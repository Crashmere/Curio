package library

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type videoProbe struct {
	Streams []struct {
		CodecType   string            `json:"codec_type"`
		Codec       string            `json:"codec_name"`
		Width       int               `json:"width"`
		Height      int               `json:"height"`
		Duration    string            `json:"duration"`
		PixelFormat string            `json:"pix_fmt"`
		Tags        map[string]string `json:"tags"`
		SideData    []struct {
			Rotation int `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func (l *Library) nvidiaAvailable(_ context.Context) bool {
	l.gpuOnce.Do(func() {
		if os.Getenv("CURIO_GPU") == "cpu" {
			return
		}
		ctx := l.runtimeCtx
		if ctx == nil {
			ctx = context.Background()
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

func (l *Library) video(parent context.Context, a *Asset, input, work string) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()
	data, err := l.cpuCommand(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", input)
	if err != nil {
		return err
	}
	var probe videoProbe
	if err = json.Unmarshal(data, &probe); err != nil {
		return err
	}
	rotation, codec, found := 0, "", false
	for _, stream := range probe.Streams {
		if stream.CodecType != "video" {
			continue
		}
		found, codec = true, stream.Codec
		a.Width, a.Height = stream.Width, stream.Height
		a.Duration = playbackNumber(stream.Duration)
		a.HasAlpha = videoHasAlpha(stream.PixelFormat, stream.Tags["alpha_mode"])
		for _, side := range stream.SideData {
			rotation = side.Rotation
		}
		break
	}
	if !found {
		return fmt.Errorf("没有可播放的视频画面，原件已保存")
	}
	if a.Duration <= 0 {
		a.Duration = playbackNumber(probe.Format.Duration)
	}
	if rotation%180 != 0 {
		a.Width, a.Height = a.Height, a.Width
	}
	a.previewExt = ""
	_, _ = l.DB.Exec("UPDATE assets SET width=?,height=?,duration=?,has_alpha=? WHERE id=? AND purge_pending=0", a.Width, a.Height, a.Duration, a.HasAlpha, a.ID)
	modes := []string{"CPU"}
	if !a.HasAlpha && l.nvidiaAvailable(ctx) {
		modes = []string{"NVIDIA GPU · 软件解码", "CPU"}
	}
	var lastErr error
	for _, engine := range modes {
		if err = ctx.Err(); err != nil {
			return err
		}
		releaseCPU, err := l.acquireCPU(ctx)
		if err != nil {
			return err
		}
		var releaseGPU func()
		gpu := engine != "CPU"
		if gpu {
			releaseGPU, err = l.acquireGPU(ctx)
			if err != nil {
				releaseCPU()
				return err
			}
		}
		args := []string{"-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"}
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
		}
		if a.HasAlpha {
			switch codec {
			case "vp8":
				args = append(args, "-c:v", "libvpx")
			case "vp9":
				args = append(args, "-c:v", "libvpx-vp9")
			}
		}
		args = append(args, "-i", input, "-map", "0:v:0")
		scale := "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease"
		if gpu {
			scale = "format=nv12,hwupload," + strings.Replace(scale, "scale=", "scale_cuda=", 1) + ":format=yuv420p,hwdownload,format=yuv420p"
		}
		args = append(args, "-vf", scale, "-frames:v", "1", "-map_metadata", "-1", "-threads", "2", "-y", filepath.Join(work, "thumbnail.png"))
		displayEngine := engine
		if !gpu && lastErr != nil {
			displayEngine = "CPU · NVIDIA 处理失败，兼容回退"
		}
		l.stage(a.ID, "thumbnail", displayEngine, 0)
		_, lastErr = command(ctx, "ffmpeg", args...)
		if releaseGPU != nil {
			releaseGPU()
		}
		releaseCPU()
		if lastErr == nil {
			a.thumbnailExt = "png"
			return nil
		}
	}
	return lastErr
}
