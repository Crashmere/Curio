package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/sys/unix"
)

const (
	nativeRemuxRecipe        = "native-mp4-v1"
	nativeRemuxIntentPrefix  = "native-remux:"
	nativeRemuxOriginalLimit = int64(2 << 30)
	nativeRemuxOutputPadding = int64(32 << 20)
	nativeRemuxDurationLimit = 2 * 60 * 60
	nativeRemuxDeadline      = 10 * time.Minute
)

type nativeRemuxIntent struct {
	Recipe  string `json:"recipe"`
	Stamp   string `json:"stamp"`
	State   string `json:"state"`
	Error   string `json:"error,omitempty"`
	Updated string `json:"updated"`
}

type nativeRemuxRecord struct {
	Recipe           string `json:"recipe"`
	Original         string `json:"original"`
	Stamp            string `json:"stamp"`
	OriginalSize     int64  `json:"originalSize"`
	OriginalModified int64  `json:"originalModified"`
	Digest           string `json:"sha256"`
	Size             int64  `json:"size"`
	Modified         int64  `json:"modified"`
}

func playbackStamp(hash string, stat os.FileInfo) string {
	return fmt.Sprintf("probe:%s:%d:%d", hash, stat.Size(), stat.ModTime().UnixNano())
}

func (spec *playbackSpec) admitNativeRemux(original Asset, stat os.FileInfo, audio, audioAAC bool) {
	if original.Format != "mp4" || stat.Size() <= 0 || stat.Size() > nativeRemuxOriginalLimit || spec.duration > nativeRemuxDurationLimit || spec.videoCodec != "h264" || spec.sourceCodecs == "" || spec.sourceMime != "video/mp4" || spec.hdr || spec.hasAlpha || audio && !audioAAC {
		return
	}
	if spec.sourceAudio != nil && math.Abs(spec.sourceAudio.Start) > .001 {
		return
	}
	parsed, err := readNativeMP4WithMinimum(spec.path, nativeMP4MinimumMDATs)
	if err != nil || len(parsed.mdats) < nativeMP4MinimumMDATs || parsed.movieTimescale > math.MaxInt32 {
		return
	}
	for _, track := range parsed.tracks {
		if track.handler == "vide" {
			if track.timescale > math.MaxInt32 {
				return
			}
			spec.nativeVideoTimescale, spec.nativeVideoTag = track.timescale, track.codec
		}
	}
	spec.nativeRemux = true
	spec.nativeMDATs, spec.nativeMovieTimescale = len(parsed.mdats), parsed.movieTimescale
}

func (l *Library) nativeRemuxPath(hash, ext string) string {
	return l.Derived(hash, nativeRemuxRecipe, ext)
}

func (l *Library) readNativeRemux(spec *playbackSpec) (*nativeRemuxRecord, error) {
	path := l.nativeRemuxPath(spec.hash, "json")
	stat, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > 4096 {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var record nativeRemuxRecord
	if json.Unmarshal(data, &record) != nil || record.Recipe != nativeRemuxRecipe || record.Original != spec.hash || record.Stamp != spec.stamp || record.OriginalSize != spec.originalSize || record.OriginalModified != spec.originalModified || !validHash.MatchString(record.Digest) || record.Size <= 0 || record.Size > spec.originalSize+nativeRemuxOutputPadding {
		return nil, nil
	}
	stat, err = os.Lstat(l.nativeRemuxPath(spec.hash, "mp4"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() != record.Size || stat.ModTime().UnixNano() != record.Modified {
		return nil, nil
	}
	return &record, nil
}

func (l *Library) enqueueNativeRemux(spec *playbackSpec) (*nativeRemuxRecord, error) {
	if !spec.nativeRemux {
		return nil, nil
	}
	unlock := l.lock(spec.hash)
	defer unlock()
	_, stat, err := l.playbackOriginal(spec.hash)
	if err != nil {
		return nil, err
	}
	if playbackStamp(spec.hash, stat) != spec.stamp {
		return nil, errPlaybackIntegrity
	}
	record, err := l.readNativeRemux(spec)
	if err != nil || record != nil {
		return record, err
	}
	key := nativeRemuxIntentPrefix + spec.hash
	var value string
	err = l.DB.QueryRow("SELECT value FROM catalog_settings WHERE key=?", key).Scan(&value)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var existing nativeRemuxIntent
	if json.Unmarshal([]byte(value), &existing) == nil && existing.Recipe == nativeRemuxRecipe && existing.Stamp == spec.stamp {
		if existing.State == "queued" || existing.State == "error" {
			return nil, nil
		}
		if existing.State == "processing" {
			l.nativeMu.Lock()
			active := l.nativeActive[spec.hash] != nil
			l.nativeMu.Unlock()
			if active {
				return nil, nil
			}
		}
	}
	intent := nativeRemuxIntent{Recipe: nativeRemuxRecipe, Stamp: spec.stamp, State: "queued", Updated: now()}
	_, err = l.DB.Exec("INSERT INTO catalog_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, marshal(intent))
	if err == nil {
		l.notifyNativeRemux()
		slog.Info("native MP4 queued", "asset", spec.hash, "size", spec.originalSize, "mediaDataAtoms", spec.nativeMDATs)
	}
	return nil, err
}

func (l *Library) notifyNativeRemux() {
	select {
	case l.nativeWake <- struct{}{}:
	default:
	}
}

func (l *Library) nativeRemuxWorker(ctx context.Context) {
	_, err := l.DB.Exec("UPDATE catalog_settings SET value=json_set(value,'$.state','queued','$.updated',?) WHERE key GLOB 'native-remux:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.recipe') END=? AND CASE WHEN json_valid(value) THEN json_extract(value,'$.state') END='processing'", now(), nativeRemuxRecipe)
	if err != nil {
		slog.Warn("recover native MP4 queue", "error", err)
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if l.nextNativeRemux(ctx) {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-l.nativeWake:
		case <-ticker.C:
		}
	}
}

func (l *Library) nextNativeRemux(parent context.Context) bool {
	var key, value string
	err := l.DB.QueryRow("SELECT key,value FROM catalog_settings WHERE key GLOB 'native-remux:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.recipe') END=? AND CASE WHEN json_valid(value) THEN json_extract(value,'$.state') END='queued' ORDER BY json_extract(value,'$.updated'),key LIMIT 1", nativeRemuxRecipe).Scan(&key, &value)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Warn("native MP4 queue", "error", err)
		}
		return false
	}
	hash := strings.TrimPrefix(key, nativeRemuxIntentPrefix)
	var intent nativeRemuxIntent
	if !validHash.MatchString(hash) || json.Unmarshal([]byte(value), &intent) != nil {
		return false
	}
	unlock := l.lock(hash)
	if err = l.playbackAllowed(hash); err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errPlaybackDeleted) {
			_, _ = l.DB.Exec("DELETE FROM catalog_settings WHERE key=?", key)
		}
		unlock()
		return errors.Is(err, sql.ErrNoRows) || errors.Is(err, errPlaybackDeleted)
	}
	intent.State, intent.Error, intent.Updated = "processing", "", now()
	result, err := l.DB.Exec("UPDATE catalog_settings SET value=? WHERE key=? AND value=?", marshal(intent), key, value)
	if err != nil {
		unlock()
		return false
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		unlock()
		return true
	}
	ctx, cancel := context.WithTimeout(parent, nativeRemuxDeadline)
	job := &activeJob{cancel: cancel, done: make(chan struct{})}
	l.nativeMu.Lock()
	l.nativeActive[hash] = job
	l.nativeMu.Unlock()
	unlock()
	defer func() {
		cancel()
		l.nativeMu.Lock()
		delete(l.nativeActive, hash)
		close(job.done)
		l.nativeMu.Unlock()
	}()
	started := time.Now()
	record, err := l.generateNativeRemux(ctx, hash, intent.Stamp)
	l.finishNativeRemux(hash, intent.Stamp, parent.Err() != nil, err)
	if err != nil {
		if parent.Err() == nil && l.playbackAllowed(hash) == nil {
			slog.Warn("native MP4 normalization failed", "asset", hash, "elapsedMs", time.Since(started).Milliseconds(), "error", err)
		}
	} else {
		slog.Info("native MP4 normalized", "asset", hash, "elapsedMs", time.Since(started).Milliseconds(), "size", record.Size, "sha256", record.Digest)
	}
	return true
}

func (l *Library) finishNativeRemux(hash, stamp string, interrupted bool, failure error) {
	unlock := l.lock(hash)
	defer unlock()
	if l.playbackAllowed(hash) != nil {
		return
	}
	key := nativeRemuxIntentPrefix + hash
	var value string
	if l.DB.QueryRow("SELECT value FROM catalog_settings WHERE key=?", key).Scan(&value) != nil {
		return
	}
	var intent nativeRemuxIntent
	if json.Unmarshal([]byte(value), &intent) != nil || intent.Recipe != nativeRemuxRecipe || intent.Stamp != stamp || intent.State != "processing" {
		return
	}
	intent.State, intent.Error, intent.Updated = "ready", "", now()
	if interrupted {
		intent.State = "queued"
	} else if failure != nil {
		intent.State, intent.Error = "error", failure.Error()
	}
	if _, err := l.DB.Exec("UPDATE catalog_settings SET value=? WHERE key=?", marshal(intent), key); err != nil {
		slog.Warn("persist native MP4 completion", "asset", hash, "error", err)
	}
}

func nativeRemuxScratchSpace(path string, outputLimit int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return err
	}
	needed := uint64(2*outputLimit + (128 << 20))
	if stat.Bsize <= 0 {
		return fmt.Errorf("invalid scratch filesystem block size")
	}
	block := uint64(stat.Bsize)
	if uint64(stat.Bavail) < (needed+block-1)/block {
		return fmt.Errorf("not enough scratch space for bounded native MP4 normalization")
	}
	return nil
}

func (l *Library) generateNativeRemux(ctx context.Context, hash, stamp string) (*nativeRemuxRecord, error) {
	a, stat, err := l.playbackOriginal(hash)
	if err != nil {
		return nil, err
	}
	if playbackStamp(hash, stat) != stamp {
		return nil, errPlaybackIntegrity
	}
	p, err := l.playbackManager()
	if err != nil {
		return nil, err
	}
	spec, err := p.specification(ctx, l, a, stat)
	if err != nil {
		return nil, err
	}
	if !spec.nativeRemux || spec.stamp != stamp {
		return nil, fmt.Errorf("source is outside the supported native MP4 normalization scope")
	}
	if record, err := l.readNativeRemux(spec); err != nil || record != nil {
		return record, err
	}
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), hash+"-native-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	outputLimit := stat.Size() + nativeRemuxOutputPadding
	if err = nativeRemuxScratchSpace(work, outputLimit); err != nil {
		return nil, err
	}
	release, err := l.acquireCPU(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	muxed, output := filepath.Join(work, "muxed.mp4"), filepath.Join(work, "native.mp4")
	err = commandOutput(ctx, "ffmpeg", io.Discard, "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-copyts", "-copytb", "1", "-i", spec.path, "-map", "0", "-c", "copy", "-tag:v", spec.nativeVideoTag, "-map_metadata", "0", "-map_chapters", "0", "-avoid_negative_ts", "disabled", "-use_editlist", "1", "-video_track_timescale", strconv.FormatUint(uint64(spec.nativeVideoTimescale), 10), "-movie_timescale", strconv.FormatUint(uint64(spec.nativeMovieTimescale), 10), "-movflags", "+faststart", "-fs", strconv.FormatInt(outputLimit, 10), muxed)
	if err != nil {
		return nil, err
	}
	muxedStat, err := os.Lstat(muxed)
	if err != nil || !muxedStat.Mode().IsRegular() || muxedStat.Size() > outputLimit {
		return nil, fmt.Errorf("normalized MP4 intermediate exceeds its bound")
	}
	normalized, err := repackNativeMP4(ctx, spec.path, muxed, output)
	if err != nil {
		return nil, err
	}
	if normalized.size > outputLimit {
		return nil, fmt.Errorf("normalized MP4 output exceeds its bound")
	}
	record := &nativeRemuxRecord{Recipe: nativeRemuxRecipe, Original: hash, Stamp: stamp, OriginalSize: stat.Size(), OriginalModified: stat.ModTime().UnixNano(), Digest: normalized.digest, Size: normalized.size, Modified: normalized.modified}
	manifest := filepath.Join(work, "native.json")
	file, err := os.OpenFile(manifest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	if err = json.NewEncoder(file).Encode(record); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	unlock := l.lock(hash)
	defer unlock()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	_, current, err := l.playbackOriginal(hash)
	if err != nil {
		return nil, err
	}
	if playbackStamp(hash, current) != stamp {
		return nil, errPlaybackIntegrity
	}
	destination := filepath.Dir(l.nativeRemuxPath(hash, "mp4"))
	if err = os.MkdirAll(destination, 0700); err != nil {
		return nil, err
	}
	if err = os.Rename(output, l.nativeRemuxPath(hash, "mp4")); err != nil {
		return nil, err
	}
	if err = syncDir(destination); err != nil {
		return nil, err
	}
	if err = os.Rename(manifest, l.nativeRemuxPath(hash, "json")); err != nil {
		return nil, err
	}
	if err = syncDir(destination); err != nil {
		return nil, err
	}
	return record, nil
}

func (l *Library) cancelNativeRemux(hashes []string) {
	l.nativeMu.Lock()
	defer l.nativeMu.Unlock()
	for _, hash := range hashes {
		if job := l.nativeActive[hash]; job != nil {
			job.cancel()
		}
	}
}

func (l *Library) nativePlaybackMedia(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		http.NotFound(w, r)
		return
	}
	a, stat, err := l.playbackOriginal(hash)
	if err != nil {
		playbackFailure(w, err)
		return
	}
	spec := &playbackSpec{hash: hash, stamp: playbackStamp(hash, stat), originalSize: stat.Size(), originalModified: stat.ModTime().UnixNano()}
	record, err := l.readNativeRemux(spec)
	if err != nil {
		playbackFailure(w, err)
		return
	}
	if record == nil || len(r.URL.Query()["revision"]) > 1 || r.URL.Query().Get("revision") != "" && r.URL.Query().Get("revision") != record.Digest {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(l.nativeRemuxPath(hash, "mp4"))
	if err != nil {
		playbackFailure(w, err)
		return
	}
	defer file.Close()
	stat, err = file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() != record.Size || stat.ModTime().UnixNano() != record.Modified {
		http.NotFound(w, r)
		return
	}
	if err = l.playbackAllowed(hash); err != nil {
		playbackFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": a.Name}))
	w.Header().Set("Cache-Control", "private,max-age=3600")
	w.Header().Set("ETag", `"`+record.Digest+`"`)
	w.Header().Set("X-Curio-Playback-Engine", nativeRemuxRecipe)
	http.ServeContent(w, r, a.Name, stat.ModTime(), file)
}
