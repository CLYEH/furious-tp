/**
 * `npm run bench` — RFC D6's reference-rig local harness.
 *
 * WHAT THIS COMMAND DOES NOT DO: decide whether the numbers are good. RFC D6's
 * thresholds and the regression baseline are FTP-49. The exit code here is
 * about whether the RUN completed, never about performance — an invalid report
 * means "do not read these numbers", not "the scene is too slow".
 *
 * The rig itself is specified by `bench/RIG.md` (FTP-47, owner-ruled), which is
 * NOT this ticket's file. What this harness does is CHECK it: the rig has two
 * GPUs, Chrome lands on the wrong one by default, and a report produced on the
 * Intel UHD is rejected rather than published. `--gpu auto` reproduces that
 * failure on purpose, as the negative control.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { type GpuPreference, createPlaywrightDriver } from "./src/driver.ts";
import type { BenchReport, BenchRunConfig, CacheState } from "./src/report.ts";
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
    // "auto" is the negative control: it omits the high-performance GPU flags,
    // and on this rig Windows then puts Chrome on the Intel UHD, which the
    // report must reject. See driver.ts.
    gpu: { type: "string", default: "high-performance" },
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

const gpuPreference: GpuPreference =
  values.gpu === "high-performance" || values.gpu === "auto"
    ? values.gpu
    : fail(`--gpu 必須是 high-performance | auto,收到 ${String(values.gpu)}`);

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
  lines.push(`  GPU 接受: ${report.gpuAccepted}   flags: ${report.environment.launchArgs.join(" ")}`);
  if (report.config !== null) {
    lines.push(
      `  設定:  routes=${report.config.routeIds.join(",")} cache=${report.config.cacheStates.join(",")}` +
        ` memory=${report.config.memoryMinutes}min warmup=${report.config.warmupFrames}` +
        ` viewport=${report.config.viewport.width}x${report.config.viewport.height} gpu=${report.config.gpuPreference}`,
    );
  }
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

async function reclaimOldWorkspaces(): Promise<void> {
  try {
    const entries = await readdir(tmpdir());
    const stale = entries.filter((name) => name.startsWith("ftp48-bench-"));
    let reclaimed = 0;
    for (const name of stale) {
      const path = join(tmpdir(), name);
      const removed = await rm(path, { recursive: true, force: true })
        .then(() => true)
        .catch(() => false);
      if (removed) reclaimed += 1;
    }
    if (reclaimed > 0) console.log(`bench: 已回收 ${reclaimed} 個先前殘留的暫存目錄`);
    if (stale.length > reclaimed) {
      console.log(`bench: ${stale.length - reclaimed} 個暫存目錄仍被佔用,留待下次回收`);
    }
  } catch {
    // Reclaiming is housekeeping; it must never stop a run from starting.
  }
}

async function main(): Promise<number> {
  const routes = await loadRoutes();
  if (routes.length === 0) fail("沒有可跑的路線");

  // Reclaim what earlier runs could not delete. Cleanup is best effort by
  // design (a locked Chrome profile must never cost us the report), but best
  // effort with no upper bound is a leak: this ticket left a 52 MB profile
  // behind after one EBUSY. Also best effort — a directory still in use by a
  // concurrent run simply stays.
  await reclaimOldWorkspaces();

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
      gpuPreference,
      onLog: (message) => console.log(message),
    });

    // Recorded verbatim, so the report can state the settings it ran under.
    // `npm run bench --cache cold` (no `--`) lets npm swallow the flag entirely
    // — run.ts then sees a legal set of defaults and produces a perfectly
    // normal report for a configuration nobody chose. This is what makes that
    // visible afterwards.
    const config: BenchRunConfig = {
      routeIds: routes.map((r) => r.id),
      cacheStates,
      memoryMinutes,
      warmupFrames,
      viewport,
      gpuPreference,
      headless: !(values.headed ?? false),
    };

    report = await runBench({
      routes,
      cacheStates,
      driver,
      signal: controller.signal,
      memoryMinutes,
      config,
      onProgress: (progress) => console.log(`bench: ${progress.message}`),
    });
  } finally {
    await site.close();
  }

  // The report is written BEFORE the workspace is cleaned up.
  //
  // It used to be the other way round, and a real run was lost to it: Windows
  // still held a lock on Chrome's `first_party_sets.db` a moment after the
  // context closed, `rm` threw EBUSY from the finally block, and a completed
  // twenty-minute measurement went in the bin with nothing written. Tidying up
  // is never allowed to destroy the result it was tidying up after.
  const outDir = values.out ?? DEFAULT_REPORT_DIR;
  await mkdir(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  // The label reaches a filename, so it may not reach out of the directory.
  const label = values.label === "" ? "" : `-${values.label.replace(/[^\w.-]+/g, "_")}`;
  const file = join(outDir, `bench-${stamp}${label}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // Best effort, and loud when it fails: a leftover temp profile costs disk,
  // losing the report costs the run.
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    (cause: unknown) => {
      console.log(
        `bench: 暫存目錄未能清除(${cause instanceof Error ? cause.message : String(cause)}),` +
          `報告已寫出,可手動刪除 ${workspace}`,
      );
    },
  );

  console.log(summarise(report));
  console.log(`\nbench: 報告 ${file}`);
  if (!report.valid) {
    console.log("bench: 這份報告標記為 invalid — 數字不可用於判定。");
  }
  console.log(
    "bench: 判定門檻與基線回歸屬 FTP-49;rig 規格見 bench/RIG.md(FTP-47)。" +
      "本報告陳述量測值,不做判定。",
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
