import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, gzipSync } from "node:zlib";

let originalBytes = 0;
let compressedBytes = 0;

async function compressDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await compressDirectory(path);
    } else if (entry.isFile() && /\.(?:js|css)$/.test(entry.name)) {
      const original = await readFile(path);
      const compressed = gzipSync(original, { level: constants.Z_BEST_COMPRESSION });
      await writeFile(`${path}.gz`, compressed);
      originalBytes += original.length;
      compressedBytes += compressed.length;
    }
  }
}

await compressDirectory(fileURLToPath(new URL("../web/dist/", import.meta.url)));
console.log(`Precompressed JS/CSS: ${originalBytes} -> ${compressedBytes} bytes`);
