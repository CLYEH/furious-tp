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

test("an unknown mode is a usage error, not a default run", async () => {
  const r = await runProbe(["--mode=hammer", "--url=http://127.0.0.1:1/x"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /mode/i);
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
