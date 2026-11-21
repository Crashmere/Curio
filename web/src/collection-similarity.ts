import type { Asset } from "./api";

export type SimilarityAsset = Pick<Asset, "id" | "name" | "title" | "kind" | "width" | "height" | "size" | "thumbnailUrl">;
export type SimilarityPair = { left: string; right: string; distance: number };
export type SimilarityProgress = { stage: "loading" | "hashing" | "comparing"; completed: number; total: number };
export type SimilarityResult = {
  assets: Record<string, SimilarityAsset>;
  pairs: SimilarityPair[];
  total: number;
  checked: number;
  skipped: { name: string; reason: string }[];
};
export type SimilarityMessage = { type: "progress"; progress: SimilarityProgress } | { type: "done"; result: SimilarityResult } | { type: "error"; error: string };
export type SimilarityFingerprint = { id: string; hash: bigint; ratio: number };

export function differenceHash(pixels: Uint8ClampedArray): bigint | null {
  const gray = (index: number) => {
    const offset = index * 4;
    const alpha = pixels[offset + 3] / 255;
    return (pixels[offset] * .299 + pixels[offset + 1] * .587 + pixels[offset + 2] * .114) * alpha + 255 * (1 - alpha);
  };
  let hash = 0n;
  let low = 255, high = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = gray(y * 9 + x), right = gray(y * 9 + x + 1);
      low = Math.min(low, left, right); high = Math.max(high, left, right);
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  // Flat thumbnails share meaningless hashes; Aura excludes this contrast range too.
  return high - low < 3000 / 257 ? null : hash;
}

export function hammingDistance(left: bigint, right: bigint): number {
  let difference = left ^ right;
  let distance = 0;
  while (difference) {
    difference &= difference - 1n;
    distance++;
  }
  return distance;
}

export class SimilarityIndex {
  private blocks = Array.from({ length: 5 }, () => new Map<bigint, SimilarityFingerprint[]>());

  add(item: SimilarityFingerprint): SimilarityPair[] {
    const pairs: SimilarityPair[] = [];
    const seen = new Set<string>();
    // With at most four differing bits, one of five disjoint blocks is identical.
    for (let block = 0; block < this.blocks.length; block++) {
      const key = block === 4 ? item.hash >> 52n : (item.hash >> BigInt(block * 13)) & 8191n;
      const bucket = this.blocks[block].get(key) ?? [];
      for (const other of bucket) {
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        if (Math.abs(item.ratio - other.ratio) >= .03) continue;
        const distance = hammingDistance(item.hash, other.hash);
        if (distance <= 4) pairs.push({ left: other.id, right: item.id, distance });
      }
      bucket.push(item);
      this.blocks[block].set(key, bucket);
    }
    return pairs;
  }
}
