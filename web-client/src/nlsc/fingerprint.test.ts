import { describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_POLLS,
  MAX_TRACKED_HASHES,
  type TilesetAlert,
  type TilesetWatchRecord,
  checkTilesetFingerprint,
  describeAlert,
  emptyRecord,
  isWellFormedRecord,
  localStorageWatchStore,
  memoryWatchStore,
  readTilesetSample,
  recordSample,
  sha256Hex,
} from "./fingerprint.js";

const URL_UNDER_TEST = "https://3dtiles.nlsc.gov.tw/building/tiles3d/22/tileset.json";

// Three tileset bodies and their digests. The digests are LITERAL: they were
// produced outside this module (node:crypto) and are written here by hand. If
// every expected value were imported from the module under test, swapping the
// digest function for a constant would keep the suite green — the exact hole
// this project hit on the DTM sentinel.
const TILESET_A = '{"asset":{"version":"1.0"},"id":"112_A","geometricError":512,"root":{}}';
const TILESET_B = '{"asset":{"version":"1.0"},"id":"114_A","geometricError":512,"root":{}}';
const TILESET_C = '{"asset":{"version":"1.0"},"id":"115_A","geometricError":512,"root":{}}';
const HASH_A = "0955d4e0abc835b592ddea933dbf7cd34ae2884219c9f964804041579a9e667a";
const HASH_B = "7b547bc1d4a5c1547ebc5ec962bafaa7cd17e60bec9e9f3b14b03be2ce3cd4ec";
const HASH_C = "57530930bdbd8c233b86c4c4525346530cba9706df775d7bc837757527a09fd7";

const T0 = "2026-08-11T00:00:00.000Z";

// The shape the defective endpoint actually returns: a body of NUL bytes
// declaring itself gzip. Written as an escape, because a literal NUL in a
// source file makes git treat the whole file as binary and stop diffing it.
const NUL_BODY = "\u0000".repeat(4);

function okSample(hash: string, tilesetId: string | null = "112_A") {
  return { ok: true as const, hash, tilesetId };
}

/** Feed a record a run of successful samples, collecting every alert raised. */
function feed(
  record: TilesetWatchRecord,
  hashes: string[],
  tilesetId: string | null = "112_A",
): { record: TilesetWatchRecord; alerts: TilesetAlert[] } {
  let current = record;
  const alerts: TilesetAlert[] = [];
  for (const [i, h] of hashes.entries()) {
    const step = recordSample(current, okSample(h, tilesetId), `2026-08-1${1 + i}T00:00:00.000Z`);
    current = step.record;
    alerts.push(...step.alerts);
  }
  return { record: current, alerts };
}

/** A response whose body cannot be read — what a corrupt content-encoding does. */
function unreadableResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.reject(new TypeError("Failed to fetch")),
  } as unknown as Response;
}

function jsonResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("sha256Hex", () => {
  it("returns the known digest of a known string", async () => {
    // Both sides literal.
    await expect(sha256Hex("hello")).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("returns the known digest of a tileset body", async () => {
    await expect(sha256Hex(TILESET_A)).resolves.toBe(HASH_A);
  });

  it("emits 64 lowercase hex characters", async () => {
    const digest = await sha256Hex(TILESET_A);
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates bodies that differ by one character", async () => {
    // Control: a constant-returning digest passes every case above but not this.
    await expect(sha256Hex(TILESET_B)).resolves.not.toBe(HASH_A);
    await expect(sha256Hex(TILESET_B)).resolves.toBe(HASH_B);
    await expect(sha256Hex(TILESET_C)).resolves.toBe(HASH_C);
  });

  it("hashes the empty string without throwing", async () => {
    await expect(sha256Hex("")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readTilesetSample", () => {
  it("reads the decoded body and its tileset id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(TILESET_A));
    await expect(readTilesetSample(URL_UNDER_TEST, fetchImpl)).resolves.toEqual({
      ok: true,
      hash: HASH_A,
      tilesetId: "112_A",
    });
  });

  // FTP-5 §2.3: a preflight is answered 405, and ACAO is a wildcard paired with
  // allow-credentials. A custom header or a credentialled request is blocked by
  // the browser — invisible here unless the init is asserted.
  it("requests without custom headers and without credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(TILESET_A));
    await readTilesetSample(URL_UNDER_TEST, fetchImpl);
    const call = fetchImpl.mock.calls[0];
    expect(call, "fetch was never called").toBeDefined();
    const init: RequestInit = call?.[1] ?? {};
    expect(call?.[0]).toBe(URL_UNDER_TEST);
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe("omit");
  });

  it("reports a non-2xx status as a defect, not as a change", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse("nope", 503));
    await expect(readTilesetSample(URL_UNDER_TEST, fetchImpl)).resolves.toMatchObject({
      ok: false,
      reason: "http-status",
    });
  });

  // The live failure mode measured on 2026-08-11: 200 + content-encoding gzip,
  // body is 3,176,361 NUL bytes. A browser surfaces that as a failed body read
  // (ERR_CONTENT_DECODING_FAILED); Node surfaces the NULs.
  it("reports a body that cannot be read as a defect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(unreadableResponse());
    await expect(readTilesetSample(URL_UNDER_TEST, fetchImpl)).resolves.toMatchObject({
      ok: false,
      reason: "undecodable",
    });
  });

  it("reports a body that is not JSON as a defect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(NUL_BODY));
    await expect(readTilesetSample(URL_UNDER_TEST, fetchImpl)).resolves.toMatchObject({
      ok: false,
      reason: "unparseable",
    });
  });

  it("reports an empty body as a defect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(""));
    await expect(readTilesetSample(URL_UNDER_TEST, fetchImpl)).resolves.toMatchObject({
      ok: false,
      reason: "unparseable",
    });
  });

  it("reports a transport failure as a defect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("NetworkError"));
    await expect(readTilesetSample(URL_UNDER_TEST, fetchImpl)).resolves.toMatchObject({
      ok: false,
      reason: "transport",
    });
  });

  it("reports a timeout as a defect and says so", async () => {
    const abort = new DOMException("The operation was aborted", "TimeoutError");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(abort);
    const sample = await readTilesetSample(URL_UNDER_TEST, fetchImpl, 10);
    expect(sample).toMatchObject({ ok: false, reason: "transport" });
    expect(sample.ok === false && sample.detail).toContain("逾時");
  });

  // Found in the browser: the abort landed while reading the body, not while
  // opening the request, and was reported as a corrupt document. Calling our
  // own clock a service defect is the kind of false alarm that makes the whole
  // alert channel worthless.
  it("reports an abort during the body read as transport, not as corruption", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("The user aborted a request.")),
    } as unknown as Response);
    const sample = await readTilesetSample(URL_UNDER_TEST, fetchImpl, 25);
    expect(sample).toMatchObject({ ok: false, reason: "transport" });
    expect(sample.ok === false && sample.detail).toContain("中止");
  });

  // An abort that is not the clock must not be dressed up as one. The merged
  // version printed "連線逾時(25 ms)" here, and that number was invented.
  it("does not invent a deadline for an abort that was not a timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("The user aborted a request.")),
    } as unknown as Response);
    const sample = await readTilesetSample(URL_UNDER_TEST, fetchImpl, 25);
    expect(sample.ok === false && sample.detail).not.toContain("25 ms");
    expect(sample.ok === false && sample.detail).not.toContain("逾時");
  });

  it("does quote the deadline when the clock really was the cause", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    const sample = await readTilesetSample(URL_UNDER_TEST, fetchImpl, 25);
    expect(sample).toMatchObject({ ok: false, reason: "transport" });
    expect(sample.ok === false && sample.detail).toContain("逾時");
    expect(sample.ok === false && sample.detail).toContain("25 ms");
  });

  // FTP-5 §3.5: the defective endpoints return SERVER PROCESS MEMORY, and this
  // detail is rendered into the page. V8's JSON parse message quotes the first
  // ~10 characters of its input, so the parser message may never be used.
  it("never renders upstream body content into the failure detail", async () => {
    const leak = 'SECRET-abc-this-came-from-server-memory';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(leak));
    const sample = await readTilesetSample(URL_UNDER_TEST, fetchImpl);
    expect(sample).toMatchObject({ ok: false, reason: "unparseable" });
    const detail = sample.ok === false ? sample.detail : "";
    expect(detail).not.toContain("SECRET");
    // A control: the case would pass trivially if the body were never a
    // substring of anything, so prove the leak is what a naive detail carries.
    let parserMessage = "";
    try {
      JSON.parse(leak);
    } catch (e) {
      parserMessage = e instanceof Error ? e.message : "";
    }
    expect(parserMessage).toContain("SECRET");
    // What it says instead: a category and a count, per FTP-5 §7.
    expect(detail).toContain("不是合法 JSON");
    expect(detail).toContain(String(leak.length));
  });

  it("accepts a tileset with no id rather than failing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('{"asset":{"version":"1.0"}}'));
    await expect(readTilesetSample(URL_UNDER_TEST, fetchImpl)).resolves.toMatchObject({
      ok: true,
      tilesetId: null,
    });
  });
});

describe("recordSample — first record", () => {
  it("records the first hash and raises nothing", () => {
    const { record, alerts } = recordSample(emptyRecord(URL_UNDER_TEST), okSample(HASH_A), T0);
    expect(record.establishedHash).toBe(HASH_A);
    expect(record.establishedTilesetId).toBe("112_A");
    expect(alerts).toEqual([]);
  });

  it("stores the observation with its first and last sighting", () => {
    const { record } = recordSample(emptyRecord(URL_UNDER_TEST), okSample(HASH_A), T0);
    expect(record.observations).toEqual([
      { hash: HASH_A, firstSeenAt: T0, lastSeenAt: T0, count: 1 },
    ]);
  });

  it("counts repeat sightings without raising anything", () => {
    const { record, alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_A, HASH_A, HASH_A]);
    expect(record.observations).toHaveLength(1);
    expect(record.observations[0]?.count).toBe(4);
    expect(record.observations[0]?.firstSeenAt).not.toBe(record.observations[0]?.lastSeenAt);
    expect(alerts).toEqual([]);
  });
});

// FTP-5 §5.3(4) and §6.3 risk 5. The confirmation rule is the whole reason the
// alert is worth believing: the service is known to answer one URL with more
// than one body, so a single new digest is not evidence of a revision.
describe("recordSample — a revision needs consecutive confirmation", () => {
  it("does not call one new digest a revision", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_A, HASH_A, HASH_B]);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([]);
  });

  it("does not call two consecutive new digests a revision", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_A, HASH_B, HASH_B]);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([]);
  });

  it("calls three consecutive new digests a revision", () => {
    const { record, alerts } = feed(emptyRecord(URL_UNDER_TEST), [
      HASH_A,
      HASH_A,
      HASH_B,
      HASH_B,
      HASH_B,
    ]);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([
      { kind: "revision", url: URL_UNDER_TEST, from: HASH_A, to: HASH_B },
    ]);
    expect(record.establishedHash).toBe(HASH_B);
  });

  it("confirms after exactly CONFIRMATION_POLLS sightings", () => {
    expect(CONFIRMATION_POLLS).toBe(3);
    const before = feed(emptyRecord(URL_UNDER_TEST), [
      HASH_A,
      ...Array<string>(CONFIRMATION_POLLS - 1).fill(HASH_B),
    ]);
    expect(before.alerts.filter((a) => a.kind === "revision")).toHaveLength(0);
    const after = feed(emptyRecord(URL_UNDER_TEST), [
      HASH_A,
      ...Array<string>(CONFIRMATION_POLLS).fill(HASH_B),
    ]);
    expect(after.alerts.filter((a) => a.kind === "revision")).toHaveLength(1);
  });

  it("raises a revision exactly once, not on every later poll", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [
      HASH_A,
      HASH_B,
      HASH_B,
      HASH_B,
      HASH_B,
      HASH_B,
    ]);
    expect(alerts.filter((a) => a.kind === "revision")).toHaveLength(1);
  });

  // The invariant the ticket states: a change is ALWAYS detected. A permanent
  // change must not be able to sit unreported forever.
  it("always detects a permanent change within CONFIRMATION_POLLS + 1 polls", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [
      HASH_A,
      ...Array<string>(CONFIRMATION_POLLS).fill(HASH_C),
    ]);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([
      { kind: "revision", url: URL_UNDER_TEST, from: HASH_A, to: HASH_C },
    ]);
  });
});

// The other half of §5.3(4): one URL answering with two bodies is a DIFFERENT
// event from a revision, and reporting it as a revision is a false alarm. The
// service list already behaves this way today (FTP-5 §0.1).
describe("recordSample — divergence is not a revision", () => {
  it("calls an alternating sequence a divergence", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_B, HASH_A]);
    expect(alerts.filter((a) => a.kind === "source-divergence")).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([]);
  });

  it("names both digests in the divergence alert", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_B, HASH_A]);
    const divergence = alerts.find((a) => a.kind === "source-divergence");
    expect(divergence).toMatchObject({ url: URL_UNDER_TEST });
    expect(divergence?.kind === "source-divergence" && divergence.hashes.sort()).toEqual(
      [HASH_A, HASH_B].sort(),
    );
  });

  it("calls three different digests in a row a divergence", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_B, HASH_C]);
    expect(alerts.filter((a) => a.kind === "source-divergence")).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([]);
  });

  it("does not let an alternating run ever be promoted to a revision", () => {
    const { record, alerts } = feed(emptyRecord(URL_UNDER_TEST), [
      HASH_A,
      HASH_B,
      HASH_A,
      HASH_B,
      HASH_A,
      HASH_B,
    ]);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([]);
    expect(record.establishedHash).toBe(HASH_A);
  });

  it("keeps every digest it has seen, with its own sighting counts", () => {
    const { record } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_B, HASH_A, HASH_B]);
    const byHash = Object.fromEntries(record.observations.map((o) => [o.hash, o.count]));
    expect(byHash).toEqual({ [HASH_A]: 2, [HASH_B]: 2 });
  });
});

describe("recordSample — a service defect is neither", () => {
  const defect = { ok: false as const, reason: "unparseable" as const, detail: "全為 NUL" };

  it("raises a service-defect alert", () => {
    const seeded = feed(emptyRecord(URL_UNDER_TEST), [HASH_A]).record;
    const { alerts } = recordSample(seeded, defect, T0);
    expect(alerts).toEqual([
      { kind: "service-defect", url: URL_UNDER_TEST, reason: "unparseable", detail: "全為 NUL" },
    ]);
  });

  it("never reports a defect as a revision or a divergence", () => {
    let record = feed(emptyRecord(URL_UNDER_TEST), [HASH_A]).record;
    const alerts: TilesetAlert[] = [];
    for (let i = 0; i < 5; i++) {
      const step = recordSample(record, defect, T0);
      record = step.record;
      alerts.push(...step.alerts);
    }
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([]);
    expect(alerts.filter((a) => a.kind === "source-divergence")).toEqual([]);
  });

  it("leaves the established fingerprint untouched", () => {
    const seeded = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_A]).record;
    const { record } = recordSample(seeded, defect, T0);
    expect(record.establishedHash).toBe(HASH_A);
    expect(record.observations).toEqual(seeded.observations);
    expect(record.recent).toEqual(seeded.recent);
  });

  // A defect between two sightings of the new digest must not break the run's
  // continuity in a way that silently loses the revision, nor fake one.
  it("does not let a defect stand in for a confirming poll", () => {
    let record = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_B, HASH_B]).record;
    const alerts: TilesetAlert[] = [];
    const step1 = recordSample(record, defect, T0);
    record = step1.record;
    alerts.push(...step1.alerts);
    expect(alerts.filter((a) => a.kind === "revision")).toEqual([]);
    const step2 = recordSample(record, okSample(HASH_B), T0);
    expect(step2.alerts.filter((a) => a.kind === "revision")).toHaveLength(1);
  });
});

describe("recordSample — the signals must agree", () => {
  // Replaces a case that asserted the opposite and could never fail. The id is
  // part of the document the digest covers, and readTilesetSample derives the
  // hash and the id from the same text — so "the id moved but the content did
  // not" is not a state the reader can produce, and the module has no branch
  // for it. This case pins the reason, and unlike its predecessor it would go
  // red if the digest ever stopped covering the id.
  it("cannot see an id change without a content change", async () => {
    // TILESET_A and TILESET_B differ in exactly one field: the id.
    expect(TILESET_A.replace("112_A", "114_A")).toBe(TILESET_B);
    await expect(sha256Hex(TILESET_A)).resolves.not.toBe(await sha256Hex(TILESET_B));
  });

  it("flags content that moves while the tileset id does not", () => {
    const { alerts } = feed(
      emptyRecord(URL_UNDER_TEST),
      [HASH_A, HASH_B, HASH_B, HASH_B],
      "112_A",
    );
    expect(alerts.filter((a) => a.kind === "revision")).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === "signal-mismatch")).toHaveLength(1);
  });

  it("stays quiet when both move together", () => {
    let record = feed(emptyRecord(URL_UNDER_TEST), [HASH_A], "112_A").record;
    const alerts: TilesetAlert[] = [];
    for (let i = 0; i < CONFIRMATION_POLLS; i++) {
      const step = recordSample(record, okSample(HASH_B, "114_A"), T0);
      record = step.record;
      alerts.push(...step.alerts);
    }
    expect(alerts.filter((a) => a.kind === "revision")).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === "signal-mismatch")).toEqual([]);
  });
});

// Same rule as the unparseable detail (S2): the tileset id is upstream content
// that ends up in the page, so it is bounded too. Normally it is 5 characters.
describe("the tileset id is not a channel for whatever upstream sends", () => {
  it("keeps a normal id intact", () => {
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_B, HASH_B, HASH_B], "112_A");
    const mismatch = alerts.find((a) => a.kind === "signal-mismatch");
    expect(mismatch?.kind === "signal-mismatch" && mismatch.detail).toContain("112_A");
  });

  it("bounds an absurd id instead of rendering all of it", () => {
    const huge = "X".repeat(5000);
    const { alerts } = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_B, HASH_B, HASH_B], huge);
    const mismatch = alerts.find((a) => a.kind === "signal-mismatch");
    const detail = mismatch?.kind === "signal-mismatch" ? mismatch.detail : "";
    expect(detail.length).toBeLessThan(200);
    expect(detail).toContain("5000 字元");
  });
});

describe("recordSample — the record cannot grow without bound", () => {
  it("keeps at most MAX_TRACKED_HASHES observations", async () => {
    let record = emptyRecord(URL_UNDER_TEST);
    for (let i = 0; i < MAX_TRACKED_HASHES + 5; i++) {
      const hash = await sha256Hex(`body-${i}`);
      record = recordSample(record, okSample(hash), `2026-08-11T00:00:0${i % 10}.000Z`).record;
    }
    expect(record.observations.length).toBeLessThanOrEqual(MAX_TRACKED_HASHES);
  });

  it("never evicts the established fingerprint", async () => {
    let record = feed(emptyRecord(URL_UNDER_TEST), [HASH_A]).record;
    for (let i = 0; i < MAX_TRACKED_HASHES + 5; i++) {
      const hash = await sha256Hex(`body-${i}`);
      record = recordSample(record, okSample(hash), `2026-08-11T00:00:0${i % 10}.000Z`).record;
    }
    expect(record.observations.map((o) => o.hash)).toContain(record.establishedHash);
  });
});

describe("describeAlert", () => {
  it.each([
    [{ kind: "revision", url: URL_UNDER_TEST, from: HASH_A, to: HASH_B }, "連續 3 次載入"],
    [{ kind: "source-divergence", url: URL_UNDER_TEST, hashes: [HASH_A, HASH_B] }, "來源分歧"],
    [
      { kind: "service-defect", url: URL_UNDER_TEST, reason: "unparseable", detail: "x" },
      "服務缺陷",
    ],
    [{ kind: "signal-mismatch", url: URL_UNDER_TEST, detail: "x" }, "訊號不一致"],
    [{ kind: "watch-degraded", url: URL_UNDER_TEST, detail: "x" }, "無法保存"],
  ] as [TilesetAlert, string][])("describes %o to the operator", (alert, phrase) => {
    expect(describeAlert(alert)).toContain(phrase);
  });

  // §5.3 reserves "改版確認" for three consecutive DAILY polls. Here a poll is a
  // page load, so the message must describe what was actually observed and say
  // that the daily confirmation has not happened. Claiming more than was
  // measured is exactly how an alert channel stops being believed.
  it("does not claim a confirmation it has not earned", () => {
    const text = describeAlert({
      kind: "revision",
      url: URL_UNDER_TEST,
      from: HASH_A,
      to: HASH_B,
    });
    expect(text).toContain("連續 3 次載入");
    expect(text).toContain("尚未經每日輪詢確認");
  });

  it("puts the short fingerprint in the revision message", () => {
    const text = describeAlert({
      kind: "revision",
      url: URL_UNDER_TEST,
      from: HASH_A,
      to: HASH_B,
    });
    expect(text).toContain(HASH_A.slice(0, 12));
    expect(text).toContain(HASH_B.slice(0, 12));
  });
});

describe("checkTilesetFingerprint", () => {
  const fetchOf = (...bodies: string[]) => {
    let i = 0;
    return vi.fn<typeof fetch>(() => {
      const body = bodies[Math.min(i, bodies.length - 1)] ?? TILESET_A;
      i += 1;
      return Promise.resolve(jsonResponse(body));
    });
  };

  it("records the fingerprint on first run", async () => {
    const store = memoryWatchStore();
    const emit = vi.fn();
    const { record } = await checkTilesetFingerprint({
      url: URL_UNDER_TEST,
      fetchImpl: fetchOf(TILESET_A),
      store,
      emit,
    });
    expect(record.establishedHash).toBe(HASH_A);
    expect(store.load(URL_UNDER_TEST)?.establishedHash).toBe(HASH_A);
    expect(emit).not.toHaveBeenCalled();
  });

  // The alert has to LEAVE the module. A version that computes a digest and
  // drops it passes every recordSample case above.
  it("hands every alert to the sink", async () => {
    const store = memoryWatchStore();
    const received: TilesetAlert[] = [];
    const emit = (a: TilesetAlert): void => void received.push(a);
    const fetchImpl = fetchOf(TILESET_A, TILESET_B, TILESET_B, TILESET_B);
    for (let i = 0; i < 4; i++) {
      await checkTilesetFingerprint({ url: URL_UNDER_TEST, fetchImpl, store, emit });
    }
    expect(received).toContainEqual({
      kind: "revision",
      url: URL_UNDER_TEST,
      from: HASH_A,
      to: HASH_B,
    });
  });

  it("hands a service defect to the sink too", async () => {
    const store = memoryWatchStore();
    const received: TilesetAlert[] = [];
    await checkTilesetFingerprint({
      url: URL_UNDER_TEST,
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("NetworkError")),
      store,
      emit: (a) => void received.push(a),
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "service-defect", reason: "transport" });
  });

  it("persists between runs so the comparison survives a reload", async () => {
    const backing = new Map<string, string>();
    const storage = fakeStorage(backing);
    const first = localStorageWatchStore(storage);
    await checkTilesetFingerprint({
      url: URL_UNDER_TEST,
      fetchImpl: fetchOf(TILESET_A),
      store: first,
      emit: vi.fn(),
    });
    // A fresh store over the same backing storage is what a page reload is.
    const second = localStorageWatchStore(fakeStorage(backing));
    expect(second.load(URL_UNDER_TEST)?.establishedHash).toBe(HASH_A);
  });

  it("survives a storage that cannot be read", async () => {
    const store = {
      load: () => {
        throw new Error("SecurityError");
      },
      save: vi.fn(),
    };
    const received: TilesetAlert[] = [];
    await expect(
      checkTilesetFingerprint({
        url: URL_UNDER_TEST,
        fetchImpl: fetchOf(TILESET_A),
        store,
        emit: (a) => void received.push(a),
      }),
    ).resolves.toMatchObject({ record: { establishedHash: HASH_A } });
    expect(received.map((a) => a.kind)).toContain("watch-degraded");
  });

  it("survives a storage that cannot be written", async () => {
    const store = {
      load: () => null,
      save: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const received: TilesetAlert[] = [];
    await expect(
      checkTilesetFingerprint({
        url: URL_UNDER_TEST,
        fetchImpl: fetchOf(TILESET_A),
        store,
        emit: (a) => void received.push(a),
      }),
    ).resolves.toMatchObject({ record: { establishedHash: HASH_A } });
    expect(received.map((a) => a.kind)).toContain("watch-degraded");
  });

  // Two overlapping checks (a boot check racing a scheduled one) must not lose
  // an observation: both read the same record, and the later save would drop
  // the earlier one.
  it("does not lose an observation when two checks overlap", async () => {
    const store = memoryWatchStore();
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(TILESET_A)));
    const emit = vi.fn();
    await Promise.all([
      checkTilesetFingerprint({ url: URL_UNDER_TEST, fetchImpl, store, emit }),
      checkTilesetFingerprint({ url: URL_UNDER_TEST, fetchImpl, store, emit }),
    ]);
    expect(store.load(URL_UNDER_TEST)?.observations[0]?.count).toBe(2);
  });
});

function fakeStorage(backing: Map<string, string>): Storage {
  return {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
}

// B2. A stored record is data written by an older build, sitting in a browser
// nobody controls. Before this, a record that was valid JSON but the wrong
// SHAPE threw inside recordSample — past both try/catch guards — so the check
// rejected, emitted nothing, and left the bad record in place. boot.ts fired it
// with `void`, so it became an unhandled rejection: D5 died silently on that
// machine and repeated the death on every later load.
//
// The realistic trigger is not an attacker. Add one field to TilesetWatchRecord
// and every record already in the wild is the wrong shape.
describe("a stored record that is JSON but not a record", () => {
  const KEY = "ftp:nlsc-tileset-watch:" + URL_UNDER_TEST;

  const poisoned = async (stored: string) => {
    const backing = new Map<string, string>([[KEY, stored]]);
    const store = localStorageWatchStore(fakeStorage(backing));
    const alerts: TilesetAlert[] = [];
    const result = await checkTilesetFingerprint({
      url: URL_UNDER_TEST,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(TILESET_A)),
      store,
      emit: (a) => void alerts.push(a),
    });
    return { alerts, result, backing };
  };

  // Each fixture is valid in EVERY respect except the one defect it names, so
  // the clause under test is the only thing that can reject it.
  //
  // The first version of this table was not isolated: the entry-level fixtures
  // also omitted establishedHash/establishedTilesetId, so they were rejected by
  // the top-level clauses and the entry clauses never decided anything. Two
  // mutants that deleted entry validation entirely survived the whole suite.
  // The cases passed; they were not testing what they said.
  const valid = { url: URL_UNDER_TEST, establishedHash: null, establishedTilesetId: null, observations: [], recent: [] };
  const shapes: [string, string][] = [
    ["an empty object", "{}"],
    ["a record with no observations", JSON.stringify({ ...valid, observations: undefined })],
    ["a record with no recent", JSON.stringify({ ...valid, recent: undefined })],
    ["a url that is not a string", JSON.stringify({ ...valid, url: 7 })],
    ["establishedHash of the wrong type", JSON.stringify({ ...valid, establishedHash: 7 })],
    ["observations that are not an array", JSON.stringify({ ...valid, observations: {} })],
    ["an observation that is not an object", JSON.stringify({ ...valid, observations: [null] })],
    ["an observation missing its hash", JSON.stringify({ ...valid, observations: [{ firstSeenAt: "t", lastSeenAt: "t", count: 1 }] })],
    ["an observation missing its count", JSON.stringify({ ...valid, observations: [{ hash: "a", firstSeenAt: "t", lastSeenAt: "t" }] })],
    ["an observation whose count is not a number", JSON.stringify({ ...valid, observations: [{ hash: "a", firstSeenAt: "t", lastSeenAt: "t", count: "1" }] })],
    ["recent holding a non-string", JSON.stringify({ ...valid, recent: [1] })],
    ["a JSON array", "[]"],
    ["a JSON string", '"nope"'],
  ];

  it.each(shapes)("survives %s rather than rejecting", async (_name, stored) => {
    await expect(poisoned(stored)).resolves.toBeDefined();
  });

  it.each(shapes)("tells the operator about %s", async (_name, stored) => {
    const { alerts } = await poisoned(stored);
    expect(alerts.map((a) => a.kind)).toContain("watch-degraded");
  });

  it.each(shapes)("rebuilds a usable record after %s", async (_name, stored) => {
    const { result, backing } = await poisoned(stored);
    expect(result.record.establishedHash).toBe(HASH_A);
    // And the poison is gone, so the next load is not the same death again.
    expect(isWellFormedRecord(JSON.parse(backing.get(KEY) as string))).toBe(true);
  });

  // Stored `null` is the one shape that is NOT a degradation: it parses to the
  // same value `load` returns for "nothing stored", so it is indistinguishable
  // from a first visit, and a clean restart is the right answer. Kept as its
  // own case rather than bent into the table, because the difference is real.
  it("treats stored null as a first visit, with no alert", async () => {
    const { alerts, result } = await poisoned("null");
    expect(alerts.map((a) => a.kind)).not.toContain("watch-degraded");
    expect(result.record.establishedHash).toBe(HASH_A);
  });

  // Control. A validator that rejected everything would pass every case above
  // while quietly throwing away good records on every single load.
  it("leaves a well-formed record alone", async () => {
    const good = feed(emptyRecord(URL_UNDER_TEST), [HASH_B, HASH_B]).record;
    const backing = new Map<string, string>([[KEY, JSON.stringify(good)]]);
    const alerts: TilesetAlert[] = [];
    const { record } = await checkTilesetFingerprint({
      url: URL_UNDER_TEST,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(TILESET_B)),
      store: localStorageWatchStore(fakeStorage(backing)),
      emit: (a) => void alerts.push(a),
    });
    expect(alerts.map((a) => a.kind)).not.toContain("watch-degraded");
    expect(record.establishedHash).toBe(HASH_B);
    expect(record.observations[0]?.count).toBe(3);
  });
});

describe("isWellFormedRecord", () => {
  it("accepts a record this module produced", () => {
    expect(isWellFormedRecord(emptyRecord(URL_UNDER_TEST))).toBe(true);
    expect(isWellFormedRecord(feed(emptyRecord(URL_UNDER_TEST), [HASH_A]).record)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["a number", 1],
    ["an array", []],
    ["an object with no url", { observations: [], recent: [] }],
    ["a url that is not a string", { url: 1, observations: [], recent: [], establishedHash: null, establishedTilesetId: null }],
    ["establishedHash of the wrong type", { url: "u", observations: [], recent: [], establishedHash: 7, establishedTilesetId: null }],
  ])("rejects %s", (_name, value) => {
    expect(isWellFormedRecord(value)).toBe(false);
  });
});

describe("localStorageWatchStore", () => {
  it("round-trips a record", () => {
    const store = localStorageWatchStore(fakeStorage(new Map()));
    const record = feed(emptyRecord(URL_UNDER_TEST), [HASH_A, HASH_A]).record;
    store.save(record);
    expect(store.load(URL_UNDER_TEST)).toEqual(record);
  });

  it("returns null for a url it has never seen", () => {
    expect(localStorageWatchStore(fakeStorage(new Map())).load(URL_UNDER_TEST)).toBeNull();
  });

  it("treats a corrupted entry as absent rather than throwing", () => {
    const backing = new Map<string, string>();
    const store = localStorageWatchStore(fakeStorage(backing));
    store.save(feed(emptyRecord(URL_UNDER_TEST), [HASH_A]).record);
    const key = [...backing.keys()][0];
    expect(key, "store wrote nothing — this case is not testing what it claims").toBeDefined();
    backing.set(key ?? "", "{not json");
    expect(store.load(URL_UNDER_TEST)).toBeNull();
  });

  it("keeps records for different urls apart", () => {
    const store = localStorageWatchStore(fakeStorage(new Map()));
    const other = "https://3dtiles.nlsc.gov.tw/building/tiles3d/10/tileset.json";
    store.save(feed(emptyRecord(URL_UNDER_TEST), [HASH_A]).record);
    store.save(feed(emptyRecord(other), [HASH_B]).record);
    expect(store.load(URL_UNDER_TEST)?.establishedHash).toBe(HASH_A);
    expect(store.load(other)?.establishedHash).toBe(HASH_B);
  });
});
