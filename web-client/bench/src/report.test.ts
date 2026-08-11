/**
 * Exam for report assembly.
 *
 * AC5 — "中斷跑 → 部分結果標記 invalid,不產生可誤判之報告" — is the reason this
 * module exists as a separate, pure function. Its failure mode is silent: a
 * JSON file that looks exactly like a good one and contains half a run. So the
 * cases below are mostly about what the report says about ITSELF.
 *
 * Grid — invariant x failure mode x time:
 *   I3 report honesty
 *     - a partial run serialises as a complete one ....... at assembly time
 *     - the invalid marker is nested where nobody reads .. at serialise time
 *     - an empty series is summarised to zeros ........... at assembly time
 *     - NaN/undefined silently dropped by JSON ........... at serialise time
 *   I4 cold/warm separation
 *     - the two cache states share one summary ........... at assembly time
 *   I6 measurement provenance
 *     - numbers ship without the environment that made them ... at assembly time
 *   permissions: N/A — pure assembly, the caller owns the filesystem.
 *   concurrency: N/A — no shared state; the interrupted case is covered in
 *   session.test.ts, where the abort actually happens.
 */

import { describe, expect, it } from "vitest";

import { REPORT_SCHEMA_VERSION, type RouteMeasurement, assembleReport } from "./report.ts";
import { summariseSeries } from "./stats.ts";

/**
 * The reference rig's real renderer string. Not a placeholder: the report is
 * only valid when the run happened on the rig's discrete GPU, so the fixture
 * has to be a string that actually passes that check.
 */
const RTX_4060 =
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)";

/** The integrated GPU in the same laptop. */
const INTEL_UHD =
  "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)";

const environment = () => ({
  cpu: "test-cpu",
  gpuRenderer: RTX_4060,
  browser: "Chrome 151.0.0.0",
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
});

const measurement = (
  routeId: string,
  cache: "cold" | "warm",
  frameTimesMs: number[],
  framesExpected = frameTimesMs.length,
): RouteMeasurement => ({
  routeId,
  routeKind: "dense-buildings",
  cache,
  frameTimesMs,
  presentIntervalsMs: frameTimesMs.map((v) => v + 1),
  startedAt: "2026-08-11T00:00:00.000Z",
  finishedAt: "2026-08-11T00:01:00.000Z",
  framesExpected,
  framesMeasured: frameTimesMs.length,
});

const expected = (routeId: string, cache: "cold" | "warm") => ({
  routeId,
  routeKind: "dense-buildings" as const,
  cache,
});

const input = (over: Partial<Parameters<typeof assembleReport>[0]> = {}) => ({
  expected: [expected("a", "cold"), expected("a", "warm")],
  measurements: [measurement("a", "cold", [8, 9, 10]), measurement("a", "warm", [7, 8, 9])],
  environment: environment(),
  memory: null,
  interrupted: false,
  startedAt: "2026-08-11T00:00:00.000Z",
  finishedAt: "2026-08-11T00:02:00.000Z",
  ...over,
});

describe("assembleReport — a complete run", () => {
  it("is valid, with no reason to give", () => {
    const report = assembleReport(input());
    expect(report.valid).toBe(true);
    expect(report.invalidReason).toBeNull();
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });

  it("carries the raw frame time series as well as the summary", () => {
    // AC2: "輸出原始 frame time 序列 + 摘要統計 JSON". The raw series is the
    // part that lets a later ticket re-derive a statistic nobody thought of
    // today; a report with only summaries cannot be re-analysed.
    const report = assembleReport(input());
    const cold = report.routes.find((r) => r.cache === "cold");
    expect(cold?.frameTimesMs).toEqual([8, 9, 10]);
    expect(cold?.summary?.p95Ms).toBe(summariseSeries([8, 9, 10]).p95Ms);
  });

  it("summarises the SECOND series separately from the first", () => {
    // The secondary series exists solely to keep the display cadence visible
    // rather than silently reported as frame time. A mutant replacing
    // presentSummary with a copy of the primary summary survived the whole
    // exam, which means that protection was not actually being checked.
    const report = assembleReport(input());
    const cold = report.routes.find((r) => r.cache === "cold");
    // measurement() builds presentIntervalsMs as frameTimesMs + 1.
    expect(cold?.summary?.p50Ms).toBe(9);
    expect(cold?.presentSummary?.p50Ms).toBe(10);
    expect(cold?.presentSummary?.p50Ms).not.toBe(cold?.summary?.p50Ms);
  });

  it("keeps the requested route order, so two runs diff cleanly", () => {
    const report = assembleReport(input());
    expect(report.routes.map((r) => `${r.routeId}:${r.cache}`)).toEqual(["a:cold", "a:warm"]);
  });
});

describe("assembleReport — nothing was asked for", () => {
  it("refuses to call a run with no expected routes valid", () => {
    // README states unconditionally that no situation produces a normal-looking
    // JSON containing half a run. An empty plan produced a normal-looking JSON
    // containing NO run. The CLI blocks this, but runBench is the module FTP-49
    // calls directly, and the claim was unconditional.
    const report = assembleReport(input({ expected: [], measurements: [] }));
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/沒有任何|no routes/i);
    expect(report.routes).toEqual([]);
  });
});

describe("assembleReport — the invalid marker", () => {
  /**
   * The literal reading of "invalid 標記在報告的最上層": `valid` is the first
   * key of the object and therefore the first key of the serialised JSON. Any
   * reader — a human opening the file, a `head -c 200`, a later regression
   * tool — meets it before it meets a number.
   */
  it("is the first key of the object and of the JSON text", () => {
    const report = assembleReport(input({ interrupted: true }));
    expect(Object.keys(report)[0]).toBe("valid");
    expect(Object.keys(report)[1]).toBe("invalidReason");
    expect(JSON.stringify(report).startsWith('{"valid":false,"invalidReason":')).toBe(true);
  });

  it("is present and false on every way a run can be incomplete", () => {
    const interrupted = assembleReport(input({ interrupted: true }));
    const missingRoute = assembleReport(
      input({ measurements: [measurement("a", "cold", [8, 9, 10])] }),
    );
    const shortRoute = assembleReport(
      input({
        measurements: [
          measurement("a", "cold", [8, 9, 10], 100),
          measurement("a", "warm", [7, 8, 9]),
        ],
      }),
    );
    for (const report of [interrupted, missingRoute, shortRoute]) {
      expect(report.valid).toBe(false);
      expect(report.invalidReason).not.toBeNull();
      expect(report.invalidReason).not.toBe("");
    }
  });

  it("names the interruption when the run was interrupted", () => {
    const report = assembleReport(input({ interrupted: true }));
    expect(report.invalidReason).toMatch(/中斷|interrupt/i);
  });

  it("names the route that is missing", () => {
    const report = assembleReport(input({ measurements: [measurement("a", "cold", [8, 9, 10])] }));
    expect(report.invalidReason).toMatch(/a/);
    expect(report.invalidReason).toMatch(/warm/);
  });

  it("says how far a truncated route actually got", () => {
    const report = assembleReport(
      input({
        measurements: [
          measurement("a", "cold", [8, 9, 10], 100),
          measurement("a", "warm", [7, 8, 9]),
        ],
      }),
    );
    const cold = report.routes.find((r) => r.cache === "cold");
    expect(cold?.valid).toBe(false);
    expect(cold?.framesMeasured).toBe(3);
    expect(cold?.framesExpected).toBe(100);
    expect(cold?.invalidReason).toMatch(/3/);
    expect(cold?.invalidReason).toMatch(/100/);
  });

  it("marks the individual route as well as the whole report", () => {
    // Top level answers "can I trust this file". Per route answers "which part
    // of it". Losing the second turns one bad route into a discarded run.
    const report = assembleReport(input({ measurements: [measurement("a", "cold", [8, 9, 10])] }));
    const cold = report.routes.find((r) => r.cache === "cold");
    const warm = report.routes.find((r) => r.cache === "warm");
    expect(cold?.valid).toBe(true);
    expect(warm?.valid).toBe(false);
  });

  it("keeps the data it did collect rather than discarding it", () => {
    // A partial run is still evidence; the rule is to label it, not delete it.
    const report = assembleReport(
      input({
        interrupted: true,
        measurements: [measurement("a", "cold", [8, 9, 10])],
      }),
    );
    expect(report.valid).toBe(false);
    expect(report.routes.find((r) => r.cache === "cold")?.frameTimesMs).toEqual([8, 9, 10]);
  });

  it("summarises nothing for a route that produced no frames", () => {
    // The dangerous shape: a zero-length series summarised to zeros, which read
    // as the best frame times ever recorded.
    const report = assembleReport(
      input({
        measurements: [measurement("a", "cold", [], 100), measurement("a", "warm", [7, 8, 9])],
      }),
    );
    const cold = report.routes.find((r) => r.cache === "cold");
    expect(cold?.summary).toBeNull();
    expect(cold?.valid).toBe(false);
    expect(report.valid).toBe(false);
  });
});

describe("assembleReport — drift", () => {
  it("carries the throttling diagnostic for a series long enough to have one", () => {
    const rising = [...Array.from({ length: 50 }, () => 10), ...Array.from({ length: 50 }, () => 15)];
    const report = assembleReport(
      input({
        measurements: [measurement("a", "cold", rising), measurement("a", "warm", [7, 8, 9])],
      }),
    );
    expect(report.routes.find((r) => r.cache === "cold")?.drift?.suspectedThrottling).toBe(true);
    // Diagnostic, not verdict: a hot laptop is a fact about the rig, and
    // deciding what to do about it is FTP-49's job.
    expect(report.routes.find((r) => r.cache === "cold")?.valid).toBe(true);
    expect(report.valid).toBe(true);
  });

  it("reports drift as unmeasured, not as zero, when the series is too short", () => {
    const report = assembleReport(input());
    expect(report.routes.find((r) => r.cache === "cold")?.drift).toBeNull();
  });
});

describe("assembleReport — cold and warm stay apart", () => {
  it("gives each cache state its own entry and its own summary", () => {
    // AC3: "冷/熱快取分開記錄". Merged, the cold pass's first-load cost would be
    // smeared into the warm number and neither would mean anything.
    const report = assembleReport(
      input({
        measurements: [
          measurement("a", "cold", [40, 41, 42]),
          measurement("a", "warm", [8, 9, 10]),
        ],
      }),
    );
    const cold = report.routes.find((r) => r.cache === "cold");
    const warm = report.routes.find((r) => r.cache === "warm");
    expect(cold?.frameTimesMs).toEqual([40, 41, 42]);
    expect(warm?.frameTimesMs).toEqual([8, 9, 10]);
    expect(cold?.summary?.p50Ms).toBe(summariseSeries([40, 41, 42]).p50Ms);
    expect(warm?.summary?.p50Ms).toBe(summariseSeries([8, 9, 10]).p50Ms);
    // And explicitly not the merged series.
    expect(cold?.summary?.p50Ms).not.toBe(summariseSeries([40, 41, 42, 8, 9, 10]).p50Ms);
  });

  it("does not collapse two cache states of one route into one entry", () => {
    const report = assembleReport(input());
    expect(report.routes.filter((r) => r.routeId === "a")).toHaveLength(2);
  });
});

/**
 * The reference rig is a hybrid-graphics laptop. Which GPU Chrome lands on
 * varies with power state, window placement and Windows' graphics preference,
 * and the same bench differs several-fold between the two. A report that does
 * not pin the GPU is a number labelled RTX that may have come from the iGPU —
 * worse than no report, because it looks usable.
 */
describe("assembleReport — which GPU actually drew this", () => {
  it("puts the renderer string at the top level, beside the validity flag", () => {
    const report = assembleReport(input());
    const keys = Object.keys(report);
    expect(keys.slice(0, 4)).toEqual(["valid", "invalidReason", "gpuRenderer", "gpuAccepted"]);
    expect(report.gpuRenderer).toBe(RTX_4060);
  });

  it("accepts a run on the rig's discrete GPU", () => {
    const report = assembleReport(input());
    expect(report.gpuAccepted).toBe(true);
    expect(report.valid).toBe(true);
  });

  /**
   * The control. The only difference between this case and the one above is the
   * renderer string, so a green here would prove the check does nothing.
   */
  it("invalidates the whole report when the run landed on the integrated GPU", () => {
    const onIgpu = assembleReport(
      input({ environment: { ...environment(), gpuRenderer: INTEL_UHD } }),
    );
    expect(onIgpu.gpuAccepted).toBe(false);
    expect(onIgpu.valid).toBe(false);
    expect(onIgpu.invalidReason).toMatch(/GPU/i);
    expect(onIgpu.invalidReason).toMatch(/Intel/);

    // ...and the identical input on the right GPU is valid, which is what makes
    // the assertion above evidence rather than a coincidence.
    const onDgpu = assembleReport(input());
    expect(onDgpu.valid).toBe(true);
  });

  it("keeps the measurements when the GPU was wrong, but refuses to bless them", () => {
    // Same rule as an interrupted run: label, never discard. The frames were
    // really rendered — just not by the GPU the thresholds assume.
    const report = assembleReport(
      input({ environment: { ...environment(), gpuRenderer: INTEL_UHD } }),
    );
    expect(report.valid).toBe(false);
    expect(report.routes.find((r) => r.cache === "cold")?.frameTimesMs).toEqual([8, 9, 10]);
  });

  it("records the exact launch flags, because they decide which GPU was used", () => {
    // Measured on this rig: Chrome's default GPU preference lands on the Intel
    // UHD, and only an explicit high-performance flag moves it to the RTX 4060.
    // "the flag was passed" must be readable from the artefact, not assumed.
    const report = assembleReport(input());
    expect(report.environment.launchArgs).toContain("--force-high-performance-gpu");
  });

  it("records the screen and power state the run happened under", () => {
    // A laptop throttles, and battery and mains are different experiments.
    const report = assembleReport(input());
    expect(report.environment.screen.width).toBe(1920);
    expect(report.environment.screen.presentCadenceHz).toBeGreaterThan(0);
    // Headless has no monitor; the cadence must not be read as the panel's.
    expect(report.environment.headless).toBe(true);
    expect(report.environment.power.charging).toBe(true);
    expect(report.environment.chromeVersion).not.toBe("");
  });
});

describe("assembleReport — provenance", () => {
  it("carries the environment the numbers were produced on", () => {
    // I6. A frame time without the machine and the vsync state is a number
    // nobody can act on, and FTP-47 has not defined the reference rig yet, so
    // the environment block is the only thing making these numbers readable.
    const report = assembleReport(input());
    expect(report.environment.gpuRenderer).toContain("NVIDIA");
    expect(report.environment.frameRateLimitDefeated).toBe(false);
    expect(report.environment.measurementNote).not.toBe("");
  });

  it("is invalid when the environment could not be determined", () => {
    const report = assembleReport(
      input({ environment: { ...environment(), gpuRenderer: "" } }),
    );
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/environment|環境|gpu/i);
  });
});

describe("assembleReport — serialisation", () => {
  it("survives a JSON round trip unchanged", () => {
    // `undefined` disappears and NaN becomes null when JSON.stringify runs, so
    // a report can lose a field between being asserted on in memory and being
    // read back off disk. This is the only test that looks at the artefact the
    // way a later ticket will.
    const report = assembleReport(input());
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("contains no NaN anywhere", () => {
    const report = assembleReport(input());
    expect(JSON.stringify(report)).not.toContain("null,null");
    const walk = (value: unknown): void => {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(report);
  });
});
