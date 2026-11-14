import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Image as ImageIcon, LoaderCircle, Maximize, Pause, PictureInPicture2, Play, RefreshCw, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { base, type Asset } from "./api";
import { coverFrameTimes } from "./cover-frames";
import { CoverFrameRequests, type CoverStrip, type CoverStripFrame, type CoverStripState } from "./cover-strip";
import { VideoPlayback, type PlaybackRepresentation } from "./video-playback";
import { useCompactViewer } from "./viewer-interactions";
import { CompatibilityPlaybackGlyph, SkipSecondsGlyph } from "./player-icons";
import "./video-player.css";

function formatDurationClock(seconds: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return `${hours ? hours + ":" + String(minutes).padStart(2, "0") : minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function buildFramePreviewUrl(id: string, time: number, size = "preview") {
  return `${base}api/assets/${id}/frame?${new URLSearchParams({ time: String(time), size })}`;
}

function FrameStripImage({ strip, frame, rotation, className, contain = false }: {
  strip: CoverStrip; frame: CoverStripFrame; rotation: number; className?: string; contain?: boolean;
}) {
  const odd = rotation % 180 !== 0;
  const transform = rotation === 90 ? `translate(${frame.height},0) rotate(90)`
    : rotation === 180 ? `translate(${frame.width},${frame.height}) rotate(180)`
    : rotation === 270 ? `translate(0,${frame.width}) rotate(270)` : undefined;
  return (
    <svg className={className} viewBox={`0 0 ${odd ? frame.height : frame.width} ${odd ? frame.width : frame.height}`}
      preserveAspectRatio={`xMidYMid ${contain ? "meet" : "slice"}`} aria-hidden="true" focusable="false">
      <g transform={transform}>
        <svg width={frame.width} height={frame.height} overflow="hidden">
          <image href={strip.imageUrl} x={-frame.x} y={-frame.y} width={strip.width} height={strip.height} />
        </svg>
      </g>
    </svg>
  );
}

export function ExactCoverPreview({ asset, time, strip }: { asset: Asset; time: number; strip?: CoverStrip }) {
  const url = buildFramePreviewUrl(asset.id, time, "preview");
  const [loaded, setLoaded] = useState("");
  const frame = strip?.frames.find((frame) => Math.abs(frame.time - time) < 1e-5);
  return <>
    {strip && frame && loaded !== url && (
      <FrameStripImage strip={strip} frame={frame} rotation={0} contain className="cover-frame-candidate-preview" />
    )}
    <img key={url} className="cover-frame-exact-preview" src={url} alt="当前选中帧预览"
      style={{ opacity: loaded === url ? 1 : 0 }} onLoad={() => setLoaded(url)} />
  </>;
}

function StripFrameThumb({ url, time, viewportRef, enabled, requests }: {
  url: string;
  time: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  requests: CoverFrameRequests;
}) {
  const thumbRef = useRef<HTMLSpanElement>(null);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const [imageUrl, setImageUrl] = useState("");

  useEffect(() => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setRequested(true);
        observer.disconnect();
      }
    }, { root: viewportRef.current, rootMargin: "0px 64px" });
    observer.observe(thumb);
    return () => observer.disconnect();
  }, [viewportRef]);

  useEffect(() => {
    if (!enabled || !requested) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    requests.load(url, time, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setImageUrl(objectUrl);
    }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [enabled, requested, requests, time, url]);

  return (
    <span ref={thumbRef} className="frame-strip-thumb">
      {failed ? <ImageIcon size={17} /> : imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : <LoaderCircle size={14} className="spin" />}
    </span>
  );
}

export function FrameTimelineStrip({
  asset,
  time,
  duration,
  locked,
  stripState,
  onSeek,
}: {
  asset: Asset;
  time: number;
  duration: number;
  locked: boolean;
  stripState: CoverStripState;
  onSeek: (targetSeconds: number) => void;
}) {
  const playbackResource = `playback/${asset.id}`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const requestsRef = useRef<{ key: string; requests: CoverFrameRequests } | null>(null);
  if (!requestsRef.current || requestsRef.current.key !== playbackResource) {
    requestsRef.current = { key: playbackResource, requests: new CoverFrameRequests(playbackResource) };
  }
  const requests = requestsRef.current.requests;
  const [earlyFrames, setEarlyFrames] = useState(false);
  const fps = asset.frameRate || 30;
  const strip = stripState.strip;
  const displayedDuration = strip?.duration || asset.duration || duration;
  const timestamps = strip?.frames.map((frame) => frame.time) || coverFrameTimes(displayedDuration, fps);
  const maxEnd = timestamps[timestamps.length - 1];
  const playheadPercent = maxEnd ? Math.min(100, (time / maxEnd) * 100) : 0;
  const closest = timestamps.reduce((best, at, index) => Math.abs(at - time) < Math.abs(timestamps[best] - time) ? index : best, 0);

  useEffect(() => {
    requests.setMode(stripState.status === "error" ? "fallback" : stripState.status === "loading" ? "preview" : "stopped");
    setEarlyFrames(false);
    if (stripState.status !== "loading") return;
    const timer = setTimeout(() => setEarlyFrames(true), 200);
    return () => clearTimeout(timer);
  }, [stripState.status, requests]);
  useEffect(() => () => requests.setMode("stopped"), [requests]);

  return (
    <div ref={viewportRef} className="frame-strip-scroll">
      <div
        className="frame-strip"
        role="group"
        aria-label="缩略帧时间轴"
        style={{ "--frame-count": timestamps.length } as CSSProperties}
      >
        {timestamps.map((ts, idx) => {
          const frameSrc = buildFramePreviewUrl(asset.id, ts, "thumb");
          return (
            <button
              type="button"
              key={idx}
              disabled={locked || !duration}
              aria-label={`选择 ${formatDurationClock(ts)} 的帧`}
              aria-pressed={idx === closest}
              title={`${ts.toFixed(3)} 秒`}
              onClick={() => onSeek(ts)}
            >
              {displayedDuration > 0 && (strip ? (
                <span className="frame-strip-thumb"><FrameStripImage strip={strip} frame={strip.frames[idx]} rotation={0} className="frame-strip-image" /></span>
              ) : (
                <StripFrameThumb key={frameSrc} url={frameSrc} time={ts} viewportRef={viewportRef}
                  enabled={earlyFrames || stripState.status === "error"} requests={requests} />
              ))}
            </button>
          );
        })}
        {duration > 0 && (
          <span
            className="frame-strip-position"
            style={{ left: `clamp(0px, ${playheadPercent}%, calc(100% - 3px))` }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}


let savedVolume = 1;
let savedMuted = true;

type WebkitFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

export const PLAYER_SKIP_SECONDS = 5;

export interface FramePlayheadState {
  time: number;
  duration: number;
  ready: boolean;
}

export function VideoPlayer({
  asset,
  locked,
  chromeHidden = false,
  onToggleChrome,
  onActivity,
  onControlsHoverChange,
  onPlaybackChange,
  onWaiting,
  onEnded,
  onPrevious,
  onNext,
  onClose,
  framePicker,
  diagnosticsOpen = false,
  onCloseDiagnostics,
}: {
  asset: Asset;
  locked: boolean;
  chromeHidden?: boolean;
  onToggleChrome: () => void;
  onActivity: () => void;
  onControlsHoverChange: (hovered: boolean) => void;
  onPlaybackChange: (playing: boolean) => void;
  onWaiting: (waiting: boolean) => void;
  onEnded?: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  diagnosticsOpen?: boolean;
  onCloseDiagnostics?: () => void;
  framePicker?: {
    initialTime: number;
    onChange: (frame: FramePlayheadState) => void;
  };
}) {
  const compact = useCompactViewer();
  const isPresent = true;
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageBoxRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [controlsHovered, setControlsHovered] = useState(false);
  const controlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [started, setStarted] = useState(!!framePicker);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(!!framePicker);
  const [errorMsg, setErrorMsg] = useState("");
  const [resumeOnly, setResumeOnly] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ReturnType<VideoPlayback["getDiagnostics"]> | null>(null);
  const [diagnosticsCopy, setDiagnosticsCopy] = useState("");
  const [sourceReady, setSourceReady] = useState(false);
  const [playbackRepresentation, setPlaybackRepresentation] =
    useState<PlaybackRepresentation>(null);
  const [sourceFrameRate, setSourceFrameRate] = useState<number | undefined>(undefined);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>(
    [],
  );
  const [volume, setVolume] = useState(savedVolume);
  const [muted, setMuted] = useState(savedMuted);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [supportsPip, setSupportsPip] = useState(false);

  const resumeOnRelease = useRef(false);
  const activeScrubValue = useRef<number | null>(null);
  const pendingPreviewTime = useRef<number | null>(null);
  const seekRafId = useRef(0);
  const touchStart = useRef<{ id: number; x: number; y: number; canceled: boolean } | undefined>(undefined);
  const ignoreNextClick = useRef(false);
  const isMounted = useRef(true);
  const lastObservedMediaTime = useRef<number | undefined>(undefined);
  const measuredFrameInterval = useRef<number | undefined>(undefined);
  const playbackRef = useRef<VideoPlayback | null>(null);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === stageBoxRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    clearTimeout(controlTimer.current);
    if (!playing || buffering || errorMsg || framePicker || controlsHovered) setControlsHidden(false);
    else controlTimer.current = setTimeout(() => setControlsHidden(true), 2600);
    return () => clearTimeout(controlTimer.current);
  }, [playing, buffering, errorMsg, fullscreen, !!framePicker, controlsHovered]);
  useEffect(() => () => onControlsHoverChange(false), [onControlsHoverChange]);

  function controlActivity() {
    setControlsHidden(false);
    clearTimeout(controlTimer.current);
    if (playing && !buffering && !errorMsg && !framePicker && !controlsHovered) controlTimer.current = setTimeout(() => setControlsHidden(true), 2600);
    onActivity();
  }
  useEffect(() => { onWaiting(buffering || !!errorMsg); }, [buffering, errorMsg, onWaiting]);
  const retainedPlaybackRef = useRef<{
    hash: string;
    time: number;
    rate: number;
    started: boolean;
  } | null>(null);
  const pendingPausedFrameRef = useRef<{ source: VideoPlayback; time: number } | null>(null);
  const startedRef = useRef(started);
  startedRef.current = started;
  const availabilityRef = useRef({ locked, isPresent });
  availabilityRef.current = { locked, isPresent };

  const callbacksRef = useRef({
    onPlaybackChange,
    onEnded,
    onFrame: framePicker?.onChange,
  });
  callbacksRef.current = {
    onPlaybackChange,
    onEnded,
    onFrame: framePicker?.onChange,
  };

  const sourceHash = asset.id;
  const sourceRotation = 0;
  const isFramePicker = !!framePicker;
  const initialFrameTime = framePicker?.initialTime || 0;
  const nominalFps = asset.frameRate || sourceFrameRate || 30;
  const frameRateRef = useRef(nominalFps);
  frameRateRef.current = nominalFps;

  function emitFrameState() {
    const el = videoRef.current;
    if (!el || !callbacksRef.current.onFrame) return;
    const totalLen = Number.isFinite(el.duration) ? el.duration : 0;
    const fps = frameRateRef.current;
    const observed = lastObservedMediaTime.current;
    const effectiveNow =
      !el.seeking &&
      observed !== undefined &&
      Math.abs(observed - el.currentTime) < 1 / fps
        ? observed
        : el.currentTime;
    callbacksRef.current.onFrame({
      time: Math.max(0, Math.min(Math.max(0, totalLen - 0.5 / fps), effectiveNow)),
      duration: totalLen,
      ready: el.paused && !el.seeking && el.readyState >= 2,
    });
  }

  function restorePausedFrame() {
    const request = pendingPausedFrameRef.current;
    const el = videoRef.current;
    if (!request || !el || playbackRef.current !== request.source) return;
    if (!availabilityRef.current.isPresent || availabilityRef.current.locked) return;
    if (document.hidden && document.pictureInPictureElement !== el) return;
    pendingPausedFrameRef.current = null;
    request.source.loadFrame(request.time);
  }

  useEffect(() => {
    const el = videoRef.current;
    isMounted.current = true;
    if (!el) return;
    el.volume = savedVolume;
    el.muted = savedMuted;
    const previous = retainedPlaybackRef.current;
    // A saved direction changes the representation, not the viewed moment.
    const retained = previous?.hash === sourceHash ? previous : null;
    el.playbackRate = retained?.rate || 1;
    setPlaybackSpeed(retained?.rate || 1);
    setCurrentTime(retained?.time || 0);
    setPlaying(false);
    setErrorMsg("");
    setResumeOnly(false);
    setBufferedRanges([]);
    setBuffering(isFramePicker || !!retained?.started);
    if (!retained) {
      setDuration(0);
      setStarted(isFramePicker);
    }
    if (isFramePicker) setStarted(true);
    setSourceReady(false);
    setPlaybackRepresentation(null);
    setSourceFrameRate(undefined);
    lastObservedMediaTime.current = undefined;
    measuredFrameInterval.current = undefined;
    const source = new VideoPlayback(el, sourceHash, {
      onReady: setSourceReady,
      onModeChange: setPlaybackRepresentation,
      onDescriptor: (descriptor) => {
        if (descriptor.duration && Number.isFinite(descriptor.duration) && descriptor.duration > 0) {
          setDuration(descriptor.duration);
        }
        if (descriptor.frameRate && Number.isFinite(descriptor.frameRate) && descriptor.frameRate > 0) {
          setSourceFrameRate(descriptor.frameRate);
        }
      },
      onSwitch: (time) => {
        setErrorMsg("");
        setResumeOnly(false);
        setBuffering(true);
        setPlaying(false);
        setCurrentTime(time);
        setBufferedRanges([]);
        lastObservedMediaTime.current = undefined;
        measuredFrameInterval.current = undefined;
        callbacksRef.current.onFrame?.({ time, duration: el.duration || 0, ready: false });
      },
      onError: (message, resume) => {
        setErrorMsg(message);
        setResumeOnly(!!resume);
        setBuffering(false);
        setPlaying(false);
        callbacksRef.current.onPlaybackChange(false);
      },
    }, retained || undefined);
    playbackRef.current = source;
    void source.prepare()
      .then(() => {
        if (playbackRef.current !== source) return;
        if (isFramePicker || retained?.started) {
          pendingPausedFrameRef.current = {
            source,
            time: isFramePicker ? initialFrameTime : retained?.time || 0,
          };
          restorePausedFrame();
        }
      })
      .catch((error: Error) => {
        if (playbackRef.current !== source || error.name === "AbortError") return;
        setErrorMsg(error.message || "视频加载失败，请重试");
        setBuffering(false);
      });

    let vfcHandle = 0;
    const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (
        lastObservedMediaTime.current !== undefined &&
        !el?.paused &&
        !el?.seeking
      ) {
        const dt = meta.mediaTime - lastObservedMediaTime.current;
        if (dt > 0 && dt < 0.2) measuredFrameInterval.current = dt;
      }
      lastObservedMediaTime.current = meta.mediaTime;
      emitFrameState();
      vfcHandle = el?.requestVideoFrameCallback(onVideoFrame) || 0;
    };
    if (el?.requestVideoFrameCallback) {
      vfcHandle = el.requestVideoFrameCallback(onVideoFrame);
    }

    const onVisibility = () => {
      if (document.hidden && document.pictureInPictureElement !== el) {
        source.suspend();
      } else if (!document.hidden) {
        restorePausedFrame();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      isMounted.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (vfcHandle) el?.cancelVideoFrameCallback(vfcHandle);
      cancelAnimationFrame(seekRafId.current);
      if (document.pictureInPictureElement === el) {
        void document.exitPictureInPicture().catch(() => {});
      }
      retainedPlaybackRef.current = {
        hash: sourceHash,
        time: el.currentTime,
        rate: el.playbackRate,
        started: startedRef.current,
      };
      if (pendingPausedFrameRef.current?.source === source) pendingPausedFrameRef.current = null;
      source.destroy();
      if (playbackRef.current === source) playbackRef.current = null;
      callbacksRef.current.onPlaybackChange(false);
    };
  }, [sourceHash, sourceRotation, isFramePicker, initialFrameTime]);

  useEffect(() => {
    if (locked || !isPresent) playbackRef.current?.suspend();
    else restorePausedFrame();
  }, [locked, isPresent]);

  useEffect(() => {
    if (!diagnosticsOpen) { setDiagnostics(null); return; }
    setDiagnosticsCopy("");
    const update = () => setDiagnostics(playbackRef.current?.getDiagnostics() || null);
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [diagnosticsOpen, sourceReady]);

  async function startPlayback() {
    const el = videoRef.current;
    const source = playbackRef.current;
    if (!el || !source || availabilityRef.current.locked || !availabilityRef.current.isPresent) return;
    if (document.hidden && document.pictureInPictureElement !== el) return;
    setStarted(true);
    setBuffering(true);
    setErrorMsg("");
    setResumeOnly(false);
    try {
      await source.play();
    } catch (err) {
      if (!isMounted.current || playbackRef.current !== source || (err as DOMException).name === "AbortError") return;
      if ((err as DOMException).name !== "NotAllowedError" && source.handleMediaError()) return;
      setBuffering(false);
      setResumeOnly((err as DOMException).name === "NotAllowedError");
      setErrorMsg(
        (err as DOMException).name === "NotAllowedError"
          ? "点按播放以继续"
          : "视频加载失败，请重试",
      );
    }
  }

  function togglePlayPause() {
    if (videoRef.current?.paused) void startPlayback();
    else videoRef.current?.pause();
    onActivity();
  }

  function finishScrub() {
    const val = activeScrubValue.current;
    const el = videoRef.current;
    if (val === null || !el) return;
    cancelAnimationFrame(seekRafId.current);
    seekRafId.current = 0;
    pendingPreviewTime.current = null;
    playbackRef.current?.loadFrame(val);
    setCurrentTime(val);
    setScrubTime(null);
    activeScrubValue.current = null;
    if (resumeOnRelease.current) void startPlayback();
    resumeOnRelease.current = false;
    onActivity();
  }

  function schedulePreviewSeek() {
    if (seekRafId.current || videoRef.current?.seeking) return;
    seekRafId.current = requestAnimationFrame(() => {
      seekRafId.current = 0;
      const el = videoRef.current;
      const target = pendingPreviewTime.current;
      if (!el || el.seeking || target === null) return;
      pendingPreviewTime.current = null;
      el.currentTime = target;
    });
  }

  function stepSingleFrame(dir: -1 | 1) {
    const el = videoRef.current;
    if (!el || locked || !duration) return;
    el.pause();
    resumeOnRelease.current = false;
    activeScrubValue.current = null;
    pendingPreviewTime.current = null;
    cancelAnimationFrame(seekRafId.current);
    seekRafId.current = 0;
    setScrubTime(null);

    const catalogRate = asset.frameRate || sourceFrameRate;
    const validRate =
      Number.isFinite(catalogRate) && catalogRate && catalogRate > 0 ? catalogRate : 0;
    const stepDt = validRate
      ? 1 / validRate
      : measuredFrameInterval.current || 1 / 30;
    const baseTime = validRate
      ? Math.floor((el.currentTime + stepDt * 0.01) / stepDt) * stepDt
      : !el.seeking &&
          lastObservedMediaTime.current !== undefined &&
          Math.abs(lastObservedMediaTime.current - el.currentTime) < stepDt
        ? lastObservedMediaTime.current
        : el.currentTime;

    const target = Math.max(
      0,
      Math.min(Math.max(0, duration - stepDt / 2), baseTime + (dir + 0.1) * stepDt),
    );
    el.currentTime = target;
    setCurrentTime(target);
    onActivity();
  }

  async function toggleFullscreen() {
    const el = videoRef.current as WebkitFullscreenVideo | null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stageBoxRef.current?.requestFullscreen) {
        try { await stageBoxRef.current.requestFullscreen(); }
        catch (error) { if (el?.webkitEnterFullscreen) el.webkitEnterFullscreen(); else throw error; }
      } else el?.webkitEnterFullscreen?.();
    } catch {
      setErrorMsg("暂时无法进入全屏");
    }
  }

  async function togglePip() {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      setErrorMsg("暂时无法开启画中画");
    }
  }

  const effectiveTime = scrubTime ?? currentTime;
  const effectiveDuration =
    duration ||
    (Number.isFinite(asset.duration) ? Math.max(0, asset.duration || 0) : 0);
  const playedRatio = effectiveDuration
    ? Math.min(100, (effectiveTime / effectiveDuration) * 100)
    : 0;

  return (
    <div
      ref={stageBoxRef}
      className={`curio-player ${playing ? "is-playing" : ""} ${started ? "is-started" : ""} ${framePicker ? "is-frame-picker" : ""} ${playing && !buffering && !errorMsg && !framePicker && (fullscreen ? controlsHidden : chromeHidden) ? "controls-hidden" : ""}`}
    >
      <video
        ref={videoRef}
        className="player-video"
        playsInline
        preload={framePicker ? "metadata" : "none"}
        poster={asset.thumbnailUrl || undefined}
        aria-label={asset.title || asset.name}
        onPointerDown={(e) => {
          if (e.pointerType === "touch" && !locked && !framePicker) {
            if (touchStart.current) {
              touchStart.current.canceled = true;
              ignoreNextClick.current = true;
              return;
            }
            e.currentTarget.setPointerCapture(e.pointerId);
            touchStart.current = { id: e.pointerId, x: e.clientX, y: e.clientY, canceled: false };
            ignoreNextClick.current = false;
          }
        }}
        onPointerMove={(e) => {
          if (
            touchStart.current &&
            Math.hypot(e.clientX - touchStart.current.x, e.clientY - touchStart.current.y) > 8
          ) {
            ignoreNextClick.current = true;
          }
        }}
        onPointerUp={(e) => {
          const start = touchStart.current;
          if (!start || start.id !== e.pointerId) return;
          touchStart.current = undefined;
          if (start.canceled || locked) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            if (dx < 0) onNext();
            else onPrevious();
          } else if (dy > 110 && dy > Math.abs(dx) * 1.5) {
            onClose();
          }
        }}
        onPointerCancel={() => {
          touchStart.current = undefined;
          ignoreNextClick.current = true;
        }}
        onClick={() => {
          if (!sourceReady) return;
          if (ignoreNextClick.current) {
            ignoreNextClick.current = false;
            return;
          }
          if (!started || !playing) togglePlayPause();
          else if (fullscreen) {
            if (controlsHidden) controlActivity();
            else setControlsHidden(true);
          } else onToggleChrome();
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          const len = Number.isFinite(el.duration) ? el.duration : 0;
          setDuration(len);
          setSupportsPip(
            !!document.pictureInPictureEnabled && !el.disablePictureInPicture,
          );
          emitFrameState();
        }}
        onLoadedData={() => {
          playbackRef.current?.settled();
          if (framePicker || videoRef.current?.paused) setBuffering(false);
          emitFrameState();
        }}
        onTimeUpdate={(e) => {
          setCurrentTime(e.currentTarget.currentTime);
          emitFrameState();
        }}
        onProgress={(e) => {
          const el = e.currentTarget;
          const list: { start: number; end: number }[] = [];
          for (let i = 0; i < el.buffered.length; i++) {
            list.push({ start: el.buffered.start(i), end: el.buffered.end(i) });
          }
          setBufferedRanges(list);
        }}
        onPlay={(e) => {
          const el = e.currentTarget;
          const source = playbackRef.current;
          if (!isMounted.current || !source || el.paused) return;
          if (
            availabilityRef.current.locked ||
            !availabilityRef.current.isPresent ||
            (document.hidden && document.pictureInPictureElement !== el)
          ) {
            source.suspend();
            return;
          }
          if (!source.played()) return;
          setStarted(true);
          setPlaying(true);
          callbacksRef.current.onPlaybackChange(true);
          emitFrameState();
        }}
        onPause={() => {
          if (isMounted.current && videoRef.current?.paused) {
            const source = playbackRef.current;
            source?.paused();
            setPlaying(false);
            if (!source?.changingSource) setBuffering(false);
            callbacksRef.current.onPlaybackChange(false);
            emitFrameState();
          }
        }}
        onPlaying={() => {
          playbackRef.current?.settled();
          setBuffering(false);
          setErrorMsg("");
          setResumeOnly(false);
        }}
        onWaiting={() => setBuffering(true)}
        onSeeking={() => {
          playbackRef.current?.seeking();
          setBuffering(true);
          emitFrameState();
        }}
        onSeeked={() => {
          playbackRef.current?.settled();
          setBuffering(false);
          schedulePreviewSeek();
          emitFrameState();
        }}
        onEnded={() => {
          setPlaying(false);
          callbacksRef.current.onPlaybackChange(false);
          callbacksRef.current.onEnded?.();
        }}
        onVolumeChange={(e) => {
          savedVolume = e.currentTarget.volume;
          savedMuted = e.currentTarget.muted;
          setVolume(savedVolume);
          setMuted(savedMuted);
        }}
        onError={() => {
          if (isMounted.current && videoRef.current?.error) {
            if (playbackRef.current?.handleMediaError()) return;
            setErrorMsg("视频加载失败，请重试");
            setResumeOnly(false);
            setBuffering(false);
            setPlaying(false);
            callbacksRef.current.onPlaybackChange(false);
            callbacksRef.current.onFrame?.({ time: 0, duration: 0, ready: false });
          }
        }}
      />

      {diagnosticsOpen && (
        <section className="player-diagnostics" aria-label="播放诊断">
          <div className="player-diagnostics-actions">
            <strong>播放诊断</strong>
            <button type="button" onClick={() => {
              const report = JSON.stringify({
                video: asset.name,
                userAgent: navigator.userAgent,
                visibility: document.visibilityState,
                standalone: window.matchMedia("(display-mode: standalone)").matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
                bundle: document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src"),
                ...playbackRef.current?.getDiagnostics(),
              }, null, 2);
              if (!navigator.clipboard) { setDiagnosticsCopy("请选择下方文本复制"); return; }
              void navigator.clipboard.writeText(report).then(() => setDiagnosticsCopy("已复制"), () => setDiagnosticsCopy("请选择下方文本复制"));
            }}>复制诊断</button>
            <button type="button" onClick={onCloseDiagnostics}>关闭</button>
          </div>
          {diagnosticsCopy && <small role="status">{diagnosticsCopy}</small>}
          <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
        </section>
      )}

      {started && playbackRepresentation === "compatibility" && (
        <span
          className="player-compatibility-badge"
          role="status"
          aria-label="兼容模式，当前播放的是转码视频而非原件"
        >
          兼容模式 · 已转码
        </span>
      )}

      <>
        {!framePicker && !playing && !buffering && !errorMsg && (
          <button
            type="button"
            className="player-big-play"
            disabled={locked || !sourceReady}
            aria-label={
              currentTime >= duration && duration > 0 ? "重新播放" : "播放视频"
            }
            onClick={togglePlayPause}
          >
            <Play size={30} fill="currentColor" strokeWidth={1} />
          </button>
        )}
      </>

      <>
        {buffering && (
          <div className="player-waiting" role="status" aria-label="视频缓冲中">
            <LoaderCircle className="spin" size={28} />
          </div>
        )}
      </>

      <>
        {errorMsg && (
          <div className="player-error" role="status">
            <span>{errorMsg}</span>
            <button
              type="button"
              disabled={locked || (resumeOnly && !sourceReady)}
              onClick={async () => {
                // Keep play in the tap handler when the browser requires a user gesture.
                if (resumeOnly) {
                  void startPlayback();
                  return;
                }
                const source = playbackRef.current;
                if (!source) return;
                setErrorMsg("");
                setBuffering(true);
                try {
                  await source.retry();
                  if (!isMounted.current || playbackRef.current !== source) return;
                  if (framePicker) source.loadFrame();
                  else void startPlayback();
                } catch (error) {
                  if (!isMounted.current || (error as Error).name === "AbortError") return;
                  setErrorMsg((error as Error).message || "视频加载失败，请重试");
                  setBuffering(false);
                }
              }}
            >
              {resumeOnly ? "继续播放" : "重试"}
            </button>
          </div>
        )}
      </>

      <div
        className="player-controls"
        onPointerDown={(e) => {
          e.stopPropagation();
          controlActivity();
        }}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") {
            setControlsHovered(true);
            onControlsHoverChange(true);
          }
          controlActivity();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "mouse") return;
          setControlsHovered(false);
          onControlsHoverChange(false);
          controlActivity();
        }}
      >
        <div className="player-seek-row">
          <span className="player-time">{formatDurationClock(effectiveTime)}</span>
          <div
            className="player-seek"
            style={{ "--played": `${playedRatio}%` } as CSSProperties}
          >
            <div className="player-buffered" aria-hidden="true">
              {duration > 0 &&
                bufferedRanges.map((r, idx) => (
                  <i
                    key={idx}
                    style={{
                      left: `${(r.start / duration) * 100}%`,
                      width: `${((r.end - r.start) / duration) * 100}%`,
                    }}
                  />
                ))}
            </div>
            <input
              type="range"
              aria-label={framePicker ? "选帧进度" : "播放进度"}
              aria-valuetext={`${formatDurationClock(effectiveTime)} / ${formatDurationClock(effectiveDuration)}`}
              min="0"
              max={
                framePicker && effectiveDuration
                  ? Math.max(0, effectiveDuration - 0.5 / nominalFps)
                  : effectiveDuration || 1
              }
              step={framePicker ? ".001" : ".1"}
              value={effectiveTime}
              disabled={locked || !sourceReady || !effectiveDuration}
              onPointerDown={() => {
                resumeOnRelease.current =
                  !!videoRef.current && !videoRef.current.paused;
                activeScrubValue.current = videoRef.current?.currentTime || currentTime;
                setScrubTime(activeScrubValue.current);
                videoRef.current?.pause();
              }}
              onChange={(e) => {
                const val = Number(e.target.value);
                activeScrubValue.current = val;
                setScrubTime(val);
                if (!compact || framePicker) {
                  pendingPreviewTime.current = val;
                  schedulePreviewSeek();
                }
              }}
              onPointerUp={finishScrub}
              onPointerCancel={finishScrub}
              onKeyUp={finishScrub}
              onBlur={finishScrub}
            />
          </div>
          <span
            className="player-time"
            title={started ? "剩余时长" : "视频时长"}
          >
            {started ? "-" : ""}
            {formatDurationClock(
              started ? effectiveDuration - effectiveTime : effectiveDuration,
            )}
          </span>
        </div>

        <div className="player-buttons">
          <div className="player-volume">
            <button
              type="button"
              aria-label={muted || volume === 0 ? "取消静音" : "静音"}
              data-player-mute
              disabled={locked}
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.muted = !videoRef.current.muted;
                }
              }}
            >
              <span key={muted || volume === 0 ? "muted" : "sound"} className="player-state-icon" aria-hidden="true">
                {muted || volume === 0 ? (
                  <VolumeX size={18} />
                ) : (
                  <Volume2 size={18} />
                )}
              </span>
            </button>
            <input
              aria-label="音量"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              disabled={locked}
              onChange={(e) => {
                if (videoRef.current) {
                  videoRef.current.volume = Number(e.target.value);
                  videoRef.current.muted = false;
                }
              }}
            />
          </div>

          <div className="player-transport">
            <button
              type="button"
              className="player-frame-step"
              data-player-previous-frame
              title="上一帧（,）"
              aria-label="上一帧"
              disabled={locked || !duration}
              onClick={() => stepSingleFrame(-1)}
            >
              <StepBack size={16} />
            </button>
            <button
              type="button"
              title={`后退 ${PLAYER_SKIP_SECONDS} 秒`}
              aria-label={`后退 ${PLAYER_SKIP_SECONDS} 秒`}
              disabled={locked || !duration}
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.currentTime = Math.max(
                    0,
                    videoRef.current.currentTime - PLAYER_SKIP_SECONDS,
                  );
                }
              }}
            >
              <SkipSecondsGlyph />
            </button>
            <button
              type="button"
              className="player-toggle"
              data-player-toggle
              aria-label={playing ? "暂停" : "播放"}
              title="播放 / 暂停（空格）"
              disabled={locked || !sourceReady}
              onClick={togglePlayPause}
            >
              <span key={playing ? "pause" : "play"} className="player-state-icon" aria-hidden="true">
                {playing ? (
                  <Pause size={22} fill="currentColor" />
                ) : (
                  <Play size={22} fill="currentColor" />
                )}
              </span>
            </button>
            <button
              type="button"
              title={`前进 ${PLAYER_SKIP_SECONDS} 秒`}
              aria-label={`前进 ${PLAYER_SKIP_SECONDS} 秒`}
              disabled={locked || !duration}
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.currentTime = Math.min(
                    duration,
                    videoRef.current.currentTime + PLAYER_SKIP_SECONDS,
                  );
                }
              }}
            >
              <SkipSecondsGlyph forward />
            </button>
            <button
              type="button"
              className="player-frame-step"
              data-player-next-frame
              title="下一帧（.）"
              aria-label="下一帧"
              disabled={locked || !duration}
              onClick={() => stepSingleFrame(1)}
            >
              <StepForward size={16} />
            </button>
          </div>

          <div className="player-options">
            {!framePicker && (
              <button
                type="button"
                title="使用兼容模式播放（转码）"
                aria-label="使用兼容模式播放"
                data-player-compatibility
                hidden={playbackRepresentation !== "source"}
                disabled={locked || !sourceReady}
                onClick={() => {
                  if (playbackRef.current?.useCompatibility(true)) {
                    setErrorMsg("");
                    setBuffering(true);
                  } else void startPlayback();
                }}
              >
                <CompatibilityPlaybackGlyph />
              </button>
            )}
            <button
              type="button"
              className="player-speed"
              aria-label={`播放速度 ${playbackSpeed} 倍`}
              title="切换播放速度"
              disabled={locked}
              onClick={() => {
                const steps = [0.5, 1, 1.5, 2];
                const next = steps[(steps.indexOf(playbackSpeed) + 1) % steps.length];
                setPlaybackSpeed(next);
                playbackRef.current?.setRate(next);
              }}
            >
              <span key={playbackSpeed} className="player-state-icon">{playbackSpeed}×</span>
            </button>
            {supportsPip && (
              <button
                type="button"
                title="画中画"
                aria-label="画中画"
                disabled={locked}
                onClick={() => void togglePip()}
              >
                <PictureInPicture2 size={18} />
              </button>
            )}
            <button
              type="button"
              title="全屏播放（F）"
              aria-label="全屏播放"
              data-player-fullscreen
              disabled={locked}
              onClick={() => void toggleFullscreen()}
            >
              <Maximize size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
