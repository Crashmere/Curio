import { createSHA256 } from "hash-wasm";

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data;
    const hash = await createSHA256();
    hash.init();
    const block = 8 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += block) {
      hash.update(new Uint8Array(await file.slice(offset, offset + block).arrayBuffer()));
      self.postMessage({ progress: Math.min(1, (offset + block) / file.size) });
    }
    self.postMessage({ hash: hash.digest() });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
