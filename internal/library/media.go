package library

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type boundedBuffer struct {
	bytes.Buffer
	maximum int
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	n := len(data)
	if b.Len() < b.maximum {
		_, _ = b.Buffer.Write(data[:min(n, b.maximum-b.Len())])
	}
	return n, nil
}

func mediaCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 5 * time.Second
	cmd.Env = append(os.Environ(), "VIPS_CONCURRENCY=2", "VIPS_DISC_THRESHOLD=64m", "OMP_NUM_THREADS=1", "OPENBLAS_NUM_THREADS=1", "MAGICK_THREAD_LIMIT=1")
	return cmd
}
func command(ctx context.Context, name string, args ...string) ([]byte, error) {
	out := &boundedBuffer{maximum: 4 << 20}
	if err := commandOutput(ctx, name, out, args...); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func commandOutput(ctx context.Context, name string, output io.Writer, args ...string) error {
	timeout := 2 * time.Minute
	if name == "vips" || name == "vipsthumbnail" {
		timeout = 5 * time.Minute
	}
	if name == "ffmpeg" {
		timeout = 30 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := mediaCommand(ctx, name, args...)
	stderr := &boundedBuffer{maximum: 4096}
	cmd.Stdout = output
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (l *Library) cpuCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	release, err := l.acquireCPU(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return command(ctx, name, args...)
}

func (l *Library) Worker(ctx context.Context) {
	_, _ = l.DB.Exec("UPDATE assets SET status='queued',stage='queued',progress=0 WHERE status='processing' AND purge_pending=0")
	entries, _ := os.ReadDir(filepath.Join(l.Root, "work"))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() && len(name) > 65 && validHash.MatchString(name[:64]) && name[64] == '-' {
			_ = os.RemoveAll(filepath.Join(l.Root, "work", name))
		}
	}
	// Probe video support before admitting background GPU work.
	l.nvidiaAvailable(ctx)
	var workers sync.WaitGroup
	for i := 0; i < l.Workers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			for ctx.Err() == nil {
				if l.nextUploadDiscard() || l.nextPurge(ctx) || l.nextJob(ctx) {
					continue
				}
				select {
				case <-ctx.Done():
					return
				case <-l.Wake:
				case <-ticker.C:
				}
			}
		}()
	}
	workers.Wait()
	l.closeImageWorkers()
}

func (l *Library) nextJob(parent context.Context) bool {
	var hash string
	err := l.DB.QueryRow("SELECT id FROM assets WHERE status='queued' AND purge_pending=0 ORDER BY created_at LIMIT 1").Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		slog.Error("media queue", "error", err)
		return false
	}
	unlock := l.lock(hash)
	result, err := l.DB.Exec("UPDATE assets SET status='processing',stage='metadata',progress=0,error='',updated_at=? WHERE id=? AND status='queued' AND purge_pending=0", now(), hash)
	if err != nil {
		unlock()
		return false
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		unlock()
		return true
	}
	a, err := l.asset(hash)
	if err != nil {
		unlock()
		return false
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	job := &activeJob{cancel: cancel, done: make(chan struct{})}
	l.activeMu.Lock()
	l.active[hash] = job
	l.activeMu.Unlock()
	unlock()
	defer func() { cancel(); l.activeMu.Lock(); delete(l.active, hash); close(job.done); l.activeMu.Unlock() }()
	err = l.process(ctx, a)
	if err != nil {
		status := "error"
		if parent.Err() != nil {
			status = "queued"
		}
		_, _ = l.DB.Exec("UPDATE assets SET status=?,stage=?,error=?,updated_at=? WHERE id=? AND purge_pending=0", status, status, err.Error(), now(), hash)
		slog.Info("media processing failed", "asset", hash, "error", err)
	}
	return true
}

func (l *Library) nextPurge(ctx context.Context) bool {
	var hash string
	err := l.DB.QueryRow("SELECT id FROM assets WHERE purge_pending=1 AND (error='' OR updated_at<?) ORDER BY updated_at LIMIT 1", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)).Scan(&hash)
	if err != nil {
		return false
	}
	if err = l.finishPurge(ctx, hash); err != nil {
		_, _ = l.DB.Exec("UPDATE assets SET error=?,updated_at=? WHERE id=? AND purge_pending=1", err.Error(), now(), hash)
		slog.Error("permanent cleanup", "asset", hash, "error", err)
	}
	return true
}

func (l *Library) finishPurge(ctx context.Context, hash string) error {
	l.cancelPlayback([]string{hash})
	if err := l.waitPlayback(ctx, []string{hash}); err != nil {
		return err
	}
	unlock := l.lock(hash)
	defer unlock()
	l.activeMu.Lock()
	job := l.active[hash]
	if job != nil {
		job.cancel()
	}
	l.activeMu.Unlock()
	if job != nil {
		select {
		case <-job.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	a, err := l.asset(hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !a.purgePending {
		return nil
	}
	for _, path := range []string{l.Object(hash), l.Incoming(hash)} {
		if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		if _, e := os.Stat(filepath.Dir(path)); e == nil {
			if err = syncDir(filepath.Dir(path)); err != nil {
				return err
			}
		}
	}
	if err = os.RemoveAll(filepath.Dir(l.Derived(hash, "thumbnail", "png"))); err != nil {
		return err
	}
	derivedParent := filepath.Join(l.Root, "derived", hash[:2])
	if _, e := os.Stat(derivedParent); e == nil {
		if err = syncDir(derivedParent); err != nil {
			return err
		}
	}
	work, _ := filepath.Glob(filepath.Join(l.Root, "work", hash+"-*"))
	for _, path := range work {
		if err = os.RemoveAll(path); err != nil {
			return err
		}
	}
	tx, err := l.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM uploads WHERE id=?", hash); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM assets WHERE id=? AND purge_pending=1", hash); err != nil {
		return err
	}
	if err = pruneContainerCovers(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Library) stage(hash, stage, engine string, progress float64) {
	_, _ = l.DB.Exec("UPDATE assets SET stage=?,engine=?,progress=?,updated_at=? WHERE id=? AND purge_pending=0", stage, engine, progress, now(), hash)
}

func metaString(data map[string]any, names ...string) string {
	for _, name := range names {
		if value, ok := data[name]; ok {
			return fmt.Sprint(value)
		}
	}
	return ""
}
func metaNumber(data map[string]any, names ...string) float64 {
	value, _ := strconv.ParseFloat(metaString(data, names...), 64)
	return value
}

func (l *Library) process(ctx context.Context, a Asset) error {
	originalKind := a.Kind
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), a.ID+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	input := filepath.Join(work, "source."+a.Format)
	if err = os.Link(l.Object(a.ID), input); err != nil {
		return err
	}
	metadata := map[string]any{}
	if raw, e := l.cpuCommand(ctx, "exiftool", "-j", "-n", "-api", "LargeFileSupport=1", input); e == nil {
		var values []map[string]any
		if json.Unmarshal(raw, &values) == nil && len(values) > 0 {
			metadata = values[0]
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	a.Width = int(metaNumber(metadata, "ImageWidth", "ExifImageWidth"))
	a.Height = int(metaNumber(metadata, "ImageHeight", "ExifImageHeight"))
	if contentType := metaString(metadata, "MIMEType"); contentType != "" {
		a.MIME = contentType
	}
	if a.Kind == "video" {
		if err = l.video(ctx, &a, input, work); err != nil {
			return err
		}
	} else {
		if a.Format == "svg" {
			safe := filepath.Join(work, "safe.svg")
			if err = sanitizeSVG(input, safe); err != nil {
				return err
			}
			input = safe
		}
		if a.Format == "ico" {
			// Decode the selected icon frame once instead of repeatedly invoking
			// libvips' ImageMagick delegate for metadata and both derivatives.
			decoded := filepath.Join(work, "icon.png")
			decodeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			_, err = l.cpuCommand(decodeCtx, "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-i", input, "-frames:v", "1", "-threads", "2", "-y", decoded)
			cancel()
			if err != nil {
				return err
			}
			input = decoded
		}
		if isAnimation(input, a.Format) {
			a.Kind = "animation"
		}
		if a.Format == "gif" && metaNumber(metadata, "FrameCount") == 1 {
			a.Kind = "image"
		}
		if raw, e := l.cpuCommand(ctx, "vipsheader", "-f", "width", input); e == nil {
			a.Width, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		}
		if raw, e := l.cpuCommand(ctx, "vipsheader", "-f", "height", input); e == nil {
			a.Height, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		}
		if orientation := int(metaNumber(metadata, "Orientation")); orientation >= 5 && orientation <= 8 {
			a.Width, a.Height = a.Height, a.Width
		}
		bands := 0
		interpretation := ""
		if raw, e := l.cpuCommand(ctx, "vipsheader", "-f", "bands", input); e == nil {
			bands, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		}
		if raw, e := l.cpuCommand(ctx, "vipsheader", "-f", "interpretation", input); e == nil {
			interpretation = strings.TrimSpace(string(raw))
		}
		a.HasAlpha = bands == 2 || (bands == 4 && interpretation != "cmyk")
		if a.Format == "webp" || a.Format == "png" || a.Format == "apng" {
			a.HasAlpha = a.HasAlpha || encodedAlpha(input, a.Format)
		}
		tx, err := l.DB.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.Exec("UPDATE assets SET width=?,height=?,kind=?,mime=?,has_alpha=? WHERE id=? AND purge_pending=0", a.Width, a.Height, a.Kind, a.MIME, a.HasAlpha, a.ID); err != nil {
			return err
		}
		if a.Kind == "animation" && originalKind != "animation" {
			// Extension-based screenshot classification can precede animation detection.
			if _, err = tx.Exec("UPDATE screenshots SET enabled=0,game_id=NULL,captured_at='',source='manual' WHERE asset_id=? AND enabled=1", a.ID); err != nil {
				return err
			}
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		if err = l.image(ctx, &a, metadata, input, work); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if a.thumbnailExt == "" {
		return fmt.Errorf("无法生成预览，原件已保存")
	}
	for _, output := range []struct{ kind, ext string }{{"thumbnail", a.thumbnailExt}, {"preview", a.previewExt}} {
		if output.ext == "" {
			continue
		}
		source := filepath.Join(work, output.kind+"."+output.ext)
		target := l.Derived(a.ID, output.kind, output.ext)
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		f, e := os.OpenFile(source, os.O_RDWR, 0600)
		if e != nil {
			return e
		}
		e = f.Sync()
		f.Close()
		if e != nil {
			return e
		}
		if err = os.Rename(source, target); err != nil {
			return err
		}
		if err = syncDir(filepath.Dir(target)); err != nil {
			return err
		}
	}
	_, err = l.DB.Exec("UPDATE assets SET width=?,height=?,duration=?,kind=?,mime=?,has_alpha=?,thumbnail_ext=?,preview_ext=?,status='ready',stage='ready',progress=100,error='',updated_at=? WHERE id=? AND purge_pending=0", a.Width, a.Height, a.Duration, a.Kind, a.MIME, a.HasAlpha, a.thumbnailExt, a.previewExt, now(), a.ID)
	if err == nil && a.Kind == "video" {
		l.warmCoverStrip(a.ID)
	}
	return err
}

func (l *Library) image(ctx context.Context, a *Asset, metadata map[string]any, input, work string) error {
	engine := "CPU · 保留透明通道、动画或矢量预览"
	if a.Kind != "animation" && !a.HasAlpha && a.Format != "svg" && a.Format != "ico" {
		if err := l.imageGPU(ctx, a, metadata, input, work); err == nil {
			a.thumbnailExt = "jpg"
			a.previewExt = "jpg"
			return nil
		} else {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			engine = "CPU · " + err.Error()
		}
	}
	inputFrame := input
	if a.Kind == "animation" {
		inputFrame += "[n=1]"
	}
	for _, output := range []struct {
		kind    string
		maximum int
	}{{"thumbnail", 640}, {"preview", 2560}} {
		if a.Kind == "animation" && output.kind == "preview" {
			continue
		}
		frame, size := inputFrame, "down"
		if a.Format == "svg" {
			// Rasterize vector paths at their display resolution; enlarging a
			// logical-size bitmap would make small icons visibly blurred.
			size = "both"
			if dimension := max(a.Width, a.Height); dimension > 0 {
				frame = input + "[scale=" + strconv.FormatFloat(float64(output.maximum)/float64(dimension), 'g', 12, 64) + "]"
			}
		}
		l.stage(a.ID, output.kind, engine+" · libvips", 0)
		_, err := l.cpuCommand(ctx, "vips", "thumbnail", frame, filepath.Join(work, output.kind+".png")+"[strip,compression=6]", strconv.Itoa(output.maximum), "--height", strconv.Itoa(output.maximum), "--size", size)
		if err != nil {
			filter := fmt.Sprintf("scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease", output.maximum, output.maximum)
			if a.Format == "svg" {
				filter = fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", output.maximum, output.maximum)
			}
			_, err = l.cpuCommand(ctx, "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-i", input, "-vf", filter, "-frames:v", "1", "-threads", "2", "-y", filepath.Join(work, output.kind+".png"))
		}
		if err != nil {
			return err
		}
		if output.kind == "thumbnail" {
			a.thumbnailExt = "png"
		} else {
			a.previewExt = "png"
		}
	}
	return nil
}

func isAnimation(path, format string) bool {
	if format == "gif" || format == "apng" {
		return true
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if format == "png" {
		var signature [8]byte
		if _, err = io.ReadFull(f, signature[:]); err != nil {
			return false
		}
		for i := 0; i < 1000; i++ {
			var h [8]byte
			if _, err = io.ReadFull(f, h[:]); err != nil {
				return false
			}
			name := string(h[4:])
			if name == "acTL" {
				return true
			}
			if name == "IDAT" || name == "IEND" {
				return false
			}
			if _, err = f.Seek(int64(binary.BigEndian.Uint32(h[:4]))+4, io.SeekCurrent); err != nil {
				return false
			}
		}
	}
	if format == "webp" {
		var h [12]byte
		if _, err = io.ReadFull(f, h[:]); err != nil {
			return false
		}
		for i := 0; i < 1000; i++ {
			var chunk [8]byte
			if _, err = io.ReadFull(f, chunk[:]); err != nil {
				return false
			}
			size := binary.LittleEndian.Uint32(chunk[4:])
			name := string(chunk[:4])
			if name == "ANIM" || name == "ANMF" {
				return true
			}
			if name == "VP8X" && size > 0 {
				var flag [1]byte
				if _, err = f.Read(flag[:]); err == nil && flag[0]&2 != 0 {
					return true
				}
				if _, err = f.Seek(int64(size-1)+int64(size%2), io.SeekCurrent); err != nil {
					return false
				}
			} else if _, err = f.Seek(int64(size)+int64(size%2), io.SeekCurrent); err != nil {
				return false
			}
		}
	}
	return false
}

func encodedAlpha(path, format string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var h [32]byte
	n, _ := f.Read(h[:])
	if (format == "png" || format == "apng") && n >= 26 {
		return h[25] == 4 || h[25] == 6
	}
	if format == "webp" && n >= 21 && string(h[12:16]) == "VP8X" {
		return h[20]&16 != 0
	}
	return false
}

func safeURLReferences(value string) bool {
	lower := strings.ToLower(value)
	if strings.Contains(lower, "@import") || strings.Contains(lower, "javascript:") || strings.Contains(lower, "\\") {
		return false
	}
	for {
		index := strings.Index(lower, "url(")
		if index < 0 {
			return true
		}
		lower = lower[index+4:]
		end := strings.Index(lower, ")")
		if end < 0 {
			return false
		}
		target := strings.Trim(strings.TrimSpace(lower[:end]), "\"'")
		if !strings.HasPrefix(target, "#") {
			return false
		}
		lower = lower[end+1:]
	}
}

func sanitizeSVG(input, output string) error {
	f, err := os.Open(input)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	if stat.Size() > 16<<20 {
		return fmt.Errorf("SVG 超过安全预览大小，原件已保存")
	}
	decoder := xml.NewDecoder(io.LimitReader(f, 16<<20))
	out := &bytes.Buffer{}
	encoder := xml.NewEncoder(out)
	allowed := map[string]bool{}
	for _, name := range strings.Fields("svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern use symbol title desc") {
		allowed[name] = true
	}
	skip := 0
	root := false
	for {
		token, e := decoder.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return fmt.Errorf("SVG 解析失败: %w", e)
		}
		switch t := token.(type) {
		case xml.StartElement:
			if skip > 0 {
				skip++
				continue
			}
			if !allowed[t.Name.Local] {
				skip = 1
				continue
			}
			if !root {
				if t.Name.Local != "svg" {
					return fmt.Errorf("SVG 根节点无效")
				}
				root = true
			}
			t.Name.Space = ""
			attrs := []xml.Attr{}
			for _, attr := range t.Attr {
				name := strings.ToLower(attr.Name.Local)
				if strings.HasPrefix(name, "on") || attr.Name.Space == "xmlns" {
					continue
				}
				if name == "href" && !strings.HasPrefix(strings.TrimSpace(attr.Value), "#") {
					continue
				}
				if !safeURLReferences(attr.Value) {
					continue
				}
				attr.Name.Space = ""
				attrs = append(attrs, attr)
			}
			t.Attr = attrs
			if err = encoder.EncodeToken(t); err != nil {
				return err
			}
		case xml.EndElement:
			if skip > 0 {
				skip--
				continue
			}
			t.Name.Space = ""
			if err = encoder.EncodeToken(t); err != nil {
				return err
			}
		case xml.CharData:
			if skip == 0 {
				if err = encoder.EncodeToken(t); err != nil {
					return err
				}
			}
		}
	}
	if !root {
		return fmt.Errorf("SVG 根节点无效")
	}
	if err = encoder.Flush(); err != nil {
		return err
	}
	return os.WriteFile(output, out.Bytes(), 0600)
}
