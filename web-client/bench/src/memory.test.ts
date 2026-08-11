/**
 * Exam for the 15-minute memory cycle measurement (RFC D6: "記憶體 = 15 分鐘循環
 * 後 JS heap(強制 GC 後)與 GPU memory 成長 <10%").
 *
 * FTP-48 owns the MEASUREMENT; the <10% judgment is FTP-49's. So nothing here
 * asserts a threshold — it asserts that the number produced is the growth that
 * actually happened, and that the part we cannot measure says so out loud
 * instead of reporting a comfortable zero.
 *
 * Grid — invariant x failure mode x time:
 *   I2 statistics correctness
 *     - growth computed against the wrong baseline ....... at summary time
 *     - division by a zero baseline yields Infinity ...... at summary time
 *   I3 report honesty
 *     - an unmeasurable quantity reported as 0 ........... at summary time
 *     - too few samples summarised anyway ................ at summary time
 *   permissions / concurrency: N/A — pure arithmetic over an already-collected
 *   series; the collection itself lives in the driver.
 */

import { describe, expect, it } from "vitest";

import { summariseMemory } from "./memory.ts";

const sample = (atMs: number, usedHeapBytes: number) => ({ atMs, usedHeapBytes });

describe("summariseMemory", () => {
  it("measures growth between the first and last post-GC samples", () => {
    const result = summariseMemory([
      sample(0, 100_000_000),
      sample(450_000, 104_000_000),
      sample(900_000, 110_000_000),
    ]);
    expect(result.startBytes).toBe(100_000_000);
    expect(result.endBytes).toBe(110_000_000);
    expect(result.growthRatio).toBeCloseTo(0.1, 10);
    expect(result.durationMs).toBe(900_000);
  });

  it("reports a shrinking heap as negative growth", () => {
    // Not clamped to zero: a heap that shrank is information, and clamping it
    // would hide a measurement that disagrees with the model.
    const result = summariseMemory([sample(0, 100), sample(1_000, 80)]);
    expect(result.growthRatio).toBeCloseTo(-0.2, 10);
  });

  it("keeps every sample it was given", () => {
    // The shape of the curve distinguishes a leak from a one-off allocation,
    // and only the raw series can show it.
    const samples = [sample(0, 100), sample(500, 150), sample(1_000, 120)];
    expect(summariseMemory(samples).samples).toEqual(samples);
  });

  it("says GPU memory is unmeasured rather than reporting it as zero", () => {
    // D6 asks for GPU memory growth too. A page cannot read it, and `0` would
    // read as "no growth" — the most flattering possible lie. `null` plus a
    // stated reason is the honest shape, and FTP-49 can decide what to do
    // about the gap.
    const result = summariseMemory([sample(0, 100), sample(1_000, 110)]);
    expect(result.gpuBytes).toBeNull();
    expect(result.gpuNote).not.toBe("");
    expect(result.gpuNote.length).toBeGreaterThan(10);
  });

  it.each([
    ["no samples", []],
    ["a single sample", [sample(0, 100)]],
  ])("throws on %s instead of inventing a growth figure", (_label, samples) => {
    // One sample cannot show growth. Returning 0 would be a fabricated pass.
    expect(() => summariseMemory(samples)).toThrow(RangeError);
  });

  it("throws rather than dividing by a zero baseline", () => {
    // (end - 0) / 0 is Infinity, which JSON.stringify writes as null: the
    // report would carry a null growth and still claim to be valid.
    expect(() => summariseMemory([sample(0, 0), sample(1_000, 100)])).toThrow();
  });

  it.each([
    ["negative", [sample(0, 100), sample(1_000, -5)]],
    ["NaN", [sample(0, 100), sample(1_000, NaN)]],
    ["Infinity", [sample(0, 100), sample(1_000, Infinity)]],
  ])("rejects a %s heap reading", (_label, samples) => {
    expect(() => summariseMemory(samples)).toThrow();
  });

  it("rejects samples that are not in chronological order", () => {
    // first/last are taken by position, so an out-of-order series would measure
    // growth backwards without any other symptom.
    expect(() =>
      summariseMemory([sample(1_000, 100), sample(0, 110), sample(2_000, 120)]),
    ).toThrow();
  });
});
