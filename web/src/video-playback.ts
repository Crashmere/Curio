import type Hls from "hls.js";
import { api as requestJson, type PlaybackDescriptor } from "./api";

type PlaybackMode = "source" | "native-hls" | "mse-hls" | "switching";
export type PlaybackRepresentation = "source" | "compatibility" | null;

const stalledOriginals = new Set<string>();

type NativeMediaDiagnostics = HTMLVideoElement & {
  webkitAudioDecodedByteCount?: number;
  mozHasAudio?: boolean;
  audioTracks?: { length: number };
};

interface PlaybackCallbacks {
  onReady: (ready: boolean) => void;
  onModeChange: (representation: PlaybackRepresentation) => void;
  onDescriptor: (descriptor: PlaybackDescriptor) => void;
  onSwitch: (time: number) => void;
  onError: (message: string, resumeOnly?: boolean) => void;
}

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
  private sourceGeneration = 0;
  private targetTime = 0;
  private rate = 1;
  private silentAudioStart?: number;
  private progressTimer?: ReturnType<typeof setInterval>;
  private progressProbe?: { time: number; at: number };
  private progressPlaybackStarted = false;
  private diagnosticEvents: { event: string; at: number; time: number; paused: boolean; ready: number }[] = [];
  private readonly diagnosticStart = performance.now();
  private readonly observedEvents = ["play", "playing", "pause", "waiting", "stalled", "seeking", "seeked", "loadedmetadata", "loadeddata", "emptied", "error"];

  constructor(
    private video: HTMLVideoElement,
    private hash: string,
    private callbacks: PlaybackCallbacks,
    position?: { time: number; rate: number },
  ) {
    this.targetTime = position?.time || 0;
    this.setRate(position?.rate || 1);
    video.addEventListener("loadedmetadata", this.restorePosition);
    video.addEventListener("timeupdate", this.checkSourceAudio);
    video.addEventListener("seeking", this.resetAudioCheck);
    for (const event of this.observedEvents) video.addEventListener(event, this.observeMedia);
  }

  private observeMedia = (event: Event): void => {
    this.recordEvent(event.type);
    if (event.type === "play") this.startProgressCheck();
    else if (event.type === "playing") {
      this.progressPlaybackStarted = true;
      this.progressProbe = undefined;
      this.startProgressCheck();
    }
    else if (event.type === "pause" && this.video.paused) this.stopProgressCheck();
    else if (["seeking", "waiting", "emptied"].includes(event.type)) this.progressProbe = undefined;
  };

  private startProgressCheck(): void {
    if (this.disposed || this.mode !== "source" || this.progressTimer) return;
    this.progressTimer = setInterval(this.checkSourceProgress, 500);
  }

  private stopProgressCheck(): void {
    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
    this.progressProbe = undefined;
    this.progressPlaybackStarted = false;
  }

  private checkSourceProgress = (): void => {
    if (this.disposed || this.mode !== "source" || !this.wantsPlayback || this.suspended) {
      this.stopProgressCheck();
      return;
    }
    const video = this.video;
    const time = video.currentTime;
    const buffered = video.buffered;
    let bufferedAhead = false;
    for (let index = 0; index < buffered.length; index++) {
      if (buffered.start(index) <= time && buffered.end(index) >= time + 1) bufferedAhead = true;
    }
    // Observe only started, buffered playback; loading, seeks and pauses are not clock failures.
    if ((document.hidden && document.pictureInPictureElement !== video) || video.paused ||
      video.seeking || video.ended || video.playbackRate <= 0 || video.readyState < 3 ||
      !this.progressPlaybackStarted || !bufferedAhead || (Number.isFinite(video.duration) && video.duration - time < 0.5)) {
      this.progressProbe = undefined;
      return;
    }
    const now = performance.now();
    if (!this.progressProbe || Math.abs(time - this.progressProbe.time) > 0.02) {
      this.progressProbe = { time, at: now };
      return;
    }
    if (now - this.progressProbe.at < 3000) return;
    this.recordEvent("source-clock-stalled");
    this.stopProgressCheck();
    stalledOriginals.add(this.hash);
    if (stalledOriginals.size > 32) stalledOriginals.delete(stalledOriginals.values().next().value!);
    this.useCompatibility();
  };

  private recordEvent(event: string): void {
    this.diagnosticEvents.push({
      event,
      at: Math.round(performance.now() - this.diagnosticStart),
      time: this.video.currentTime,
      paused: this.video.paused,
      ready: this.video.readyState,
    });
    if (this.diagnosticEvents.length > 30) this.diagnosticEvents.shift();
  }

  getDiagnostics() {
    const video = this.video;
    return {
      mode: this.mode,
      ready: this.ready,
      wantsPlayback: this.wantsPlayback,
      suspended: this.suspended,
      changingSource: this.changingSource,
      time: video.currentTime,
      targetTime: this.targetTime,
      duration: video.duration,
      paused: video.paused,
      seeking: video.seeking,
      ended: video.ended,
      rate: video.playbackRate,
      muted: video.muted,
      readyState: video.readyState,
      networkState: video.networkState,
      buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]),
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      events: [...this.diagnosticEvents],
    };
  }

  get changingSource(): boolean {
    return this.switching;
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
    const descriptor = await requestJson<PlaybackDescriptor>(
      `playback/${this.hash}`,
      undefined,
      undefined,
      this.abort.signal,
    );
    if (this.disposed) return;
    this.descriptor = descriptor;
    this.callbacks.onDescriptor(descriptor);
    if (stalledOriginals.has(this.hash)) {
      this.sourceFailed = true;
      this.recordEvent("reuse-source-clock-fallback");
    }
    const source = descriptor.source;
    // Container/codec hints cannot prove that the native decoder will accept the tracks.
    if (!this.sourceFailed && source) {
      this.mode = "source";
      this.video.src = source.url;
      this.callbacks.onModeChange("source");
    } else {
      await this.bindStream();
    }
    if (this.disposed) return;
    this.ready = true;
    this.callbacks.onReady(true);
  }

  private async bindStream(): Promise<void> {
    if (this.descriptor?.fallbackError) throw new Error(this.descriptor.fallbackError);
    const url = this.descriptor!.stream.url;
    if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      this.mode = "native-hls";
      this.video.src = url;
      this.callbacks.onModeChange("compatibility");
      return;
    }
    const { default: Hls } = await import("hls.js").catch(() => {
      throw new Error("分段播放器加载失败，请刷新后重试");
    });
    if (this.disposed) return;
    if (!Hls.isSupported()) throw new Error("浏览器不支持分段视频播放，可下载原件查看");
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
    this.callbacks.onModeChange("compatibility");
    hls.on(Hls.Events.ERROR, (_event, error) => {
      if (this.disposed || this.hls !== hls || !error.fatal) return;
      hls.stopLoad();
      this.callbacks.onError(
        error.response?.code === 401
          ? "设备授权已失效，请返回门户重新登录"
          : error.response?.code === 410
            ? "原件已被永久删除"
            : "视频加载失败，请重试",
      );
    });
    hls.attachMedia(this.video);
    // Load the small playlist now, but defer every video fragment until playback or a seek.
    hls.loadSource(url);
  }

  play(): Promise<void> {
    if (!this.ready) return Promise.reject(new Error("视频正在准备，请稍后重试"));
    this.wantsPlayback = true;
    this.suspended = false;
    this.targetTime = this.video.ended ? 0 : this.video.currentTime || this.targetTime;
    this.rate = this.video.playbackRate;
    this.recordEvent("request-play");
    this.startLoading();
    this.startProgressCheck();
    return this.playMedia();
  }

  private playMedia(): Promise<void> {
    const generation = this.sourceGeneration;
    return this.video.play().then(() => {
      if (!this.disposed && generation === this.sourceGeneration) {
        this.progressPlaybackStarted = true;
        this.progressProbe = undefined;
        this.recordEvent("play-resolved");
      }
    }).catch((error: DOMException) => {
      // A replaced source can reject its pending play after the new source has started.
      if (this.disposed || generation !== this.sourceGeneration) return;
      this.recordEvent(`play-rejected:${error.name}`);
      throw error;
    });
  }

  played(): boolean {
    if (this.disposed || !this.ready || this.video.paused) return false;
    this.startProgressCheck();
    if (this.wantsPlayback) return true;
    this.wantsPlayback = true;
    this.suspended = false;
    if (this.video.readyState >= 1) this.targetTime = this.video.currentTime;
    this.rate = this.video.playbackRate;
    this.startLoading();
    return true;
  }

  setRate(rate: number): void {
    if (this.disposed) return;
    this.rate = rate;
    this.progressProbe = undefined;
    this.video.defaultPlaybackRate = rate;
    this.video.playbackRate = rate;
  }

  loadFrame(time = this.targetTime): void {
    this.stopProgressCheck();
    this.wantsPlayback = false;
    this.suspended = false;
    this.targetTime = Math.max(0, time);
    this.recordEvent("request-frame");
    this.startLoading();
    if (this.video.readyState >= 1) this.restorePosition();
  }

  private startLoading(): void {
    if (this.hls) {
      // Preserve the target if loading starts before the playlist has been parsed.
      this.hls.config.startPosition = this.targetTime;
      this.hls.startLoad(this.targetTime);
    } else if (!this.loaded) {
      this.video.preload = "metadata";
      this.video.load();
    }
    this.loaded = true;
  }

  paused(): void {
    if (this.changingSource || this.video.error) return;
    this.stopProgressCheck();
    this.wantsPlayback = false;
    if (!this.video.seeking) this.hls?.stopLoad();
  }

  suspend(): void {
    this.stopProgressCheck();
    this.suspended = true;
    this.wantsPlayback = false;
    this.recordEvent("request-suspend");
    this.video.pause();
    this.hls?.stopLoad();
  }

  seeking(): void {
    this.targetTime = this.video.currentTime;
    if (!this.hls || this.changingSource) return;
    const buffered = this.video.buffered;
    for (let index = 0; index < buffered.length; index++) {
      if (buffered.start(index) <= this.targetTime && buffered.end(index) > this.targetTime) {
        return;
      }
    }
    this.hls.stopLoad();
    this.hls.startLoad(this.targetTime, true);
  }

  settled(): void {
    this.switching = false;
    if (this.video.paused && !this.video.seeking) this.hls?.stopLoad();
  }

  handleMediaError(): boolean {
    return this.useCompatibility();
  }

  useCompatibility(resume = false): boolean {
    if (resume && (this.mode === "source" || this.mode === "switching")) {
      this.wantsPlayback = true;
      this.suspended = false;
    }
    if (this.mode === "switching") return true;
    if (this.mode !== "source" || !this.descriptor) return false;
    this.sourceFailed = true;
    this.targetTime = this.video.currentTime || this.targetTime;
    this.rate = this.video.playbackRate;
    this.switching = true;
    this.recordEvent("request-compatibility");
    this.mode = "switching";
    this.callbacks.onSwitch(this.targetTime);
    this.resetMedia();
    void this.bindStream()
      .then(() => {
        if (this.disposed) return;
        this.ready = true;
        this.callbacks.onReady(true);
        if (this.suspended) return;
        this.startLoading();
        if (this.wantsPlayback) {
          void this.playMedia().catch((error: DOMException) => {
            if (this.disposed || error.name === "AbortError") return;
            this.callbacks.onError(
              error.name === "NotAllowedError"
                ? "点按播放以继续"
                : "视频加载失败，请重试",
              error.name === "NotAllowedError",
            );
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
    this.rate = this.video.playbackRate;
    this.switching = true;
    this.mode = "switching";
    this.resetMedia();
    await this.prepare();
  }

  private resetAudioCheck = (): void => {
    this.silentAudioStart = undefined;
  };

  private checkSourceAudio = (): void => {
    const video = this.video as NativeMediaDiagnostics;
    const audio = this.descriptor?.source?.audio;
    const time = video.currentTime;
    // Decoded bytes count silence too. A missing counter is not evidence of failed audio.
    const missingAudio = video.webkitAudioDecodedByteCount === 0 ||
      video.mozHasAudio === false || video.audioTracks?.length === 0;
    if (this.disposed || this.mode !== "source" || !audio || !missingAudio ||
      video.paused || video.seeking || video.muted || video.volume === 0 ||
      time < Math.max(0, audio.start) ||
      (audio.duration !== undefined && time >= audio.start + audio.duration)) {
      this.resetAudioCheck();
      return;
    }
    this.silentAudioStart ??= time;
    if (time - this.silentAudioStart >= 0.75) this.handleMediaError();
  };

  private restorePosition = (): void => {
    if (this.disposed) return;
    // A supported container can silently play only audio when its video codec is unavailable.
    if (this.mode === "source" && this.video.videoWidth === 0) {
      this.handleMediaError();
      return;
    }
    this.video.playbackRate = this.rate;
    const duration = this.video.duration;
    const target = Number.isFinite(duration)
      ? Math.min(this.targetTime, Math.max(0, duration - 0.001))
      : this.targetTime;
    if (Math.abs(this.video.currentTime - target) > 0.001) {
      this.video.currentTime = target;
    }
  };

  private resetMedia(): void {
    this.stopProgressCheck();
    this.sourceGeneration += 1;
    this.resetAudioCheck();
    this.ready = false;
    this.loaded = false;
    if (!this.disposed) {
      this.callbacks.onReady(false);
      this.callbacks.onModeChange(null);
    }
    this.hls?.destroy();
    this.hls = undefined;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }

  destroy(): void {
    this.disposed = true;
    this.abort.abort();
    this.video.removeEventListener("loadedmetadata", this.restorePosition);
    this.video.removeEventListener("timeupdate", this.checkSourceAudio);
    this.video.removeEventListener("seeking", this.resetAudioCheck);
    for (const event of this.observedEvents) this.video.removeEventListener(event, this.observeMedia);
    this.resetMedia();
  }
}
