import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    setupFiles: ["@testing-library/jest-dom/vitest"],
    restoreMocks: true,
    clearMocks: true,
    // Bound jsdom workers on machines that expose many CPUs but have limited memory.
    maxWorkers: 4,
  },
});
