import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Download, RotateCw } from "lucide-react";
import { Asset } from "./api";
import { Dialog } from "./components";
import { ImageViewer } from "./ImageViewer";
import { readTankPreset, tankDefaults, tankMaxBytes, tankMaxPixels, TankOptions } from "./tank-decode";
import thirdPartyNotices from "../../docs/THIRD_PARTY_NOTICES.md?raw";

export function canDecodeTank(asset: Asset) {
  return asset.kind === "image" && asset.mime !== "image/svg+xml" && !!asset.originalUrl && asset.width > 0 && asset.height > 0
    && /^(jpe?g|png|webp|avif|bmp|ico)$/.test((asset.format || asset.name.split(".").pop() || "").toLowerCase());
}

export function TankDecoder({ asset, close }: { asset: Asset; close: () => void }) {
  const worker = useRef<Worker | null>(null);
  const request = useRef(0);
  const currentUrl = useRef("");
  const inFlight = useRef(false);
  const pending = useRef<{ id: number; options: TankOptions } | null>(null);
  const [options, setOptions] = useState<TankOptions>({ ...tankDefaults });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [preset, setPreset] = useState(false);
  const [compare, setCompare] = useState(false);
  const [original, setOriginal] = useState("");
  const [result, setResult] = useState("");
  const [engine, setEngine] = useState("");
  const [dimensions, setDimensions] = useState({ width: asset.width, height: asset.height });
  function update(patch: Partial<TankOptions>) {
    request.current++;
    pending.current = null;
    setOptions(value => ({ ...value, ...patch }));
    setBusy(true); setError("");
  }
  function dispatch() {
    if (inFlight.current || !pending.current || !worker.current) return;
    inFlight.current = true;
    worker.current.postMessage({ type: "decode", ...pending.current });
    pending.current = null;
  }
  const message = useEffectEvent(async (event: MessageEvent) => {
    if (event.data.type === "ready") { setReady(true); return; }
    // Keep only the latest pending parameters while one full-size decode is running.
    inFlight.current = false;
    dispatch();
    const id = event.data.id;
    if (id !== request.current) return;
    if (event.data.type === "error") { setError(`显形失败：${event.data.error}`); setBusy(false); return; }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = dimensions.width; canvas.height = dimensions.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器不支持图片导出");
      context.putImageData(new ImageData(event.data.pixels, canvas.width, canvas.height), 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG 导出失败")), "image/png"));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.src = url;
      try { await image.decode(); } catch (error) { URL.revokeObjectURL(url); throw error; }
      if (id !== request.current) { URL.revokeObjectURL(url); return; }
      const previous = currentUrl.current;
      currentUrl.current = url;
      setResult(url); setEngine(event.data.engine); setBusy(false);
      if (previous) URL.revokeObjectURL(previous);
    } catch (error) {
      if (id === request.current) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
    }
  });
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
          instance.onerror = () => { setError("显形处理器启动失败，请关闭后重试"); setBusy(false); setReady(false); };
          instance.postMessage({ type: "init", width: bitmap.width, height: bitmap.height, pixels }, [pixels.buffer]);
        } finally { bitmap.close(); }
      } catch (error) {
        if (!abort.signal.aborted) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
      }
    }
    void load();
    return () => {
      abort.abort(); request.current++;
      worker.current?.terminate(); worker.current = null;
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    };
  }, [asset.id]);
  useEffect(() => {
    if (!ready) return;
    const id = ++request.current;
    setBusy(true);
    const timer = window.setTimeout(() => { pending.current = { id, options }; dispatch(); }, 120);
    return () => window.clearTimeout(timer);
  }, [ready, options]);
  const viewingAsset = { ...asset, ...dimensions, hasAlpha: compare ? asset.hasAlpha : options.mode === "prism", previewUrl: original || asset.previewUrl };
  return <Dialog title="坦克显形" close={close} wide>
    <div className="tank-decoder">
      <div className="tank-preview">
        <ImageViewer asset={viewingAsset} sourceOverride={compare ? original || undefined : result || original || undefined} />
        <div className="tank-preview-status" role="status">{compare ? "原图" : busy ? <><RotateCw size={12} className="spin" />{ready ? "正在显形" : "正在读取原图"}</> : result ? `显形结果 · 浏览器 ${engine}` : "原图"}</div>
      </div>
      <div className="tank-controls">
        <p className="form-help">在本机浏览器中读取原件并显形，不向第三方发送图片，也不修改素材。</p>
        <label>显形方式<select value={options.mode} disabled={!ready} onChange={event => update({ mode: event.target.value as TankOptions["mode"] })}><option value="prism">光棱坦克（Prism 色阶）</option><option value="black">幻影坦克（黑底）</option><option value="white">幻影坦克（白底）</option></select></label>
        {options.mode === "prism" ? <>
          <p className="form-help">{preset ? "已读取图片内的 Prism 显形参数。" : "未找到显形参数，先使用 0–24 色阶；可手动调整。"}</p>
          <label>色阶下限 <span className="tank-value">{options.lower}</span><input type="range" min={0} max={options.upper - 1} value={options.lower} disabled={!ready} onChange={event => update({ lower: Number(event.target.value) })} /></label>
          <label>色阶上限 <span className="tank-value">{options.upper}</span><input type="range" min={options.lower + 1} max={255} value={options.upper} disabled={!ready} onChange={event => update({ upper: Number(event.target.value) })} /></label>
          <label>表图填充<select value={options.fill} disabled={!ready} onChange={event => update({ fill: event.target.value as TankOptions["fill"] })}><option value="ltavg">邻域填充</option><option value="black">黑色</option><option value="white">白色</option><option value="transparent">透明</option><option value="lcopy">复制左侧像素</option><option value="tcopy">复制上方像素</option></select></label>
          {options.fill === "ltavg" && <label>填充轮数 <span className="tank-value">{options.iterations}</span><input type="range" min={0} max={32} value={options.iterations} disabled={!ready} onChange={event => update({ iterations: Number(event.target.value) })} /></label>}
        </> : <p className="form-help">用纯{options.mode === "black" ? "黑" : "白"}色合成透明像素，查看传统幻影坦克的另一幅图。</p>}
        <label>对比度 <span className="tank-value">{Math.round(options.contrast)}</span><input type="range" min={-255} max={255} value={options.contrast} disabled={!ready} onChange={event => update({ contrast: Number(event.target.value) })} /></label>
        <div className="tank-buttons"><button className="button" disabled={!original} aria-pressed={compare} onClick={() => setCompare(!compare)}>{compare ? "查看显形" : "对比原图"}</button><button className="button subtle" disabled={!ready} onClick={() => update({ ...tankDefaults })}>重置参数</button></div>
        {engine === "CPU" && options.mode === "prism" && options.fill === "ltavg" && <p className="form-help">当前使用 CPU 兼容填充：逐像素平均左上邻域，不使用填充轮数。</p>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <p className="form-help">仅处理静态位图，最多 64 MiB / 1600 万像素。压缩或缩放过的图片可能无法恢复里图。</p>
        <a className={`button primary ${!result || busy || error ? "is-disabled" : ""}`} aria-disabled={!result || busy || !!error} href={result && !busy && !error ? result : undefined} download={`${asset.name.replace(/\.[^.]+$/, "")}-显形.png`} onClick={event => { if (!result || busy || error) event.preventDefault(); }}><Download size={15} />下载显形 PNG</a>
        <a className="tank-credit" href="https://prism.uyanide.com/" target="_blank" rel="noreferrer">算法来源：Prism / Uyanide</a>
        <a className="tank-credit" href={`data:text/plain;charset=utf-8,${encodeURIComponent(thirdPartyNotices)}`} download="Curio-Third-Party-Notices.txt">MIT 开源许可</a>
      </div>
    </div>
  </Dialog>;
}
