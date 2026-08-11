/**
 * The 15-minute memory cycle measurement (RFC D6).
 *
 * FTP-48 measures; FTP-49 judges. D6's "<10%" threshold deliberately does not
 * appear in this file — a harness that both produces a number and decides
 * whether it is acceptable makes the decision unreviewable.
 */

export interface MemorySample {
  /** Milliseconds since the cycle started. */
  atMs: number;
  /** JS heap in use, read after a forced GC. */
  usedHeapBytes: number;
}

export interface PowerState {
  charging: boolean | null;
  /** 0..1, or null when the browser would not say. */
  batteryLevel: number | null;
  note: string;
}

export interface MemoryContext {
  startedAt: string;
  finishedAt: string;
  power: PowerState | null;
}

export interface MemoryResult {
  startBytes: number;
  endBytes: number;
  /** (end - start) / start. Negative when the heap shrank. */
  growthRatio: number;
  durationMs: number;
  samples: MemorySample[];
  /** Always null — see `gpuNote`. Never 0, which would read as "no growth". */
  gpuBytes: null;
  gpuNote: string;
  /**
   * When the cycle ran, and on what power. The rig is a laptop: the same
   * 15-minute cycle on battery and on mains are different experiments, and
   * only the report can say which one produced these bytes.
   */
  startedAt: string | null;
  finishedAt: string | null;
  power: PowerState | null;
}

const GPU_NOTE =
  "GPU 記憶體未量測:瀏覽器不提供讀取 GPU 記憶體的介面,頁面內無法取得。D6 要求的 GPU 成長量在此為缺口,不是 0。";

export function summariseMemory(
  samples: readonly MemorySample[],
  context?: MemoryContext,
): MemoryResult {
  if (samples.length < 2) {
    // One reading cannot show growth, and returning 0 for it would be a
    // fabricated pass on the one metric this function exists to produce.
    throw new RangeError(
      `summariseMemory: 至少需要 2 個樣本才能量出成長,收到 ${samples.length} 個`,
    );
  }

  for (let i = 0; i < samples.length; i++) {
    const { atMs, usedHeapBytes } = samples[i]!;
    if (!Number.isFinite(usedHeapBytes) || usedHeapBytes < 0) {
      throw new RangeError(`summariseMemory: 樣本 ${i} 的 heap 讀數無效(${String(usedHeapBytes)})`);
    }
    if (!Number.isFinite(atMs)) {
      throw new RangeError(`summariseMemory: 樣本 ${i} 的時間無效(${String(atMs)})`);
    }
    // first/last are taken by position, so an out-of-order series would measure
    // the growth backwards with no other symptom.
    if (i > 0 && atMs < samples[i - 1]!.atMs) {
      throw new RangeError(`summariseMemory: 樣本 ${i} 的時間早於前一個樣本,序列非時間排序`);
    }
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (first.usedHeapBytes === 0) {
    // (end - 0) / 0 is Infinity, and JSON.stringify writes Infinity as null —
    // the report would carry a null growth ratio and still call itself valid.
    throw new RangeError("summariseMemory: 起始 heap 為 0,成長率無法定義");
  }

  return {
    startBytes: first.usedHeapBytes,
    endBytes: last.usedHeapBytes,
    growthRatio: (last.usedHeapBytes - first.usedHeapBytes) / first.usedHeapBytes,
    durationMs: last.atMs - first.atMs,
    samples: [...samples],
    gpuBytes: null,
    gpuNote: GPU_NOTE,
    startedAt: context?.startedAt ?? null,
    finishedAt: context?.finishedAt ?? null,
    power: context?.power ?? null,
  };
}
