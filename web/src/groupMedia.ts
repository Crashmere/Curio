import { api, Asset, AssetPage, MediaGroup } from "./api";

async function bounded<T>(items: T[], concurrency: number, signal: AbortSignal, work: (item: T) => Promise<void>) {
  let cursor = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !failed) {
      signal.throwIfAborted();
      const item = items[cursor++];
      try { await work(item); }
      catch (error) { failed = true; throw error; }
    }
  }));
  signal.throwIfAborted();
}

export async function prepareGroupMedia(assets: Asset[], groups: MediaGroup[], path: string, signal: AbortSignal): Promise<Record<string, AssetPage>> {
  const members = new Map(assets.map(asset => [asset.id, asset]));
  const ids = [...new Set(groups.flatMap(group => group.assetIds))];
  const missing = ids.filter(id => !members.has(id));
  const batches: string[][] = [];
  // Keep ID queries below the gateway's ordinary request-line limit.
  for (let offset = 0; offset < missing.length; offset += 60) batches.push(missing.slice(offset, offset + 60));
  await bounded(batches, 2, signal, async batch => {
    const params = new URLSearchParams(path.split("?")[1]);
    params.delete("grouped");
    params.set("ids", batch.join(","));
    params.set("limit", String(batch.length));
    params.set("offset", "0");
    const page = await api<AssetPage>(`assets?${params}`, undefined, undefined, signal);
    for (const asset of page.items) members.set(asset.id, asset);
  });
  const thumbnails = ids.map(id => members.get(id)?.thumbnailUrl).filter((url): url is string => !!url);
  await bounded(thumbnails, 8, signal, async url => {
    const image = new Image();
    image.loading = "eager";
    image.decoding = "sync";
    const cancel = () => { image.src = ""; };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      image.src = url;
      // Failed derivatives retain the media card's ordinary error placeholder.
      await image.decode().catch(() => {});
      signal.throwIfAborted();
    } finally { signal.removeEventListener("abort", cancel); }
  });
  return Object.fromEntries(groups.map(group => {
    const items = group.assetIds.map(id => members.get(id)).filter((asset): asset is Asset => !!asset);
    return [group.id, { items, total: items.length, nextOffset: null }];
  }));
}
