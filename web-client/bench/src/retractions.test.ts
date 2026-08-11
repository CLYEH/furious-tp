/**
 * Retracted claims must stay retracted — everywhere, not where they were spotted.
 *
 * WHY THIS FILE EXISTS. In round 1 the claim "the run-to-run spread came from
 * GPU contention" was withdrawn: it was removed from the PR body, from
 * gpuload.ts, and from the handoff. It then survived in README.md with a
 * different number ("utilisation swinging 7%-55%"), was shipped, and was found
 * by the verifier after merge.
 *
 * The mechanism matters more than the instance. The finding named the PR body
 * and the code, so I patched the PR body and the code. The retraction covered
 * THE PLACES THAT WERE POINTED AT rather than the claim, and a claim removed
 * from three places out of four is not removed. A promise not to repeat it is
 * the same kind of object as the original claim — unverifiable. So each
 * retraction becomes a test.
 *
 * Both directions are needed:
 *   - forbidden: a withdrawn claim must appear nowhere in the deliverable
 *   - required: a disclosure that only lives in a PR body does not exist for
 *     anyone reading the shipped files, so the ones that were relied on are
 *     pinned present
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything a reader of the shipped harness can see. */
function deliverableFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "reports" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|md|json|html)$/.test(entry.name)) continue;
      // This file quotes the forbidden text in order to forbid it.
      if (entry.name === "retractions.test.ts") continue;
      files.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(BENCH);
  return files;
}

/**
 * A disclaimer has to be able to name the claim it disclaims.
 *
 * The first version of this guard flagged `不得據此主張…離散來自競用` in
 * gpuload.ts and `它不是「近空場景基線」` in the README — both of which are the
 * CORRECTION, not the claim. A check that fires on the correct sentence is one
 * somebody eventually switches off, so a line carrying a negation is not a
 * violation. `assertsClaim` below has its own control cases.
 */
const NEGATIONS = ["不得", "不是", "不能", "沒有", "並非", "未", "撤回", "withdrawn", "must not", "NOT"];

export function assertsClaim(line: string, fragment: string): boolean {
  if (!line.includes(fragment)) return false;
  return !NEGATIONS.some((negation) => line.includes(negation));
}

interface Retraction {
  /** What was claimed, and why it was withdrawn. */
  claim: string;
  /** Literal fragments that assert it. */
  fragments: string[];
}

const RETRACTIONS: Retraction[] = [
  {
    claim:
      "AC1's failure was conditional on GPU contention. Withdrawn: nvidia-smi on a " +
      "consumer card has no per-process utilisation, and the figures quoted were total " +
      "GPU utilisation sampled while our OWN Chrome was rendering. Measured idle with the " +
      "same three applications resident: flat 0%.",
    fragments: ["受污染條件", "7%–55%", "7%-55%", "median 38", "中位數 38"],
  },
  {
    claim:
      "Foreign GPU load explains the run-to-run spread. Withdrawn for the same reason, " +
      "and gpuload.ts ships the opposite statement in every report.",
    fragments: [
      "外來 GPU 負載的起伏本身就會造成重跑之間的離散",
      "離散來自競用",
      "無法與場景本身的變異區分",
    ],
  },
  {
    claim:
      "offroad-south is a near-empty-scene baseline. Withdrawn: a frozen camera at its " +
      "first waypoint holds 229 ms and pulls 98 MB, and it is one of the heaviest views " +
      "in the repo.",
    fragments: ["近空場景基線"],
  },
  {
    claim:
      "A 5.10 ms p95 spread. Withdrawn: the two reports behind it were deleted by me as " +
      "pre-fix data, so the figure has no surviving evidence.",
    fragments: ["5.10 ms", "5.10ms"],
  },
];

describe("retracted claims do not reappear in the deliverable", () => {
  const files = deliverableFiles();

  it("scans a non-trivial number of files", () => {
    // Guard against the scan silently covering nothing, which would make every
    // assertion below vacuously true.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.path.endsWith("README.md"))).toBe(true);
  });

  it.each(RETRACTIONS.map((r) => [r.claim, r] as const))("%s", (_claim, retraction) => {
    const hits = files.flatMap((file) =>
      file.text
        .split(/\r?\n/)
        .flatMap((line, index) =>
          retraction.fragments
            .filter((fragment) => assertsClaim(line, fragment))
            .map((fragment) => `${file.path}:${index + 1}: ${fragment}`),
        ),
    );
    expect(hits).toEqual([]);
  });
});

/**
 * The detector's own control.
 *
 * Without this, "no violations found" could mean the deliverable is clean OR
 * that the detector stopped detecting — and the second is exactly how a guard
 * rots into decoration.
 */
describe("assertsClaim tells an assertion from a disclaimer", () => {
  it("flags a line that makes the claim", () => {
    expect(assertsClaim("重跑之間的離散來自競用", "離散來自競用")).toBe(true);
    expect(assertsClaim("這是近空場景基線", "近空場景基線")).toBe(true);
  });

  it("does not flag the sentence that withdraws it", () => {
    expect(assertsClaim("不得據此主張重跑之間的離散來自競用。", "離散來自競用")).toBe(false);
    expect(assertsClaim("它不是「近空場景基線」,不得如此閱讀。", "近空場景基線")).toBe(false);
  });

  it("does not flag a line that never mentions it", () => {
    expect(assertsClaim("完全不相關的一行", "離散來自競用")).toBe(false);
  });
});

/**
 * Disclosures that were relied on in review and must therefore live in the
 * shipped files. A statement that exists only in a PR body does not exist for
 * anyone who later reads the harness.
 */
describe("required disclosures are in the deliverable, not only in the PR", () => {
  const readme = readFileSync(join(BENCH, "README.md"), "utf8");

  it("carries the four-run p95 distribution AC1b failed on", () => {
    // These numbers were quoted as the evidence for the AC1 verdict and lived
    // only in the PR body, which a reader of this directory never sees.
    for (const value of ["351.60", "369.50", "398.30", "432.30", "80.70"]) {
      expect(readme).toContain(value);
    }
  });

  it("states that AC1b was not met, without a qualifier", () => {
    expect(readme).toMatch(/AC1b/);
    expect(readme).toMatch(/未達|不成立/);
  });

  it("names page/main.ts as unreachable by the exam, not only driver.ts", () => {
    // The gap was described as "driver.ts" everywhere, while page/main.ts holds
    // the per-frame timing loop that is the ONLY source of the primary series,
    // plus the GPU string the whole rig check rests on.
    expect(readme).toMatch(/page\/main\.ts/);
  });

  it("records that cross-run p95 drift cannot serve as a regression baseline", () => {
    expect(readme).toMatch(/基線|baseline/);
    expect(readme).toMatch(/漂移|drift|離散/);
  });

  it("records the first measured memory growth, with its sample-count caveat", () => {
    expect(readme).toContain("303");
    expect(readme).toMatch(/3 個樣本|三個樣本/);
  });
});
