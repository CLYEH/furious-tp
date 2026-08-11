/**
 * Exam for the frame-time statistics (RFC D6: "frame time p50/p95/p99 + 1% low",
 * "無 >100ms hitch").
 *
 * Why these cases and not a golden file: every number below is derived from a
 * stated definition, so the test fails when the DEFINITION drifts, not merely
 * when the output changes. A snapshot regenerated on failure would assert
 * nothing at all.
 *
 * Grid — invariant x failure mode x time:
 *   I2 statistics correctness
 *     - definition drift (percentile rank, 1% low sample count) .... at summary time
 *     - boundary handling (exactly 100 ms, n=1, n=2) ............... at summary time
 *     - poisoned input (NaN/Infinity/negative) ..................... at ingest time
 *     - empty series reported as a perfect score .................. at summary time
 *   I3 report honesty
 *     - an empty series must not summarise to zeros ................ at summary time
 *   concurrency (aliasing)
 *     - in-place sort corrupting the caller's chronological series . after summary
 *   permissions: N/A — pure functions, no I/O, no ambient authority.
 */

import { describe, expect, it } from "vitest";

import {
  HITCH_THRESHOLD_MS,
  findHitches,
  onePercentLowSampleCount,
  percentileNearestRank,
  summariseSeries,
} from "./stats.ts";

/** 1..n, in order. Chosen so every percentile has an arithmetically obvious answer. */
const ramp = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe("percentileNearestRank", () => {
  // Nearest-rank: P(q) = sorted[ceil(q * n) - 1]. Written out because "the p95"
  // is not one definition — linear interpolation would give 95.05 for this
  // input, and a bench whose percentile definition is unstated is a bench whose
  // numbers cannot be compared to anyone else's.
  it("uses the nearest-rank definition on a 1..100 ramp", () => {
    const sorted = ramp(100);
    expect(percentileNearestRank(sorted, 0.5)).toBe(50);
    expect(percentileNearestRank(sorted, 0.95)).toBe(95);
    expect(percentileNearestRank(sorted, 0.99)).toBe(99);
  });

  it("never indexes past either end", () => {
    // ceil(0.99 * 2) - 1 = 1, and ceil(0 * n) - 1 = -1 without a clamp. Both
    // ends are load-bearing: an out-of-range read yields undefined, which
    // propagates as NaN into the report and JSON-serialises to null.
    expect(percentileNearestRank([7], 0.5)).toBe(7);
    expect(percentileNearestRank([7], 0.99)).toBe(7);
    expect(percentileNearestRank([3, 9], 0.99)).toBe(9);
    expect(percentileNearestRank([3, 9], 0.5)).toBe(3);
    expect(percentileNearestRank([3, 9], 0)).toBe(3);
    expect(percentileNearestRank([3, 9], 1)).toBe(9);
  });

  it("rejects an empty series rather than returning a number", () => {
    expect(() => percentileNearestRank([], 0.95)).toThrow(RangeError);
  });
});

describe("onePercentLowSampleCount", () => {
  /**
   * "1% low" here = the mean of the slowest ceil(n/100) frames, minimum one.
   *
   * The rounding direction is pinned because it is the whole metric at small n:
   * with floor(), a 60-frame run averages the slowest 0 frames and the metric
   * silently becomes NaN or 0.
   */
  it("takes the ceiling, and never fewer than one frame", () => {
    expect(onePercentLowSampleCount(100)).toBe(1);
    expect(onePercentLowSampleCount(101)).toBe(2);
    expect(onePercentLowSampleCount(200)).toBe(2);
    expect(onePercentLowSampleCount(201)).toBe(3);
    expect(onePercentLowSampleCount(1)).toBe(1);
    expect(onePercentLowSampleCount(60)).toBe(1);
  });
});

describe("findHitches", () => {
  it("reports the chronological frame index, not the sorted position", () => {
    // The whole point of a hitch record is "when did the stall happen". A
    // summary that sorts first and reports the sorted position points at a
    // frame that is not the one that stalled.
    const series = [8, 9, 8, 250, 8, 9];
    expect(findHitches(series)).toEqual([{ frameIndex: 3, frameTimeMs: 250 }]);
  });

  it("treats exactly 100 ms as not a hitch, and anything above it as one", () => {
    // RFC D6 says "無 >100ms hitch" — strictly greater. The ticket's
    // Verification Steps name this boundary explicitly, so `>` vs `>=` is the
    // difference between a passing run and a failing one for a frame that lands
    // exactly on the threshold.
    expect(HITCH_THRESHOLD_MS).toBe(100);
    expect(findHitches([100])).toEqual([]);
    expect(findHitches([99.999])).toEqual([]);
    expect(findHitches([100.001])).toEqual([{ frameIndex: 0, frameTimeMs: 100.001 }]);
  });

  it("finds every hitch, in order", () => {
    const series = [8, 120, 8, 8, 300, 8];
    expect(findHitches(series)).toEqual([
      { frameIndex: 1, frameTimeMs: 120 },
      { frameIndex: 4, frameTimeMs: 300 },
    ]);
  });

  it("returns none for a clean series", () => {
    expect(findHitches([8, 9, 10, 11])).toEqual([]);
  });
});

describe("summariseSeries", () => {
  it("summarises a 1..100 ramp to its stated definitions", () => {
    const s = summariseSeries(ramp(100));
    expect(s.count).toBe(100);
    expect(s.minMs).toBe(1);
    expect(s.maxMs).toBe(100);
    expect(s.meanMs).toBeCloseTo(50.5, 10);
    expect(s.p50Ms).toBe(50);
    expect(s.p95Ms).toBe(95);
    expect(s.p99Ms).toBe(99);
    // Slowest ceil(100/100) = 1 frame, which is 100.
    expect(s.onePercentLowMs).toBe(100);
  });

  it("averages the slowest 1% when that is more than one frame", () => {
    // n = 200 -> slowest 2 frames are 199 and 200 -> mean 199.5. A version that
    // reports the single worst frame gives 200 and passes the n=100 case above,
    // which is why this second size is here.
    const s = summariseSeries(ramp(200));
    expect(s.onePercentLowMs).toBeCloseTo(199.5, 10);
  });

  it("is independent of the order samples arrive in", () => {
    const chronological = [50, 1, 99, 2, 100];
    const shuffled = [100, 2, 1, 50, 99];
    const a = summariseSeries(chronological);
    const b = summariseSeries(shuffled);
    expect(a.p50Ms).toBe(b.p50Ms);
    expect(a.p95Ms).toBe(b.p95Ms);
    expect(a.p99Ms).toBe(b.p99Ms);
    expect(a.onePercentLowMs).toBe(b.onePercentLowMs);
  });

  it("does not reorder the caller's array", () => {
    // Aliasing, and the reason this is the "concurrency" cell of the grid: the
    // same chronological array is read by the summary and by the hitch scan.
    // An in-place `.sort()` inside the summary silently renumbers every hitch
    // the caller later reports. Nothing else in the harness would notice.
    const series = [8, 250, 8, 9];
    const before = [...series];
    summariseSeries(series);
    expect(series).toEqual(before);
    expect(findHitches(series)).toEqual([{ frameIndex: 1, frameTimeMs: 250 }]);
  });

  it("carries the hitches it found", () => {
    const s = summariseSeries([8, 9, 150, 8]);
    expect(s.hitches).toEqual([{ frameIndex: 2, frameTimeMs: 150 }]);
  });

  it("handles a single sample without producing NaN", () => {
    const s = summariseSeries([12.5]);
    expect(s.count).toBe(1);
    expect(s.p50Ms).toBe(12.5);
    expect(s.p95Ms).toBe(12.5);
    expect(s.p99Ms).toBe(12.5);
    expect(s.onePercentLowMs).toBe(12.5);
    expect(s.meanMs).toBe(12.5);
    expect(Number.isNaN(s.p99Ms)).toBe(false);
  });

  /**
   * The failure this exists to prevent is the quiet one: an interrupted or
   * broken run collects nothing, the summary returns zeros, and zeros are the
   * best-looking frame times a report can contain. A run with no samples has to
   * be loud.
   */
  it("throws on an empty series instead of scoring it as zero", () => {
    expect(() => summariseSeries([])).toThrow(RangeError);
  });

  it.each([
    ["NaN", [8, NaN, 9]],
    ["Infinity", [8, Infinity, 9]],
    ["-Infinity", [8, -Infinity, 9]],
    ["a negative frame time", [8, -1, 9]],
  ])("rejects a series containing %s", (_label, series) => {
    // A single NaN poisons every percentile and JSON-serialises to null, so the
    // report would carry a null where a number is expected and still claim to
    // be valid. Rejected at ingest, where the cause is still known.
    expect(() => summariseSeries(series)).toThrow();
  });

  it("accepts a zero-length frame time", () => {
    // 0 ms is not poison — a sub-microsecond frame legitimately rounds to it on
    // a coarse clock. Only negatives are impossible.
    expect(() => summariseSeries([0, 1, 2])).not.toThrow();
  });
});
