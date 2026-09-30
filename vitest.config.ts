import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: "forks",
    env: { PB4_COMMONS_GAP_MS: "0" }, // no Commons pacing in tests: fetch is always stubbed
  },
});
