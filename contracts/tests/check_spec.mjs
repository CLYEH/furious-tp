#!/usr/bin/env node
// FTP-22 spec exam — declaration commit: these checks encode the acceptance
// criteria and the finalized numeric decisions BEFORE the spec artifacts
// exist. They must all be RED at the declaration commit and GREEN after
// implementation. Run:  node contracts/tests/check_spec.mjs
//
// Categories: happy (H*), boundary (B*), error (E*).
// permissions / concurrency: N/A — pure documentation contract (ticket
// Verification Steps mark these N/A; no runtime surface exists here).
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
  zStep: 0.00390625, // 2^-8 m, global height quantization step
  zQuantMax: 65535, // per-tile height span: (65535+1)*2^-8 = 256 m
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

// ---------------------------------------------------------------------------
// happy — the six AC artifacts exist with required structure
// ---------------------------------------------------------------------------
check("H1", "contracts/README.md: 定位 / 版本策略 / merge = finalized", () => {
  const md = readText("README.md");
  assert(/^## 定位/m.test(md), "missing section 「## 定位」");
  assert(/^## 版本策略/m.test(md), "missing section 「## 版本策略」");
  assert(/merge = finalized/.test(md), "missing clause 「merge = finalized」");
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
  assert(g.z_step_m === 2 ** -8, "z_step_m must be exactly 2^-8");
  assert((g.z_quant_max + 1) * g.z_step_m === 256, "z span must be exactly 256 m");
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

// ---------------------------------------------------------------------------
// error — independent recomputation; domain guards; doc/number drift
// ---------------------------------------------------------------------------

// From-scratch inverse transverse Mercator (Snyder 1987, GRS80) + geodetic->ECEF.
// Deliberately NOT the PROJ algorithm that generated the vectors.
function epsg3826ToEcef(E, N, h) {
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

  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const Nn = a / Math.sqrt(1 - e2 * sinP * sinP);
  return {
    lonDeg: (lam * 180) / Math.PI,
    latDeg: (phi * 180) / Math.PI,
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
  assert(/z_step_m *= *1\/256/.test(md), "grid.md does not state z_step_m = 1/256");
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
