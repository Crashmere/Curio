package library

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type CoverSelection struct {
	Time     float64 `json:"time"`
	Revision string  `json:"revision"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Format   string  `json:"format"`
}
type frameVideo struct {
	Width, Height             int
	Duration, Start, TimeBase float64
}

var errCoverConflict = errors.New("封面已改变，请刷新后重试")
var errFrameTime = errors.New("请选择视频时长内的有效帧")

func coverRevision(asset Asset) string {
	if asset.Cover != nil {
		return asset.Cover.Revision
	}
	return ""
}
func (l *Library) coverPath(hash string, cover *CoverSelection, kind string) string {
	return l.Derived(hash, "cover-"+cover.Revision+"-"+kind, cover.Format)
}
func (l *Library) removeCoverRevision(hash, revision string) error {
	if !validHash.MatchString(hash) || !validID.MatchString(revision) {
		return errCoverConflict
	}
	for _, kind := range []string{"thumbnail", "preview"} {
		for _, format := range []string{"jpg", "png"} {
			path := l.Derived(hash, "cover-"+revision+"-"+kind, format)
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return syncDir(filepath.Dir(l.Derived(hash, "thumbnail", "png")))
}
func frameFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, errCoverConflict) {
		writeJSON(w, 409, map[string]string{"error": err.Error(), "code": "cover_changed"})
	} else if errors.Is(err, errFrameTime) {
		fail(w, 400, err)
	} else {
		playbackFailure(w, err)
	}
}
func (l *Library) saveCover(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Time          json.RawMessage `json:"time"`
		ExpectedCover *string         `json:"expectedCover"`
	}
	if !decode(w, r, &input) {
		return
	}
	hash := chi.URLParam(r, "id")
	var at *float64
	if !validHash.MatchString(hash) || len(input.Time) == 0 || json.Unmarshal(input.Time, &at) != nil ||
		input.ExpectedCover == nil || *input.ExpectedCover != "" && !validID.MatchString(*input.ExpectedCover) ||
		at != nil && (math.IsNaN(*at) || math.IsInf(*at, 0) || *at < 0) {
		fail(w, 400, "请选择有效视频帧并提供当前封面版本")
		return
	}
	if err := l.setCover(r.Context(), hash, at, *input.ExpectedCover, requestScope(r.URL.Query())); err != nil {
		frameFailure(w, err)
		return
	}
	l.assetDetail(w, r)
}
func (l *Library) setCover(parent context.Context, hash string, at *float64, expected, scope string) error {
	unlock := l.lock(hash)
	defer unlock()
	a, err := scanAsset(l.DB.QueryRow("SELECT "+assetColumns+" FROM assets a WHERE a.id=? AND a.purge_pending=0 AND "+scopeSQL(scope), hash))
	if err != nil {
		return err
	}
	if a.Kind != "video" {
		return sql.ErrNoRows
	}
	if coverRevision(a) != expected {
		return errCoverConflict
	}
	p, err := l.playbackManager()
	if err != nil {
		return err
	}
	ctx, finish, err := p.beginCoverWork(parent, hash)
	if err != nil {
		return err
	}
	defer finish()
	if err = l.playbackAllowed(hash); err != nil {
		return err
	}
	var selection *CoverSelection
	committed := false
	defer func() {
		if !committed && selection != nil {
			_ = l.removeCoverRevision(hash, selection.Revision)
		}
	}()
	if at != nil {
		f, stat, err := l.playbackOriginal(hash)
		if err != nil {
			return err
		}
		spec, err := p.specification(ctx, l, f, stat)
		if err != nil {
			return err
		}
		probe, err := spec.frameVideo()
		if err != nil {
			return err
		}
		if *at >= probe.Duration {
			return errFrameTime
		}
		selected, err := l.containingFrame(ctx, hash, *at, probe)
		if err != nil {
			return err
		}
		format := "jpg"
		if spec.hasAlpha {
			format = "png"
		}
		selection = &CoverSelection{Time: selected, Revision: id(), Width: probe.Width, Height: probe.Height, Format: format}
		if err = l.generateCover(ctx, hash, selection, spec); err != nil {
			return err
		}
	}
	tx, err := l.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := scanAsset(tx.QueryRow("SELECT "+assetColumns+" FROM assets a WHERE a.id=? AND a.purge_pending=0 AND "+scopeSQL(scope), hash))
	if err != nil {
		return err
	}
	if coverRevision(current) != expected {
		return errCoverConflict
	}
	if selection == nil {
		_, err = tx.ExecContext(ctx, "DELETE FROM asset_covers WHERE asset_id=?", hash)
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO asset_covers(asset_id,time,revision,width,height,format) VALUES(?,?,?,?,?,?)
   ON CONFLICT(asset_id) DO UPDATE SET time=excluded.time,revision=excluded.revision,width=excluded.width,height=excluded.height,format=excluded.format`,
			hash, selection.Time, selection.Revision, selection.Width, selection.Height, selection.Format)
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	committed = true
	if expected != "" {
		if err = l.removeCoverRevision(hash, expected); err != nil {
			slog.Warn("remove replaced cover", "hash", hash, "error", err)
		}
	}
	return nil
}
func readyDerivative(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && stat.Mode().IsRegular() && stat.Size() > 0
}

func (p *playbackCache) beginCoverWork(parent context.Context, hash string) (context.Context, func(), error) {
	// Keep publication registered until every output is durable, not only until frame decoding ends.
	key := "cover-save:" + hash + ":" + id()
	p.mu.Lock()
	ctx, job, err := p.newJobLocked(key, hash, 0, 5*time.Minute, true)
	p.mu.Unlock()
	if err != nil {
		return nil, nil, err
	}
	stop := context.AfterFunc(parent, job.cancel)
	return context.WithValue(ctx, foregroundMediaKey{}, true), func() {
		stop()
		p.finishJob(ctx, key, job, nil, nil, ctx.Err())
	}, nil
}

func (l *Library) rebuildCover(parent context.Context, hash, expected string) error {
	unlock := l.lock(hash)
	defer unlock()
	a, err := l.asset(hash)
	if err != nil {
		return err
	}
	if a.purgePending {
		return errPlaybackDeleted
	}
	if a.Cover == nil || coverRevision(a) != expected {
		return errCoverConflict
	}
	p, err := l.playbackManager()
	if err != nil {
		return err
	}
	ctx, finish, err := p.beginCoverWork(parent, hash)
	if err != nil {
		return err
	}
	defer finish()
	f, stat, err := l.playbackOriginal(hash)
	if err != nil {
		return err
	}
	spec, err := p.specification(ctx, l, f, stat)
	if err != nil {
		return err
	}
	return l.generateCover(ctx, hash, a.Cover, spec)
}
func (l *Library) generateCover(ctx context.Context, hash string, cover *CoverSelection, spec *playbackSpec) error {
	if readyDerivative(l.coverPath(hash, cover, "preview")) && readyDerivative(l.coverPath(hash, cover, "thumbnail")) {
		return nil
	}
	p, err := l.playbackManager()
	if err != nil {
		return err
	}
	entry, err := p.frame(ctx, l, spec, hash, cover.Time, 0, 2560)
	if err != nil {
		return err
	}
	defer p.release(entry)
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), hash+"-cover-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	preview, thumb := filepath.Join(work, "preview."+cover.Format), filepath.Join(work, "thumbnail."+cover.Format)
	if err = os.WriteFile(preview, entry.data, 0600); err != nil {
		return err
	}
	if err = l.renderVideoFrame(ctx, preview, thumb, 0, 640, nil, nil); err != nil {
		return err
	}
	destination := filepath.Dir(l.coverPath(hash, cover, "preview"))
	if err = os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	for _, kind := range []string{"preview", "thumbnail"} {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = l.playbackAllowed(hash); err != nil {
			return err
		}
		if err = publishCoverImage(filepath.Join(work, kind+"."+cover.Format), l.coverPath(hash, cover, kind)); err != nil {
			return err
		}
	}
	return syncDir(destination)
}
func (l *Library) frame(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	q := r.URL.Query()
	at, err := strconv.ParseFloat(q.Get("time"), 64)
	if err != nil || math.IsNaN(at) || math.IsInf(at, 0) || at < 0 || len(q["time"]) != 1 ||
		len(q["size"]) > 1 || q.Has("size") && q.Get("size") != "thumb" && q.Get("size") != "preview" {
		frameFailure(w, errFrameTime)
		return
	}
	p, spec, err := l.playbackRequest(r)
	if err != nil {
		frameFailure(w, err)
		return
	}
	if at >= spec.duration {
		frameFailure(w, errFrameTime)
		return
	}
	dimension := 2560
	if q.Get("size") == "thumb" {
		dimension = 640
	}
	entry, err := p.frame(r.Context(), l, spec, spec.hash, at, 0, dimension)
	if err != nil {
		frameFailure(w, err)
		return
	}
	defer p.release(entry)
	if err = l.playbackAllowed(spec.hash); err != nil {
		frameFailure(w, err)
		return
	}
	contentType, name := "image/jpeg", "frame.jpg"
	if spec.hasAlpha {
		contentType, name = "image/png", "frame.png"
	}
	w.Header().Set("Content-Type", contentType)
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(entry.data))
}
func (l *Library) coverThumbnailURL(hash string) string {
	url := "/curio/media/" + hash + "/thumbnail"
	var revision string
	if l.DB.QueryRow("SELECT revision FROM asset_covers WHERE asset_id=?", hash).Scan(&revision) == nil {
		url += "?cover=" + revision
	}
	return url
}
func alphaDecoder(spec *playbackSpec) []string {
	if spec == nil || !spec.hasAlpha {
		return nil
	}
	switch spec.videoCodec {
	case "vp8":
		return []string{"-c:v", "libvpx"}
	case "vp9":
		return []string{"-c:v", "libvpx-vp9"}
	}
	return nil
}
func coverHDRFilters(spec *playbackSpec, dimension int) []string {
	filters := playbackHDRFilters(spec)
	return strings.Split(strings.ReplaceAll(strings.Join(filters, ","), "1920", strconv.Itoa(dimension)), ",")
}
func (l *Library) runVideoSampleCommand(ctx context.Context, args []string, gpu, software bool) (string, error) {
	if software {
		release, err := l.acquireCPU(ctx)
		if err != nil {
			return "", err
		}
		defer release()
	}
	if gpu {
		release, err := l.acquireGPU(ctx)
		if err != nil {
			return "", err
		}
		defer release()
	}
	logs := &boundedBuffer{maximum: 256 << 10}
	cmd := mediaCommand(ctx, "ffmpeg", args...)
	cmd.Stderr = logs
	err := cmd.Run()
	return logs.String(), err
}

// Input -ss alone rounds an interior time forward to the next decoded frame.
// Resolve the containing frame from original PTS, decoding only the preceding
// keyframe interval and its reorder tail. Integer PTS also preserves VFR timing.
func (l *Library) containingFrame(parent context.Context, hash string, at float64, probe frameVideo) (float64, error) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	release, err := l.acquireCPU(ctx)
	if err != nil {
		return 0, err
	}
	defer release()
	target := probe.Start + at
	seek := strconv.FormatFloat(math.Floor(target*1e6)/1e6, 'f', 6, 64)
	cmd := mediaCommand(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-select_streams", "v:0", "-read_intervals", seek+"%", "-show_entries", "frame=best_effort_timestamp", "-of", "csv=p=0", l.Object(hash))
	stderr := &boundedBuffer{maximum: 4096}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	if err = cmd.Start(); err != nil {
		return 0, err
	}
	scanner := bufio.NewScanner(stdout)
	selected, found, stopped := 0.0, false, false
	for scanner.Scan() {
		value, _, _ := strings.Cut(scanner.Text(), ",")
		pts, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			continue
		}
		seconds := float64(pts) * probe.TimeBase
		if seconds > target+1e-7 {
			if !found {
				selected, found = seconds, true
			}
			stopped = true
			cancel()
			break
		}
		selected, found = seconds, true
	}
	waitErr := cmd.Wait()
	if parent.Err() != nil {
		return 0, parent.Err()
	}
	if !stopped && waitErr != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, fmt.Errorf("ffprobe frame timing: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
	}
	if err = scanner.Err(); err != nil {
		return 0, err
	}
	if !found {
		return 0, errFrameTime
	}
	return max(0, selected-probe.Start), nil
}

func publishCoverImage(path, destination string) error {
	output, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if _, _, err = image.DecodeConfig(output); err == nil {
		err = output.Chmod(0600)
	}
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(path, destination)
}

func (l *Library) renderVideoFrame(ctx context.Context, input, output string, at float64, dimension int, hdrFilters []string, spec *playbackSpec) error {
	var err error
	modes := []string{"CPU"}
	if spec != nil && !spec.hasAlpha && len(hdrFilters) == 0 && l.nvidiaAvailable(ctx) {
		// Software decode applies the source display matrix before CUDA resizing;
		// JPEG has no video display matrix and cannot defer native orientation.
		modes = []string{"NVIDIA GPU · 软件解码", "CPU"}
	}
	for _, mode := range modes {
		if err = ctx.Err(); err != nil {
			return err
		}
		args := []string{"-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"}
		gpu := mode != "CPU"
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
		}
		if at > 0 {
			args = append(args, "-ss", strconv.FormatFloat(math.Floor(at*1e6)/1e6, 'f', 6, 64))
		}
		args = append(args, alphaDecoder(spec)...)
		args = append(args, "-i", input, "-map", "0:v:0")
		filter := fmt.Sprintf("scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", dimension, dimension)
		if len(hdrFilters) > 0 {
			filter = strings.Join(hdrFilters, ",")
		} else if gpu {
			filter = "format=nv12,hwupload," + strings.Replace(filter, "scale=", "scale_cuda=", 1) + ":format=yuv420p,hwdownload,format=yuv420p"
		}
		args = append(args, "-vf", filter, "-frames:v", "1", "-map_metadata", "-1", "-q:v", "2", "-threads", "2", "-y", output)
		var release func()
		var releaseCPU func()
		if gpu {
			if foregroundMedia(ctx) {
				releaseCPU, err = l.acquireCPU(ctx)
				if err != nil {
					return err
				}
			}
			release, err = l.acquireGPU(ctx)
		} else {
			release, err = l.acquireCPU(ctx)
		}
		if err != nil {
			if releaseCPU != nil {
				releaseCPU()
			}
			return err
		}
		_, err = command(ctx, "ffmpeg", args...)
		release()
		if releaseCPU != nil {
			releaseCPU()
		}
		if err == nil && readyDerivative(output) {
			return nil
		}
		if err == nil {
			err = errFrameTime
		}
		if gpu {
			slog.Info("retry cover frame with CPU", "engine", mode, "error", err)
		}
	}
	return err
}
