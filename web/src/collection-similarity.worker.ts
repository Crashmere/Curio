import { api, type AssetPage, type Scope } from "./api";
import { differenceHash, SimilarityIndex, type SimilarityAsset, type SimilarityFingerprint, type SimilarityMessage, type SimilarityResult } from "./collection-similarity";

const send = (message: SimilarityMessage) => self.postMessage(message);

async function scan(collectionId: string, scope: Scope) {
  const assets = new Map<string, SimilarityAsset & { status: string }>();
  let offset: number | null = 0;
  while (offset !== null) {
    const params: URLSearchParams = new URLSearchParams({ collection: collectionId, scope, limit: "240", offset: String(offset), sort: "oldest" });
    const page: AssetPage = await api<AssetPage>(`assets?${params}`, undefined, undefined, AbortSignal.timeout(30000));
    for (const asset of page.items) {
      const { id, name, title, kind, width, height, size, thumbnailUrl, status } = asset;
      assets.set(id, { id, name, title, kind, width, height, size, thumbnailUrl, status });
    }
    send({ type: "progress", progress: { stage: "loading", completed: assets.size, total: page.total } });
    if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error("收藏集分页未前进，请关闭后重试");
    offset = page.nextOffset;
  }

  const items = [...assets.values()];
  const fingerprints: (SimilarityFingerprint | undefined)[] = new Array(items.length);
  const skipped: SimilarityResult["skipped"] = [];
  const lowContrast = new Set<string>();
  let next = 0;
  let completed = 0;
  async function hashItems() {
    const canvas = new OffscreenCanvas(9, 8);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法读取图片像素");
    while (next < items.length) {
      const index = next++;
      const asset = items[index];
      try {
        if (asset.status !== "ready" || !asset.thumbnailUrl || asset.width <= 0 || asset.height <= 0) throw new Error("尚未处理完成或像素尺寸未知");
        const response = await fetch(asset.thumbnailUrl, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`缩略图读取失败 (${response.status})`);
        const bitmap = await createImageBitmap(await response.blob());
        try {
          context.clearRect(0, 0, 9, 8);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";
          context.drawImage(bitmap, 0, 0, 9, 8);
          const hash = differenceHash(context.getImageData(0, 0, 9, 8).data);
          if (hash === null) lowContrast.add(asset.id);
          else fingerprints[index] = { id: asset.id, ratio: asset.width / asset.height, hash };
        } finally { bitmap.close(); }
      } catch (error) {
        skipped.push({ name: asset.title || asset.name, reason: error instanceof Error ? error.message : String(error) });
      }
      send({ type: "progress", progress: { stage: "hashing", completed: ++completed, total: items.length } });
    }
    canvas.width = canvas.height = 0;
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, hashItems));

  const index = new SimilarityIndex();
  const pairs: SimilarityResult["pairs"] = [];
  const ready = fingerprints.filter((item): item is SimilarityFingerprint => !!item);
  for (let i = 0; i < ready.length; i++) {
    for (const pair of index.add(ready[i])) pairs.push(pair);
    if (i % 100 === 0 || i === ready.length - 1) send({ type: "progress", progress: { stage: "comparing", completed: i + 1, total: ready.length } });
  }
  pairs.sort((left, right) => left.distance - right.distance);
  const matched = new Set([...lowContrast, ...pairs.flatMap(pair => [pair.left, pair.right])]);
  const cards = Object.fromEntries(items.filter(asset => matched.has(asset.id)).map(({ status: _status, ...asset }) => [asset.id, asset]));
  send({ type: "done", result: { assets: cards, pairs, total: items.length, checked: ready.length, lowContrast: items.filter(asset => lowContrast.has(asset.id)).map(asset => asset.id), skipped } });
}

self.onmessage = (event: MessageEvent<{ collectionId: string; scope: Scope }>) => {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    send({ type: "error", error: "当前浏览器不支持离屏像素计算，请使用新版 Safari、Chrome 或 Firefox" });
    return;
  }
  void scan(event.data.collectionId, event.data.scope).catch(error => send({ type: "error", error: error instanceof Error ? error.message : String(error) }));
};
