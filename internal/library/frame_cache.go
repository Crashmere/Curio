package library

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const frameRecipe = "original-frame-jpeg-v1"
const frameImageLimit = int64(8 << 20)

type frameWaiter struct {
	preview bool
	ready   chan struct{}
}

func (p *playbackCache) acquireFrameSlot(ctx context.Context, preview bool) (func(), error) {
	waiter := &frameWaiter{preview: preview, ready: make(chan struct{})}
	p.mu.Lock()
	p.frameWaiters = append(p.frameWaiters, waiter)
	p.dispatchFramesLocked()
	p.mu.Unlock()
	select {
	case <-ctx.Done():
		p.mu.Lock()
		queued := false
		for i, candidate := range p.frameWaiters {
			if candidate == waiter {
				p.frameWaiters = append(p.frameWaiters[:i], p.frameWaiters[i+1:]...)
				queued = true
				break
			}
		}
		if !queued {
			p.frameActive--
			p.dispatchFramesLocked()
		}
		p.mu.Unlock()
		return nil, ctx.Err()
	case <-waiter.ready:
		return func() {
			p.mu.Lock()
			p.frameActive--
			p.dispatchFramesLocked()
			p.mu.Unlock()
		}, nil
	}
}

func (p *playbackCache) dispatchFramesLocked() {
	for p.frameActive < 2 && len(p.frameWaiters) > 0 {
		index := 0
		for i, waiter := range p.frameWaiters {
			if waiter.preview {
				index = i
				break
			}
		}
		waiter := p.frameWaiters[index]
		p.frameWaiters = append(p.frameWaiters[:index], p.frameWaiters[index+1:]...)
		p.frameActive++
		close(waiter.ready)
	}
}

func (spec *playbackSpec) frameVideo() (frameVideo, error) {
	result := frameVideo{Width: spec.width, Height: spec.height, Duration: spec.duration, Start: spec.frameStart, TimeBase: spec.timeBase}
	if result.TimeBase <= 0 || math.IsNaN(result.TimeBase) || math.IsInf(result.TimeBase, 0) || math.IsNaN(result.Start) || math.IsInf(result.Start, 0) {
		return result, errFrameTime
	}
	if int(math.Round(math.Abs(spec.nativeRotation)))%180 == 90 {
		result.Width, result.Height = result.Height, result.Width
	}
	return result, nil
}

func (p *playbackCache) frame(ctx context.Context, l *Library, spec *playbackSpec, owner string, at float64, rotation, dimension int) (*playbackEntry, error) {
	key := fmt.Sprintf("frame:%s:%s:%s:%d:%d:%s", owner, spec.stamp, frameRecipe, rotation, dimension, strconv.FormatFloat(at, 'g', -1, 64))
	p.mu.Lock()
	p.expireLocked(time.Now())
	// Deletion takes this same cache lock to cancel and collect registered jobs.
	for _, hash := range []string{owner, spec.hash} {
		if err := l.playbackAllowed(hash); err != nil {
			p.mu.Unlock()
			return nil, err
		}
	}
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
				return p.frame(ctx, l, spec, owner, at, rotation, dimension)
			}
		}
		job.waiters++
		p.mu.Unlock()
		if err := p.await(ctx, job); err != nil {
			return nil, err
		}
		return job.entry, nil
	}
	jobCtx, job, err := p.newJobLocked(key, spec.hash, frameImageLimit, 5*time.Minute, true)
	if err == nil {

	}
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	go func() {
		release, err := p.acquireFrameSlot(jobCtx, dimension > 640)
		var data []byte
		if err == nil {
			data, err = l.encodeFrame(jobCtx, p.scratch, spec, at, rotation, dimension)
			release()
		}
		for _, hash := range []string{owner, spec.hash} {
			if err == nil {
				err = l.playbackAllowed(hash)
			}
		}
		var entry *playbackEntry
		if err == nil {
			entry = &playbackEntry{key: key, hash: spec.hash, data: data}
		}
		p.finishJob(jobCtx, key, job, entry, nil, err)
	}()
	if err = p.await(ctx, job); err != nil {
		return nil, err
	}
	return job.entry, nil
}

func (l *Library) encodeFrame(ctx context.Context, scratch string, spec *playbackSpec, at float64, rotation, dimension int) ([]byte, error) {
	ctx = context.WithValue(ctx, foregroundMediaKey{}, true)
	probe, err := spec.frameVideo()
	if err != nil {
		return nil, err
	}
	selected, err := l.containingFrame(ctx, spec.hash, at, probe)
	if err != nil {
		return nil, err
	}
	work, err := os.MkdirTemp(scratch, spec.hash+"-frame-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	name := "frame.jpg"
	if spec.hasAlpha {
		name = "frame.png"
	}
	output := filepath.Join(work, name)
	var filters []string
	if spec.hdr {
		filters = coverHDRFilters(spec, dimension)
	}
	if err = l.renderVideoFrame(ctx, spec.path, output, selected, dimension, filters, spec); err != nil {
		return nil, err
	}
	if rotation != 0 {
		orientation := map[int]string{90: "6", 180: "3", 270: "8"}[rotation]
		if _, err = command(ctx, "exiftool", "-n", "-EXIF:Orientation="+orientation, "-overwrite_original", output); err != nil {
			return nil, err
		}
	}
	stat, err := os.Stat(output)
	if err != nil {
		return nil, err
	}
	if stat.Size() <= 0 || stat.Size() >= frameImageLimit {
		return nil, fmt.Errorf("frame exceeds its output bound or contains no image")
	}
	return os.ReadFile(output)
}
