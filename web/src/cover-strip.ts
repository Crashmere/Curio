import { useEffect, useState } from "react";
import { base as APP_BASE, ApiError as HttpServiceError, api as requestJson, type Asset, type PlaybackDescriptor } from "./api";
import { BrowserCoverFrames } from "./browser-cover-frames";

export type CoverStripFrame = { time: number; x: number; y: number; width: number; height: number };
type CoverStripPayload = { revision: string; duration: number; width: number; height: number; frames: CoverStripFrame[] };
export type CoverStrip = CoverStripPayload & { imageUrl: string; image: HTMLImageElement };
type Entry = { key: string; strip: CoverStrip; refs: number; bytes: number; used: number; retired: boolean; disposed: boolean };
type Lease = { strip: CoverStrip; release: () => void };
type Pending = { controller: AbortController; waiters: number; promise: Promise<Entry>; started: number; idleTimer?: ReturnType<typeof setTimeout> };
export type CoverStripState = { status: "idle" | "loading" | "ready" | "error"; strip?: CoverStrip };

const entries = new Map<string, Entry>();
const pending = new Map<string, Pending>();
const CACHE_BYTES = 24 * 1024 * 1024;
const REQUEST_GRACE = 2000;
let cacheBytes = 0;

function deferUnusedRequest(job: Pending) {
  clearTimeout(job.idleTimer);
  job.idleTimer = setTimeout(() => { if (!job.waiters) job.controller.abort(); }, REQUEST_GRACE);
  const unused = [...pending.values()].filter(item => !item.waiters && item.idleTimer)
    .sort((a, b) => a.started - b.started);
  for (const stale of unused.slice(0, Math.max(0, unused.length - 2))) {
    clearTimeout(stale.idleTimer);
    stale.controller.abort();
  }
}

function dispose(entry: Entry) {
  if (entry.disposed || entry.refs > 0) return;
  entry.disposed = true;
  URL.revokeObjectURL(entry.strip.imageUrl);
  entry.strip.image.removeAttribute("src");
  cacheBytes -= entry.bytes;
}

function retire(entry: Entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  entry.retired = true;
  dispose(entry);
}

function trimCache() {
  while (entries.size > 6 || cacheBytes > CACHE_BYTES) {
    const oldest = [...entries.values()].filter((entry) => entry.refs === 0).sort((a, b) => a.used - b.used)[0];
    if (!oldest) break;
    retire(oldest);
  }
}

function lease(entry: Entry): Lease {
  entry.refs++;
  entry.used = Date.now();
  let released = false;
  return { strip: entry.strip, release: () => {
    if (released) return;
    released = true;
    entry.refs--;
    if (entry.retired) dispose(entry);
    else trimCache();
  } };
}

export function coverStripResource(asset: Asset): string | undefined {
  if (asset.kind !== "video" || asset.status === "deleting") return;
  return `assets/${asset.id}/frames`;
}

async function fetchStrip(key: string, signal: AbortSignal): Promise<Entry> {
  const payload = await requestJson<CoverStripPayload>(key, undefined, undefined, signal);
  const response = await fetch(`${APP_BASE}api/${key}?image=${payload.revision}`, { credentials: "same-origin", signal });
  if (!response.ok) throw new HttpServiceError("候选帧加载失败", response.status);
  const blob = await response.blob();
  signal.throwIfAborted();
  if (blob.size > 8 * 1024 * 1024) throw new Error("Candidate atlas exceeds its output bound");
  const imageUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    signal.throwIfAborted();
    const entry: Entry = { key, strip: { ...payload, imageUrl, image }, refs: 0,
      bytes: blob.size + payload.width * payload.height * 4, used: Date.now(), retired: false, disposed: false };
    const previous = entries.get(key);
    if (previous) retire(previous);
    entries.set(key, entry);
    cacheBytes += entry.bytes;
    return entry;
  } catch (error) {
    URL.revokeObjectURL(imageUrl);
    throw error;
  }
}

export function acquireCoverStrip(key: string, signal: AbortSignal): Promise<Lease> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const cached = entries.get(key);
  if (cached) return Promise.resolve(lease(cached));
  let job = pending.get(key);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    const promise = fetchStrip(key, controller.signal);
    job = { controller, promise, waiters: 0, started: Date.now() };
    pending.set(key, job);
    const current = job;
    const done = () => {
      clearTimeout(current.idleTimer);
      if (pending.get(key) === current) pending.delete(key);
      if (!current.waiters) trimCache();
    };
    promise.then(done, done);
  }
  const current = job;
  clearTimeout(current.idleTimer);
  current.idleTimer = undefined;
  current.waiters++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      signal.removeEventListener("abort", abort);
      current.waiters--;
    };
    const abort = () => {
      if (settled) return;
      finish();
      if (!current.waiters) deferUnusedRequest(current);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    current.promise.then((entry) => {
      if (settled) return;
      finish();
      resolve(lease(entry));
      trimCache();
    }, (error) => {
      if (settled) return;
      finish();
      reject(error);
    });
  });
}

export class CoverFrameRequests {
  private mode: "preview" | "fallback" | "stopped" = "preview";
  private running = 0;
  private waiting = new Map<() => void, () => void>();
  private active = new Set<AbortController>();
  private browser?: BrowserCoverFrames;
  private browserFailed = false;

  constructor(private readonly playbackResource: string, private readonly rotation = 0) {}

  setMode(mode: "preview" | "fallback" | "stopped") {
    this.mode = mode;
    if (mode === "stopped") {
      for (const abort of this.waiting.values()) abort();
      for (const controller of this.active) controller.abort();
      this.browser?.dispose();
      this.browser = undefined;
      this.browserFailed = false;
    } else {
      this.pump();
    }
  }

  load(url: string, time: number, signal: AbortSignal): Promise<Blob> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let started = false;
      let finished = false;
      const finish = (blob?: Blob, error?: unknown) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        this.waiting.delete(start);
        this.active.delete(controller);
        if (started) this.running--;
        if (blob) resolve(blob);
        else reject(error);
        this.pump();
      };
      const abort = () => {
        controller.abort();
        if (!started) finish(undefined, controller.signal.reason);
      };
      const start = () => {
        this.waiting.delete(start);
        if (signal.aborted) { finish(undefined, signal.reason); return; }
        started = true;
        this.running++;
        this.active.add(controller);
        void this.capture(url, time, controller.signal).then((blob) => finish(blob), (error) => finish(undefined, error));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.set(start, abort);
      this.pump();
    });
  }

  private async capture(url: string, time: number, signal: AbortSignal): Promise<Blob> {
    if (!this.browserFailed) {
      const browser = this.browser ??= new BrowserCoverFrames(async (sourceSignal) => {
        const descriptor = await requestJson<PlaybackDescriptor>(this.playbackResource, undefined, undefined, sourceSignal);
        return descriptor.source ? { ...descriptor.source, duration: descriptor.duration } : undefined;
      }, this.rotation, this.playbackResource);
      try {
        return await browser.capture(time, signal);
      } catch {
        signal.throwIfAborted();
        if (this.browser === browser) {
          browser.dispose();
          this.browser = undefined;
          this.browserFailed = true;
        }
      }
    }
    const response = await fetch(url, { credentials: "same-origin", signal });
    if (!response.ok) throw new HttpServiceError("候选帧加载失败", response.status);
    const blob = await response.blob();
    signal.throwIfAborted();
    if (blob.size > 8 * 1024 * 1024) throw new Error("Candidate frame exceeds its output bound");
    return blob;
  }

  private pump() {
    // Native seeks share one decoder; early server thumbnails leave an exact-preview slot.
    const limit = this.mode === "fallback" && this.browserFailed ? 2 : 1;
    while (this.mode !== "stopped" && this.running < limit) {
      const next = this.waiting.keys().next().value;
      if (!next) break;
      next();
    }
  }
}

export function useCoverStrip(resource: string | undefined, enabled: boolean): CoverStripState {
  const [state, setState] = useState<CoverStripState & { resource?: string }>({ status: "idle" });
  const [visible, setVisible] = useState(!document.hidden);
  const active = enabled && visible;
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!active || !resource) { setState({ status: "idle" }); return; }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setState({ status: "loading", resource });
    acquireCoverStrip(resource, controller.signal).then((loaded) => {
      if (controller.signal.aborted) { loaded.release(); return; }
      release = loaded.release;
      setState({ status: "ready", resource, strip: loaded.strip });
    }, () => { if (!controller.signal.aborted) setState({ status: "error", resource }); });
    return () => { controller.abort(); release?.(); };
  }, [resource, active]);
  if (!active || !resource) return { status: "idle" };
  return state.resource === resource ? state : { status: "loading" };
}

function clearCache() {
  for (const entry of entries.values()) retire(entry);
  for (const job of pending.values()) {
    clearTimeout(job.idleTimer);
    job.controller.abort();
  }
}

window.addEventListener("curio-cover-strip-invalidated", clearCache);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearCache();
});
