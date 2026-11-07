import { PointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tag } from "lucide-react";
import { Entity } from "./api";

type Drag = { pointerId: number; startX: number; startY: number; x: number; y: number; left: number; top: number; active: boolean; ready: boolean };
type Props = { tag: Entity; assetId?: string; className: string; cancelKey: string; disabled?: boolean; click?: () => void; change: (assetId: string, tag: Entity, remove: boolean) => void };
const removeDistance = 64;

export function TagChip({ tag, assetId, className, cancelKey, disabled, click, change }: Props) {
  const [drag, setDrag] = useState<Drag>();
  const session = useRef<Drag>(undefined);
  const target = useRef<HTMLElement | null>(null);
  const source = useRef<HTMLButtonElement>(null);
  const suppressClick = useRef(false);

  function clearTarget() {
    target.current?.removeAttribute("data-tag-drop-active");
    target.current = null;
  }
  function cancel() {
    const current = session.current;
    session.current = undefined;
    clearTarget();
    setDrag(undefined);
    if (current && source.current?.hasPointerCapture(current.pointerId)) source.current.releasePointerCapture(current.pointerId);
  }
  useEffect(() => {
    cancel();
    return cancel;
  }, [cancelKey, disabled]);
  const tracking = !!drag;
  useEffect(() => {
    if (!tracking) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancel); };
  }, [tracking]);

  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = session.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    const active = current.active || distance >= 6;
    if (active) { event.preventDefault(); suppressClick.current = true; }
    let ready = false;
    if (assetId) ready = distance >= removeDistance;
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

  return <>
    <button ref={source} type="button" className={`${className} tag-drag-source ${drag?.active ? "is-dragging" : ""}`} disabled={disabled} draggable={false}
      title={`标签：${tag.name}；${assetId ? "拖远后松开移除，拖回或按 Esc 取消" : "拖到素材上添加标签"}`}
      aria-label={`${tag.name}，${assetId ? "拖动移除标签" : "拖到素材上添加标签"}`}
      onDragStart={event => event.preventDefault()}
      onClick={event => { event.stopPropagation(); if (suppressClick.current) event.preventDefault(); else click?.(); }}
      onPointerDown={event => {
        suppressClick.current = false;
        if (disabled || !event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const next = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, active: false, ready: false };
        session.current = next;
        setDrag(next);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={event => {
        const current = move(event);
        if (!current) return;
        const id = assetId || target.current?.dataset.tagDropAsset;
        cancel();
        if (current.active && current.ready && id) change(id, tag, !!assetId);
      }}
      onPointerCancel={cancel} onLostPointerCapture={cancel}>
      {assetId && <Tag size={10} />}<span>{tag.name}</span>
    </button>
    {drag?.active && createPortal(<div className={`tag-drag-ghost ${assetId && drag.ready ? "remove-ready" : ""}`} style={{ left: drag.left + drag.x - drag.startX, top: drag.top + drag.y - drag.startY }}>
      <div className="tag-drag-label"><Tag size={12} /><span>{tag.name}</span></div>
      <span className="tag-drag-hint" role="status">{assetId ? drag.ready ? "松开移除标签" : "拖远移除 · 拖回取消" : drag.ready ? "松开添加标签" : "拖到素材上"}</span>
    </div>, document.body)}
  </>;
}
