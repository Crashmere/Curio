import { api, ApiError, base, Scope, UploadSession } from "./api";

export type UploadItem = {
  id: string; file: File; name: string; scope: Scope; displayScope: Scope; tagIds: string[]; collectionIds: string[]; gameId: string; screenshot: boolean;
  state: "waiting" | "paused" | "reading" | "uploading" | "verifying" | "done" | "duplicate" | "error";
  progress: number; hash?: string; expectedHash?: string; assetId?: string; existingHidden?: boolean; trashed?: boolean; error?: string;
};
type State = { items: UploadItem[]; running: boolean; paused: boolean };
let state: State = { items: [], running: false, paused: false };
const listeners = new Set<() => void>();
const queueWaiters = new Set<() => void>();
let active = false;
type Lane = { controller?: AbortController; worker?: Worker; itemId?: string; settled?: Promise<void> };
const lanes = new Set<Lane>();
const discarding = new Set<string>();
const discarded = new Map<string, number>();
const queueOrder = new WeakMap<UploadItem, number>();
let sequence = 0;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let libraryTimer: ReturnType<typeof setTimeout> | undefined;
let libraryDirty = false;
const supported = /\.(jpe?g|png|webp|gif|apng|avif|svg|ico|tiff?|heic|heif|bmp|mov|mp4|m4v|mkv|webm|avi|3gp|mts)$/i;

function emit() {
  clearTimeout(progressTimer);
  progressTimer = undefined;
  state = { ...state, items: [...state.items] };
  listeners.forEach(listener => listener());
  queueWaiters.forEach(wake => wake());
  queueWaiters.clear();
}
function progress() {
  if (!progressTimer) progressTimer = setTimeout(emit, 120);
}
function flushLibrary() {
  clearTimeout(libraryTimer);
  libraryTimer = undefined;
  if (!libraryDirty) return;
  libraryDirty = false;
  window.dispatchEvent(new Event("curio-library-changed"));
}
function libraryChanged() {
  libraryDirty = true;
  if (!libraryTimer) libraryTimer = setTimeout(flushLibrary, 1000);
}
export const snapshot = () => state;
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function addFiles(files: File[], scope: Scope, tagIds: string[] = [], collectionIds: string[] = [], gameId = "", screenshot = false, expectedHash = "", displayScope: Scope = scope) {
  let skipped = 0;
  const keyFor = (file: File, scope: Scope, tagIds: string[], collectionIds: string[], gameId: string, screenshot: boolean, expectedHash = "", displayScope: Scope = scope) =>
    JSON.stringify([file.webkitRelativePath || file.name, file.size, file.lastModified, scope, displayScope, [...tagIds].sort(), [...collectionIds].sort(), gameId, screenshot, expectedHash]);
  const seen = new Set(state.items.map(item => keyFor(item.file, item.scope, item.tagIds, item.collectionIds, item.gameId, item.screenshot, item.expectedHash, item.displayScope)));
  for (const file of files) {
    if (!file.size || (!supported.test(file.name) && !/^(image|video)\//.test(file.type))) { skipped++; continue; }
    const key = keyFor(file, scope, tagIds, collectionIds, gameId, screenshot, expectedHash, displayScope);
    if (seen.has(key)) continue;
    const item: UploadItem = { id: crypto.randomUUID(), file, name: file.webkitRelativePath || file.name, scope, displayScope, tagIds: [...tagIds], collectionIds: [...collectionIds], gameId, screenshot, expectedHash: expectedHash || undefined, state: state.paused ? "paused" : "waiting", progress: 0 };
    queueOrder.set(item, ++sequence);
    state.items.push(item);
    seen.add(key);
  }
  emit();
  void run();
  return skipped;
}
export function pause() {
  state.paused = true;
  state.items.forEach(item => { if (["waiting", "reading", "uploading", "verifying"].includes(item.state)) item.state = "paused"; });
  lanes.forEach(lane => lane.controller?.abort());
  emit();
}
export function resume() {
  state.paused = false;
  state.items.forEach(item => { if (["paused", "error"].includes(item.state) && (!item.hash || !discarding.has(item.hash))) { item.state = "waiting"; item.error = undefined; } });
  emit();
  void run();
}
export function pauseItem(id: string) {
  const item = state.items.find(item => item.id === id);
  if (!item || ["done", "duplicate", "error", "paused"].includes(item.state)) return;
  item.state = "paused";
  lanes.forEach(lane => { if (lane.itemId === id) lane.controller?.abort(); });
  emit();
}
export function resumeItem(id: string) {
  const item = state.items.find(item => item.id === id);
  if (!item || !["paused", "error"].includes(item.state) || item.hash && discarding.has(item.hash)) return;
  // A targeted continuation must not release the rest of a globally paused batch.
  if (state.paused) state.items.forEach(candidate => { if (candidate.state === "waiting") candidate.state = "paused"; });
  state.paused = false;
  item.state = "waiting";
  item.error = undefined;
  emit();
  void run();
}
export function removeItem(id: string) {
  lanes.forEach(lane => { if (lane.itemId === id) lane.controller?.abort(); });
  state.items = state.items.filter(item => item.id !== id);
  emit();
}
export async function stopHash(hash: string) {
  discarding.add(hash);
  state.items.forEach(item => { if (item.hash === hash && !["done", "duplicate"].includes(item.state)) item.state = "paused"; });
  const stopping: Promise<void>[] = [];
  lanes.forEach(lane => {
    if (state.items.some(item => item.id === lane.itemId && item.hash === hash)) {
      lane.controller?.abort();
      if (lane.settled) stopping.push(lane.settled);
    }
  });
  emit();
  await Promise.all(stopping);
}
export function finishDiscard(hash: string, removed: boolean) {
  if (removed) {
    // Still-hashing items can reveal the same bytes after deletion has already finished.
    discarded.set(hash, sequence);
    state.items = state.items.filter(item => item.hash !== hash || ["done", "duplicate"].includes(item.state));
  }
  discarding.delete(hash);
  emit();
}
export function clearFinished(scope?: Scope) {
  state.items = state.items.filter(item => scope && item.displayScope !== scope || !["done", "duplicate"].includes(item.state));
  emit();
}
function hashFile(item: UploadItem, lane: Lane, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = lane.worker ||= new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { signal.removeEventListener("abort", abort); worker.onmessage = null; worker.onerror = null; };
    const discard = () => { worker.terminate(); lane.worker = undefined; };
    const abort = () => { cleanup(); discard(); reject(signal.reason); };
    worker.onmessage = event => {
      if (event.data.hash) { cleanup(); resolve(event.data.hash); }
      else if (event.data.error) { cleanup(); discard(); reject(new Error(event.data.error)); }
      else { item.progress = Number(event.data.progress) * 0.05; progress(); }
    };
    worker.onerror = event => { cleanup(); discard(); reject(new Error(event.message)); };
    signal.addEventListener("abort", abort, { once: true });
    worker.postMessage(item.file);
  });
}
function waitFor(promise: Promise<void>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = (settle: () => void) => { signal.removeEventListener("abort", abort); settle(); };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(() => finish(resolve), error => finish(() => reject(error)));
  });
}
async function delay(ms: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await waitFor(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
async function withHash(hash: string, pending: Map<string, Promise<void>>, signal: AbortSignal, transfer: () => Promise<void>) {
  while (pending.has(hash)) await waitFor(pending.get(hash)!, signal);
  signal.throwIfAborted();
  let release!: () => void;
  pending.set(hash, new Promise<void>(resolve => { release = resolve; }));
  try { await transfer(); }
  finally { pending.delete(hash); release(); }
}
const uploadProgress = (offset: number, size: number) => 0.05 + 0.94 * offset / size;
function sendChunk(item: UploadItem, offset: number, chunkSize: number, signal: AbortSignal) {
  return new Promise<{ offset: number }>((resolve, reject) => {
    signal.throwIfAborted();
    const chunk = item.file.slice(offset, offset + chunkSize);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${base}api/uploads/${item.hash}?offset=${offset}`);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.timeout = 660000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Upload-Offset", String(offset));
    const abort = () => xhr.abort();
    const finish = (settle: () => void) => {
      signal.removeEventListener("abort", abort);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.upload.onprogress = null;
      settle();
    };
    xhr.upload.onprogress = event => {
      if (signal.aborted) return;
      // Sent bytes animate the UI; only the response can advance the durable offset.
      item.progress = uploadProgress(offset + Math.min(chunk.size, event.loaded), item.file.size);
      progress();
    };
    xhr.onload = () => {
      const data = xhr.response || {};
      finish(() => xhr.status >= 200 && xhr.status < 300 ? resolve(data) : reject(new ApiError(xhr.status === 401 ? "请返回门户重新登录" : data.error || `上传失败 (${xhr.status})`, xhr.status, data)));
    };
    xhr.onerror = () => finish(() => reject(new Error("网络连接中断，请重试")));
    xhr.ontimeout = () => finish(() => reject(new Error("分片上传超时，请重试")));
    xhr.onabort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(chunk);
  });
}
function validate(session: UploadSession, size: number) {
  if (typeof session.complete !== "boolean") throw new Error("服务器返回了无效的上传状态");
  if (session.complete) return;
  if (session.state === "discarding") throw new Error("此上传正在清理，请稍后重新选择原文件");
  if (!Number.isInteger(session.offset) || session.offset < 0 || session.offset > size || !Number.isInteger(session.chunkSize) || session.chunkSize < 1 || session.chunkSize > 128 * 1024 * 1024) throw new Error("服务器返回了无效的续传参数");
}
async function transfer(item: UploadItem, lane: Lane, pending: Map<string, Promise<void>>, signal: AbortSignal) {
  if (!item.hash) {
    const hash = await hashFile(item, lane, signal);
    signal.throwIfAborted();
    item.hash = hash;
  }
  signal.throwIfAborted();
  if (item.expectedHash && item.hash !== item.expectedHash) throw new Error("选择的文件与待续传原件不同，请移出此项后重新选择正确的原文件");
  const cutoff = discarded.get(item.hash);
  if (cutoff !== undefined && queueOrder.get(item)! <= cutoff) { removeItem(item.id); return; }
  if (discarding.has(item.hash)) { item.state = "paused"; emit(); return; }
  item.state = "uploading";
  item.progress = Math.max(0.05, item.progress);
  emit();
  // Different filenames can contain identical bytes; prepare the second after the first commits.
  await withHash(item.hash, pending, signal, async () => {
    if (discarding.has(item.hash!)) { item.state = "paused"; emit(); return; }
    await upload(item, signal);
  });
}
function completed(item: UploadItem, session: UploadSession, duplicate: boolean) {
  item.assetId = session.assetId;
  item.existingHidden = session.effectiveHidden ?? session.existingHidden;
  item.trashed = session.trashed;
  item.state = duplicate ? "duplicate" : "done";
  item.progress = 1;
  emit();
  libraryChanged();
}
async function upload(item: UploadItem, signal: AbortSignal) {
  let session = await api<UploadSession>("uploads", { hash: item.hash, name: item.file.name, size: item.file.size, mime: item.file.type, scope: item.scope, tagIds: item.tagIds, collectionIds: item.collectionIds, gameId: item.gameId, screenshot: item.screenshot }, undefined, signal);
  signal.throwIfAborted();
  validate(session, item.file.size);
  item.assetId = session.assetId;
  if (session.complete) {
    completed(item, session, true);
    return;
  }
  item.state = "uploading";
  item.progress = uploadProgress(session.offset, item.file.size);
  emit();
  let offset = session.offset;
  let failures = 0;
  while (offset < item.file.size) {
    signal.throwIfAborted();
    try {
      const data = await sendChunk(item, offset, session.chunkSize, signal);
      signal.throwIfAborted();
      if (!Number.isInteger(data.offset) || data.offset <= offset || data.offset > item.file.size) throw new Error("服务器未确认已接收的分片");
      offset = data.offset;
      failures = 0;
      item.progress = uploadProgress(offset, item.file.size);
      progress();
    } catch (error) {
      item.progress = uploadProgress(offset, item.file.size);
      progress();
      signal.throwIfAborted();
      if (error instanceof ApiError && [400, 401, 403, 404, 410, 413, 415, 422].includes(error.status)) throw error;
      const conflict = error instanceof ApiError && error.status === 409;
      if (++failures > 3) throw conflict ? new Error("上传位置持续冲突，请暂停后重试") : error;
      if (!conflict) await delay(1000 * 2 ** failures, signal);
      session = await api<UploadSession>(`uploads/${item.hash}`, undefined, undefined, signal);
      signal.throwIfAborted();
      validate(session, item.file.size);
      if (session.complete) { completed(item, session, true); return; }
      offset = session.offset;
      item.progress = uploadProgress(offset, item.file.size);
      progress();
    }
  }
  signal.throwIfAborted();
  item.state = "verifying";
  item.progress = 0.99;
  emit();
  const result = await api<UploadSession>(`uploads/${item.hash}/complete`, {}, undefined, signal);
  signal.throwIfAborted();
  validate(result, item.file.size);
  if (!result.complete) throw new Error("服务器尚未完成原件校验");
  completed(item, result, !!result.duplicate);
}
async function run() {
  if (active || state.paused) return;
  active = true;
  state.running = true;
  emit();
  const pool: Lane[] = [{}, {}];
  const pending = new Map<string, Promise<void>>();
  pool.forEach(lane => lanes.add(lane));
  let wake: WakeLockSentinel | undefined;
  try { wake = await navigator.wakeLock?.request("screen"); } catch { /* Uploads also work without a wake lock. */ }
  try {
    await Promise.all(pool.map(async lane => {
      while (!state.paused) {
        const item = state.items.find(candidate => candidate.state === "waiting" && ![...lanes].some(lane => lane.itemId === candidate.id));
        if (!item) {
          // Keep a free lane available for new files or a resumed row while its peer is busy.
          if ([...lanes].some(candidate => candidate.controller)) { await new Promise<void>(resolve => queueWaiters.add(resolve)); continue; }
          break;
        }
        item.state = item.hash ? "uploading" : "reading";
        if (!item.hash) item.progress = 0;
        emit();
        const controller = new AbortController();
        let settle!: () => void;
        lane.controller = controller;
        lane.itemId = item.id;
        lane.settled = new Promise<void>(resolve => { settle = resolve; });
        try { await transfer(item, lane, pending, controller.signal); }
        catch (error) {
          if (state.items.includes(item) && !["paused", "waiting"].includes(item.state)) {
            if (controller.signal.aborted) item.state = "paused";
            else { item.state = "error"; item.error = error instanceof Error ? error.message : String(error); }
          }
        } finally {
          if (controller.signal.aborted) { lane.worker?.terminate(); lane.worker = undefined; }
          lane.controller = undefined;
          lane.itemId = undefined;
          settle();
          lane.settled = undefined;
        }
        emit();
      }
    }));
  } finally {
    pool.forEach(lane => { lane.worker?.terminate(); lanes.delete(lane); });
    flushLibrary();
    active = false;
    state.running = false;
    await wake?.release().catch(() => {});
    emit();
    if (!state.paused && state.items.some(item => item.state === "waiting")) void run();
  }
}
window.addEventListener("beforeunload", event => { if (active) event.preventDefault(); });
window.addEventListener("online", () => {
  if (!state.paused) state.items.filter(item => item.state === "error").forEach(item => resumeItem(item.id));
});
