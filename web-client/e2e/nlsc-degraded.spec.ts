import { expect, test } from "@playwright/test";

import { readSceneProbe, waitForSceneReady } from "./scene-probe.js";

/**
 * The other half of AC2's invariant, made deterministic.
 *
 * The ticket's Verification Steps ask for "模擬 NLSC 404/timeout → 場景仍啟動並
 * 記錄告警", and FTP-9 carries the story-level degradation AC. Both were only
 * observed by unit tests against a stub, plus an `if/else` in `smoke.spec.ts`
 * whose degraded branch ran only when the live service happened to be broken —
 * so on a healthy day nothing watched `bootScene`'s failure wiring at all.
 *
 * A mutant that hardcoded `setTilesetLoaded(true)` survived the entire suite
 * because of that gap: a frame with no buildings in it, under a status line
 * reading "NLSC 建物已載入". Blocking the host at the network layer reproduces
 * the failure on every run, in seconds, without touching the real service.
 */
test.describe("NLSC 不可用", () => {
  test.beforeEach(async ({ page }) => {
    // Everything on the host: the tileset, its tiles, and the fingerprint
    // check's own request all have to fail for this to be the degraded path.
    await page.route("**://3dtiles.nlsc.gov.tw/**", (route) => route.abort());
  });

  test("場景仍然啟動", async ({ page }) => {
    await page.goto("./");
    await waitForSceneReady(page);

    const probe = await readSceneProbe(page);
    expect(probe.error, "場景啟動時丟出例外").toBeNull();
    expect(await page.locator("#scene canvas").count()).toBeGreaterThan(0);
    // The renderer is not merely constructed, it is drawing.
    await page.waitForFunction(
      () =>
        ((globalThis as { __ftpScene?: { framesRendered: number } }).__ftpScene?.framesRendered ??
          0) > 0,
      undefined,
      { timeout: 60_000 },
    );
  });

  test("狀態列說的是實話,不是「已載入」", async ({ page }) => {
    await page.goto("./");
    await waitForSceneReady(page);

    const probe = await readSceneProbe(page);
    expect(probe.tilesetLoaded).toBe(false);

    const status = await page.locator("#scene-status").textContent();
    expect(status).toContain("降級模式");
    // The half that the surviving mutant broke: claiming success over an empty
    // scene. Asserting the absence is the point, not decoration.
    expect(status).not.toContain("NLSC 建物已載入");
  });

  test("告警說得出是誰壞了", async ({ page }) => {
    await page.goto("./");
    await waitForSceneReady(page);

    const probe = await readSceneProbe(page);
    const warnings = probe.warnings.join(" ");
    expect(warnings).toContain("NLSC");
    expect(warnings).toContain("建物");
    // A degradation message nobody can act on is not a degradation path.
    expect(warnings).not.toContain("[object Object]");
    expect(warnings).not.toContain("undefined");
  });

  test("畫面沒有建物,而量測看得出來", async ({ page }) => {
    await page.goto("./");
    await waitForSceneReady(page);
    await page.waitForTimeout(3_000);

    // The same instrument AC2 uses, pointed at the opposite case: if this could
    // not tell an empty scene from a full one, AC2's evidence would be worth
    // nothing either. Measured here rather than assumed.
    const { readRenderedFrameStats } = await import("./scene-probe.js");
    const stats = await readRenderedFrameStats(page);
    expect(stats.nonDominantShare).toBeLessThan(0.25);
  });
});
