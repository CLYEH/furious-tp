import { describe, expect, it, vi } from "vitest";

import { loadNlscTileset } from "./tileset.js";

const URL_UNDER_TEST = "https://3dtiles.nlsc.gov.tw/building/tiles3d/22/tileset.json";

/** Stand-in for a Cesium3DTileset — this seam does not care what it is. */
const HANDLE = { id: "tileset" };

describe("loadNlscTileset — the happy path", () => {
  it("returns the tileset and warns about nothing", async () => {
    const onWarning = vi.fn();
    await expect(
      loadNlscTileset(URL_UNDER_TEST, { load: () => Promise.resolve(HANDLE), onWarning }),
    ).resolves.toBe(HANDLE);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("loads the url it was given", async () => {
    const load = vi.fn().mockResolvedValue(HANDLE);
    await loadNlscTileset(URL_UNDER_TEST, { load, onWarning: vi.fn() });
    expect(load).toHaveBeenCalledWith(URL_UNDER_TEST);
  });
});

// Invariant 1 of this ticket, and RFC D6's degradation path: NLSC going away
// costs the buildings, never the scene. Every case here asserts BOTH halves —
// that nothing was thrown, and that the operator was told.
describe("loadNlscTileset — NLSC unavailable", () => {
  const failures: [string, unknown][] = [
    ["a rejected promise", new Error("Request has failed.")],
    ["a network TypeError", new TypeError("Failed to fetch")],
    ["a timeout", new DOMException("aborted", "TimeoutError")],
    ["a non-Error rejection", "just a string"],
  ];

  it.each(failures)("returns null instead of throwing on %s", async (_name, thrown) => {
    await expect(
      loadNlscTileset(URL_UNDER_TEST, {
        load: () => Promise.reject(thrown),
        onWarning: vi.fn(),
      }),
    ).resolves.toBeNull();
  });

  it.each(failures)("records a warning on %s", async (_name, thrown) => {
    const onWarning = vi.fn();
    await loadNlscTileset(URL_UNDER_TEST, { load: () => Promise.reject(thrown), onWarning });
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it("survives a loader that throws synchronously", async () => {
    const onWarning = vi.fn();
    await expect(
      loadNlscTileset(URL_UNDER_TEST, {
        load: () => {
          throw new Error("constructed badly");
        },
        onWarning,
      }),
    ).resolves.toBeNull();
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  // What the user sees. A warning that says "Error: [object Object]" is not a
  // degradation path, it is a bug report nobody can act on.
  it("says what failed, in the project's language, naming the source", async () => {
    const onWarning = vi.fn();
    await loadNlscTileset(URL_UNDER_TEST, {
      load: () => Promise.reject(new Error("Request has failed.")),
      onWarning,
    });
    const message = onWarning.mock.calls[0]?.[0] as string;
    expect(message).toContain("NLSC");
    expect(message).toContain("建物");
    expect(message).toContain(URL_UNDER_TEST);
    expect(message).toContain("Request has failed.");
  });

  it("still produces a readable warning when the failure carries no message", async () => {
    const onWarning = vi.fn();
    await loadNlscTileset(URL_UNDER_TEST, { load: () => Promise.reject(null), onWarning });
    const message = onWarning.mock.calls[0]?.[0] as string;
    expect(message).toContain("NLSC");
    expect(message).not.toContain("[object Object]");
  });
});
