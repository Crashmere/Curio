package library

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type playbackHDRSideData struct {
	Type         string  `json:"side_data_type"`
	MaxContent   float64 `json:"max_content"`
	MaxLuminance string  `json:"max_luminance"`
}

func playbackHDRDefaultPeak(transfer string) float64 {
	// Match FFmpeg's source-side defaults in units of 100 nits. Linearization
	// strips HDR side data and would otherwise hide PQ's 10,000-nit fallback.
	if transfer == "smpte2084" {
		return 100
	}
	return 10
}

func playbackHDRSignalPeak(transfer string, data []playbackHDRSideData) float64 {
	for _, item := range data {
		if item.Type == "Content light level metadata" && item.MaxContent > 0 && !math.IsInf(item.MaxContent, 0) && !math.IsNaN(item.MaxContent) {
			return item.MaxContent / 100
		}
	}
	for _, item := range data {
		if item.Type != "Mastering display metadata" {
			continue
		}
		parts := strings.SplitN(item.MaxLuminance, "/", 2)
		value := playbackNumber(parts[0])
		if len(parts) == 2 {
			denominator := playbackNumber(parts[1])
			if denominator == 0 {
				continue
			}
			value /= denominator
		}
		if value > 0 && !math.IsInf(value, 0) && !math.IsNaN(value) {
			return value / 100
		}
	}
	return playbackHDRDefaultPeak(transfer)
}

func (l *Library) probePlaybackHDRPeak(ctx context.Context, path, transfer string) float64 {
	// The descriptor probe already holds CPU admission. One selected video
	// packet plus decoder flushing exposes first-frame metadata without a scan.
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output := &boundedBuffer{maximum: 256 << 10}
	err := commandOutput(probeCtx, "ffprobe", output, "-v", "error", "-threads", "2", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_frames", "-show_entries", "frame_side_data=side_data_type,max_content,max_luminance", "-of", "json", path)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("HDR playback peak probe failed", "source", filepath.Base(path), "error", err)
		}
		return playbackHDRDefaultPeak(transfer)
	}
	var raw struct {
		Frames []struct {
			SideData []playbackHDRSideData `json:"side_data_list"`
		} `json:"frames"`
	}
	if err = json.Unmarshal(output.Bytes(), &raw); err != nil {
		slog.Warn("HDR playback peak metadata invalid", "source", filepath.Base(path), "error", err)
		return playbackHDRDefaultPeak(transfer)
	}
	if len(raw.Frames) == 0 {
		return playbackHDRDefaultPeak(transfer)
	}
	return playbackHDRSignalPeak(transfer, raw.Frames[0].SideData)
}

func playbackHDRFilters(spec *playbackSpec) []string {
	peak := spec.hdrPeak
	if peak <= 0 || math.IsNaN(peak) || math.IsInf(peak, 0) {
		peak = playbackHDRDefaultPeak(spec.transfer)
	}
	// Keep conversion and resize separate: zimg otherwise downsizes HDR samples
	// before linearization. Resizing here bounds the later float tone mapper.
	const fit = "min(1,1920/max(iw,ih))"
	scale := "zscale=w='max(2,trunc(round(iw*" + fit + ")/2)*2)'" +
		":h='max(2,trunc(round(ih*" + fit + ")/2)*2)'"
	return []string{
		"zscale=t=linear:npl=100",
		"format=gbrpf32le",
		scale,
		"tonemap=tonemap=mobius:desat=0:peak=" + strconv.FormatFloat(peak, 'f', -1, 64),
		"zscale=p=bt709:t=bt709:m=bt709:r=tv",
		"format=yuv420p",
	}
}
