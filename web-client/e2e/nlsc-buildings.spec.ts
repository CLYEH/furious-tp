import { expect, test } from "@playwright/test";

import { M1_BBOX_WGS84, isInsideM1Bbox } from "../src/config/scene.js";
import {
  type FrameStats,
  readRenderedFrameStats,
  readSceneProbe,
  waitForSceneReady,
} from "./scene-probe.js";

/**
 * FTP-39 AC2: "本地 dev server 於信義 bbox 顯示 NLSC 建物(PR 附截圖)".
 *
 * Written so that it cannot pass without real NLSC data: it asserts the tileset
 * resolved, that the camera that produced the frame was inside the M1 area, and
 * that the frame carries geometry rather than one flat colour. No fixture, no
 * fallback — if the service is not serving decodable tiles this goes red, which
 * is the correct report. It did exactly that for most of 2026-08-11.
 */

/** A frame with buildings in it. Fixed up front, never relaxed to fit a run. */
const HAS_GEOMETRY = (s: FrameStats): boolean => s.distinctColours > 50 && s.nonDominantShare > 0.25;

test("信義區 NLSC 建物出現在畫面上", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("./");
  await waitForSceneReady(page);

  const booted = await readSceneProbe(page);
  expect(
    booted.tilesetLoaded,
    `NLSC tileset 未載入。警告:${booted.warnings.join(" | ")};console:${consoleErrors.join(" | ")}`,
  ).toBe(true);

  // The render loop is alive. Under a software rasteriser a frame of downtown
  // Taipei costs seconds, so this is a liveness check, not a progress bar.
  const startFrames = booted.framesRendered;
  await page.waitForFunction(
    (n) =>
      ((globalThis as { __ftpScene?: { framesRendered: number } }).__ftpScene?.framesRendered ??
        0) > n + 2,
    startFrames,
    { timeout: 120_000 },
  );

  // Then wait for the picture to actually contain something. Tiles stream in,
  // so the frame is not final the instant the tileset resolves. The criterion
  // is fixed above and is the same one asserted at the end — this waits for a
  // state, it does not relax a threshold to whatever the run produced.
  let stats = await readRenderedFrameStats(page);
  const progression: FrameStats[] = [stats];
  const deadline = Date.now() + 420_000;
  while (!HAS_GEOMETRY(stats) && Date.now() < deadline) {
    await page.waitForTimeout(5_000);
    stats = await readRenderedFrameStats(page);
    progression.push(stats);
  }
  testInfo.annotations.push({
    type: "frame-progression",
    description: progression.map((s) => `${s.distinctColours}/${s.nonDominantShare.toFixed(3)}`).join(" → "),
  });

  // Tie the picture to the place. Without this the frame only proves "a city";
  // read back from the renderer, it proves the camera that produced this frame
  // was inside the M1 area contracts/ defines (invariant 4).
  const settled = await readSceneProbe(page);
  expect(settled.camera, "renderer reported no camera position").not.toBeNull();
  const { longitude, latitude } = settled.camera ?? { longitude: NaN, latitude: NaN };
  expect(
    isInsideM1Bbox(longitude, latitude),
    `相機在 M1 bbox 之外:${longitude}, ${latitude} vs ${JSON.stringify(M1_BBOX_WGS84)}`,
  ).toBe(true);
  testInfo.annotations.push({ type: "camera", description: JSON.stringify(settled.camera) });

  // D5, end to end and against the real service. Every other fingerprint case
  // runs on a fetch mock; this is the one that proves the digest is really
  // computed in a browser, from a real NLSC response, and really persisted —
  // which is what "首次記錄" has to mean for the next session to compare.
  const record = await page
    .waitForFunction(
      () => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith("ftp:nlsc-tileset-watch:")) return localStorage.getItem(key);
        }
        return null;
      },
      undefined,
      { timeout: 120_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<string>);
  const parsed = JSON.parse(record) as {
    url: string;
    establishedHash: string | null;
    observations: { hash: string; count: number }[];
  };
  expect(parsed.url).toContain("3dtiles.nlsc.gov.tw");
  expect(parsed.establishedHash, "no fingerprint was recorded").toMatch(/^[0-9a-f]{64}$/);
  expect(parsed.observations).toHaveLength(1);
  expect(parsed.observations[0]?.hash).toBe(parsed.establishedHash);
  testInfo.annotations.push({ type: "fingerprint", description: parsed.establishedHash ?? "none" });

  const screenshot = testInfo.outputPath("xinyi-nlsc-buildings.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("xinyi-nlsc-buildings", { path: screenshot, contentType: "image/png" });

  // A frame of buildings has structure. The empty-scene failure is one colour
  // over the whole canvas.
  expect(
    stats.distinctColours,
    `畫面只有 ${stats.distinctColours} 種顏色,可能是一片藍`,
  ).toBeGreaterThan(50);
  expect(stats.nonDominantShare).toBeGreaterThan(0.25);

  // CORS is not allowed to be the thing that broke (FTP-5 §2.3): the service
  // answers a preflight with 405, so a request carrying a header would fail.
  expect(consoleErrors.filter((e) => /CORS|Access-Control/i.test(e))).toEqual([]);
});
