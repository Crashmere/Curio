package library

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type videoProbe struct {
	Streams []struct {
		CodecType   string `json:"codec_type"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		Duration    string `json:"duration"`
		PixelFormat string `json:"pix_fmt"`
		SideData    []struct {
			Rotation int `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func (l *Library) acquireGPU(ctx context.Context) (func(), error) {
	select {
	case l.GPU <- struct{}{}:
		return func() { <-l.GPU }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (l *Library) nvidiaAvailable(ctx context.Context) bool {
	l.gpuOnce.Do(func() {
		if os.Getenv("CURIO_GPU") == "cpu" {
			return
		}
		probe, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		release, err := l.acquireGPU(probe)
		if err != nil {
			return
		}
		defer release()
		_, err = command(probe, "ffmpeg", "-nostdin", "-v", "error", "-filter_threads", "1", "-threads", "2", "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu", "-f", "lavfi", "-i", "color=size=640x480:rate=1", "-vf", "format=nv12,hwupload,scale_cuda=320:240", "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-")
		l.gpuAvailable = err == nil
	})
	return l.gpuAvailable
}

func (l *Library) video(ctx context.Context, a *Asset, input, work string) error {
	data, err := command(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", input)
	if err != nil {
		return err
	}
	var probe videoProbe
	if err = json.Unmarshal(data, &probe); err != nil {
		return err
	}
	rotation := 0
	found := false
	for _, stream := range probe.Streams {
		if stream.CodecType != "video" {
			continue
		}
		found = true
		a.Width, a.Height = stream.Width, stream.Height
		a.Duration, _ = strconv.ParseFloat(stream.Duration, 64)
		a.HasAlpha = strings.Contains(stream.PixelFormat, "yuva") || strings.Contains(stream.PixelFormat, "rgba") || strings.Contains(stream.PixelFormat, "gbrap")
		for _, side := range stream.SideData {
			rotation = side.Rotation
		}
		break
	}
	if !found {
		return fmt.Errorf("没有可播放的视频画面，原件已保存")
	}
	if a.Duration <= 0 {
		a.Duration, _ = strconv.ParseFloat(probe.Format.Duration, 64)
	}
	if rotation%180 != 0 {
		a.Width, a.Height = a.Height, a.Width
	}
	_, _ = l.DB.Exec("UPDATE assets SET width=?,height=?,duration=?,has_alpha=? WHERE id=? AND purge_pending=0", a.Width, a.Height, a.Duration, a.HasAlpha, a.ID)
	modes := []string{"CPU"}
	if l.nvidiaAvailable(ctx) {
		modes = []string{"NVIDIA GPU · 软件解码", "CPU"}
		if rotation == 0 && !a.HasAlpha {
			modes = append([]string{"NVIDIA GPU"}, modes...)
		}
	}
	for _, step := range []string{"thumbnail", "preview"} {
		var lastErr error
		succeeded := false
		for _, engine := range modes {
			if step == "thumbnail" && engine == "NVIDIA GPU" {
				continue
			}
			gpu := engine != "CPU"
			release := func() {}
			if gpu {
				release, err = l.acquireGPU(ctx)
				if err != nil {
					return err
				}
			}
			args := []string{"-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"}
			if gpu {
				args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
				if engine == "NVIDIA GPU" {
					args = append(args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda")
				}
			}
			args = append(args, "-i", input, "-map", "0:v:0")
			scale := "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
			if step == "thumbnail" {
				scale = "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease"
			}
			if gpu {
				scale = strings.Replace(scale, "scale=", "scale_cuda=", 1)
				if engine != "NVIDIA GPU" {
					scale = "format=nv12,hwupload," + scale
				}
				if step == "thumbnail" {
					scale += ":format=yuv420p,hwdownload,format=yuv420p"
				} else {
					scale += ":format=nv12"
				}
			}
			args = append(args, "-vf", scale)
			output := filepath.Join(work, step+".mp4")
			if step == "thumbnail" {
				output = filepath.Join(work, step+".png")
				args = append(args, "-frames:v", "1", "-map_metadata", "-1")
			} else {
				args = append(args, "-map", "0:a?")
				if gpu {
					args = append(args, "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-b:v", "0")
				} else {
					args = append(args, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p")
				}
				args = append(args, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart")
			}
			args = append(args, "-threads", "2", "-y", output)
			displayEngine := engine
			if !gpu {
				if lastErr != nil {
					displayEngine = "CPU · NVIDIA 处理失败，兼容回退"
				} else {
					displayEngine = "CPU · NVIDIA 编解码不可用"
				}
			}
			l.stage(a.ID, step, displayEngine, 0)
			lastErr = l.ffmpeg(ctx, a.ID, step, displayEngine, a.Duration, args)
			release()
			if lastErr == nil {
				succeeded = true
				break
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
		}
		if !succeeded {
			return lastErr
		}
		if step == "thumbnail" {
			a.thumbnailExt = "png"
		} else {
			a.previewExt = "mp4"
		}
	}
	return nil
}

func (l *Library) ffmpeg(parent context.Context, hash, stage, engine string, duration float64, args []string) error {
	timeout := 30 * time.Minute
	if stage == "thumbnail" {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := mediaCommand(ctx, "ffmpeg", append([]string{"-nostdin", "-v", "error", "-progress", "pipe:1", "-nostats"}, args...)...)
	stderr := &boundedBuffer{maximum: 4096}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	last := time.Time{}
	for scanner.Scan() {
		if value, ok := strings.CutPrefix(scanner.Text(), "out_time_us="); ok && duration > 0 && stage == "preview" && time.Since(last) > time.Second {
			micros, e := strconv.ParseFloat(value, 64)
			if e == nil {
				l.stage(hash, stage, engine, max(0, min(99.9, micros/(duration*10000))))
				last = time.Now()
			}
		}
	}
	if err = cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	return nil
}
