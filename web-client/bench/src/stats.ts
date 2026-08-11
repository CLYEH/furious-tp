/**
 * Frame-time statistics (RFC D6).
 *
 * Every definition here is written down rather than assumed, because "the p95"
 * is not one number: nearest-rank and linear interpolation disagree, and a
 * bench whose percentile definition is unstated produces figures that cannot be
 * compared to anyone else's — including its own, after a refactor.
 *
 * Nothing in this file judges. RFC D6's thresholds (p95 <= 16.6 ms, p99 <= 33 ms)
 * belong to FTP-49; this module reports what happened.
 */

/** RFC D6: "無 >100ms hitch". Strictly greater — exactly 100 ms is not a hitch. */
export const HITCH_THRESHOLD_MS = 100;

export interface Hitch {
  /** Position in the chronological series — which frame stalled, not which rank. */
  frameIndex: number;
  frameTimeMs: number;
}

export interface SeriesSummary {
  count: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Mean of the slowest `onePercentLowSampleCount(n)` frames. */
  onePercentLowMs: number;
  hitches: Hitch[];
}

/**
 * Nearest-rank percentile: P(q) = sorted[ceil(q * n) - 1].
 *
 * No interpolation. With interpolation the p95 of a 1..100 ramp is 95.05, a
 * value no frame ever took; nearest-rank always returns a frame time that was
 * actually observed, which is the honest thing for a report whose raw series
 * ships alongside it.
 */
export function percentileNearestRank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    throw new RangeError("percentileNearestRank: 空序列沒有百分位數");
  }
  const rank = Math.ceil(q * sorted.length);
  // Clamped at both ends: q = 0 gives rank 0 and would index -1, and floating
  // point can push q = 1 to a rank of n + 1. An out-of-range read returns
  // undefined, which becomes NaN downstream and then `null` in the JSON.
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index]!;
}

/**
 * How many frames the "1% low" averages: ceil(n / 100), never fewer than one.
 *
 * The ceiling is the whole metric below n = 100. With floor(), a 60-frame route
 * averages zero frames and the statistic silently becomes NaN.
 */
export function onePercentLowSampleCount(count: number): number {
  return Math.max(1, Math.ceil(count / 100));
}

/** Every frame slower than the threshold, in the order they happened. */
export function findHitches(frameTimesMs: readonly number[]): Hitch[] {
  const hitches: Hitch[] = [];
  for (let i = 0; i < frameTimesMs.length; i++) {
    const frameTimeMs = frameTimesMs[i]!;
    if (frameTimeMs > HITCH_THRESHOLD_MS) hitches.push({ frameIndex: i, frameTimeMs });
  }
  return hitches;
}

function assertUsable(frameTimesMs: readonly number[]): void {
  if (frameTimesMs.length === 0) {
    // Loud on purpose. A run that collected nothing would otherwise summarise
    // to zeros, and zeros are the best-looking frame times a report can carry —
    // an interrupted run would read as a record-breaking one.
    throw new RangeError("summariseSeries: 沒有任何 frame 樣本,無法統計");
  }
  for (let i = 0; i < frameTimesMs.length; i++) {
    const value = frameTimesMs[i]!;
    if (!Number.isFinite(value) || value < 0) {
      // Rejected at ingest, where the frame index is still known. One NaN
      // poisons every percentile and JSON-serialises to `null`, so the report
      // would carry a null where a number belongs and still claim to be valid.
      throw new RangeError(`summariseSeries: frame ${i} 的時間不是有效值(${String(value)})`);
    }
  }
}

export function summariseSeries(frameTimesMs: readonly number[]): SeriesSummary {
  assertUsable(frameTimesMs);

  // Copied before sorting. The caller's array is chronological and is also read
  // by `findHitches`, whose whole output is positions in that order — an
  // in-place sort here would renumber every hitch in the report and nothing
  // else would notice.
  const sorted = [...frameTimesMs].sort((a, b) => a - b);
  const count = sorted.length;

  const lowCount = onePercentLowSampleCount(count);
  const slowest = sorted.slice(count - lowCount);

  return {
    count,
    meanMs: sorted.reduce((sum, v) => sum + v, 0) / count,
    minMs: sorted[0]!,
    maxMs: sorted[count - 1]!,
    p50Ms: percentileNearestRank(sorted, 0.5),
    p95Ms: percentileNearestRank(sorted, 0.95),
    p99Ms: percentileNearestRank(sorted, 0.99),
    onePercentLowMs: slowest.reduce((sum, v) => sum + v, 0) / slowest.length,
    hitches: findHitches(frameTimesMs),
  };
}
