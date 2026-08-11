import { expect, test } from "@playwright/test";

import { readSceneProbe, waitForSceneReady } from "./scene-probe.js";

test("the environment serves the built app, not just static HTML", async ({ page }) => {
  await page.goto("./");
  await expect(page).toHaveTitle(/furious-tp/);

  // The probe object only exists once the compiled dist/ module has run, so
  // this proves the deploy ships the build artifact — the same thing the old
  // scaffold probe proved, against the page that replaced it.
  await waitForSceneReady(page);
  const probe = await readSceneProbe(page);
  expect(probe.error).toBeNull();
});

test("the scene comes up whether or not NLSC answers", async ({ page }) => {
  await page.goto("./");
  await waitForSceneReady(page);

  // Invariant 1 of FTP-39, and the story-level degradation AC on FTP-9: losing
  // NLSC costs the buildings, never the scene. Asserted without reference to
  // whether NLSC is up, so it is meaningful on both paths.
  const canvasCount = await page.locator("#scene canvas").count();
  expect(canvasCount).toBeGreaterThan(0);

  const probe = await readSceneProbe(page);
  expect(probe.error).toBeNull();

  // The operator is told something, whichever path this run took.
  //
  // Deliberately NOT branching on `probe.tilesetLoaded` any more. This was an
  // if/else asserting the healthy wording in one arm and the degraded wording
  // in the other — so the degraded arm ran only when the live service happened
  // to be broken, which is a test that reads like coverage and is not. Each
  // path now has a spec that reaches it on every run: nlsc-buildings.spec.ts
  // for the healthy one, nlsc-degraded.spec.ts for the degraded one.
  const status = await page.locator("#scene-status").textContent();
  expect(status?.trim().length ?? 0).toBeGreaterThan(0);
});
