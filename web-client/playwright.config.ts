import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env["TEST_URL"] ?? "https://clyeh.github.io/furious-tp/",
  },
  reporter: [["list"]],
});
