import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

export function formatDurationClock(seconds: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return `${hours ? hours + ":" + String(minutes).padStart(2, "0") : minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function parsePlayerTime(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length > 3 || !/^\d+(?:\.\d+)?$/.test(parts.at(-1) || "")) return null;
  if (parts.slice(0, -1).some(part => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (parts.length > 1 && numbers.at(-1)! >= 60) return null;
  if (parts.length === 3 && numbers[1] >= 60) return null;
  const time = numbers.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(time) ? time : null;
}

function editableTime(time: number) {
  const rounded = Math.round(Math.max(0, time) * 1000) / 1000;
  const fraction = rounded.toFixed(3).split(".")[1].replace(/0+$/, "");
  return formatDurationClock(rounded) + (fraction ? `.${fraction}` : "");
}

export function PlayerTimeEditor({ time, maxTime, disabled, onCommit, onEditingChange }: {
  time: number;
  maxTime: number;
  disabled: boolean;
  onCommit: (time: number) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  const initialDraft = useRef("");
  const errorId = useId();

  useEffect(() => () => {
    if (active.current) onEditingChange(false);
  }, [onEditingChange]);
  useEffect(() => {
    if (disabled && active.current) closeEditor();
  }, [disabled]);

  function closeEditor() {
    active.current = false;
    setEditing(false);
    setError("");
    onEditingChange(false);
  }

  function commit(value: string) {
    if (!active.current) return;
    // Leaving an untouched clock must not jump back while playback advances.
    if (value.trim() === initialDraft.current) {
      closeEditor();
      return;
    }
    const target = parsePlayerTime(value);
    if (target === null) {
      setError("请输入秒数、分:秒或时:分:秒");
      return;
    }
    if (target > maxTime) {
      setError(`时间范围 0:00 - ${editableTime(maxTime)}`);
      return;
    }
    closeEditor();
    onCommit(target);
  }

  return (
    <div className={`player-time-control${editing ? " is-editing" : ""}`}>
      <span className="player-time-width" aria-hidden="true">
        {editing ? draft || initialDraft.current : formatDurationClock(maxTime)}
      </span>
      {editing ? (
        <input
          className="player-time player-time-input"
          type="text"
          aria-label="播放时间"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          value={draft}
          maxLength={24}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onFocus={event => event.currentTarget.select()}
          onChange={event => { setDraft(event.currentTarget.value); setError(""); }}
          onBlur={event => commit(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              commit(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeEditor();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="player-time player-time-button"
          title="点击编辑播放时间"
          aria-label={`编辑播放时间：${formatDurationClock(time)}`}
          disabled={disabled}
          onClick={() => {
            initialDraft.current = editableTime(time);
            setDraft(initialDraft.current);
            setError("");
            active.current = true;
            setEditing(true);
            onEditingChange(true);
          }}
        >
          {formatDurationClock(time)}
        </button>
      )}
      {error && <span className="player-time-error" id={errorId} role="alert">{error}</span>}
    </div>
  );
}

export function PlayerSeekPreview({ maxTime, disabled, style, children }: {
  maxTime: number;
  disabled: boolean;
  style: CSSProperties;
  children: ReactNode;
}) {
  const seekRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const pointerX = useRef<number | null>(null);
  const raf = useRef(0);

  function hidePreview() {
    pointerX.current = null;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const preview = previewRef.current;
    preview?.removeAttribute("data-visible");
    preview?.style.removeProperty("transform");
    preview?.style.removeProperty("--preview-anchor");
  }

  useEffect(() => hidePreview(), [maxTime, disabled]);
  useEffect(() => {
    const seek = seekRef.current;
    if (!seek) return;
    const observer = new ResizeObserver(hidePreview);
    observer.observe(seek);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  function followPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || disabled || maxTime <= 0) return;
    pointerX.current = event.clientX;
    if (raf.current) return;
    // Paint only the floating clock, rather than rerendering the video on mousemove.
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const seek = seekRef.current;
      const preview = previewRef.current;
      const label = labelRef.current;
      const input = seek?.querySelector('input[type="range"]');
      if (!seek || !preview || !label || !input || pointerX.current === null) return;
      const box = input.getBoundingClientRect();
      const inset = (parseFloat(getComputedStyle(seek).getPropertyValue("--player-seek-thumb-size")) || 11) / 2;
      const ratio = Math.max(0, Math.min(1, (pointerX.current - box.left - inset) / Math.max(1, box.width - inset * 2)));
      const anchor = box.left - seek.getBoundingClientRect().left + inset + ratio * (box.width - inset * 2);
      label.textContent = formatDurationClock(ratio * maxTime);
      const left = Math.max(0, Math.min(seek.clientWidth - preview.offsetWidth, anchor - preview.offsetWidth / 2));
      preview.style.transform = `translate3d(${left}px, 0, 0)`;
      preview.style.setProperty("--preview-anchor", `${anchor - left}px`);
      preview.setAttribute("data-visible", "true");
    });
  }

  return (
    <div ref={seekRef} className="player-seek" style={style}
      onPointerEnter={followPointer} onPointerMove={followPointer}
      onPointerLeave={hidePreview} onPointerCancel={hidePreview}>
      {children}
      <div ref={previewRef} className="player-seek-preview" aria-hidden="true">
        <span ref={labelRef}>0:00</span>
      </div>
    </div>
  );
}
