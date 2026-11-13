import { ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { X } from "lucide-react";

const dialogStack: HTMLElement[] = [];
export type DialogProps = { title: string; children: ReactNode; close: () => void; wide?: boolean; dirty?: boolean; busy?: boolean };

export function Dialog({ title, children, close, wide = false, dirty = false, busy = false }: DialogProps) {
  const section = useRef<HTMLElement>(null);
  const [discard, setDiscard] = useState(false);
  function requestClose() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else close();
  }
  const escape = useEffectEvent((event: KeyboardEvent) => {
    if (dialogStack.at(-1) !== section.current || event.key !== "Escape" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (discard) setDiscard(false);
    else requestClose();
  });
  useEffect(() => {
    const element = section.current!;
    dialogStack.push(element);
    document.addEventListener("keydown", escape, true);
    return () => {
      dialogStack.splice(dialogStack.indexOf(element), 1);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);
  useEffect(() => { if (!dirty) setDiscard(false); }, [dirty]);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <section ref={section} className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} onClickCapture={event => {
      const trigger = event.target instanceof Element ? event.target.closest("[data-dialog-close]") : null;
      if (trigger?.closest("[role=dialog]") !== event.currentTarget) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    }}>
      <header className="dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭" data-dialog-close disabled={busy}><X size={20} /></button></header>
      {discard && <div className="dialog-unsaved" role="alert"><p>还有未保存的修改，是否放弃？</p><div><button type="button" className="button" disabled={busy} onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className="button danger" disabled={busy} onClick={close}>放弃修改</button></div></div>}
      {children}
    </section>
  </div>;
}
export function Empty({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h2>{title}</h2>{description && <p>{description}</p>}{children}</div>;
}
export const kindNames: Record<string, string> = { image: "图片", animation: "动图", video: "视频" };
export const stateNames: Record<string, string> = { queued: "等待处理", processing: "处理中", ready: "已完成", error: "处理失败", deleting: "删除中" };
export function isTextInput(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
}
