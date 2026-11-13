import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, EyeOff, Gamepad2, Info, Pencil, RotateCw, ScanEye, Star, Trash2, X } from "lucide-react";
import { api, Asset, bytes, captureLabel, duration, Entity, Game, gameLabel, Patch, Scope, scoped, supportsGameMedia } from "./api";
import { ScreenshotEditor } from "./Games";
import { Dialog, isTextInput, kindNames, stateNames } from "./components";
import { EntityPicker } from "./EntityPicker";
import { VideoPlayer } from "./VideoPlayer";
import { ImageViewer } from "./ImageViewer";
import { TagChip } from "./TagChip";
import { canDecodeTank, TankDecoder } from "./TankDecoder";
import { useCompactViewer, useViewerControls } from "./viewer-interactions";

type Props = { asset: Asset; scope: Scope; tags: Entity[]; collections: Entity[]; games: Game[]; close: () => void; previous?: () => void; next?: () => void; changed: () => void; notify: (text: string) => void; tagDragKey: string; tagBusy: boolean; changeTag: (assetId: string, tag: Entity, remove: boolean) => void };
const originalCopyBytes = 32 * 1024 * 1024;
const originalCopyPixels = 40_000_000;

async function clipboardPNG(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error("图片暂不可用，请重试或下载原件");
  const blob = await response.blob();
  signal.throwIfAborted();
  return new Promise<Blob>((resolve, reject) => {
    const image = new Image();
    const objectURL = URL.createObjectURL(blob);
    const cleanup = () => { URL.revokeObjectURL(objectURL); image.onload = null; image.onerror = null; signal.removeEventListener("abort", abort); };
    const abort = () => { image.src = ""; cleanup(); reject(signal.reason); };
    image.onload = () => {
      try {
        signal.throwIfAborted();
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > originalCopyPixels) throw new Error("图片尺寸过大，请下载原件使用");
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器无法复制此图片，请下载原件");
        context.drawImage(image, 0, 0);
        cleanup();
        canvas.toBlob(result => {
          canvas.width = 0; canvas.height = 0;
          if (signal.aborted) reject(signal.reason);
          else if (result) resolve(result);
          else reject(new Error("无法复制此图片，请下载原件"));
        }, "image/png");
      } catch (error) { cleanup(); reject(error); }
    };
    image.onerror = () => { cleanup(); reject(new Error("浏览器无法读取此图片，请复制预览图或下载原件")); };
    signal.addEventListener("abort", abort, { once: true });
    image.src = objectURL;
  });
}

export function Viewer({ asset, scope, tags, collections, games, close, previous, next, changed, notify, tagDragKey, tagBusy, changeTag }: Props) {
  const compact = useCompactViewer();
  const [details, setDetails] = useState(!compact);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tank, setTank] = useState(false);
  const [screenshotEdit, setScreenshotEdit] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyController = useRef<AbortController | null>(null);
  const controls = useViewerControls(playing, details || waiting || edit || tank || screenshotEdit);
  const format = (asset.format || asset.name.split(".").pop() || "").toLowerCase();
  const gameMedia = supportsGameMedia(asset);
  const canCopyOriginal = asset.kind === "image" && /^(jpe?g|png|webp|avif|gif|bmp|ico|apng)$/.test(format) && asset.mime !== "image/svg+xml" && !!asset.originalUrl
    && asset.size <= originalCopyBytes && asset.width > 0 && asset.height > 0 && asset.width * asset.height <= originalCopyPixels;
  useEffect(() => { setCopying(false); return () => { copyController.current?.abort(); copyController.current = null; }; }, [asset.id]);
  useEffect(() => { setEdit(false); setTank(false); setScreenshotEdit(false); setPlaying(false); setWaiting(false); controls.reveal(); }, [asset.id]);
  useEffect(() => { if (!gameMedia) setScreenshotEdit(false); }, [gameMedia]);
  useEffect(() => { if (compact) setDetails(false); }, [compact]);
  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || isTextInput(event.target) || edit || tank || screenshotEdit) return;
    if (event.key === "Escape") { if (details && compact) setDetails(false); else close(); }
    if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") { event.preventDefault(); previous?.(); }
    if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") { event.preventDefault(); next?.(); }
  });
  useEffect(() => {
    window.addEventListener("keydown", keyboard);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", keyboard); document.body.style.overflow = before; };
  }, []);
  async function update(patch: Patch) {
    if (busy) return;
    setBusy(true);
    try { await api(scoped(`assets/${asset.id}`, scope), patch, "PATCH"); changed(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function copyImage(original = false) {
    if (copyController.current || (original && !canCopyOriginal)) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { notify("浏览器不支持复制图片，请下载原件"); return; }
    const controller = new AbortController();
    copyController.current = controller; setCopying(true);
    try {
      // Pass the pending PNG to ClipboardItem while the click still grants clipboard access.
      const promise = clipboardPNG(original ? asset.originalUrl : asset.previewUrl, controller.signal);
      void promise.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "image/png": promise })]);
      if (!controller.signal.aborted) notify(original ? "原图已复制（PNG）" : "预览图已复制（PNG）");
    } catch (error) { if (!controller.signal.aborted) { controller.abort(); notify(error instanceof Error ? error.message : "浏览器不支持复制此图片，请下载原件"); } }
    finally { if (copyController.current === controller) { copyController.current = null; setCopying(false); } }
  }
  const image = asset.kind !== "video";
  return <div className={`viewer ${compact ? "compact-viewer" : ""} ${controls.hidden ? "is-immersive" : ""}`} role="dialog" aria-modal="true" aria-label={asset.title || asset.name}
    onPointerMove={event => { if (!compact && asset.kind === "video" && event.pointerType !== "touch") controls.reveal(); }}>
    <header className="viewer-heading"><button className="icon-button" aria-label="关闭预览" onClick={close}><X size={21} /></button><div className="viewer-name"><strong>{asset.title || asset.name}</strong><span>{kindNames[asset.kind]}{asset.effectiveHidden && <> · <EyeOff size={11} /> 隐藏</>}</span></div><div className="viewer-actions">{canDecodeTank(asset) && <button className="icon-button" title="坦克显形" aria-label="坦克显形" onClick={() => setTank(true)}><ScanEye size={18} /></button>}<button className={`icon-button ${asset.starred ? "is-active" : ""}`} title={asset.starred ? "取消星标" : "添加星标"} aria-label={asset.starred ? "取消星标" : "添加星标"} disabled={busy} onClick={() => void update({ starred: !asset.starred })}><Star size={18} fill={asset.starred ? "currentColor" : "none"} /></button><a className="icon-button" title="下载原件" aria-label="下载原件" href={asset.downloadUrl} download><Download size={18} /></a><button className={`icon-button ${details ? "is-active" : ""}`} title="素材信息" aria-label="素材信息" onClick={() => setDetails(!details)}><Info size={18} /></button></div></header>
    <div className={`viewer-body ${details ? "with-details" : ""}`}>
      <div className="viewer-canvas">
        {image ? <ImageViewer key={asset.id} asset={asset} previous={previous} next={next} close={close} toggleChrome={controls.toggle} /> : <div className="media-stage dark"><VideoPlayer key={asset.id} asset={asset} compact={compact} hidden={controls.hidden} activity={controls.reveal} toggleChrome={controls.toggle} previous={previous} next={next} close={close} onPlayback={setPlaying} onWaiting={setWaiting} /></div>}
        {previous && <button className="viewer-step previous" aria-label="上一项" onClick={previous}><ChevronLeft size={23} /></button>}{next && <button className="viewer-step next" aria-label="下一项" onClick={next}><ChevronRight size={23} /></button>}
      </div>
      {details && compact && <button className="viewer-details-backdrop" aria-label="收起素材信息" onClick={() => setDetails(false)} />}
      {details && <aside className="viewer-details"><div className="details-title"><h2>素材信息</h2><button className="button subtle" onClick={() => setEdit(true)}><Pencil size={14} />编辑</button>{compact && <button className="icon-button" aria-label="收起素材信息" onClick={() => setDetails(false)}><X size={18} /></button>}</div><dl className="metadata-grid"><dt>原文件名</dt><dd>{asset.name}</dd><dt>格式</dt><dd>{asset.mime || asset.name.split(".").pop()?.toUpperCase()}</dd><dt>尺寸</dt><dd>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "读取中"}</dd><dt>大小</dt><dd>{bytes(asset.size)}</dd>{asset.duration > 0 && <><dt>时长</dt><dd>{duration(asset.duration)}</dd></>}<dt>收集时间</dt><dd>{new Date(asset.createdAt).toLocaleString("zh-CN", { hour12: false })}</dd><dt>处理状态</dt><dd>{stateNames[asset.status] || asset.status}</dd></dl>
        {asset.error && <div className="inline-error">{asset.error}<button className="button subtle" onClick={() => void api("assets/retry", { ids: [asset.id] }).then(changed).catch(error => notify(error.message))}><RotateCw size={14} />重试处理</button></div>}
        {(gameMedia || asset.screenshot) && <div className="details-section"><div className="details-title"><h3><Gamepad2 size={14} />游戏截图</h3><button className="button subtle" disabled={busy} onClick={() => gameMedia ? setScreenshotEdit(true) : void update({ screenshot: false })}>{gameMedia ? asset.screenshot ? "编辑" : "移入游戏截图" : "移出游戏截图"}</button></div>{asset.screenshot && <dl className="metadata-grid"><dt>游戏</dt><dd>{asset.game ? gameLabel(asset.game) : "未指定游戏"}</dd>{asset.game?.steamAppId && <><dt>Steam ID</dt><dd>{asset.game.steamAppId}</dd></>}<dt>{asset.kind === "video" ? "录像时间" : "截图时间"}</dt><dd>{captureLabel(asset.capturedAt)}</dd><dt>识别方式</dt><dd>{asset.screenshotSource === "steam" ? "Steam 文件名" : "手动指定"}</dd></dl>}</div>}
        {!!asset.tags?.length && <div className="details-section"><h3>标签</h3><div className="entity-chips">{asset.tags.map(tag => <TagChip key={tag.id} tag={tag} assetId={asset.id} className="detail-tag" cancelKey={`${tagDragKey}:${edit}:${screenshotEdit}`} disabled={tagBusy || busy} change={changeTag} />)}</div></div>}
        {!!asset.collections?.length && <div className="details-section"><h3>收藏集</h3><div className="entity-chips">{asset.collections.map(collection => <span key={collection.id}>{collection.name}</span>)}</div></div>}
        {(asset.author || asset.sourceUrl || asset.notes) && <div className="details-section"><h3>来源与备注</h3>{asset.author && <p>{asset.author}</p>}{asset.sourceUrl && <a className="source-link" href={asset.sourceUrl} target="_blank" rel="noreferrer">{asset.sourceUrl}</a>}{asset.notes && <p className="notes">{asset.notes}</p>}</div>}
        {asset.effectiveHidden && <div className="details-section hidden-reasons"><h3><EyeOff size={13} />隐藏原因</h3>{asset.hiddenReasons?.map(reason => <p key={`${reason.kind}-${reason.id}`}>{reason.kind === "media" ? "素材单独隐藏" : `${reason.kind === "tag" ? "标签" : "收藏集"}：${reason.name}`}</p>)}</div>}
        <div className="details-bottom">{asset.kind === "image" && asset.previewUrl && <button className="button" disabled={copying} onClick={() => void copyImage()}><Copy size={15} />复制预览图</button>}{canCopyOriginal && <button className="button" title="按原始尺寸复制为 PNG，不改动原件" disabled={copying} onClick={() => void copyImage(true)}><Copy size={15} />复制原图（PNG）</button>}<button className="button danger subtle" disabled={busy} onClick={() => void update({ trash: !asset.trashedAt })}>{asset.trashedAt ? <RotateCw size={15} /> : <Trash2 size={15} />}{asset.trashedAt ? "恢复素材" : "移入回收站"}</button></div>
      </aside>}
    </div>
    {edit && <MetadataEditor asset={asset} scope={scope} tags={tags} collections={collections} close={() => setEdit(false)} saved={() => { setEdit(false); changed(); }} notify={notify} />}
    {tank && <TankDecoder key={asset.id} asset={asset} close={() => setTank(false)} />}
    {screenshotEdit && gameMedia && <ScreenshotEditor asset={asset} count={1} games={games} scope={scope} close={() => setScreenshotEdit(false)} save={async patch => { await api(scoped(`assets/${asset.id}`, scope), patch, "PATCH"); setScreenshotEdit(false); changed(); notify("游戏截图信息已保存"); }} />}
  </div>;
}
function MetadataEditor({ asset, scope, tags, collections, close, saved, notify }: { asset: Asset; scope: Scope; tags: Entity[]; collections: Entity[]; close: () => void; saved: () => void; notify: (message: string) => void }) {
  const [title, setTitle] = useState(asset.title || "");
  const [author, setAuthor] = useState(asset.author || "");
  const [sourceUrl, setSourceUrl] = useState(asset.sourceUrl || "");
  const [notes, setNotes] = useState(asset.notes || "");
  const [hidden, setHidden] = useState(asset.hidden);
  const [tagIds, setTagIds] = useState((asset.tags || []).map(tag => tag.id));
  const [collectionIds, setCollectionIds] = useState((asset.collections || []).map(collection => collection.id));
  const [busy, setBusy] = useState(false);
  const [tagBusy, setTagBusy] = useState(false);
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [error, setError] = useState("");
  const initial = useRef({ title: asset.title || "", author: asset.author || "", sourceUrl: asset.sourceUrl || "", notes: asset.notes || "", hidden: asset.hidden, tagIds: (asset.tags || []).map(tag => tag.id), collectionIds: (asset.collections || []).map(collection => collection.id) });
  const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every(id => right.includes(id));
  const dirty = title !== initial.current.title || author !== initial.current.author || sourceUrl !== initial.current.sourceUrl || notes !== initial.current.notes || hidden !== initial.current.hidden
    || !sameIds(tagIds, initial.current.tagIds) || !sameIds(collectionIds, initial.current.collectionIds);
  const working = busy || tagBusy || collectionBusy;
  const allTags = [...tags, ...(asset.tags || []).filter(item => !tags.some(tag => tag.id === item.id))];
  const allCollections = [...collections, ...(asset.collections || []).filter(item => !collections.some(collection => collection.id === item.id))];
  async function save() {
    if (working) return;
    setBusy(true); setError("");
    try { await api(scoped(`assets/${asset.id}`, scope), { title, author, sourceUrl, notes, hidden, tagIds, collectionIds }, "PATCH"); notify("素材信息已保存"); saved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title="编辑素材" close={close} wide dirty={dirty} busy={working}><form onSubmit={event => { event.preventDefault(); void save(); }} className="metadata-form"><label>标题<input value={title} placeholder={asset.name} onChange={event => setTitle(event.target.value)} maxLength={500} disabled={working} /></label><div className="form-columns"><label>作者<input value={author} onChange={event => setAuthor(event.target.value)} maxLength={500} disabled={working} /></label><label>来源链接<input type="url" value={sourceUrl} placeholder="https://" onChange={event => setSourceUrl(event.target.value)} disabled={working} /></label></div><label>备注<textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} maxLength={10000} disabled={working} /></label><EntityPicker kind="tags" scope={scope} items={allTags} selected={tagIds} change={setTagIds} disabled={working} onBusyChange={setTagBusy} /><EntityPicker kind="collections" scope={scope} items={allCollections} selected={collectionIds} change={setCollectionIds} disabled={working} onBusyChange={setCollectionBusy} /><div className="form-switches"><label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} disabled={working} />单独隐藏此素材</label></div>{asset.hiddenReasons?.some(reason => reason.kind !== "media") && <p className="form-help">此素材也继承了标签或收藏集的隐藏状态。取消单独隐藏不会解除这些来源。</p>}{error && <div className="inline-error">{error}</div>}<footer className="dialog-footer"><button type="button" className="button" data-dialog-close disabled={working}>取消</button><button type="submit" className="button primary" disabled={working}>{working ? <RotateCw size={15} className="spin" /> : <Check size={15} />}保存</button></footer></form></Dialog>;
}
