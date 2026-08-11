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

const environment = () => ({
  cpu: "test-cpu",
  gpuRenderer: "ANGLE (NVIDIA, Test GPU, D3D11)",
  browser: "Chrome 151.0.0.0",
  os: "Windows 11",
  viewport: { width: 1920, height: 1080 },
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

  it("keeps the requested route order, so two runs diff cleanly", () => {
    const report = assembleReport(input());
    expect(report.routes.map((r) => `${r.routeId}:${r.cache}`)).toEqual(["a:cold", "a:warm"]);
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
