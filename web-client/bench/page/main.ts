/**
 * The page under measurement.
 *
 * It boots the SAME scene the product boots — `bootScene` from src/scene/boot.ts,
 * whose header says FTP-48/49 measure exactly what it builds — and then takes
 * the render loop away from Cesium so the bench can time individual frames.
 *
 * Why the loop is driven by hand:
 *
 *   `useDefaultRenderLoop = false` is the opposite of capping the frame rate.
 *   Cesium's own loop renders inside a requestAnimationFrame callback, and rAF
 *   is paced by the display — measured on this machine at ~17.4 ms whatever the
 *   scene contains. A frame-time series read from those intervals would report
 *   the monitor, so "is the base overhead above 6 ms" (D1) could never be
 *   answered by it. Timing `widget.render()` directly measures the work.
 *
 *   What that number IS: the main-thread cost of producing a frame. What it is
 *   NOT: the GPU's asynchronous execution of that frame, which no browser API
 *   exposes. The report states this, and carries the presented-frame intervals
 *   as a second series so the display cap stays visible rather than being
 *   quietly reported as the frame time.
 *
 * The loop still yields through rAF between frames — a tight synchronous loop
 * would starve the fetch and worker callbacks that stream tiles in, so the
 * scene would never load anything and the bench would measure an empty frame
 * very quickly.
 */

import { Cartesian3, Math as CesiumMath } from "cesium";

import { bootScene } from "../../src/scene/boot.js";

export interface BenchPose {
  longitude: number;
  latitude: number;
  height: number;
  headingDegrees: number;
  pitchDegrees: number;
  rollDegrees: number;
}

export interface BenchRunResult {
  frameTimesMs: number[];
  presentIntervalsMs: number[];
  framesMeasured: number;
  warnings: string[];
}

export interface BenchPagePower {
  charging: boolean | null;
  batteryLevel: number | null;
  note: string;
}

export interface BenchPageEnvironment {
  gpuRenderer: string;
  gpuVendor: string;
  browser: string;
  chromeVersion: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number; estimatedRefreshHz: number };
  power: BenchPagePower;
  devicePixelRatio: number;
  presentIntervalMedianMs: number;
  frameRateLimitDefeated: boolean;
}

export interface BenchApi {
  ready: boolean;
  error: string | null;
  tilesetLoaded: boolean;
  warnings: string[];
  environment(): Promise<BenchPageEnvironment>;
  runPoses(poses: BenchPose[], warmupFrames: number): Promise<BenchRunResult>;
  heapBytes(): number;
}

declare global {
  var __ftpBench: BenchApi | undefined;
}

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * A frame rate is "unlocked" only if it runs far above any display refresh.
 * 4 ms is 250 fps — no panel this harness will meet runs there, so anything
 * below it means the cap is gone.
 */
const UNLOCKED_INTERVAL_MS = 4;

async function measurePresentInterval(samples: number): Promise<number> {
  const intervals: number[] = [];
  let previous = await nextFrame();
  for (let i = 0; i < samples; i++) {
    const now = await nextFrame();
    intervals.push(now - previous);
    previous = now;
  }
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)] ?? 0;
}

function readGpu(): { renderer: string; vendor: string } {
  // A throwaway context: reading the debug extension off the scene's own
  // context is possible but this must also work if the scene failed to boot,
  // and the answer is a property of the browser, not of the canvas.
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (gl === null) return { renderer: "", vendor: "" };
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (debugInfo === null) {
    return { renderer: String(gl.getParameter(gl.RENDERER)), vendor: String(gl.getParameter(gl.VENDOR)) };
  }
  return {
    renderer: String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)),
    vendor: String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)),
  };
}

interface BatteryLike {
  charging: boolean;
  level: number;
}

/**
 * Mains or battery.
 *
 * The rig is a laptop, and a 15-minute cycle on battery is a different
 * experiment from the same cycle on mains — different clocks, different
 * thermal headroom. When the browser will not say, the report says THAT
 * rather than guessing "plugged in".
 */
async function readPower(): Promise<BenchPagePower> {
  const getBattery = (navigator as { getBattery?: () => Promise<BatteryLike> }).getBattery;
  if (typeof getBattery !== "function") {
    return { charging: null, batteryLevel: null, note: "navigator.getBattery() 不存在,電源狀態未知" };
  }
  try {
    const battery = await getBattery.call(navigator);
    return {
      charging: battery.charging,
      batteryLevel: battery.level,
      note: "navigator.getBattery()",
    };
  } catch (cause) {
    return {
      charging: null,
      batteryLevel: null,
      note: `navigator.getBattery() 失敗:${cause instanceof Error ? cause.name : "unknown"}`,
    };
  }
}

/** Chrome's version, from the UA. Empty when it cannot be read rather than guessed. */
function readChromeVersion(): string {
  return /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "";
}

/**
 * The display's frame pacing, measured BEFORE the scene exists.
 *
 * Measured after boot it is not a property of the display at all: the first run
 * of this harness reported a 31.5 ms "refresh interval" because tiles were
 * streaming while it sampled, which then produced an estimated 31.7 Hz for a
 * 144 Hz panel and would have been read as evidence about the monitor. An idle
 * page is the only state in which this number means what it says.
 */
let idlePresentIntervalMs = 0;

async function start(): Promise<void> {
  idlePresentIntervalMs = await measurePresentInterval(60);

  const container = document.getElementById("scene");
  if (container === null) {
    globalThis.__ftpBench = failed("找不到場景容器 #scene");
    return;
  }

  try {
    const scene = await bootScene(container);
    const { widget } = scene;

    // The bench owns the loop from here. Cesium must not also be rendering, or
    // every measured frame would be racing an unmeasured one.
    widget.useDefaultRenderLoop = false;

    globalThis.__ftpBench = {
      ready: true,
      error: null,
      tilesetLoaded: scene.tileset !== null,
      warnings: scene.warnings,

      async environment(): Promise<BenchPageEnvironment> {
        const gpu = readGpu();
        // The idle figure, captured before the scene was built. See above.
        const presentIntervalMedianMs = idlePresentIntervalMs;
        return {
          gpuRenderer: gpu.renderer,
          gpuVendor: gpu.vendor,
          browser: navigator.userAgent,
          chromeVersion: readChromeVersion(),
          viewport: { width: widget.canvas.width, height: widget.canvas.height },
          screen: {
            width: globalThis.screen.width,
            height: globalThis.screen.height,
            // Derived, not read: a page cannot ask the OS for the refresh rate.
            estimatedRefreshHz:
              presentIntervalMedianMs > 0 ? 1000 / presentIntervalMedianMs : 0,
          },
          power: await readPower(),
          devicePixelRatio: globalThis.devicePixelRatio,
          presentIntervalMedianMs,
          // Recorded from a measurement, not from the flags that were passed.
          // The flags that are supposed to defeat vsync do not always work, and
          // a reader has no other way to tell.
          frameRateLimitDefeated: presentIntervalMedianMs < UNLOCKED_INTERVAL_MS,
        };
      },

      async runPoses(poses: BenchPose[], warmupFrames: number): Promise<BenchRunResult> {
        const frameTimesMs: number[] = [];
        const presentIntervalsMs: number[] = [];
        let previousPresent = await nextFrame();

        for (let i = 0; i < poses.length; i++) {
          const pose = poses[i]!;
          widget.camera.setView({
            destination: Cartesian3.fromDegrees(pose.longitude, pose.latitude, pose.height),
            orientation: {
              heading: CesiumMath.toRadians(pose.headingDegrees),
              pitch: CesiumMath.toRadians(pose.pitchDegrees),
              roll: CesiumMath.toRadians(pose.rollDegrees),
            },
          });

          const before = performance.now();
          widget.render();
          const after = performance.now();

          // Yield so the tile requests this frame just issued can actually be
          // answered. It also paces the loop at the display rate, which is what
          // makes `presentIntervalsMs` a presented-frame interval.
          const present = await nextFrame();

          if (i >= warmupFrames) {
            frameTimesMs.push(after - before);
            presentIntervalsMs.push(present - previousPresent);
          }
          previousPresent = present;
        }

        return {
          frameTimesMs,
          presentIntervalsMs,
          framesMeasured: frameTimesMs.length,
          warnings: scene.warnings,
        };
      },

      heapBytes(): number {
        const memory = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
        return memory?.usedJSHeapSize ?? 0;
      },
    };
  } catch (cause) {
    globalThis.__ftpBench = failed(cause instanceof Error ? cause.message : String(cause));
  }
}

function failed(error: string): BenchApi {
  return {
    ready: true,
    error,
    tilesetLoaded: false,
    warnings: [],
    environment: () => Promise.reject(new Error(error)),
    runPoses: () => Promise.reject(new Error(error)),
    heapBytes: () => 0,
  };
}

void start();
