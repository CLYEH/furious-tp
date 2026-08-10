#!/usr/bin/env node
// FTP-22 spec exam — round 3 declaration (post owner ruling on B-4 / S-3 / S-4).
// These checks encode the acceptance criteria and the finalized numeric
// decisions. Run:  node contracts/tests/check_spec.mjs
//
// Categories: happy (H*), boundary (B*), error (E*).
// permissions / concurrency: N/A — pure documentation contract (ticket
// Verification Steps mark these N/A; no runtime surface exists here).
//
// Round 3 strengthening:
//   - B-4 (blocking): a declared extreme may no longer be an isolated frozen
//     number. Every figure of the Z budget is DERIVED from recorded evidence
//     rows, and no piece of evidence in the file — including an anchor's own
//     `ele=` — may sit above the ceiling the file declares (B15/B16/B17).
//   - S-3: the corridor survey's containment claims must agree with the
//     coordinates it records (E19).
//   - S-4: the 19 mutants that survived the Layer 2 round-2 loop are pinned
//     (E11-E17): the CRS definition itself, both index formulas and the
//     interval notation, both dequantization formulas, the closed-interval
//     h_min, the fail-closed clause, the seam clauses, the local axes, the
//     geoid sign, and the README version / finalized clause bodies.
//   - frame_survey is no longer trusted prose: E18 recomputes the rigid-ENU
//     corner error, the seam gap and the meridian convergence from scratch
//     and requires the declared figures to be outward bounds of them.
//
// Round 2 strengthening (Layer 2 S-2: 15 of 30 mutants survived round 1
// because prose ACs were checked by section-heading existence only):
//   - every normative prose clause of AC2 / AC3 / AC5 is pinned verbatim;
//   - every number printed in spec/grid.md is derived from constants/ and
//     cross-checked, so doc<->constants drift cannot pass;
//   - the Z budget, the h0 rule and the per-vertex ECEF rule are executed,
//     not merely mentioned;
//   - anchors are validated by reprojecting their own EPSG:3826 values with
//     an independent implementation and comparing to their declared WGS84.
//
// Independence note: the ECEF example vectors are generated with pyproj/PROJ
// (extended Krueger tmerc). E1 recomputes them here from scratch with the
// classic Snyder/Redfearn series — two independent implementations must
// agree within the declared tolerance.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Frozen expectations (the "exam key"). Changing any spec number without
// updating these literals — or vice versa — must fail.
// ---------------------------------------------------------------------------
const X = {
  crs: "EPSG:3826",
  tileSize: 500, // m
  xyQuantMax: 65535, // q in [0, 65535] maps to [0, tileSize]
  // round 2 (B-2): 2^-6 m. The round-1 value 2^-8 gave a 255.99609375 m
  // encodable span, which the measured worst tile (508.0 m) overruns by 2x.
  zStep: 0.015625,
  zQuantMax: 65535, // encodable span above h0 = 65535 * 2^-6 = 1023.984375 m
  bbox: { e_min: 305500, e_max: 309000, n_min: 2767500, n_max: 2771000 },
  tilesX: 7,
  tilesY: 7,
  cornerTiles: {
    sw: [611, 5535],
    se: [617, 5535],
    nw: [611, 5541],
    ne: [617, 5541],
    // exact max-edge point belongs to the NEXT tile (min-incl / max-excl)
    maxEdge: [618, 5542],
  },
  geoidOffsetM: 0.0, // v0.1 convention: orthometric treated as ellipsoidal
  requiredAnchorRoles: ["dense_urban", "high_speed_straight", "off_road"],
  // EPSG:3826 plausibility domain for the Taiwan main island (sanity guard)
  domain: { e: [140000, 360000], n: [2400000, 2820000] },
};

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------
const results = [];
function check(id, name, fn) {
  try {
    fn();
    results.push({ id, name, err: null });
  } catch (err) {
    results.push({ id, name, err: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, what) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
function readText(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
function readJson(rel) {
  return JSON.parse(readText(rel));
}
// Digit-guarded citation check: "41.0 m" must NOT be satisfied by the "41.0 m"
// hiding inside "241.0 m". Plain substring matching let an understated survey
// witness survive the round-2 mutation loop (N14).
function citesNumber(md, value, unit = " m") {
  const s = String(value).replace(/\./g, "\\.");
  return new RegExp(`(?<![0-9.])${s}(\\.0)?${unit}`).test(md);
}

// Grid formulas exactly as specified in spec/grid.md
function tileOf(e, n, s) {
  return [Math.floor(e / s), Math.floor(n / s)];
}
function tileRange(tx, ty, s) {
  return { eMin: tx * s, eMax: (tx + 1) * s, nMin: ty * s, nMax: (ty + 1) * s };
}
function dequantXY(q, s, qMax) {
  return (q * s) / qMax;
}
function quantXY(x, s, qMax) {
  return Math.round((x / s) * qMax); // round half up
}
// Height framing exactly as specified in spec/grid.md
function h0Of(minH, step) {
  return Math.floor(minH / step) * step;
}
function quantZ(h, h0, step) {
  return Math.round((h - h0) / step);
}

// ---------------------------------------------------------------------------
// happy — the six AC artifacts exist with required structure
// ---------------------------------------------------------------------------
check("H1", "contracts/README.md: 定位 / 版本策略 / merge = finalized", () => {
  const md = readText("README.md");
  assert(/^## 定位/m.test(md), "missing section 「## 定位」");
  assert(/^## 版本策略/m.test(md), "missing section 「## 版本策略」");
  // both the section and the clause body — mutating either alone must fail
  assert(/^## merge = finalized/m.test(md), "missing section 「## merge = finalized」");
  assert(
    (md.match(/merge = finalized/g) || []).length >= 2,
    "the merge = finalized clause must appear as both heading and clause body",
  );
});

check("H2", "contracts/spec/grid.md: four normative sections", () => {
  const md = readText("spec/grid.md");
  for (const h of [
    /^## Tile 網格/m,
    /^## Per-tile 座標框架與量化/m,
    /^## ECEF 轉換慣例/m,
    /^## 接縫規則/m,
  ]) {
    assert(h.test(md), `missing section matching ${h}`);
  }
});

check("H3", "constants/grid.json: frozen grid parameters", () => {
  const g = readJson("constants/grid.json");
  assertEq(g.crs, X.crs, "crs");
  assertEq(g.tile_size_m, X.tileSize, "tile_size_m");
  assertEq(g.xy_quant_max, X.xyQuantMax, "xy_quant_max");
  assertEq(g.z_step_m, X.zStep, "z_step_m");
  assertEq(g.z_quant_max, X.zQuantMax, "z_quant_max");
});

check("H4", "constants/m1_area.json: frozen bbox + rationale + D6 anchors", () => {
  const m = readJson("constants/m1_area.json");
  assertEq(m.crs, X.crs, "crs");
  assertEq(m.bbox, X.bbox, "bbox");
  assertEq(m.geoid_offset_m, X.geoidOffsetM, "geoid_offset_m");
  assert(
    typeof m.rationale === "string" && m.rationale.length > 50,
    "rationale must be a substantive string",
  );
  for (const kw of ["高密度", "長直線", "off-road"]) {
    assert(m.rationale.includes(kw), `rationale must mention 「${kw}」`);
  }
  assert(Array.isArray(m.anchors) && m.anchors.length >= 3, "need >= 3 anchors");
  const roles = new Set(m.anchors.map((a) => a.role));
  for (const r of X.requiredAnchorRoles) {
    assert(roles.has(r), `missing anchor role「${r}」`);
  }
  for (const a of m.anchors) {
    assert(typeof a.name === "string" && a.name.length > 0, "anchor.name");
    assert(
      Array.isArray(a.epsg3826) &&
        a.epsg3826.length === 2 &&
        a.epsg3826.every(Number.isFinite),
      `anchor ${a.name}: epsg3826 must be finite [e, n]`,
    );
  }
});

check("H5", "constants/ecef_examples.json: >= 3 test vectors, GRS80", () => {
  const ex = readJson("constants/ecef_examples.json");
  assertEq(ex.ellipsoid, "GRS80", "ellipsoid");
  assert(Array.isArray(ex.vectors) && ex.vectors.length >= 3, "need >= 3 vectors");
  for (const v of ex.vectors) {
    assert(typeof v.name === "string", "vector.name");
    assert(
      Array.isArray(v.epsg3826) &&
        v.epsg3826.length === 3 &&
        v.epsg3826.every(Number.isFinite),
      `${v.name}: epsg3826 must be finite [E, N, h]`,
    );
    assert(
      Array.isArray(v.wgs84_check) && v.wgs84_check.length === 2,
      `${v.name}: wgs84_check [lon, lat]`,
    );
    assert(
      Array.isArray(v.ecef) && v.ecef.length === 3 && v.ecef.every(Number.isFinite),
      `${v.name}: ecef must be finite [X, Y, Z]`,
    );
    assert(
      Number.isFinite(v.tolerance_m) && v.tolerance_m > 0 && v.tolerance_m <= 0.01,
      `${v.name}: tolerance_m in (0, 0.01]`,
    );
  }
});

// ---------------------------------------------------------------------------
// boundary — grid formulas at the bbox corners and quantization extremes
// ---------------------------------------------------------------------------
check("B1", "bbox edges are tile-size multiples, non-empty", () => {
  const { bbox } = readJson("constants/m1_area.json");
  const s = readJson("constants/grid.json").tile_size_m;
  for (const [k, v] of Object.entries(bbox)) {
    assert(Number.isInteger(v / s), `${k}=${v} is not a multiple of ${s}`);
  }
  assert(bbox.e_min < bbox.e_max && bbox.n_min < bbox.n_max, "bbox must be non-empty");
});

check("B2", "four bbox corners map to the frozen tile ids", () => {
  const { bbox } = readJson("constants/m1_area.json");
  const s = readJson("constants/grid.json").tile_size_m;
  // interior-side samples 1 m inside the max edges
  assertEq(tileOf(bbox.e_min, bbox.n_min, s), X.cornerTiles.sw, "SW corner");
  assertEq(tileOf(bbox.e_max - 1, bbox.n_min, s), X.cornerTiles.se, "SE corner");
  assertEq(tileOf(bbox.e_min, bbox.n_max - 1, s), X.cornerTiles.nw, "NW corner");
  assertEq(tileOf(bbox.e_max - 1, bbox.n_max - 1, s), X.cornerTiles.ne, "NE corner");
});

check("B3", "exact max-edge point belongs to next tile (min-incl/max-excl)", () => {
  const { bbox } = readJson("constants/m1_area.json");
  const s = readJson("constants/grid.json").tile_size_m;
  assertEq(tileOf(bbox.e_max, bbox.n_max, s), X.cornerTiles.maxEdge, "max edge");
});

check("B4", "tile id <-> range round trip at corner + center tiles", () => {
  const s = readJson("constants/grid.json").tile_size_m;
  const center = [
    Math.floor((X.cornerTiles.sw[0] + X.cornerTiles.ne[0]) / 2),
    Math.floor((X.cornerTiles.sw[1] + X.cornerTiles.ne[1]) / 2),
  ];
  for (const [tx, ty] of [...Object.values(X.cornerTiles), center]) {
    const r = tileRange(tx, ty, s);
    assertEq(r.eMax - r.eMin, s, `tile ${tx},${ty} width`);
    assertEq(r.nMax - r.nMin, s, `tile ${tx},${ty} height`);
    assertEq(tileOf(r.eMin, r.nMin, s), [tx, ty], `tile ${tx},${ty} min corner`);
    assertEq(tileOf(r.eMax, r.nMax, s), [tx + 1, ty + 1], `tile ${tx},${ty} max corner`);
  }
});

check("B5", "bbox spans exactly the frozen tile counts", () => {
  const { bbox } = readJson("constants/m1_area.json");
  const s = readJson("constants/grid.json").tile_size_m;
  assertEq((bbox.e_max - bbox.e_min) / s, X.tilesX, "tiles in E");
  assertEq((bbox.n_max - bbox.n_min) / s, X.tilesY, "tiles in N");
});

check("B6", "quantization extremes are exact; z-step is a power of two", () => {
  const g = readJson("constants/grid.json");
  assert(dequantXY(0, g.tile_size_m, g.xy_quant_max) === 0, "dequant(0) !== 0");
  assert(
    dequantXY(g.xy_quant_max, g.tile_size_m, g.xy_quant_max) === g.tile_size_m,
    "dequant(q_max) !== tile_size",
  );
  assert(quantXY(0, g.tile_size_m, g.xy_quant_max) === 0, "quant(0) !== 0");
  assert(
    quantXY(g.tile_size_m, g.tile_size_m, g.xy_quant_max) === g.xy_quant_max,
    "quant(tile_size) !== q_max",
  );
  // round-half-up convention at the exact midpoint
  assert(quantXY(250, 500, 65535) === 32768, "midpoint must round half up");
  assert(g.z_step_m === 2 ** -6, "z_step_m must be exactly 2^-6");
});

check("B7", "all anchors lie inside the bbox (min-incl/max-excl)", () => {
  const m = readJson("constants/m1_area.json");
  for (const a of m.anchors) {
    const [e, n] = a.epsg3826;
    assert(
      e >= m.bbox.e_min && e < m.bbox.e_max && n >= m.bbox.n_min && n < m.bbox.n_max,
      `anchor ${a.name} (${e}, ${n}) outside bbox`,
    );
  }
});

check("B8", "SW/NE ECEF example inputs coincide with the bbox corners", () => {
  const { bbox } = readJson("constants/m1_area.json");
  const { vectors } = readJson("constants/ecef_examples.json");
  const sw = vectors.find((v) => /SW/.test(v.name));
  const ne = vectors.find((v) => /NE/.test(v.name));
  assert(sw && ne, "need vectors named with SW and NE");
  assertEq(sw.epsg3826.slice(0, 2), [bbox.e_min, bbox.n_min], "SW vector input");
  assertEq(ne.epsg3826.slice(0, 2), [bbox.e_max, bbox.n_max], "NE vector input");
});

// --- round 2 additions (Layer 2 B-1 / B-2 / S-2) ----------------------------

check("B9", "encodable Z span above h0 is q_max * step, and grid.md says so", () => {
  const g = readJson("constants/grid.json");
  const md = readText("spec/grid.md");
  const span = g.z_quant_max * g.z_step_m;
  // the off-by-one that round 1 froze: (q_max + 1) * step is the COUNT of
  // representable values, not the span.
  assert(
    !md.includes(`(${g.z_quant_max} + 1)`),
    "grid.md must not compute the span as (q_max + 1) * step",
  );
  assert(
    md.includes(`${g.z_quant_max} × 1/${1 / g.z_step_m} = ${span}`),
    `grid.md must state the encodable span as ${g.z_quant_max} × 1/${1 / g.z_step_m} = ${span}`,
  );
  assert(md.includes("q_z ∈ [0, z_quant_max]"), "grid.md must state the q_z range");
});

check("B10", "rationale km figures are derived from the frozen bbox", () => {
  const m = readJson("constants/m1_area.json");
  const kmE = (m.bbox.e_max - m.bbox.e_min) / 1000;
  const kmN = (m.bbox.n_max - m.bbox.n_min) / 1000;
  assert(m.rationale.includes(`${kmE} × ${kmN} km`), `rationale must state ${kmE} × ${kmN} km`);
});

check("B11", "Z budget covers the measured worst tile with the declared margin", () => {
  const g = readJson("constants/grid.json");
  const z = readJson("constants/m1_area.json").z_budget;
  const md = readText("spec/grid.md");
  assert(z && Number.isFinite(z.worst_tile_span_m), "m1_area.json needs a z_budget survey");
  assert(
    Number.isFinite(z.required_margin_factor) && z.required_margin_factor >= 1.5,
    "required_margin_factor must be >= 1.5",
  );
  const span = g.z_quant_max * g.z_step_m;
  assert(
    span >= z.worst_tile_span_m * z.required_margin_factor,
    `encodable span ${span} m < measured worst tile span ${z.worst_tile_span_m} m ` +
      `x margin ${z.required_margin_factor}`,
  );
  // the terrain-only figure must also fit, and must be a real measurement
  assert(
    z.terrain_worst_relief_m > 0 && span >= z.terrain_worst_relief_m,
    "encodable span must cover the measured terrain relief",
  );
  // the survey must be internally consistent: the worst tile is a tile of
  // THIS bbox, and the overall worst span cannot be under the terrain-only one
  assert(
    z.bbox_min_h_m <= z.worst_tile_min_h_m && z.worst_tile_min_h_m <= z.bbox_max_h_m,
    `worst_tile_min_h_m ${z.worst_tile_min_h_m} outside the surveyed bbox range ` +
      `[${z.bbox_min_h_m}, ${z.bbox_max_h_m}]`,
  );
  assert(
    z.worst_tile_span_m >= z.terrain_worst_relief_m,
    "the overall worst span cannot be smaller than the terrain-only worst relief",
  );
  assert(
    z.bbox_max_h_m - z.bbox_min_h_m >= z.terrain_worst_relief_m,
    "bbox relief cannot be smaller than a single tile's relief",
  );
  // grid.md must print the measured witnesses, not a hand-wave
  for (const lit of [z.worst_tile_span_m, z.terrain_worst_relief_m]) {
    assert(citesNumber(md, lit), `grid.md must cite the measured witness ${lit} m`);
  }
  assert(
    !/遠低於/.test(md),
    "grid.md must not claim the terrain is 'far below' the budget (round-1 false claim)",
  );
});

check("B12", "h0 selection rule is executable and keeps q_z in range", () => {
  const g = readJson("constants/grid.json");
  const z = readJson("constants/m1_area.json").z_budget;
  const md = readText("spec/grid.md");
  assert(
    md.includes("h0 = floor(h_min / z_step_m) × z_step_m"),
    "grid.md must state the h0 selection rule",
  );
  // the compliance condition must stay expressed in the contract's own
  // parameters — a hard-coded bound silently decouples it from grid.json
  assert(
    md.includes("h_max - h0 <= z_quant_max × z_step_m"),
    "grid.md must state the per-tile compliance condition in terms of the constants",
  );
  // execute the rule on the measured worst tile and on adversarial inputs
  const cases = [
    [z.worst_tile_min_h_m, z.worst_tile_min_h_m + z.worst_tile_span_m],
    // the surveyed bbox extremes, derived — a literal here would decouple the
    // adversarial case from the measurements it claims to represent
    [z.bbox_min_h_m, z.bbox_max_h_m],
    [0, 0], // degenerate: flat tile
    [3.0, 3.0 + g.z_quant_max * g.z_step_m], // exactly at the budget
    [-7.0, -7.0 + g.z_quant_max * g.z_step_m], // budget-filling, negative base
  ];
  for (const [minH, maxH] of cases) {
    const h0 = h0Of(minH, g.z_step_m);
    assert(h0 <= minH, `h0 ${h0} must not exceed the tile minimum ${minH}`);
    assert(
      Number.isInteger(h0 / g.z_step_m),
      `h0 ${h0} must be an integer multiple of z_step_m`,
    );
    const qLo = quantZ(minH, h0, g.z_step_m);
    const qHi = quantZ(maxH, h0, g.z_step_m);
    assert(qLo >= 0, `q_z ${qLo} below 0 for min height ${minH}`);
    assert(
      qHi <= g.z_quant_max,
      `q_z ${qHi} exceeds z_quant_max for span ${maxH - minH} m (h0 ${h0})`,
    );
  }
  // negative case: a tile one step over budget must be detected as
  // non-compliant, otherwise the condition is decorative
  const overMin = 10.0;
  const overMax = overMin + g.z_quant_max * g.z_step_m + g.z_step_m;
  const overH0 = h0Of(overMin, g.z_step_m);
  assert(
    overMax - overH0 > g.z_quant_max * g.z_step_m &&
      quantZ(overMax, overH0, g.z_step_m) > g.z_quant_max,
    "an over-budget tile must violate the compliance condition",
  );
});

check("B13", "boundary heights are exactly representable on both sides of a seam", () => {
  const g = readJson("constants/grid.json");
  // two neighbours with different terrain, hence different h0
  const h0a = h0Of(3.4, g.z_step_m);
  const h0b = h0Of(87.9, g.z_step_m);
  assert(h0a !== h0b, "test needs two distinct h0 values");
  const md = readText("spec/grid.md");
  assert(
    md.includes("必須是 `z_step_m` 的整數倍"),
    "grid.md must require h0 to be a multiple of z_step_m",
  );
  // a shared-edge height snapped to the global step must be an exact integer
  // q_z on both sides — this is what makes the seam rule implementable.
  for (const k of [0, 1, 12345, 40000]) {
    const h = h0b + k * g.z_step_m; // snapped boundary height
    for (const h0 of [h0a, h0b]) {
      const q = (h - h0) / g.z_step_m;
      assert(Number.isInteger(q), `boundary height ${h} not an integer q_z from h0 ${h0}`);
    }
  }
});

check("B14", "M1 budget table rows agree with constants (tile, span, share)", () => {
  const g = readJson("constants/grid.json");
  const z = readJson("constants/m1_area.json").z_budget;
  const span = g.z_quant_max * g.z_step_m;
  const lines = readText("spec/grid.md").split("\n");
  // B-1 was a derived figure contradicting a frozen value; the same class of
  // defect in this table must not be possible either.
  for (const [tile, value] of [
    [z.terrain_worst_tile, z.terrain_worst_relief_m],
    [z.worst_tile, z.worst_tile_span_m],
  ]) {
    const id = `(${tile[0]}, ${tile[1]})`;
    const row = lines.find((l) => l.trim().startsWith("|") && l.includes(id));
    assert(row, `budget table has no row for tile ${id}`);
    assert(citesNumber(row, value), `budget row for ${id} must cite ${value} m`);
    const pct = ((value / span) * 100).toFixed(1);
    assert(row.includes(`${pct}%`), `budget row for ${id} must state ${pct}% of the span`);
  }
});

// --- round 3 additions (Layer 2 B-4: frozen figures must be derived) --------

// Every terrain figure in the budget must be reducible to a recorded sample
// run. B-4 was possible because `bbox_max_h_m` was an isolated literal: no
// other field could contradict it, so a coarse-grid extreme could pose as the
// bbox ceiling while the file's own anchor named a higher point.
check("B15", "every Z-budget terrain figure is derived from recorded evidence", () => {
  const z = readJson("constants/m1_area.json").z_budget;
  const rows = z.terrain_evidence;
  assert(Array.isArray(rows) && rows.length >= 3, "z_budget needs a terrain_evidence log");
  for (const r of rows) {
    assert(typeof r.source === "string" && r.source.length > 0, "evidence row needs a source");
    assert(
      Number.isFinite(r.grid_step_m) && r.grid_step_m > 0,
      `${r.source}: every sample run must state its grid step`,
    );
    assert(
      Number.isInteger(r.samples) && r.samples > 0,
      `${r.source}: every sample run must state how many points it took`,
    );
    assert(
      Number.isFinite(r.min_h_m) && Number.isFinite(r.max_h_m) && r.max_h_m >= r.min_h_m,
      `${r.source}: min/max must be finite and ordered`,
    );
  }
  const row = (source, tile) =>
    rows.find(
      (r) =>
        r.source === source &&
        (tile
          ? Array.isArray(r.tile) && r.tile[0] === tile[0] && r.tile[1] === tile[1]
          : r.extent === "bbox"),
    );
  // the primary source's densest run on the worst terrain tile defines it
  const tw = row(z.terrain_source, z.terrain_worst_tile);
  assert(tw, `no ${z.terrain_source} evidence row for terrain_worst_tile`);
  assertEq(z.terrain_worst_tile_min_h_m, tw.min_h_m, "terrain_worst_tile_min_h_m");
  assertEq(z.terrain_worst_tile_max_h_m, tw.max_h_m, "terrain_worst_tile_max_h_m");
  assertEq(
    z.terrain_worst_relief_m,
    Number((tw.max_h_m - tw.min_h_m).toFixed(6)),
    "terrain_worst_relief_m must equal the recorded tile max - min",
  );
  // the cross-check figure must come from a genuinely different source
  const cross = rows.find(
    (r) =>
      r.source !== z.terrain_source &&
      Array.isArray(r.tile) &&
      r.tile[0] === z.terrain_worst_tile[0] &&
      r.tile[1] === z.terrain_worst_tile[1],
  );
  assert(cross, "the relief cross-check must name a second source for the same tile");
  assertEq(
    z.terrain_worst_relief_crosscheck_m,
    Number((cross.max_h_m - cross.min_h_m).toFixed(6)),
    "terrain_worst_relief_crosscheck_m must equal the second source's max - min",
  );
  // ...and the declared worst tile must actually be the worst one on record
  for (const r of rows) {
    if (r.source !== z.terrain_source || !Array.isArray(r.tile)) continue;
    assert(
      r.max_h_m - r.min_h_m <= z.terrain_worst_relief_m + 1e-9,
      `tile ${r.tile} has relief ${r.max_h_m - r.min_h_m} m, above the declared worst`,
    );
  }
  // the ground floor of the overall worst tile is evidence too, not a guess
  const wt = row(z.terrain_source, z.worst_tile);
  assert(wt, `no ${z.terrain_source} evidence row for worst_tile`);
  assertEq(z.worst_tile_min_h_m, wt.min_h_m, "worst_tile_min_h_m");
});

check("B16", "the declared bbox extremes are the envelope of all evidence", () => {
  const m = readJson("constants/m1_area.json");
  const z = m.z_budget;
  const eles = m.anchors
    .map((a) => /\bele=([0-9]+(?:\.[0-9]+)?)/.exec(a.note || ""))
    .filter(Boolean)
    .map((hit) => Number(hit[1]));
  // reviewer fixture A: no anchor may name a point above the declared ceiling
  for (const [i, e] of eles.entries()) {
    assert(
      e <= z.bbox_max_h_m,
      `an anchor declares ele=${e} m, above bbox_max_h_m ${z.bbox_max_h_m} m (anchor #${i})`,
    );
  }
  const maxes = z.terrain_evidence.map((r) => r.max_h_m).concat(eles);
  const mins = z.terrain_evidence.map((r) => r.min_h_m);
  assertEq(z.bbox_max_h_m, Math.max(...maxes), "bbox_max_h_m must be the max of all evidence");
  assertEq(z.bbox_min_h_m, Math.min(...mins), "bbox_min_h_m must be the min of all evidence");
  // a sampled extreme is a bound, not a truth — the file has to say so
  assert(
    typeof z.extremes_semantics === "string" && /下界|包絡/.test(z.extremes_semantics),
    "z_budget must state that sampled extremes are bounds, not exact ceilings",
  );
});

check("B17", "the worst tile's span is backed by a named structure record", () => {
  const z = readJson("constants/m1_area.json").z_budget;
  const s = z.tallest_structure;
  assert(s && Number.isFinite(s.height_m), "z_budget needs a tallest_structure record");
  assert(/\bway\/[0-9]+/.test(s.source), "the structure must cite its OSM object id");
  assertEq(s.tile, z.worst_tile, "the tallest structure must sit in the declared worst tile");
  assert(
    Number.isFinite(s.second_tallest_m) && s.second_tallest_m < s.height_m,
    "the runner-up must be recorded and lower — otherwise 'tallest' is unchecked",
  );
  // span = structure height above the tile floor; the floor is the tile min,
  // so the span can never be below the structure's own height
  assert(
    z.worst_tile_span_m >= s.height_m,
    `worst_tile_span_m ${z.worst_tile_span_m} is below the tallest structure ${s.height_m} m`,
  );
});

// ---------------------------------------------------------------------------
// error — independent recomputation; domain guards; doc/number drift
// ---------------------------------------------------------------------------

// From-scratch inverse transverse Mercator (Snyder 1987, GRS80) + geodetic->ECEF.
// Deliberately NOT the PROJ algorithm that generated the vectors.
function epsg3826ToGeodetic(E, N) {
  const a = 6378137.0;
  const f = 1 / 298.257222101; // GRS80
  const k0 = 0.9999;
  const E0 = 250000.0;
  const lam0 = (121 * Math.PI) / 180;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const e4 = e2 * e2;
  const e6 = e4 * e2;

  // footpoint latitude from meridian distance
  const M = N / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const C1 = ep2 * cos1 * cos1;
  const T1 = tan1 * tan1;
  const N1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const R1 = (a * (1 - e2)) / (1 - e2 * sin1 * sin1) ** 1.5;
  const D = (E - E0) / (N1 * k0);

  const phi =
    phi1 -
    ((N1 * tan1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) /
          720);
  const lam =
    lam0 +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
      cos1;
  return { phi, lam, lonDeg: (lam * 180) / Math.PI, latDeg: (phi * 180) / Math.PI };
}

function epsg3826ToEcef(E, N, h) {
  const a = 6378137.0;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const { phi, lam, lonDeg, latDeg } = epsg3826ToGeodetic(E, N);
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const Nn = a / Math.sqrt(1 - e2 * sinP * sinP);
  return {
    lonDeg,
    latDeg,
    x: (Nn + h) * cosP * Math.cos(lam),
    y: (Nn + h) * cosP * Math.sin(lam),
    z: (Nn * (1 - e2) + h) * sinP,
  };
}

check("E1", "ECEF vectors survive independent from-scratch recomputation", () => {
  const { vectors } = readJson("constants/ecef_examples.json");
  for (const v of vectors) {
    const [E, N, h] = v.epsg3826;
    const r = epsg3826ToEcef(E, N, h);
    assert(
      Math.abs(r.lonDeg - v.wgs84_check[0]) < 1e-8 &&
        Math.abs(r.latDeg - v.wgs84_check[1]) < 1e-8,
      `${v.name}: wgs84_check drift (got ${r.lonDeg}, ${r.latDeg})`,
    );
    for (const [axis, got, decl] of [
      ["X", r.x, v.ecef[0]],
      ["Y", r.y, v.ecef[1]],
      ["Z", r.z, v.ecef[2]],
    ]) {
      assert(
        Math.abs(got - decl) <= v.tolerance_m,
        `${v.name}: ${axis} off by ${Math.abs(got - decl).toFixed(6)} m ` +
          `(> ${v.tolerance_m} m); recomputed ${got.toFixed(4)} vs declared ${decl}`,
      );
    }
  }
});

check("E2", "bbox lies inside the EPSG:3826 plausibility domain", () => {
  const { bbox } = readJson("constants/m1_area.json");
  assert(
    bbox.e_min >= X.domain.e[0] &&
      bbox.e_max <= X.domain.e[1] &&
      bbox.n_min >= X.domain.n[0] &&
      bbox.n_max <= X.domain.n[1],
    "bbox outside Taiwan EPSG:3826 domain — projection or units error",
  );
});

check("E3", "spec/grid.md normative literals match constants/grid.json", () => {
  const md = readText("spec/grid.md");
  const g = readJson("constants/grid.json");
  assert(
    new RegExp(`tile_size_m *= *${g.tile_size_m}\\b`).test(md),
    "grid.md does not state tile_size_m literal",
  );
  assert(
    new RegExp(`xy_quant_max *= *${g.xy_quant_max}\\b`).test(md),
    "grid.md does not state xy_quant_max literal",
  );
  assert(
    md.includes(`z_step_m = 1/${1 / g.z_step_m}`),
    `grid.md does not state z_step_m = 1/${1 / g.z_step_m}`,
  );
  assert(
    new RegExp(`z_quant_max\` *= *\`?${g.z_quant_max}\\b`).test(md),
    "grid.md does not state z_quant_max literal",
  );
  // XY resolution printed in the doc must equal the computed one
  const res = ((g.tile_size_m / g.xy_quant_max) * 1000).toFixed(2);
  assert(md.includes(res), `grid.md must print the XY resolution ${res} mm`);
});

// --- round 2 additions: kill the doc/constants drift mutants -----------------

check("E4", "spec/grid.md restates bbox + corner tile ids derived from constants", () => {
  const md = readText("spec/grid.md");
  const { bbox } = readJson("constants/m1_area.json");
  const s = readJson("constants/grid.json").tile_size_m;
  assert(
    md.includes(`E [${bbox.e_min}, ${bbox.e_max}] × N [${bbox.n_min}, ${bbox.n_max}]`),
    "bbox literal drift between grid.md and m1_area.json",
  );
  const [sx, sy] = tileOf(bbox.e_min, bbox.n_min, s);
  const [nx, ny] = tileOf(bbox.e_max - 1, bbox.n_max - 1, s);
  assert(
    md.includes(`SW (${sx}, ${sy})`) && md.includes(`NE (${nx}, ${ny})`),
    "corner tile id drift",
  );
  // the teaching example for max-exclusive attribution must be the real answer
  const [mx, my] = tileOf(bbox.e_max, bbox.n_max, s);
  assert(
    md.includes(`(${bbox.e_max}, ${bbox.n_max}) 屬於 tile (${mx}, ${my})`),
    "max-edge example does not match the formula",
  );
  const tiles = ((bbox.e_max - bbox.e_min) / s) * ((bbox.n_max - bbox.n_min) / s);
  assert(md.includes(`= ${tiles} tiles`), `grid.md must state = ${tiles} tiles`);
});

check("E5", "spec/grid.md ECEF table matches constants/ecef_examples.json", () => {
  const md = readText("spec/grid.md");
  for (const v of readJson("constants/ecef_examples.json").vectors) {
    for (const c of v.ecef) assert(md.includes(c.toFixed(4)), `ECEF table drift: ${c}`);
    for (const c of v.epsg3826) assert(md.includes(String(c)), `ECEF input drift: ${c}`);
    // the comparison tolerance the doc advertises must be the one shipped
    assert(
      md.includes(`tolerance_m = ${v.tolerance_m}`),
      `grid.md advertises a different tolerance than ${v.name} (${v.tolerance_m})`,
    );
  }
});

check("E6", "normative prose clauses are pinned (AC2 / AC3 / AC5)", () => {
  const md = readText("spec/grid.md");
  assert(/min 邊\*\*含\*\*、max 邊\*\*不含\*\*/.test(md), "boundary attribution clause altered");
  assert(/\*\*local origin\*\*:tile 的 min 角落/.test(md), "local origin rule altered");
  assert(/位元級,無容差/.test(md), "seam bit-exactness clause weakened");
  assert(!/容差 *[0-9]/.test(md.split("## 接縫規則")[1] ?? ""), "seam clause gained a tolerance");
  assert(/round half up/.test(md), "XY rounding convention altered");
  // B6 executes round-half-up; the doc must not contradict it anywhere
  assert(!/round half (down|even)/.test(md), "a contradictory rounding convention appears");
});

check("E7", "seam guarantee is stated in ECEF and applied per vertex (B-3)", () => {
  const md = readText("spec/grid.md");
  const fs = readJson("constants/m1_area.json").frame_survey;
  assert(md.includes("**逐頂點**(per-vertex)"), "missing the per-vertex normative clause");
  assert(
    md.includes("不得以 per-tile 剛體變換代替"),
    "missing the prohibition on per-tile rigid placement",
  );
  const seam = md.split("## 接縫規則")[1] ?? "";
  assert(/ECEF/.test(seam), "seam section must state the guarantee in ECEF terms");
  // ...and must name ECEF as the guaranteed SPACE, not merely mention it
  assert(
    seam.includes("**本節保證的空間是 ECEF**"),
    "seam section must declare ECEF as the guaranteed space",
  );
  assert(fs && Number.isFinite(fs.rigid_enu_seam_gap_m), "m1_area.json needs a frame_survey");
  assert(
    fs.rigid_enu_seam_gap_m > 0.5,
    "frame_survey must record the measured gap that motivates the clause",
  );
  assert(
    citesNumber(md, fs.rigid_enu_seam_gap_m),
    `grid.md must cite the measured seam gap ${fs.rigid_enu_seam_gap_m} m`,
  );
  assert(
    citesNumber(md, fs.meridian_convergence_deg_max, " 度"),
    `grid.md must cite the measured convergence ${fs.meridian_convergence_deg_max} 度`,
  );
});

check("E8", "anchor EPSG:3826 and WGS84 agree under an independent projection", () => {
  const m = readJson("constants/m1_area.json");
  const tol = m.anchor_tolerance_m;
  // anchors are measured, not eyeballed: the two representations of one point
  // must agree tightly. Round 1's self-declared +/-100 m was the S-1 hole.
  assert(Number.isFinite(tol) && tol > 0 && tol <= 5, "anchor_tolerance_m in (0, 5]");
  for (const a of m.anchors) {
    assert(
      Array.isArray(a.approx_wgs84) && a.approx_wgs84.length === 2,
      `anchor ${a.name}: approx_wgs84 [lon, lat]`,
    );
    const [e, n] = a.epsg3826;
    const { lonDeg, latDeg } = epsg3826ToGeodetic(e, n);
    // metric error: 1 deg lat ~ 110574 m, 1 deg lon ~ 111320*cos(lat)
    const dN = (latDeg - a.approx_wgs84[1]) * 110574;
    const dE = (lonDeg - a.approx_wgs84[0]) * 111320 * Math.cos((latDeg * Math.PI) / 180);
    const d = Math.hypot(dE, dN);
    assert(
      d <= tol,
      `anchor ${a.name}: epsg3826 and approx_wgs84 disagree by ${d.toFixed(1)} m (> ${tol} m)`,
    );
  }
});

check("E9", "corridor witness numbers match the anchor geometry", () => {
  const m = readJson("constants/m1_area.json");
  const c = m.corridor_survey;
  assert(c && Number.isFinite(c.straight_run_m), "m1_area.json needs a corridor_survey");
  const ends = m.anchors.filter((a) => a.role === "high_speed_straight");
  assertEq(ends.length, 2, "need exactly two corridor anchors");
  const d = Math.hypot(
    ends[0].epsg3826[0] - ends[1].epsg3826[0],
    ends[0].epsg3826[1] - ends[1].epsg3826[1],
  );
  assert(
    Math.abs(d - c.straight_run_m) <= 2,
    `corridor anchors are ${d.toFixed(1)} m apart but straight_run_m says ${c.straight_run_m}`,
  );
  assert(
    m.rationale.includes(c.road) && m.rationale.includes(`${c.straight_run_m}`),
    `rationale must name ${c.road} and cite ${c.straight_run_m} m`,
  );
  // round 1 claimed a section that contradicted the named intersection
  assert(!m.rationale.includes("四—五段"), "round-1 contradictory section label still present");
});

check("E10", "geoid_offset_m is declared a pending measurement, not an estimate", () => {
  const md = readText("spec/grid.md");
  const m = readJson("constants/m1_area.json");
  assertEq(m.geoid_offset_m, X.geoidOffsetM, "geoid_offset_m");
  assert(md.includes("**待辦實測項**"), "grid.md must mark the geoid offset as pending QA measurement");
  assert(
    !/[十百]?[0-9十]+ *公尺|約十餘公尺/.test(md.split("高程慣例")[1]?.split("\n")[0] ?? ""),
    "the geoid offset must not carry an unverified magnitude estimate",
  );
  assert(
    md.includes("不得將 `geoid_offset_m` 視為已知量"),
    "grid.md must forbid treating the unmeasured offset as known",
  );
});

// --- round 3 additions: pin the 19 clauses that survived the round-2 loop ----
// Every assertion below quotes a clause an AC explicitly requires. The shipped
// text is correct today; these exist so it cannot drift silently tomorrow.

check("E11", "the CRS definition itself is pinned (Z01-Z04)", () => {
  const md = readText("spec/grid.md");
  // the exam's own from-scratch projection uses these four parameters; if the
  // doc and the implementation disagree, one of them is wrong by definition
  for (const [lit, what] of [
    ["中央經線 121°E", "central meridian"],
    ["k0 = 0.9999", "scale factor"],
    ["假東距 250 000 m", "false easting"],
    ["假北距 0 m", "false northing"],
    ["a = 6378137", "GRS80 semi-major axis"],
    ["1/f = 298.257222101", "GRS80 inverse flattening"],
  ]) {
    assert(md.includes(lit), `grid.md must state the ${what} as 「${lit}」`);
  }
  assert(md.includes("EPSG:3826(TWD97 / TM2 zone 121)"), "the CRS must be named in full");
});

check("E12", "AC2 index formulas and interval notation are pinned (S10b/S10c)", () => {
  const md = readText("spec/grid.md");
  assert(md.includes("tx = floor(E / tile_size_m)"), "the E index formula is not pinned");
  assert(md.includes("ty = floor(N / tile_size_m)"), "the N index formula is not pinned");
  assert(!/\b(ceil|round)\((?:E|N) \/ tile_size_m\)/.test(md), "index formula must use floor");
  // min-inclusive / max-exclusive stated as prose AND as interval notation
  assert(
    md.includes("E ∈ [tx · tile_size_m, (tx + 1) · tile_size_m)"),
    "the E range must be written half-open, min-inclusive",
  );
  assert(
    md.includes("N ∈ [ty · tile_size_m, (ty + 1) · tile_size_m)"),
    "the N range must be written half-open, min-inclusive",
  );
  assert(
    !/∈ \((?:tx|ty) ·/.test(md),
    "an open-lower interval contradicts the min-inclusive boundary rule",
  );
});

check("E13", "AC3 quantization formulas, ranges, axes and rounding are pinned", () => {
  const md = readText("spec/grid.md");
  const g = readJson("constants/grid.json");
  // dequantization: the divisor is q_max, not q_max + 1 (Z05)
  assert(
    md.includes("x = q · tile_size_m / xy_quant_max"),
    "the XY dequantization formula is not pinned",
  );
  assert(
    md.includes("q = round(x / tile_size_m · xy_quant_max)"),
    "the XY quantization formula is not pinned",
  );
  assert(
    !/xy_quant_max \+ 1|\(xy_quant_max ?\+ ?1\)/.test(md),
    "XY dequantization must not divide by xy_quant_max + 1",
  );
  // Z dequantization: no half-step offset (Z06)
  assert(md.includes("h = h0 + q_z · z_step_m"), "the Z dequantization formula is not pinned");
  assert(md.includes("q_z = round((h - h0) / z_step_m)"), "the Z quantization formula is not pinned");
  assert(!/q_z \+ 0\.5|\(q_z ?\+ ?0\.5\)/.test(md), "Z dequantization must not offset by half a step");
  // the quantized range and what it maps onto (Z12/Z15)
  assert(
    md.includes(`量化值 q ∈ [0, ${g.xy_quant_max}] 對應 local 座標 [0, tile_size_m]`),
    "the XY quantized range and its image are not pinned",
  );
  assert(
    md.includes(`\`xy_quant_max = ${g.xy_quant_max}\`(16-bit)`),
    "xy_quant_max must be stated as a 16-bit value",
  );
  assert(
    md.includes(`\`z_quant_max\` = ${g.z_quant_max}(16-bit)`),
    "z_quant_max must be stated as a 16-bit value",
  );
  // h_min is taken over the CLOSED tile, boundaries included (Z07)
  assert(
    md.includes("**閉區間**(含四條邊界)"),
    "h_min must be taken over the closed tile — an open interval lets a boundary vertex go below h0",
  );
  // local axes (Z10)
  assert(/local X = E [−-] E0\(向東\)/.test(md), "the local X axis is not pinned to east");
  assert(/local Y = N [−-] N0\(向北\)/.test(md), "the local Y axis is not pinned to north");
  assert(/local Z = h [−-] h0\(向上\)/.test(md), "the local Z axis is not pinned to up");
  // rounding convention (S13b): only one convention may appear anywhere
  assert(/round half up/.test(md), "the rounding convention is not stated");
  assert(
    !/round (half (down|even)|toward zero|toward -?infinity)|無條件(捨去|進位)/.test(md),
    "a second, contradictory rounding convention appears",
  );
});

check("E14", "the over-budget tile clause stays fail-closed (Z08)", () => {
  const md = readText("spec/grid.md");
  assert(
    md.includes("pipeline 必須失敗並回報,不得截斷或改用 per-tile 縮放"),
    "the fail-closed clause for over-budget tiles was weakened or removed",
  );
  assert(
    /超出者為\*\*不合規 tile\*\*/.test(md),
    "an over-budget tile must be labelled non-compliant, not merely discouraged",
  );
  assert(
    !/(應|建議)(盡量)?(避免|減少)截斷/.test(md),
    "a 'should avoid truncating' reading must not exist alongside the must-fail rule",
  );
});

check("E15", "the geoid offset is applied with the declared sign (Z11)", () => {
  const md = readText("spec/grid.md");
  assert(md.includes("h_ellip = h + geoid_offset_m"), "the geoid offset sign convention is not pinned");
  assert(!/h_ellip = h - geoid_offset_m/.test(md), "the geoid offset must be added, not subtracted");
  assert(
    md.includes("(= 正高 + `geoid_offset_m`"),
    "the ECEF table must restate the same sign for its h column",
  );
});

check("E16", "the seam clauses keep their normative force (Z09/Z16)", () => {
  const md = readText("spec/grid.md");
  const seam = md.split("## 接縫規則")[1] ?? "";
  assert(
    seam.includes("邊界頂點在相鄰兩 tile 中各自出現"),
    "the boundary vertex must be duplicated into BOTH tiles",
  );
  assert(
    !/只(在|由)索引較(小|大)的 tile/.test(seam),
    "assigning a boundary vertex to one side only breaks the duplication rule",
  );
  assert(
    seam.includes("**必須為 `z_step_m` 的整數倍**"),
    "clause 3 must require (not recommend) boundary heights on the global step",
  );
  assert(
    !/(建議|宜|應盡量)為 `z_step_m` 的整數倍/.test(seam),
    "clause 3 was softened from a requirement to a recommendation",
  );
  // the snap must name its rounding direction, or two pipelines can disagree
  assert(/snap 採 round half up/.test(seam), "clause 3 must state the snap rounding direction");
});

check("E17", "README version policy and finalized clause bodies are pinned (Z13/Z14)", () => {
  const md = readText("README.md");
  assert(
    md.includes("pre-1.0:**minor** 版本遞增可變更數值或語意"),
    "the pre-1.0 policy must keep value/semantic changes at minor, not patch",
  );
  assert(
    md.includes("**patch** 僅限訂正文字、不改變任何數值與語意"),
    "the patch policy body is not pinned",
  );
  assert(
    md.includes("合併後不得原地修改既有版本的數值或語意"),
    "the merge = finalized clause body was inverted or removed",
  );
  assert(
    !/合併後(可|得)原地修改/.test(md),
    "a clause permitting in-place edits contradicts merge = finalized",
  );
});

// From-scratch ENU placement, so the frame_survey figures are checkable
// offline instead of being trusted prose.
function enuBasis(lonDeg, latDeg) {
  const lo = (lonDeg * Math.PI) / 180;
  const la = (latDeg * Math.PI) / 180;
  return {
    east: [-Math.sin(lo), Math.cos(lo), 0],
    north: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
  };
}
function perVertex(E, N) {
  const r = epsg3826ToEcef(E, N, 0);
  return [r.x, r.y, r.z];
}
function rigidEnu(tx, ty, x, y, s) {
  const o = epsg3826ToEcef(tx * s, ty * s, 0);
  const b = enuBasis(o.lonDeg, o.latDeg);
  return [
    o.x + x * b.east[0] + y * b.north[0],
    o.y + x * b.east[1] + y * b.north[1],
    o.z + x * b.east[2] + y * b.north[2],
  ];
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

check("E18", "frame_survey figures are outward bounds of an independent recomputation", () => {
  const m = readJson("constants/m1_area.json");
  const s = readJson("constants/grid.json").tile_size_m;
  const fs = m.frame_survey;
  const txs = [];
  for (let tx = m.bbox.e_min / s; tx < m.bbox.e_max / s; tx += 1) txs.push(tx);
  const tys = [];
  for (let ty = m.bbox.n_min / s; ty < m.bbox.n_max / s; ty += 1) tys.push(ty);

  // 1) meridian convergence over the bbox
  let cMin = Infinity;
  let cMax = -Infinity;
  for (let i = 0; i <= 14; i += 1) {
    for (let j = 0; j <= 14; j += 1) {
      const E = m.bbox.e_min + ((m.bbox.e_max - m.bbox.e_min) * i) / 14;
      const N = m.bbox.n_min + ((m.bbox.n_max - m.bbox.n_min) * j) / 14;
      const { lonDeg, latDeg } = epsg3826ToGeodetic(E, N);
      const gamma =
        (Math.atan(
          Math.tan(((lonDeg - 121) * Math.PI) / 180) * Math.sin((latDeg * Math.PI) / 180),
        ) *
          180) /
        Math.PI;
      cMin = Math.min(cMin, gamma);
      cMax = Math.max(cMax, gamma);
    }
  }
  assert(
    fs.meridian_convergence_deg_min <= cMin && fs.meridian_convergence_deg_max >= cMax,
    `declared convergence [${fs.meridian_convergence_deg_min}, ${fs.meridian_convergence_deg_max}] ` +
      `does not bound the recomputed [${cMin.toFixed(6)}, ${cMax.toFixed(6)}]`,
  );
  assert(
    cMax - cMin > 0 && fs.meridian_convergence_deg_max <= cMax * 1.01,
    "the declared convergence bound is inflated far beyond the measurement",
  );

  // 2) rigid-ENU corner error: worst tile corner over the whole bbox
  let corner = 0;
  let cornerTile = null;
  for (const tx of txs) {
    for (const ty of tys) {
      for (const [x, y] of [
        [0, 0],
        [s, 0],
        [0, s],
        [s, s],
      ]) {
        const d = dist3(rigidEnu(tx, ty, x, y, s), perVertex(tx * s + x, ty * s + y));
        if (d > corner) {
          corner = d;
          cornerTile = [tx, ty];
        }
      }
    }
  }
  assert(
    fs.rigid_enu_corner_error_m >= corner && fs.rigid_enu_corner_error_m <= corner * 1.01,
    `declared corner error ${fs.rigid_enu_corner_error_m} m is not a tight outward bound of ` +
      `the recomputed ${corner.toFixed(4)} m`,
  );
  assertEq(fs.rigid_enu_corner_error_worst_tile, cornerTile, "corner-error worst tile");

  // 3) seam gap: the same shared-edge point placed by each neighbour
  let gap = 0;
  let gapPair = null;
  for (const tx of txs) {
    for (const ty of tys) {
      for (let k = 0; k <= 10; k += 1) {
        const t = (s * k) / 10;
        if (txs.includes(tx + 1)) {
          const d = dist3(rigidEnu(tx, ty, s, t, s), rigidEnu(tx + 1, ty, 0, t, s));
          if (d > gap) {
            gap = d;
            gapPair = [
              [tx, ty],
              [tx + 1, ty],
            ];
          }
        }
        if (tys.includes(ty + 1)) {
          const d = dist3(rigidEnu(tx, ty, t, s, s), rigidEnu(tx, ty + 1, t, 0, s));
          if (d > gap) {
            gap = d;
            gapPair = [
              [tx, ty],
              [tx, ty + 1],
            ];
          }
        }
      }
    }
  }
  assert(
    fs.rigid_enu_seam_gap_m >= gap && fs.rigid_enu_seam_gap_m <= gap * 1.01,
    `declared seam gap ${fs.rigid_enu_seam_gap_m} m is not a tight outward bound of ` +
      `the recomputed ${gap.toFixed(4)} m`,
  );
  assertEq(fs.rigid_enu_seam_gap_worst_pair, gapPair, "seam-gap worst pair");
  // both figures must be global extremes of the same bbox, stated as such —
  // mixing "one sampled pair" with "the maximum" is what made them incomparable
  assert(
    typeof fs.bounds_convention === "string" && /極值|向外取整/.test(fs.bounds_convention),
    "frame_survey must state its sampling and rounding convention",
  );
});

check("E19", "corridor survey containment claims match its own coordinates (S-3)", () => {
  const m = readJson("constants/m1_area.json");
  const c = m.corridor_survey;
  const r = c.relaxed;
  assert(r && Number.isFinite(r.run_m), "corridor_survey needs a recorded relaxed-tolerance run");
  assert(
    r.chord_tolerance_m > c.chord_tolerance_m,
    "the relaxed variant must actually relax the straightness tolerance",
  );
  assert(
    r.run_m > c.straight_run_m,
    "relaxing the tolerance can only lengthen the run — a shorter one means a different method",
  );
  assert(
    c.straight_run_along_m >= c.straight_run_m,
    "the along-polyline length cannot be shorter than the chord",
  );
  // the claim about the bbox must agree with the coordinate it is based on
  const inside = r.west_end_e >= m.bbox.e_min && r.west_end_e < m.bbox.e_max;
  assertEq(r.west_end_inside_bbox, inside, "west_end_inside_bbox vs the recorded easting");
  if (inside) {
    assert(
      !/越出 bbox|越界|超出 bbox/.test(c.survey + (r.note || "")),
      "the survey claims the relaxed run leaves the bbox while its own easting is inside",
    );
  }
  // the prose must cite the numbers the fields record, so the two cannot drift
  for (const lit of [c.straight_run_m, r.run_m]) {
    assert(
      new RegExp(`(?<![0-9.])${String(lit).replace(/\./g, "\\.")}(?![0-9])`).test(c.survey),
      `corridor survey text must cite ${lit} m`,
    );
  }
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (r.err) {
    failed += 1;
    console.log(`FAIL ${r.id} ${r.name}\n     ${r.err}`);
  } else {
    console.log(`ok   ${r.id} ${r.name}`);
  }
}
console.log("skip permissions — N/A: pure documentation contract");
console.log("skip concurrency — N/A: pure documentation contract");
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
