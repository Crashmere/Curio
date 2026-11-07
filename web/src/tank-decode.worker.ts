import { adjustTankContrast, decodeTankCPU, TankOptions } from "./tank-decode";
import { TankGPU } from "./tank-decode-gpu";

let pixels: Uint8ClampedArray;
let width: number;
let gpu: TankGPU | null = null;
self.onmessage = (event: MessageEvent) => {
  const { id, type, options } = event.data as { id: number; type: string; options: TankOptions; pixels: Uint8ClampedArray; width: number; height: number };
  try {
    if (type === "init") {
      pixels = event.data.pixels;
      width = event.data.width;
      try { gpu = new TankGPU(width, event.data.height, pixels); } catch { gpu = null; }
      self.postMessage({ type: "ready" });
      return;
    }
    let output: Uint8ClampedArray | undefined;
    let engine = "CPU";
    if (gpu && (options.mode !== "prism" || options.fill !== "lcopy" && options.fill !== "tcopy")) {
      try { output = gpu.decode(options); engine = "GPU"; } catch { gpu = null; }
    }
    output ??= decodeTankCPU(pixels, width, options);
    adjustTankContrast(output, options.contrast);
    self.postMessage({ type: "result", id, pixels: output, engine }, { transfer: [output.buffer] });
  } catch (error) {
    self.postMessage({ type: "error", id, error: error instanceof Error ? error.message : String(error) });
  }
};
