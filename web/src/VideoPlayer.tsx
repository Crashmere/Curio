import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import type { Asset } from "./api";
import { VideoPlayback } from "./video-playback";

export function VideoPlayer({ asset }: { asset: Asset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<VideoPlayback | null>(null);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);

  async function startPlayback() {
    const video = videoRef.current;
    const source = playbackRef.current;
    if (!video || !source || (document.hidden && document.pictureInPictureElement !== video)) return;
    try {
      await source.play();
    } catch (error) {
      if (playbackRef.current !== source || (error as DOMException).name === "AbortError") return;
      if ((error as DOMException).name === "NotAllowedError") {
        source.suspend();
        return;
      }
      if (source.handleMediaError()) return;
      setError((error as Error).message || "视频加载失败，请重试");
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError("");
    const source = new VideoPlayback(video, asset.id, {
      onSwitch: () => setError(""),
      onError: setError,
    });
    playbackRef.current = source;
    void source.prepare()
      .then(() => {
        if (playbackRef.current === source) void startPlayback();
      })
      .catch((error: Error) => {
        if (playbackRef.current !== source || error.name === "AbortError") return;
        setError(error.message || "视频加载失败，请重试");
      });
    const onVisibility = () => {
      if (document.hidden && document.pictureInPictureElement !== video) source.suspend();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture().catch(() => {});
      }
      source.destroy();
      if (playbackRef.current === source) playbackRef.current = null;
    };
  }, [asset.id]);

  return <div className="video-player">
    <video
      ref={videoRef}
      className="viewer-video"
      poster={asset.thumbnailUrl || undefined}
      aria-label={asset.title || asset.name}
      controls
      autoPlay
      playsInline
      preload="metadata"
      onPlay={event => {
        const video = event.currentTarget;
        const source = playbackRef.current;
        if (!source || video.paused) return;
        if (document.hidden && document.pictureInPictureElement !== video) {
          source.suspend();
          return;
        }
        if (source.played()) setError("");
      }}
      onPause={() => playbackRef.current?.paused()}
      onSeeking={() => playbackRef.current?.seeking()}
      onSeeked={() => playbackRef.current?.settled()}
      onLoadedData={() => playbackRef.current?.settled()}
      onPlaying={() => playbackRef.current?.settled()}
      onRateChange={() => playbackRef.current?.rateChanged()}
      onError={() => {
        if (!videoRef.current?.error) return;
        if (playbackRef.current?.handleMediaError()) return;
        setError("视频加载失败，请重试");
      }}
    />
    {error && <div className="preview-pending video-playback-error" role="alert">
      <strong>{error}</strong>
      <button className="button" disabled={retrying} onClick={async () => {
        const source = playbackRef.current;
        if (!source || retrying) return;
        setRetrying(true);
        setError("");
        try {
          await source.retry();
          if (playbackRef.current === source) await startPlayback();
        } catch (error) {
          if (playbackRef.current === source && (error as Error).name !== "AbortError") {
            setError((error as Error).message || "视频加载失败，请重试");
          }
        } finally {
          if (playbackRef.current === source) setRetrying(false);
        }
      }}><RotateCw size={14} className={retrying ? "spin" : undefined} />重试</button>
    </div>}
  </div>;
}
