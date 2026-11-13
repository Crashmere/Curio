import { useEffect, useEffectEvent, useState } from "react";
import { Check, CircleAlert, EyeOff, Folder, Image, Layers3, RotateCw, Star, Video } from "lucide-react";
import { Asset, captureLabel, duration, Entity, gameLabel } from "./api";
import { kindNames } from "./components";
import { TagChip } from "./TagChip";

export function MediaCard({ asset, tagId, collectionId, selected, selecting, active = true, loading = "lazy", retryKey = 0, open, select, tagDragKey, tagBusy, changeTag }: { asset: Asset; tagId: string; collectionId: string; selected: boolean; selecting: boolean; active?: boolean; loading?: "lazy" | "eager"; retryKey?: number; open: (event: React.MouseEvent) => void; select: (range: boolean) => void; tagDragKey: string; tagBusy: boolean; changeTag: (assetId: string, tag: Entity, remove: boolean) => void }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryStamp, setRetryStamp] = useState(0);
  function retryThumbnail() { if (failed) { setHover(false); setFailed(false); setRetryStamp(value => value + 1); } }
  const retry = useEffectEvent(retryThumbnail);
  useEffect(() => { setFailed(false); setRetryStamp(0); }, [asset.thumbnailUrl, asset.status]);
  useEffect(() => { retry(); }, [retryKey]);
  useEffect(() => {
    const online = () => retry();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  useEffect(() => { if (!active) setHover(false); }, [active]);
  const animationPreview = active && hover && asset.kind === "animation" && asset.size < 30 * 1024 * 1024 && !!asset.previewUrl;
  const thumbnail = asset.thumbnailUrl && retryStamp ? `${asset.thumbnailUrl}${asset.thumbnailUrl.includes("?") ? "&" : "?"}retry=${retryStamp}` : asset.thumbnailUrl;
  const src = animationPreview ? asset.previewUrl : thumbnail;
  const otherCollections = tagId || collectionId ? asset.collections.filter(collection => collection.id !== collectionId) : [];
  const otherTags = asset.tags.filter(tag => tag.id !== tagId);
  return <article data-asset={asset.id} data-tag-drop-asset={active && !tagBusy ? asset.id : undefined} className={`media-card ${selected ? "selected" : ""} ${asset.hasAlpha ? "has-alpha" : ""}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <button className="media-open" onClick={open} style={{ aspectRatio: asset.width && asset.height ? Math.min(2.3, Math.max(0.45, asset.width / asset.height)) : 1 }} aria-label={`查看 ${asset.title || asset.name}`}>
      {src && !failed ? <img src={src} alt={asset.title || asset.name} loading={loading} decoding={loading === "eager" ? "sync" : "async"} onError={() => { if (animationPreview) setHover(false); else setFailed(true); }} /> : <div className="media-placeholder">{asset.status === "error" ? <CircleAlert size={27} /> : asset.kind === "video" ? <Video size={30} /> : <Image size={30} strokeWidth={1.3} />}<span>{failed ? "缩略图加载失败" : asset.status === "error" ? "预览失败" : asset.status === "ready" ? kindNames[asset.kind] : "预览准备中"}</span></div>}
      <div className="media-shade" />
      {(asset.kind !== "image" || asset.status !== "ready") && <span className="media-kind">{asset.kind === "video" ? <Video size={11} /> : asset.kind === "animation" ? <Layers3 size={11} /> : <RotateCw size={11} />}{asset.kind === "video" && asset.duration > 0 ? duration(asset.duration) : asset.kind === "animation" ? "动图" : asset.status === "error" ? "失败" : "处理中"}</span>}
      {asset.starred && <span className="media-star"><Star size={13} fill="currentColor" /></span>}
    </button>
    {failed && <button type="button" className="button subtle media-thumbnail-retry" aria-label={`重新加载 ${asset.title || asset.name} 的缩略图`} onClick={event => { event.stopPropagation(); retryThumbnail(); }}><RotateCw size={14} />重新加载</button>}
    <button className={`select-media ${selected ? "checked" : ""} ${selecting ? "show" : ""}`} aria-label={selected ? "取消选择" : "选择素材"} aria-pressed={selected} onClick={event => select(event.shiftKey)}>{selected && <Check size={13} />}</button>
    <div className="media-caption"><span title={asset.title || asset.name}>{asset.title || asset.name}</span>{asset.effectiveHidden && <EyeOff size={11} />}</div>
    {asset.screenshot && <div className="screenshot-caption"><span>{asset.game ? gameLabel(asset.game) : "未指定游戏"}</span><time>{captureLabel(asset.capturedAt)}</time></div>}
    {!!(otherCollections.length || otherTags.length) && <div className="media-memberships" aria-label="收藏集和标签">
      {otherCollections.map(collection => <span className="media-membership collection" key={collection.id} title={`收藏集：${collection.name}`}><Folder size={10} /><span>{collection.name}</span></span>)}
      {otherTags.map(tag => <TagChip className="media-membership tag" key={tag.id} tag={tag} assetId={asset.id} cancelKey={tagDragKey} disabled={tagBusy || !active} change={changeTag} />)}
    </div>}
  </article>;
}
