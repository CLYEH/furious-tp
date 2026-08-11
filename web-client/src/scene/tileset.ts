/**
 * Attaching the NLSC building layer, in a form that has no Cesium in it.
 *
 * The invariant this seam owns: **NLSC going away costs the buildings, never
 * the scene** (RFC D6 degradation, and the story-level AC on FTP-9). Keeping
 * the failure handling here rather than inside the Cesium bootstrap is what
 * makes that invariant testable without a GPU.
 *
 * Two failure shapes, both measured on the live service rather than imagined:
 *
 *  - **It never answers.** A rejection is easy to remember; silence is the one
 *    that leaves the scene reporting nothing forever, so the wait is bounded.
 *  - **It answers wrongly, but not always.** FTP-5 §0.1/§5.3(5) recorded one
 *    URL returning more than one body. On **2026-08-11**, during a service
 *    incident, this endpoint served a decodable tileset on **4 requests out of
 *    20**; later the same day it measured **13/13 decodable**, and the reviewer
 *    independently measured 13/13 too. So the 20% figure describes a past
 *    incident, **not** the steady state — the reason to retry is that this
 *    source is known to answer inconsistently at all, not that it is 20%.
 *
 * On the number 3 specifically: it is **supported by measurement but not
 * derived from it**. What the measurements support is "retry"; at p=0.2 three
 * attempts only move 20% to 49%, which is still a coin toss. What actually caps
 * it is FTP-5 R7 — do not lean on a public government service — which outranks
 * squeezing the success rate higher.
 *
 * Known tension with R7 (nit, not fixed here): an abandoned attempt is dropped,
 * not cancelled, so in the worst case three ~3 MB requests are in flight at
 * once. Cancelling needs the loader to accept an AbortSignal, which
 * `Cesium3DTileset.fromUrl` does not expose.
 */

/** How long one attempt gets before it is abandoned. */
export const TILESET_LOAD_TIMEOUT_MS = 20_000;
/** Total attempts, including the first. */
export const TILESET_LOAD_ATTEMPTS = 3;
/** Pause between attempts. */
export const TILESET_RETRY_DELAY_MS = 1_500;

import { messageOf } from "../errors.js";

export interface TilesetLoadDeps<T> {
  /** Loads the tileset — `Cesium3DTileset.fromUrl` in the real scene. */
  load: (url: string) => Promise<T>;
  onWarning: (message: string) => void;
}

export interface TilesetLoadOptions {
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  /** Injected so tests do not have to spend real seconds proving they waited. */
  sleep?: (ms: number) => Promise<void>;
}

type Attempt<T> = { kind: "loaded"; value: T } | { kind: "failed"; reason: string };

async function attemptLoad<T>(
  url: string,
  load: (url: string) => Promise<T>,
  timeoutMs: number,
): Promise<Attempt<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A loader that throws synchronously lands in the enclosing catch, same as
    // one that rejects — no wrapper needed.
    //
    // Nor does the abandoned attempt need its rejection "claimed": Promise.race
    // attaches handlers to every promise it is given, so a load that rejects
    // after losing the race is already handled and never reaches
    // unhandledRejection. Measured, not assumed — an earlier version carried a
    // `loading.catch(() => undefined)` line for this, and deleting it changed
    // no observable behaviour.
    const loading = load(url);

    return await Promise.race<Attempt<T>>([
      loading.then((value): Attempt<T> => ({ kind: "loaded", value })),
      new Promise<Attempt<T>>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "failed", reason: `逾時(${timeoutMs} ms)` }),
          timeoutMs,
        );
      }),
    ]);
  } catch (cause) {
    return { kind: "failed", reason: messageOf(cause) };
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the tileset, or `null` after telling the operator why not. */
export async function loadNlscTileset<T>(
  url: string,
  deps: TilesetLoadDeps<T>,
  options: TilesetLoadOptions = {},
): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? TILESET_LOAD_TIMEOUT_MS;
  const attempts = options.attempts ?? TILESET_LOAD_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? TILESET_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const reasons: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = await attemptLoad(url, deps.load, timeoutMs);
    if (outcome.kind === "loaded") return outcome.value;
    reasons.push(`第 ${attempt} 次:${outcome.reason}`);
    if (attempt < attempts) await sleep(retryDelayMs);
  }

  deps.onWarning(
    `NLSC 建物圖層載入失敗(共 ${attempts} 次嘗試),場景以無建物模式繼續:${reasons.join("、")}(${url})`,
  );
  return null;
}
