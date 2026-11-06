package library

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type playbackSource struct {
	URL    string `json:"url"`
	Mime   string `json:"mime"`
	Codecs string `json:"codecs,omitempty"`
}

type playbackDescriptor struct {
	Source        *playbackSource `json:"source,omitempty"`
	Stream        playbackSource  `json:"stream"`
	Duration      float64         `json:"duration,omitempty"`
	FrameRate     float64         `json:"frameRate,omitempty"`
	FallbackError string          `json:"fallbackError,omitempty"`
}

type playbackSpec struct {
	hash, stamp, path          string
	duration, start, frameRate float64
	width, height              int
	nativeRotation             float64
	hdr                        bool
	hdrPeak                    float64
	transfer                   string
	colorPrimaries, colorSpace string
	sourceCodecs               string
	sourceMime                 string
	hasAlpha                   bool
}

var errPlaybackDeleted = errors.New("视频已被永久删除")
var errPlaybackIntegrity = errors.New("原件大小或类型异常，请检查存储")
var errPlaybackAlpha = errors.New("此透明视频无法生成保留透明通道的兼容播放，请下载原件查看")

func (l *Library) playbackAllowed(hash string) error {
	a, err := l.asset(hash)
	if err != nil {
		return err
	}
	if a.purgePending {
		return errPlaybackDeleted
	}
	if a.Kind != "video" {
		return sql.ErrNoRows
	}
	return nil
}

func videoHasAlpha(pixels, alphaMode string) bool {
	return alphaMode == "1" || strings.Contains(pixels, "yuva") || strings.Contains(pixels, "rgba") || strings.Contains(pixels, "bgra") || strings.Contains(pixels, "argb") || strings.Contains(pixels, "abgr") || strings.Contains(pixels, "gbrap")
}

func (l *Library) playbackOriginal(hash string) (Asset, os.FileInfo, error) {
	if err := l.playbackAllowed(hash); err != nil {
		return Asset{}, nil, err
	}
	f, err := l.asset(hash)
	if err != nil {
		return Asset{}, nil, err
	}
	stat, err := os.Lstat(l.Object(hash))
	if err != nil {
		return Asset{}, nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() != f.Size {
		return Asset{}, nil, fmt.Errorf("%w: original size or type changed", errPlaybackIntegrity)
	}
	return f, stat, nil
}

func (p *playbackCache) specification(ctx context.Context, l *Library, f Asset, stat os.FileInfo) (*playbackSpec, error) {
	key := fmt.Sprintf("probe:%s:%d:%d", f.ID, stat.Size(), stat.ModTime().UnixNano())
	p.mu.Lock()
	if cached, ok := p.specs[key]; ok {
		cached.used = time.Now()
		p.specs[key] = cached
		p.mu.Unlock()
		return cached.spec, nil
	}
	if job := p.jobs[key]; job != nil {
		if job.waiters == 0 {
			p.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-job.done:
				return p.specification(ctx, l, f, stat)
			}
		}
		job.waiters++
		p.mu.Unlock()
		if err := p.await(ctx, job); err != nil {
			return nil, err
		}
		return job.spec, nil
	}
	jobCtx, job, err := p.newJobLocked(key, f.ID, 2<<20, 20*time.Second)
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	go func() {
		spec, err := l.probePlayback(jobCtx, f.ID, key)
		p.finishJob(jobCtx, key, job, nil, spec, err)
	}()
	if err = p.await(ctx, job); err != nil {
		return nil, err
	}
	return job.spec, nil
}

func (l *Library) probePlayback(ctx context.Context, hash, stamp string) (*playbackSpec, error) {
	original, _, err := l.playbackOriginal(hash)
	if err != nil {
		return nil, err
	}
	release, err := l.acquirePlaybackCPU(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	output := &boundedBuffer{maximum: 256 << 10}
	err = commandOutput(ctx, "ffprobe", output, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=format_name,duration,start_time:stream=codec_type,codec_name,codec_tag_string,profile,width,height,pix_fmt,duration,start_time,avg_frame_rate,color_transfer,color_primaries,color_space:stream_tags=alpha_mode:stream_side_data=rotation", "-of", "json", l.Object(hash))
	if err != nil {
		return nil, err
	}
	var raw struct {
		Streams []struct {
			Type      string            `json:"codec_type"`
			Codec     string            `json:"codec_name"`
			Tag       string            `json:"codec_tag_string"`
			Profile   string            `json:"profile"`
			Pixels    string            `json:"pix_fmt"`
			Width     int               `json:"width"`
			Height    int               `json:"height"`
			Duration  string            `json:"duration"`
			Start     string            `json:"start_time"`
			Rate      string            `json:"avg_frame_rate"`
			Transfer  string            `json:"color_transfer"`
			Primaries string            `json:"color_primaries"`
			Space     string            `json:"color_space"`
			Tags      map[string]string `json:"tags"`
			SideData  []struct {
				Rotation *float64 `json:"rotation"`
			} `json:"side_data_list"`
		} `json:"streams"`
		Format struct {
			Name     string `json:"format_name"`
			Duration string `json:"duration"`
			Start    string `json:"start_time"`
		} `json:"format"`
	}
	if err = json.Unmarshal(output.Bytes(), &raw); err != nil {
		return nil, err
	}
	spec := &playbackSpec{hash: hash, stamp: stamp, path: l.Object(hash)}
	video, audio, audioCompatible, audioAAC := false, false, true, false
	videoCodec, audioCodec := "", ""
	for _, stream := range raw.Streams {
		if stream.Type == "audio" && !audio {
			audioAAC = stream.Codec == "aac" && stream.Profile == "LC"
			// PCM16 QuickTime recordings can play without converting the video.
			audio, audioCompatible = true, audioAAC || stream.Codec == "pcm_s16le"
			audioCodec = stream.Codec
		}
		if stream.Type != "video" || video {
			continue
		}
		video = true
		videoCodec = stream.Codec
		spec.hasAlpha = videoHasAlpha(stream.Pixels, stream.Tags["alpha_mode"])
		spec.width, spec.height = stream.Width, stream.Height
		spec.duration = playbackNumber(stream.Duration)
		spec.start, _ = strconv.ParseFloat(stream.Start, 64)
		if stream.Start == "" || stream.Start == "N/A" {
			spec.start, _ = strconv.ParseFloat(raw.Format.Start, 64)
		}
		parts := strings.Split(stream.Rate, "/")
		if len(parts) == 2 {
			denominator := playbackNumber(parts[1])
			if denominator > 0 {
				spec.frameRate = playbackNumber(parts[0]) / denominator
			}
		}
		spec.transfer = stream.Transfer
		spec.colorPrimaries, spec.colorSpace = stream.Primaries, stream.Space
		spec.hdr = stream.Transfer == "smpte2084" || stream.Transfer == "arib-std-b67"
		for _, data := range stream.SideData {
			if data.Rotation != nil {
				spec.nativeRotation = *data.Rotation
			}
		}
		if stream.Codec == "h264" && (stream.Tag == "avc1" || stream.Tag == "avc3") && (stream.Profile == "Constrained Baseline" || stream.Profile == "Baseline" || stream.Profile == "Main" || stream.Profile == "High") && (stream.Pixels == "yuv420p" || stream.Pixels == "yuvj420p") {
			spec.sourceCodecs = stream.Tag
		}
		if stream.Codec == "hevc" && (stream.Tag == "hvc1" || stream.Tag == "hev1") && (stream.Profile == "Main" || stream.Profile == "Main 10") {
			spec.sourceCodecs = stream.Tag
		}
	}
	if spec.duration <= 0 {
		spec.duration = playbackNumber(raw.Format.Duration)
	}
	if !video || spec.width <= 0 || spec.height <= 0 || spec.duration <= 0 || math.IsNaN(spec.start) || math.IsInf(spec.start, 0) {
		return nil, errPlaybackTime
	}
	iso, webm := false, false
	for _, name := range strings.Split(raw.Format.Name, ",") {
		iso = iso || name == "mov" || name == "mp4"
		webm = webm || name == "webm"
	}
	declaredWebM := original.Format == "webm" || strings.TrimSpace(strings.ToLower(strings.SplitN(original.MIME, ";", 2)[0])) == "video/webm"
	if iso && audioCompatible && spec.sourceCodecs != "" {
		spec.sourceMime = "video/mp4"
		if audioAAC {
			spec.sourceCodecs += ", mp4a.40.2"
		}
	} else {
		spec.sourceCodecs = ""
	}
	if webm && declaredWebM && (!audio || audioCodec == "opus" || audioCodec == "vorbis") {
		switch videoCodec {
		case "vp8", "vp9":
			spec.sourceCodecs = videoCodec
		case "av1":
			spec.sourceCodecs = "av01"
		}
		if spec.sourceCodecs != "" {
			spec.sourceMime = "video/webm"
			if audio {
				spec.sourceCodecs += ", " + audioCodec
			}
		}
	}
	// Native playback exposes source PTS; the compatibility stream starts at zero.
	if math.Abs(spec.start) > 0.001 {
		spec.sourceCodecs = ""
	}
	if spec.hdr {
		spec.hdrPeak = l.probePlaybackHDRPeak(ctx, spec.path, spec.transfer)
	}
	if err = l.playbackAllowed(hash); err != nil {
		return nil, err
	}
	return spec, nil
}

func playbackNumber(text string) float64 {
	v, err := strconv.ParseFloat(text, 64)
	if err != nil || v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func (l *Library) playbackRequest(r *http.Request) (*playbackCache, *playbackSpec, error) {
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		return nil, nil, sql.ErrNoRows
	}
	f, stat, err := l.playbackOriginal(hash)
	if err != nil {
		return nil, nil, err
	}
	p, err := l.playbackManager()
	if err != nil {
		return nil, nil, err
	}
	spec, err := p.specification(r.Context(), l, f, stat)
	return p, spec, err
}

func playbackFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, errPlaybackDeleted):
		fail(w, 404, "视频或资源不存在")
	case errors.Is(err, errPlaybackIntegrity):
		writeJSON(w, 409, map[string]string{"error": err.Error(), "code": "original_integrity_error"})
	case os.IsNotExist(err):
		writeJSON(w, 503, map[string]string{"error": "原件暂不可读，请检查存储", "code": "original_missing"})
	case errors.Is(err, errPlaybackAlpha):
		writeJSON(w, 415, map[string]string{"error": err.Error(), "code": "alpha_playback_unsupported"})
	case errors.Is(err, errPlaybackTime):
		fail(w, 400, err)
	default:
		writeJSON(w, 503, map[string]string{"error": "视频播放暂不可用，请稍后重试", "code": "playback_unavailable"})
	}
}

func (l *Library) playbackInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_, spec, err := l.playbackRequest(r)
	if err != nil {
		playbackFailure(w, err)
		return
	}
	result := playbackDescriptor{Stream: playbackSource{URL: fmt.Sprintf("/curio/media/%s/stream/index.m3u8", spec.hash), Mime: "application/vnd.apple.mpegurl"}, Duration: spec.duration, FrameRate: spec.frameRate}
	if spec.hasAlpha {
		result.FallbackError = errPlaybackAlpha.Error()
	}
	if spec.sourceCodecs != "" {
		result.Source = &playbackSource{URL: "/curio/media/" + spec.hash + "/source", Mime: spec.sourceMime, Codecs: spec.sourceCodecs}
	}
	if err = l.playbackAllowed(spec.hash); err != nil {
		playbackFailure(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (l *Library) streamPlaylist(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_, spec, err := l.playbackRequest(r)
	if err == nil && spec.hasAlpha {
		err = errPlaybackAlpha
	}
	if err != nil {
		playbackFailure(w, err)
		return
	}
	var playlist strings.Builder
	playlist.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	for index, count := 0, int(math.Ceil(spec.duration/playbackSegmentSeconds)); index < count; index++ {
		duration := min(playbackSegmentSeconds, spec.duration-float64(index)*playbackSegmentSeconds)
		fmt.Fprintf(&playlist, "#EXTINF:%.6f,\n%d.ts\n", duration, index)
	}
	playlist.WriteString("#EXT-X-ENDLIST\n")
	if err = l.playbackAllowed(spec.hash); err != nil {
		playbackFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, "index.m3u8", time.Time{}, strings.NewReader(playlist.String()))
}

func (l *Library) streamSegment(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, spec, err := l.playbackRequest(r)
	if err == nil && spec.hasAlpha {
		err = errPlaybackAlpha
	}
	index, parseErr := strconv.Atoi(chi.URLParam(r, "segment"))
	if err == nil && (parseErr != nil || index < 0 || float64(index)*playbackSegmentSeconds >= spec.duration) {
		err = errPlaybackTime
	}
	if err != nil {
		playbackFailure(w, err)
		return
	}
	var entry *playbackEntry
	if r.Method == http.MethodHead {
		p.mu.Lock()
		p.expireLocked(time.Now())
		entry = p.entries[playbackSegmentKey(spec, index)]
		if entry != nil {
			entry.refs++
			entry.used = time.Now()
		}
		p.mu.Unlock()
	} else {
		entry, err = p.segment(r.Context(), l, spec, index)
	}
	if err != nil {
		playbackFailure(w, err)
		return
	}
	if entry != nil {
		defer p.release(entry)
	}
	if err = l.playbackAllowed(spec.hash); err != nil {
		playbackFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "video/mp2t")
	if entry == nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("ETag", entry.etag)
	w.Header().Set("X-Curio-Playback-Engine", entry.engine)
	http.ServeContent(w, r, fmt.Sprintf("%d.ts", index), time.Time{}, bytes.NewReader(entry.data))
}
