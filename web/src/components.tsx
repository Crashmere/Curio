import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

export function Dialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [close]);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={20} /></button></header>
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
