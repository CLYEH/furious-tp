/**
 * `npm run bench` — RFC D6's reference-rig local harness.
 *
 * WHAT THIS COMMAND DOES NOT DO: decide whether the numbers are good. RFC D6's
 * thresholds and the regression baseline are FTP-49. The exit code here is
 * about whether the RUN completed, never about performance — an invalid report
 * means "do not read these numbers", not "the scene is too slow".
 *
 * Nor does it know what machine it is on. FTP-47 (`bench/RIG.md`) is still
 * waiting on the owner, so nothing here claims to be the reference rig; the
 * report records the machine it actually ran on and leaves the comparison to
 * whoever defines the rig.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { createPlaywrightDriver } from "./src/driver.ts";
import type { BenchReport, CacheState } from "./src/report.ts";
import { type RouteDefinition, parseRoute } from "./src/route.ts";
import { runBench } from "./src/session.ts";
import { buildBenchPage, serveBenchPage } from "./src/site.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, "routes");
const DEFAULT_REPORT_DIR = join(HERE, "reports");

const { values } = parseArgs({
  options: {
    routes: { type: "string" },
    cache: { type: "string", default: "both" },
    "memory-minutes": { type: "string", default: "15" },
    warmup: { type: "string", default: "0" },
    viewport: { type: "string", default: "1920x1080" },
    out: { type: "string", default: DEFAULT_REPORT_DIR },
    headed: { type: "boolean", default: false },
    label: { type: "string", default: "" },
  },
});

function fail(message: string): never {
  console.error(`bench: ${message}`);
  process.exit(2);
}

const cacheStates: CacheState[] =
  values.cache === "both"
    ? ["cold", "warm"]
    : values.cache === "cold" || values.cache === "warm"
      ? [values.cache]
      : fail(`--cache 必須是 cold | warm | both,收到 ${String(values.cache)}`);

const memoryMinutes = Number(values["memory-minutes"]);
if (!Number.isFinite(memoryMinutes) || memoryMinutes < 0) {
  fail(`--memory-minutes 必須是 >= 0 的數字,收到 ${String(values["memory-minutes"])}`);
}
const warmupFrames = Number(values.warmup);
if (!Number.isInteger(warmupFrames) || warmupFrames < 0) {
  fail(`--warmup 必須是 >= 0 的整數,收到 ${String(values.warmup)}`);
}

const viewportMatch = /^(\d+)x(\d+)$/.exec(values.viewport ?? "");
if (viewportMatch === null) fail(`--viewport 必須是 WIDTHxHEIGHT,收到 ${String(values.viewport)}`);
const viewport = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };

async function loadRoutes(): Promise<RouteDefinition[]> {
  const files = (await readdir(ROUTES_DIR)).filter((f) => f.endsWith(".json")).sort();
  const routes: RouteDefinition[] = [];
  for (const file of files) {
    const raw = await readFile(join(ROUTES_DIR, file), "utf8");
    try {
      routes.push(parseRoute(JSON.parse(raw)));
    } catch (cause) {
      // A malformed route file stops the run. Skipping it would produce a
      // report that is missing a route for a reason nobody recorded.
      fail(`路線檔 ${file} 無法解析:${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const wanted = values.routes?.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (wanted === undefined || wanted.length === 0) return routes;
  const selected = routes.filter((r) => wanted.includes(r.id));
  const missing = wanted.filter((id) => !routes.some((r) => r.id === id));
  if (missing.length > 0) fail(`找不到路線:${missing.join("、")}`);
  return selected;
}

function summarise(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  valid: ${report.valid}${report.valid ? "" : ` — ${report.invalidReason ?? ""}`}`);
  lines.push(`  GPU:   ${report.environment.gpuRenderer || "(未知)"}`);
  lines.push(
    `  vsync: frameRateLimitDefeated=${report.environment.frameRateLimitDefeated}` +
      ` (present interval median ${report.environment.presentIntervalMedianMs?.toFixed(2) ?? "?"} ms)`,
  );
  lines.push("");
  lines.push("  route                cache  frames   p50     p95     p99    1%low  hitches");
  for (const route of report.routes) {
    const s = route.summary;
    const cell = (value: number | undefined): string =>
      value === undefined ? "    -  " : value.toFixed(2).padStart(7);
    lines.push(
      `  ${route.routeId.padEnd(20)} ${route.cache.padEnd(6)} ${String(route.framesMeasured).padStart(6)}` +
        `${cell(s?.p50Ms)}${cell(s?.p95Ms)}${cell(s?.p99Ms)}${cell(s?.onePercentLowMs)}` +
        `${String(s?.hitches.length ?? "-").padStart(9)}` +
        (route.valid ? "" : `   << ${route.invalidReason ?? ""}`),
    );
  }
  if (report.memory !== null) {
    lines.push("");
    lines.push(
      `  memory: ${(report.memory.startBytes / 1e6).toFixed(1)} MB → ` +
        `${(report.memory.endBytes / 1e6).toFixed(1)} MB ` +
        `(${(report.memory.growthRatio * 100).toFixed(2)}% over ${(report.memory.durationMs / 60000).toFixed(1)} min)`,
    );
    lines.push(`  GPU memory: ${report.memory.gpuNote}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const routes = await loadRoutes();
  if (routes.length === 0) fail("沒有可跑的路線");

  const workspace = await mkdtemp(join(tmpdir(), "ftp48-bench-"));
  const pageDir = join(workspace, "page");
  const controller = new AbortController();

  // Interruption is a first-class path, not an error path: the report still
  // gets written, and it says of itself that it is partial.
  let interruptions = 0;
  const onSignal = (): void => {
    interruptions += 1;
    if (interruptions === 1) {
      console.log("\nbench: 收到中斷訊號,正在收尾並輸出標記為 invalid 的部分報告…");
      controller.abort();
      return;
    }
    console.log("bench: 再次中斷,立即結束(不會有報告)");
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log("bench: 建置量測頁面…");
  await buildBenchPage(pageDir);
  const site = await serveBenchPage(pageDir);
  console.log(`bench: 量測頁面 ${site.url}`);

  let report: BenchReport;
  try {
    const driver = createPlaywrightDriver({
      baseUrl: site.url,
      profileRoot: join(workspace, "profiles"),
      headed: values.headed ?? false,
      viewport,
      warmupFrames,
      timeoutMs: 600_000,
      onLog: (message) => console.log(message),
    });

    report = await runBench({
      routes,
      cacheStates,
      driver,
      signal: controller.signal,
      memoryMinutes,
      onProgress: (progress) => console.log(`bench: ${progress.message}`),
    });
  } finally {
    await site.close();
    await rm(workspace, { recursive: true, force: true });
  }

  const outDir = values.out ?? DEFAULT_REPORT_DIR;
  await mkdir(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const label = values.label === "" ? "" : `-${values.label}`;
  const file = join(outDir, `bench-${stamp}${label}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(summarise(report));
  console.log(`\nbench: 報告 ${file}`);
  if (!report.valid) {
    console.log("bench: 這份報告標記為 invalid — 數字不可用於判定。");
  }
  console.log(
    "bench: 判定門檻與基線回歸屬 FTP-49;reference rig 規格屬 FTP-47(尚未提供)," +
      "本報告僅陳述「這台機器上的」量測值。",
  );

  // Completion, not performance. See the header.
  return report.valid ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error("bench: 執行失敗", cause);
    process.exit(2);
  },
);
