package library

import "context"

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

func (l *Library) acquirePlaybackGPU(ctx context.Context) (func(), error) {
	return acquireMediaSlot(ctx, l.GPU)
}
