import { defineConfig } from "vitest/config";

// Unit tests only — e2e/*.spec.ts belongs to Playwright, not vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
