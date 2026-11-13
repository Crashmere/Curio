import { useEffect, useState } from "react";
import { base as APP_BASE, ApiError as HttpServiceError, api as requestJson, type Asset } from "./api";

export type CoverStripFrame = { time: number; x: number; y: number; width: number; height: number };
type CoverStripPayload = { revision: string; duration: number; width: number; height: number; frames: CoverStripFrame[] };
export type CoverStrip = CoverStripPayload & { imageUrl: string };
type Entry = { key: string; strip: CoverStrip; refs: number; bytes: number; used: number; retired: boolean; disposed: boolean };
type Lease = { strip: CoverStrip; release: () => void };
type Pending = { controller: AbortController; waiters: number; promise: Promise<Entry> };
export type CoverStripState = { status: "idle" | "loading" | "ready" | "error"; strip?: CoverStrip };

const entries = new Map<string, Entry>();
const pending = new Map<string, Pending>();
const CACHE_BYTES = 24 * 1024 * 1024;
let cacheBytes = 0;

function dispose(entry: Entry) {
  if (entry.disposed || entry.refs > 0) return;
  entry.disposed = true;
  URL.revokeObjectURL(entry.strip.imageUrl);
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
    const entry: Entry = { key, strip: { ...payload, imageUrl }, refs: 0,
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
    job = { controller, promise, waiters: 0 };
    pending.set(key, job);
    const current = job;
    promise.then(() => { if (pending.get(key) === current) pending.delete(key); }, () => { if (pending.get(key) === current) pending.delete(key); });
  }
  const current = job;
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
      if (!current.waiters) current.controller.abort();
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

export function useCoverStrip(resource: string | undefined, enabled: boolean): CoverStripState {
  const [state, setState] = useState<CoverStripState & { resource?: string }>({ status: "idle" });
  useEffect(() => {
    if (!enabled || !resource) { setState({ status: "idle" }); return; }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setState({ status: "loading", resource });
    acquireCoverStrip(resource, controller.signal).then((loaded) => {
      if (controller.signal.aborted) { loaded.release(); return; }
      release = loaded.release;
      setState({ status: "ready", resource, strip: loaded.strip });
    }, () => { if (!controller.signal.aborted) setState({ status: "error", resource }); });
    return () => { controller.abort(); release?.(); };
  }, [resource, enabled]);
  if (!enabled || !resource) return { status: "idle" };
  return state.resource === resource ? state : { status: "loading" };
}

function clearCache() {
  for (const entry of entries.values()) retire(entry);
  for (const job of pending.values()) job.controller.abort();
}

window.addEventListener("curio-cover-strip-invalidated", clearCache);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) for (const entry of entries.values()) retire(entry);
});
