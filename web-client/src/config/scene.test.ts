import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INITIAL_CAMERA, M1_BBOX_WGS84, isInsideM1Bbox } from "./scene.js";

// The M1 area is not this module's invention: contracts/ owns it (FTP-22), and
// these cases read the contract rather than restate it, so a contract change
// that this module has not followed is a red case rather than a silent drift.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function contract<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(REPO, "contracts", rel), "utf8")) as T;
}

interface EcefExamples {
  vectors: { name: string; wgs84_check: [number, number] }[];
}
interface M1Area {
  anchors: { name: string; approx_wgs84: [number, number] }[];
}

describe("M1 bbox is the contract's bbox", () => {
  // Literal, deliberately not imported from the module under test: if someone
  // edits the constant, this case must be the thing that fails.
  it("holds the WGS84 corners published by contracts/constants/ecef_examples.json", () => {
    expect(M1_BBOX_WGS84).toEqual({
      west: 121.5498908525,
      south: 25.0145340364,
      east: 121.5847170028,
      north: 25.0459993165,
    });
  });

  it("tracks the contract file, not a copy of it", () => {
    const vectors = contract<EcefExamples>("constants/ecef_examples.json").vectors;
    const sw = vectors.find((v) => v.name.includes("SW corner"));
    const ne = vectors.find((v) => v.name.includes("NE corner"));
    expect(sw, "contract no longer publishes an SW corner — this test is stale").toBeDefined();
    expect(ne, "contract no longer publishes an NE corner — this test is stale").toBeDefined();
    expect([M1_BBOX_WGS84.west, M1_BBOX_WGS84.south]).toEqual(sw?.wgs84_check);
    expect([M1_BBOX_WGS84.east, M1_BBOX_WGS84.north]).toEqual(ne?.wgs84_check);
  });

  it("contains every anchor the contract uses to justify the M1 area", () => {
    const anchors = contract<M1Area>("constants/m1_area.json").anchors;
    // Control: a scan that finds nothing would pass every assertion below.
    expect(anchors.length).toBeGreaterThanOrEqual(6);
    for (const a of anchors) {
      const [lon, lat] = a.approx_wgs84;
      expect(isInsideM1Bbox(lon, lat), `anchor outside the bbox: ${a.name}`).toBe(true);
    }
  });
});

describe("isInsideM1Bbox", () => {
  const { west, south, east, north } = M1_BBOX_WGS84;

  it("accepts a point in the middle", () => {
    expect(isInsideM1Bbox((west + east) / 2, (south + north) / 2)).toBe(true);
  });

  // Boundary: the edges belong to the box. A tile request at the western edge
  // is inside the M1 area, and the driving route reaches these edges.
  it.each([
    ["SW corner", west, south],
    ["NE corner", east, north],
    ["NW corner", west, north],
    ["SE corner", east, south],
  ])("accepts the %s exactly on the edge", (_name, lon, lat) => {
    expect(isInsideM1Bbox(lon, lat)).toBe(true);
  });

  // Boundary: one ulp-ish step out on each axis, separately, so a predicate
  // that only filters one axis cannot pass.
  it.each([
    ["west of west", west - 1e-6, (south + north) / 2],
    ["east of east", east + 1e-6, (south + north) / 2],
    ["south of south", (west + east) / 2, south - 1e-6],
    ["north of north", (west + east) / 2, north + 1e-6],
  ])("rejects a point just %s", (_name, lon, lat) => {
    expect(isInsideM1Bbox(lon, lat)).toBe(false);
  });

  it("rejects a point that is inside on one axis only", () => {
    // Same latitude band, longitude of Taichung: an AND that became an OR
    // passes every single-axis case above but not this one.
    expect(isInsideM1Bbox(120.6839, (south + north) / 2)).toBe(false);
    expect(isInsideM1Bbox((west + east) / 2, 24.1477)).toBe(false);
  });

  it.each([
    ["NaN longitude", Number.NaN, 25.03],
    ["NaN latitude", 121.56, Number.NaN],
    ["infinite longitude", Number.POSITIVE_INFINITY, 25.03],
  ])("rejects %s", (_name, lon, lat) => {
    expect(isInsideM1Bbox(lon, lat)).toBe(false);
  });
});

describe("initial camera", () => {
  it("sits on the contract's Taipei 101 anchor", () => {
    const anchors = contract<M1Area>("constants/m1_area.json").anchors;
    const t101 = anchors.find((a) => a.name === "台北101");
    expect(t101, "contract no longer names the 台北101 anchor — this test is stale").toBeDefined();
    expect([INITIAL_CAMERA.longitude, INITIAL_CAMERA.latitude]).toEqual(t101?.approx_wgs84);
  });

  it("is at the literal anchor coordinates", () => {
    expect(INITIAL_CAMERA.longitude).toBe(121.564544);
    expect(INITIAL_CAMERA.latitude).toBe(25.033944);
  });

  it("starts inside the M1 bbox", () => {
    expect(isInsideM1Bbox(INITIAL_CAMERA.longitude, INITIAL_CAMERA.latitude)).toBe(true);
  });

  // AC2 is a screenshot of buildings. A camera above the tallest structure in
  // the bbox (台北101, 508 m) pitched downwards is what makes that possible;
  // a level or upward pitch renders sky, which is the "一片藍" failure.
  it("looks down from above the tallest structure in the bbox", () => {
    expect(INITIAL_CAMERA.height).toBeGreaterThan(508);
    expect(INITIAL_CAMERA.pitchDegrees).toBeLessThan(0);
    expect(INITIAL_CAMERA.pitchDegrees).toBeGreaterThan(-90);
  });

  // Not so high that the buildings become invisible specks: the frame has to
  // show Xinyi, not Taiwan.
  it("stays close enough for buildings to fill the frame", () => {
    expect(INITIAL_CAMERA.height).toBeLessThan(3000);
  });
});
