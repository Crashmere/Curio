import { CSSProperties, ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Image, Layers3, Plus, RotateCw, Ungroup } from "lucide-react";
import { Asset, AssetPage, base, MediaGroup } from "./api";

export type GalleryEntry = { asset: Asset; group?: undefined } | { group: MediaGroup; items: Asset[]; asset?: undefined };

export function collectionEntries(assets: Asset[], groups: MediaGroup[], pages: Record<string, AssetPage>): GalleryEntry[] {
  const memberships = new Map(groups.flatMap(group => group.assetIds.map(id => [id, group] as const)));
  const members = new Map([...assets, ...Object.values(pages).flatMap(page => page.items)].map(asset => [asset.id, asset]));
  const seen = new Set<string>();
  const entries: GalleryEntry[] = [];
  for (const asset of assets) {
    const group = memberships.get(asset.id);
    if (!group) entries.push({ asset });
    else if (!seen.has(group.id)) {
      seen.add(group.id);
      const items = group.assetIds.map(id => members.get(id)).filter((item): item is Asset => !!item);
      entries.push({ group, items });
    }
  }
  return entries;
}

export function CollectionGallery({ entries, expanded, pages, pending, selected, selecting, busy, render, toggle, load, selectGroup, add, dissolve }: {
  entries: GalleryEntry[]; expanded: Set<string>; pages: Record<string, AssetPage>; pending: Set<string>;
  selected: Set<string>; selecting: boolean; busy: boolean; render: (asset: Asset) => ReactNode;
  toggle: (group: MediaGroup) => void; load: (group: MediaGroup) => void; selectGroup: (group: MediaGroup) => void;
  add: (group: MediaGroup) => void; dissolve: (group: MediaGroup) => void;
}) {
  const gallery = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const element = gallery.current!;
    const measure = () => setColumns(getComputedStyle(element).gridTemplateColumns.split(" ").length);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={gallery} className="gallery collection-gallery">{entries.map(entry => {
    if (entry.asset) return render(entry.asset);
    const { group, items } = entry;
    const open = expanded.has(group.id);
    const count = group.assetIds.length;
    const selectedCount = group.assetIds.filter(id => selected.has(id)).length;
    const page = pages[group.id];
    const canLoad = items.length < count && (!page || page.nextOffset != null);
    return <section key={group.id} className={`media-group ${open ? "expanded" : "collapsed"} ${selectedCount ? "has-selected" : ""}`} style={{ viewTransitionName: `group-${group.id}`, "--group-span": Math.min(count, columns) } as CSSProperties} aria-label={`${count} 个素材的分组`}>
      {!open && <button className="group-preview" onClick={() => toggle(group)} aria-label={`展开分组，${count} 个素材`} aria-expanded={false} aria-controls={`group-content-${group.id}`}>
        <div className="group-stack" aria-hidden="true">{group.assetIds.slice(0, 3).reverse().map((id, index, ids) => <span className="group-sheet" key={id} style={{ "--sheet": ids.length - index - 1 } as CSSProperties}><Image size={24} strokeWidth={1.2} /><img src={`${base}media/${id}/thumbnail`} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.style.opacity = "0"; }} /></span>)}</div>
        <span className="group-preview-hint">一起收藏，轻触展开</span>
      </button>}
      <div className="group-heading">
        <button className="group-toggle" onClick={() => toggle(group)} aria-expanded={open} aria-controls={`group-content-${group.id}`}><span className="group-mark"><Layers3 size={15} /></span><span className="group-count">{count}<small>个素材</small></span><span className="group-toggle-label">{open ? "收起" : "展开"}</span><ChevronDown className="group-chevron" size={15} /></button>
        <div className="group-actions">
          {selecting && <button className={`icon-button ${selectedCount === count ? "is-active" : ""}`} title={selectedCount === count ? "取消选择这组" : "选择这组"} aria-label={selectedCount === count ? "取消选择这组" : "选择这组"} aria-pressed={selectedCount === count} disabled={busy} onClick={() => selectGroup(group)}><Check size={15} /></button>}
          {!!selected.size && <button className="icon-button" title="将所选素材加入这组" aria-label="将所选素材加入这组" disabled={busy || [...selected].every(id => group.assetIds.includes(id))} onClick={() => add(group)}><Plus size={16} /></button>}
          <button className="icon-button group-dissolve" title="解散分组，保留全部素材" aria-label="解散分组" disabled={busy} onClick={() => dissolve(group)}><Ungroup size={15} /></button>
        </div>
      </div>
      {open && <div className="group-content" id={`group-content-${group.id}`}><div className="gallery group-media">{items.map((asset, index) => <div className="group-member" key={asset.id} style={{ "--reveal-delay": `${Math.min(index, 6) * 18}ms` } as CSSProperties}>{render(asset)}</div>)}</div>{canLoad && <div className="group-load"><button className="button subtle" onClick={() => load(group)} disabled={pending.has(group.id)}>{pending.has(group.id) && <RotateCw size={13} className="spin" />}{pending.has(group.id) ? "正在展开…" : page ? "加载组内更多素材" : "加载组内素材"}<span>{items.length} / {count}</span></button></div>}</div>}
    </section>;
  })}</div>;
}
