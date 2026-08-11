/**
 * The Playwright driver — the one piece that needs a GPU, and therefore the one
 * piece the exam cannot reach. Everything decidable was pushed out of here into
 * session.ts / report.ts / stats.ts on purpose.
 *
 * Cold and warm are real, not labels: a cache state is a browser profile
 * directory. Cold deletes the route's profile before launching, so the HTTP
 * cache starts empty; warm relaunches on the profile the cold pass just filled.
 *
 * KNOWN LIMIT, and it belongs in the report rather than in a footnote: FTP-5
 * measured that the NLSC service forbids caching of its tileset, so a "warm"
 * run is warm in the bundle, the Cesium assets and whatever tiles the service
 * did allow to be cached — not in the whole scene. The difference between the
 * two states here is smaller than the words suggest.
 */

import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { cpus, release, type as osType } from "node:os";
import { join } from "node:path";

import { type BrowserContext, type Page, chromium } from "@playwright/test";

import type { BenchPageEnvironment, BenchPagePower, BenchPose } from "../page/main.ts";
import { UNMEASURED_GPU_LOAD, summariseGpuLoad } from "./gpuload.ts";
import type { MemorySample } from "./memory.ts";
import type { BenchEnvironment, RouteMeasurement } from "./report.ts";
import { type RouteDefinition, createAutopilot } from "./route.ts";
import type {
  BenchDriver,
  MemoryCycleRequest,
  MemoryCycleResult,
  RouteRequest,
} from "./session.ts";

/**
 * Asks Chrome to stop pacing frames to the display.
 *
 * Kept because they cost nothing and help where they work — but NEVER trusted:
 * the environment block records the frame rate limit as MEASURED by the page,
 * and on this machine these flags do not in fact remove the cap. Reporting
 * "vsync disabled" because the flag was passed would be a claim about an
 * intention, not about the run.
 */
const BASE_CHROME_ARGS = [
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  // Without this `performance.memory` is bucketed to 5 MB; the memory cycle
  // reads through CDP instead, but the page's own fallback should not lie.
  "--enable-precise-memory-info",
];

/**
 * Moving Chrome onto the discrete GPU.
 *
 * MEASURED on the reference rig (FTP-47): `chrome.exe` has GpuPreference=0, so
 * Windows chooses, and Windows chooses the Intel UHD. Without an explicit flag
 * the whole bench runs on the integrated GPU — and a 16.6 ms budget or D1's
 * "base overhead > 6 ms, replace the renderer" trigger judged against iGPU
 * numbers would recommend throwing away the rendering engine over a GPU that
 * should never have been in the measurement.
 *
 * Both spellings are passed: Chromium has carried the underscore form and the
 * hyphen form at different times, and passing an unknown switch is free.
 */
const HIGH_PERFORMANCE_GPU_ARGS = [
  "--force-high-performance-gpu",
  "--force_high_performance_gpu",
];

/**
 * `"auto"` deliberately omits the flags above so Chrome falls back to Windows'
 * choice. It exists to be the NEGATIVE CONTROL: on this rig it really does land
 * on the Intel UHD, so it proves the renderer assertion rejects the failure this
 * machine actually produces — which a synthetic string cannot.
 */
export type GpuPreference = "high-performance" | "auto";

export interface PlaywrightDriverOptions {
  baseUrl: string;
  /** Where per-route browser profiles live; a cache state is a directory. */
  profileRoot: string;
  headed: boolean;
  viewport: { width: number; height: number };
  /** Frames rendered but not recorded at the start of a route. Recorded in the report. */
  warmupFrames: number;
  timeoutMs: number;
  gpuPreference: GpuPreference;
  onLog?: (message: string) => void;
}

interface HeapUsage {
  usedSize: number;
}

const MEASUREMENT_NOTE =
  "主序列 frameTimesMs = 手動驅動 render loop 下 widget.render() 的主執行緒耗時(不含 GPU 非同步執行);" +
  "次序列 presentIntervalsMs = 相鄰呈現幀的間隔(受顯示更新率限制)。";


/**
 * Reads a command's stdout, or null if it is not there.
 *
 * `shell: false` and an absolute-ish command name on purpose: a shelled command
 * on this machine resolves through WSL and fails for everything, which would
 * make "no foreign GPU load" the answer to every query — a clean bill of health
 * from a check that never ran.
 */
function tryRun(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      shell: false,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const gpuUtilisationNow = (): string | null =>
  tryRun("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]);

/**
 * Resolve the PIDs on the GPU to names ourselves, rather than trusting the
 * names nvidia-smi printed.
 *
 * Without elevation it prints "[Insufficient Permissions]" instead of a name,
 * and on this rig the PID behind that is dwm — so filtering on what it printed
 * raised the foreign-process flag on every run, including runs where the GPU
 * measured a flat 0%.
 * RIG.md 2.1 prescribes exactly this: take the PID, resolve it separately,
 * then decide.
 */
function resolveProcessNames(pids: readonly number[]): Record<number, string> {
  if (pids.length === 0) return {};
  const script =
    `@(${pids.join(",")}) | ForEach-Object { ` +
    "$p = Get-Process -Id $_ -ErrorAction SilentlyContinue; " +
    'if ($p) { "$_=$($p.ProcessName)" } }';
  const out = tryRun("powershell", ["-NoProfile", "-Command", script]);
  if (out === null) return {};
  const resolved: Record<number, string> = {};
  for (const line of out.split(String.fromCharCode(10))) {
    const [pidText, name] = line.trim().split("=");
    const pid = Number(pidText);
    // An unresolvable PID is left ABSENT rather than defaulted to something
    // harmless: "we could not tell" must stay distinguishable from "it was fine".
    if (Number.isInteger(pid) && name !== undefined && name !== "") resolved[pid] = name;
  }
  return resolved;
}

/** The PIDs nvidia-smi says are on the GPU, whatever it managed to call them. */
function gpuProcessPids(computeApps: string | null): number[] {
  if (computeApps === null) return [];
  return computeApps
    .split(String.fromCharCode(10))
    .map((line) => Number(line.split(",")[0]?.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * PIDs of the browsers this harness itself started, so they are not counted as
 * foreign load. Found by profile directory, which is unique to this run.
 */
function ourBrowserPids(profileRoot: string): number[] {
  // Single quotes are the only metacharacter that matters inside a PowerShell
  // single-quoted string; a temp path cannot contain one, so doubling it is
  // cheap insurance rather than a live concern.
  const needle = profileRoot.replace(/'/g, "''");
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
    `Where-Object { $_.CommandLine -like '*${needle}*' } | ` +
    "ForEach-Object { $_.ProcessId }";
  const out = tryRun("powershell", ["-NoProfile", "-Command", script]);
  if (out === null) return [];
  return out
    .split(String.fromCharCode(10))
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function createPlaywrightDriver(options: PlaywrightDriverOptions): BenchDriver {
  const profileFor = (routeId: string): string => join(options.profileRoot, routeId);

  const launchArgs = [
    ...BASE_CHROME_ARGS,
    ...(options.gpuPreference === "high-performance" ? HIGH_PERFORMANCE_GPU_ARGS : []),
  ];

  async function withPage<T>(
    userDataDir: string,
    body: (page: Page, context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: !options.headed,
      viewport: options.viewport,
      deviceScaleFactor: 1,
      args: launchArgs,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(options.timeoutMs);
      await page.goto(options.baseUrl, { waitUntil: "load", timeout: options.timeoutMs });
      await page.waitForFunction(() => globalThis.__ftpBench?.ready === true, undefined, {
        timeout: options.timeoutMs,
      });
      const error = await page.evaluate(() => globalThis.__ftpBench?.error ?? null);
      if (error !== null) throw new Error(`bench page 啟動失敗:${error}`);
      return await body(page, context);
    } finally {
      await context.close();
    }
  }

  const readPageEnvironment = (page: Page): Promise<BenchPageEnvironment> =>
    page.evaluate(() => globalThis.__ftpBench!.environment());

  function nodeEnvironment(page: BenchPageEnvironment): BenchEnvironment {
    return {
      cpu: cpus()[0]?.model ?? "",
      gpuRenderer: page.gpuRenderer,
      browser: page.browser,
      chromeVersion: page.chromeVersion,
      launchArgs,
      os: `${osType()} ${release()}`,
      viewport: page.viewport,
      headless: !options.headed,
      screen: page.screen,
      power: page.power,
      frameRateLimitDefeated: page.frameRateLimitDefeated,
      measurementNote: MEASUREMENT_NOTE,
      presentIntervalMedianMs: page.presentIntervalMedianMs,
      // Overridden by readEnvironment, which samples it while our browser is up.
      externalGpuLoad: UNMEASURED_GPU_LOAD,
    };
  }

  /** Poses are computed in Node, by the same tested autopilot, then handed over. */
  function posesFor(route: RouteDefinition): BenchPose[] {
    const autopilot = createAutopilot(route);
    const poses: BenchPose[] = [];
    for (let i = 0; i < autopilot.frameCount; i++) poses.push(autopilot.poseAt(i));
    return poses;
  }

  return {
    readEnvironment(): Promise<BenchEnvironment> {
      return withPage(join(options.profileRoot, "__environment"), async (page) => {
        // Sampled while our own browser is up, so its PIDs can be excluded and
        // whatever remains is genuinely somebody else.
        const computeApps = tryRun("nvidia-smi", [
          "--query-compute-apps=pid,process_name",
          "--format=csv,noheader",
        ]);
        const load = summariseGpuLoad({
          utilisationStart: gpuUtilisationNow(),
          utilisationEnd: null,
          computeApps,
          ourPids: ourBrowserPids(options.profileRoot),
          resolvedNames: resolveProcessNames(gpuProcessPids(computeApps)),
        });
        return { ...nodeEnvironment(await readPageEnvironment(page)), externalGpuLoad: load };
      });
    },

    readGpuUtilisationNow(): Promise<string | null> {
      return Promise.resolve(gpuUtilisationNow());
    },

    async runRoute(request: RouteRequest): Promise<RouteMeasurement> {
      const userDataDir = profileFor(request.route.id);
      if (request.cache === "cold") {
        // The definition of cold: no profile, therefore no HTTP cache.
        await rm(userDataDir, { recursive: true, force: true });
      }

      const autopilot = createAutopilot(request.route);
      const poses: BenchPose[] = [];
      for (let i = 0; i < autopilot.frameCount; i++) poses.push(autopilot.poseAt(i));
      const startedAt = new Date().toISOString();
      options.onLog?.(
        `  ${request.route.id}(${request.cache}):${poses.length} frames、` +
          `${autopilot.speedMps.toFixed(1)} m/s`,
      );

      const result = await withPage(userDataDir, (page) =>
        page.evaluate(
          ([posesArg, warmupArg]) => globalThis.__ftpBench!.runPoses(posesArg, warmupArg),
          [poses, options.warmupFrames] as const,
        ),
      );

      return {
        routeId: request.route.id,
        routeKind: request.route.kind,
        cache: request.cache,
        frameTimesMs: result.frameTimesMs,
        presentIntervalsMs: result.presentIntervalsMs,
        startedAt,
        finishedAt: new Date().toISOString(),
        framesExpected: poses.length - options.warmupFrames,
        framesMeasured: result.framesMeasured,
      };
    },

    async runMemoryCycle(request: MemoryCycleRequest): Promise<MemoryCycleResult> {
      const totalMs = request.minutes * 60_000;
      const samples: MemorySample[] = [];
      const startedAt = new Date().toISOString();
      let power: BenchPagePower | null = null;

      await withPage(join(options.profileRoot, "__memory"), async (page, context) => {
        const cdp = await context.newCDPSession(page);
        const started = Date.now();
        const readPower = (): Promise<BenchPagePower> =>
          page.evaluate(async () => (await globalThis.__ftpBench!.environment()).power);
        const powerAtStart = await readPower();

        // Read through CDP rather than `performance.memory`: the forced GC D6
        // asks for ("強制 GC 後") is only reachable from the protocol, and a
        // heap read without it measures garbage that has not been collected yet
        // rather than memory that is actually retained.
        const sample = async (): Promise<void> => {
          await cdp.send("HeapProfiler.collectGarbage");
          const usage = (await cdp.send("Runtime.getHeapUsage")) as unknown as HeapUsage;
          samples.push({ atMs: Date.now() - started, usedHeapBytes: usage.usedSize });
        };

        await sample();
        while (Date.now() - started < totalMs && !request.signal.aborted) {
          for (const route of request.routes) {
            if (Date.now() - started >= totalMs || request.signal.aborted) break;
            await page.evaluate(
              ([posesArg]) => globalThis.__ftpBench!.runPoses(posesArg, 0),
              [posesFor(route)] as const,
            );
            await sample();
            options.onLog?.(
              `  記憶體循環 ${Math.round((Date.now() - started) / 1000)}s / ${request.minutes * 60}s`,
            );
          }
        }
        await sample();

        // Read again at the end: a laptop unplugged half way through the cycle
        // is a different experiment from one that was on mains throughout, and
        // the growth figure would silently mix the two.
        const powerAtEnd = await readPower();
        power =
          powerAtStart.charging === powerAtEnd.charging
            ? powerAtStart
            : {
                ...powerAtEnd,
                note: `${powerAtEnd.note};電源狀態在循環中變動(起始 charging=${String(powerAtStart.charging)})`,
              };
      });

      return {
        samples,
        context: { startedAt, finishedAt: new Date().toISOString(), power },
      };
    },

    close(): Promise<void> {
      // Every context is closed by `withPage`'s finally, so there is no browser
      // left to shut down here. Kept because the interface promises it and a
      // later driver that pools contexts will need it.
      return Promise.resolve();
    },
  };
}
