import { PointerEvent, useEffect, useRef } from "react";
import { base } from "./api";

export function Brand({ home, switchScope }: { home: () => void; switchScope: () => void }) {
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClick = useRef(false);

  function cancelPress() {
    clearTimeout(press.current?.timer);
    press.current = null;
  }
  useEffect(() => {
    window.addEventListener("blur", cancelPress);
    return () => { window.removeEventListener("blur", cancelPress); cancelPress(); };
  }, []);

  function startPress(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    cancelPress();
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      timer: setTimeout(() => {
        press.current = null;
        suppressClick.current = true;
        switchScope();
      }, 800)
    };
  }
  function movePress(event: PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    if (current?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) {
      suppressClick.current = true;
      cancelPress();
    }
  }

  return <button className="brand" aria-label="Curio 首页，长按切换隐藏模式"
    onPointerDown={startPress} onPointerMove={movePress}
    onPointerUp={event => { if (press.current?.id === event.pointerId) cancelPress(); }}
    onPointerCancel={cancelPress} onLostPointerCapture={cancelPress}
    onContextMenu={event => event.preventDefault()}
    onClick={event => {
      // The click generated after a hold must not navigate away from the current view.
      if (suppressClick.current && event.detail > 0) { suppressClick.current = false; return; }
      home();
    }}>
    <img src={`${base}favicon.svg`} alt="" draggable={false} /><span>Curio</span>
  </button>;
}
