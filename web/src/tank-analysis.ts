import { tankDefaults, TankOptions } from "./tank-decode";

export type TankCandidate = { label: string; options: TankOptions };
export type TankAnalysis = {
  kind: "prism" | "transparent" | "unknown";
  confidence: "preset" | "strong" | "uncertain";
  summary: string;
  candidates: TankCandidate[];
};

const sampleLimit = 16384;
const clamp = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));
const luminance = (pixels: Uint8ClampedArray, offset: number) => pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
function percentile(histogram: Uint32Array, count: number, fraction: number) {
  let sum = 0;
  for (let i = 0; i < histogram.length; i++) {
    sum += histogram[i];
    if (sum >= Math.max(1, count * fraction)) return i;
  }
  return 0;
}
function suggestedContrast(histogram: Uint32Array, count: number) {
  const lower = percentile(histogram, count, 0.05), upper = percentile(histogram, count, 0.95);
  if (upper - lower < 24) return 0;
  const factor = Math.max(1, Math.min(1.35, 210 / (upper - lower), lower < 128 ? 128 / (128 - lower) : Infinity, upper > 128 ? 127 / (upper - 128) : Infinity));
  return Math.round(259 * 255 * (factor - 1) / (255 * factor + 259));
}

function sampleOffsets(width: number, height: number) {
  const columns = Math.min(width, sampleLimit, Math.max(1, Math.ceil(Math.sqrt(sampleLimit * width / height))));
  const rows = Math.min(height, Math.max(1, Math.floor(sampleLimit / columns)));
  const offsets = new Uint32Array(columns * rows);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const left = Math.floor(column * width / columns), top = Math.floor(row * height / rows);
    const cellWidth = Math.floor((column + 1) * width / columns) - left;
    const cellHeight = Math.floor((row + 1) * height / rows) - top;
    // Jitter within each cell to avoid aliasing the encoder's alternating rows/columns.
    const hash = (Math.imul(column + 1, 73856093) ^ Math.imul(row + 1, 19349663)) >>> 0;
    offsets[row * columns + column] = ((top + (hash >>> 16) % cellHeight) * width + left + hash % cellWidth) * 4;
  }
  return offsets;
}

type Trial = TankCandidate & { score: number; strong: boolean; endpoint: number };
function prismTrial(pixels: Uint8ClampedArray, width: number, height: number, offsets: Uint32Array, span: number, bright: boolean): Trial {
  const lower = bright ? 255 - span : 0, upper = bright ? 255 : span;
  const inside = (offset: number) => pixels[offset + 3] > 8 && luminance(pixels, offset) >= lower && luminance(pixels, offset) <= upper;
  const levels = new Uint32Array(256), channels = new Uint32Array(256), endpoints = new Uint32Array(256);
  const cells = new Uint32Array(64), occupied = new Uint32Array(64);
  const tries = new Uint32Array(14), returns = new Uint32Array(14), differences = new Float64Array(14);
  let visible = 0, count = 0, adjacent = 0, crossings = 0, clipped = 0;
  for (const offset of offsets) {
    if (pixels[offset + 3] <= 8) continue;
    const position = offset / 4, x = position % width, y = Math.floor(position / width);
    const cell = Math.min(7, Math.floor(y * 8 / height)) * 8 + Math.min(7, Math.floor(x * 8 / width));
    cells[cell]++; visible++;
    if (!inside(offset)) continue;
    occupied[cell]++; count++;
    const value = luminance(pixels, offset);
    levels[clamp(Math.round((value - lower) * 255 / span), 0, 255)]++;
    const edge = bright ? 255 - Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) : Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    endpoints[edge]++;
    for (let c = 0; c < 3; c++) {
      if (pixels[offset + c] < lower || pixels[offset + c] > upper) clipped++;
      channels[clamp(Math.round((pixels[offset + c] - lower) * 255 / span), 0, 255)]++;
    }
    for (let axis = 0; axis < 2; axis++) {
      const remaining = axis === 0 ? width - x - 1 : height - y - 1, stride = axis === 0 ? 4 : width * 4;
      if (remaining < 1 || pixels[offset + stride + 3] <= 8) continue;
      adjacent++;
      if (inside(offset + stride)) continue;
      crossings++;
      // A narrow band must recur across a cover pixel, not merely form a dark region.
      for (let distance = 2; distance <= Math.min(8, remaining); distance++) {
        const other = offset + distance * stride, slot = axis * 7 + distance - 2;
        if (pixels[other + 3] <= 8) continue;
        tries[slot]++;
        if (!inside(other)) continue;
        returns[slot]++;
        differences[slot] += (Math.abs(pixels[offset] - pixels[other]) + Math.abs(pixels[offset + 1] - pixels[other + 1]) + Math.abs(pixels[offset + 2] - pixels[other + 2])) / (3 * span);
      }
    }
  }
  const fraction = count / Math.max(1, visible), crossing = crossings / Math.max(1, adjacent);
  const spread = (percentile(levels, count, 0.95) - percentile(levels, count, 0.05)) / 255;
  let recurrence = 0, coherence = 0;
  for (let i = 0; i < tries.length; i++) {
    if (tries[i] < Math.max(24, count * 0.08)) continue;
    const ratio = returns[i] / tries[i], smoothness = 1 - clamp(differences[i] / Math.max(1, returns[i]) / 0.25, 0, 1);
    if (ratio * smoothness > recurrence * coherence) { recurrence = ratio; coherence = smoothness; }
  }
  let coveredCells = 0, totalCells = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] >= 4) {
    totalCells++;
    if (occupied[i] / cells[i] >= 0.04) coveredCells++;
  }
  const coverage = coveredCells / Math.max(1, totalCells), validChannels = 1 - clipped / Math.max(1, count * 3);
  const plausible = fraction >= 0.04 && fraction <= 0.85 && count >= 64;
  const score = plausible ? (Math.min(1, crossing / 0.5) * 0.3 + recurrence * 0.4 + coherence * 0.3)
    * coverage * Math.min(1, fraction / 0.2) * Math.min(1, spread / 0.65) * validChannels : 0;
  const strong = plausible && crossing >= 0.35 && recurrence >= 0.8 && coherence >= 0.55 && coverage >= 0.7 && spread >= 0.25 && validChannels >= 0.96 && score >= 0.65;
  return { label: bright ? "亮色光棱" : "暗色光棱", options: { ...tankDefaults, lower, upper, contrast: suggestedContrast(channels, count * 3) },
    score, strong, endpoint: clamp(percentile(endpoints, count, 0.995) + 1, 4, 112) };
}

function fillIterations(pixels: Uint8ClampedArray, width: number, height: number, offsets: Uint32Array, options: TankOptions) {
  const distances = new Uint32Array(17);
  let checked = 0;
  const inside = (offset: number) => pixels[offset + 3] > 8 && luminance(pixels, offset) >= options.lower && luminance(pixels, offset) <= options.upper;
  for (const offset of offsets) {
    if (inside(offset)) continue;
    const position = offset / 4, x = position % width, y = Math.floor(position / width);
    let nearest = 16;
    search: for (let radius = 1; radius <= 16; radius++) {
      for (const [dx, dy] of [[-radius, 0], [radius, 0], [0, -radius], [0, radius], [-radius, -radius], [radius, radius], [-radius, radius], [radius, -radius]]) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height && inside(((y + dy) * width + x + dx) * 4)) { nearest = radius; break search; }
      }
    }
    distances[nearest]++;
    if (++checked >= 512) break;
  }
  const distance = percentile(distances, checked, 0.95);
  return checked && distance < 16 ? clamp(Math.ceil(distance / 2) + 1, 2, 16) : tankDefaults.iterations;
}

export function analyzeTank(pixels: Uint8ClampedArray, width: number, height: number, preset?: Partial<TankOptions> | null): TankAnalysis {
  if (preset) return { kind: "prism", confidence: "preset", summary: "已读取 Prism 内嵌参数", candidates: [{ label: "内嵌参数", options: { ...tankDefaults, ...preset, mode: "prism" } }] };
  const offsets = sampleOffsets(width, height), trials: Trial[] = [];
  for (const bright of [false, true]) {
    for (const span of [8, 12, 16, 24, 32, 48, 64, 96]) trials.push(prismTrial(pixels, width, height, offsets, span, bright));
    const best = trials.filter(trial => (trial.options.lower > 0) === bright).sort((a, b) => b.score - a.score).slice(0, 2);
    for (const trial of best) {
      if (!trials.some(other => other.options.lower === (bright ? 255 - trial.endpoint : 0) && other.options.upper === (bright ? 255 : trial.endpoint))) {
        trials.push(prismTrial(pixels, width, height, offsets, trial.endpoint, bright));
      }
    }
  }
  trials.sort((a, b) => b.score - a.score || a.options.upper - a.options.lower - (b.options.upper - b.options.lower));
  const best = trials[0], opposite = trials.find(trial => (trial.options.lower > 0) !== (best.options.lower > 0));
  const automatic = best.strong && (!opposite?.strong || best.score - opposite.score >= 0.12);
  if (automatic) {
    const candidates = trials.filter(trial => trial.score >= best.score * 0.7).slice(0, 3).map(trial => ({ label: trial.label,
      options: { ...trial.options, iterations: fillIterations(pixels, width, height, offsets, trial.options) } }));
    return { kind: "prism", confidence: "strong", summary: "疑似光棱坦克 · 色阶与交错特征较强", candidates };
  }
  let transparent = 0;
  const composites = (["black", "white"] as const).map(mode => {
    const histogram = new Uint32Array(256), levels = new Uint32Array(256);
    let count = 0;
    for (const offset of offsets) {
      const alpha = pixels[offset + 3] / 255;
      if (mode === "black" && alpha < 0.98) transparent++;
      for (let c = 0; c < 3; c++) histogram[Math.round(pixels[offset + c] * alpha + (mode === "white" ? 255 * (1 - alpha) : 0))]++;
      levels[Math.round(luminance(pixels, offset) * alpha + (mode === "white" ? 255 * (1 - alpha) : 0))]++;
      count += 3;
    }
    const spread = percentile(levels, count / 3, 0.95) - percentile(levels, count / 3, 0.05);
    return { label: mode === "black" ? "黑底幻影" : "白底幻影", options: { ...tankDefaults, mode, contrast: spread >= 24 ? suggestedContrast(histogram, count) : 0 }, spread };
  }).sort((a, b) => b.spread - a.spread);
  if (transparent / offsets.length >= 0.02) return { kind: "transparent", confidence: "uncertain", summary: "检测到透明度 · 是否为幻影坦克无法确定",
    candidates: composites.map(({ label, options }) => ({ label, options })) };
  const dark = trials.find(trial => trial.options.lower === 0)!, bright = trials.find(trial => trial.options.upper === 255)!;
  const candidates = [dark, bright].sort((a, b) => b.score - a.score).map(trial => ({ label: trial.label,
    options: trial.score > 0 ? trial.options : { ...tankDefaults, lower: trial.options.lower === 0 ? 0 : 231, upper: trial.options.lower === 0 ? 24 : 255 } }));
  return { kind: best.score >= 0.3 ? "prism" : "unknown", confidence: "uncertain",
    summary: best.score >= 0.3 ? "疑似光棱坦克 · 特征不足，需人工确认" : "未发现可靠的坦克特征", candidates };
}
