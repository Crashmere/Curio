export const base = import.meta.env.BASE_URL;
export type Scope = "normal" | "hidden";
export type View = "all" | "inbox" | "starred" | "collections" | "tags" | "trash" | "jobs";
export type Entity = { id: string; name: string; hidden: boolean; count: number; coverUrl?: string };
export type HiddenReason = { kind: string; id: string; name: string };
export type Asset = {
  id: string;
  name: string;
  title: string;
  notes: string;
  author: string;
  sourceUrl: string;
  size: number;
  mime: string;
  kind: "image" | "animation" | "video";
  width: number;
  height: number;
  duration: number;
  hasAlpha: boolean;
  hidden: boolean;
  effectiveHidden: boolean;
  hiddenReasons: HiddenReason[];
  organized: boolean;
  starred: boolean;
  trashedAt?: string;
  createdAt: string;
  thumbnailUrl: string;
  previewUrl: string;
  originalUrl: string;
  downloadUrl: string;
  tags: Entity[];
  collections: Entity[];
  status: string;
  error: string;
};
export type Info = {
  name: string; version: string;
  total: number; starred: number; unorganized: number; trash: number; bytes: number; queued: number; errors: number;
  chunkSize: number;
};
export type AssetPage = { items: Asset[]; total: number; nextOffset: number | null };
export type Patch = {
  title?: string; notes?: string; author?: string; sourceUrl?: string;
  hidden?: boolean; organized?: boolean; starred?: boolean; trash?: boolean;
  addTagIds?: string[]; removeTagIds?: string[];
  addCollectionIds?: string[]; removeCollectionIds?: string[];
};
export type Job = { id: string; assetId: string; name: string; status: string; stage: string; error?: string; updatedAt?: string; createdAt?: string; engine?: string; progress: number; thumbnailUrl?: string };
export type UploadSession = {
  id: string; hash?: string; name?: string; size: number; offset: number;
  complete: boolean; duplicate?: boolean; assetId?: string; chunkSize: number;
  scope?: Scope; hidden?: boolean; createdAt?: string;
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown> = {}) {
    super(message);
  }
}
export async function api<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}api/${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status === 401 ? "请返回门户重新登录" : data.error || `请求失败 (${response.status})`, response.status, data);
  return data as T;
}
export const scoped = (path: string, scope: Scope) => `${path}${path.includes("?") ? "&" : "?"}scope=${scope}`;
export function bytes(value: number) {
  if (!value) return "0 B";
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
export function duration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
