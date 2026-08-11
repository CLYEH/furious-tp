/**
 * RFC D5: "client 記錄 tileset.json 版本指紋,變更時告警".
 *
 * The mechanism has to survive a service that FTP-5 measured misbehaving in
 * three different ways, and the alert is only worth having if it can be
 * believed. Hence three rules taken straight from that spike (§5.3(4), §6.3
 * risk 5), none of which are optional:
 *
 *  1. **Hash the decoded body, never the raw bytes.** A defective endpoint
 *     returns a stable stream of NUL bytes; hashing those gives a beautifully
 *     stable fingerprint of nothing at all.
 *  2. **Keep the set of digests seen, not just the last one.** The service is
 *     known to answer one URL with more than one body, so "different from last
 *     time" is not the same question as "the data changed".
 *  3. **Separate the alerts.** A revision, a diverging source and a broken
 *     service are three different events. Collapsing them means the first
 *     divergence is reported as a revision, and after one false alarm nobody
 *     reads the next one.
 */

import { NLSC_FETCH_INIT } from "../config/nlsc.js";
import { messageOf } from "../errors.js";

/** Consecutive polls a new digest must hold alone before it counts as a revision. */
export const CONFIRMATION_POLLS = 3;

/** Upper bound on remembered digests, so a churning source cannot fill storage. */
export const MAX_TRACKED_HASHES = 8;

// The document is ~3 MB over a link the service forbids caching, and the check
// runs while the renderer is streaming tiles. Generous on purpose: the check is
// fire-and-forget, so a slow answer costs nothing, while a premature abort
// reports a service defect that never happened.
const DEFAULT_TIMEOUT_MS = 60_000;
const STORAGE_PREFIX = "ftp:nlsc-tileset-watch:";

export type SampleFailureReason = "http-status" | "undecodable" | "unparseable" | "transport";

export type TilesetSample =
  | { ok: true; hash: string; tilesetId: string | null }
  | { ok: false; reason: SampleFailureReason; detail: string };

export interface HashObservation {
  hash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface TilesetWatchRecord {
  url: string;
  establishedHash: string | null;
  establishedTilesetId: string | null;
  observations: HashObservation[];
  /** The last CONFIRMATION_POLLS successful digests, oldest first. */
  recent: string[];
}

export type TilesetAlert =
  | { kind: "revision"; url: string; from: string; to: string }
  | { kind: "source-divergence"; url: string; hashes: string[] }
  | { kind: "service-defect"; url: string; reason: SampleFailureReason; detail: string }
  | { kind: "signal-mismatch"; url: string; detail: string }
  | { kind: "watch-degraded"; url: string; detail: string };

export function emptyRecord(url: string): TilesetWatchRecord {
  return {
    url,
    establishedHash: null,
    establishedTilesetId: null,
    observations: [],
    recent: [],
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch the tileset and reduce it to a fingerprint, or to a named failure.
 *
 * Every failure is a failure — none of them are allowed to look like a change.
 * The body is read through `text()` so the digest covers the DECODED document
 * (rule 1 above); a body that cannot be decoded fails the read rather than
 * yielding bytes to hash.
 */
export async function readTilesetSample(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TilesetSample> {
  // An abort can surface while opening the request OR while reading the body,
  // and the second one used to be reported as a corrupt document. Saying "the
  // service is broken" when it was our own clock is a false defect report, and
  // D5's value is that its alerts can be believed.
  //
  // Timeout and abort are told apart rather than merged: only a real timeout
  // gets to quote the deadline. The merged version printed "連線逾時(60000 ms)"
  // for any error whose message happened to contain "abort", and that number
  // was fiction whenever the abort was not the clock.
  const abortKind = (cause: unknown): "timeout" | "aborted" | null => {
    if (cause instanceof DOMException) {
      if (cause.name === "TimeoutError") return "timeout";
      if (cause.name === "AbortError") return "aborted";
    }
    if (cause instanceof Error && /abort/i.test(cause.message)) return "aborted";
    return null;
  };
  const abortDetail = (kind: "timeout" | "aborted", cause: unknown): string =>
    kind === "timeout" ? `連線逾時(${timeoutMs} ms)` : `請求被中止:${messageOf(cause)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...NLSC_FETCH_INIT,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const kind = abortKind(cause);
    return {
      ok: false,
      reason: "transport",
      detail: kind === null ? messageOf(cause) : abortDetail(kind, cause),
    };
  }

  if (!response.ok) {
    return { ok: false, reason: "http-status", detail: `HTTP ${response.status}` };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    const kind = abortKind(cause);
    if (kind !== null) {
      return { ok: false, reason: "transport", detail: abortDetail(kind, cause) };
    }
    // Where the live corruption lands in a browser: the response claims
    // content-encoding gzip and the body does not decode, which fails here
    // rather than at the fetch.
    return { ok: false, reason: "undecodable", detail: messageOf(cause) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately NOT the parser's message. V8 quotes the first ~10 characters
    // of the input back at you, and this detail is rendered into the page — so
    // a defective endpoint returning server process memory (FTP-5 §3.5) would
    // have it displayed. §7 pinned the probe to "never emit body content, only
    // a category and a count"; the same rule applies here.
    return {
      ok: false,
      reason: "unparseable",
      detail: `回應不是合法 JSON(${text.length} 字元)`,
    };
  }

  const tilesetId =
    typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string"
      ? (parsed as { id: string }).id
      : null;

  return { ok: true, hash: await sha256Hex(text), tilesetId };
}

function upsert(
  observations: HashObservation[],
  hash: string,
  now: string,
  establishedHash: string | null,
): HashObservation[] {
  const existing = observations.find((o) => o.hash === hash);
  const next = existing
    ? observations.map((o) =>
        o.hash === hash ? { ...o, lastSeenAt: now, count: o.count + 1 } : o,
      )
    : [...observations, { hash, firstSeenAt: now, lastSeenAt: now, count: 1 }];

  if (next.length <= MAX_TRACKED_HASHES) return next;

  // Evict the least recently seen, but never the established fingerprint —
  // losing that is losing the thing every comparison is made against.
  const evictable = next.filter((o) => o.hash !== establishedHash && o.hash !== hash);
  if (evictable.length === 0) return next;
  const oldest = evictable.reduce((a, b) => (a.lastSeenAt <= b.lastSeenAt ? a : b));
  return next.filter((o) => o !== oldest);
}

/**
 * True when the confirmation window holds more than one clean transition —
 * `[A,A,B]` is a source part-way through changing, `[A,B,A]` and `[A,B,C]` are
 * a source that is not settling on one answer.
 */
function isDiverging(window: string[]): boolean {
  let transitions = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i] !== window[i - 1]) transitions += 1;
  }
  return transitions > 1;
}

export function recordSample(
  record: TilesetWatchRecord,
  sample: TilesetSample,
  now: string,
): { record: TilesetWatchRecord; alerts: TilesetAlert[] } {
  if (!sample.ok) {
    // A defect changes nothing about what we believe the content to be. It is
    // reported, and the record is handed back untouched.
    return {
      record,
      alerts: [
        { kind: "service-defect", url: record.url, reason: sample.reason, detail: sample.detail },
      ],
    };
  }

  const { hash, tilesetId } = sample;
  const observations = upsert(record.observations, hash, now, record.establishedHash);
  const recent = [...record.recent, hash].slice(-CONFIRMATION_POLLS);
  const alerts: TilesetAlert[] = [];

  if (record.establishedHash === null) {
    return {
      record: { ...record, observations, recent, establishedHash: hash, establishedTilesetId: tilesetId },
      alerts,
    };
  }

  let establishedHash = record.establishedHash;
  let establishedTilesetId = record.establishedTilesetId;

  if (isDiverging(recent)) {
    alerts.push({ kind: "source-divergence", url: record.url, hashes: [...new Set(recent)] });
  } else if (
    hash !== establishedHash &&
    recent.length === CONFIRMATION_POLLS &&
    recent.every((h) => h === hash)
  ) {
    alerts.push({ kind: "revision", url: record.url, from: establishedHash, to: hash });
    if (tilesetId === establishedTilesetId) {
      alerts.push({
        kind: "signal-mismatch",
        url: record.url,
        detail: `內容指紋改變但 tileset id 未動(${String(tilesetId)})`,
      });
    }
    establishedHash = hash;
    establishedTilesetId = tilesetId;
  }
  // There is deliberately no "id moved but the content did not" branch. The id
  // lives INSIDE the document the digest covers, and `readTilesetSample` derives
  // both from the same `text`, so an id change always changes the hash. A branch
  // for it could never run and a test for it could never fail. (FTP-5 round-4
  // review flagged this in the spec; an earlier version of this file had the
  // branch anyway, with a case that only passed because it hand-built a state
  // the reader cannot produce. The unreachability is now pinned as a case.)

  return {
    record: { ...record, observations, recent, establishedHash, establishedTilesetId },
    alerts,
  };
}

const short = (hash: string): string => hash.slice(0, 12);

export function describeAlert(alert: TilesetAlert): string {
  switch (alert.kind) {
    case "revision":
      // "連續 ${CONFIRMATION_POLLS} 次載入", not "確認改版": §5.3 reserves the
      // latter for three consecutive DAILY polls, and a poll here is a page
      // load. Saying more than was measured is how an alert stops being worth
      // believing.
      return `NLSC tileset 指紋連續 ${CONFIRMATION_POLLS} 次載入為新值:${short(alert.from)} → ${short(alert.to)}(尚未經每日輪詢確認)(${alert.url})`;
    case "source-divergence":
      return `NLSC tileset 來源分歧:同一 URL 回傳多份內容 ${alert.hashes
        .map(short)
        .join("、")}(${alert.url})`;
    case "service-defect":
      return `NLSC tileset 服務缺陷(${alert.reason}):${alert.detail}(${alert.url})`;
    case "signal-mismatch":
      return `NLSC tileset 訊號不一致:${alert.detail}(${alert.url})`;
    case "watch-degraded":
      return `NLSC tileset 指紋無法保存,改版偵測已降級:${alert.detail}(${alert.url})`;
  }
}

export interface TilesetWatchStore {
  load(url: string): TilesetWatchRecord | null;
  save(record: TilesetWatchRecord): void;
}

/**
 * Is this actually a record, or merely something that parsed as JSON?
 *
 * A stored record is data written by an earlier version of this program, living
 * in a browser nobody controls. `JSON.parse(...) as TilesetWatchRecord` is a
 * claim, not a check — and when the claim was wrong the whole check threw
 * before reaching either try/catch, emitted nothing, and left the bad record in
 * place, so every later load of that browser repeated it. Silent AND permanent:
 * the worst of the three storage failures this module can suffer, and the only
 * one that was not handled.
 *
 * The likely trigger is not an attacker, it is evolution — add one field to
 * TilesetWatchRecord and every record already in the wild has the wrong shape.
 * That is why the entries are checked too, not just the top level.
 */
export function isWellFormedRecord(value: unknown): value is TilesetWatchRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<TilesetWatchRecord>;
  const nullableString = (v: unknown): boolean => v === null || typeof v === "string";
  return (
    typeof record.url === "string" &&
    nullableString(record.establishedHash) &&
    nullableString(record.establishedTilesetId) &&
    Array.isArray(record.recent) &&
    record.recent.every((hash) => typeof hash === "string") &&
    Array.isArray(record.observations) &&
    record.observations.every(
      (o: unknown) =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as HashObservation).hash === "string" &&
        typeof (o as HashObservation).firstSeenAt === "string" &&
        typeof (o as HashObservation).lastSeenAt === "string" &&
        typeof (o as HashObservation).count === "number",
    )
  );
}

export function memoryWatchStore(seed: TilesetWatchRecord[] = []): TilesetWatchStore {
  const records = new Map(seed.map((r) => [r.url, r]));
  return {
    load: (url) => records.get(url) ?? null,
    save: (record) => void records.set(record.url, record),
  };
}

export function localStorageWatchStore(storage: Storage): TilesetWatchStore {
  return {
    load(url) {
      const raw = storage.getItem(STORAGE_PREFIX + url);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as TilesetWatchRecord;
      } catch {
        // A corrupted entry is worth no more than an absent one, and throwing
        // here would take the scene down with it.
        return null;
      }
    },
    save(record) {
      storage.setItem(STORAGE_PREFIX + record.url, JSON.stringify(record));
    },
  };
}

export interface CheckOptions {
  url: string;
  fetchImpl?: typeof fetch;
  store: TilesetWatchStore;
  emit: (alert: TilesetAlert) => void;
  now?: () => string;
  timeoutMs?: number;
}

export interface CheckResult {
  record: TilesetWatchRecord;
  alerts: TilesetAlert[];
}

/**
 * Overlapping checks on one URL would both read the same record and the later
 * save would drop the earlier observation. Chaining per URL costs nothing and
 * removes the lost update.
 */
const chains = new Map<string, Promise<unknown>>();

export function checkTilesetFingerprint(options: CheckOptions): Promise<CheckResult> {
  const previous = chains.get(options.url) ?? Promise.resolve();
  const result = previous.then(
    () => runCheck(options),
    () => runCheck(options),
  );
  chains.set(
    options.url,
    result.catch(() => undefined),
  );
  return result;
}

async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const { url, store, emit } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const alerts: TilesetAlert[] = [];

  let previous: TilesetWatchRecord | null = null;
  try {
    previous = store.load(url);
  } catch (cause) {
    alerts.push({ kind: "watch-degraded", url, detail: `讀取失敗:${messageOf(cause)}` });
  }

  // Checked here rather than inside one store, so every store implementation —
  // including whatever a later ticket writes — gets the same guarantee.
  if (previous !== null && !isWellFormedRecord(previous)) {
    alerts.push({
      kind: "watch-degraded",
      url,
      detail: "既有紀錄格式不符,已捨棄並重新建立",
    });
    previous = null;
  }

  const sample = await readTilesetSample(url, options.fetchImpl ?? fetch, options.timeoutMs);
  const step = recordSample(previous ?? emptyRecord(url), sample, now());
  alerts.push(...step.alerts);

  try {
    store.save(step.record);
  } catch (cause) {
    alerts.push({ kind: "watch-degraded", url, detail: `寫入失敗:${messageOf(cause)}` });
  }

  for (const alert of alerts) emit(alert);
  return { record: step.record, alerts };
}
