import { CSSProperties, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Maximize, Minus, Plus, RotateCw } from "lucide-react";
import { Asset } from "./api";

type Point = { x: number; y: number };
type Transform = Point & { scale: number | null };
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

export function ImageViewer({ asset, sourceOverride, pixels, bitmap }: { asset: Asset; sourceOverride?: string; pixels?: ImageData; bitmap?: ImageBitmap }) {
  const stage = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const raster = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const current = useRef<Transform>({ scale: null, x: 0, y: 0 });
  const [view, setView] = useState(current.current);
  const [size, setSize] = useState({ width: asset.width, height: asset.height });
  const [previewPixels, setPreviewPixels] = useState({ width: 0, height: 0 });
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [background, setBackground] = useState("checker");
  const [quality, setQuality] = useState<"preview" | "loading" | "original" | "fallback">("preview");
  const [requestOriginal, setRequestOriginal] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const format = (asset.format || asset.name.split(".").pop() || "").toLowerCase();
  const canLoadOriginal = !sourceOverride && !pixels && !bitmap && asset.kind === "image" && /^(jpe?g|png|webp|avif|gif|bmp|ico|apng)$/.test(format) && asset.mime !== "image/svg+xml" && !!asset.originalUrl;
  const ready = size.width > 0 && size.height > 0 && area.width > 0 && area.height > 0;
  const fit = ready ? Math.min(format === "svg" ? Infinity : 1, area.width / size.width, area.height / size.height) : 1;
  const minimum = Math.min(fit, 0.1);
  const maximum = Math.max(8, fit * 8);
  const scale = Math.min(maximum, Math.max(minimum, view.scale ?? fit));
  const zoomed = scale > fit + 0.001;
  const previewLimited = previewPixels.width > 0 && Math.max(size.width, size.height) > Math.max(previewPixels.width, previewPixels.height)
    && (size.width * scale * window.devicePixelRatio > previewPixels.width || size.height * scale * window.devicePixelRatio > previewPixels.height);
  const needsOriginal = ready && (zoomed || previewLimited);

  function bounded(next: Transform): Transform {
    const scale = Math.min(maximum, Math.max(minimum, next.scale ?? fit));
    return {
      scale: next.scale === null ? null : scale,
      x: clamp(next.x, Math.max(0, (size.width * scale - area.width) / 2)),
      y: clamp(next.y, Math.max(0, (size.height * scale - area.height) / 2))
    };
  }
  function apply(next: Transform) {
    current.current = bounded(next);
    setView(current.current);
  }
  function point(clientX: number, clientY: number): Point {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }
  function zoomTo(value: number, anchor: Point = { x: 0, y: 0 }, destination = anchor) {
    if (!ready) return;
    const before = bounded(current.current);
    const oldScale = before.scale ?? fit;
    const nextScale = Math.min(maximum, Math.max(minimum, value));
    // Keep the same image point under the cursor or moving pinch midpoint.
    apply({ scale: nextScale, x: destination.x - (anchor.x - before.x) * nextScale / oldScale, y: destination.y - (anchor.y - before.y) * nextScale / oldScale });
  }
  const resize = useEffectEvent(() => apply(current.current));
  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(([entry]) => setArea({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { resize(); }, [area.width, area.height, size.width, size.height]);
  useEffect(() => {
    if (asset.width > 0 && asset.height > 0) setSize({ width: asset.width, height: asset.height });
  }, [asset.width, asset.height]);
  useLayoutEffect(() => {
    const canvas = raster.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    if (bitmap) { context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0); }
    else if (pixels) context.putImageData(pixels, 0, 0);
  }, [pixels, bitmap]);

  const wheel = useEffectEvent((event: WheelEvent) => {
    if (!ready) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.height : 1);
    zoomTo((bounded(current.current).scale ?? fit) * Math.exp(-delta * 0.002), point(event.clientX, event.clientY));
  });
  useEffect(() => {
    const element = stage.current!;
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    if (needsOriginal && canLoadOriginal) setRequestOriginal(true);
  }, [needsOriginal, canLoadOriginal]);
  useEffect(() => {
    if (!requestOriginal || sourceOverride || pixels || bitmap) return;
    let active = true;
    const original = new Image();
    setQuality("loading");
    original.onload = async () => {
      try {
        await original.decode();
        if (active) setQuality("original");
      } catch { if (active) setQuality("fallback"); }
    };
    original.onerror = () => { if (active) setQuality("fallback"); };
    original.src = asset.originalUrl;
    return () => { active = false; original.onload = null; original.onerror = null; original.src = ""; };
  }, [requestOriginal, asset.originalUrl, sourceOverride, !!pixels, !!bitmap]);

  function release(pointerId: number) {
    pointers.current.delete(pointerId);
    setDragging(pointers.current.size > 0);
  }
  const source = sourceOverride || (quality === "original" ? asset.originalUrl : asset.previewUrl);
  const imageStyle: CSSProperties = { width: size.width || undefined, height: size.height || undefined, visibility: ready ? "visible" : "hidden", transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${scale})` };
  return <>
    <div ref={stage} className={`media-stage image-stage ${asset.hasAlpha ? background : "neutral"} ${dragging ? "is-dragging" : ""} ${zoomed ? "is-zoomed" : ""}`}>
      <div ref={viewport} className="image-viewport"
        onDoubleClick={event => { event.preventDefault(); if (zoomed) apply({ scale: null, x: 0, y: 0 }); else zoomTo(fit < 0.99 ? 1 : fit * 2, point(event.clientX, event.clientY)); }}
        onPointerDown={event => {
          if (!ready || event.button !== 0 || pointers.current.size >= 2) return;
          event.preventDefault();
          pointers.current.set(event.pointerId, point(event.clientX, event.clientY));
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={event => {
          if (!pointers.current.has(event.pointerId)) return;
          const before = [...pointers.current.values()];
          pointers.current.set(event.pointerId, point(event.clientX, event.clientY));
          const after = [...pointers.current.values()];
          if (after.length === 1) {
            const view = bounded(current.current);
            apply({ ...view, x: view.x + after[0].x - before[0].x, y: view.y + after[0].y - before[0].y });
          } else {
            const midpoint = (points: Point[]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
            const distance = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            if (distance(before) > 0) zoomTo((bounded(current.current).scale ?? fit) * distance(after) / distance(before), midpoint(before), midpoint(after));
          }
        }}
        onPointerUp={event => release(event.pointerId)} onPointerCancel={event => release(event.pointerId)} onLostPointerCapture={event => release(event.pointerId)}>
        {pixels || bitmap ? <canvas ref={raster} className="viewer-image" width={(bitmap || pixels)!.width} height={(bitmap || pixels)!.height} role="img" aria-label={asset.title || asset.name} style={imageStyle} />
          : source && (sourceOverride || !previewFailed || quality === "original") ? <img className="viewer-image" src={source} alt={asset.title || asset.name} draggable={false}
          onLoad={event => {
            const dimensions = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
            if (!size.width || !size.height) setSize(dimensions);
            if (quality !== "original") setPreviewPixels(dimensions);
          }}
          onError={() => { if (quality === "original") setQuality("fallback"); else setPreviewFailed(true); }}
          style={imageStyle} />
          : <div className="preview-pending"><RotateCw size={30} className={asset.status === "error" || previewFailed ? "" : "spin"} /><strong>{previewFailed ? "预览暂不可用" : asset.status === "error" ? "预览处理失败" : "预览正在准备"}</strong><span>原件已保存，可以先下载使用。</span></div>}
      </div>
      {!sourceOverride && !pixels && !bitmap && (zoomed || quality === "loading" || quality === "fallback") && source && <div className="image-quality" role="status">{quality === "loading" ? <><RotateCw size={12} className="spin" />正在加载原图</> : quality === "fallback" ? "预览图 · 原图不可用" : quality === "original" || asset.kind === "animation" ? "原图" : !canLoadOriginal ? "兼容预览" : "预览图"}</div>}
    </div>
    <div className="viewer-tools">
      <button className="icon-button" aria-label="缩小" disabled={!ready || scale <= minimum} onClick={() => zoomTo(scale / 1.25)}><Minus size={16} /></button>
      <button className="zoom-label" aria-label="原始尺寸（100%）" title="原始尺寸（100%）" disabled={!ready} onClick={() => zoomTo(1)}>{Math.round(scale * 100)}%</button>
      <button className="icon-button" aria-label="放大" disabled={!ready || scale >= maximum} onClick={() => zoomTo(scale * 1.25)}><Plus size={16} /></button>
      <button className="icon-button" aria-label="适应窗口" title="适应窗口" disabled={!ready} onClick={() => apply({ scale: null, x: 0, y: 0 })}><Maximize size={15} /></button>
      {asset.hasAlpha && <><span className="tool-divider" /><button className={`background-swatch checker ${background === "checker" ? "selected" : ""}`} aria-label="透明棋盘背景" onClick={() => setBackground("checker")} /><button className={`background-swatch light ${background === "light" ? "selected" : ""}`} aria-label="浅色背景" onClick={() => setBackground("light")} /><button className={`background-swatch dark ${background === "dark" ? "selected" : ""}`} aria-label="深色背景" onClick={() => setBackground("dark")} /></>}
    </div>
  </>;
}
