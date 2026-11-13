package library

import "context"

type foregroundMediaKey struct{}

func foregroundMedia(ctx context.Context) bool {
	value, _ := ctx.Value(foregroundMediaKey{}).(bool)
	return value
}

func acquireMediaSlot(ctx context.Context, slots chan struct{}) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (l *Library) acquireCPU(ctx context.Context) (func(), error) {
	if foregroundMedia(ctx) {
		return l.acquirePlaybackCPU(ctx)
	}
	background, err := acquireMediaSlot(ctx, l.backgroundCPU)
	if err != nil {
		return nil, err
	}
	release, err := l.acquirePlaybackCPU(ctx)
	if err != nil {
		background()
		return nil, err
	}
	return func() { release(); background() }, nil
}

func (l *Library) acquirePlaybackCPU(ctx context.Context) (func(), error) {
	return acquireMediaSlot(ctx, l.CPU)
}

func (l *Library) acquireGPU(ctx context.Context) (func(), error) {
	if foregroundMedia(ctx) {
		return l.acquirePlaybackGPU(ctx)
	}
	background, err := acquireMediaSlot(ctx, l.backgroundGPU)
	if err != nil {
		return nil, err
	}
	release, err := l.acquirePlaybackGPU(ctx)
	if err != nil {
		background()
		return nil, err
	}
	return func() { release(); background() }, nil
}

func (l *Library) acquirePlaybackGPU(ctx context.Context) (func(), error) {
	return acquireMediaSlot(ctx, l.GPU)
}
