/**
 * Run orchestration: what gets measured, in what order, and what happens when
 * the run does not finish.
 *
 * The browser lives behind `BenchDriver` so that everything decidable — the
 * schedule, the cold-before-warm ordering, the abort handling, the failure
 * handling — is testable without a GPU. That split is not tidiness: the
 * interruption case in AC5 is the one this harness is most likely to get wrong
 * and least likely to notice, and it can only be pinned deterministically if a
 * fake can decide exactly when the abort lands.
 */

import type { MemoryContext, MemoryResult, MemorySample } from "./memory.ts";
import { summariseMemory } from "./memory.ts";
import type {
  BenchEnvironment,
  BenchReport,
  BenchRunConfig,
  CacheState,
  ExpectedRoute,
  RouteFailure,
  RouteMeasurement,
} from "./report.ts";
import { UNMEASURED_GPU_LOAD } from "./gpuload.ts";
import { assembleReport, bounded } from "./report.ts";
import { type RigExpectation, checkRigGpu } from "./rig.ts";
import type { RouteDefinition } from "./route.ts";

export interface RouteRequest {
  route: RouteDefinition;
  cache: CacheState;
  signal: AbortSignal;
}

export interface MemoryCycleRequest {
  routes: readonly RouteDefinition[];
  minutes: number;
  signal: AbortSignal;
}

export interface MemoryCycleResult {
  samples: MemorySample[];
  /** When it ran and on what power — the rig is a laptop, so both matter. */
  context: MemoryContext;
}

export interface BenchDriver {
  readEnvironment(): Promise<BenchEnvironment>;
  runRoute(request: RouteRequest): Promise<RouteMeasurement>;
  close(): Promise<void>;
  /** GPU utilisation right now, as nvidia-smi prints it. Optional: not every rig has it. */
  readGpuUtilisationNow?(): Promise<string | null>;
  /** Optional so a test double can omit it; only called when memoryMinutes is set. */
  runMemoryCycle?(request: MemoryCycleRequest): Promise<MemoryCycleResult>;
}

export interface BenchProgress {
  phase: "route-start" | "route-done" | "memory-start" | "memory-done";
  routeId: string | null;
  cache: CacheState | null;
  message: string;
}

export interface RunBenchOptions {
  routes: readonly RouteDefinition[];
  cacheStates: readonly CacheState[];
  driver: BenchDriver;
  signal?: AbortSignal;
  onProgress?: (progress: BenchProgress) => void;
  memoryMinutes?: number;
  /** Defaults to the reference rig. Data, so FTP-47 can move it without code changes. */
  rig?: RigExpectation;
  /** Recorded verbatim in the report so a run can state its own settings. */
  config?: BenchRunConfig;
  now?: () => string;
}

/** What the report says when the driver could not tell us where it ran. */
const UNKNOWN_ENVIRONMENT: BenchEnvironment = {
  cpu: "",
  gpuRenderer: "",
  browser: "",
  chromeVersion: "",
  launchArgs: [],
  os: "",
  viewport: { width: 0, height: 0 },
  headless: true,
  screen: { width: 0, height: 0, presentCadenceHz: 0 },
  power: { charging: null, batteryLevel: null, note: "環境讀取失敗,電源狀態未知" },
  externalGpuLoad: UNMEASURED_GPU_LOAD,
  frameRateLimitDefeated: false,
  measurementNote: "",
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export async function runBench(options: RunBenchOptions): Promise<BenchReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();

  // A signal always exists so the driver can be written one way; when the
  // caller supplied none, this one simply never fires.
  const signal = options.signal ?? new AbortController().signal;

  // The plan is built once, in the order it will run: routes in the order
  // given, and for each route every cache state in the order given. Cold comes
  // before warm because a "warm cache" number taken before anything populated
  // the cache is a cold number wearing a warm label.
  const plan: { route: RouteDefinition; cache: CacheState }[] = [];
  for (const route of options.routes) {
    for (const cache of options.cacheStates) plan.push({ route, cache });
  }
  const expected: ExpectedRoute[] = plan.map(({ route, cache }) => ({
    routeId: route.id,
    routeKind: route.kind,
    cache,
  }));

  const measurements: RouteMeasurement[] = [];
  const failures: RouteFailure[] = [];
  const extraProblems: string[] = [];
  let environment = UNKNOWN_ENVIRONMENT;
  let memory: MemoryResult | null = null;
  let interrupted = false;

  try {
    try {
      environment = await options.driver.readEnvironment();
    } catch (cause) {
      extraProblems.push(`無法取得量測環境:${messageOf(cause)}`);
    }

    // Checked before anything is measured. On the reference rig Chrome lands on
    // the integrated GPU unless told otherwise, so this is the DEFAULT outcome,
    // not an edge case — and spending twenty minutes producing frame times the
    // report will refuse to bless is pure waste. assembleReport states the
    // reason; this only records that nothing was measured because of it.
    const gpu = checkRigGpu(environment.gpuRenderer, options.rig);
    const measurable = gpu.accepted;
    if (!measurable) extraProblems.push("GPU 不符 reference rig,已於量測前中止,未取得任何 frame");

    for (const { route, cache } of measurable ? plan : []) {
      if (signal.aborted) {
        interrupted = true;
        break;
      }
      options.onProgress?.({
        phase: "route-start",
        routeId: route.id,
        cache,
        message: `量測 ${route.id}(${cache})`,
      });

      let measurement: RouteMeasurement;
      try {
        measurement = await options.driver.runRoute({ route, cache, signal });
      } catch (cause) {
        // Stop rather than carry on. A driver failure normally means the
        // browser is gone, and continuing would produce a run whose remaining
        // routes failed for a reason the report would attribute to the scene.
        failures.push({ routeId: route.id, cache, detail: messageOf(cause) });
        break;
      }

      measurements.push(measurement);
      options.onProgress?.({
        phase: "route-done",
        routeId: route.id,
        cache,
        message: `完成 ${route.id}(${cache}):${measurement.framesMeasured} frames`,
      });

      // Checked again after the await: the abort can land while a route is
      // being measured, and that route's data is kept — labelled by the
      // report's top-level `valid`, not silently dropped.
      if (signal.aborted) {
        interrupted = true;
        break;
      }
    }

    const canRunMemory =
      measurable &&
      options.memoryMinutes !== undefined &&
      options.memoryMinutes > 0 &&
      !interrupted &&
      failures.length === 0;
    if (canRunMemory) {
      if (options.driver.runMemoryCycle === undefined) {
        extraProblems.push("要求記憶體循環量測,但這個 driver 不支援");
      } else {
        options.onProgress?.({
          phase: "memory-start",
          routeId: null,
          cache: null,
          message: `記憶體循環量測 ${options.memoryMinutes} 分鐘`,
        });
        try {
          const cycle = await options.driver.runMemoryCycle({
            routes: options.routes,
            minutes: options.memoryMinutes!,
            signal,
          });
          memory = summariseMemory(cycle.samples, cycle.context);
          options.onProgress?.({
            phase: "memory-done",
            routeId: null,
            cache: null,
            message: `記憶體成長 ${(memory.growthRatio * 100).toFixed(2)}%`,
          });
        } catch (cause) {
          extraProblems.push(`記憶體循環量測失敗:${messageOf(cause)}`);
        }
        if (signal.aborted) interrupted = true;
      }
    }
  } finally {
    try {
      // Always. A headed Chrome that outlives an interrupted bench keeps a GPU
      // busy, and the next run would then measure a machine that is not idle.
      await options.driver.close();
    } catch (cause) {
      extraProblems.push(`關閉瀏覽器失敗:${messageOf(cause)}`);
    }
  }

  // Sampled after the last route, so the pair brackets the measurement. One
  // reading taken before the run cannot show that something else started up
  // half way through — which is precisely the case that makes two runs of the
  // same version disagree.
  const endUtilisation = await Promise.resolve(options.driver.readGpuUtilisationNow?.()).catch(
    () => null,
  );
  const endPct = endUtilisation == null ? null : Number(endUtilisation.trim());
  const environmentAtEnd: BenchEnvironment =
    endPct === null || !Number.isFinite(endPct)
      ? environment
      : {
          ...environment,
          externalGpuLoad: { ...environment.externalGpuLoad, utilizationPctAtEnd: endPct },
        };

  return assembleReport({
    expected,
    measurements,
    environment: environmentAtEnd,
    memory,
    interrupted,
    startedAt,
    finishedAt: now(),
    failures,
    extraProblems: extraProblems.map(bounded),
    ...(options.rig === undefined ? {} : { rig: options.rig }),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
}
