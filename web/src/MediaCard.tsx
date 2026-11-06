import { useEffect, useState } from "react";
import { Check, CircleAlert, EyeOff, Folder, Image, Layers3, RotateCw, Star, Tag, Video } from "lucide-react";
import { Asset, duration } from "./api";
import { kindNames } from "./components";

export function MediaCard({ asset, tagId, collectionId, selected, selecting, active = true, loading = "lazy", open, select }: { asset: Asset; tagId: string; collectionId: string; selected: boolean; selecting: boolean; active?: boolean; loading?: "lazy" | "eager"; open: (event: React.MouseEvent) => void; select: (range: boolean) => void }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.thumbnailUrl, asset.status]);
  useEffect(() => { if (!active) setHover(false); }, [active]);
  const src = active && hover && asset.kind === "animation" && asset.size < 30 * 1024 * 1024 ? asset.previewUrl || asset.thumbnailUrl : asset.thumbnailUrl;
  const otherCollections = tagId || collectionId ? asset.collections.filter(collection => collection.id !== collectionId) : [];
  const otherTags = tagId || collectionId ? asset.tags.filter(tag => tag.id !== tagId) : [];
  return <article className={`media-card ${selected ? "selected" : ""} ${asset.hasAlpha ? "has-alpha" : ""}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <button className="media-open" onClick={open} style={{ aspectRatio: asset.width && asset.height ? Math.min(2.3, Math.max(0.45, asset.width / asset.height)) : 1 }} aria-label={`查看 ${asset.title || asset.name}`}>
      {src && !failed ? <img src={src} alt={asset.title || asset.name} loading={loading} decoding={loading === "eager" ? "sync" : "async"} onError={() => { if (src !== asset.thumbnailUrl) setHover(false); else setFailed(true); }} /> : <div className="media-placeholder">{asset.status === "error" ? <CircleAlert size={27} /> : asset.kind === "video" ? <Video size={30} /> : <Image size={30} strokeWidth={1.3} />}<span>{asset.status === "error" ? "预览失败" : asset.status === "ready" ? kindNames[asset.kind] : "预览准备中"}</span></div>}
      <div className="media-shade" />
      {(asset.kind !== "image" || asset.status !== "ready") && <span className="media-kind">{asset.kind === "video" ? <Video size={11} /> : asset.kind === "animation" ? <Layers3 size={11} /> : <RotateCw size={11} />}{asset.kind === "video" && asset.duration > 0 ? duration(asset.duration) : asset.kind === "animation" ? "动图" : asset.status === "error" ? "失败" : "处理中"}</span>}
      {asset.starred && <span className="media-star"><Star size={13} fill="currentColor" /></span>}
    </button>
    <button className={`select-media ${selected ? "checked" : ""} ${selecting ? "show" : ""}`} aria-label={selected ? "取消选择" : "选择素材"} aria-pressed={selected} onClick={event => select(event.shiftKey)}>{selected && <Check size={13} />}</button>
    <div className="media-caption"><span title={asset.title || asset.name}>{asset.title || asset.name}</span>{asset.effectiveHidden && <EyeOff size={11} />}</div>
    {!!(otherCollections.length || otherTags.length) && <div className="media-memberships" aria-label="其他收藏集和标签">
      {otherCollections.map(collection => <span className="media-membership collection" key={collection.id} title={`收藏集：${collection.name}`}><Folder size={10} /><span>{collection.name}</span></span>)}
      {otherTags.map(tag => <span className="media-membership tag" key={tag.id} title={`标签：${tag.name}`}><Tag size={10} /><span>{tag.name}</span></span>)}
    </div>}
  </article>;
}
