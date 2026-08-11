import { defineConfig } from "vitest/config";

// A second vitest project, for the same reason bench/tsconfig.json exists: the
// root vitest config's `include` is "src/**/*.test.ts" and this ticket's scope
// does not reach it. `npm test` runs both configs, so the bench exam is gated
// by the same command CI already runs — an ungated exam is not an exam.
//
// `root` is explicit because vitest resolves it from the working directory, not
// from where this config happens to live, and `npm test` runs from web-client/.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["src/**/*.test.ts"],
  },
});
