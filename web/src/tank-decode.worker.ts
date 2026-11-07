import { adjustTankContrast, decodeTankCPU, resizeTankPreview, tankPreviewEdge, TankOptions } from "./tank-decode";
import { TankGPU } from "./tank-decode-gpu";

let pixels: Uint8ClampedArray;
let width: number;
let height: number;
let gpu: TankGPU | null = null;
let cachedKey = "";
let cached: { full: Uint8ClampedArray; preview: ReturnType<typeof resizeTankPreview> } | null = null;
self.onmessage = (event: MessageEvent) => {
  const { id, type, options } = event.data as { id: number; type: string; options: TankOptions; pixels: Uint8ClampedArray; width: number; height: number };
  try {
    if (type === "init") {
      pixels = event.data.pixels;
      width = event.data.width;
      height = event.data.height;
      try { gpu = new TankGPU(width, event.data.height, pixels); } catch { gpu = null; }
      self.postMessage({ type: "ready" });
      return;
    }
    if (gpu && (options.mode !== "prism" || options.fill !== "lcopy" && options.fill !== "tcopy")) {
      try {
        if (type === "export") {
          const output = gpu.decode(options);
          self.postMessage({ type: "export", id, pixels: output, width, height }, { transfer: [output.buffer] });
        } else {
          const bitmap = gpu.preview(options, tankPreviewEdge);
          self.postMessage({ type: "result", id, bitmap, engine: "GPU" }, { transfer: [bitmap] });
        }
        return;
      } catch { gpu = null; }
    }
    const key = JSON.stringify([options.mode, options.lower, options.upper, options.fill, options.iterations]);
    if (!cached || cachedKey !== key) {
      const full = decodeTankCPU(pixels, width, options);
      cached = { full, preview: resizeTankPreview(full, width, height) };
      cachedKey = key;
    }
    const output = type === "export" ? cached.full.slice() : cached.preview.pixels.slice();
    adjustTankContrast(output, options.contrast);
    self.postMessage({ type: type === "export" ? "export" : "result", id, pixels: output,
      width: type === "export" ? width : cached.preview.width, height: type === "export" ? height : cached.preview.height, engine: "CPU" }, { transfer: [output.buffer] });
  } catch (error) {
    self.postMessage({ type: "error", id, error: error instanceof Error ? error.message : String(error) });
  }
};
