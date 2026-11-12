import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Maximize, Pause, Play, RotateCw, Volume2, VolumeX } from "lucide-react";
import { type Asset, duration as clock } from "./api";
import { VideoPlayback } from "./video-playback";
import { useTouchNavigation, useViewerControls } from "./viewer-interactions";

type Props = {
  asset: Asset; compact: boolean; hidden: boolean; activity: () => void; toggleChrome: () => void;
  previous?: () => void; next?: () => void; close: () => void;
  onPlayback: (playing: boolean) => void; onWaiting: (waiting: boolean) => void;
};
type NativeVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export function VideoPlayer({ asset, compact, hidden, activity, toggleChrome, previous, next, close, onPlayback, onWaiting }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<VideoPlayback | null>(null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(asset.duration);
  const [scrub, setScrub] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [mode, setMode] = useState<"source" | "compatibility">("source");
  const [fullscreen, setFullscreen] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const resumeScrub = useRef(false);
  const localControls = useViewerControls(playing, waiting || !!error || scrub !== null);
  function reveal() { activity(); localControls.reveal(); }
  const fullscreenChanged = useEffectEvent(() => { setFullscreen(document.fullscreenElement === stage.current); reveal(); });
  const nativeFullscreenEnded = useEffectEvent(() => { setNativeFullscreen(false); reveal(); });
  const gestures = useTouchNavigation({ previous, next, close, tap: () => {
    if (!ready) return;
    if (!playing) void startPlayback();
    else if (fullscreen) localControls.toggle();
    else toggleChrome();
  } });

  async function startPlayback() {
    const video = videoRef.current, source = playbackRef.current;
    if (!video || !source || (document.hidden && document.pictureInPictureElement !== video)) return;
    setWaiting(true); setError(""); reveal();
    try { await source.play(); }
    catch (error) {
      if (playbackRef.current !== source || (error as DOMException).name === "AbortError") return;
      if ((error as DOMException).name === "NotAllowedError") { source.suspend(); setWaiting(false); return; }
      if (source.handleMediaError()) return;
      setWaiting(false); setError((error as Error).message || "视频加载失败，请重试");
    }
  }

  useEffect(() => {
    const video = videoRef.current!;
    const source = new VideoPlayback(video, asset.id, {
      onSwitch: () => { setError(""); setWaiting(true); },
      onError: message => { setError(message); setWaiting(false); setPlaying(false); },
      onReady: setReady, onMode: setMode,
    });
    playbackRef.current = source;
    void source.prepare().then(() => {
      if (!compact && playbackRef.current === source) void startPlayback();
    }).catch((error: Error) => {
      if (playbackRef.current === source && error.name !== "AbortError") setError(error.message || "视频加载失败，请重试");
    });
    const visibility = () => { if (document.hidden && document.pictureInPictureElement !== video) source.suspend(); };
    const full = () => fullscreenChanged();
    const nativeBegin = () => setNativeFullscreen(true);
    const nativeEnd = () => nativeFullscreenEnded();
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", full);
    video.addEventListener("webkitbeginfullscreen", nativeBegin);
    video.addEventListener("webkitendfullscreen", nativeEnd);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", full);
      video.removeEventListener("webkitbeginfullscreen", nativeBegin);
      video.removeEventListener("webkitendfullscreen", nativeEnd);
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
      source.destroy();
      if (playbackRef.current === source) playbackRef.current = null;
    };
  }, [asset.id]);
  useEffect(() => { onPlayback(playing); }, [playing]);
  useEffect(() => { onWaiting(waiting || !!error); }, [waiting, error]);
  async function toggleFullscreen() {
    const video = videoRef.current as NativeVideo;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.current?.requestFullscreen) {
        try { await stage.current.requestFullscreen(); }
        catch (error) { if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else throw error; }
      } else video.webkitEnterFullscreen?.();
    } catch { setError("暂时无法进入全屏"); }
  }
  function finishScrub() {
    if (scrub === null || !videoRef.current) return;
    playbackRef.current?.loadFrame(scrub);
    setTime(scrub); setScrub(null);
    if (resumeScrub.current) void startPlayback();
    resumeScrub.current = false;
  }
  const hideControls = playing && !waiting && !error && scrub === null && (fullscreen ? localControls.hidden : hidden);
  return <div ref={stage} className={`video-player ${hideControls ? "controls-hidden" : ""}`}>
    <video ref={videoRef} className="viewer-video" poster={asset.thumbnailUrl || undefined}
      aria-label={asset.title || asset.name} controls={!compact || nativeFullscreen} playsInline preload={compact ? "none" : "metadata"}
      {...(compact && !nativeFullscreen ? gestures : {})}
      onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
      onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
      onVolumeChange={event => setMuted(event.currentTarget.muted)}
      onRateChange={event => { setRate(event.currentTarget.playbackRate); playbackRef.current?.rateChanged(); }}
      onPlay={event => {
        const video = event.currentTarget, source = playbackRef.current;
        if (!source || video.paused) return;
        if (document.hidden && document.pictureInPictureElement !== video) { source.suspend(); return; }
        if (source.played()) { setError(""); setPlaying(true); }
      }}
      onPause={() => { playbackRef.current?.paused(); setPlaying(false); }}
      onWaiting={() => setWaiting(true)} onStalled={() => { if (!videoRef.current?.paused) setWaiting(true); }}
      onSeeking={() => { playbackRef.current?.seeking(); setWaiting(true); }}
      onSeeked={() => { playbackRef.current?.settled(); setWaiting(false); }}
      onLoadedData={() => { playbackRef.current?.settled(); setWaiting(false); }}
      onPlaying={() => { playbackRef.current?.settled(); setWaiting(false); }}
      onEnded={() => { setPlaying(false); setWaiting(false); }}
      onError={() => {
        if (!videoRef.current?.error) return;
        if (playbackRef.current?.handleMediaError()) return;
        setWaiting(false); setError("视频加载失败，请重试");
      }} />
    {!error && (!ready || waiting) && <div className="video-waiting" role="status"><RotateCw size={20} className="spin" /><span>{ready ? "正在缓冲" : "正在准备视频"}</span></div>}
    {compact && ready && !playing && !waiting && !error && <button className="video-start" aria-label="播放视频" onClick={() => void startPlayback()}><Play size={30} fill="currentColor" /></button>}
    {error && <div className="preview-pending video-playback-error" role="alert">
      <strong>{error}</strong><button className="button" disabled={retrying} onClick={async () => {
        const source = playbackRef.current;
        if (!source || retrying) return;
        setRetrying(true); setError(""); setWaiting(true);
        try { await source.retry(); if (playbackRef.current === source) await startPlayback(); }
        catch (error) { if (playbackRef.current === source && (error as Error).name !== "AbortError") { setError((error as Error).message); setWaiting(false); } }
        finally { if (playbackRef.current === source) setRetrying(false); }
      }}><RotateCw size={14} className={retrying ? "spin" : undefined} />重试</button>
    </div>}
    {compact && <div className="video-controls" onPointerDown={reveal} onPointerEnter={reveal}>
      <div className="video-seek"><span>{clock(scrub ?? time)}</span><input type="range" aria-label="播放进度" aria-valuetext={`${clock(scrub ?? time)} / ${clock(duration)}`} min="0" max={duration || 1} step="0.1" value={scrub ?? time} disabled={!ready || !duration}
        onPointerDown={() => { resumeScrub.current = !videoRef.current!.paused; setScrub(videoRef.current!.currentTime); videoRef.current!.pause(); }}
        onChange={event => setScrub(Number(event.target.value))} onPointerUp={finishScrub} onPointerCancel={finishScrub} onKeyUp={finishScrub} onBlur={finishScrub} /><span>{clock(duration)}</span></div>
      <div className="video-buttons">
        <button aria-label={muted ? "取消静音" : "静音"} onClick={() => { videoRef.current!.muted = !muted; }}>{muted ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
        <button aria-label={playing ? "暂停" : "播放"} disabled={!ready} onClick={() => playing ? videoRef.current?.pause() : void startPlayback()}>{playing ? <Pause size={22} /> : <Play size={22} />}</button>
        <label className="video-rate"><select aria-label="播放速度" value={rate} onChange={event => { videoRef.current!.playbackRate = Number(event.target.value); }}>{[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
        <button aria-label="全屏播放" onClick={() => void toggleFullscreen()}><Maximize size={20} /></button>
      </div>
      {mode === "source" && <button className="video-compatibility" disabled={!ready} onClick={() => { if (playbackRef.current?.useCompatibility()) reveal(); }}>播放不流畅？切换兼容播放</button>}
    </div>}
  </div>;
}
