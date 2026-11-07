import { useEffect, useEffectEvent, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, EyeOff, Info, Pencil, Plus, RotateCw, Star, Trash2, X } from "lucide-react";
import { api, Asset, bytes, duration, Entity, Patch, Scope, scoped } from "./api";
import { Dialog, isTextInput, kindNames, stateNames } from "./components";
import { VideoPlayer } from "./VideoPlayer";
import { ImageViewer } from "./ImageViewer";
import { TagChip } from "./TagChip";

type Props = { asset: Asset; scope: Scope; tags: Entity[]; collections: Entity[]; close: () => void; previous?: () => void; next?: () => void; changed: () => void; notify: (text: string) => void; tagDragKey: string; tagBusy: boolean; changeTag: (assetId: string, tag: Entity, remove: boolean) => void };
export function Viewer({ asset, scope, tags, collections, close, previous, next, changed, notify, tagDragKey, tagBusy, changeTag }: Props) {
  const [details, setDetails] = useState(true);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEdit(false); }, [asset.id]);
  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || isTextInput(event.target) || edit) return;
    if (event.key === "Escape") close();
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
  async function copyImage() {
    try {
      const promise = fetch(asset.previewUrl, { credentials: "same-origin" }).then(response => response.blob()).then(blob => new Promise<Blob>((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(blob);
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          canvas.getContext("2d")?.drawImage(image, 0, 0);
          URL.revokeObjectURL(url);
          canvas.toBlob(result => result ? resolve(result) : reject(new Error("无法复制此图片")), "image/png");
        };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片尚未准备好")); };
        image.src = url;
      }));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": promise })]);
      notify("图片已复制");
    } catch (error) { notify(error instanceof Error ? error.message : "浏览器不支持复制此图片，请下载原件"); }
  }
  const image = asset.kind !== "video";
  return <div className="viewer" role="dialog" aria-modal="true" aria-label={asset.title || asset.name}>
    <header className="viewer-heading"><button className="icon-button" aria-label="关闭预览" onClick={close}><X size={21} /></button><div className="viewer-name"><strong>{asset.title || asset.name}</strong><span>{kindNames[asset.kind]}{asset.effectiveHidden && <> · <EyeOff size={11} /> 隐藏</>}</span></div><div className="viewer-actions"><button className={`icon-button ${asset.starred ? "is-active" : ""}`} title={asset.starred ? "取消星标" : "添加星标"} aria-label={asset.starred ? "取消星标" : "添加星标"} disabled={busy} onClick={() => void update({ starred: !asset.starred })}><Star size={18} fill={asset.starred ? "currentColor" : "none"} /></button><a className="icon-button" title="下载原件" aria-label="下载原件" href={asset.downloadUrl} download><Download size={18} /></a><button className={`icon-button ${details ? "is-active" : ""}`} title="素材信息" aria-label="素材信息" onClick={() => setDetails(!details)}><Info size={18} /></button></div></header>
    <div className={`viewer-body ${details ? "with-details" : ""}`}>
      <div className="viewer-canvas">
        {image ? <ImageViewer key={asset.id} asset={asset} /> : <div className="media-stage dark"><VideoPlayer key={asset.id} asset={asset} /></div>}
        {previous && <button className="viewer-step previous" aria-label="上一项" onClick={previous}><ChevronLeft size={23} /></button>}{next && <button className="viewer-step next" aria-label="下一项" onClick={next}><ChevronRight size={23} /></button>}
      </div>
      {details && <aside className="viewer-details"><div className="details-title"><h2>素材信息</h2><button className="button subtle" onClick={() => setEdit(true)}><Pencil size={14} />编辑</button></div><dl className="metadata-grid"><dt>原文件名</dt><dd>{asset.name}</dd><dt>格式</dt><dd>{asset.mime || asset.name.split(".").pop()?.toUpperCase()}</dd><dt>尺寸</dt><dd>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "读取中"}</dd><dt>大小</dt><dd>{bytes(asset.size)}</dd>{asset.duration > 0 && <><dt>时长</dt><dd>{duration(asset.duration)}</dd></>}<dt>收集时间</dt><dd>{new Date(asset.createdAt).toLocaleString("zh-CN", { hour12: false })}</dd><dt>处理状态</dt><dd>{stateNames[asset.status] || asset.status}</dd></dl>
        {asset.error && <div className="inline-error">{asset.error}<button className="button subtle" onClick={() => void api("assets/retry", { ids: [asset.id] }).then(changed).catch(error => notify(error.message))}><RotateCw size={14} />重试处理</button></div>}
        {!!asset.tags?.length && <div className="details-section"><h3>标签</h3><div className="entity-chips">{asset.tags.map(tag => <TagChip key={tag.id} tag={tag} assetId={asset.id} className="detail-tag" cancelKey={`${tagDragKey}:${edit}`} disabled={tagBusy || busy} change={changeTag} />)}</div></div>}
        {!!asset.collections?.length && <div className="details-section"><h3>收藏集</h3><div className="entity-chips">{asset.collections.map(collection => <span key={collection.id}>{collection.name}</span>)}</div></div>}
        {(asset.author || asset.sourceUrl || asset.notes) && <div className="details-section"><h3>来源与备注</h3>{asset.author && <p>{asset.author}</p>}{asset.sourceUrl && <a className="source-link" href={asset.sourceUrl} target="_blank" rel="noreferrer">{asset.sourceUrl}</a>}{asset.notes && <p className="notes">{asset.notes}</p>}</div>}
        {asset.effectiveHidden && <div className="details-section hidden-reasons"><h3><EyeOff size={13} />隐藏原因</h3>{asset.hiddenReasons?.map(reason => <p key={`${reason.kind}-${reason.id}`}>{reason.kind === "media" ? "素材单独隐藏" : `${reason.kind === "tag" ? "标签" : "收藏集"}：${reason.name}`}</p>)}</div>}
        <div className="details-bottom">{asset.kind === "image" && asset.previewUrl && <button className="button" onClick={() => void copyImage()}><Copy size={15} />复制图片</button>}<button className="button danger subtle" disabled={busy} onClick={() => void update({ trash: !asset.trashedAt })}>{asset.trashedAt ? <RotateCw size={15} /> : <Trash2 size={15} />}{asset.trashedAt ? "恢复素材" : "移入回收站"}</button></div>
      </aside>}
    </div>
    {edit && <MetadataEditor asset={asset} scope={scope} tags={tags} collections={collections} close={() => setEdit(false)} saved={() => { setEdit(false); changed(); }} notify={notify} />}
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
  const [newTag, setNewTag] = useState("");
  const [localTags, setLocalTags] = useState<Entity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allTags = [...tags, ...(asset.tags || []).filter(item => !tags.some(tag => tag.id === item.id)), ...localTags.filter(item => !tags.some(tag => tag.id === item.id) && !asset.tags?.some(tag => tag.id === item.id))];
  const allCollections = [...collections, ...(asset.collections || []).filter(item => !collections.some(collection => collection.id === item.id))];
  function toggle(id: string, ids: string[], setter: (next: string[]) => void) { setter(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]); }
  async function createTag() {
    if (!newTag.trim() || busy) return;
    setBusy(true); setError("");
    try { const tag = await api<Entity>("tags", { name: newTag.trim(), hidden: scope === "hidden" }); setLocalTags([...localTags, tag]); setTagIds([...tagIds.filter(id => id !== tag.id), tag.id]); setNewTag(""); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try { await api(scoped(`assets/${asset.id}`, scope), { title, author, sourceUrl, notes, hidden, tagIds, collectionIds }, "PATCH"); notify("素材信息已保存"); saved(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title="编辑素材" close={close} wide><form onSubmit={event => { event.preventDefault(); void save(); }} className="metadata-form"><label>标题<input value={title} placeholder={asset.name} onChange={event => setTitle(event.target.value)} maxLength={500} /></label><div className="form-columns"><label>作者<input value={author} onChange={event => setAuthor(event.target.value)} maxLength={500} /></label><label>来源链接<input type="url" value={sourceUrl} placeholder="https://" onChange={event => setSourceUrl(event.target.value)} /></label></div><label>备注<textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} maxLength={10000} /></label><div className="form-section"><h3>标签</h3><div className="choice-chips">{allTags.map(tag => <button type="button" className={tagIds.includes(tag.id) ? "selected" : ""} key={tag.id} onClick={() => toggle(tag.id, tagIds, setTagIds)}>{tagIds.includes(tag.id) && <Check size={12} />}{tag.name}</button>)}</div><div className="inline-create"><input value={newTag} placeholder="新标签" onChange={event => setNewTag(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void createTag(); } }} /><button type="button" className="button" disabled={!newTag.trim() || busy} onClick={() => void createTag()}><Plus size={14} />添加</button></div></div><div className="form-section"><h3>收藏集</h3>{allCollections.length ? <div className="choice-chips">{allCollections.map(collection => <button type="button" className={collectionIds.includes(collection.id) ? "selected" : ""} key={collection.id} onClick={() => toggle(collection.id, collectionIds, setCollectionIds)}>{collectionIds.includes(collection.id) && <Check size={12} />}{collection.name}</button>)}</div> : <p className="muted">可以先在收藏集页面创建一个收藏集。</p>}</div><div className="form-switches"><label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />单独隐藏此素材</label></div>{asset.hiddenReasons?.some(reason => reason.kind !== "media") && <p className="form-help">此素材也继承了标签或收藏集的隐藏状态。取消单独隐藏不会解除这些来源。</p>}{error && <div className="inline-error">{error}</div>}<footer className="dialog-footer"><button type="button" className="button" onClick={close}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? <RotateCw size={15} className="spin" /> : <Check size={15} />}保存</button></footer></form></Dialog>;
}
