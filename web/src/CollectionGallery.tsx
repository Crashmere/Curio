import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Image, Layers3, MoreHorizontal, Pencil, Plus, RotateCw, Ungroup } from "lucide-react";
import { Asset, AssetPage, base, MediaGroup } from "./api";
import { GroupFormation, MasonryGallery } from "./MasonryGallery";

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

export function CollectionGallery({ entries, expanded, formation, selected, selecting, busy, render, toggle, selectGroup, add, rename, saveName, dissolve }: {
  entries: GalleryEntry[]; expanded: Set<string>; formation?: GroupFormation;
  selected: Set<string>; selecting: boolean; busy: boolean; render: (asset: Asset, groupOpen?: boolean) => ReactNode;
  toggle: (group: MediaGroup) => void; selectGroup: (group: MediaGroup) => void;
  add: (group: MediaGroup) => void; rename: (group: MediaGroup) => void; dissolve: (group: MediaGroup) => void;
  saveName: (group: MediaGroup, name: string) => Promise<boolean>;
}) {
  const [menu, setMenu] = useState<{ id: string; left: number; top: number }>();
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuSource = useRef<HTMLButtonElement | null>(null);
  const editingHeadingPress = useRef(new Set<string>());
  const menuGroup = entries.find(entry => entry.group?.id === menu?.id)?.group;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRoot.current?.contains(event.target) && !menuSource.current?.contains(event.target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [menu]);
  useEffect(() => { if (busy) setMenu(undefined); }, [busy]);
  return <><MasonryGallery formation={formation}>{entries.map(entry => {
    if (entry.asset) return render(entry.asset);
    const { group, items } = entry;
    const open = expanded.has(group.id);
    const count = group.assetIds.length;
    const selectedCount = group.assetIds.filter(id => selected.has(id)).length;
    const label = group.name || "未命名分组";
    return <article key={group.id} className={`media-group ${open ? "expanded" : "collapsed"} ${selectedCount ? "has-selected" : ""}`} data-group={group.id} data-span={open ? "full" : undefined} aria-label={`${label}，${count} 个素材`}>
      <button className="group-preview" hidden={open} onClick={() => toggle(group)} aria-label={`展开${label}，${count} 个素材`} aria-expanded={open} aria-controls={`group-content-${group.id}`}>
        <div className="group-stack" aria-hidden="true">{group.assetIds.slice(0, 3).reverse().map((id, index, ids) => <span className="group-sheet" key={id} style={{ "--sheet": ids.length - index - 1 } as CSSProperties}><Image size={24} strokeWidth={1.2} /><img src={`${base}media/${id}/thumbnail`} alt="" loading="eager" decoding="sync" onError={event => { event.currentTarget.style.opacity = "0"; }} /></span>)}</div>
      </button>
      <header className="group-heading">
        <div className="group-toggle group-heading-expanded" hidden={!open} onPointerDownCapture={event => {
          // Blur removes the input before click, so retain the state at pointer-down.
          if (event.currentTarget.querySelector(".group-name-input")) editingHeadingPress.current.add(group.id);
          else editingHeadingPress.current.delete(group.id);
        }} onClick={event => {
          if (editingHeadingPress.current.delete(group.id)) return;
          if (event.target instanceof Element && !event.target.closest("button, input, small, .group-name-editor, .group-name-error")) toggle(group);
        }}>
          <Layers3 size={16} /><div className="group-heading-copy group-heading-editable">
            <GroupName group={group} busy={busy} save={saveName} />
            <small>{count} 个素材{selectedCount > 0 && ` · 已选 ${selectedCount}`}</small>
          </div>
          <button className="icon-button group-fold-toggle" title="收起分组" aria-label={`收起${label}`} aria-expanded={true} aria-controls={`group-content-${group.id}`} onClick={() => toggle(group)}><ChevronDown size={14} className="group-chevron" /></button>
        </div>
        <button className="group-toggle" hidden={open} onClick={() => toggle(group)} aria-label={`展开${label}`} aria-expanded={false} aria-controls={`group-content-${group.id}`}>
          <Layers3 size={16} /><span className="group-heading-copy"><strong title={label}>{label}</strong><small>{count} 个素材{selectedCount > 0 && ` · 已选 ${selectedCount}`}</small></span><ChevronDown size={14} className="group-chevron" />
        </button>
        <div className="group-actions">
          {selecting && <button className={`icon-button group-select ${selectedCount === count ? "is-active" : ""}`} title={selectedCount === count ? "取消选择这组" : "选择这组"} aria-label={selectedCount === count ? "取消选择这组" : "选择这组"} aria-pressed={selectedCount === count} disabled={busy} onClick={() => selectGroup(group)}><Check size={16} /></button>}
          <button className="icon-button" title="分组设置" aria-label={`分组设置：${label}`} aria-haspopup="menu" aria-expanded={menu?.id === group.id} disabled={busy} onClick={event => {
            if (menu?.id === group.id) { setMenu(undefined); return; }
            menuSource.current = event.currentTarget;
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ id: group.id, left: Math.max(12, Math.min(rect.right - 240, innerWidth - 252)), top: Math.max(12, Math.min(rect.bottom + 6, innerHeight - 240)) });
          }}><MoreHorizontal size={18} /></button>
        </div>
      </header>
      <div className="group-content" id={`group-content-${group.id}`} hidden={!open}>
        <MasonryGallery className="group-gallery">{items.map(asset => render(asset, open))}</MasonryGallery>
        <button className="group-collapse" onClick={() => toggle(group)}><ChevronDown size={14} />收起分组</button>
      </div>
    </article>;
  })}</MasonryGallery>
    {menu && menuGroup && createPortal(<div ref={menuRoot} className="group-action-menu" style={{ left: menu.left, top: menu.top }} role="menu" aria-label="分组设置">
      <strong>{menuGroup.name || "未命名分组"}</strong>
      <button className="button subtle" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); rename(menuGroup); }}><Pencil size={15} />{menuGroup.name ? "修改分组名称" : "添加分组名称"}</button>
      {!!selected.size && <button className="button subtle" role="menuitem" disabled={busy || [...selected].every(id => menuGroup.assetIds.includes(id))} onClick={() => { setMenu(undefined); add(menuGroup); }}><Plus size={15} />将所选素材加入这组</button>}
      <button className="button subtle danger" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); dissolve(menuGroup); }}><Ungroup size={15} />解散分组，保留素材</button>
    </div>, document.body)}
  </>;
}

function GroupName({ group, busy, save }: { group: MediaGroup; busy: boolean; save: (group: MediaGroup, name: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  async function commit() {
    setEditing(false);
    if (cancelled.current || saving) return;
    const name = draft.trim();
    if (name === group.name) { setError(""); return; }
    setSaving(true); setError("");
    try { await save(group, name); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  const label = (saving || error ? draft.trim() : group.name) || "未命名分组";
  return <div className="group-name">
    {editing ? <span className="group-name-editor"><span className="group-name-width" aria-hidden="true">{draft || "未命名分组"}</span><input className="group-name-input" aria-label="分组名称" value={draft} maxLength={80} placeholder="未命名分组" autoFocus onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setError(""); setDraft(group.name); setEditing(false); }
    }} /></span> : <button className="group-name-text" aria-label={`编辑分组名称：${label}`} title="点击编辑分组名称" disabled={busy || saving} onClick={() => {
      cancelled.current = false;
      if (!error) setDraft(group.name);
      setEditing(true);
    }}><strong>{label}</strong>{saving && <RotateCw size={12} className="spin" />}</button>}
    {error && <span className="group-name-error" role="alert">保存失败：{error}，点击名称重试</span>}
  </div>;
}
