/**
 * Who else was on the GPU while this ran.
 *
 * `rig.ts` answers "which GPU". This answers the other half of D6's measurement
 * conditions — "無其他 GPU 負載" — which nothing in this repo answered
 * automatically before: it lived only in RIG.md's manual preflight, and a manual
 * step is not a check.
 *
 * Why it is recorded rather than enforced:
 *
 *   Foreign GPU load VARIES BETWEEN RUNS, and run-to-run variance is exactly
 *   what AC1 measures. A "p95 is not reproducible" result taken under contention
 *   is indistinguishable from one caused by the scene — the two produce the same
 *   observation. Only the report can tell them apart, and only if it says which
 *   conditions applied.
 *
 *   Aborting on contention would discard completed data. The rule here is the
 *   same as for an interrupted run: label, never discard. Deciding whether a
 *   contended batch is usable belongs to the reader and to FTP-49.
 */

export interface GpuProcess {
  pid: number | null;
  name: string;
}

export interface ExternalGpuLoad {
  /** False when the query could not run at all — never confuse that with "clean". */
  supported: boolean;
  /** True/false when known, null when unmeasurable. */
  contended: boolean | null;
  utilizationPctAtStart: number | null;
  utilizationPctAtEnd: number | null;
  foreignProcesses: GpuProcess[];
  note: string;
}

/** What the environment carries when the query never ran. Not "clean" — "unknown". */
export const UNMEASURED_GPU_LOAD: ExternalGpuLoad = {
  supported: false,
  contended: null,
  utilizationPctAtStart: null,
  utilizationPctAtEnd: null,
  foreignProcesses: [],
  note: "未查詢 GPU 佔用,本次是否有其他 GPU 負載未知 —— 不等於沒有負載。",
};

export interface GpuLoadSample {
  utilisationStart: string | null;
  utilisationEnd: string | null;
  /** Raw `nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader`. */
  computeApps: string | null;
  /** PIDs belonging to this harness's own browser. */
  ourPids: readonly number[];
}

/** Process paths come from the OS and land in a file other people open. */
const MAX_NAME_CHARS = 200;
const boundedName = (name: string): string =>
  name.length <= MAX_NAME_CHARS ? name : `${name.slice(0, MAX_NAME_CHARS)}…(共 ${name.length} 字元)`;

/**
 * On every Windows machine with a screen, the desktop compositor is on the GPU.
 * Counting it as contention would mark every run contended, and a flag that is
 * always true teaches the reader to ignore it.
 */
const IGNORED_PROCESSES = ["dwm.exe"];

function parsePercent(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw.trim().replace(/\s*%$/, ""));
  return Number.isFinite(value) ? value : null;
}

/** `12345, C:\path\to\thing.exe` — pid and basename, or null pid when unreadable. */
function parseProcessLine(line: string): GpuProcess | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const comma = trimmed.indexOf(",");
  const pidText = comma === -1 ? "" : trimmed.slice(0, comma).trim();
  const rest = comma === -1 ? trimmed : trimmed.slice(comma + 1).trim();
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
  // Basename, so the report carries "brave.exe" rather than a full install path.
  const name = rest.split(/[\\/]/).pop() ?? rest;
  return { pid, name: boundedName(name === "" ? rest : name) };
}

export function summariseGpuLoad(sample: GpuLoadSample): ExternalGpuLoad {
  if (sample.computeApps === null) {
    // No tool, no list — which is NOT the same as an empty list. Reporting
    // "clean" here would be a clean bill of health issued by a check that never
    // ran, the same failure shape as a zero with no control.
    return {
      supported: false,
      contended: null,
      utilizationPctAtStart: parsePercent(sample.utilisationStart),
      utilizationPctAtEnd: parsePercent(sample.utilisationEnd),
      foreignProcesses: [],
      note: "無法查詢 GPU 佔用(nvidia-smi 不可用),本次是否有其他 GPU 負載未知 —— 不等於沒有負載。",
    };
  }

  const ours = new Set(sample.ourPids);
  const foreignProcesses = sample.computeApps
    .split(/\r?\n/)
    .map(parseProcessLine)
    .filter((process): process is GpuProcess => process !== null)
    .filter((process) => !(process.pid !== null && ours.has(process.pid)))
    .filter((process) => !IGNORED_PROCESSES.includes(process.name.toLowerCase()));

  const contended = foreignProcesses.length > 0;
  return {
    supported: true,
    contended,
    utilizationPctAtStart: parsePercent(sample.utilisationStart),
    utilizationPctAtEnd: parsePercent(sample.utilisationEnd),
    foreignProcesses,
    note: contended
      ? `量測期間有其他程序共用同一顆 GPU(${foreignProcesses
          .map((p) => p.name)
          .join("、")})。D6 要求「無其他 GPU 負載」,本批數字不滿足該條件,重跑之間的離散無法與場景本身的變異區分。`
      : "量測期間未偵測到其他程序共用該 GPU(已排除 dwm 與本 harness 自己的瀏覽器)。",
  };
}
