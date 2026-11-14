package library

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const coverStripRecipe = "cover-strip-v1"
const coverStripSuffix = "-cover-strip-v1"
const coverStripDimension = 320
const coverStripColumns = 5
const coverStripSeekBatch = 3
const coverStripDecodePixels = 3840 * 2160

type coverStripFrame struct {
	Time   float64 `json:"time"`
	X      int     `json:"x"`
	Y      int     `json:"y"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
}

type coverStripRecord struct {
	Recipe   string            `json:"recipe"`
	Stamp    string            `json:"stamp"`
	Revision string            `json:"revision"`
	Duration float64           `json:"duration"`
	Width    int               `json:"width"`
	Height   int               `json:"height"`
	Frames   []coverStripFrame `json:"frames"`
}

func coverStripTimes(duration, frameRate float64) []float64 {
	count := max(5, min(15, int(math.Floor(5+2*math.Log2(max(duration/15, 1))+.5))))
	if frameRate <= 0 {
		frameRate = 30
	}
	end := max(0, duration-.5/frameRate)
	times := make([]float64, count)
	for i := range times {
		times[i] = end * float64(i) / float64(count-1)
	}
	return times
}

func (l *Library) readCoverStrip(spec *playbackSpec) (*playbackEntry, error) {
	stat, err := os.Stat(l.Derived(spec.hash, coverStripRecipe, "json"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > 64<<10 {
		return nil, nil
	}
	meta, err := os.ReadFile(l.Derived(spec.hash, coverStripRecipe, "json"))
	if err != nil {
		return nil, err
	}
	var record coverStripRecord
	if json.Unmarshal(meta, &record) != nil || record.Recipe != coverStripRecipe || record.Stamp != spec.stamp || !validID.MatchString(record.Revision) || record.Duration != spec.duration || len(record.Frames) != len(coverStripTimes(spec.duration, spec.frameRate)) {
		return nil, nil
	}
	stat, err = os.Stat(l.Derived(spec.hash, coverStripRecipe, "png"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() >= frameImageLimit {
		return nil, nil
	}
	data, err := os.ReadFile(l.Derived(spec.hash, coverStripRecipe, "png"))
	if err != nil {
		return nil, err
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != record.Width || config.Height != record.Height || record.Width > coverStripColumns*coverStripDimension || record.Height > 3*coverStripDimension {
		return nil, nil
	}
	previous := -1.0
	for _, frame := range record.Frames {
		if math.IsNaN(frame.Time) || math.IsInf(frame.Time, 0) || frame.Time < previous || frame.Time < 0 || frame.Time >= spec.duration || frame.X < 0 || frame.Y < 0 || frame.Width <= 0 || frame.Height <= 0 || frame.X+frame.Width > record.Width || frame.Y+frame.Height > record.Height {
			return nil, nil
		}
		previous = frame.Time
	}
	return &playbackEntry{hash: spec.hash, data: data, strip: &record}, nil
}

func (p *playbackCache) coverStrip(ctx context.Context, l *Library, spec *playbackSpec) (*playbackEntry, error) {
	key := "strip:" + coverStripRecipe + ":" + spec.stamp
	p.mu.Lock()
	p.expireLocked(time.Now())
	if err := l.playbackAllowed(spec.hash); err != nil {
		p.mu.Unlock()
		return nil, err
	}
	if entry := p.entries[key]; entry != nil {
		entry.refs++
		entry.used = time.Now()
		p.mu.Unlock()
		return entry, nil
	}
	if job := p.jobs[key]; job != nil {
		if job.waiters == 0 && job.orphan == nil {
			p.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-job.done:
				return p.coverStrip(ctx, l, spec)
			}
		}
		if job.orphan != nil {
			job.orphan.Stop()
			job.orphan = nil
		}
		job.waiters++
		p.mu.Unlock()
		if err := p.await(ctx, job); err != nil {
			return nil, err
		}
		return job.entry, nil
	}
	strips := 0
	for _, job := range p.jobs {
		if job.strip {
			strips++
		}
	}
	if strips >= 2 {
		p.mu.Unlock()
		return nil, errPlaybackBusy
	}
	jobCtx, job, err := p.newJobLocked(key, spec.hash, frameImageLimit, 5*time.Minute, false)
	if err == nil {
		job.strip = true
	}
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	go func() {
		entry, err := l.readCoverStrip(spec)
		if err == nil && entry == nil {
			var release func()
			release, err = acquireMediaSlot(jobCtx, p.stripSlots)
			if err == nil {
				entry, err = l.generateCoverStrip(jobCtx, spec)
				release()
			}
		}
		if err == nil {
			err = l.playbackAllowed(spec.hash)
		}
		if entry != nil {
			entry.key = key
		}
		p.finishJob(jobCtx, key, job, entry, nil, err)
	}()
	if err = p.await(ctx, job); err != nil {
		return nil, err
	}
	return job.entry, nil
}

func (l *Library) warmCoverStrip(hash string) {
	p, err := l.playbackManager()
	if err != nil {
		return
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.running.Add(1)
	p.mu.Unlock()
	go func() {
		defer p.running.Done()
		f, stat, err := l.playbackOriginal(hash)
		var spec *playbackSpec
		if err == nil {
			spec, err = p.specification(p.ctx, l, f, stat)
		}
		if err == nil {
			var entry *playbackEntry
			entry, err = p.coverStrip(p.ctx, l, spec)
			if err == nil {
				p.release(entry)
			}
		}
		if err != nil && p.ctx.Err() == nil && !errors.Is(err, errPlaybackBusy) && !errors.Is(err, errPlaybackClosed) && l.playbackAllowed(hash) == nil {
			slog.Warn("precompute cover strip", "hash", hash, "error", err)
		}
	}()
}

var coverStripPTS = regexp.MustCompile(`\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:`)
var coverStripBatchPTS = regexp.MustCompile(`showinfo@candidate(\d+)\s+@[^\n]*?\bn:\s*0\s+pts:\s*(-?\d+)\s+pts_time:`)

func coverStripFilters(spec *playbackSpec, mode string) []string {
	if spec.hdr {
		filters := []string{}
		if mode == "cuda" {
			filters = append(filters, "hwdownload", "format=p010le")
		}
		return append(filters, coverHDRFilters(spec, coverStripDimension)...)
	}
	scale := fmt.Sprintf("w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", coverStripDimension, coverStripDimension)
	if mode == "cpu" {
		return []string{"scale=" + scale}
	}
	filters := []string{}
	if mode != "cuda" {
		filters = append(filters, "format=nv12", "hwupload")
	}
	return append(filters, "scale_cuda="+scale+":format=yuv420p", "hwdownload", "format=yuv420p")
}

func (l *Library) extractCoverStripSeeks(ctx context.Context, spec *playbackSpec, work, mode string, first int, targets []float64) ([]float64, []string, error) {
	args := []string{"-nostdin", "-v", "info", "-filter_threads", "4", "-filter_complex_threads", "1", "-copyts", "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu"}
	graphs := make([]string, len(targets))
	paths := make([]string, len(targets))
	for i, target := range targets {
		args = append(args, "-protocol_whitelist", "file,pipe", "-threads", "2")
		if mode == "cuda" {
			args = append(args, "-hwaccel", "cuda", "-hwaccel_device", "gpu", "-hwaccel_output_format", "cuda")
		}
		at := math.Floor((spec.frameStart+target)*1e6) / 1e6
		args = append(args, "-seek_timestamp", "1", "-ss", strconv.FormatFloat(at, 'f', 6, 64), "-i", spec.path)
		graphs[i] = fmt.Sprintf("[%d:v:0]%s,showinfo@candidate%d[frame%d]", i, strings.Join(coverStripFilters(spec, mode), ","), i, i)
		paths[i] = filepath.Join(work, fmt.Sprintf("frame-%03d.png", first+i+1))
	}
	args = append(args, "-filter_complex", strings.Join(graphs, ";"))
	for i, path := range paths {
		args = append(args, "-map", fmt.Sprintf("[frame%d]", i), "-an", "-fps_mode", "passthrough", "-frames:v", "1", "-map_metadata", "-1", "-q:v", "3", "-threads", "2", "-y", path)
	}
	logs, err := l.runVideoSampleCommand(ctx, args, true, true)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w: %s", mode, err, logs[max(0, len(logs)-2000):])
	}
	times := make([]float64, len(targets))
	found := make([]bool, len(targets))
	for _, stamp := range coverStripBatchPTS.FindAllStringSubmatch(logs, -1) {
		i, err := strconv.Atoi(stamp[1])
		if err != nil || i >= len(targets) || found[i] {
			continue
		}
		pts, err := strconv.ParseInt(stamp[2], 10, 64)
		at := max(0, float64(pts)*spec.timeBase-spec.frameStart)
		if err != nil || at >= spec.duration {
			return nil, nil, errFrameTime
		}
		times[i], found[i] = at, true
	}
	for _, ok := range found {
		if !ok {
			return nil, nil, errFrameTime
		}
	}
	return times, paths, nil
}

func coverStripBatchSize(spec *playbackSpec, mode string) int {
	if spec.duration <= 60 || spec.hdr || mode == "cpu" {
		return 1
	}
	// Share CUDA startup while bounding simultaneous decoder surfaces to one 4K frame budget.
	return min(coverStripSeekBatch, max(1, coverStripDecodePixels/(spec.width*spec.height)))
}

func (l *Library) extractCoverStrip(ctx context.Context, spec *playbackSpec, work string, targets []float64) ([]float64, []string, string, error) {
	modes := []string{"cpu"}
	if !spec.hasAlpha && l.nvidiaAvailable(ctx) {
		if !spec.hdr {
			modes = []string{"software-gpu", "cpu"}
		}
		if math.Abs(math.Remainder(spec.nativeRotation, 360)) < .001 {
			modes = append([]string{"cuda"}, modes...)
		}
	}
	batch := spec.duration <= 60
	seeks := []float64{0}
	if !batch {
		seeks = targets
	}
	var lastErr error
	for _, mode := range modes {
		lastErr = nil
		var times []float64
		var paths []string
		seekBatch := coverStripBatchSize(spec, mode)
		for index := 0; index < len(seeks); index += seekBatch {
			if seekBatch > 1 {
				group := seeks[index:min(index+seekBatch, len(seeks))]
				groupTimes, groupPaths, err := l.extractCoverStripSeeks(ctx, spec, work, mode, index, group)
				if err != nil {
					lastErr = err
					break
				}
				times, paths = append(times, groupTimes...), append(paths, groupPaths...)
				continue
			}
			seek := seeks[index]
			gpu := mode != "cpu"
			args := []string{"-nostdin", "-v", "info", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "4", "-filter_complex_threads", "1", "-copyts"}
			if gpu {
				args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
			}
			if mode == "cuda" {
				args = append(args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda")
			}
			if !batch {
				at := math.Floor((spec.frameStart+seek)*1e6) / 1e6
				args = append(args, "-seek_timestamp", "1", "-ss", strconv.FormatFloat(at, 'f', 6, 64))
			}
			args = append(args, alphaDecoder(spec)...)
			args = append(args, "-i", spec.path, "-map", "0:v:0", "-an")
			filters := []string{}
			frames, pattern := 1, filepath.Join(work, fmt.Sprintf("frame-%03d.png", index+1))
			if batch {
				selects := []string{"isnan(prev_selected_t)"}
				for _, at := range targets[1:] {
					value := strconv.FormatFloat(spec.frameStart+at-1e-7, 'f', 9, 64)
					selects = append(selects, "gte(t,"+value+")*lt(prev_selected_t,"+value+")")
				}
				filters = append(filters, "select='gt("+strings.Join(selects, "+")+",0)'")
				frames, pattern = len(targets), filepath.Join(work, "frame-%03d.png")
			}
			filters = append(filters, coverStripFilters(spec, mode)...)
			args = append(args, "-vf", strings.Join(filters, ",")+",showinfo", "-fps_mode", "passthrough", "-frames:v", strconv.Itoa(frames), "-map_metadata", "-1", "-q:v", "3", "-threads", "2", "-y", pattern)
			logs, err := l.runVideoSampleCommand(ctx, args, gpu, true)
			if err != nil {
				lastErr = fmt.Errorf("%s: %w: %s", mode, err, logs[max(0, len(logs)-2000):])
				break
			}
			stamps := coverStripPTS.FindAllStringSubmatch(logs, -1)
			if len(stamps) == 0 {
				lastErr = errFrameTime
				break
			}
			for i, stamp := range stamps[:min(frames, len(stamps))] {
				pts, err := strconv.ParseInt(stamp[1], 10, 64)
				at := max(0, float64(pts)*spec.timeBase-spec.frameStart)
				if err != nil || at >= spec.duration {
					lastErr = errFrameTime
					break
				}
				path := pattern
				if batch {
					path = filepath.Join(work, fmt.Sprintf("frame-%03d.png", i+1))
				}
				times, paths = append(times, at), append(paths, path)
			}
			if lastErr != nil {
				break
			}
		}
		if lastErr == nil && len(paths) > 0 {
			return times, paths, mode, nil
		}
		if ctx.Err() != nil {
			return nil, nil, "", ctx.Err()
		}
	}
	return nil, nil, "", fmt.Errorf("could not extract candidate frames: %w", lastErr)
}

func (l *Library) generateCoverStrip(ctx context.Context, spec *playbackSpec) (*playbackEntry, error) {
	started := time.Now()
	probe, err := spec.frameVideo()
	if err != nil {
		return nil, err
	}
	targets := coverStripTimes(spec.duration, spec.frameRate)
	// VFR's final displayed frame can start well before the nominal frame-rate estimate.
	last, err := l.containingFrame(ctx, spec.hash, targets[len(targets)-1], probe)
	if err != nil {
		return nil, err
	}
	for i := range targets {
		targets[i] = min(targets[i], last)
	}
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), spec.hash+"-cover-strip-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	times, paths, engine, err := l.extractCoverStrip(ctx, spec, work, targets)
	if err != nil {
		return nil, err
	}
	images := make([]image.Image, len(paths))
	width, height := 0, 0
	for i, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		images[i], _, err = image.Decode(file)
		file.Close()
		if err != nil {
			return nil, err
		}
		bounds := images[i].Bounds()
		if i == 0 {
			width, height = bounds.Dx(), bounds.Dy()
		}
		if bounds.Dx() != width || bounds.Dy() != height || width > coverStripDimension || height > coverStripDimension {
			return nil, fmt.Errorf("inconsistent candidate dimensions")
		}
	}
	columns := min(coverStripColumns, len(targets))
	record := &coverStripRecord{Recipe: coverStripRecipe, Stamp: spec.stamp, Revision: id(), Duration: spec.duration, Width: columns * width, Height: ((len(targets) + columns - 1) / columns) * height}
	sheet := image.NewRGBA(image.Rect(0, 0, record.Width, record.Height))
	index := 0
	for i, at := range targets {
		for index+1 < len(times) && times[index] < at-1e-7 {
			index++
		}
		x, y := i%columns*width, i/columns*height
		draw.Draw(sheet, image.Rect(x, y, x+width, y+height), images[index], images[index].Bounds().Min, draw.Src)
		record.Frames = append(record.Frames, coverStripFrame{Time: times[index], X: x, Y: y, Width: width, Height: height})
	}
	var encoded bytes.Buffer
	if err = png.Encode(&encoded, sheet); err != nil {
		return nil, err
	}
	if encoded.Len() >= int(frameImageLimit) {
		return nil, fmt.Errorf("candidate atlas exceeds output bound")
	}

	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = l.playbackAllowed(spec.hash); err != nil {
		return nil, err
	}
	_, stat, err := l.playbackOriginal(spec.hash)
	if err != nil {
		return nil, err
	}
	if fmt.Sprintf("probe:%s:%d:%d", spec.hash, stat.Size(), stat.ModTime().UnixNano()) != spec.stamp {
		return nil, errCoverConflict
	}
	if err = os.MkdirAll(filepath.Dir(l.Derived(spec.hash, coverStripRecipe, "png")), 0700); err != nil {
		return nil, err
	}
	output := filepath.Join(work, "strip.png")
	if err = os.WriteFile(output, encoded.Bytes(), 0600); err != nil {
		return nil, err
	}
	if err = publishCoverImage(output, l.Derived(spec.hash, coverStripRecipe, "png")); err != nil {
		return nil, err
	}
	meta, err := os.CreateTemp(filepath.Dir(l.Derived(spec.hash, coverStripRecipe, "png")), spec.hash+coverStripSuffix+".part-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(meta.Name())
	err = json.NewEncoder(meta).Encode(record)
	if err == nil {
		err = meta.Sync()
	}
	closeErr := meta.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(meta.Name(), l.Derived(spec.hash, coverStripRecipe, "json"))
	}
	if err == nil {
		err = syncDir(filepath.Dir(l.Derived(spec.hash, coverStripRecipe, "png")))
	}
	if err != nil {
		return nil, err
	}
	passes := 1
	if spec.duration > 60 {
		passes = (len(paths) + coverStripBatchSize(spec, engine) - 1) / coverStripBatchSize(spec, engine)
	}
	slog.Info("candidate atlas generated", "hash", spec.hash, "elapsedMs", time.Since(started).Milliseconds(), "candidates", len(record.Frames), "engine", engine, "decodePasses", passes)
	return &playbackEntry{hash: spec.hash, data: encoded.Bytes(), strip: record}, nil
}

func (l *Library) frameStrip(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, spec, err := l.playbackRequest(r)
	revision := r.URL.Query().Get("image")
	if len(r.URL.Query()["image"]) > 1 || revision != "" && !validID.MatchString(revision) {
		frameFailure(w, errFrameTime)
		return
	}
	if err != nil {
		frameFailure(w, err)
		return
	}
	entry, err := p.coverStrip(r.Context(), l, spec)
	if err != nil {
		frameFailure(w, err)
		return
	}
	defer p.release(entry)
	if err = l.playbackAllowed(spec.hash); err != nil {
		frameFailure(w, err)
		return
	}
	if revision != "" {
		if revision != entry.strip.Revision {
			frameFailure(w, errCoverConflict)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		http.ServeContent(w, r, "strip.png", time.Time{}, bytes.NewReader(entry.data))
		return
	}
	writeJSON(w, 200, map[string]any{"revision": entry.strip.Revision, "duration": entry.strip.Duration, "width": entry.strip.Width, "height": entry.strip.Height, "frames": entry.strip.Frames})
}
