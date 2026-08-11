/**
 * Exam for the run orchestration.
 *
 * This is where AC5's interruption is settled, and it is settled DETERMINISTICALLY:
 * the fake driver below aborts the run itself at a chosen call index. Nothing
 * here waits for a signal to arrive at the right moment, because a test that
 * interrupts "at about the right time" passes for the wrong reason on a slow
 * machine and is not evidence of anything.
 *
 * The driver is an interface precisely so this file can exist — the browser is
 * the untestable part, and separating it leaves the sequencing, the cold/warm
 * ordering, the failure handling and the interruption fully examinable without
 * a GPU.
 *
 * Grid — invariant x failure mode x time:
 *   I3 report honesty
 *     - interruption produces a clean-looking report .... mid run
 *     - a driver failure is swallowed ................... mid run
 *   I4 cold/warm separation
 *     - warm measured before anything warmed it ......... at scheduling time
 *   I1 replayability
 *     - route order varies between runs ................. at scheduling time
 *   resource discipline
 *     - the browser outlives the run .................... on every exit path
 *   permissions: N/A — the driver owns all I/O; this module has no authority
 *   of its own. concurrency: routes run strictly in sequence (RFC D6 measures
 *   one scene at a time); the parallel case is not merely untested, it is
 *   forbidden, and the sequencing case below pins it.
 */

import { describe, expect, it, vi } from "vitest";

import type { BenchDriver, RouteRequest } from "./session.ts";
import { runBench } from "./session.ts";
import type { RouteDefinition } from "./route.ts";
import type { CacheState, RouteMeasurement } from "./report.ts";

const route = (id: string): RouteDefinition => ({
  id,
  title: id,
  kind: "dense-buildings",
  description: "exam route",
  durationSeconds: 1,
  stepHz: 2,
  waypoints: [
    { longitude: 121.56, latitude: 25.03, height: 300, headingDegrees: 0, pitchDegrees: -20, rollDegrees: 0 },
    { longitude: 121.57, latitude: 25.03, height: 300, headingDegrees: 0, pitchDegrees: -20, rollDegrees: 0 },
  ],
});

// The rig's real renderer string: the report is only valid when the run
// happened on the rig's discrete GPU (see rig.ts), so a placeholder here would
// make every "valid run" case below fail for an unrelated reason.
const environment = {
  cpu: "test-cpu",
  gpuRenderer:
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  browser: "Chrome 151",
  chromeVersion: "151.0.7922.76",
  launchArgs: ["--force-high-performance-gpu"],
  os: "Windows 11",
  viewport: { width: 1920, height: 1080 },
  headless: true,
  screen: { width: 1920, height: 1080, presentCadenceHz: 60 },
  power: { charging: true, batteryLevel: 1, note: "navigator.getBattery()" },
  externalGpuLoad: {
    supported: true,
    foreignProcessesPresent: false,
    utilizationPctAtStart: 3,
    utilizationPctAtEnd: 4,
    foreignProcesses: [],
    note: "clean",
  },
  frameRateLimitDefeated: false,
  measurementNote: "scene.render() CPU cost",
};

interface FakeDriverOptions {
  onCall?: (request: RouteRequest, index: number) => void | Promise<void>;
  frameTimes?: number[];
  gpuRenderer?: string;
  /** Runs when the memory cycle is entered — the hook the abort cases fire from. */
  onMemoryCycle?: () => void;
}

/** Records what it was asked to do, in order, and answers with fixed samples. */
function fakeDriver(options: FakeDriverOptions = {}) {
  const calls: { routeId: string; cache: CacheState }[] = [];
  let closed = 0;
  let memoryCycles = 0;
  const driver: BenchDriver = {
    readEnvironment: () =>
      Promise.resolve(
        options.gpuRenderer === undefined
          ? environment
          : { ...environment, gpuRenderer: options.gpuRenderer },
      ),
    async runRoute(request: RouteRequest): Promise<RouteMeasurement> {
      const index = calls.length;
      calls.push({ routeId: request.route.id, cache: request.cache });
      await options.onCall?.(request, index);
      const frameTimesMs = options.frameTimes ?? [8, 9, 10];
      return {
        routeId: request.route.id,
        routeKind: request.route.kind,
        cache: request.cache,
        frameTimesMs,
        presentIntervalsMs: frameTimesMs.map((v) => v + 1),
        startedAt: "2026-08-11T00:00:00.000Z",
        finishedAt: "2026-08-11T00:00:30.000Z",
        framesExpected: frameTimesMs.length,
        framesMeasured: frameTimesMs.length,
      };
    },
    close: () => {
      closed += 1;
      return Promise.resolve();
    },
    runMemoryCycle: () => {
      memoryCycles += 1;
      options.onMemoryCycle?.();
      return Promise.resolve({
        samples: [
          { atMs: 0, usedHeapBytes: 1_000 },
          { atMs: 1_000, usedHeapBytes: 1_100 },
        ],
        context: { startedAt: "t0", finishedAt: "t1", power: null },
      });
    },
  };
  return {
    driver,
    calls,
    closeCount: () => closed,
    memoryCycleCount: () => memoryCycles,
  };
}

describe("runBench — a complete run", () => {
  it("measures every route in every requested cache state", async () => {
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a"), route("b")],
      cacheStates: ["cold", "warm"],
      driver: fake.driver,
    });
    expect(report.valid).toBe(true);
    expect(fake.calls).toHaveLength(4);
    expect(report.routes).toHaveLength(4);
  });

  it("measures a route cold before it measures it warm", async () => {
    // A "warm cache" number taken before anything populated the cache is a cold
    // number wearing a warm label — the one ordering mistake that makes AC3's
    // separation meaningless while still producing two tidy entries.
    const fake = fakeDriver();
    await runBench({
      routes: [route("a"), route("b")],
      cacheStates: ["cold", "warm"],
      driver: fake.driver,
    });
    for (const id of ["a", "b"]) {
      const forRoute = fake.calls.filter((c) => c.routeId === id).map((c) => c.cache);
      expect(forRoute).toEqual(["cold", "warm"]);
    }
  });

  it("finishes a route's cache states before moving to the next route", async () => {
    // Mutation testing found that swapping the two loops — every route cold,
    // then every route warm — passed every case here: the per-route
    // cold-before-warm check above cannot see it, and the order check below
    // only used one cache state. It is observable, though: the report's route
    // order is the schedule, and two runs that schedule differently do not
    // diff cleanly.
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a"), route("b")],
      cacheStates: ["cold", "warm"],
      driver: fake.driver,
    });
    expect(fake.calls.map((c) => `${c.routeId}:${c.cache}`)).toEqual([
      "a:cold",
      "a:warm",
      "b:cold",
      "b:warm",
    ]);
    expect(report.routes.map((r) => `${r.routeId}:${r.cache}`)).toEqual([
      "a:cold",
      "a:warm",
      "b:cold",
      "b:warm",
    ]);
  });

  it("runs routes in the order given, every time", async () => {
    // Two runs of the same version must produce comparable files; a set-ordered
    // or concurrent schedule would reorder `routes[]` between runs and make a
    // textual diff useless even when the numbers agree.
    const fake = fakeDriver();
    await runBench({
      routes: [route("a"), route("b"), route("c")],
      cacheStates: ["cold"],
      driver: fake.driver,
    });
    expect(fake.calls.map((c) => c.routeId)).toEqual(["a", "b", "c"]);
  });

  it("runs one route at a time", async () => {
    // Concurrency is forbidden here, not merely absent: two scenes rendering at
    // once share a GPU and each measures the other's load.
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = fakeDriver({
      onCall: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
    });
    await runBench({
      routes: [route("a"), route("b"), route("c")],
      cacheStates: ["cold", "warm"],
      driver: fake.driver,
    });
    expect(maxInFlight).toBe(1);
  });

  it("closes the driver", async () => {
    const fake = fakeDriver();
    await runBench({ routes: [route("a")], cacheStates: ["cold"], driver: fake.driver });
    expect(fake.closeCount()).toBe(1);
  });
});

describe("runBench — interruption", () => {
  it("marks the report invalid when aborted part way through", async () => {
    // Deterministic: the abort fires from inside the second measurement, so the
    // run is always interrupted at exactly the same point.
    const controller = new AbortController();
    const fake = fakeDriver({
      onCall: (_request, index) => {
        if (index === 1) controller.abort();
      },
    });
    const report = await runBench({
      routes: [route("a"), route("b"), route("c")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
    });
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/中斷|interrupt/i);
  });

  it("stops measuring once aborted", async () => {
    const controller = new AbortController();
    const fake = fakeDriver({
      onCall: (_request, index) => {
        if (index === 1) controller.abort();
      },
    });
    await runBench({
      routes: [route("a"), route("b"), route("c")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
    });
    // a and b were entered; c must never have been started.
    expect(fake.calls.map((c) => c.routeId)).toEqual(["a", "b"]);
  });

  it("keeps the measurements it completed before the abort", async () => {
    const controller = new AbortController();
    const fake = fakeDriver({
      onCall: (_request, index) => {
        if (index === 1) controller.abort();
      },
    });
    const report = await runBench({
      routes: [route("a"), route("b"), route("c")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
    });
    expect(report.routes.find((r) => r.routeId === "a")?.frameTimesMs).toEqual([8, 9, 10]);
  });

  it("marks the report invalid when the abort lands during the LAST route", async () => {
    /**
     * The hole mutation testing opened, and the worst one in this file.
     *
     * Every other interruption case is caught by the check at the TOP of the
     * next iteration — so with two or more routes left, deleting the check
     * after the await changes nothing. On the final route there is no next
     * iteration: the loop ends normally, `interrupted` is never set, and the
     * run produces a report that says valid=true about a run the operator
     * interrupted. That is precisely the misleading-report failure AC5 exists
     * to forbid, and nothing here could see it.
     */
    const controller = new AbortController();
    const fake = fakeDriver({
      onCall: () => {
        controller.abort();
      },
    });
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
    });
    expect(fake.calls).toHaveLength(1);
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/中斷|interrupt/i);
  });

  it("still produces a well-formed report when aborted before the first route", async () => {
    // The empty-file failure: abort during startup and write nothing, or write
    // a truncated file. Either way the next reader cannot tell a crashed run
    // from a run that never happened.
    const controller = new AbortController();
    controller.abort();
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
    });
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/中斷|interrupt/i);
    expect(report.routes.every((r) => r.valid === false)).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("closes the driver even when aborted", async () => {
    const controller = new AbortController();
    const fake = fakeDriver({
      onCall: (_request, index) => {
        if (index === 0) controller.abort();
      },
    });
    await runBench({
      routes: [route("a"), route("b")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
    });
    // A headed Chrome that outlives an interrupted bench holds a GPU and keeps
    // rendering; the next run then measures a machine that is already busy.
    expect(fake.closeCount()).toBe(1);
  });
});

/**
 * TERMINAL-POSITION STATES — a whole axis, not a bug.
 *
 * The abort test that used to exist here passed with the post-await check
 * deleted, because the check at the TOP of the next iteration caught it. That
 * generalises, and generalising it is the point of this block:
 *
 *   A state written at the END of a step, whose only reader is the entry check
 *   of the NEXT step, is unobserved for the LAST step. There is no next entry.
 *
 * So every terminal position in the pipeline needs its own case. The pipeline
 * is:  route x cache (loop)  ->  memory cycle (phase)  ->  assemble report.
 *
 *   last iteration of the route loop ... covered in "interruption" above
 *   the memory cycle, i.e. the last phase ... covered here
 *   entry to the memory cycle after a failure ... covered here
 *
 * The second of those was a REAL surviving hole found in review: an abort
 * during the 15-minute memory cycle left `interrupted` unset and published
 * `valid: true` for an interrupted run — the identical AC5 failure that was
 * fixed for the last route, one phase later. Fixing only the instance would
 * have left the third one open too.
 */
describe("runBench — the last phase, not just the last route", () => {
  it("runs the memory cycle and reports its result on a clean run", async () => {
    // The positive control. Without it, "the cycle did not run" would pass
    // every negative case below.
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
      memoryMinutes: 15,
    });
    expect(fake.memoryCycleCount()).toBe(1);
    expect(report.memory).not.toBeNull();
    expect(report.memory?.growthRatio).toBeCloseTo(0.1, 10);
    expect(report.valid).toBe(true);
  });

  it("marks the report invalid when the abort lands during the memory cycle", async () => {
    // The hole. Every route has already finished, so the route loop's entry
    // check will never run again — if the cycle does not check for itself, an
    // interrupted 15-minute run is published as valid.
    const controller = new AbortController();
    const fake = fakeDriver({
      onMemoryCycle: () => {
        controller.abort();
      },
    });
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
      memoryMinutes: 15,
    });
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/中斷|interrupt/i);
    // Label, never discard: the samples it did collect stay in the report.
    expect(report.memory).not.toBeNull();
  });

  it("does not start the memory cycle when the run was already interrupted", async () => {
    // A 15-minute cycle after the operator pressed Ctrl-C is fifteen minutes of
    // work nobody asked for, appended to a run already known to be void.
    const controller = new AbortController();
    const fake = fakeDriver({
      onCall: () => {
        controller.abort();
      },
    });
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
      signal: controller.signal,
      memoryMinutes: 15,
    });
    expect(fake.memoryCycleCount()).toBe(0);
    expect(report.valid).toBe(false);
  });

  it("does not start the memory cycle after a driver failure", async () => {
    const fake = fakeDriver({
      onCall: () => {
        throw new Error("browser died");
      },
    });
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
      memoryMinutes: 15,
    });
    expect(fake.memoryCycleCount()).toBe(0);
    expect(report.valid).toBe(false);
  });

  it("does not run the cycle when it was not asked for", async () => {
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
    });
    expect(fake.memoryCycleCount()).toBe(0);
    expect(report.memory).toBeNull();
    expect(report.valid).toBe(true);
  });

  it("says so when the cycle was asked for but the driver cannot do it", async () => {
    // Silence here would read as "memory was fine", which is the same shape as
    // summarising an empty series to zero.
    const fake = fakeDriver();
    // Built explicitly rather than by destructuring the fake: pulling a method
    // off an object detaches it from its receiver, which lint rightly objects to.
    const withoutCycle: BenchDriver = {
      readEnvironment: () => fake.driver.readEnvironment(),
      runRoute: (request) => fake.driver.runRoute(request),
      close: () => fake.driver.close(),
    };
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: withoutCycle,
      memoryMinutes: 15,
    });
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/記憶體|memory/i);
  });
});

describe("runBench — the settings a report ran under", () => {
  it("records the configuration it was given", async () => {
    // "The same version measured twice" has to mean "with the same settings".
    // A report that cannot state its own settings cannot support that, and this
    // ticket already produced runs whose --cache flag npm had swallowed.
    const fake = fakeDriver();
    const config = {
      routeIds: ["a"],
      cacheStates: ["cold" as const],
      memoryMinutes: 0,
      warmupFrames: 0,
      viewport: { width: 1920, height: 1080 },
      gpuPreference: "high-performance",
      headless: true,
      maxSeconds: 0,
    };
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
      config,
    });
    expect(report.config).toEqual(config);
  });

  it("says the settings are unknown rather than inventing them", async () => {
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
    });
    expect(report.config).toBeNull();
  });
});

describe("runBench — external GPU load", () => {
  it("brackets the run with a second utilisation reading", async () => {
    // One reading taken before the run cannot show that something else started
    // up half way through, and that is exactly the case that makes two runs of
    // the same version disagree. The pair is the evidence.
    const fake = fakeDriver();
    const driver: BenchDriver = {
      ...fake.driver,
      readGpuUtilisationNow: () => Promise.resolve("47"),
    };
    const report = await runBench({ routes: [route("a")], cacheStates: ["cold"], driver });
    expect(report.environment.externalGpuLoad.utilizationPctAtEnd).toBe(47);
    // The start reading came from readEnvironment and must survive untouched.
    expect(report.environment.externalGpuLoad.utilizationPctAtStart).toBe(3);
  });

  it("leaves the reading alone when the rig cannot supply one", async () => {
    // A driver without the capability must not turn into a fabricated number.
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
    });
    expect(report.environment.externalGpuLoad.utilizationPctAtEnd).toBe(4);
  });

  it("survives a driver that throws while reading utilisation", async () => {
    // Housekeeping must never destroy the run — the same rule that the EBUSY
    // cleanup bug taught this harness the hard way.
    const fake = fakeDriver();
    const driver: BenchDriver = {
      ...fake.driver,
      readGpuUtilisationNow: () => Promise.reject(new Error("nvidia-smi exploded")),
    };
    const report = await runBench({ routes: [route("a")], cacheStates: ["cold"], driver });
    expect(report.valid).toBe(true);
  });
});

describe("runBench — wrong GPU", () => {
  const INTEL_UHD =
    "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)";

  it("does not measure at all when the browser landed on the wrong GPU", async () => {
    // Measuring for twenty minutes to produce numbers the report will refuse to
    // bless is pure waste, and the wrong-GPU case is not rare on this rig — it
    // is what happens by default. The check is cheap and comes first.
    const fake = fakeDriver({ gpuRenderer: INTEL_UHD });
    const report = await runBench({
      routes: [route("a"), route("b")],
      cacheStates: ["cold", "warm"],
      driver: fake.driver,
    });
    expect(fake.calls).toHaveLength(0);
    expect(report.valid).toBe(false);
    expect(report.gpuAccepted).toBe(false);
    expect(report.invalidReason).toMatch(/Intel/);
  });

  it("still closes the browser it opened to find that out", async () => {
    const fake = fakeDriver({ gpuRenderer: INTEL_UHD });
    await runBench({ routes: [route("a")], cacheStates: ["cold"], driver: fake.driver });
    expect(fake.closeCount()).toBe(1);
  });

  it("measures normally on the rig's GPU", async () => {
    // The control for the two cases above: same code path, correct GPU.
    const fake = fakeDriver();
    const report = await runBench({
      routes: [route("a")],
      cacheStates: ["cold"],
      driver: fake.driver,
    });
    expect(fake.calls).toHaveLength(1);
    expect(report.valid).toBe(true);
  });
});

describe("runBench — driver failure", () => {
  it("marks the report invalid and names the route", async () => {
    const fake = fakeDriver({
      onCall: (request) => {
        if (request.route.id === "b") throw new Error("browser died");
      },
    });
    const report = await runBench({
      routes: [route("a"), route("b"), route("c")],
      cacheStates: ["cold"],
      driver: fake.driver,
    });
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/b/);
  });

  it("stops rather than pretending the remaining routes are fine", async () => {
    const fake = fakeDriver({
      onCall: (request) => {
        if (request.route.id === "b") throw new Error("browser died");
      },
    });
    await runBench({
      routes: [route("a"), route("b"), route("c")],
      cacheStates: ["cold"],
      driver: fake.driver,
    });
    expect(fake.calls.map((c) => c.routeId)).toEqual(["a", "b"]);
  });

  it("closes the driver on the failure path", async () => {
    const fake = fakeDriver({
      onCall: () => {
        throw new Error("browser died");
      },
    });
    await runBench({ routes: [route("a")], cacheStates: ["cold"], driver: fake.driver });
    expect(fake.closeCount()).toBe(1);
  });

  it("bounds the failure text it copies into the report", async () => {
    // Project discipline: never echo an unbounded upstream string into an
    // artefact. The failure here can carry a message from the browser, and a
    // report is a file other people open.
    const fake = fakeDriver({
      onCall: () => {
        throw new Error("x".repeat(20_000));
      },
    });
    const report = await runBench({ routes: [route("a")], cacheStates: ["cold"], driver: fake.driver });
    expect(report.invalidReason!.length).toBeLessThan(1_000);
  });
});

describe("runBench — progress", () => {
  it("reports each route as it starts", async () => {
    // A 15-minute run with no output is indistinguishable from a hung one.
    const onProgress = vi.fn();
    const fake = fakeDriver();
    await runBench({
      routes: [route("a"), route("b")],
      cacheStates: ["cold"],
      driver: fake.driver,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
    const routeIds = onProgress.mock.calls.map((c) => (c[0] as { routeId?: string }).routeId);
    expect(routeIds).toContain("a");
    expect(routeIds).toContain("b");
  });
});
