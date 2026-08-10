import { defineConfig } from "@playwright/test";

// Normalize: page.goto("./") resolves against baseURL per URL semantics, so a
// missing trailing slash would silently drop the /furious-tp/ subpath.
const raw = process.env["TEST_URL"] ?? "https://clyeh.github.io/furious-tp/";
const baseURL = raw.endsWith("/") ? raw : `${raw}/`;

export default defineConfig({
  testDir: "./e2e",
  retries: 1,
  use: { baseURL },
  reporter: [["list"]],
});
