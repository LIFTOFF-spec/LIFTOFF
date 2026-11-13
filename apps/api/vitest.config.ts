import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Semua file test memakai database liftoff_test_api yang sama → jalankan berurutan.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
