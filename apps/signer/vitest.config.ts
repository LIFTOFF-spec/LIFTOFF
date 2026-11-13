import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test memakai database liftoff_test_signer yang sama → jalankan berurutan.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
