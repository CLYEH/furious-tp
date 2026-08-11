import { describe, expect, it, vi } from "vitest";

import {
  TILESET_LOAD_ATTEMPTS,
  TILESET_LOAD_TIMEOUT_MS,
  TILESET_RETRY_DELAY_MS,
  loadNlscTileset,
} from "./tileset.js";

const URL_UNDER_TEST = "https://3dtiles.nlsc.gov.tw/building/tiles3d/22/tileset.json";

/** Stand-in for a Cesium3DTileset — this seam does not care what it is. */
const HANDLE = { id: "tileset" };

/** Never actually wait, in any case that is not about waiting. */
const instant = { sleep: () => Promise.resolve(), retryDelayMs: 0 };

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

  it("does not retry a load that worked", async () => {
    const load = vi.fn().mockResolvedValue(HANDLE);
    await loadNlscTileset(URL_UNDER_TEST, { load, onWarning: vi.fn() }, instant);
    expect(load).toHaveBeenCalledTimes(1);
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
      loadNlscTileset(
        URL_UNDER_TEST,
        { load: () => Promise.reject(thrown), onWarning: vi.fn() },
        instant,
      ),
    ).resolves.toBeNull();
  });

  it.each(failures)("records a warning on %s", async (_name, thrown) => {
    const onWarning = vi.fn();
    await loadNlscTileset(
      URL_UNDER_TEST,
      { load: () => Promise.reject(thrown), onWarning },
      instant,
    );
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it("survives a loader that throws synchronously", async () => {
    const onWarning = vi.fn();
    await expect(
      loadNlscTileset(
        URL_UNDER_TEST,
        {
          load: () => {
            throw new Error("constructed badly");
          },
          onWarning,
        },
        instant,
      ),
    ).resolves.toBeNull();
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  // What the user sees. A warning that says "Error: [object Object]" is not a
  // degradation path, it is a bug report nobody can act on.
  it("says what failed, in the project's language, naming the source", async () => {
    const onWarning = vi.fn();
    await loadNlscTileset(
      URL_UNDER_TEST,
      { load: () => Promise.reject(new Error("Request has failed.")), onWarning },
      instant,
    );
    const message = onWarning.mock.calls[0]?.[0] as string;
    expect(message).toContain("NLSC");
    expect(message).toContain("建物");
    expect(message).toContain(URL_UNDER_TEST);
    expect(message).toContain("Request has failed.");
  });

  it("still produces a readable warning when the failure carries no message", async () => {
    const onWarning = vi.fn();
    await loadNlscTileset(
      URL_UNDER_TEST,
      { load: () => Promise.reject(null), onWarning },
      instant,
    );
    const message = onWarning.mock.calls[0]?.[0] as string;
    expect(message).toContain("NLSC");
    expect(message).not.toContain("[object Object]");
  });
});

// Added after the browser found it: the first e2e run left the scene stuck
// reporting nothing for over two minutes because the load never settled.
describe("loadNlscTileset — a load that never settles", () => {
  const hangs = () => new Promise<typeof HANDLE>(() => undefined);

  it("gives up rather than hanging forever", async () => {
    const onWarning = vi.fn();
    await expect(
      loadNlscTileset(
        URL_UNDER_TEST,
        { load: hangs, onWarning },
        { ...instant, timeoutMs: 20, attempts: 1 },
      ),
    ).resolves.toBeNull();
    expect(onWarning.mock.calls[0]?.[0]).toContain("逾時");
  });

  it("does not time out a load that answers in time", async () => {
    const onWarning = vi.fn();
    await expect(
      loadNlscTileset(
        URL_UNDER_TEST,
        {
          load: () => new Promise((resolve) => setTimeout(() => resolve(HANDLE), 1)),
          onWarning,
        },
        { ...instant, timeoutMs: 5_000 },
      ),
    ).resolves.toBe(HANDLE);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("bounds the wait by default, without the caller having to ask", () => {
    expect(TILESET_LOAD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TILESET_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

// The endpoint was measured serving a decodable tileset on 4 requests out of 20
// on 2026-08-11. One attempt against that is a coin toss, not a load.
describe("loadNlscTileset — an intermittently wrong source", () => {
  it("succeeds on a later attempt", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("ERR_CONTENT_DECODING_FAILED"))
      .mockResolvedValueOnce(HANDLE);
    const onWarning = vi.fn();
    await expect(
      loadNlscTileset(URL_UNDER_TEST, { load, onWarning }, instant),
    ).resolves.toBe(HANDLE);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("retries a timed-out attempt too, not only a rejected one", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(HANDLE);
    await expect(
      loadNlscTileset(
        URL_UNDER_TEST,
        { load, onWarning: vi.fn() },
        { ...instant, timeoutMs: 20 },
      ),
    ).resolves.toBe(HANDLE);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("stops after the attempt budget rather than retrying forever", async () => {
    const load = vi.fn().mockRejectedValue(new Error("still broken"));
    const onWarning = vi.fn();
    await expect(
      loadNlscTileset(URL_UNDER_TEST, { load, onWarning }, { ...instant, attempts: 3 }),
    ).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it("names every attempt in the one warning it raises", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("第一種壞法"))
      .mockRejectedValueOnce(new Error("第二種壞法"))
      .mockRejectedValueOnce(new Error("第三種壞法"));
    const onWarning = vi.fn();
    await loadNlscTileset(URL_UNDER_TEST, { load, onWarning }, { ...instant, attempts: 3 });
    const message = onWarning.mock.calls[0]?.[0] as string;
    expect(message).toContain("第一種壞法");
    expect(message).toContain("第二種壞法");
    expect(message).toContain("第三種壞法");
    expect(message).toContain("3 次嘗試");
  });

  it("waits between attempts instead of hammering the service", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockRejectedValue(new Error("broken"));
    await loadNlscTileset(
      URL_UNDER_TEST,
      { load, onWarning: vi.fn() },
      { attempts: 3, retryDelayMs: 250, sleep },
    );
    // Between attempts, not after the last one.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("does not wait after an attempt that succeeded", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await loadNlscTileset(
      URL_UNDER_TEST,
      { load: () => Promise.resolve(HANDLE), onWarning: vi.fn() },
      { retryDelayMs: 250, sleep },
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  // FTP-5 R7: do not lean on a public government service. The budget is a
  // product decision, so it is pinned rather than left to drift upwards.
  it("keeps the retry budget small and the pause real", () => {
    expect(TILESET_LOAD_ATTEMPTS).toBeGreaterThan(1);
    expect(TILESET_LOAD_ATTEMPTS).toBeLessThanOrEqual(3);
    expect(TILESET_RETRY_DELAY_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("makes exactly one attempt when asked for one", async () => {
    const load = vi.fn().mockRejectedValue(new Error("broken"));
    await loadNlscTileset(URL_UNDER_TEST, { load, onWarning: vi.fn() }, { ...instant, attempts: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
