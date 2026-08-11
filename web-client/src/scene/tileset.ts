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
 *    URL returning more than one body, and on 2026-08-11 this endpoint was
 *    measured serving a decodable tileset on 4 requests out of 20. A single
 *    attempt against a source like that is not "loading", it is a coin toss,
 *    so a small bounded number of attempts is made before giving up.
 *
 * The retry budget is deliberately small. FTP-5 R7 — do not lean on a public
 * government service — outranks squeezing the success rate higher.
 */

/** How long one attempt gets before it is abandoned. */
export const TILESET_LOAD_TIMEOUT_MS = 20_000;
/** Total attempts, including the first. */
export const TILESET_LOAD_ATTEMPTS = 3;
/** Pause between attempts. */
export const TILESET_RETRY_DELAY_MS = 1_500;

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

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  if (typeof cause === "number" || typeof cause === "boolean") return String(cause);
  // Anything else — null, a bare object, an error carrying no message —
  // stringifies to something the operator cannot act on, so say that instead.
  return "沒有錯誤訊息";
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
    // one that rejects — no wrapper needed. (There was one, with a comment
    // claiming it was what routed sync throws here. Mutation testing showed
    // removing it changed nothing, because the comment was wrong.)
    const loading = load(url);
    // A load that loses the race can still reject later. Claim it now, or the
    // rejection surfaces as an unhandled one long after we stopped caring.
    loading.catch(() => undefined);

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
