/**
 * Exam for the external-GPU-load record.
 *
 * D6's measurement conditions include "無其他 GPU 負載". The rig check in rig.ts
 * answers "which GPU", which is a different question from "who else is on it",
 * and nothing in this repo answered the second one — it lived only in RIG.md's
 * manual preflight. That gap is not hypothetical: this ticket's first four runs
 * were taken with Brave and Acrobat sharing the GPU, its utilisation swinging
 * between 7% and 55% within seconds.
 *
 * What it can show, and what it cannot: nvidia-smi on a consumer card gives no
 * per-process utilisation, so this records PRESENCE, never consumption. A report
 * carrying foreign processes does not license "the spread came from contention"
 * — only "these were present, and their effect was not measured".
 *
 * Recording never aborts. Aborting would discard completed data, and this
 * project's rule is label, never discard.
 *
 * Grid — invariant x failure mode x time:
 *   I6 provenance
 *     - a run sharing the GPU looks identical to a clean one ..... at report time
 *     - the harness's own browser counted as foreign load ........ at collection
 *     - the compositor (dwm) counted as foreign load ............. at collection
 *     - nvidia-smi absent reported as "no foreign load" .......... at collection
 *   permissions
 *     - a process the user may not inspect is dropped silently ... at collection
 *   concurrency: N/A — a pure reduction over an already-captured sample.
 */

import { describe, expect, it, vi } from "vitest";

import { collectGpuLoad, createNvidiaSmiIo, summariseGpuLoad } from "./gpuload.ts";

/** Real `nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader` output from this rig. */
const REAL_APPS = [
  "21032, C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "24204, C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "2000, [Insufficient Permissions]",
  "22936, C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe",
  "38744, C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].join("\n");

/** 38744 was this harness's own browser on that run. */
const OUR_PIDS = [38744];

describe("summariseGpuLoad", () => {
  it("reports the foreign processes sharing the GPU", () => {
    const load = summariseGpuLoad({
      utilisationStart: "39",
      utilisationEnd: "22",
      computeApps: REAL_APPS,
      ourPids: OUR_PIDS,
    });
    expect(load.supported).toBe(true);
    expect(load.utilizationPctAtStart).toBe(39);
    expect(load.utilizationPctAtEnd).toBe(22);
    const names = load.foreignProcesses.map((p) => p.name);
    expect(names).toContain("brave.exe");
    expect(names).toContain("Acrobat.exe");
  });

  it("does not count the harness's own browser as foreign load", () => {
    // The control that matters: without this the harness raises the flag on
    // every run including a perfectly clean rig, and the signal is worth
    // nothing.
    const load = summariseGpuLoad({
      utilisationStart: "12",
      utilisationEnd: "10",
      computeApps: REAL_APPS,
      ourPids: OUR_PIDS,
    });
    expect(load.foreignProcesses.map((p) => p.pid)).not.toContain(38744);
  });

  it("reports a clean rig as clean", () => {
    // The other half of the control: our browser alone must produce an empty
    // foreign list, so "shared" and "clean" are actually distinguishable.
    const load = summariseGpuLoad({
      utilisationStart: "8",
      utilisationEnd: "9",
      computeApps: "38744, C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ourPids: OUR_PIDS,
    });
    expect(load.foreignProcesses).toEqual([]);
    expect(load.foreignProcessesPresent).toBe(false);
  });

  it("raises the flag when anything foreign is present", () => {
    const load = summariseGpuLoad({
      utilisationStart: "39",
      utilisationEnd: "22",
      computeApps: REAL_APPS,
      ourPids: OUR_PIDS,
    });
    expect(load.foreignProcessesPresent).toBe(true);
  });

  it("ignores the desktop compositor", () => {
    // dwm.exe is on the GPU on every Windows machine that has a screen.
    // Counting it would raise the flag on every run and train the reader to
    // ignore the field.
    const load = summariseGpuLoad({
      utilisationStart: "5",
      utilisationEnd: "5",
      computeApps: ["1234, C:\\Windows\\System32\\dwm.exe", "38744, chrome.exe"].join("\n"),
      ourPids: OUR_PIDS,
    });
    expect(load.foreignProcesses).toEqual([]);
    expect(load.foreignProcessesPresent).toBe(false);
  });

  /**
   * The defect RIG.md 2.1 had already fixed, and which this module reintroduced
   * one commit later.
   *
   * A non-elevated nvidia-smi prints "[Insufficient Permissions]" instead of a
   * name, and on this rig the PID behind that string is dwm. Filtering the
   * ignore-list BY NAME therefore never matched it, so `foreignProcessesPresent` came out
   * true on every run — including runs where the GPU measured a flat 0%.
   *
   * RIG.md's own wording for this shape: a check that no machine state can pass
   * is worse than no check. Here it is worse still — `foreignProcessesPresent` is the sole
   * evidence for AC1's qualifier, so permanently true means the qualifier can
   * never be lifted and AC1 can never be adjudicated at all.
   */
  it("excludes dwm even when nvidia-smi refuses to name it", () => {
    const load = summariseGpuLoad({
      utilisationStart: "0",
      utilisationEnd: "0",
      computeApps: "2000, [Insufficient Permissions]",
      ourPids: [],
      resolvedNames: { 2000: "dwm" },
    });
    expect(load.foreignProcesses).toEqual([]);
    expect(load.foreignProcessesPresent).toBe(false);
  });

  it("excludes our own browser even when nvidia-smi refuses to name it", () => {
    // The same masking with a different victim: our own Chrome behind the
    // permissions string would otherwise be counted as somebody else's load.
    const load = summariseGpuLoad({
      utilisationStart: "0",
      utilisationEnd: "0",
      computeApps: "38744, [Insufficient Permissions]",
      ourPids: [38744],
      resolvedNames: { 38744: "chrome" },
    });
    expect(load.foreignProcesses).toEqual([]);
    expect(load.foreignProcessesPresent).toBe(false);
  });

  it("still reports a genuinely foreign process that had to be resolved", () => {
    // The control: resolution must not become a blanket exclusion. Without this
    // case, "resolve then drop everything" would pass the two cases above.
    const load = summariseGpuLoad({
      utilisationStart: "0",
      utilisationEnd: "0",
      computeApps: ["2000, [Insufficient Permissions]", "21032, [Insufficient Permissions]"].join(
        "\n",
      ),
      ourPids: [],
      resolvedNames: { 2000: "dwm", 21032: "brave" },
    });
    expect(load.foreignProcesses.map((p) => p.name)).toEqual(["brave"]);
    expect(load.foreignProcessesPresent).toBe(true);
  });

  it("keeps a process it was not allowed to inspect, rather than dropping it", () => {
    // "[Insufficient Permissions]" is a real row on this rig. When the PID
    // cannot be resolved either, it is something on the GPU whose identity is
    // unknown — which is not the same as nothing, and must not be discarded.
    const load = summariseGpuLoad({
      utilisationStart: "39",
      utilisationEnd: "22",
      computeApps: "2000, [Insufficient Permissions]",
      ourPids: OUR_PIDS,
    });
    expect(load.foreignProcesses).toHaveLength(1);
    expect(load.foreignProcesses[0]?.name).toMatch(/Insufficient Permissions|unknown/i);
    expect(load.foreignProcessesPresent).toBe(true);
  });

  it("says it could not measure when nvidia-smi is unavailable", () => {
    // The dangerous shape: no tool, no processes listed, therefore "no foreign
    // load" — a clean bill of health issued by a check that never ran.
    const load = summariseGpuLoad({ utilisationStart: null, utilisationEnd: null, computeApps: null, ourPids: [] });
    expect(load.supported).toBe(false);
    expect(load.foreignProcessesPresent).toBeNull();
    expect(load.utilizationPctAtStart).toBeNull();
    expect(load.note).not.toBe("");
  });

  it("survives output it cannot parse without claiming the rig was clean", () => {
    const load = summariseGpuLoad({
      utilisationStart: "not-a-number",
      utilisationEnd: "",
      computeApps: "@@@ garbage @@@",
      ourPids: [],
    });
    expect(load.utilizationPctAtStart).toBeNull();
    // A line it cannot parse is still evidence that SOMETHING was listed.
    expect(load.foreignProcessesPresent).not.toBe(false);
  });

  it("bounds the process names it copies into the report", () => {
    /**
     * Same rule as everywhere else: a process name comes from the OS and the
     * report is a file other people open.
     *
     * The long part has to be the LAST path segment. Mutation testing caught
     * the first version of this case asserting nothing at all: it used a long
     * PATH ending in "evil.exe", and since only the basename is kept the result
     * was eight characters whether or not the bound existed — deleting the
     * truncation left this test green.
     */
    const longBasename = `${"A".repeat(5000)}.exe`;
    const load = summariseGpuLoad({
      utilisationStart: "1",
      utilisationEnd: "1",
      computeApps: `999, C:\\Program Files\\${longBasename}`,
      ourPids: [],
    });
    expect(load.foreignProcesses[0]!.name.length).toBeLessThan(300);
  });

  it("handles an empty process list as genuinely empty", () => {
    const load = summariseGpuLoad({
      utilisationStart: "3",
      utilisationEnd: "4",
      computeApps: "",
      ourPids: [],
    });
    expect(load.supported).toBe(true);
    expect(load.foreignProcesses).toEqual([]);
    expect(load.foreignProcessesPresent).toBe(false);
  });
});

/**
 * The WIRING, not just the reduction.
 *
 * `summariseGpuLoad` is well covered — five mutants inside it, all killed. The
 * hole was one level up, in the driver nobody can test: passing
 * `resolvedNames: {}` at the call site silently undoes the entire dwm fix and
 * restores the permanently-true contention flag, and that mutant SURVIVED.
 *
 * So the collection is a seam with its I/O injected. What still needs a browser
 * (launchPersistentContext, CDP) stays unexamined on purpose; this does not.
 */
describe("collectGpuLoad", () => {
  const io = () => ({
    utilisation: vi.fn(() => "7"),
    computeApps: vi.fn(
      () => "2000, [Insufficient Permissions]\n21032, [Insufficient Permissions]",
    ),
    resolveNames: vi.fn((pids: readonly number[]) =>
      Object.fromEntries(pids.map((pid) => [pid, pid === 2000 ? "dwm" : "brave"])),
    ),
    ourPids: vi.fn(() => [] as number[]),
  });

  it("resolves the PIDs it found before deciding anything", () => {
    // The mutant that survived: dropping this call. Without resolution dwm
    // stays in the list as "[Insufficient Permissions]" and the flag is true on
    // every machine forever.
    const deps = io();
    const load = collectGpuLoad(deps);
    expect(deps.resolveNames).toHaveBeenCalledTimes(1);
    expect(deps.resolveNames.mock.calls[0]?.[0]).toEqual([2000, 21032]);
    expect(load.foreignProcesses.map((p) => p.name)).toEqual(["brave"]);
    expect(load.foreignProcessesPresent).toBe(true);
  });

  it("reports a genuinely clean rig as clean", () => {
    // The other half of the control. Without it, "resolve then drop everything"
    // would satisfy the case above.
    const deps = { ...io(), computeApps: vi.fn(() => "2000, [Insufficient Permissions]") };
    const load = collectGpuLoad(deps);
    expect(load.foreignProcesses).toEqual([]);
    expect(load.foreignProcessesPresent).toBe(false);
  });

  it("excludes our own browser by PID", () => {
    const deps = { ...io(), ourPids: vi.fn(() => [21032]) };
    const load = collectGpuLoad(deps);
    expect(load.foreignProcesses).toEqual([]);
  });

  it("says it could not measure when the tool is missing", () => {
    const deps = { ...io(), computeApps: vi.fn(() => null), utilisation: vi.fn(() => null) };
    const load = collectGpuLoad(deps);
    expect(load.supported).toBe(false);
    expect(load.foreignProcessesPresent).toBeNull();
    // Resolution is pointless with no list, and must not be invented.
    expect(deps.resolveNames).not.toHaveBeenCalled();
  });

  it("survives a resolver that fails without claiming the rig was clean", () => {
    const deps = {
      ...io(),
      resolveNames: vi.fn(() => {
        throw new Error("Get-Process exploded");
      }),
    };
    const load = collectGpuLoad(deps);
    // Unresolved occupants stay in the list as unknowns rather than vanishing.
    expect(load.foreignProcessesPresent).toBe(true);
    expect(load.foreignProcesses.length).toBeGreaterThan(0);
  });
});

describe("createNvidiaSmiIo", () => {
  it("asks nvidia-smi for the process list and passes the resolver through", () => {
    // Guards the wiring the driver used to hold inline, where a one-line
    // `resolveNames: () => ({})` reverted B2 with nothing to catch it.
    const run = vi.fn((_cmd: string, args: string[]) =>
      args[0]?.includes("compute-apps") === true ? "2000, [Insufficient Permissions]" : "5",
    );
    const resolveNames = vi.fn(() => ({ 2000: "dwm" }));
    const load = collectGpuLoad(createNvidiaSmiIo(run, () => [], resolveNames));

    expect(run).toHaveBeenCalledWith("nvidia-smi", [
      "--query-compute-apps=pid,process_name",
      "--format=csv,noheader",
    ]);
    expect(resolveNames).toHaveBeenCalledWith([2000]);
    // dwm resolved and excluded: the whole point of B2, end to end.
    expect(load.foreignProcessesPresent).toBe(false);
    expect(load.utilizationPctAtStart).toBe(5);
  });

  it("reports unsupported when the tool is absent", () => {
    const load = collectGpuLoad(createNvidiaSmiIo(() => null, () => [], () => ({})));
    expect(load.supported).toBe(false);
    expect(load.foreignProcessesPresent).toBeNull();
  });
});
