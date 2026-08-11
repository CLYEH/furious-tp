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
  screen: { width: 1920, height: 1080, estimatedRefreshHz: 60 },
  power: { charging: true, batteryLevel: 1, note: "navigator.getBattery()" },
  frameRateLimitDefeated: false,
  measurementNote: "scene.render() CPU cost",
};

interface FakeDriverOptions {
  onCall?: (request: RouteRequest, index: number) => void | Promise<void>;
  frameTimes?: number[];
}

/** Records what it was asked to do, in order, and answers with fixed samples. */
function fakeDriver(options: FakeDriverOptions = {}) {
  const calls: { routeId: string; cache: CacheState }[] = [];
  let closed = 0;
  const driver: BenchDriver = {
    readEnvironment: () => Promise.resolve(environment),
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
  };
  return {
    driver,
    calls,
    closeCount: () => closed,
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
