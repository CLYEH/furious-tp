import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  NLSC_BUILDING_SERVICE_CODE,
  NLSC_BUILDING_TILESET_URL,
  NLSC_FETCH_INIT,
  NLSC_TILES_ORIGIN,
} from "./nlsc.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THIS_MODULE = path.join(SRC, "config", "nlsc.ts");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

describe("NLSC endpoint configuration", () => {
  // Literal. FTP-5 §3.1/§R5(c): building service code 22 is the endpoint the
  // spike measured end to end; code 0 (the documented Taipei code) was already
  // serving undecodable content when the spike ran.
  it("points at the tileset FTP-5 selected", () => {
    expect(NLSC_BUILDING_TILESET_URL).toBe(
      "https://3dtiles.nlsc.gov.tw/building/tiles3d/22/tileset.json",
    );
  });

  it("names the service code separately so it can be switched", () => {
    expect(NLSC_BUILDING_SERVICE_CODE).toBe("22");
    expect(NLSC_BUILDING_TILESET_URL).toContain(`/tiles3d/${NLSC_BUILDING_SERVICE_CODE}/`);
  });

  it("serves the origin over https", () => {
    expect(NLSC_TILES_ORIGIN).toBe("https://3dtiles.nlsc.gov.tw");
    expect(new URL(NLSC_BUILDING_TILESET_URL).origin).toBe(NLSC_TILES_ORIGIN);
  });
});

// FTP-5 §2.3. These are not style preferences: the service answers a CORS
// preflight with 405, so any request that triggers one is blocked by the
// browser, and it pairs `access-control-allow-origin: *` with
// `access-control-allow-credentials: true`, which a credentialled request
// rejects. Both are invisible in unit tests unless pinned here.
describe("request shape the service actually accepts", () => {
  it("sends no request headers, because a preflight would 405", () => {
    expect(NLSC_FETCH_INIT.headers).toBeUndefined();
  });

  it("never sends credentials, because ACAO is a wildcard", () => {
    expect(NLSC_FETCH_INIT.credentials).toBe("omit");
  });

  it("uses cors mode explicitly", () => {
    expect(NLSC_FETCH_INIT.mode).toBe("cors");
  });
});

// AC4: "NLSC URL 設定集中於單一設定檔". Pinned by scanning the source tree,
// not by reading this file — a second hardcoded host elsewhere is exactly the
// failure this case exists to catch, and only a scan can see it.
describe("the NLSC host has exactly one home in the source tree", () => {
  const HOST = "nlsc.gov.tw";

  it("scans a source tree that is actually there", () => {
    // Control. Without this, a walker that silently returns [] would make the
    // next case pass while checking nothing.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain(THIS_MODULE);
  });

  it("finds the host in the config module", () => {
    // Control in the other direction: proves the matcher can see the host at
    // all, so "found it nowhere else" is a measurement and not a broken grep.
    expect(readFileSync(THIS_MODULE, "utf8")).toContain(HOST);
  });

  it("finds it nowhere else", () => {
    const offenders = sourceFiles()
      .filter((f) => f !== THIS_MODULE)
      .filter((f) => readFileSync(f, "utf8").includes(HOST))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
