import { PointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Tag, X } from "lucide-react";
import { Entity } from "./api";

type Drag = { pointerId: number; pointerType: string; startX: number; startY: number; x: number; y: number; left: number; top: number; armed: boolean; active: boolean; ready: boolean };
type Props = { tag: Entity; assetId?: string; className: string; cancelKey: string; disabled?: boolean; click?: () => void; remove?: () => void; change: (assetId: string, tag: Entity, remove: boolean) => void };
const removeDistance = 64;
const touchHold = 450;
const touchSlop = 10;

export function TagChip({ tag, assetId, className, cancelKey, disabled, click, remove, change }: Props) {
  const [drag, setDrag] = useState<Drag>();
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const session = useRef<Drag>(undefined);
  const target = useRef<HTMLElement | null>(null);
  const source = useRef<HTMLButtonElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClick = useRef(false);

  function clearTarget() {
    target.current?.removeAttribute("data-tag-drop-active");
    target.current = null;
  }
  function cancel() {
    clearTimeout(hold.current);
    hold.current = undefined;
    const current = session.current;
    session.current = undefined;
    clearTarget();
    setDrag(undefined);
    if (current && source.current?.hasPointerCapture(current.pointerId)) source.current.releasePointerCapture(current.pointerId);
  }
  useEffect(() => {
    cancel();
    setMenu(undefined);
    return cancel;
  }, [cancelKey, disabled]);
  useEffect(() => {
    const element = source.current!;
    // Before the hold, normal touch scrolling remains available.
    const touchMove = (event: TouchEvent) => { if (session.current?.pointerType === "touch" && session.current.armed) event.preventDefault(); };
    element.addEventListener("touchmove", touchMove, { passive: false });
    return () => element.removeEventListener("touchmove", touchMove);
  }, []);
  const tracking = !!drag || !!menu;
  useEffect(() => {
    if (!tracking) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel(); setMenu(undefined);
    };
    const blur = () => { cancel(); setMenu(undefined); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur); };
  }, [tracking]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !menuRoot.current?.contains(event.target) && !source.current?.contains(event.target)) setMenu(undefined);
    };
    const close = () => setMenu(undefined);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [!!menu]);

  function openMenu() {
    cancel();
    if (menu) { setMenu(undefined); return; }
    const rect = source.current!.getBoundingClientRect();
    setMenu({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 252)), top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 212)) });
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = session.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    if (!current.armed) {
      if (distance > touchSlop) { suppressClick.current = true; cancel(); return; }
      return current;
    }
    const active = current.active || distance >= 6;
    if (active) { event.preventDefault(); suppressClick.current = true; if (menu) setMenu(undefined); }
    let ready = false;
    if (assetId && active) ready = distance >= removeDistance;
    else if (active) {
      const next = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tag-drop-asset]") ?? null;
      if (next !== target.current) { clearTarget(); target.current = next; next?.setAttribute("data-tag-drop-active", ""); }
      ready = !!next;
    }
    const next = { ...current, x: event.clientX, y: event.clientY, active, ready };
    session.current = next;
    setDrag(next);
    return next;
  }

  const chip = <button ref={source} type="button" className={`${className} tag-drag-source ${drag?.active ? "is-dragging" : ""}`} disabled={disabled} draggable={false}
      title={`标签：${tag.name}；${assetId ? "点击管理；触屏长按拖远移除，拖回或按 Esc 取消" : "触屏长按后拖到素材上添加标签"}`}
      aria-label={`${tag.name}，${assetId ? "管理素材标签" : "拖到素材上添加标签"}`}
      aria-haspopup={assetId ? "menu" : undefined} aria-expanded={assetId ? !!menu : undefined}
      onDragStart={event => event.preventDefault()}
      onContextMenu={event => { if (assetId || session.current?.pointerType === "touch") { event.preventDefault(); event.stopPropagation(); if (assetId && session.current?.pointerType !== "touch") openMenu(); } }}
      onClick={event => { event.stopPropagation(); if (suppressClick.current) event.preventDefault(); else if (assetId) openMenu(); else click?.(); }}
      onPointerDown={event => {
        suppressClick.current = false;
        if (disabled || !event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const touch = event.pointerType === "touch";
        const next = { pointerId: event.pointerId, pointerType: event.pointerType, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, armed: !touch, active: false, ready: false };
        session.current = next;
        setDrag(next);
        if (!touch) event.currentTarget.setPointerCapture(event.pointerId);
        else hold.current = setTimeout(() => {
          if (session.current !== next || disabled || !source.current) return;
          const ready = { ...next, armed: true, active: true };
          session.current = ready; setDrag(ready); setMenu(undefined); suppressClick.current = true;
          source.current.setPointerCapture(next.pointerId);
        }, touchHold);
      }}
      onPointerMove={move}
      onPointerUp={event => {
        const current = move(event);
        if (!current) return;
        const id = assetId || target.current?.dataset.tagDropAsset;
        cancel();
        if (current.active && current.ready && id) change(id, tag, !!assetId);
      }}
      onPointerCancel={() => { suppressClick.current = true; cancel(); }} onLostPointerCapture={cancel}>
      {assetId && <Tag size={10} />}<span>{tag.name}</span>{assetId && <MoreHorizontal className="tag-action-hint" size={12} />}
    </button>;

  return <>
    {remove ? <span className={`tag-chip-with-remove ${drag?.active ? "is-dragging" : ""}`}>
      {chip}
      <button type="button" className="tag-chip-remove" disabled={disabled} title="删除标签" aria-label={`删除标签 ${tag.name}`}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); remove(); }}><X size={12} /></button>
    </span> : chip}
    {drag?.active && createPortal(<div className={`tag-drag-ghost ${assetId && drag.ready ? "remove-ready" : ""}`} style={{ left: drag.left + drag.x - drag.startX, top: drag.top + drag.y - drag.startY }}>
      <div className="tag-drag-label"><Tag size={12} /><span>{tag.name}</span></div>
      <span className="tag-drag-hint" role="status">{assetId ? drag.ready ? "松开移除标签" : "拖远移除 · 拖回取消" : drag.ready ? "松开添加标签" : "拖到素材上"}</span>
    </div>, document.body)}
    {menu && assetId && createPortal(<div ref={menuRoot} className="tag-action-menu" style={menu} role="menu" aria-label={`素材标签：${tag.name}`}>
      <strong>{tag.name}</strong><p>只移除当前素材的这个标签。</p>
      <button type="button" className="button danger subtle" role="menuitem" disabled={disabled} onClick={() => { setMenu(undefined); change(assetId, tag, true); }}><X size={16} />移除这个标签</button>
      <button type="button" className="button subtle" role="menuitem" onClick={() => setMenu(undefined)}>取消</button>
    </div>, document.body)}
  </>;
}
