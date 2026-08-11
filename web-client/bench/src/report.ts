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

import type { ExternalGpuLoad } from "./gpuload.ts";
import type { MemoryResult, PowerState } from "./memory.ts";
import { type RigExpectation, checkRigGpu } from "./rig.ts";
import type { RouteKind } from "./route.ts";
import { type DriftAnalysis, type SeriesSummary, analyseDrift, summariseSeries } from "./stats.ts";

export const REPORT_SCHEMA_VERSION = 2;

/**
 * Limitations that travel WITH the numbers.
 *
 * These were previously only in a PR comment and half a line of source. A
 * reader opening a report six months from now has neither, and both of these
 * change how a figure in that file should be read — so they ship inside it.
 */
export const KNOWN_LIMITATIONS: readonly string[] = [
  "externalGpuLoad.foreignProcessesPresent 目前在 reference rig 上尚未觀測到 false:" +
    "owner 的 Brave 與 Acrobat 常駐於同一顆 GPU。true 代表偵測到常駐行程," +
    "不代表本次量測受到干擾(消費級卡無 per-process 利用率)。",
  "中斷路徑:runBench 的 abort 處理與 --max-seconds 已端到端驗證(報告會寫出且標記 invalid)," +
    "但 Node 的 SIGINT handler 在真實 console Ctrl-C 下是否觸發,尚未在本平台驗證 —— " +
    "Windows 上 kill 與 child.kill('SIGINT') 都是 TerminateProcess,無法用來驗證。",
  "frameTimesMs 是 widget.render() 的主執行緒耗時,含 tile ingest、不含 GPU 非同步時間;" +
    "本輸出不足以判定 D1 的 6 ms 翻案條件(詳見 bench/README.md)。",
  "考卷到不了的範圍是 src/driver.ts 與 page/main.ts 兩個完整檔案。page/main.ts 沒有任何 runtime 覆蓋," +
    "而它握有逐幀計時迴圈(本報告 frameTimesMs 的唯一來源)與 readGpu()(gpuRenderer/gpuAccepted 的唯一來源)。" +
    "已實測:把 readGpu() 換成寫死字串,全部閘門仍然通過且 gpuAccepted 仍為 true。",
  "跨 run 的 p95 漂移不可作為回歸基線:同版本四次冷快取的 p95 全距為 80.70 ms(中位數的 21.84%)," +
    "而報告目前沒有欄位能區分場景、網路與機器熱狀態這三種成因。",
];

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
  chromeVersion: string;
  /**
   * The exact browser launch arguments this run used.
   *
   * Load-bearing on this rig: Chrome's default GPU preference sends it to the
   * Intel UHD, and only an explicit high-performance flag moves it to the
   * RTX 4060. The flag list is therefore part of what produced the numbers,
   * and a reader must be able to see it rather than trust that it was passed.
   */
  launchArgs: string[];
  /**
   * Headless has no display at all, so the pacing below is a synthetic
   * compositor cadence rather than a monitor. Recorded so nobody reads a
   * 32 Hz cadence as a statement about the rig's 144 Hz panel.
   */
  headless: boolean;
  screen: {
    width: number;
    height: number;
    /**
     * Observed presentation cadence, derived from the idle rAF interval — a
     * page cannot ask the OS for a refresh rate. NOT the monitor's refresh
     * rate: headless reports its own frame-sink cadence here.
     */
    presentCadenceHz: number;
  };
  /** The rig is a laptop, and mains vs battery is a different experiment. */
  power: PowerState;
  /**
   * Who else was on this GPU. D6 requires "無其他 GPU 負載", and the renderer
   * string cannot answer it — it says which card, not who else is using it.
   * Recorded, never enforced: see gpuload.ts.
   */
  externalGpuLoad: ExternalGpuLoad;
}

export interface RouteMeasurement {
  routeId: string;
  routeKind: RouteKind;
  cache: CacheState;
  /** Primary series, raw. AC2 — a later ticket can re-derive statistics nobody thought of today. */
  frameTimesMs: number[];
  /** Secondary series: presented-frame intervals, so the display cap stays visible. */
  presentIntervalsMs: number[];
  /**
   * Indices of presented-frame intervals that span a pose-batch boundary.
   *
   * Same length as frameTimesMs by construction, so `presentIntervalsMs[i] -
   * frameTimesMs[i]` remains a valid pairing — that pairing is how this ticket
   * showed ~6 ms falls outside render(). These particular samples include a
   * round trip to Node, so they are named here and excluded from the summary
   * rather than deleted, which would misalign the two series silently.
   */
  presentIntervalBoundaryIndices?: number[];
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
  /** Excludes the batch-boundary samples named below. */
  presentSummary: SeriesSummary | null;
  presentIntervalBoundaryIndices: number[];
  /** null = the series was too short to measure drift, not "no drift". */
  drift: DriftAnalysis | null;
}

/**
 * The settings this run actually used, after parsing.
 *
 * "The same version measured twice" has to mean "with the same settings", and
 * a report could not previously say what its own settings were. That gap has
 * already bitten this ticket: `npm run bench --cache cold` lets npm swallow the
 * flag (it creates a ./cold cache directory instead), run.ts never sees it,
 * silently uses the default, and produces a completely normal-looking report
 * for a configuration nobody chose. Rejecting positional arguments does not
 * catch that — a swallowed flag leaves no positional behind.
 */
export interface BenchRunConfig {
  routeIds: string[];
  cacheStates: CacheState[];
  memoryMinutes: number;
  warmupFrames: number;
  viewport: { width: number; height: number };
  gpuPreference: string;
  headless: boolean;
  /** 0 = no cap. A capped run is deliberately interrupted and reports as invalid. */
  maxSeconds: number;
}

export interface BenchReport {
  valid: boolean;
  invalidReason: string | null;
  /**
   * Which GPU actually drew these frames, verbatim, at the top level.
   *
   * The rig has two. A reader must not have to go looking for this, and a
   * report whose GPU was not the rig's is invalid — see rig.ts.
   */
  gpuRenderer: string;
  gpuAccepted: boolean;
  schemaVersion: number;
  /** null only for callers that did not supply one (the exam's fakes). */
  config: BenchRunConfig | null;
  /** Ships with the numbers; see KNOWN_LIMITATIONS. */
  limitations: readonly string[];
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
  /** Defaults to the reference rig; data rather than code so FTP-47 can move it. */
  rig?: RigExpectation;
  /** The settings this run used. Absent only in unit tests. */
  config?: BenchRunConfig;
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

/** Drift needs a beginning and an end; a short series simply has not got one. */
function tryAnalyseDrift(series: number[]): DriftAnalysis | null {
  try {
    return analyseDrift(series);
  } catch {
    return null;
  }
}

function environmentProblem(environment: BenchEnvironment): string | null {
  // Numbers without provenance are not readable. The rig is specified in
  // bench/RIG.md (FTP-47); this block is what says the run actually happened
  // on it.
  const missing: string[] = [];
  if (environment.gpuRenderer === "") missing.push("gpuRenderer");
  if (environment.browser === "") missing.push("browser");
  if (environment.cpu === "") missing.push("cpu");
  return missing.length === 0 ? null : `量測環境不完整,缺少 ${missing.join("、")}`;
}

export function assembleReport(input: AssembleInput): BenchReport {
  const problems: string[] = [];

  if (input.expected.length === 0) {
    // A run that was never asked to measure anything used to serialise as a
    // perfectly valid report with `routes: []`. The README's claim that no
    // situation produces a normal-looking JSON containing half a run is
    // unconditional, and this was a normal-looking JSON containing none of one.
    // The CLI blocks it, but runBench is the module FTP-49 calls directly.
    problems.push("沒有任何預定路線,本次未量測任何東西");
  }

  if (input.interrupted) {
    problems.push("執行中斷:本次量測未跑完,以下結果為部分資料");
  }

  const environmentIssue = environmentProblem(input.environment);
  if (environmentIssue !== null) problems.push(environmentIssue);

  // The rig has two GPUs and the wrong one produces perfectly plausible
  // numbers. Same treatment as an interrupted run: the data is kept, the
  // report refuses to bless it.
  const gpu = checkRigGpu(input.environment.gpuRenderer, input.rig);
  if (gpu.reason !== null) problems.push(gpu.reason);

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
        presentIntervalBoundaryIndices: [],
        summary: null,
        presentSummary: null,
        drift: null,
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
        presentIntervalBoundaryIndices: [],
        summary: null,
        presentSummary: null,
        drift: null,
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
    // Boundary samples carry a round trip to Node; summarising them would
    // report harness overhead as presentation stalls.
    const boundaries = new Set(measurement.presentIntervalBoundaryIndices ?? []);
    const present = trySummarise(
      measurement.presentIntervalsMs.filter((_, index) => !boundaries.has(index)),
    );

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
      presentIntervalBoundaryIndices: [...boundaries],
      summary: primary.summary,
      presentSummary: present.summary,
      // null means "the series was too short to ask", never "no drift".
      drift: tryAnalyseDrift(measurement.frameTimesMs),
    };
  });

  return {
    // First keys, deliberately. See the header: a reader meets the validity and
    // the GPU that produced these numbers before it meets a number.
    valid: problems.length === 0,
    invalidReason: problems.length === 0 ? null : problems.join("|"),
    gpuRenderer: input.environment.gpuRenderer,
    gpuAccepted: gpu.accepted,
    schemaVersion: REPORT_SCHEMA_VERSION,
    config: input.config ?? null,
    limitations: KNOWN_LIMITATIONS,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    environment: input.environment,
    routes,
    memory: input.memory,
  };
}
