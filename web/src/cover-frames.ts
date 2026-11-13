const MIN_FRAMES = 5;
const MAX_FRAMES = 15;
const BASE_SECONDS = 15;

export function coverFrameTimes(duration: number, frameRate = 30): number[] {
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const scaledCount = Math.round(
    MIN_FRAMES + 2 * Math.log2(Math.max(seconds / BASE_SECONDS, 1)),
  );
  const count = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, scaledCount));
  const fps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30;
  const end = Math.max(0, seconds - 0.5 / fps);
  return Array.from({ length: count }, (_, index) => end * index / (count - 1));
}
