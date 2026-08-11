/**
 * Who else was on the GPU while this ran.
 *
 * `rig.ts` answers "which GPU". This answers the other half of D6's measurement
 * conditions — "無其他 GPU 負載" — which nothing in this repo answered
 * automatically before: it lived only in RIG.md's manual preflight, and a manual
 * step is not a check.
 *
 * WHAT THIS CAN AND CANNOT SHOW — read this before quoting the field.
 *
 *   nvidia-smi on a consumer card reports NO per-process utilisation. So this
 *   records that other processes were RESIDENT on the GPU. It does not show
 *   that they consumed any of it, and it does not show that they contended
 *   with the measurement. Total `utilization.gpu` cannot close the gap either:
 *   sampled while our own browser is rendering, it is dominated by us.
 *
 *   Therefore a report carrying foreign processes does NOT license "the
 *   run-to-run spread came from contention". It licenses exactly "these
 *   processes were present, and their effect was not measured". Using the
 *   stronger sentence to excuse a failing reproducibility result would be the
 *   mirror image of reporting a fail as a pass — and this ticket did that once
 *   already, which is why the wording is pinned here.
 *
 *   Recorded, never enforced: aborting would discard completed data, and the
 *   rule is label, never discard. Whether a batch is usable belongs to the
 *   reader and to FTP-49.
 *
 * ONE DELIBERATE DIFFERENCE FROM RIG.md 2.1's preflight, so it is not read as
 * drift: that check does NOT exempt chrome, because it runs BEFORE bench starts
 * and any Chrome on the GPU then is the operator's own browsing. This one runs
 * DURING the measurement, when our browser is legitimately on the GPU, so it
 * exempts exactly the PIDs launched under our own profile directory — and
 * nothing else. Everything else follows 2.1: resolve the PID with Get-Process
 * rather than trusting nvidia-smi's name, and exempt only dwm.
 */

export interface GpuProcess {
  pid: number | null;
  name: string;
}

export interface ExternalGpuLoad {
  /** False when the query could not run at all — never confuse that with "clean". */
  supported: boolean;
  /**
   * Were any processes other than ours and the compositor resident on this GPU?
   * null when it could not be queried at all.
   *
   * Deliberately NOT called "contended": presence is what is observable, and
   * consumption is not.
   */
  foreignProcessesPresent: boolean | null;
  utilizationPctAtStart: number | null;
  utilizationPctAtEnd: number | null;
  foreignProcesses: GpuProcess[];
  note: string;
}

/** What the environment carries when the query never ran. Not "clean" — "unknown". */
export const UNMEASURED_GPU_LOAD: ExternalGpuLoad = {
  supported: false,
  foreignProcessesPresent: null,
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
  /**
   * PID to process name, resolved independently of nvidia-smi.
   *
   * Load-bearing, not decorative. A non-elevated nvidia-smi prints
   * "[Insufficient Permissions]" instead of a name, and on this rig the PID
   * behind that string is dwm. Matching the ignore-list against the PRINTED
   * name therefore never matched it, so `foreignProcessesPresent` came out true on every
   * run — including runs where the GPU measured a flat 0%.
   *
   * That is the defect RIG.md 2.1 had fixed one commit earlier, reintroduced
   * here. Its own wording applies: a check no machine state can pass is worse
   * than no check — and worse still here, because `foreignProcessesPresent` is the sole
   * evidence for AC1's qualifier, so permanently true means the qualifier can
   * never be lifted and AC1 can never be adjudicated.
   */
  resolvedNames?: Readonly<Record<number, string>>;
}

/** Process paths come from the OS and land in a file other people open. */
const MAX_NAME_CHARS = 200;
const boundedName = (name: string): string =>
  name.length <= MAX_NAME_CHARS ? name : `${name.slice(0, MAX_NAME_CHARS)}…(共 ${name.length} 字元)`;

/**
 * On every Windows machine with a screen, the desktop compositor is on the GPU.
 * Counting it would raise the foreign-process flag on every run, and a flag
 * that is always true teaches the reader to ignore it.
 */
const IGNORED_PROCESSES = ["dwm"];

/**
 * Compared without the .exe suffix, because the two sources spell it
 * differently: nvidia-smi prints "dwm.exe", PowerShell's resolver returns "dwm".
 * Matching only one spelling is how this check silently stopped matching.
 */
const isIgnored = (name: string): boolean =>
  IGNORED_PROCESSES.includes(name.toLowerCase().replace(/\.exe$/, ""));

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

/**
 * Prefer the independently resolved name over whatever nvidia-smi printed.
 *
 * Applied to every row rather than only the unnamed ones: identity is a
 * property of the PID, and the resolver is the more trustworthy source.
 */
function identify(
  process: GpuProcess,
  resolved: Readonly<Record<number, string>> | undefined,
): GpuProcess {
  if (process.pid === null) return process;
  const name = resolved?.[process.pid];
  if (name === undefined || name === "") return process;
  return { pid: process.pid, name: boundedName(name) };
}

export function summariseGpuLoad(sample: GpuLoadSample): ExternalGpuLoad {
  if (sample.computeApps === null) {
    // No tool, no list — which is NOT the same as an empty list. Reporting
    // "clean" here would be a clean bill of health issued by a check that never
    // ran, the same failure shape as a zero with no control.
    return {
      supported: false,
      foreignProcessesPresent: null,
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
    // Identify BEFORE filtering. Filtering on whatever nvidia-smi printed is
    // precisely what let dwm through as "[Insufficient Permissions]".
    .map((process) => identify(process, sample.resolvedNames))
    .filter((process) => !(process.pid !== null && ours.has(process.pid)))
    .filter((process) => !isIgnored(process.name));

  const foreignProcessesPresent = foreignProcesses.length > 0;
  return {
    supported: true,
    foreignProcessesPresent,
    utilizationPctAtStart: parsePercent(sample.utilisationStart),
    utilizationPctAtEnd: parsePercent(sample.utilisationEnd),
    foreignProcesses,
    note: foreignProcessesPresent
      ? `量測期間有其他程序**常駐**於同一顆 GPU(${foreignProcesses
          .map((p) => p.name)
          .join("、")})。消費級顯卡的 nvidia-smi 不提供 per-process 利用率,` +
        `因此**它們是否真的造成競用並未被量到** —— 本欄位陳述「有誰在場」,不是「它們吃掉多少」。` +
        `不得據此主張重跑之間的離散來自競用。`
      : "量測期間未偵測到其他程序常駐於該 GPU(已以 PID 反查排除 dwm 與本 harness 自己的瀏覽器)。",
  };
}
