import { defineConfig } from "@playwright/test";

// Two targets, one harness:
//   TEST_URL set   — the deployed test environment (test-deploy.yml).
//   TEST_URL unset — the locally built site, served exactly as the deploy
//                    assembles it, so a local run and a deployed run exercise
//                    the same page.
const deployed = process.env["TEST_URL"];
const LOCAL_URL = "http://127.0.0.1:4173/";

// Normalize: page.goto("./") resolves against baseURL per URL semantics, so a
// missing trailing slash would silently drop the /furious-tp/ subpath.
const baseURL = deployed ? (deployed.endsWith("/") ? deployed : `${deployed}/`) : LOCAL_URL;

export default defineConfig({
  testDir: "./e2e",
  retries: 1,
  // Cesium fetches its workers, then a 3 MB tileset, then the tiles themselves,
  // and rasterises downtown Taipei in software — there is no GPU on a CI
  // runner, and none in headless Chromium here either.
  timeout: 600_000,
  // One at a time, for the same reason: parallel browsers share one CPU, and
  // the software rasteriser is the bottleneck. Two workers made the heavy spec
  // roughly twice as slow as running it alone.
  workers: 1,
  expect: { timeout: 60_000 },
  use: { baseURL, viewport: { width: 1280, height: 800 } },
  reporter: [["list"]],
  ...(deployed
    ? {}
    : {
        webServer: {
          command: "npm run serve:site",
          url: LOCAL_URL,
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }),
});
