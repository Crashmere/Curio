import { api as requestJson, type PlaybackDescriptor } from "./api";
import { BrowserCoverFrames, type BrowserCoverSource } from "./browser-cover-frames";
import type { CoverStrip } from "./cover-strip";

export type TimelinePreviewMedia = {
  stripResource?: string;
  playbackResource: string;
  source?: BrowserCoverSource;
  rotation: number;
  width: number;
  height: number;
  prefetch: boolean;
};

const FRAME_STEP = 0.1;
const MAX_WIDTH = 320;
const MAX_HEIGHT = 200;
const CACHE_BYTES = 8 * 1024 * 1024;
const REFINE_DELAY = 250;

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = w / 2 + "px";
}

function copyFrame(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  sizeCanvas(canvas, source.width, source.height);
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export class TimelineFramePreview {
  private lifetime = new AbortController();
  private browser?: BrowserCoverFrames;
  private source?: BrowserCoverSource;
  private strip?: CoverStrip;
  private frames = new Map<number, HTMLCanvasElement>();
  private bytes = 0;
  private latest?: number;
  private running = false;
  private nativeFailed = false;
  private disposed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private refineTimer?: ReturnType<typeof setTimeout>;
  ready = false;

  constructor(private media: TimelinePreviewMedia, private canvas: HTMLCanvasElement,
    private changed: () => void) {
    this.source = media.source;
    const odd = Math.abs(media.rotation % 180) > 45;
    sizeCanvas(canvas, (odd ? media.height : media.width) || 320,
      (odd ? media.width : media.height) || 180);
  }

  get failed() { return this.nativeFailed && !this.strip?.frames.length && !this.ready; }

  setSource(source?: BrowserCoverSource) { this.source = source; }

  setStrip(strip?: CoverStrip) {
    this.strip = strip;
    if (this.latest !== undefined) {
      this.paintNearby(this.latest);
      this.changed();
    }
  }

  update(time: number): boolean {
    if (this.disposed) return false;
    clearTimeout(this.idleTimer);
    const target = Math.round(Math.max(0, time) / FRAME_STEP) * FRAME_STEP;
    if (this.latest !== target) {
      this.latest = target;
      clearTimeout(this.refineTimer);
      // Moving pointers use the atlas; only a settled target needs an original-video seek.
      this.refineTimer = setTimeout(() => {
        this.refineTimer = undefined;
        this.pump();
      }, REFINE_DELAY);
    }
    this.paintNearby(this.latest);
    return this.ready;
  }

  pause() {
    this.latest = undefined;
    clearTimeout(this.idleTimer);
    clearTimeout(this.refineTimer);
    this.refineTimer = undefined;
    // Keep one warm decoder briefly for fast re-entry; no new seeks while hidden.
    this.idleTimer = setTimeout(() => {
      this.browser?.dispose();
      this.browser = undefined;
      this.nativeFailed = false;
    }, 10000);
  }

  dispose() {
    this.disposed = true;
    this.latest = undefined;
    clearTimeout(this.idleTimer);
    clearTimeout(this.refineTimer);
    this.lifetime.abort();
    this.browser?.dispose();
    for (const frame of this.frames.values()) frame.width = frame.height = 0;
    this.frames.clear();
    this.bytes = 0;
    this.canvas.width = this.canvas.height = 0;
    this.strip = undefined;
  }

  private paintBitmap(frame: HTMLCanvasElement) {
    sizeCanvas(this.canvas, frame.width, frame.height);
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    this.ready = true;
  }

  private paintNearby(time: number) {
    const cached = this.frames.get(time);
    if (cached) {
      this.frames.delete(time);
      this.frames.set(time, cached);
      this.paintBitmap(cached);
      return;
    }
    const strip = this.strip;
    if (!strip?.frames.length) {
      if (this.nativeFailed) {
        this.ready = false;
        this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      return;
    }
    const frame = strip.frames.reduce((best, frame) =>
      Math.abs(frame.time - time) < Math.abs(best.time - time) ? frame : best);
    const angle = this.media.rotation * Math.PI / 180;
    const odd = Math.abs(this.media.rotation % 180) > 45;
    sizeCanvas(this.canvas, odd ? frame.height : frame.width, odd ? frame.width : frame.height);
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.save();
    context.translate(this.canvas.width / 2, this.canvas.height / 2);
    context.rotate(angle);
    const scale = Math.min(this.canvas.width / frame.width, this.canvas.height / frame.height);
    const rotatedScale = odd
      ? Math.min(this.canvas.width / frame.height, this.canvas.height / frame.width)
      : scale;
    context.drawImage(strip.image, frame.x, frame.y, frame.width, frame.height,
      -frame.width * rotatedScale / 2, -frame.height * rotatedScale / 2,
      frame.width * rotatedScale, frame.height * rotatedScale);
    context.restore();
    this.ready = true;
  }

  private remember(time: number, frame: HTMLCanvasElement) {
    this.frames.set(time, frame);
    this.bytes += frame.width * frame.height * 4;
    while (this.frames.size > 32 || this.bytes > CACHE_BYTES) {
      const oldest = this.frames.keys().next().value!;
      const discarded = this.frames.get(oldest)!;
      this.frames.delete(oldest);
      this.bytes -= discarded.width * discarded.height * 4;
      discarded.width = discarded.height = 0;
    }
  }

  private pump() {
    const time = this.latest;
    if (this.running || this.refineTimer || this.disposed || this.nativeFailed || time === undefined || this.frames.has(time)) return;
    const browser = this.browser ??= new BrowserCoverFrames(async signal => {
      if (this.source) return this.source;
      const descriptor = await requestJson<PlaybackDescriptor>(this.media.playbackResource, undefined, undefined, signal);
      return descriptor.source ? { ...descriptor.source, duration: descriptor.duration } : undefined;
    }, this.media.rotation, this.media.playbackResource);
    this.running = true;
    // Native seeks are serial. A moving pointer replaces the pending target, not the decoder.
    void browser.captureCanvas(time, this.lifetime.signal).then(frame => {
      if (this.disposed || this.browser !== browser) return;
      const bitmap = copyFrame(frame);
      frame.width = frame.height = 0;
      this.remember(time, bitmap);
      if (this.latest === time) {
        this.paintBitmap(bitmap);
        this.changed();
      }
    }, () => {
      if (this.disposed || this.browser !== browser) return;
      this.nativeFailed = true;
      browser.dispose();
      this.browser = undefined;
      if (this.latest !== undefined) this.paintNearby(this.latest);
      this.changed();
    }).finally(() => {
      this.running = false;
      this.pump();
    });
  }
}

