import { api, ApiError, base, Scope, UploadSession } from "./api";

export type UploadItem = {
  id: string; file: File; name: string; scope: Scope; tagIds: string[]; collectionIds: string[];
  state: "waiting" | "reading" | "uploading" | "done" | "duplicate" | "error";
  progress: number; hash?: string; assetId?: string; error?: string;
};
type State = { items: UploadItem[]; running: boolean; paused: boolean };
let state: State = { items: [], running: false, paused: false };
const listeners = new Set<() => void>();
let active = false;
let controller: AbortController | undefined;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
const supported = /\.(jpe?g|png|webp|gif|apng|avif|svg|ico|tiff?|heic|heif|bmp|mov|mp4|m4v|mkv|webm|avi|3gp|mts)$/i;

function emit() {
  clearTimeout(progressTimer);
  progressTimer = undefined;
  state = { ...state, items: [...state.items] };
  listeners.forEach(listener => listener());
}
function progress() {
  if (!progressTimer) progressTimer = setTimeout(emit, 120);
}
export const snapshot = () => state;
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function addFiles(files: File[], scope: Scope, tagIds: string[] = [], collectionIds: string[] = []) {
  let skipped = 0;
  const seen = new Set(state.items.map(item => `${item.name}|${item.file.size}|${item.file.lastModified}|${item.scope}`));
  for (const file of files) {
    if (!file.size || (!supported.test(file.name) && !/^(image|video)\//.test(file.type))) { skipped++; continue; }
    const key = `${file.name}|${file.size}|${file.lastModified}|${scope}`;
    if (seen.has(key)) continue;
    state.items.push({ id: crypto.randomUUID(), file, name: file.webkitRelativePath || file.name, scope, tagIds: [...tagIds], collectionIds: [...collectionIds], state: "waiting", progress: 0 });
    seen.add(key);
  }
  emit();
  void run();
  return skipped;
}
export function pause() {
  state.paused = true;
  controller?.abort();
  emit();
}
export function resume() {
  state.paused = false;
  state.items.forEach(item => { if (item.state === "error") { item.state = "waiting"; item.error = undefined; } });
  emit();
  void run();
}
export function clearFinished() {
  state.items = state.items.filter(item => !["done", "duplicate"].includes(item.state));
  emit();
}
function hashFile(item: UploadItem) {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = event => {
      if (event.data.hash) { worker.terminate(); resolve(event.data.hash); }
      else if (event.data.error) { worker.terminate(); reject(new Error(event.data.error)); }
      else { item.progress = Number(event.data.progress) * 0.05; progress(); }
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage(item.file);
  });
}
function validate(session: UploadSession, size: number) {
  if (typeof session.complete !== "boolean") throw new Error("服务器返回了无效的上传状态");
  if (session.complete) return;
  if (!Number.isInteger(session.offset) || session.offset < 0 || session.offset > size || !Number.isInteger(session.chunkSize) || session.chunkSize < 1 || session.chunkSize > 128 * 1024 * 1024) throw new Error("服务器返回了无效的续传参数");
}
async function transfer(item: UploadItem) {
  if (!item.hash) {
    item.state = "reading";
    emit();
    item.hash = await hashFile(item);
  }
  if (state.paused) { item.state = "waiting"; return; }
  let session = await api<UploadSession>("uploads", { hash: item.hash, name: item.file.name, size: item.file.size, mime: item.file.type, scope: item.scope, tagIds: item.tagIds, collectionIds: item.collectionIds });
  validate(session, item.file.size);
  item.assetId = session.assetId;
  if (session.complete) {
    item.state = "duplicate";
    item.progress = 1;
    emit();
    window.dispatchEvent(new Event("curio-library-changed"));
    return;
  }
  item.state = "uploading";
  item.progress = 0.05 + 0.95 * session.offset / item.file.size;
  emit();
  let offset = session.offset;
  let failures = 0;
  while (offset < item.file.size) {
    if (state.paused) { item.state = "waiting"; return; }
    try {
      controller = new AbortController();
      const response = await fetch(`${base}api/uploads/${item.hash}?offset=${offset}`, {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(offset) },
        body: item.file.slice(offset, offset + session.chunkSize),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(660000)])
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        session = await api<UploadSession>(`uploads/${item.hash}`);
        validate(session, item.file.size);
        offset = session.offset;
        if (session.complete) break;
        if (++failures > 3) throw new Error("上传位置持续冲突，请暂停后重试");
        continue;
      }
      if (!response.ok) throw new ApiError(response.status === 401 ? "请返回门户重新登录" : data.error || `上传失败 (${response.status})`, response.status, data);
      if (!Number.isInteger(data.offset) || data.offset <= offset || data.offset > item.file.size) throw new Error("服务器未确认已接收的分片");
      offset = data.offset;
      failures = 0;
      item.progress = 0.05 + 0.95 * offset / item.file.size;
      progress();
    } catch (error) {
      if (state.paused) { item.state = "waiting"; return; }
      if (error instanceof ApiError && [400, 401, 403, 404, 410, 413, 415, 422].includes(error.status)) throw error;
      if (++failures > 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** failures));
      session = await api<UploadSession>(`uploads/${item.hash}`);
      validate(session, item.file.size);
      offset = session.offset;
      if (session.complete) break;
    } finally { controller = undefined; }
  }
  if (state.paused) { item.state = "waiting"; return; }
  const result = await api<UploadSession>(`uploads/${item.hash}/complete`, {});
  item.assetId = result.assetId;
  item.state = result.duplicate ? "duplicate" : "done";
  item.progress = 1;
  emit();
  window.dispatchEvent(new Event("curio-library-changed"));
}
async function run() {
  if (active || state.paused) return;
  active = true;
  state.running = true;
  emit();
  let wake: WakeLockSentinel | undefined;
  try { wake = await navigator.wakeLock?.request("screen"); } catch { /* Uploads also work without a wake lock. */ }
  try {
    while (!state.paused) {
      const item = state.items.find(candidate => candidate.state === "waiting");
      if (!item) break;
      try { await transfer(item); }
      catch (error) { item.state = "error"; item.error = error instanceof Error ? error.message : String(error); }
      emit();
    }
  } finally {
    active = false;
    state.running = false;
    await wake?.release().catch(() => {});
    emit();
  }
}
window.addEventListener("beforeunload", event => { if (active) event.preventDefault(); });
window.addEventListener("online", () => { if (!state.paused && state.items.some(item => item.state === "error")) resume(); });
