import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/indexer-main.ts", "src/economic-main.ts", "src/monitor-main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  noExternal: [/^@liftoff\//],
  // Dependensi npm (termasuk milik paket workspace, mis. Raydium SDK) TIDAK di-bundle: modul CJS
  // yang di-bundle ke ESM gagal saat `node dist/...` ("Dynamic require ... not supported").
  // Image Docker produksi menyediakan node_modules (Tahap 10b).
  external: [/^(?!@liftoff\/)[^./]/],
});
