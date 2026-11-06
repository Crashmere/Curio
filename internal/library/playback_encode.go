package library

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func (p *playbackCache) segment(ctx context.Context, l *Library, spec *playbackSpec, index int) (*playbackEntry, error) {
	key := playbackSegmentKey(spec, index)
	p.mu.Lock()
	p.expireLocked(time.Now())
	if entry := p.entries[key]; entry != nil {
		entry.refs++
		entry.used = time.Now()
		p.mu.Unlock()
		return entry, nil
	}
	if job := p.jobs[key]; job != nil {
		if job.waiters == 0 {
			p.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-job.done:
				return p.segment(ctx, l, spec, index)
			}
		}
		job.waiters++
		p.mu.Unlock()
		if err := p.await(ctx, job); err != nil {
			return nil, err
		}
		return job.entry, nil
	}
	jobCtx, job, err := p.newJobLocked(key, spec.hash, playbackReservation, playbackDeadline)
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	go func() {
		select {
		case p.slots <- struct{}{}:
		case <-jobCtx.Done():
			p.finishJob(jobCtx, key, job, nil, nil, jobCtx.Err())
			return
		}
		data, engine, err := l.encodePlaybackSegment(jobCtx, p.scratch, spec, index)
		<-p.slots
		var entry *playbackEntry
		if err == nil {
			err = l.playbackAllowed(spec.hash)
		}
		if err == nil {
			entry = &playbackEntry{key: key, hash: spec.hash, engine: engine, data: data, etag: fmt.Sprintf("\"%x\"", sha256.Sum256(data))}
		} else if jobCtx.Err() == nil {
			slog.Warn("temporary video segment failed", "hash", spec.hash, "segment", index, "error", err)
		}
		p.finishJob(jobCtx, key, job, entry, nil, err)
	}()
	if err = p.await(ctx, job); err != nil {
		return nil, err
	}
	return job.entry, nil
}

func playbackSegmentKey(spec *playbackSpec, index int) string {
	return fmt.Sprintf("segment:%s:%s:%d", spec.stamp, playbackRecipe, index)
}

func (l *Library) encodePlaybackSegment(ctx context.Context, scratch string, spec *playbackSpec, index int) ([]byte, string, error) {
	if spec.hasAlpha {
		return nil, "", errPlaybackAlpha
	}
	if _, _, err := l.playbackOriginal(spec.hash); err != nil {
		return nil, "", err
	}
	work, err := os.MkdirTemp(scratch, spec.hash+"-")
	if err != nil {
		return nil, "", err
	}
	defer os.RemoveAll(work)
	output := filepath.Join(work, "segment.ts")
	start := float64(index) * playbackSegmentSeconds
	duration := min(playbackSegmentSeconds, spec.duration-start)
	if duration <= 0 {
		return nil, "", errPlaybackTime
	}
	modes := []string{"cpu"}
	// The capability probe takes its own slot; never call it while holding one.
	if l.nvidiaAvailable(ctx) {
		modes = []string{"nvenc-software", "cpu"}
		if math.Abs(math.Remainder(spec.nativeRotation, 360)) < 0.001 && !spec.hdr {
			modes = append([]string{"nvenc-cuda"}, modes...)
		}
	}
	for _, mode := range modes {
		if err = ctx.Err(); err != nil {
			return nil, "", err
		}
		filterThreads := "1"
		if spec.hdr {
			// Float tone mapping is CPU-only on NAS; bound its slice workers to four.
			filterThreads = "4"
		}
		args := []string{"-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", filterThreads, "-filter_complex_threads", "1"}
		gpu := mode != "cpu"
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
		}
		if mode == "nvenc-cuda" {
			args = append(args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda")
		}
		// Absolute input seeking preserves videos whose first PTS is nonzero.
		args = append(args, "-seek_timestamp", "1", "-ss", playbackTime(spec.start+start), "-i", spec.path, "-t", playbackTime(duration), "-map", "0:v:0", "-map", "0:a:0?")
		filters := []string{}
		if spec.hdr {
			filters = append(filters, playbackHDRFilters(spec)...)
		}
		const scale = "w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
		if gpu {
			if mode != "nvenc-cuda" {
				filters = append(filters, "format=nv12", "hwupload")
			}
			filters = append(filters, "scale_cuda="+scale+":format=nv12")
		} else {
			filters = append(filters, "scale="+scale, "format=yuv420p")
		}
		args = append(args, "-vf", strings.Join(filters, ","), "-fps_mode", "passthrough")
		gop := max(1, min(600, int(math.Ceil(max(30, spec.frameRate)*playbackSegmentSeconds))))
		if gpu {
			args = append(args, "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "22", "-b:v", "0", "-maxrate", "8M", "-bufsize", "8M", "-forced-idr", "1")
		} else {
			args = append(args, "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-maxrate", "8M", "-bufsize", "8M")
		}
		args = append(args, "-g", strconv.Itoa(gop), "-bf", "0", "-force_key_frames", "0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-map_metadata", "-1")
		if spec.hdr {
			args = append(args, "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv")
		}
		// A fixed positive bias avoids negative AAC priming/wrapped TS timestamps.
		args = append(args, "-output_ts_offset", playbackTime(start+1), "-avoid_negative_ts", "disabled", "-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", "-fs", strconv.FormatInt(playbackSegmentLimit, 10), "-threads", "2", "-y", output)
		var releaseCPU, releaseGPU func()
		if mode != "nvenc-cuda" {
			releaseCPU, err = l.acquirePlaybackCPU(ctx)
			if err != nil {
				return nil, "", err
			}
		}
		if gpu {
			releaseGPU, err = l.acquirePlaybackGPU(ctx)
			if err != nil {
				if releaseCPU != nil {
					releaseCPU()
				}
				return nil, "", err
			}
		}
		_, err = command(ctx, "ffmpeg", args...)
		if releaseGPU != nil {
			releaseGPU()
		}
		if releaseCPU != nil {
			releaseCPU()
		}
		if err == nil {
			stat, e := os.Stat(output)
			if e != nil {
				err = e
			} else if stat.Size() <= 0 || stat.Size() >= playbackSegmentLimit {
				err = fmt.Errorf("segment exceeds its output bound or contains no media")
			} else {
				data, e := os.ReadFile(output)
				if e == nil {
					return data, mode, nil
				}
				err = e
			}
		}
		if gpu && ctx.Err() == nil {
			slog.Info("retry temporary video segment with fallback engine", "hash", spec.hash, "segment", index, "engine", mode, "error", err)
		}
	}
	return nil, "", err
}

func playbackTime(seconds float64) string {
	return strconv.FormatFloat(seconds, 'f', 6, 64)
}
