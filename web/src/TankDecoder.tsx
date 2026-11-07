import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Download, RotateCw } from "lucide-react";
import { Asset } from "./api";
import { Dialog } from "./components";
import { ImageViewer } from "./ImageViewer";
import { readTankPreset, tankDefaults, tankMaxBytes, tankMaxPixels, tankPreviewEdge, TankOptions } from "./tank-decode";
import thirdPartyNotices from "../../docs/THIRD_PARTY_NOTICES.md?raw";

export function canDecodeTank(asset: Asset) {
  return asset.kind === "image" && asset.mime !== "image/svg+xml" && !!asset.originalUrl && asset.width > 0 && asset.height > 0
    && /^(jpe?g|png|webp|avif|bmp|ico)$/.test((asset.format || asset.name.split(".").pop() || "").toLowerCase());
}

export function TankDecoder({ asset, close }: { asset: Asset; close: () => void }) {
  const worker = useRef<Worker | null>(null);
  const request = useRef(0);
  const exportUrl = useRef("");
  const renderedRequest = useRef(0);
  const currentBitmap = useRef<ImageBitmap | null>(null);
  const inFlight = useRef<"decode" | "export" | null>(null);
  const pending = useRef<{ type: "decode" | "export"; id: number; options: TankOptions } | null>(null);
  const exportRequested = useRef(false);
  const [options, setOptions] = useState<TankOptions>({ ...tankDefaults });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [preset, setPreset] = useState(false);
  const [compare, setCompare] = useState(false);
  const [original, setOriginal] = useState("");
  const [result, setResult] = useState<{ pixels?: ImageData; bitmap?: ImageBitmap }>();
  const [exporting, setExporting] = useState(false);
  const [engine, setEngine] = useState("");
  const [dimensions, setDimensions] = useState({ width: asset.width, height: asset.height });
  function update(patch: Partial<TankOptions>) {
    if (exportRequested.current) return;
    request.current++;
    pending.current = null;
    setOptions(value => ({ ...value, ...patch }));
    setError("");
  }
  function dispatch() {
    if (inFlight.current || !pending.current || !worker.current) return;
    inFlight.current = pending.current.type;
    worker.current.postMessage(pending.current);
    pending.current = null;
  }
  const message = useEffectEvent((event: MessageEvent) => {
    if (event.data.type === "ready") { setReady(true); return; }
    // Keep only the latest pending parameters while one full-size decode is running.
    const operation = inFlight.current;
    inFlight.current = null;
    dispatch();
    const id = event.data.id;
    if (!worker.current || id < renderedRequest.current) { event.data.bitmap?.close(); return; }
    if (event.data.type === "error") {
      if (id === request.current) {
        setError(`显形失败：${event.data.error}`);
        if (operation === "export") finishExport();
      }
      return;
    }
    if (event.data.type === "export") { void saveExport(event.data); return; }
    try {
      // Present completed frames during a drag, even while newer parameters are queued.
      renderedRequest.current = id;
      currentBitmap.current?.close();
      currentBitmap.current = event.data.bitmap || null;
      setResult(event.data.bitmap ? { bitmap: event.data.bitmap }
        : { pixels: new ImageData(event.data.pixels, event.data.width, event.data.height) });
      setEngine(event.data.engine);
    } catch (error) {
      if (id === request.current) setError(error instanceof Error ? error.message : String(error));
    }
  });
  function finishExport() {
    exportRequested.current = false;
    if (!worker.current) return;
    setExporting(false);
    if (renderedRequest.current < request.current) {
      pending.current = { type: "decode", id: request.current, options };
      dispatch();
    }
  }
  async function saveExport(data: { id: number; pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }) {
    const id = data.id;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = data.width; canvas.height = data.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器不支持图片导出");
      context.putImageData(new ImageData(data.pixels, data.width, data.height), 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG 导出失败")), "image/png"));
      canvas.width = canvas.height = 0;
      if (id !== request.current || !worker.current) return;
      const url = URL.createObjectURL(blob);
      if (exportUrl.current) URL.revokeObjectURL(exportUrl.current);
      exportUrl.current = url;
      const link = document.createElement("a");
      link.href = url;
      link.download = `${asset.name.replace(/\.[^.]+$/, "")}-显形.png`;
      link.click();
    } catch (error) {
      if (id === request.current && worker.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      finishExport();
    }
  }
  function download() {
    if (!ready || !result || error || exportRequested.current || !worker.current) return;
    exportRequested.current = true;
    setExporting(true);
    // Export the selected parameters after any running preview, without waiting for its paint.
    pending.current = { type: "export", id: request.current, options };
    dispatch();
  }
  useEffect(() => {
    const abort = new AbortController();
    let originalUrl = "";
    async function load() {
      try {
        if (asset.size > tankMaxBytes || asset.width * asset.height > tankMaxPixels) throw new Error("浏览器显形支持不超过 64 MiB、1600 万像素的图片；原件仍可正常下载。");
        const response = await fetch(asset.originalUrl, { credentials: "same-origin", signal: abort.signal });
        if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录" : "原图加载失败");
        if (!response.body) throw new Error("浏览器不支持读取原图");
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > tankMaxBytes) { await reader.cancel(); throw new Error("原图超过浏览器显形的 64 MiB 限制"); }
          chunks.push(value);
        }
        const blob = new Blob(chunks, { type: asset.mime });
        const metadata = readTankPreset(await blob.arrayBuffer());
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        try {
          if (abort.signal.aborted) return;
          if (bitmap.width * bitmap.height > tankMaxPixels) throw new Error("原图超过浏览器显形的 1600 万像素限制");
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("浏览器不支持图片显形");
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
          canvas.width = canvas.height = 0;
          setDimensions({ width: bitmap.width, height: bitmap.height });
          if (metadata) { setOptions(value => ({ ...value, ...metadata })); setPreset(true); }
          originalUrl = URL.createObjectURL(blob);
          setOriginal(originalUrl);
          const instance = new Worker(new URL("./tank-decode.worker.ts", import.meta.url), { type: "module" });
          worker.current = instance;
          instance.onmessage = message;
          instance.onerror = () => { setError("显形处理器启动失败，请关闭后重试"); setReady(false); exportRequested.current = false; setExporting(false); };
          instance.postMessage({ type: "init", width: bitmap.width, height: bitmap.height, pixels }, [pixels.buffer]);
        } finally { bitmap.close(); }
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      }
    }
    void load();
    return () => {
      abort.abort(); request.current++;
      worker.current?.terminate(); worker.current = null;
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      if (exportUrl.current) URL.revokeObjectURL(exportUrl.current);
      currentBitmap.current?.close();
    };
  }, [asset.id]);
  useEffect(() => {
    if (!ready || exportRequested.current) return;
    const id = ++request.current;
    pending.current = { type: "decode", id, options };
    const frame = window.requestAnimationFrame(dispatch);
    return () => window.cancelAnimationFrame(frame);
  }, [ready, options]);
  const viewingAsset = { ...asset, ...dimensions, hasAlpha: compare ? asset.hasAlpha : options.mode === "prism", previewUrl: original || asset.previewUrl };
  return <Dialog title="坦克显形" close={close} wide>
    <div className="tank-decoder">
      <div className="tank-preview">
        <ImageViewer asset={viewingAsset} sourceOverride={original || undefined} pixels={compare ? undefined : result?.pixels} bitmap={compare ? undefined : result?.bitmap} />
        <div className="tank-preview-status" role="status">{compare ? "原图" : result ? `快速预览 · 浏览器 ${engine}` : error ? "原图" : <><RotateCw size={12} className="spin" />{ready ? "正在生成预览" : "正在读取原图"}</>}</div>
      </div>
      <div className="tank-controls">
        <p className="form-help">在本机浏览器中读取原件并显形，不向第三方发送图片，也不修改素材。</p>
        <label>显形方式<select value={options.mode} disabled={!ready || exporting} onChange={event => update({ mode: event.target.value as TankOptions["mode"] })}><option value="prism">光棱坦克（Prism 色阶）</option><option value="black">幻影坦克（黑底）</option><option value="white">幻影坦克（白底）</option></select></label>
        {options.mode === "prism" ? <>
          <p className="form-help">{preset ? "已读取图片内的 Prism 显形参数。" : "未找到显形参数，先使用 0–24 色阶；可手动调整。"}</p>
          <label>色阶下限 <span className="tank-value">{options.lower}</span><input type="range" min={0} max={options.upper - 1} value={options.lower} disabled={!ready || exporting} onInput={event => update({ lower: Number(event.currentTarget.value) })} /></label>
          <label>色阶上限 <span className="tank-value">{options.upper}</span><input type="range" min={options.lower + 1} max={255} value={options.upper} disabled={!ready || exporting} onInput={event => update({ upper: Number(event.currentTarget.value) })} /></label>
          <label>表图填充<select value={options.fill} disabled={!ready || exporting} onChange={event => update({ fill: event.target.value as TankOptions["fill"] })}><option value="ltavg">邻域填充</option><option value="black">黑色</option><option value="white">白色</option><option value="transparent">透明</option><option value="lcopy">复制左侧像素</option><option value="tcopy">复制上方像素</option></select></label>
          {options.fill === "ltavg" && <label>填充轮数 <span className="tank-value">{options.iterations}</span><input type="range" min={0} max={32} value={options.iterations} disabled={!ready || exporting} onInput={event => update({ iterations: Number(event.currentTarget.value) })} /></label>}
        </> : <p className="form-help">用纯{options.mode === "black" ? "黑" : "白"}色合成透明像素，查看传统幻影坦克的另一幅图。</p>}
        <label>对比度 <span className="tank-value">{Math.round(options.contrast)}</span><input type="range" min={-255} max={255} value={options.contrast} disabled={!ready || exporting} onInput={event => update({ contrast: Number(event.currentTarget.value) })} /></label>
        <div className="tank-buttons"><button className="button" disabled={!original} aria-pressed={compare} onClick={() => setCompare(!compare)}>{compare ? "查看显形" : "对比原图"}</button><button className="button subtle" disabled={!ready || exporting} onClick={() => update({ ...tankDefaults })}>重置参数</button></div>
        {engine === "CPU" && options.mode === "prism" && options.fill === "ltavg" && <p className="form-help">当前使用 CPU 兼容填充：逐像素平均左上邻域，不使用填充轮数。</p>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <p className="form-help">仅处理静态位图，最多 64 MiB / 1600 万像素。压缩或缩放过的图片可能无法恢复里图。</p>
        <p className="form-help">快速预览最长边 {tankPreviewEdge} 像素；下载仍使用原图完整分辨率。</p>
        <button className="button primary" disabled={!ready || !result || !!error || exporting} onClick={() => void download()}>{exporting ? <RotateCw size={15} className="spin" /> : <Download size={15} />}{exporting ? "正在导出 PNG" : "下载显形 PNG"}</button>
        <a className="tank-credit" href="https://prism.uyanide.com/" target="_blank" rel="noreferrer">算法来源：Prism / Uyanide</a>
        <a className="tank-credit" href={`data:text/plain;charset=utf-8,${encodeURIComponent(thirdPartyNotices)}`} download="Curio-Third-Party-Notices.txt">MIT 开源许可</a>
      </div>
    </div>
  </Dialog>;
}
