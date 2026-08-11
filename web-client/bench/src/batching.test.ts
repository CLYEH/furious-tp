/**
 * Exam for the pose-batch seam.
 *
 * WHY THIS MODULE EXISTS AT ALL: `driver.ts` is not executed by any test — a
 * probe replacing `createPlaywrightDriver` with a throw fails nothing, twice
 * confirmed. That is acceptable for the parts that genuinely need a browser
 * (`launchPersistentContext`, CDP). It was NOT acceptable for the batching,
 * because two one-line edits inside the driver silently reverted fixes this
 * ticket had already made and no test noticed:
 *
 *     start += 100000        -> SF4's batching gone, abort ignored again
 *     resolvedNames: {}      -> B2's dwm fix gone, contention flag always true
 *
 * A fix that one line can undo with nothing to catch it is not fixed. So the
 * decidable half — how the batches are shaped, and whether the loop honours the
 * signal — moves out from behind the browser and gets pinned here.
 *
 * Grid — invariant x failure mode x time:
 *   SF4 batching
 *     - one giant batch, so the signal is never read ....... at planning time
 *     - the LAST batch is dropped .......................... at planning time
 *     - warmup frames counted in every batch ............... at planning time
 *   AC5 terminal position
 *     - abort before the final batch still runs it ......... mid loop
 *     - abort is only checked between batches, never for the last one
 *   permissions / concurrency: N/A — pure planning over integers, and the
 *   loop runs strictly in sequence by construction.
 */

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_POSE_BATCH, planPoseBatches, runPoseBatches } from "./batching.ts";

describe("planPoseBatches", () => {
  it("covers every pose exactly once, in order", () => {
    const batches = planPoseBatches(2101, 300, 0);
    expect(batches.reduce((sum, b) => sum + b.count, 0)).toBe(2101);
    expect(batches[0]?.start).toBe(0);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i]!.start).toBe(batches[i - 1]!.start + batches[i - 1]!.count);
    }
  });

  it("keeps the short final batch rather than dropping it", () => {
    // 2101 = 7 x 300 + 1. The remainder is one pose, and the shape that loses
    // it is the same shape that loses the last iteration everywhere else.
    const batches = planPoseBatches(2101, 300, 0);
    expect(batches).toHaveLength(8);
    expect(batches[7]).toEqual({ start: 2100, count: 1, warmupFrames: 0 });
  });

  it("actually splits, so an abort has somewhere to land", () => {
    // The property SF4 exists for. A planner returning one batch passes every
    // coverage assertion above and silently restores the old behaviour, which
    // is exactly what the surviving `start += 100000` mutant did.
    expect(planPoseBatches(2101, 300, 0).length).toBeGreaterThan(1);
    expect(planPoseBatches(2101, 300, 0).every((b) => b.count <= 300)).toBe(true);
  });

  it("splits a real route with the DEFAULT batch size", () => {
    // The constant itself is load-bearing, so it is pinned here rather than
    // left in the driver where nothing could observe it being changed.
    const batches = planPoseBatches(2101, DEFAULT_POSE_BATCH, 0);
    expect(batches.length).toBeGreaterThan(1);
    expect(DEFAULT_POSE_BATCH).toBeLessThanOrEqual(600);
    expect(DEFAULT_POSE_BATCH).toBeGreaterThan(0);
  });

  it("applies warmup only to the first batch", () => {
    // Warmup is frames skipped at the START of a route. Counted per batch it
    // would silently discard 7 x warmup frames of real measurement.
    const batches = planPoseBatches(1000, 300, 60);
    expect(batches[0]?.warmupFrames).toBe(60);
    expect(batches.slice(1).every((b) => b.warmupFrames === 0)).toBe(true);
  });

  it("returns a single batch when the route is shorter than one", () => {
    expect(planPoseBatches(100, 300, 0)).toEqual([{ start: 0, count: 100, warmupFrames: 0 }]);
  });

  it("returns nothing for an empty route", () => {
    expect(planPoseBatches(0, 300, 0)).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN])("rejects a batch size of %s", (size) => {
    // A zero or fractional batch size loops forever or produces nonsense
    // offsets; both are worse than refusing.
    expect(() => planPoseBatches(100, size, 0)).toThrow(RangeError);
  });
});

describe("runPoseBatches", () => {
  const chunk = (count: number, base: number) => ({
    frameTimesMs: Array.from({ length: count }, (_, i) => base + i),
    presentIntervalsMs: Array.from({ length: count }, (_, i) => base + i + 100),
    framesMeasured: count,
    warnings: [],
  });

  it("runs every batch and concatenates the series in order", async () => {
    const runBatch = vi.fn((b: { start: number; count: number }) =>
      Promise.resolve(chunk(b.count, b.start)),
    );
    const result = await runPoseBatches(planPoseBatches(700, 300, 0), new AbortController().signal, runBatch);
    expect(runBatch).toHaveBeenCalledTimes(3);
    expect(result.frameTimesMs).toHaveLength(700);
    expect(result.frameTimesMs[0]).toBe(0);
    expect(result.frameTimesMs[699]).toBe(699);
  });

  it("stops at the batch boundary when aborted", async () => {
    const controller = new AbortController();
    const runBatch = vi.fn((b: { start: number; count: number }) => {
      if (b.start === 300) controller.abort();
      return Promise.resolve(chunk(b.count, b.start));
    });
    const result = await runPoseBatches(planPoseBatches(1200, 300, 0), controller.signal, runBatch);
    // Batches 0 and 1 ran; the abort fired inside batch 1, so 2 and 3 must not.
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(result.frameTimesMs).toHaveLength(600);
  });

  /**
   * The third terminal position, and the one the axis missed.
   *
   * The route loop's last iteration and the memory phase were both covered, but
   * the axis stopped at the module boundary — inside runRoute, the LAST pose
   * batch is a terminal position too, and deleting the signal check left it
   * unobserved.
   */
  it("does not start the final batch when the abort lands during the one before it", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const runBatch = vi.fn((b: { start: number; count: number }) => {
      seen.push(b.start);
      // Abort during the second-to-last batch.
      if (b.start === 300) controller.abort();
      return Promise.resolve(chunk(b.count, b.start));
    });
    await runPoseBatches(planPoseBatches(700, 300, 0), controller.signal, runBatch);
    expect(seen).toEqual([0, 300]);
    expect(seen).not.toContain(600);
  });

  it("runs no batch at all when aborted before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const runBatch = vi.fn(() => Promise.resolve(chunk(1, 0)));
    const result = await runPoseBatches(planPoseBatches(700, 300, 0), controller.signal, runBatch);
    expect(runBatch).not.toHaveBeenCalled();
    expect(result.frameTimesMs).toEqual([]);
  });

  /**
   * The two series stay index-aligned.
   *
   * An earlier version dropped the first presented-frame interval of every
   * later batch, because that one spans the round trip to Node. It made the
   * arrays different lengths (2101 vs 2094) with nothing saying so — and
   * `presentIntervalsMs[i] - frameTimesMs[i]` is exactly the pairing this
   * ticket used to show that ~6 ms falls outside render(). Silently
   * misaligning the evidence for a published conclusion is worse than keeping
   * a few unusable values, so the values stay and their indices are recorded.
   */
  it("keeps both series the same length and names the boundary samples", async () => {
    const runBatch = (b: { start: number; count: number }) => Promise.resolve(chunk(b.count, b.start));
    const result = await runPoseBatches(planPoseBatches(700, 300, 0), new AbortController().signal, runBatch);
    expect(result.presentIntervalsMs).toHaveLength(result.frameTimesMs.length);
    // First sample of each later batch spans a round trip to Node.
    expect(result.boundaryIndices).toEqual([300, 600]);
  });

  it("records no boundaries for a single-batch route", async () => {
    const runBatch = (b: { start: number; count: number }) => Promise.resolve(chunk(b.count, b.start));
    const result = await runPoseBatches(planPoseBatches(100, 300, 0), new AbortController().signal, runBatch);
    expect(result.boundaryIndices).toEqual([]);
  });
});
