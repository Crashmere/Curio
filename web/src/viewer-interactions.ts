import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";

const compactQuery = window.matchMedia("(max-width: 900px), (pointer: coarse)");
export function useCompactViewer() {
  return useSyncExternalStore(callback => {
    compactQuery.addEventListener("change", callback);
    return () => compactQuery.removeEventListener("change", callback);
  }, () => compactQuery.matches);
}

export function useViewerControls(playing: boolean, pinned: boolean) {
  const [hidden, setHidden] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    if (!playing || pinned) setHidden(false);
    else timer.current = setTimeout(() => setHidden(true), 2600);
    return () => clearTimeout(timer.current);
  }, [playing, pinned]);
  function reveal() {
    setHidden(false);
    clearTimeout(timer.current);
    if (playing && !pinned) timer.current = setTimeout(() => setHidden(true), 2600);
  }
  return { hidden, reveal, toggle: () => { if (!pinned) { if (hidden) reveal(); else setHidden(true); } } };
}

export function useTouchNavigation({ previous, next, close, tap }: {
  previous?: () => void; next?: () => void; close?: () => void; tap: () => void;
}) {
  const start = useRef<{ id: number; x: number; y: number; canceled: boolean } | null>(null);
  const ignoreClick = useRef(false);
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch") return;
      if (start.current) { start.current.canceled = true; return; }
      start.current = { id: event.pointerId, x: event.clientX, y: event.clientY, canceled: false };
      ignoreClick.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const origin = start.current;
      if (!origin || origin.id !== event.pointerId) return;
      start.current = null;
      ignoreClick.current = true;
      if (origin.canceled) return;
      const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
      if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.4) { if (dx < 0) next?.(); else previous?.(); }
      else if (dy > 110 && dy > Math.abs(dx) * 1.5) close?.();
      else if (Math.hypot(dx, dy) < 8) tap();
    },
    onPointerCancel() { start.current = null; ignoreClick.current = true; },
    onClick() { if (ignoreClick.current) ignoreClick.current = false; else tap(); },
  };
}
