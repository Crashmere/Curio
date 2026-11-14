import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ComponentPropsWithRef, type ReactNode } from "react";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const PresenceContext = createContext(true);
type MotionStyle = CSSProperties & Record<`--${string}`, string | number>;

export function prefersReducedMotion() {
  return window.matchMedia(reducedMotionQuery).matches;
}

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => true);
}

export function useIsPresent() {
  return useContext(PresenceContext);
}

export function MotionPresence({ present, children, variant = "overlay", exitMs = 160 }: {
  present: boolean;
  children: ReactNode;
  variant?: "overlay" | "menu" | "panel" | "toast" | "dock" | "shade";
  exitMs?: number;
}) {
  const parentPresent = useIsPresent();
  const reducedMotion = useReducedMotion();
  const [retained, setRetained] = useState<ReactNode>(present ? children : null);
  const [presentation, setPresentation] = useState({ present, epoch: 0 });
  // A newly opened editor must not reuse the departing view's local draft.
  if (present !== presentation.present) {
    setPresentation({ present, epoch: presentation.epoch + (present ? 1 : 0) });
  }

  useLayoutEffect(() => {
    if (present) setRetained(children);
  }, [present, children]);

  useEffect(() => {
    if (present) return;
    if (reducedMotion) { setRetained(null); return; }
    const timer = window.setTimeout(() => setRetained(null), exitMs);
    return () => window.clearTimeout(timer);
  }, [present, reducedMotion, exitMs]);

  if (!present && (reducedMotion || retained === null)) return null;
  const active = parentPresent && present;
  // Retain the departing view visually while its controls and shortcuts stop.
  return <PresenceContext.Provider value={active}>
    <div key={presentation.epoch} className="motion-presence" data-presence={present ? "present" : "exiting"} data-motion={variant}
      style={{ "--motion-exit-duration": `${exitMs}ms` } as MotionStyle} inert={!active} aria-hidden={!active || undefined}>
      {present ? children : retained}
    </div>
  </PresenceContext.Provider>;
}

export function CollapsibleRegion({ open, children, className = "", ...props }: ComponentPropsWithRef<"div"> & { open: boolean; children: ReactNode }) {
  const active = useIsPresent() && open;
  return <div {...props} className={`motion-collapse ${open ? "is-open" : ""} ${className}`.trim()}>
    <PresenceContext.Provider value={active}>
      <div className="motion-collapse-inner" inert={!active} aria-hidden={!active || undefined}>{children}</div>
    </PresenceContext.Provider>
  </div>;
}

export function useSlidingIndicator<T extends HTMLElement = HTMLDivElement>(activeKey: string | number, selector = ".active") {
  const ref = useRef<T>(null);
  const [style, setStyle] = useState<MotionStyle>({});

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      const selected = container.querySelector<HTMLElement>(selector);
      if (!selected) {
        setStyle(previous => previous["--motion-indicator-visible"] === 0 ? previous : { ...previous, "--motion-indicator-visible": 0 });
        return;
      }
      // Offsets ignore button press transforms and the mobile sidebar's slide.
      let x = selected.offsetLeft;
      let y = selected.offsetTop;
      let parent = selected.offsetParent;
      while (parent instanceof HTMLElement && parent !== container) {
        x += parent.offsetLeft + parent.clientLeft;
        y += parent.offsetTop + parent.clientTop;
        parent = parent.offsetParent;
      }
      const next: MotionStyle = {
        "--motion-indicator-x": `${x}px`,
        "--motion-indicator-y": `${y}px`,
        "--motion-indicator-width": `${selected.offsetWidth}px`,
        "--motion-indicator-height": `${selected.offsetHeight}px`,
        "--motion-indicator-visible": selected.offsetWidth ? 1 : 0,
      };
      setStyle(previous => Object.entries(next).every(([key, value]) => previous[key as keyof MotionStyle] === value) ? previous : {
        ...next,
        "--motion-indicator-duration": previous["--motion-indicator-width"] ? "220ms" : "0ms",
      });
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    for (const button of container.querySelectorAll("button")) observer.observe(button);
    const mutations = new MutationObserver(() => {
      for (const button of container.querySelectorAll("button")) observer.observe(button);
      scheduleMeasure();
    });
    mutations.observe(container, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [activeKey, selector]);

  return { ref, style };
}
