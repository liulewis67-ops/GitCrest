import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    setupFiles: ["tests/e2e/setup-profile.ts"],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
