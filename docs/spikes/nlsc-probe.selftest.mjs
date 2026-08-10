// Self-test (exam) for nlsc-probe.mjs — FTP-5 / Spike R1.
//
// WHY this file exists: the probe is pointed at a live PUBLIC GOVERNMENT
// SERVICE. Its safety properties (hard rate cap, immediate abort on 429,
// sequential requests, no credentials) are the whole reason it is allowed to
// run at all, and "I read the code and it looked right" is not evidence. Every
// case below runs the probe as a child process against a LOCAL fake server —
// this file never touches nlsc.gov.tw.
//
// Run:  node --test docs/spikes/nlsc-probe.selftest.mjs
//
// Frozen in the FTP-5 declaration commit BEFORE nlsc-probe.mjs existed; every
// case was red at that point. Weakening any assertion later must be justified
// in the ticket [handoff].
//
// Round 2 (Layer 2 review of PR #12) added four cases marked [round-2]. They
// pin behaviour the shipped probe ALREADY had right but the exam did not prove:
// Layer 2's independent mutation run produced four mutants that passed all 12
// original cases. Each [round-2] case was verified red against the specific
// mutant it targets before being kept — see the ticket [handoff] for the run.
//
// Round 3 added three more cases marked [round-3], from Layer 2's 30-mutant run
// on the round-2 exam: three mutants survived, all of them whole branches the
// exam never entered (`invalid_json`, `region` bounding volumes, transport
// errors reaching the abort rule). The shipped probe was right in all three
// cases; only the exam was missing. Same discipline: each case was run against
// the mutant it targets and confirmed red before being kept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "nlsc-probe.mjs");

const MIN_SAMPLES_FOR_P95 = 20; // contract: fewer samples => no p95, flagged
const HARD_RPS_CAP = 2; // contract: --rps above this is clamped, never obeyed

/** Start a fake server; returns { origin, close, state }. */
async function serve(handler) {
  const state = { requests: [], inFlight: 0, maxInFlight: 0 };
  const server = createServer((req, res) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.requests.push({ url: req.url, at: Date.now(), headers: req.headers });
    res.on("close", () => {
      state.inFlight -= 1;
    });
    handler(req, res, state);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}

function json(res, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(200, { "content-type": "application/json", ...extra });
  res.end(buf);
}

/** A three-level tileset tree whose bounding spheres contain every point. */
function tilesetTree(req, res) {
  const path = req.url.split("?")[0];
  const level = /^\/l(\d)\//.exec(path);
  if (!level) {
    res.writeHead(404).end();
    return;
  }
  const n = Number(level[1]);
  if (path.endsWith("tile.b3dm")) {
    const body = Buffer.alloc(64);
    body.write("b3dm", 0, "ascii");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(body);
    return;
  }
  const node = {
    boundingVolume: { sphere: [0, 0, 0, 1e9] },
    geometricError: 100 / (n + 1),
    content: { uri: "tile.b3dm" },
  };
  if (n < 2) node.children = [{ boundingVolume: { sphere: [0, 0, 0, 1e9] }, geometricError: 50, content: { uri: `../l${n + 1}/tileset.json` } }];
  json(res, { asset: { version: "1.0" }, geometricError: 500, root: node });
}

function runProbe(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PROBE, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout, stderr });
      },
    );
  });
}

function parse(stdout) {
  return JSON.parse(stdout);
}

// --- happy path -----------------------------------------------------------

test("drive: reports a stable schema and counts every request", async () => {
  const s = await serve(tilesetTree);
  try {
    const r = await runProbe([
      "--mode=drive",
      `--root=${s.origin}/l0/tileset.json`,
      "--depth=3",
      "--max-requests=8",
      "--rps=2",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const out = parse(r.stdout);
    for (const key of ["schemaVersion", "mode", "startedAt", "finishedAt", "config", "requests", "latencyMs", "aborted", "abortReason", "findings"]) {
      assert.ok(key in out, `missing key ${key}`);
    }
    assert.equal(out.mode, "drive");
    assert.equal(out.aborted, false);
    assert.equal(out.abortReason, null);
    assert.equal(out.requests.total, s.state.requests.length);
    assert.ok(out.requests.ok > 0);
    assert.equal(out.requests.rateLimited, 0);
  } finally {
    await s.close();
  }
});

test("integrity: a well-formed gzip tileset is reported decodable", async () => {
  const body = gzipSync(Buffer.from(JSON.stringify({ asset: { version: "1.0" }, root: {} })));
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(body);
  });
  try {
    const r = await runProbe(["--mode=integrity", `--url=${s.origin}/tileset.json`, "--samples=3", "--rps=2"]);
    assert.equal(r.code, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.integrity.attempts, 3);
    assert.equal(out.integrity.decodable, 3);
    assert.deepEqual(out.integrity.defects, []);
  } finally {
    await s.close();
  }
});

// --- error paths ----------------------------------------------------------

test("integrity: a corrupt content-encoding is detected, not silently accepted", async () => {
  // Exactly the live defect this spike found: correct Content-Length, declared
  // gzip, body that is not a gzip stream.
  const s = await serve((req, res) => {
    const body = Buffer.alloc(4096);
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(body.length) });
    res.end(body);
  });
  try {
    const r = await runProbe(["--mode=integrity", `--url=${s.origin}/tileset.json`, "--samples=2", "--rps=2"]);
    assert.equal(r.code, 4, "a detected defect must not exit 0");
    const out = parse(r.stdout);
    assert.equal(out.integrity.decodable, 0);
    assert.equal(out.integrity.defects.length, 2);
    assert.equal(out.integrity.defects[0].kind, "corrupt_content_encoding");
    // [round-2] The NUL ratio is the number the report quotes as its evidence
    // that the body is not a truncated/mangled gzip stream but empty buffer
    // residue. An unmeasured number must not be quotable: this body is all NUL,
    // so the ratio is exactly 1 and nothing else.
    assert.equal(out.integrity.defects[0].rawNulByteRatio, 1);
    // [round-2] With zero decodable samples there is no evidence of stability
    // either way. Reporting `true` here (the pre-`be889ef` behaviour) would let
    // a D5 fingerprint track corrupt content and call it stable.
    assert.equal(out.versionSignals.bodyStableAcrossSamples, null);
  } finally {
    await s.close();
  }
});

// [round-2] A constant NUL ratio (0 or 1) must not survive: pin a body whose
// ratio is neither, computed from a known mix.
test("integrity: the NUL-byte ratio is measured, not a constant", async () => {
  const body = Buffer.alloc(4000, 0xff);
  body.fill(0, 0, 1000); // exactly 25% NUL
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(body.length) });
    res.end(body);
  });
  try {
    const r = await runProbe(["--mode=integrity", `--url=${s.origin}/tileset.json`, "--samples=1", "--rps=2"]);
    assert.equal(r.code, 4);
    const out = parse(r.stdout);
    assert.equal(out.integrity.samples[0].rawNulByteRatio, 0.25);
    assert.equal(out.integrity.defects[0].rawNulByteRatio, 0.25);
  } finally {
    await s.close();
  }
});

// [round-2] The live `road2nd/0` endpoint returns a DIFFERENT body on every
// request at a fixed Content-Length. A fingerprint that cannot see that — or
// hashes that are constant — would report a mutating endpoint as stable.
test("integrity: bodies that differ between samples are reported unstable, with distinct hashes", async () => {
  let n = 0;
  const s = await serve((req, res) => {
    n += 1;
    const buf = gzipSync(Buffer.from(JSON.stringify({ asset: { version: "1.0" }, root: {}, nonce: n })));
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(buf);
  });
  try {
    const r = await runProbe(["--mode=integrity", `--url=${s.origin}/tileset.json`, "--samples=2", "--rps=2"]);
    assert.equal(r.code, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.integrity.decodable, 2);
    assert.equal(out.versionSignals.bodyStableAcrossSamples, false);
    assert.equal(out.versionSignals.decodedBodySha256.length, 2, "two different bodies must yield two decoded hashes");
    const [a, b] = out.integrity.samples;
    assert.notEqual(a.rawSha256, b.rawSha256, "rawSha256 must track the raw bytes, not be a constant");
    assert.notEqual(a.decodedSha256, b.decodedSha256);
  } finally {
    await s.close();
  }
});

// [round-3] Found by Layer 2's mutation run on the round-2 exam: the
// `invalid_json` branch had NO coverage, so deleting the JSON check entirely
// survived all 18 cases. A body that decodes cleanly but is not a tileset (an
// error page, an HTML interstitial, a truncated write) would then be counted
// decodable, handed a `decodedSha256`, and fed straight into the D5 fingerprint
// — §5.3 of the report keys change detection on exactly that hash. This is the
// same hole `be889ef` closed for the zero-sample case, one branch over.
test("integrity: a decodable body that is not JSON is a defect, never a fingerprintable sample", async () => {
  const body = gzipSync(Buffer.from("<html><body>service temporarily unavailable</body></html>"));
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(body);
  });
  try {
    const r = await runProbe(["--mode=integrity", `--url=${s.origin}/tileset.json`, "--samples=2", "--rps=2"]);
    assert.equal(r.code, 4, "a body that is not a tileset must not exit 0");
    const out = parse(r.stdout);
    assert.equal(out.integrity.decodable, 0, "a non-JSON body must not count as decodable");
    assert.equal(out.integrity.defects.length, 2);
    assert.equal(out.integrity.defects[0].kind, "invalid_json");
    assert.equal(out.integrity.samples[0].decodedSha256, undefined, "a non-JSON body was given a decoded fingerprint");
    assert.equal(out.integrity.samples[0].decodedBytes, undefined);
    // Nothing may reach the D5 fingerprint from a body that never parsed.
    assert.deepEqual(out.versionSignals.decodedBodySha256, []);
    assert.equal(out.versionSignals.bodyStableAcrossSamples, null);
  } finally {
    await s.close();
  }
});

test("429 aborts immediately and is never counted as a good sample", async () => {
  let n = 0;
  const s = await serve((req, res) => {
    n += 1;
    if (n >= 2) {
      res.writeHead(429, { "retry-after": "120" });
      res.end();
      return;
    }
    tilesetTree(req, res);
  });
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=50", "--rps=2"]);
    assert.equal(r.code, 3, "abort must be visible in the exit code");
    const out = parse(r.stdout);
    assert.equal(out.aborted, true);
    assert.equal(out.abortReason, "rate_limited");
    assert.equal(out.requests.rateLimited, 1);
    assert.ok(out.requests.total < 50, "must stop early, not push through");
    assert.equal(out.latencyMs.count, out.requests.ok, "429 must not enter latency samples");
    assert.ok(out.findings.some((f) => /retry-after/i.test(JSON.stringify(f))), "Retry-After must be reported");
  } finally {
    await s.close();
  }
});

test("a sustained error rate aborts the run", async () => {
  const s = await serve((req, res) => {
    if (req.url.endsWith("tile.b3dm")) {
      res.writeHead(503).end();
      return;
    }
    tilesetTree(req, res);
  });
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=50", "--rps=2"]);
    assert.equal(r.code, 3);
    const out = parse(r.stdout);
    assert.equal(out.aborted, true);
    assert.equal(out.abortReason, "error_rate");
    assert.ok(out.requests.total < 50);
  } finally {
    await s.close();
  }
});

// [round-3] Found by Layer 2's mutation run on the round-2 exam: dropping
// `transportError` from the error-rate arithmetic survived all 18 cases,
// because the only abort case used HTTP 503s. Connections that fail outright
// are the shape a rate-limiter or a firewall block takes when it does NOT
// answer 429 — and a probe that keeps dialling an endpoint refusing it is
// exactly the behaviour the report promises this tool cannot exhibit.
test("repeated transport errors abort the run instead of spending the whole budget", async () => {
  const dead = "http://127.0.0.1:1/tile.b3dm"; // nothing listens on port 1
  const s = await serve((req, res) => {
    json(res, {
      asset: { version: "1.0" },
      geometricError: 500,
      root: { boundingVolume: { sphere: [0, 0, 0, 1e9] }, geometricError: 100, content: { uri: dead } },
    });
  });
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/tileset.json`, "--depth=2", "--max-requests=12", "--rps=2"]);
    assert.equal(r.code, 3, "a run that cannot reach the tiles must abort, not exit clean");
    const out = parse(r.stdout);
    assert.equal(out.aborted, true);
    assert.equal(out.abortReason, "transport_error");
    assert.ok(out.requests.transportError >= 4, `transport failures were not counted: ${out.requests.transportError}`);
    assert.ok(out.requests.total < 12, `abort must stop the run early, got ${out.requests.total} of 12`);
    assert.equal(out.latencyMs.count, out.requests.ok, "a failed connection must not enter the latency samples");
    assert.ok(
      out.findings.some((f) => f.kind === "aborted" && f.reason === "transport_error"),
      "the abort and its reason must be in the findings, not only in the exit code",
    );
  } finally {
    await s.close();
  }
});

test("an unknown mode is a usage error, not a default run", async () => {
  const r = await runProbe(["--mode=hammer", "--url=http://127.0.0.1:1/x"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /mode/i);
});

// [round-2] Found by this round's own mutation run: deleting the mode check
// entirely still passed the case above, because a bad mode then failed on the
// missing --root and that message also contains the word "mode". With --root
// supplied, the deleted check would have silently run a drive against the
// service. The property that matters is "makes no requests", not "exits 2".
test("an unknown mode makes no requests at all, even with every other flag valid", async () => {
  const s = await serve(tilesetTree);
  try {
    const r = await runProbe(["--mode=hammer", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=5", "--rps=2"]);
    assert.equal(r.code, 2, "an unrecognised mode must be rejected, not treated as a default");
    assert.equal(s.state.requests.length, 0, "an unrecognised mode reached the network");
  } finally {
    await s.close();
  }
});

// --- boundary values ------------------------------------------------------

test("--rps above the hard cap is clamped, and the clamp is disclosed", async () => {
  const s = await serve(tilesetTree);
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=3", "--rps=500"]);
    assert.equal(r.code, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.config.rps, HARD_RPS_CAP);
    assert.equal(out.config.rpsRequested, 500);
    assert.ok(out.findings.some((f) => /clamp/i.test(JSON.stringify(f))));
  } finally {
    await s.close();
  }
});

// [round-2] The case above proves the clamp is REPORTED; the case below proves
// it is APPLIED. Layer 2's mutant drove 174 req/s while printing
// `config.rps: 2`, and passed all 12 original cases — because the clamp case
// only read the reported value and the wall-clock case only asked for --rps=2,
// which is already inside the cap. Restraint on a public service is the one
// property of this probe that must never be merely announced.
test("the hard cap throttles in wall-clock time even when --rps demands more", async () => {
  const s = await serve(tilesetTree);
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=5", "--rps=500"]);
    assert.equal(r.code, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.config.rps, HARD_RPS_CAP, "the applied rate must be the cap");
    assert.equal(s.state.requests.length, 5);
    // 5 requests at the 2 rps cap => >= ~2s of spacing, whatever --rps asked for.
    const span = s.state.requests.at(-1).at - s.state.requests[0].at;
    assert.ok(span >= 1800, `hard cap was reported but not enforced: span=${span}ms`);
  } finally {
    await s.close();
  }
});

test("the rate limit is enforced in wall-clock time, not merely recorded", async () => {
  const s = await serve(tilesetTree);
  try {
    const t0 = Date.now();
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=5", "--rps=2"]);
    const elapsed = Date.now() - t0;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(s.state.requests.length, 5);
    // 5 requests at 2 rps => >= 2s of spacing between first and last.
    const span = s.state.requests.at(-1).at - s.state.requests[0].at;
    assert.ok(span >= 1800, `requests were not spaced out: span=${span}ms elapsed=${elapsed}ms`);
  } finally {
    await s.close();
  }
});

test("too few samples yields no p95 rather than a fabricated one", async () => {
  const s = await serve(tilesetTree);
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=4", "--rps=2"]);
    const out = parse(r.stdout);
    assert.ok(out.latencyMs.count < MIN_SAMPLES_FOR_P95);
    assert.equal(out.latencyMs.insufficientSamples, true);
    assert.equal(out.latencyMs.p95, null);
  } finally {
    await s.close();
  }
});

test("--max-requests=0 does nothing and says so", async () => {
  const s = await serve(tilesetTree);
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--max-requests=0", "--rps=2"]);
    assert.equal(r.code, 2, "a zero budget is a usage error, not a silent no-op");
    assert.equal(s.state.requests.length, 0);
  } finally {
    await s.close();
  }
});

// --- route filtering ------------------------------------------------------

/** WGS84 lon/lat -> ECEF, mirroring the probe's own geodesy. */
function ecef(lon, lat) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const rlat = (lat * Math.PI) / 180;
  const rlon = (lon * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(rlat) ** 2);
  return [n * Math.cos(rlat) * Math.cos(rlon), n * Math.cos(rlat) * Math.sin(rlon), n * (1 - e2) * Math.sin(rlat)];
}

// [round-2] Found by this round's own mutation run: making the bounding-volume
// test always return true survived the whole exam. Route filtering is what makes
// the latency figures mean "a drive through Xinyi" rather than "whatever tiles
// came first" — and against the live service it is also what keeps the request
// count small. An unfiltered walk would both misreport AC3 and hit the agency
// harder than the report claims.
test("drive: tiles outside the route's bounding volumes are never requested", async () => {
  const onRoute = ecef(121.5645, 25.0338); // Taipei 101
  const offRoute = ecef(120.2, 23.0); // ~250 km away
  const s = await serve((req, res) => {
    const path = req.url.split("?")[0];
    if (path.endsWith(".b3dm")) {
      const body = Buffer.alloc(64);
      body.write("b3dm", 0, "ascii");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
      return;
    }
    json(res, {
      asset: { version: "1.0" },
      geometricError: 500,
      root: {
        boundingVolume: { sphere: [...onRoute, 1e6] },
        geometricError: 100,
        content: { uri: "root.b3dm" },
        children: [
          { boundingVolume: { sphere: [...onRoute, 500] }, geometricError: 50, content: { uri: "near.b3dm" } },
          { boundingVolume: { sphere: [...offRoute, 500] }, geometricError: 50, content: { uri: "far.b3dm" } },
        ],
      },
    });
  });
  try {
    const r = await runProbe([
      "--mode=drive",
      `--root=${s.origin}/tileset.json`,
      "--route=121.5645,25.0338",
      "--depth=3",
      "--max-requests=6",
      "--rps=2",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const paths = s.state.requests.map((q) => q.url);
    assert.ok(paths.some((p) => p.includes("near.b3dm")), "the on-route tile was never fetched");
    assert.ok(!paths.some((p) => p.includes("far.b3dm")), "a tile outside every route bounding volume was fetched");
    const out = parse(r.stdout);
    assert.equal(out.drive.tilesDiscovered, 2, "discovery must keep root + on-route tile only");
  } finally {
    await s.close();
  }
});

// [round-3] Found by Layer 2's mutation run on the round-2 exam: the case above
// only ever exercises `sphere` bounding volumes, so making the `region` branch
// return true unconditionally survived all 18 cases. `region` is the other form
// the 3D Tiles spec defines for georeferenced tilesets — a tileset that used it
// would be walked without any route filter at all, silently turning the AC3
// latency figures into "whatever tiles came first" and multiplying the request
// count against a live public service.
test("drive: route filtering also applies to region bounding volumes", async () => {
  const rad = (deg) => (deg * Math.PI) / 180;
  // [west, south, east, north, minHeight, maxHeight], radians per the spec.
  const onRoute = [rad(121.56), rad(25.03), rad(121.57), rad(25.04), 0, 600];
  const offRoute = [rad(120.19), rad(22.99), rad(120.21), rad(23.01), 0, 600]; // ~250 km away
  const s = await serve((req, res) => {
    const path = req.url.split("?")[0];
    if (path.endsWith(".b3dm")) {
      const body = Buffer.alloc(64);
      body.write("b3dm", 0, "ascii");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
      return;
    }
    json(res, {
      asset: { version: "1.0" },
      geometricError: 500,
      root: {
        boundingVolume: { region: onRoute },
        geometricError: 100,
        content: { uri: "root.b3dm" },
        children: [
          { boundingVolume: { region: onRoute }, geometricError: 50, content: { uri: "near.b3dm" } },
          { boundingVolume: { region: offRoute }, geometricError: 50, content: { uri: "far.b3dm" } },
        ],
      },
    });
  });
  try {
    const r = await runProbe([
      "--mode=drive",
      `--root=${s.origin}/tileset.json`,
      "--route=121.5645,25.0338",
      "--depth=3",
      "--max-requests=6",
      "--rps=2",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const paths = s.state.requests.map((q) => q.url);
    assert.ok(paths.some((p) => p.includes("near.b3dm")), "the on-route tile inside the region was never fetched");
    assert.ok(!paths.some((p) => p.includes("far.b3dm")), "a tile outside every route region was fetched");
    const out = parse(r.stdout);
    assert.equal(out.drive.tilesDiscovered, 2, "discovery must keep root + on-route tile only");
    assert.ok(
      !out.findings.some((f) => f.kind === "unsupported_bounding_volume"),
      "region is a supported bounding volume and must not be reported as unsupported",
    );
  } finally {
    await s.close();
  }
});

// --- concurrency ----------------------------------------------------------

test("requests are strictly sequential (never parallel against the service)", async () => {
  const s = await serve((req, res) => setTimeout(() => tilesetTree(req, res), 60));
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=6", "--rps=2"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(s.state.maxInFlight, 1, "probe must never open concurrent connections");
    const out = parse(r.stdout);
    assert.equal(out.config.concurrency, 1);
  } finally {
    await s.close();
  }
});

// --- permissions ----------------------------------------------------------

// [round-2] The corrupt endpoints return server process memory (see nlsc.md
// §3.5). Anything this probe prints may end up in a ticket, a PR or an email to
// the agency, so the probe must characterise those bodies — length, NUL ratio,
// hash — and never reproduce them. This is a disclosure property, not a
// formatting preference.
test("response bodies are never echoed to stdout, only characterised", async () => {
  const marker = "LEAKED-RESIDUE-MARKER-8f31c0";
  const s = await serve((req, res) => {
    // Undecodable body (declared gzip, is not) carrying recognisable content —
    // the shape of the live defect.
    const body = Buffer.alloc(4096);
    body.write(marker, 100, "ascii");
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(body.length) });
    res.end(body);
  });
  try {
    const r = await runProbe(["--mode=integrity", `--url=${s.origin}/tileset.json`, "--samples=1", "--rps=2"]);
    assert.equal(r.code, 4);
    assert.ok(!r.stdout.includes(marker), "probe echoed response body content to stdout");
    assert.ok(!r.stderr.includes(marker), "probe echoed response body content to stderr");
    const out = parse(r.stdout);
    // It must still say something useful about the body it refused to print.
    assert.match(out.integrity.samples[0].rawSha256, /^[0-9a-f]{64}$/);
    assert.equal(out.integrity.samples[0].bytes, 4096);
  } finally {
    await s.close();
  }
});

test("no credentials are ever sent (the service is public and must stay anonymous)", async () => {
  const s = await serve((req, res) => {
    // The live service sets a session cookie on every response; the probe must
    // not echo it back, and must not send any authorization material.
    res.setHeader("set-cookie", "session-id=deadbeef");
    tilesetTree(req, res);
  });
  try {
    const r = await runProbe(["--mode=drive", `--root=${s.origin}/l0/tileset.json`, "--depth=3", "--max-requests=6", "--rps=2"]);
    assert.equal(r.code, 0, r.stderr);
    for (const req of s.state.requests) {
      assert.equal(req.headers.cookie, undefined, "probe leaked a cookie back to the service");
      assert.equal(req.headers.authorization, undefined, "probe sent authorization material");
    }
  } finally {
    await s.close();
  }
});
