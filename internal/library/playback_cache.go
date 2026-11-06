package library

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	playbackSegmentSeconds = 4.0
	playbackCacheLimit     = int64(256 << 20)
	playbackSegmentLimit   = int64(8 << 20)
	playbackReservation    = 2 * playbackSegmentLimit
	playbackCacheTTL       = 20 * time.Minute
	playbackDeadline       = 75 * time.Second
	playbackRecipe         = "h264-ts-sdr-v1"
)

var errPlaybackClosed = errors.New("视频播放暂不可用")
var errPlaybackBusy = errors.New("视频播放繁忙，请稍后重试")
var errPlaybackTime = errors.New("请选择视频时长内的有效片段")

type playbackEntry struct {
	key, hash, etag, engine string
	data                    []byte
	used                    time.Time
	refs                    int
	retired                 bool
}

type playbackJob struct {
	hash     string
	cancel   context.CancelFunc
	done     chan struct{}
	waiters  int
	finished bool
	entry    *playbackEntry
	spec     *playbackSpec
	err      error
	reserve  int64
}

type playbackSpecEntry struct {
	spec *playbackSpec
	used time.Time
}

type playbackCache struct {
	ctx      context.Context
	cancel   context.CancelFunc
	scratch  string
	mu       sync.Mutex
	entries  map[string]*playbackEntry
	specs    map[string]playbackSpecEntry
	jobs     map[string]*playbackJob
	bytes    int64
	reserved int64
	closed   bool
	slots    chan struct{}
	running  sync.WaitGroup
}

func (l *Library) StartPlayback(parent context.Context) error {
	if err := parent.Err(); err != nil {
		return err
	}
	l.playbackMu.Lock()
	defer l.playbackMu.Unlock()
	if l.playback != nil {
		return fmt.Errorf("playback is already running")
	}
	base := os.Getenv("CURIO_PLAYBACK_CACHE")
	if base == "" {
		base = filepath.Join(l.Root, "work", "playback")
	}
	base, err := filepath.Abs(base)
	if err != nil {
		return err
	}
	for _, protected := range []string{"assets", "derived", "incoming"} {
		path := filepath.Join(l.Root, protected)
		if base == path || strings.HasPrefix(base, path+string(os.PathSeparator)) {
			return fmt.Errorf("playback scratch cannot use original or durable media storage")
		}
	}
	if err = os.MkdirAll(base, 0700); err != nil {
		return err
	}
	if info, e := os.Lstat(base); e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("playback scratch must be a real directory")
	}
	scratch, err := os.MkdirTemp(base, "session-")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	p := &playbackCache{ctx: ctx, cancel: cancel, scratch: scratch, entries: map[string]*playbackEntry{}, specs: map[string]playbackSpecEntry{}, jobs: map[string]*playbackJob{}, slots: make(chan struct{}, 2)}
	l.runtimeCtx = ctx
	l.playback = p
	p.running.Add(1)
	go func() {
		defer p.running.Done()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				p.mu.Lock()
				p.expireLocked(now)
				p.mu.Unlock()
			}
		}
	}()
	return nil
}

func (l *Library) playbackManager() (*playbackCache, error) {
	l.playbackMu.Lock()
	defer l.playbackMu.Unlock()
	if l.playback == nil || l.playback.ctx.Err() != nil {
		return nil, errPlaybackClosed
	}
	return l.playback, nil
}

func (l *Library) ClosePlayback() {
	l.playbackMu.Lock()
	p := l.playback
	l.playback = nil
	l.playbackMu.Unlock()
	if p == nil {
		return
	}
	p.mu.Lock()
	p.closed = true
	p.cancel()
	for _, job := range p.jobs {
		job.cancel()
	}
	for _, entry := range p.entries {
		p.evictLocked(entry)
	}
	p.specs = map[string]playbackSpecEntry{}
	p.mu.Unlock()
	p.running.Wait()
	if err := os.RemoveAll(p.scratch); err != nil {
		slog.Warn("remove temporary playback scratch", "error", err)
	}
}

func (p *playbackCache) evictLocked(entry *playbackEntry) {
	if p.entries[entry.key] == entry {
		delete(p.entries, entry.key)
	}
	entry.retired = true
	if entry.refs == 0 && entry.data != nil {
		p.bytes -= int64(len(entry.data))
		entry.data = nil
	}
}

func (p *playbackCache) expireLocked(now time.Time) {
	for _, entry := range p.entries {
		if entry.refs == 0 && now.Sub(entry.used) >= playbackCacheTTL {
			p.evictLocked(entry)
		}
	}
	for key, entry := range p.specs {
		if now.Sub(entry.used) >= playbackCacheTTL {
			delete(p.specs, key)
		}
	}
}

func (p *playbackCache) reserveLocked(size int64) bool {
	p.expireLocked(time.Now())
	for p.bytes+p.reserved+size > playbackCacheLimit {
		var oldest *playbackEntry
		for _, entry := range p.entries {
			if entry.refs == 0 && (oldest == nil || entry.used.Before(oldest.used)) {
				oldest = entry
			}
		}
		if oldest == nil {
			return false
		}
		p.evictLocked(oldest)
	}
	p.reserved += size
	return true
}

func (p *playbackCache) release(entry *playbackEntry) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry.refs--
	if entry.retired && entry.refs == 0 && entry.data != nil {
		p.bytes -= int64(len(entry.data))
		entry.data = nil
	}
}

func (p *playbackCache) await(ctx context.Context, job *playbackJob) error {
	select {
	case <-ctx.Done():
	case <-job.done:
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		if job.finished {
			if job.entry != nil {
				job.entry.refs--
				if job.entry.retired && job.entry.refs == 0 && job.entry.data != nil {
					p.bytes -= int64(len(job.entry.data))
					job.entry.data = nil
				}
			}
		} else {
			job.waiters--
			if job.waiters == 0 {
				job.cancel()
			}
		}
		return err
	}
	return job.err
}

func (p *playbackCache) newJobLocked(key, hash string, reserve int64, deadline time.Duration) (context.Context, *playbackJob, error) {
	if p.closed || p.ctx.Err() != nil {
		return nil, nil, errPlaybackClosed
	}
	if len(p.jobs) >= 8 || !p.reserveLocked(reserve) {
		return nil, nil, errPlaybackBusy
	}
	ctx, cancel := context.WithTimeout(p.ctx, deadline)
	job := &playbackJob{hash: hash, cancel: cancel, done: make(chan struct{}), waiters: 1, reserve: reserve}
	p.jobs[key] = job
	p.running.Add(1)
	return ctx, job, nil
}

func (p *playbackCache) finishJob(ctx context.Context, key string, job *playbackJob, entry *playbackEntry, spec *playbackSpec, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reserved -= job.reserve
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	if err == nil && !p.closed {
		if entry != nil {
			entry.refs = job.waiters
			entry.used = time.Now()
			p.entries[key] = entry
			p.bytes += int64(len(entry.data))
			job.entry = entry
		}
		if spec != nil {
			if len(p.specs) >= 128 {
				oldest, used := "", time.Time{}
				for k, cached := range p.specs {
					if oldest == "" || cached.used.Before(used) {
						oldest, used = k, cached.used
					}
				}
				delete(p.specs, oldest)
			}
			p.specs[key] = playbackSpecEntry{spec: spec, used: time.Now()}
			job.spec = spec
		}
	}
	job.err, job.finished = err, true
	delete(p.jobs, key)
	close(job.done)
	job.cancel()
	p.running.Done()
}

func (l *Library) cancelPlayback(hashes []string) {
	p, err := l.playbackManager()
	if err != nil {
		return
	}
	wanted := map[string]bool{}
	for _, hash := range hashes {
		wanted[hash] = true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, job := range p.jobs {
		if wanted[job.hash] {
			job.cancel()
		}
	}
	for _, entry := range p.entries {
		if wanted[entry.hash] {
			p.evictLocked(entry)
		}
	}
	for key, entry := range p.specs {
		if wanted[entry.spec.hash] {
			delete(p.specs, key)
		}
	}
}

func (l *Library) waitPlayback(ctx context.Context, hashes []string) error {
	p, err := l.playbackManager()
	if err != nil {
		return nil
	}
	wanted := map[string]bool{}
	for _, hash := range hashes {
		wanted[hash] = true
	}
	p.mu.Lock()
	jobs := []*playbackJob{}
	for _, job := range p.jobs {
		if wanted[job.hash] {
			job.cancel()
			jobs = append(jobs, job)
		}
	}
	p.mu.Unlock()
	for _, job := range jobs {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-job.done:
		}
	}
	return nil
}
