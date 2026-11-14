import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FolderHeart, Image, Layers3, RotateCw } from "lucide-react";
import { api, Asset, Scope, scoped } from "./api";
import { MotionPresence, useIsPresent } from "./motion";

type Target = { id: string; name: string; collectionName?: string; selected: boolean };
type Targets = { groups: Target[]; collections: Target[] };
type Kind = "group" | "collection";

export function ContainerCoverMenu({ asset, scope, open, setOpen, disabled, changed, notify }: {
  asset: Asset; scope: Scope; open: boolean; setOpen: (open: boolean) => void; disabled: boolean;
  changed: () => void; notify: (message: string) => void;
}) {
  const isPresent = useIsPresent();
  const root = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<Targets>();
  const [kind, setKind] = useState<Kind>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open || !isPresent) return;
    const controller = new AbortController();
    setTargets(undefined); setKind(undefined);
    void api<Targets>(scoped(`assets/${asset.id}/cover-targets`, scope), undefined, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setTargets(value); }).catch(error => { if (!controller.signal.aborted) { setOpen(false); notify(error.message); } });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      controller.abort();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", keyboard, true);
    };
  }, [open, asset.id, scope, isPresent]);

  async function save(kind: Kind, target: Target) {
    if (saving || !open || !isPresent) return;
    setSaving(true);
    try {
      await api(scoped(`assets/${asset.id}/container-cover`, scope), { kind, targetId: target.id }, "PATCH");
      setOpen(false); changed(); notify(`已设为${kind === "group" ? "分组" : "收藏集"}封面`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  function choose(kind: Kind) {
    if (!open || !isPresent) return;
    const items = targets?.[kind === "group" ? "groups" : "collections"] || [];
    if (items.length === 1) void save(kind, items[0]);
    else setKind(kind);
  }
  const items = targets?.[kind === "group" ? "groups" : "collections"] || [];
  return <div className="container-cover-control" ref={root}>
    <button className={`container-cover-toggle ${open ? "is-active" : ""}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled || saving || !!asset.trashedAt} onClick={() => setOpen(!open)}>
      {saving ? <RotateCw size={15} className="spin" /> : <Image size={15} />}<span>设为封面</span><ChevronDown size={12} />
    </button>
    <MotionPresence key={asset.id} present={open && isPresent} variant="menu">{open && <div className="container-cover-menu compact-action-menu" role="menu" aria-label="设为封面" aria-busy={!targets || saving}>
      {kind ? <>
        <button className="cover-menu-back" disabled={saving} onClick={() => setKind(undefined)}><ChevronLeft size={14} />选择{kind === "group" ? "分组" : "收藏集"}</button>
        <div className="action-menu-divider" role="separator" />
        {items.map(target => <button key={target.id} className="action-menu-item cover-target" role="menuitem" disabled={saving} onClick={() => void save(kind, target)}>
          {kind === "group" ? <Layers3 size={15} /> : <FolderHeart size={15} />}
          <span className="cover-target-copy"><span>{target.name || "未命名分组"}</span>{kind === "group" && <small>{target.collectionName}</small>}</span>
          {target.selected && <Check size={14} className="cover-menu-trailing" />}
        </button>)}
      </> : <>
        <button className="action-menu-item" role="menuitem" disabled={saving || !targets?.groups.length} title={targets && !targets.groups.length ? "此素材不在任何分组中" : undefined} onClick={() => choose("group")}>
          <Layers3 size={16} /><span>分组封面</span>{targets && targets.groups.length > 1 && <ChevronRight size={13} className="cover-menu-trailing" />}
        </button>
        <button className="action-menu-item" role="menuitem" disabled={saving || !targets?.collections.length} title={targets && !targets.collections.length ? "此素材不在任何收藏集中" : undefined} onClick={() => choose("collection")}>
          <FolderHeart size={16} /><span>收藏集封面</span>{targets && targets.collections.length > 1 && <ChevronRight size={13} className="cover-menu-trailing" />}
        </button>
        {!targets && <small className="cover-menu-loading"><RotateCw size={11} className="spin" />正在读取归属</small>}
      </>}
    </div>}</MotionPresence>
  </div>;
}
