import type Hls from "hls.js";
import { api, type PlaybackDescriptor } from "./api";

type PlaybackMode = "source" | "native-hls" | "mse-hls" | "switching";

type PlaybackCallbacks = {
  onSwitch: () => void;
  onError: (message: string) => void;
};

export class VideoPlayback {
  private abort = new AbortController();
  private descriptor?: PlaybackDescriptor;
  private preparing?: Promise<void>;
  private hls?: Hls;
  private mode?: PlaybackMode;
  private ready = false;
  private disposed = false;
  private sourceFailed = false;
  private switching = false;
  private suspended = false;
  private wantsPlayback = false;
  private loaded = false;
  private targetTime = 0;
  private rate = 1;

  constructor(
    private video: HTMLVideoElement,
    private hash: string,
    private callbacks: PlaybackCallbacks,
  ) {
    this.setRate(1);
    video.addEventListener("loadedmetadata", this.restorePosition);
  }

  prepare(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareSource().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  private async prepareSource(): Promise<void> {
    const descriptor = await api<PlaybackDescriptor>(
      `playback/${this.hash}`, undefined, undefined, this.abort.signal,
    );
    if (this.disposed) return;
    this.descriptor = descriptor;
    const source = descriptor.source;
    const type = source?.codecs
      ? `${source.mime}; codecs="${source.codecs}"`
      : source?.mime || "";
    if (!this.sourceFailed && source && type && this.video.canPlayType(type)) {
      this.mode = "source";
      this.video.src = source.url;
    } else {
      await this.bindStream();
    }
    if (!this.disposed) this.ready = true;
  }

  private async bindStream(): Promise<void> {
    const descriptor = this.descriptor!;
    if (descriptor.fallbackError) throw new Error(descriptor.fallbackError);
    const url = descriptor.stream.url;
    if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      this.mode = "native-hls";
      this.video.src = url;
      return;
    }
    const { default: Hls } = await import("hls.js").catch(() => {
      throw new Error("分段播放器加载失败，请刷新后重试");
    });
    if (this.disposed) return;
    if (!Hls.isSupported()) throw new Error("浏览器不支持分段视频播放，请下载原件查看");
    const hls = new Hls({
      autoStartLoad: false,
      startFragPrefetch: false,
      testBandwidth: false,
      lowLatencyMode: false,
      maxBufferLength: 8,
      maxMaxBufferLength: 12,
      backBufferLength: 8,
      maxBufferSize: 16 * 1024 * 1024,
      fragLoadPolicy: {
        default: {
          ...Hls.DefaultConfig.fragLoadPolicy.default,
          maxTimeToFirstByteMs: 45_000,
          maxLoadTimeMs: 90_000,
        },
      },
    });
    this.hls = hls;
    this.mode = "mse-hls";
    hls.on(Hls.Events.ERROR, (_event, error) => {
      if (this.disposed || this.hls !== hls || !error.fatal) return;
      this.suspend();
      this.callbacks.onError(
        error.response?.code === 401
          ? "请返回门户重新登录"
          : error.response?.code === 410
            ? "原件已被永久删除"
            : "视频加载失败，请重试",
      );
    });
    hls.attachMedia(this.video);
    // Preparing a playlist must not prefetch video fragments.
    hls.loadSource(url);
  }

  play(): Promise<void> {
    if (!this.ready) return Promise.reject(new Error("视频正在准备，请稍后重试"));
    this.wantsPlayback = true;
    this.suspended = false;
    this.targetTime = this.video.ended ? 0 : this.video.currentTime || this.targetTime;
    this.setRate(this.video.playbackRate);
    this.startLoading();
    return this.video.play();
  }

  played(): boolean {
    if (this.disposed || !this.ready || this.video.paused) return false;
    if (this.wantsPlayback) return true;
    this.wantsPlayback = true;
    this.suspended = false;
    if (this.video.readyState >= 1) this.targetTime = this.video.currentTime;
    this.setRate(this.video.playbackRate);
    this.startLoading();
    return true;
  }

  rateChanged(): void {
    this.setRate(this.video.playbackRate);
  }

  private setRate(rate: number): void {
    if (this.disposed) return;
    this.rate = rate;
    if (this.video.defaultPlaybackRate !== rate) this.video.defaultPlaybackRate = rate;
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
  }

  private startLoading(): void {
    if (this.hls) {
      // Preserve the target if loading starts before the playlist is parsed.
      this.hls.config.startPosition = this.targetTime;
      this.hls.startLoad(this.targetTime);
    } else if (!this.loaded) {
      this.video.preload = "metadata";
      this.video.load();
    }
    this.loaded = true;
  }

  paused(): void {
    if (this.switching || this.video.error || !this.video.paused) return;
    this.wantsPlayback = false;
    this.video.autoplay = false;
    if (!this.video.seeking) this.hls?.stopLoad();
  }

  suspend(): void {
    this.suspended = true;
    this.wantsPlayback = false;
    this.video.autoplay = false;
    this.video.pause();
    this.hls?.stopLoad();
  }

  seeking(): void {
    this.targetTime = this.video.currentTime;
    if (!this.hls || this.switching) return;
    const buffered = this.video.buffered;
    for (let index = 0; index < buffered.length; index++) {
      if (buffered.start(index) <= this.targetTime && buffered.end(index) > this.targetTime) return;
    }
    this.hls.stopLoad();
    this.hls.startLoad(this.targetTime, true);
  }

  settled(): void {
    this.switching = false;
    if (this.video.paused && !this.video.seeking) this.hls?.stopLoad();
  }

  handleMediaError(): boolean {
    if (this.mode === "switching") return true;
    if (this.mode !== "source" || !this.descriptor) return false;
    this.sourceFailed = true;
    this.targetTime = this.video.currentTime || this.targetTime;
    this.setRate(this.video.playbackRate);
    this.switching = true;
    this.mode = "switching";
    this.callbacks.onSwitch();
    this.resetMedia();
    void this.bindStream()
      .then(() => {
        if (this.disposed) return;
        this.ready = true;
        if (this.suspended) return;
        this.startLoading();
        if (this.wantsPlayback) {
          void this.video.play().catch((error: DOMException) => {
            if (this.disposed || error.name === "AbortError") return;
            if (error.name === "NotAllowedError") {
              this.suspend();
              return;
            }
            this.callbacks.onError("视频加载失败，请重试");
          });
        }
      })
      .catch((error: Error) => {
        if (!this.disposed) this.callbacks.onError(error.message);
      });
    return true;
  }

  async retry(): Promise<void> {
    this.targetTime = this.video.currentTime || this.targetTime;
    this.setRate(this.video.playbackRate);
    this.switching = true;
    this.mode = "switching";
    this.resetMedia();
    await this.prepare();
  }

  private restorePosition = (): void => {
    if (this.disposed) return;
    this.video.playbackRate = this.rate;
    const duration = this.video.duration;
    const target = Number.isFinite(duration)
      ? Math.min(this.targetTime, Math.max(0, duration - 0.001))
      : this.targetTime;
    if (target > 0 && Math.abs(this.video.currentTime - target) > 0.001) {
      this.video.currentTime = target;
    }
  };

  private resetMedia(): void {
    this.ready = false;
    this.loaded = false;
    this.hls?.destroy();
    this.hls = undefined;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }

  destroy(): void {
    this.disposed = true;
    this.abort.abort();
    this.video.autoplay = false;
    this.video.removeEventListener("loadedmetadata", this.restorePosition);
    this.resetMedia();
  }
}
