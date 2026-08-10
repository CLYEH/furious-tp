#!/usr/bin/env node
// nlsc-probe.mjs — FTP-5 / Spike R1 measurement probe (experiment, not a module).
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS TOOL POINTS AT A PUBLIC GOVERNMENT SERVICE. READ BEFORE RUNNING.
//
// It exists to answer one feasibility question — "can a browser client stream
// NLSC 3D Tiles directly?" — and NOT to load-test anything. Every default is
// deliberately timid, and the restraint is enforced in code rather than left to
// the operator's judgement:
//
//   * Requests are strictly SEQUENTIAL. There is no concurrency flag.
//   * Request rate is capped at MAX_RPS = 2 req/s. `--rps` higher than that is
//     clamped, not obeyed, and the clamp is reported in the output.
//   * A single HTTP 429 aborts the whole run immediately. So does a sustained
//     error rate. The probe never retries and never "pushes through" a block.
//   * The total request budget (`--max-requests`, default 120) covers tileset
//     discovery as well as tile fetches.
//   * No credentials, no cookies, no auth: the service is public and anonymous
//     access is the access pattern under test.
//
// Stopping early is a valid, reportable result. If you find yourself raising
// the caps to "get better numbers", stop and reconsider: the numbers are not
// worth degrading a public service for.
//
// NLSC's TLS hosts send a leaf certificate WITHOUT the issuing intermediate,
// so OpenSSL-based clients (Node included) cannot build a chain on their own.
// Browsers and Windows recover via AIA fetching. Run this probe as:
//
//     node --use-system-ca docs/spikes/nlsc-probe.mjs ...
//
// or supply the TWCA intermediate through NODE_EXTRA_CA_CERTS.
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage:
//   node --use-system-ca docs/spikes/nlsc-probe.mjs --mode=integrity \
//        --url=https://3dtiles.nlsc.gov.tw/building/tiles3d/0/tileset.json --samples=5
//
//   node --use-system-ca docs/spikes/nlsc-probe.mjs --mode=drive \
//        --root=https://3dtiles.nlsc.gov.tw/Terrain20M/tiles3d/%E9%9B%BB%E5%AD%90%E5%9C%B0%E5%9C%96/0/0/0/tileset.json \
//        --depth=8 --max-requests=120 --rps=2
//
// Modes:
//   integrity — fetch one tileset.json N times and check that the body is
//               actually decodable (declared Content-Encoding honoured, JSON
//               parses). Also reports the version signals D5 would rely on.
//   drive     — walk the tileset tree towards a route (default: a short Xinyi
//               District drive), then request the discovered tiles in route
//               order at the configured rate, measuring latency.
//
// Exit codes: 0 clean · 2 usage error · 3 run aborted (429 / error rate /
// transport) · 4 integrity defect detected.
//
// Output: one JSON object on stdout, stable schema (schemaVersion 1), so two
// runs can be diffed.

import http from "node:http";
import https from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const MAX_RPS = 2; // hard ceiling — see the banner above
const DEFAULT_RPS = 1;
const DEFAULT_MAX_REQUESTS = 120;
const DEFAULT_DEPTH = 8;
const DEFAULT_SAMPLES = 5;
const MIN_SAMPLES_FOR_P95 = 20;
const ERROR_RATE_ABORT = 0.2; // after MIN_REQUESTS_FOR_RATE requests
const MIN_REQUESTS_FOR_RATE = 5;
const REQUEST_TIMEOUT_MS = 30_000;

// A short drive through Xinyi District (the M1 vertical slice): Taipei 101 →
// City Hall → Songshou Rd. Longitude, latitude.
const DEFAULT_ROUTE = [
  [121.5645, 25.0338],
  [121.5665, 25.0356],
  [121.5685, 25.0371],
  [121.5702, 25.0381],
];

// --- argument handling ------------------------------------------------------

function usage(message) {
  process.stderr.write(`${message}\n\nSee the header of this file for the full contract.\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) usage(`unrecognised argument: ${arg}`);
    out[m[1]] = m[2] ?? "true";
  }
  return out;
}

function num(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) usage(`--${name} must be a number, got ${raw}`);
  return v;
}

// --- geodesy (WGS84 lon/lat/height -> ECEF, for bounding-volume tests) ------

function toEcef([lon, lat, height = 0]) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const rlat = (lat * Math.PI) / 180;
  const rlon = (lon * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(rlat) ** 2);
  return [
    (n + height) * Math.cos(rlat) * Math.cos(rlon),
    (n + height) * Math.cos(rlat) * Math.sin(rlon),
    (n * (1 - e2) + height) * Math.sin(rlat),
  ];
}

/** Does a 3D Tiles boundingVolume contain any of the route points? */
function containsAnyRoutePoint(boundingVolume, route) {
  if (!boundingVolume) return true; // unconstrained node: descend
  if (boundingVolume.sphere) {
    const [cx, cy, cz, r] = boundingVolume.sphere;
    return route.some(([lon, lat]) => {
      const [x, y, z] = toEcef([lon, lat]);
      return Math.hypot(x - cx, y - cy, z - cz) <= r;
    });
  }
  if (boundingVolume.region) {
    const [west, south, east, north] = boundingVolume.region;
    return route.some(([lon, lat]) => {
      const rlon = (lon * Math.PI) / 180;
      const rlat = (lat * Math.PI) / 180;
      return rlon >= west && rlon <= east && rlat >= south && rlat <= north;
    });
  }
  return null; // unsupported (e.g. box) — caller decides and reports it
}

// --- HTTP -------------------------------------------------------------------

/**
 * Single request, raw body (NO transparent decompression — checking whether the
 * declared Content-Encoding is honoured is the point of `integrity` mode).
 */
function request(url) {
  const started = Date.now();
  const lib = url.startsWith("https:") ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(
      url,
      {
        headers: {
          // Deliberately no cookie / authorization: anonymous access is the
          // access pattern under test.
          accept: "*/*",
          "user-agent": "furious-tp-spike-r1-probe/1 (+FTP-5 feasibility probe; sequential, <=2 req/s)",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            ms: Date.now() - started,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (err) =>
      resolve({ status: null, headers: {}, body: Buffer.alloc(0), ms: Date.now() - started, error: err }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sequential, rate-limited request driver with the abort rules baked in. */
class Runner {
  constructor(config, findings) {
    this.config = config;
    this.findings = findings;
    this.counts = { total: 0, ok: 0, clientError: 0, serverError: 0, rateLimited: 0, transportError: 0 };
    this.latencies = [];
    this.aborted = false;
    this.abortReason = null;
    this.lastStart = 0;
  }

  get budgetLeft() {
    return this.config.maxRequests - this.counts.total;
  }

  async fetch(url) {
    if (this.aborted || this.budgetLeft <= 0) return null;
    const minInterval = 1000 / this.config.rps;
    const wait = this.lastStart + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();

    const res = await request(url);
    this.counts.total += 1;

    if (res.error) {
      this.counts.transportError += 1;
      const tls = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|CERT/i.test(res.error.code || res.error.message || "");
      this.findings.push({
        kind: tls ? "tls_chain_incomplete" : "transport_error",
        url,
        detail: res.error.message,
        ...(tls
          ? { remedy: "NLSC serves a leaf certificate without its intermediate; run node with --use-system-ca or set NODE_EXTRA_CA_CERTS" }
          : {}),
      });
      this.#abortIfErrorRate();
      return res;
    }

    if (res.status === 429) {
      this.counts.rateLimited += 1;
      this.aborted = true;
      this.abortReason = "rate_limited";
      this.findings.push({
        kind: "rate_limited",
        url,
        status: 429,
        "retry-after": res.headers["retry-after"] ?? null,
        detail: "service returned 429; run aborted immediately without retrying",
      });
      return res;
    }

    if (res.status >= 200 && res.status < 300) {
      this.counts.ok += 1;
      this.latencies.push(res.ms);
    } else if (res.status >= 500) {
      this.counts.serverError += 1;
      this.findings.push({ kind: "server_error", url, status: res.status });
      this.#abortIfErrorRate();
    } else {
      this.counts.clientError += 1;
      this.findings.push({ kind: "client_error", url, status: res.status });
      this.#abortIfErrorRate();
    }
    return res;
  }

  #abortIfErrorRate() {
    const errors = this.counts.clientError + this.counts.serverError + this.counts.transportError;
    if (this.counts.total >= MIN_REQUESTS_FOR_RATE && errors / this.counts.total > ERROR_RATE_ABORT) {
      this.aborted = true;
      this.abortReason = this.counts.transportError === errors ? "transport_error" : "error_rate";
      this.findings.push({
        kind: "aborted",
        reason: this.abortReason,
        detail: `error rate ${(errors / this.counts.total).toFixed(2)} over ${this.counts.total} requests exceeded ${ERROR_RATE_ABORT}`,
      });
    }
  }

  latencySummary() {
    const s = [...this.latencies].sort((a, b) => a - b);
    const pick = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
    const enough = s.length >= MIN_SAMPLES_FOR_P95;
    return {
      count: s.length,
      min: s.length ? s[0] : null,
      p50: s.length ? pick(50) : null,
      p95: enough ? pick(95) : null,
      max: s.length ? s[s.length - 1] : null,
      insufficientSamples: !enough,
      minSamplesForP95: MIN_SAMPLES_FOR_P95,
    };
  }
}

// --- body decoding ----------------------------------------------------------

/** Decode a body according to its declared Content-Encoding. Never guesses. */
function decodeBody(res) {
  const enc = (res.headers["content-encoding"] || "").toLowerCase().trim();
  try {
    if (!enc || enc === "identity") return { ok: true, buf: res.body, encoding: enc || "identity" };
    if (enc === "gzip") return { ok: true, buf: gunzipSync(res.body), encoding: enc };
    if (enc === "deflate") return { ok: true, buf: inflateSync(res.body), encoding: enc };
    if (enc === "br") return { ok: true, buf: brotliDecompressSync(res.body), encoding: enc };
    return { ok: false, encoding: enc, error: `unsupported content-encoding: ${enc}` };
  } catch (err) {
    return { ok: false, encoding: enc, error: err.message };
  }
}

const nulRatio = (buf) => {
  if (!buf.length) return null;
  let zero = 0;
  for (const b of buf) if (b === 0) zero += 1;
  return Number((zero / buf.length).toFixed(4));
};

// --- modes ------------------------------------------------------------------

async function modeIntegrity(config, findings) {
  const runner = new Runner(config, findings);
  const samples = [];
  for (let i = 0; i < config.samples && !runner.aborted; i += 1) {
    const res = await runner.fetch(config.url);
    if (!res) break;
    if (res.error) continue;
    const sample = {
      status: res.status,
      contentLength: res.headers["content-length"] ?? null,
      contentEncoding: res.headers["content-encoding"] ?? null,
      etag: res.headers.etag ?? null,
      lastModified: res.headers["last-modified"] ?? null,
      cacheControl: res.headers["cache-control"] ?? null,
      bytes: res.body.length,
      rawNulByteRatio: nulRatio(res.body),
      rawSha256: createHash("sha256").update(res.body).digest("hex"),
      ms: res.ms,
    };
    if (res.status < 200 || res.status >= 300) {
      sample.defect = { kind: "http_error", status: res.status };
    } else {
      const decoded = decodeBody(res);
      if (!decoded.ok) {
        sample.defect = {
          kind: "corrupt_content_encoding",
          declared: decoded.encoding,
          detail: decoded.error,
          rawNulByteRatio: sample.rawNulByteRatio,
        };
      } else {
        try {
          JSON.parse(decoded.buf.toString("utf8"));
          sample.decodedBytes = decoded.buf.length;
          sample.decodedSha256 = createHash("sha256").update(decoded.buf).digest("hex");
        } catch (err) {
          sample.defect = { kind: "invalid_json", detail: err.message };
        }
      }
    }
    samples.push(sample);
  }

  const defects = samples.filter((s) => s.defect).map((s) => s.defect);
  const decoded = samples.filter((s) => !s.defect);
  const bodyHashes = [...new Set(decoded.map((s) => s.decodedSha256))];
  return {
    runner,
    extra: {
      integrity: {
        url: config.url,
        attempts: samples.length,
        decodable: decoded.length,
        defects,
        samples,
      },
      // What a D5 tileset fingerprint could actually key on, measured rather
      // than assumed.
      versionSignals: {
        etag: samples[0]?.etag ?? null,
        lastModified: samples[0]?.lastModified ?? null,
        cacheControl: samples[0]?.cacheControl ?? null,
        decodedBodySha256: bodyHashes,
        // null, not `true`: with nothing decodable there is no evidence either
        // way, and "stable" would be a comforting lie.
        bodyStableAcrossSamples: bodyHashes.length === 0 ? null : bodyHashes.length === 1,
      },
    },
    exitOnDefect: defects.length > 0,
  };
}

async function modeDrive(config, findings) {
  const runner = new Runner(config, findings);
  const tileUrls = [];
  const visitedTilesets = [];

  // Phase 1 — discovery: descend the tileset tree towards the route.
  const queue = [{ url: config.root, depth: 1 }];
  while (queue.length && !runner.aborted && runner.budgetLeft > 0) {
    const { url, depth } = queue.shift();
    const res = await runner.fetch(url);
    if (!res || res.error || res.status < 200 || res.status >= 300) continue;
    const decoded = decodeBody(res);
    if (!decoded.ok) {
      findings.push({ kind: "corrupt_content_encoding", url, declared: decoded.encoding, detail: decoded.error });
      continue;
    }
    let tileset;
    try {
      tileset = JSON.parse(decoded.buf.toString("utf8"));
    } catch (err) {
      findings.push({ kind: "invalid_json", url, detail: err.message });
      continue;
    }
    visitedTilesets.push({ url, depth, bytes: decoded.buf.length });

    const walk = (node) => {
      if (!node) return;
      const uri = node.content?.uri ?? node.content?.url;
      if (uri) {
        const abs = new URL(uri, url).toString();
        if (/\.json(\?|$)/i.test(abs)) {
          if (depth < config.depth) queue.push({ url: abs, depth: depth + 1 });
        } else if (!tileUrls.includes(abs)) {
          tileUrls.push(abs);
        }
      }
      for (const child of node.children ?? []) {
        const hit = containsAnyRoutePoint(child.boundingVolume, config.route);
        if (hit === null) {
          findings.push({
            kind: "unsupported_bounding_volume",
            url,
            detail: "boundingVolume is neither sphere nor region; descending anyway",
          });
          walk(child);
        } else if (hit) {
          walk(child);
        }
      }
    };
    walk(tileset.root);
  }

  if (!tileUrls.length) {
    findings.push({
      kind: "no_tiles_discovered",
      detail: "tileset traversal produced no tile content URIs; latency figures below are discovery-only",
    });
  }

  // Phase 2 — drive: request the discovered tiles in route order, on repeat,
  // until the budget runs out. The service sends `Cache-Control: no-store`, so
  // a real client re-fetches on every approach too.
  for (let i = 0; !runner.aborted && runner.budgetLeft > 0 && tileUrls.length; i += 1) {
    await runner.fetch(tileUrls[i % tileUrls.length]);
  }

  return {
    runner,
    extra: {
      drive: {
        root: config.root,
        route: config.route,
        depth: config.depth,
        tilesetsVisited: visitedTilesets.length,
        tilesDiscovered: tileUrls.length,
        tilesets: visitedTilesets,
        sampleTileUrls: tileUrls.slice(0, 5),
      },
    },
    exitOnDefect: false,
  };
}

// --- main -------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write("See the header comment of docs/spikes/nlsc-probe.mjs for usage and safety rules.\n");
  process.exit(0);
}

const mode = args.mode;
if (mode !== "drive" && mode !== "integrity") usage(`--mode must be "drive" or "integrity", got ${mode ?? "(none)"}`);

const findings = [];
const rpsRequested = num(args.rps, DEFAULT_RPS, "rps");
if (rpsRequested <= 0) usage("--rps must be greater than 0");
const rps = Math.min(rpsRequested, MAX_RPS);
if (rps < rpsRequested) {
  findings.push({
    kind: "rps_clamped",
    requested: rpsRequested,
    applied: rps,
    detail: `request rate clamped to the hard cap of ${MAX_RPS} req/s; this probe will not hammer a public service`,
  });
}

const maxRequests = num(args["max-requests"], DEFAULT_MAX_REQUESTS, "max-requests");
if (!Number.isInteger(maxRequests) || maxRequests < 1) usage("--max-requests must be an integer >= 1");

let route = DEFAULT_ROUTE;
if (args.route) {
  route = args.route.split(";").map((pair) => {
    const [lon, lat] = pair.split(",").map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) usage(`--route entry is not "lon,lat": ${pair}`);
    return [lon, lat];
  });
}

const config = {
  mode,
  rps,
  rpsRequested,
  maxRequests,
  concurrency: 1,
  hardRpsCap: MAX_RPS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  errorRateAbortThreshold: ERROR_RATE_ABORT,
};

if (mode === "integrity") {
  if (!args.url) usage("--mode=integrity requires --url=<tileset url>");
  config.url = args.url;
  config.samples = num(args.samples, DEFAULT_SAMPLES, "samples");
  if (!Number.isInteger(config.samples) || config.samples < 1) usage("--samples must be an integer >= 1");
} else {
  if (!args.root) usage("--mode=drive requires --root=<root tileset url>");
  config.root = args.root;
  config.depth = num(args.depth, DEFAULT_DEPTH, "depth");
  if (!Number.isInteger(config.depth) || config.depth < 1) usage("--depth must be an integer >= 1");
  config.route = route;
}

const startedAt = new Date().toISOString();
const { runner, extra, exitOnDefect } = mode === "integrity" ? await modeIntegrity(config, findings) : await modeDrive(config, findings);

const report = {
  schemaVersion: SCHEMA_VERSION,
  mode,
  startedAt,
  finishedAt: new Date().toISOString(),
  config,
  requests: runner.counts,
  latencyMs: runner.latencySummary(),
  aborted: runner.aborted,
  abortReason: runner.abortReason,
  ...extra,
  findings,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(runner.aborted ? 3 : exitOnDefect ? 4 : 0);
