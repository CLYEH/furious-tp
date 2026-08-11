/**
 * Exam for route definitions and the autopilot (RFC D6: "量測路線 = 腳本化
 * autopilot(固定 spline + 固定速度,非人手駕駛)").
 *
 * AC1 is "三條路線定義檔存在且可重播;同版本重跑兩次 p95 差 <1ms". The p95 half
 * is measured on hardware; the REPLAYABLE half is a property of this module and
 * is settled here. If two runs do not visit the same camera positions, the two
 * p95 values are not measurements of the same thing and comparing them is
 * meaningless however close they land.
 *
 * Grid — invariant x failure mode x time:
 *   I1 replayability
 *     - pose depends on wall clock / call order ......... during a run
 *     - two autopilots over one route diverge ........... during a run
 *     - frame count depends on machine speed ............ at construction
 *   I5 route definition integrity
 *     - a missing or mistyped field silently defaults ... at parse time
 *     - a typo'd key is ignored rather than rejected .... at parse time
 *     - a route that is not in the M1 area .............. at parse time
 *   "fixed speed"
 *     - uneven waypoint spacing becomes uneven speed .... during a run
 *     - heading interpolation takes the long way round .. during a run
 *   permissions: N/A — parsing and arithmetic, no ambient authority.
 *   concurrency: N/A — poseAt is pure; there is no shared mutable state to race.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { isInsideM1Bbox } from "../../src/config/scene.js";
import { ROUTE_KINDS, type RouteDefinition, createAutopilot, parseRoute } from "./route.ts";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");

/** A minimal valid route, used as the base every negative case mutates one field of. */
const validRoute = (): Record<string, unknown> => ({
  id: "test-route",
  title: "測試路線",
  kind: "dense-buildings",
  description: "a route used by the exam",
  durationSeconds: 2,
  stepHz: 60,
  waypoints: [
    { longitude: 121.56, latitude: 25.03, height: 300, headingDegrees: 0, pitchDegrees: -20, rollDegrees: 0 },
    { longitude: 121.57, latitude: 25.04, height: 300, headingDegrees: 90, pitchDegrees: -20, rollDegrees: 0 },
    { longitude: 121.58, latitude: 25.03, height: 300, headingDegrees: 180, pitchDegrees: -20, rollDegrees: 0 },
  ],
});

describe("parseRoute", () => {
  it("accepts a well-formed route and returns it typed", () => {
    const route = parseRoute(validRoute());
    expect(route.id).toBe("test-route");
    expect(route.kind).toBe("dense-buildings");
    expect(route.waypoints).toHaveLength(3);
  });

  it.each([
    "id",
    "title",
    "kind",
    "description",
    "durationSeconds",
    "stepHz",
    "waypoints",
  ])("rejects a route missing %s, naming the field", (field) => {
    const broken = validRoute();
    delete broken[field];
    // The field name has to be in the message. A route file is hand-written
    // data; "invalid route" without the field name turns a five-second fix into
    // a hunt.
    expect(() => parseRoute(broken)).toThrow(new RegExp(field));
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // `stepHZ: 120` next to a correct `stepHz: 60` is the realistic typo, and
    // ignoring unknown keys makes it silent: the route runs at the wrong rate
    // and every number it produces is fine-looking and wrong.
    const typo = { ...validRoute(), stepHZ: 120 };
    expect(() => parseRoute(typo)).toThrow(/stepHZ/);
  });

  it.each([
    ["a non-object", "not-a-route"],
    ["null", null],
    ["an array", []],
  ])("rejects %s", (_label, value) => {
    expect(() => parseRoute(value)).toThrow();
  });

  it.each([
    ["id", 7],
    ["durationSeconds", "2"],
    ["stepHz", "60"],
    ["waypoints", {}],
  ])("rejects %s of the wrong type", (field, value) => {
    expect(() => parseRoute({ ...validRoute(), [field]: value })).toThrow(new RegExp(field));
  });

  it("rejects an unknown route kind", () => {
    expect(() => parseRoute({ ...validRoute(), kind: "underwater" })).toThrow(/kind/);
  });

  it("rejects fewer than two waypoints", () => {
    const one = validRoute();
    one["waypoints"] = [(validRoute()["waypoints"] as unknown[])[0]];
    expect(() => parseRoute(one)).toThrow(/waypoint/i);
  });

  it.each([
    ["durationSeconds", 0],
    ["durationSeconds", -1],
    ["stepHz", 0],
    ["stepHz", -60],
  ])("rejects %s = %s", (field, value) => {
    expect(() => parseRoute({ ...validRoute(), [field]: value })).toThrow(new RegExp(field));
  });

  it("rejects a fractional frame count", () => {
    // frameCount must be an integer or the last frame is half a step from the
    // end of the spline, which makes the route's endpoint depend on rounding.
    expect(() => parseRoute({ ...validRoute(), durationSeconds: 2.5, stepHz: 3 })).toThrow();
  });

  it.each([
    ["longitude", 181],
    ["longitude", -181],
    ["latitude", 91],
    ["latitude", -91],
  ])("rejects a waypoint with %s = %s", (field, value) => {
    const route = validRoute();
    const waypoints = route["waypoints"] as Record<string, unknown>[];
    waypoints[0] = { ...waypoints[0], [field]: value };
    expect(() => parseRoute(route)).toThrow(new RegExp(field));
  });

  it("rejects a non-finite coordinate", () => {
    const route = validRoute();
    const waypoints = route["waypoints"] as Record<string, unknown>[];
    waypoints[1] = { ...waypoints[1], height: NaN };
    expect(() => parseRoute(route)).toThrow(/height/);
  });
});

describe("createAutopilot", () => {
  it("derives the frame count from the route, not from the machine", () => {
    // duration * stepHz + 1: both endpoints of the spline are visited, so t
    // runs 0..duration inclusive. A machine that renders slowly runs the same
    // frames, just over more wall-clock seconds.
    const auto = createAutopilot(parseRoute(validRoute()));
    expect(auto.frameCount).toBe(2 * 60 + 1);
  });

  it("starts on the first waypoint and ends on the last", () => {
    const route = parseRoute(validRoute());
    const auto = createAutopilot(route);
    const first = auto.poseAt(0);
    const last = auto.poseAt(auto.frameCount - 1);
    expect(first.longitude).toBeCloseTo(route.waypoints[0]!.longitude, 9);
    expect(first.latitude).toBeCloseTo(route.waypoints[0]!.latitude, 9);
    expect(last.longitude).toBeCloseTo(route.waypoints[2]!.longitude, 9);
    expect(last.latitude).toBeCloseTo(route.waypoints[2]!.latitude, 9);
  });

  /** I1. The property AC1's "可重播" actually names. */
  it("returns the same pose every time it is asked for the same frame", () => {
    const auto = createAutopilot(parseRoute(validRoute()));
    for (const i of [0, 1, 37, 60, 119, 120]) {
      expect(auto.poseAt(i)).toEqual(auto.poseAt(i));
    }
  });

  it("produces an identical path from two separate constructions", () => {
    // This is "two runs of the same version": each run builds its own autopilot
    // from the same file. Every frame is compared, not a sample of them —
    // a divergence at one frame is a divergence in what was measured.
    const a = createAutopilot(parseRoute(validRoute()));
    const b = createAutopilot(parseRoute(validRoute()));
    expect(a.frameCount).toBe(b.frameCount);
    for (let i = 0; i < a.frameCount; i++) {
      expect(a.poseAt(i)).toEqual(b.poseAt(i));
    }
  });

  it("does not consult the clock", () => {
    // The failure mode this forbids: an autopilot that advances by elapsed wall
    // time. It looks correct on a fast machine and silently shortens the route
    // on a slow one, so the two runs AC1 compares would cover different ground.
    const auto = createAutopilot(parseRoute(validRoute()));
    const before = auto.poseAt(45);
    const realNow = Date.now;
    const realPerfNow = performance.now.bind(performance);
    try {
      Date.now = () => realNow() + 3_600_000;
      performance.now = () => realPerfNow() + 3_600_000;
      expect(auto.poseAt(45)).toEqual(before);
    } finally {
      Date.now = realNow;
      performance.now = realPerfNow;
    }
  });

  it("is not affected by the order frames are requested in", () => {
    // An autopilot that keeps an internal cursor would pass the "same frame
    // twice" case and still be order-dependent.
    const auto = createAutopilot(parseRoute(validRoute()));
    const forward = Array.from({ length: auto.frameCount }, (_, i) => auto.poseAt(i));
    const backward = createAutopilot(parseRoute(validRoute()));
    for (let i = auto.frameCount - 1; i >= 0; i--) {
      expect(backward.poseAt(i)).toEqual(forward[i]);
    }
  });

  /** "固定速度". */
  it("moves the same distance every frame despite uneven waypoint spacing", () => {
    // Waypoints deliberately bunched at the start: without arc-length
    // reparameterisation the camera crawls through the first leg and sprints
    // through the second, so p95 would depend on how the author happened to
    // space the file rather than on the scene.
    const uneven = {
      ...validRoute(),
      durationSeconds: 4,
      waypoints: [
        { longitude: 121.5600, latitude: 25.0300, height: 300, headingDegrees: 0, pitchDegrees: -20, rollDegrees: 0 },
        { longitude: 121.5605, latitude: 25.0300, height: 300, headingDegrees: 0, pitchDegrees: -20, rollDegrees: 0 },
        { longitude: 121.5900, latitude: 25.0300, height: 300, headingDegrees: 0, pitchDegrees: -20, rollDegrees: 0 },
      ],
    };
    const auto = createAutopilot(parseRoute(uneven));
    const steps: number[] = [];
    for (let i = 1; i < auto.frameCount; i++) {
      steps.push(metresBetween(auto.poseAt(i - 1), auto.poseAt(i)));
    }
    const min = Math.min(...steps);
    const max = Math.max(...steps);
    expect(min).toBeGreaterThan(0);
    // 5% is loose enough for the spline's own curvature and tight enough that
    // parameter-uniform sampling (which is off by ~50x on this route) fails.
    expect(max / min).toBeLessThan(1.05);
  });

  it("reports the speed it is flying at", () => {
    const auto = createAutopilot(parseRoute({ ...validRoute(), durationSeconds: 4 }));
    expect(auto.speedMps).toBeGreaterThan(0);
    expect(auto.speedMps).toBeCloseTo(auto.totalMetres / 4, 6);
  });

  it("interpolates heading the short way around the circle", () => {
    // 350 -> 10 is +20 degrees, not -340. The long way swings the camera
    // through south, which is a different scene and therefore a different
    // measurement.
    const wrapping = {
      ...validRoute(),
      durationSeconds: 1,
      waypoints: [
        { longitude: 121.56, latitude: 25.03, height: 300, headingDegrees: 350, pitchDegrees: -20, rollDegrees: 0 },
        { longitude: 121.57, latitude: 25.03, height: 300, headingDegrees: 10, pitchDegrees: -20, rollDegrees: 0 },
      ],
    };
    const auto = createAutopilot(parseRoute(wrapping));
    const mid = auto.poseAt(Math.floor(auto.frameCount / 2));
    // Mid-route heading should sit near 0/360, never near 180.
    const distanceFromNorth = Math.min(
      Math.abs(mid.headingDegrees % 360),
      360 - Math.abs(mid.headingDegrees % 360),
    );
    expect(distanceFromNorth).toBeLessThan(15);
  });

  it("keeps every emitted heading inside [0, 360)", () => {
    const auto = createAutopilot(parseRoute(validRoute()));
    for (let i = 0; i < auto.frameCount; i++) {
      const h = auto.poseAt(i).headingDegrees;
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it.each([-1, 1.5, NaN])("rejects the out-of-range frame index %s", (index) => {
    const auto = createAutopilot(parseRoute(validRoute()));
    expect(() => auto.poseAt(index)).toThrow();
  });

  it("rejects a frame index past the end of the route", () => {
    const auto = createAutopilot(parseRoute(validRoute()));
    expect(() => auto.poseAt(auto.frameCount)).toThrow();
  });
});

/**
 * The three shipped route files. These assertions are what AC1's "三條路線定義檔
 * 存在" means operationally — the files parse, they are the three D6 M1 types,
 * and they look at the slice this milestone is about.
 */
describe("the shipped M1 routes", () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".json")).sort();
  const load = (file: string): RouteDefinition =>
    parseRoute(JSON.parse(readFileSync(join(ROUTES_DIR, file), "utf8")));

  it("are exactly three", () => {
    expect(files).toHaveLength(3);
  });

  it("cover each of D6's three M1 route types exactly once", () => {
    // RFC D6: "M1 版縮至切片區域,至少含 ①②⑤ 三型" — dense buildings, high
    // speed straight, off-road.
    const kinds = files.map((f) => load(f).kind).sort();
    expect(kinds).toEqual([...ROUTE_KINDS].sort());
  });

  it("have unique ids", () => {
    const ids = files.map((f) => load(f).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ["dense-buildings"],
    ["high-speed-straight"],
    ["off-road"],
  ])("keep every %s waypoint inside the M1 area", (kind) => {
    // Ties the route to the place. Without this a route could fly over open
    // ocean and still produce beautiful frame times, because there would be
    // nothing to draw. `isInsideM1Bbox` is the same contract-derived check the
    // FTP-39 e2e spec uses.
    const route = files.map(load).find((r) => r.kind === kind);
    expect(route, `no shipped route of kind ${kind}`).toBeDefined();
    for (const wp of route!.waypoints) {
      expect(
        isInsideM1Bbox(wp.longitude, wp.latitude),
        `${route!.id} waypoint outside M1 bbox: ${wp.longitude}, ${wp.latitude}`,
      ).toBe(true);
    }
  });

  it("are each long enough to be a measurement rather than a glance", () => {
    // RFC D6 sizes the full-city legs at 60-90s each. M1 routes are shorter
    // than the city ones but a route below ~20s cannot produce a stable p99.
    for (const file of files) {
      const route = load(file);
      expect(route.durationSeconds, `${route.id} is too short`).toBeGreaterThanOrEqual(20);
    }
  });

  it("replay identically from the file on two separate loads", () => {
    for (const file of files) {
      const a = createAutopilot(load(file));
      const b = createAutopilot(load(file));
      expect(a.frameCount).toBe(b.frameCount);
      for (let i = 0; i < a.frameCount; i += 7) {
        expect(a.poseAt(i)).toEqual(b.poseAt(i));
      }
    }
  });
});

/** Equirectangular metres about the first point — good to well under 1% over a few km. */
function metresBetween(
  a: { longitude: number; latitude: number; height: number },
  b: { longitude: number; latitude: number; height: number },
): number {
  const metresPerDegLat = 111_132;
  const metresPerDegLon = metresPerDegLat * Math.cos((a.latitude * Math.PI) / 180);
  const dx = (b.longitude - a.longitude) * metresPerDegLon;
  const dy = (b.latitude - a.latitude) * metresPerDegLat;
  const dz = b.height - a.height;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
