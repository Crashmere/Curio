const WINDOW_MS = 2000;

export class UploadRateMeter {
  private startedAt = performance.now();
  private samples = [{ at: this.startedAt, bytes: 0 }];
  private rate = 0;
  private timer = setInterval(() => this.publish(), 250);

  constructor(private onRate: (bytesPerSecond: number) => void) {}

  update(bytes: number): void {
    const last = this.samples.at(-1);
    if (!last || bytes <= last.bytes) return;
    this.samples.push({ at: performance.now(), bytes });
    this.publish();
  }

  stop(): void {
    clearInterval(this.timer);
    this.samples = [];
    this.setRate(0);
  }

  private publish(): void {
    if (!this.samples.length) return;
    const now = performance.now();
    const cutoff = Math.max(this.startedAt, now - WINDOW_MS);
    // Keep the zero-byte baseline when early events share the start timestamp.
    while (cutoff > this.startedAt && this.samples.length > 1 && this.samples[1].at <= cutoff) {
      this.samples.shift();
    }
    const [first, next] = this.samples;
    const last = this.samples.at(-1)!;
    // Interpolate the window boundary; idle ticks age out a stalled transfer.
    const baseline = next && next.at > first.at
      ? first.bytes + (next.bytes - first.bytes) * (cutoff - first.at) / (next.at - first.at)
      : first.bytes;
    const elapsed = now - cutoff;
    this.setRate(elapsed > 0 ? (last.bytes - baseline) * 1000 / elapsed : 0);
  }

  private setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    this.onRate(rate);
  }
}

export function formatUploadRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"];
  const unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytesPerSecond) / Math.log(1024))));
  return `${(bytesPerSecond / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
