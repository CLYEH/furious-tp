import { describe, expect, it } from "vitest";

import { STATUS_ELEMENT_ID, statusText } from "./status.js";

// The only UI this ticket is allowed to ship ("UI(告警旗標除外)"): one line
// telling the operator whether the buildings are there and, if not, why.
describe("statusText", () => {
  it("reports a healthy scene", () => {
    expect(statusText({ tilesetLoaded: true, warnings: [] })).toContain("NLSC 建物已載入");
  });

  it("reports a degraded scene", () => {
    const text = statusText({ tilesetLoaded: false, warnings: ["NLSC 建物圖層載入失敗"] });
    expect(text).toContain("降級");
    expect(text).toContain("NLSC 建物圖層載入失敗");
  });

  it("shows every warning, not just the first", () => {
    const text = statusText({
      tilesetLoaded: false,
      warnings: ["第一個問題", "第二個問題", "第三個問題"],
    });
    expect(text).toContain("第一個問題");
    expect(text).toContain("第二個問題");
    expect(text).toContain("第三個問題");
  });

  // Boundary: buildings loaded AND a warning raised (a fingerprint alert on a
  // healthy scene). Neither half may swallow the other.
  it("shows warnings even when the tileset did load", () => {
    const text = statusText({
      tilesetLoaded: true,
      warnings: ["tileset 指紋改版:112_A → 114_A"],
    });
    expect(text).toContain("NLSC 建物已載入");
    expect(text).toContain("tileset 指紋改版:112_A → 114_A");
  });

  it("never renders an empty line", () => {
    expect(statusText({ tilesetLoaded: false, warnings: [] }).trim().length).toBeGreaterThan(0);
  });

  it("names the element the page renders into", () => {
    expect(STATUS_ELEMENT_ID).toBe("scene-status");
  });
});
