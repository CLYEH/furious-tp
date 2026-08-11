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

import type { MemoryResult, MemorySample } from "./memory.ts";
import { summariseMemory } from "./memory.ts";
import type {
  BenchEnvironment,
  BenchReport,
  CacheState,
  ExpectedRoute,
  RouteFailure,
  RouteMeasurement,
} from "./report.ts";
import { assembleReport, bounded } from "./report.ts";
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

export interface BenchDriver {
  readEnvironment(): Promise<BenchEnvironment>;
  runRoute(request: RouteRequest): Promise<RouteMeasurement>;
  close(): Promise<void>;
  /** Optional so a test double can omit it; only called when memoryMinutes is set. */
  runMemoryCycle?(request: MemoryCycleRequest): Promise<MemorySample[]>;
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
  now?: () => string;
}

/** What the report says when the driver could not tell us where it ran. */
const UNKNOWN_ENVIRONMENT: BenchEnvironment = {
  cpu: "",
  gpuRenderer: "",
  browser: "",
  os: "",
  viewport: { width: 0, height: 0 },
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

    for (const { route, cache } of plan) {
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
          const samples = await options.driver.runMemoryCycle({
            routes: options.routes,
            minutes: options.memoryMinutes!,
            signal,
          });
          memory = summariseMemory(samples);
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

  return assembleReport({
    expected,
    measurements,
    environment,
    memory,
    interrupted,
    startedAt,
    finishedAt: now(),
    failures,
    extraProblems: extraProblems.map(bounded),
  });
}
