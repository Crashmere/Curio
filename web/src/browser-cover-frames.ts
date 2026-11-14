export type BrowserCoverSource = { url: string };

const MEDIA_TIMEOUT = 4000;

function bounded<T>(signal: AbortSignal, timeout: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", failed);
      if (ok) resolve(value as T);
      else reject(value);
    };
    const abort = () => controller.abort(signal.reason);
    const failed = () => finish(false, controller.signal.reason);
    const timer = setTimeout(() => controller.abort(new Error("Browser video preview timed out")), timeout);
    signal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", failed, { once: true });
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return task(controller.signal);
    }).then((value) => finish(true, value), (error) => finish(false, error));
  });
}

function waitMedia(video: HTMLVideoElement, signal: AbortSignal, ready: () => boolean, action: () => void): Promise<void> {
  return bounded(signal, MEDIA_TIMEOUT, (signal) => new Promise((resolve, reject) => {
    const events = ["loadedmetadata", "loadeddata", "durationchange", "canplay", "seeked", "timeupdate"];
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      for (const event of events) video.removeEventListener(event, check);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const failed = () => finish(new Error(video.error?.message || "Native video decoding failed"));
    const aborted = () => finish(signal.reason);
    const check = () => {
      if (video.error) failed();
      else if (ready()) finish();
    };
    for (const event of events) video.addEventListener(event, check);
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      action();
      check();
    } catch (error) { finish(error); }
  }));
}

function waitDecodedFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return bounded(signal, MEDIA_TIMEOUT, (signal) => new Promise((resolve, reject) => {
    let settled = false;
    let callback: number | undefined;
    let animationFrame: number | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const failed = () => finish(new Error(video.error?.message || "Native video decoding failed"));
    const aborted = () => finish(signal.reason);
    const complete = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking) finish();
      else finish(new Error("Native video frame is not ready"));
    };
    // Detached paused videos do not consistently deliver video-frame callbacks.
    const fallback = setTimeout(() => {
      animationFrame = requestAnimationFrame(() => {
        animationFrame = requestAnimationFrame(() => complete());
      });
    }, 120);
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      if (typeof video.requestVideoFrameCallback === "function") {
        callback = video.requestVideoFrameCallback(() => complete());
      }
    } catch (error) { finish(error); }
  }));
}

export class BrowserCoverFrames {
  private lifetime = new AbortController();
  private video?: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;

  constructor(
    private resolveSource: (signal: AbortSignal) => Promise<BrowserCoverSource | undefined>,
    private rotation = 0,
  ) {}

  async capture(time: number, signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (!Number.isFinite(time) || time < 0) throw new Error("Invalid video frame time");
    const controller = new AbortController();
    const abort = () => {
      controller.abort(signal.aborted ? signal.reason : this.lifetime.signal.reason);
      this.releaseMedia();
    };
    signal.addEventListener("abort", abort, { once: true });
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    try {
      const video = await this.prepare(controller.signal);
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("Native video duration is unavailable");
      const target = Math.min(time, Math.max(0, video.duration - 0.001));
      await waitMedia(video, controller.signal,
        () => !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
        () => { video.currentTime = target; });
      await waitDecodedFrame(video, controller.signal);
      controller.signal.throwIfAborted();
      const canvas = this.paint(video);
      const blob = await bounded(controller.signal, MEDIA_TIMEOUT, () => new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob?.size) resolve(blob);
          else reject(new Error("Native video preview could not be encoded"));
        }, "image/png");
      }));
      controller.signal.throwIfAborted();
      return blob;
    } catch (error) {
      this.releaseMedia();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }

  dispose() {
    this.lifetime.abort();
    this.releaseMedia();
  }

  private async prepare(signal: AbortSignal): Promise<HTMLVideoElement> {
    if (this.video) return this.video;
    const source = await bounded(signal, 10000, (signal) => this.resolveSource(signal));
    signal.throwIfAborted();
    if (!source) throw new Error("Native video source is unavailable");
    const url = new URL(source.url, window.location.href);
    if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) {
      throw new Error("Native video source must be same-origin");
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    this.video = video;
    await waitMedia(video, signal,
      () => video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0 && video.videoHeight > 0,
      () => { video.src = url.href; video.load(); });
    return video;
  }

  private paint(video: HTMLVideoElement): HTMLCanvasElement {
    const angle = (Number.isFinite(this.rotation) ? this.rotation % 360 : 0) * Math.PI / 180;
    const width = video.videoWidth;
    const height = video.videoHeight;
    const rotatedWidth = Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle));
    const rotatedHeight = Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle));
    const scale = Math.min(1, 320 / Math.max(rotatedWidth, rotatedHeight));
    const canvas = this.canvas ??= document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rotatedWidth * scale));
    canvas.height = Math.max(1, Math.round(rotatedHeight * scale));
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Native video canvas is unavailable");
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(angle);
    context.drawImage(video, -width * scale / 2, -height * scale / 2, width * scale, height * scale);
    return canvas;
  }

  private releaseMedia() {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      this.video = undefined;
    }
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas = undefined;
    }
  }
}
