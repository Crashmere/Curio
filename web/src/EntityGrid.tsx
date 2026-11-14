import { ComponentPropsWithoutRef, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Tag, Trash2 } from "lucide-react";
import { Entity } from "./api";
import { Empty } from "./components";

export function EntityCard({ entity, kind, open, actions, disabled, className = "", ...props }: {
  entity: Entity; kind: "tags" | "collections"; open: (entity: Entity) => void; actions: ReactNode; disabled?: boolean;
} & ComponentPropsWithoutRef<"article">) {
  return <article className={`entity-card ${className}`} {...props}>
    <button className="entity-open" disabled={disabled} draggable={false} onClick={() => open(entity)}>
      <div className="entity-cover">
        {entity.coverUrl ? <img src={entity.coverUrl} alt="" loading="lazy" draggable={false} /> : kind === "collections" ? <Folder size={35} strokeWidth={1.2} /> : <Tag size={30} strokeWidth={1.2} />}
        {kind === "collections" && entity.pinned && <span className="collection-pin-badge"><Pin size={12} />已固定</span>}
      </div>
      <div className="entity-card-info"><h2>{entity.name}</h2><span>{entity.count} 个素材</span></div>
    </button>
    <div className="entity-actions">{actions}</div>
  </article>;
}

export function EntityGrid({ items, kind, searching, busy, open, edit, rename, pin, remove, create }: {
  items: Entity[]; kind: "tags" | "collections"; searching: boolean; busy: boolean;
  open: (entity: Entity) => void; edit: (entity: Entity) => void; rename: (entity: Entity) => void;
  pin: (entity: Entity) => void; remove: (entity: Entity) => void; create: () => void;
}) {
  const [menu, setMenu] = useState<{ id: string; left: number; top: number }>();
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuSource = useRef<HTMLButtonElement | null>(null);
  const menuEntity = items.find(entity => entity.id === menu?.id);
  useLayoutEffect(() => {
    if (!menuRoot.current || !menuSource.current) return;
    const source = menuSource.current.getBoundingClientRect();
    const { width, height } = menuRoot.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(source.right - width, innerWidth - width - 12));
    const below = source.bottom + 6;
    const top = below + height <= innerHeight - 12 ? below : Math.max(12, source.top - height - 6);
    setMenu(current => current && (current.left !== left || current.top !== top) ? { ...current, left, top } : current);
  }, [menu?.id, menuEntity]);
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
    return () => {
      document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close);
    };
  }, [menu]);
  useEffect(() => { if (busy || (menu && !menuEntity)) setMenu(undefined); }, [busy, menu, menuEntity]);
  if (!items.length && searching) return <Empty icon={<Search size={30} />} title={`没有匹配的${kind === "collections" ? "收藏集" : "标签"}`} description="试试其他关键词，或清空搜索。" />;
  if (!items.length) return <Empty icon={kind === "collections" ? <Folder size={32} strokeWidth={1.3} /> : <Tag size={32} strokeWidth={1.3} />} title={kind === "collections" ? "还没有收藏集" : "还没有标签"} description={kind === "collections" ? "把同一个游戏、角色或主题的素材放在一起。" : "用头像、壁纸、梗图等标签标记用途，同一素材可以有多个标签。"}><button className="button primary" onClick={create}><Plus size={15} />新建{kind === "collections" ? "收藏集" : "标签"}</button></Empty>;
  return <><div className={`entity-grid ${kind}`}>{items.map(entity => <EntityCard entity={entity} kind={kind} open={open} key={entity.id} actions={kind === "collections" ? <button className="icon-button collection-menu-toggle" aria-label={`收藏集操作：${entity.name}`} title="收藏集操作" aria-haspopup="menu" aria-expanded={menu?.id === entity.id} disabled={busy} onClick={event => {
      if (menu?.id === entity.id) { setMenu(undefined); return; }
      menuSource.current = event.currentTarget;
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ id: entity.id, left: rect.right, top: rect.bottom + 6 });
    }}><MoreHorizontal size={18} /></button> : <>
      <button className="icon-button" aria-label={`编辑 ${entity.name}`} title="编辑" onClick={() => edit(entity)}><MoreHorizontal size={17} /></button>
      <button className="icon-button" aria-label={`移除 ${entity.name}`} title="移除" onClick={() => remove(entity)}><Trash2 size={15} /></button>
    </>} />)}</div>
    {menu && menuEntity && createPortal(<div ref={menuRoot} className="compact-action-menu collection-action-menu" style={{ left: menu.left, top: menu.top }} role="menu" aria-label={`收藏集操作：${menuEntity.name}`}>
      <div className="action-menu-heading" title={menuEntity.name}>{menuEntity.name}</div>
      <button className="action-menu-item" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); rename(menuEntity); }}><Pencil size={15} />重命名</button>
      <button className="action-menu-item" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); pin(menuEntity); }}>{menuEntity.pinned ? <PinOff size={15} /> : <Pin size={15} />}{menuEntity.pinned ? "取消固定" : "固定到侧栏"}</button>
      <div className="action-menu-divider" role="separator" />
      <button className="action-menu-item action-menu-danger collection-menu-delete" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); remove(menuEntity); }}><Trash2 size={15} />删除收藏集</button>
    </div>, document.body)}
  </>;
}
