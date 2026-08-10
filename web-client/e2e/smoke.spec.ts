import { expect, test } from "@playwright/test";

test("test environment serves the built app", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("h1")).toContainText("furious-tp");
  // The probe renders via the built dist/ module — proves the deploy ships
  // the compiled artifact, not just static HTML.
  await expect(page.locator("#probe")).toHaveText("hello, test-env");
});
