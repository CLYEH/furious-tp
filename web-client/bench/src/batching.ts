/**
 * How a route's poses are split, and how the split loop honours an abort.
 *
 * This lives outside `driver.ts` deliberately. The driver is not reachable by
 * any test — a probe replacing `createPlaywrightDriver` with a throw fails
 * nothing — which is fine for the parts that genuinely need a browser, and was
 * not fine for these two, because a single line inside the driver silently
 * reverted fixes this ticket had already made:
 *
 *     start += 100000     one giant batch again; the abort signal never read
 *     resolvedNames: {}   dwm unresolved again; the contention flag always true
 *
 * Both survived mutation because nothing could observe them. A fix that one
 * line can undo, with no test to notice, is not a fix — so the decidable half
 * moved here and the browser keeps only what actually needs a browser.
 */

/**
 * Frames per page.evaluate call.
 *
 * Lives here, not in the driver, because the driver is unexamined: as a
 * constant over there a one-line edit to 100000 restored the old single-batch
 * behaviour and no test could see it. Small enough that an abort is acted on
 * within seconds, large enough that the per-batch round trip is noise against
 * a route of thousands of frames.
 */
export const DEFAULT_POSE_BATCH = 300;

export interface PoseBatch {
  start: number;
  count: number;
  /** Frames rendered but not recorded. Only ever non-zero on the first batch. */
  warmupFrames: number;
}

export interface BatchChunk {
  frameTimesMs: number[];
  presentIntervalsMs: number[];
  framesMeasured: number;
  warnings: string[];
}

export interface BatchedRun {
  frameTimesMs: number[];
  presentIntervalsMs: number[];
  framesMeasured: number;
  warnings: string[];
  /**
   * Indices whose presented-frame interval spans a batch boundary — it includes
   * a round trip to Node and is not something the renderer produced.
   *
   * Recorded rather than removed. Dropping them made the two series different
   * lengths (2101 vs 2094) with nothing saying so, and
   * `presentIntervalsMs[i] - frameTimesMs[i]` is the exact pairing this ticket
   * used to show ~6 ms falls outside render(). Quietly misaligning the evidence
   * for a published conclusion is worse than carrying a few unusable samples
   * with their positions named.
   */
  boundaryIndices: number[];
}

export function planPoseBatches(
  total: number,
  batchSize: number,
  warmupFrames: number,
): PoseBatch[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`planPoseBatches: batchSize 必須是正整數,收到 ${String(batchSize)}`);
  }
  const batches: PoseBatch[] = [];
  for (let start = 0; start < total; start += batchSize) {
    batches.push({
      start,
      count: Math.min(batchSize, total - start),
      // Warmup is frames skipped at the start of a ROUTE, not of every batch.
      // Per batch it would silently discard warmup x batches of measurement.
      warmupFrames: start === 0 ? warmupFrames : 0,
    });
  }
  return batches;
}

export async function runPoseBatches(
  batches: readonly PoseBatch[],
  signal: AbortSignal,
  runBatch: (batch: PoseBatch) => Promise<BatchChunk>,
): Promise<BatchedRun> {
  const frameTimesMs: number[] = [];
  const presentIntervalsMs: number[] = [];
  const boundaryIndices: number[] = [];
  let warnings: string[] = [];

  for (const [index, batch] of batches.entries()) {
    // Checked before every batch INCLUDING the last. The last one is a terminal
    // position in exactly the sense session.ts documents: nothing after it will
    // check on its behalf.
    if (signal.aborted) break;
    if (index > 0) boundaryIndices.push(frameTimesMs.length);

    const chunk = await runBatch(batch);
    frameTimesMs.push(...chunk.frameTimesMs);
    presentIntervalsMs.push(...chunk.presentIntervalsMs);
    warnings = chunk.warnings;
  }

  return {
    frameTimesMs,
    presentIntervalsMs,
    framesMeasured: frameTimesMs.length,
    warnings,
    boundaryIndices,
  };
}
