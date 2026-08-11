import { describe, expect, it, vi } from "vitest";

import { STATUS_ELEMENT_ID, createStatusTracker, statusText } from "./status.js";

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

// Found by looking at the acceptance screenshot: the buildings were plainly on
// screen and the status line underneath them read "降級模式:無 NLSC 建物",
// because the caller re-rendered every warning with the flag hardcoded false.
describe("createStatusTracker", () => {
  it("starts degraded, because nothing has loaded yet", () => {
    const render = vi.fn();
    createStatusTracker(render).warn("某個問題");
    expect(render.mock.calls.at(-1)?.[0]).toContain("降級模式");
  });

  it("keeps reporting a loaded tileset when a later warning arrives", () => {
    const render = vi.fn();
    const tracker = createStatusTracker(render);
    tracker.setTilesetLoaded(true);
    tracker.warn("NLSC tileset 服務缺陷(undecodable):x");
    const text = render.mock.calls.at(-1)?.[0] as string;
    expect(text).toContain("NLSC 建物已載入");
    expect(text).not.toContain("降級模式");
    expect(text).toContain("服務缺陷");
  });

  it("renders on every change, so the page never shows a stale line", () => {
    const render = vi.fn();
    const tracker = createStatusTracker(render);
    tracker.setTilesetLoaded(true);
    tracker.warn("一");
    tracker.warn("二");
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("accumulates warnings rather than replacing them", () => {
    const render = vi.fn();
    const tracker = createStatusTracker(render);
    tracker.warn("一");
    tracker.warn("二");
    expect(tracker.warnings).toEqual(["一", "二"]);
    expect(render.mock.calls.at(-1)?.[0]).toContain("一");
    expect(render.mock.calls.at(-1)?.[0]).toContain("二");
  });

  it("can go back to degraded if the tileset is lost", () => {
    const render = vi.fn();
    const tracker = createStatusTracker(render);
    tracker.setTilesetLoaded(true);
    tracker.setTilesetLoaded(false);
    expect(render.mock.calls.at(-1)?.[0]).toContain("降級模式");
  });
});
