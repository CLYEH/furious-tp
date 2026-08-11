/**
 * Report assembly.
 *
 * AC5: "中斷跑 → 部分結果標記 invalid,不產生可誤判之報告".
 *
 * The failure this module exists to prevent is silent. A run that dies half way
 * through still writes a file, and that file has the same shape, the same keys
 * and the same plausible numbers as a good one — it is simply missing half the
 * evidence. Nothing downstream can tell the difference unless the report says
 * so about itself, so `valid` is the FIRST key of the object and therefore the
 * first thing in the serialised JSON: a reader meets it before it meets a
 * number.
 *
 * The rule throughout is label, never discard. A partial run is still evidence;
 * deleting it would turn a recoverable 20-minute run into a lost one.
 */

import type { MemoryResult } from "./memory.ts";
import type { RouteKind } from "./route.ts";
import { type SeriesSummary, summariseSeries } from "./stats.ts";

export const REPORT_SCHEMA_VERSION = 1;

export type CacheState = "cold" | "warm";

export interface BenchEnvironment {
  cpu: string;
  /** WebGL UNMASKED_RENDERER — the only trustworthy statement of which GPU drew this. */
  gpuRenderer: string;
  browser: string;
  os: string;
  viewport: { width: number; height: number };
  /**
   * Whether the browser's frame rate cap was actually removed.
   *
   * When false, any measurement derived from presented-frame intervals is a
   * measurement of the display, not of the renderer. Recorded rather than
   * assumed because the flags that are supposed to defeat vsync do not always
   * work, and a reader has no other way to know.
   */
  frameRateLimitDefeated: boolean;
  /** What the primary frame-time series actually is. */
  measurementNote: string;
  /** Median rAF interval observed on this machine — the evidence for the flag above. */
  presentIntervalMedianMs?: number;
}

export interface RouteMeasurement {
  routeId: string;
  routeKind: RouteKind;
  cache: CacheState;
  /** Primary series, raw. AC2 — a later ticket can re-derive statistics nobody thought of today. */
  frameTimesMs: number[];
  /** Secondary series: presented-frame intervals, so the display cap stays visible. */
  presentIntervalsMs: number[];
  startedAt: string;
  finishedAt: string;
  framesExpected: number;
  framesMeasured: number;
}

export interface ExpectedRoute {
  routeId: string;
  routeKind: RouteKind;
  cache: CacheState;
}

export interface RouteFailure {
  routeId: string;
  cache: CacheState;
  detail: string;
}

export interface RouteReport {
  routeId: string;
  routeKind: RouteKind;
  cache: CacheState;
  valid: boolean;
  invalidReason: string | null;
  framesExpected: number;
  framesMeasured: number;
  startedAt: string | null;
  finishedAt: string | null;
  frameTimesMs: number[];
  presentIntervalsMs: number[];
  summary: SeriesSummary | null;
  presentSummary: SeriesSummary | null;
}

export interface BenchReport {
  valid: boolean;
  invalidReason: string | null;
  schemaVersion: number;
  startedAt: string;
  finishedAt: string;
  environment: BenchEnvironment;
  routes: RouteReport[];
  memory: MemoryResult | null;
}

export interface AssembleInput {
  expected: readonly ExpectedRoute[];
  measurements: readonly RouteMeasurement[];
  environment: BenchEnvironment;
  memory: MemoryResult | null;
  interrupted: boolean;
  startedAt: string;
  finishedAt: string;
  failures?: readonly RouteFailure[];
  /** Problems the caller detected that belong to no single route. */
  extraProblems?: readonly string[];
}

/**
 * Upstream text never reaches an artefact unbounded.
 *
 * Same rule as `displayId` in src/nlsc/fingerprint.ts: a failure detail can
 * carry whatever the browser or the network decided to say, and a report is a
 * file other people open.
 */
const MAX_DETAIL_CHARS = 200;
export const bounded = (text: string): string =>
  text.length <= MAX_DETAIL_CHARS
    ? text
    : `${text.slice(0, MAX_DETAIL_CHARS)}…(共 ${text.length} 字元)`;

/** Summarise, or say why not. Never return a summary built from unusable input. */
function trySummarise(series: number[]): { summary: SeriesSummary | null; problem: string | null } {
  if (series.length === 0) return { summary: null, problem: null };
  try {
    return { summary: summariseSeries(series), problem: null };
  } catch (cause) {
    return {
      summary: null,
      problem: bounded(cause instanceof Error ? cause.message : String(cause)),
    };
  }
}

function environmentProblem(environment: BenchEnvironment): string | null {
  // Numbers without provenance are not readable, and FTP-47 has not defined the
  // reference rig — the environment block is currently the ONLY thing that says
  // what these figures are figures of.
  const missing: string[] = [];
  if (environment.gpuRenderer === "") missing.push("gpuRenderer");
  if (environment.browser === "") missing.push("browser");
  if (environment.cpu === "") missing.push("cpu");
  return missing.length === 0 ? null : `量測環境不完整,缺少 ${missing.join("、")}`;
}

export function assembleReport(input: AssembleInput): BenchReport {
  const problems: string[] = [];

  if (input.interrupted) {
    problems.push("執行中斷:本次量測未跑完,以下結果為部分資料");
  }

  const environmentIssue = environmentProblem(input.environment);
  if (environmentIssue !== null) problems.push(environmentIssue);

  for (const problem of input.extraProblems ?? []) problems.push(bounded(problem));

  const routes: RouteReport[] = input.expected.map((expected) => {
    const where = `${expected.routeId}(${expected.cache})`;
    const base = {
      routeId: expected.routeId,
      routeKind: expected.routeKind,
      cache: expected.cache,
    };

    const failure = input.failures?.find(
      (f) => f.routeId === expected.routeId && f.cache === expected.cache,
    );
    if (failure !== undefined) {
      const reason = `量測失敗:${bounded(failure.detail)}`;
      problems.push(`路線 ${where} ${reason}`);
      return {
        ...base,
        valid: false,
        invalidReason: reason,
        framesExpected: 0,
        framesMeasured: 0,
        startedAt: null,
        finishedAt: null,
        frameTimesMs: [],
        presentIntervalsMs: [],
        summary: null,
        presentSummary: null,
      };
    }

    const measurement = input.measurements.find(
      (m) => m.routeId === expected.routeId && m.cache === expected.cache,
    );
    if (measurement === undefined) {
      problems.push(`缺少量測:${where}`);
      return {
        ...base,
        valid: false,
        invalidReason: "未取得量測",
        framesExpected: 0,
        framesMeasured: 0,
        startedAt: null,
        finishedAt: null,
        frameTimesMs: [],
        presentIntervalsMs: [],
        summary: null,
        presentSummary: null,
      };
    }

    const reasons: string[] = [];
    if (measurement.framesMeasured === 0) {
      reasons.push("沒有任何 frame 樣本");
    } else if (measurement.framesMeasured !== measurement.framesExpected) {
      reasons.push(`只完成 ${measurement.framesMeasured}/${measurement.framesExpected} frames`);
    }

    const primary = trySummarise(measurement.frameTimesMs);
    if (primary.problem !== null) reasons.push(`frame time 序列無法統計:${primary.problem}`);
    const present = trySummarise(measurement.presentIntervalsMs);

    if (reasons.length > 0) problems.push(`路線 ${where}:${reasons.join(";")}`);

    return {
      ...base,
      valid: reasons.length === 0,
      invalidReason: reasons.length === 0 ? null : reasons.join(";"),
      framesExpected: measurement.framesExpected,
      framesMeasured: measurement.framesMeasured,
      startedAt: measurement.startedAt,
      finishedAt: measurement.finishedAt,
      // The raw series is kept whatever else is wrong with the route.
      frameTimesMs: measurement.frameTimesMs,
      presentIntervalsMs: measurement.presentIntervalsMs,
      summary: primary.summary,
      presentSummary: present.summary,
    };
  });

  return {
    // First key, deliberately. See the header.
    valid: problems.length === 0,
    invalidReason: problems.length === 0 ? null : problems.join("|"),
    schemaVersion: REPORT_SCHEMA_VERSION,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    environment: input.environment,
    routes,
    memory: input.memory,
  };
}
