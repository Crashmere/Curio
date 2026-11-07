// Prism algorithms adapted from TankFactory/Mirage_Decode (MIT). See THIRD_PARTY_NOTICES.md.
export type TankOptions = {
  mode: "prism" | "black" | "white";
  lower: number;
  upper: number;
  contrast: number;
  fill: "black" | "white" | "transparent" | "lcopy" | "tcopy" | "ltavg";
  iterations: number;
};
export const tankDefaults: TankOptions = { mode: "prism", lower: 0, upper: 24, contrast: 0, fill: "ltavg", iterations: 16 };
export const tankMaxBytes = 64 * 1024 * 1024;
export const tankMaxPixels = 16_000_000;
export const tankPreviewEdge = 1280;

export function resizeTankPreview(source: Uint8ClampedArray, width: number, height: number) {
  const scale = Math.min(1, tankPreviewEdge / Math.max(width, height));
  const previewWidth = Math.max(1, Math.round(width * scale));
  const previewHeight = Math.max(1, Math.round(height * scale));
  if (scale === 1) return { pixels: source.slice(), width, height };
  const pixels = new Uint8ClampedArray(previewWidth * previewHeight * 4);
  for (let y = 0; y < previewHeight; y++) {
    const sourceY = (y + 0.5) * height / previewHeight - 0.5;
    const top = Math.max(0, Math.floor(sourceY));
    const bottom = Math.min(height - 1, top + 1);
    const dy = sourceY - top;
    for (let x = 0; x < previewWidth; x++) {
      const sourceX = (x + 0.5) * width / previewWidth - 0.5;
      const left = Math.max(0, Math.floor(sourceX));
      const right = Math.min(width - 1, left + 1);
      const dx = sourceX - left;
      const target = (y * previewWidth + x) * 4;
      for (let c = 0; c < 4; c++) pixels[target + c] =
        source[(top * width + left) * 4 + c] * (1 - dx) * (1 - dy)
        + source[(top * width + right) * 4 + c] * dx * (1 - dy)
        + source[(bottom * width + left) * 4 + c] * (1 - dx) * dy
        + source[(bottom * width + right) * 4 + c] * dx * dy;
    }
  }
  return { pixels, width: previewWidth, height: previewHeight };
}

export function decodeTankCPU(source: Uint8ClampedArray, width: number, options: TankOptions) {
  const output = new Uint8ClampedArray(source.length);
  const { mode, lower, upper, fill } = options;
  for (let i = 0; i < source.length; i += 4) {
    if (mode !== "prism") {
      const alpha = source[i + 3] / 255;
      const background = mode === "white" ? 255 : 0;
      for (let c = 0; c < 3; c++) output[i + c] = source[i + c] * alpha + background * (1 - alpha);
      output[i + 3] = 255;
      continue;
    }
    const luminance = source[i] * 0.299 + source[i + 1] * 0.587 + source[i + 2] * 0.114;
    if (luminance >= lower && luminance <= upper) {
      for (let c = 0; c < 3; c++) output[i + c] = (source[i + c] - lower) * 255 / (upper - lower);
      output[i + 3] = source[i + 3];
    } else if (fill === "white" || fill === "black") {
      output.fill(fill === "white" ? 255 : 0, i, i + 3);
      output[i + 3] = 255;
    } else if (fill !== "transparent") {
      const left = i % (width * 4) !== 0;
      const top = i >= width * 4;
      const copy = fill === "lcopy" ? (left ? i - 4 : -1) : fill === "tcopy" ? (top ? i - width * 4 : -1)
        : left ? i - 4 : top ? i - width * 4 : -1;
      if (copy < 0) output[i + 3] = 255;
      else for (let c = 0; c < 4; c++) output[i + c] = fill === "ltavg" && left && top
        ? (output[i - 4 + c] + output[i - width * 4 + c] + output[i - width * 4 - 4 + c]) / 3
        : output[copy + c];
    }
  }
  return output;
}

export function adjustTankContrast(pixels: Uint8ClampedArray, contrast: number) {
  if (!contrast) return;
  const factor = 259 * (contrast + 255) / (255 * (259 - contrast));
  for (let i = 0; i < pixels.length; i += 4) {
    for (let c = 0; c < 3; c++) pixels[i + c] = factor * (pixels[i + c] - 128) + 128;
  }
}

function parsePreset(text: string): Partial<TankOptions> | null {
  const value = text.replace(/\0.*$/, "");
  if (!/^[01][0-9a-f]{2}(?:[0-9a-f]{2})?$/i.test(value)) return null;
  const threshold = parseInt(value.slice(1, 3), 16);
  if (!threshold) return null;
  const contrast = value.length === 5 ? parseInt(value.slice(3, 5), 16) : 50;
  if (contrast > 100) return null;
  return {
    lower: value[0] === "1" ? 255 - threshold : 0,
    upper: value[0] === "1" ? 255 : threshold,
    contrast: Math.max(-255, Math.min(255, (50 - contrast) * 255 / 50))
  };
}

export function readTankPreset(buffer: ArrayBuffer): Partial<TankOptions> | null {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const text = (start: number, end: number) => new TextDecoder("latin1").decode(bytes.subarray(start, end));
  if (bytes.length >= 8 && bytes[0] === 137 && text(1, 8) === "PNG\r\n\x1a\n") {
    for (let pos = 8; pos + 12 <= bytes.length;) {
      const length = view.getUint32(pos);
      if (length > bytes.length - pos - 12) break;
      if (text(pos + 4, pos + 8) === "tEXt" && length <= 256) {
        const preset = parsePreset(text(pos + 8, pos + 8 + length));
        if (preset) return preset;
      }
      pos += length + 12;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    for (let pos = 2; pos + 4 <= bytes.length;) {
      if (bytes[pos++] !== 255) break;
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (pos + 2 > bytes.length) break;
      const length = view.getUint16(pos);
      if (length < 2 || length > bytes.length - pos) break;
      if (marker === 225 && text(pos + 2, pos + 8) === "Exif\0\0") {
        const tiff = pos + 8;
        const end = pos + length;
        const little = text(tiff, tiff + 2) === "II";
        if (tiff + 8 <= end && (little || text(tiff, tiff + 2) === "MM") && view.getUint16(tiff + 2, little) === 42) {
          const directory = tiff + view.getUint32(tiff + 4, little);
          if (directory + 2 <= end) {
            const count = view.getUint16(directory, little);
            for (let entry = directory + 2; entry + 12 <= end && entry < directory + 2 + count * 12; entry += 12) {
              if (view.getUint16(entry, little) !== 271 || view.getUint16(entry + 2, little) !== 2) continue;
              const size = view.getUint32(entry + 4, little);
              const start = size <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, little);
              if (size > 0 && size <= 256 && start + size <= end) {
                const preset = parsePreset(text(start, start + size));
                if (preset) return preset;
              }
            }
          }
        }
      }
      pos += length;
    }
  }
  return null;
}
