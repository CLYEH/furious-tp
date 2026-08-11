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

import { KNOWN_LIMITATIONS } from "./report.ts";

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
const NEGATIONS = ["不得", "不是", "不能", "沒有", "並非", "尚未", "未經", "不再", "撤回"];

/**
 * English needs word boundaries. "NOTE" contains "NOT", so every line carrying
 * `MEASUREMENT_NOTE` or `// NOTE:` was exempt from every fragment.
 */
const ENGLISH_NEGATIONS = [/\bnot\b/i, /\bwithdrawn\b/i, /\bno longer\b/i, /\bnever\b/i];

/**
 * Clauses, not lines.
 *
 * A negation anywhere on a line used to exempt the entire line, so
 * `本批離散來自競用,並非場景本身的變異。` passed — the claim is asserted in the
 * first clause and something else is denied in the second. Worse,
 * `routes/03-offroad.json` holds its whole description on ONE line containing
 * the English word "NOT", which made that description immune to every fragment
 * — in the very file the retracted claim originally lived in.
 *
 * `.` only ends a clause when whitespace follows, so "5.10 ms" and "80.70 ms"
 * survive as single tokens and stay matchable.
 */
function clauses(text: string): string[] {
  return text.split(/[。！？；,、\n;]+|\.(?=\s|$)/);
}

export function assertsClaim(line: string, fragment: string): boolean {
  return clauses(line).some((clause) => {
    if (!clause.includes(fragment)) return false;
    if (NEGATIONS.some((negation) => clause.includes(negation))) return false;
    return !ENGLISH_NEGATIONS.some((pattern) => pattern.test(clause));
  });
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

  /**
   * The seven escapes review found, kept as cases.
   *
   * Each one let the claim through for a reason that had nothing to do with the
   * claim: a single-character negation that is idiomatic here, an English
   * substring inside an unrelated word, and a negation sitting in a different
   * clause. A detector whose blind spots are not pinned is a detector that
   * quietly reacquires them.
   */
  it("is not disarmed by a negation in a DIFFERENT clause", () => {
    expect(assertsClaim("本批離散來自競用,並非場景本身的變異。", "離散來自競用")).toBe(true);
  });

  it("is not disarmed by 未 used idiomatically elsewhere on the line", () => {
    // "未達" is this document's ordinary word for "not met"; treating a bare 未
    // as a negation made every line containing it immune.
    expect(assertsClaim("AC1b:未達。本批離散來自競用。", "離散來自競用")).toBe(true);
  });

  it("is not disarmed by NOTE, which merely contains NOT", () => {
    expect(assertsClaim("MEASUREMENT_NOTE: 這是近空場景基線", "近空場景基線")).toBe(true);
    expect(assertsClaim("// NOTE: 重跑之間的離散來自競用", "離散來自競用")).toBe(true);
  });

  it("is not disarmed by a one-line JSON description that says NOT elsewhere", () => {
    // The worst of the seven: routes/03-offroad.json keeps its entire
    // description on one line, and that line contains "NOT", so the whole
    // description was immune — in the file the claim originally lived in.
    const jsonLine =
      '  "description": "It is therefore NOT an empty-scene baseline. 本路線是近空場景基線。",';
    expect(assertsClaim(jsonLine, "近空場景基線")).toBe(true);
  });

  it("still exempts a genuine English disclaimer in its own clause", () => {
    expect(assertsClaim("This is NOT a 近空場景基線", "近空場景基線")).toBe(false);
  });

  it("keeps decimals intact so numeric fragments stay matchable", () => {
    // Splitting on every "." would turn "5.10 ms" into "5" and "10 ms", and the
    // fragment would never match again — a guard that silently stops guarding.
    expect(assertsClaim("量到的全距是 5.10 ms", "5.10 ms")).toBe(true);
  });
});

/**
 * Disclosures that were relied on in review and must therefore live in the
 * shipped files. A statement that exists only in a PR body does not exist for
 * anyone who later reads the harness.
 */
/**
 * Disclosures that were relied on in review and must therefore live in the
 * shipped files.
 *
 * WHY THIS BLOCK WAS REBUILT. Its first version matched fragments independently
 * across the whole document: `/AC1b/` and `/未達|不成立/` as two separate
 * searches. Because `未達` appears three times and `基線` three times, deleting
 * any single statement left the others holding the assertion up, and seven
 * mutants survived — including changing the verdict to "已達成" and, worst,
 * restoring the qualifier as "在受競用的條件下未達".
 *
 * That last one is this ticket's entire defect, reproduced verbatim, with the
 * guard green. The guard was pinning NUMBERS while every incident here has been
 * about A VERDICT AND ITS QUALIFIER. So each disclosure is now located as a
 * single statement and inspected as a unit.
 */
describe("required disclosures are in the deliverable, not only in the PR", () => {
  const readme = readFileSync(join(BENCH, "README.md"), "utf8");

  /** The statements mentioning a topic, one per line, so a verdict can be read whole. */
  const statementsAbout = (text: string, topic: RegExp): string[] =>
    text.split(/\r?\n/).filter((line) => topic.test(line));

  it("carries the four-run p95 distribution AC1b failed on", () => {
    // Quoted in review as the evidence for the verdict, and previously only in
    // the PR body, which a reader of this directory never sees.
    for (const value of ["351.60", "369.50", "398.30", "432.30", "80.70"]) {
      expect(readme).toContain(value);
    }
  });

  it("states AC1b as NOT MET, in one place, with no qualifier attached", () => {
    const verdicts = statementsAbout(readme, /AC1b/);
    expect(verdicts.length).toBeGreaterThan(0);

    // The heading that delivers the verdict, inspected as a unit rather than as
    // two independent greps that each other's copies can satisfy.
    const headline = verdicts.filter((line) => /未達|不成立|已達|成立/.test(line));
    expect(headline).toHaveLength(1);
    expect(headline[0]).toMatch(/未達|不成立/);
    expect(headline[0]).not.toMatch(/已達成/);

    // And no qualifier may creep back onto it. This is the exact sentence shape
    // the ticket had to retract twice.
    expect(headline[0]).not.toMatch(/條件下|競用|污染|contend/i);
  });

  it("says the AC1b figures carry no qualifier at all", () => {
    expect(readme).toMatch(/沒有任何限定條件|無任何限定條件/);
  });

  it("records, exactly once, that cross-run drift cannot be a regression baseline", () => {
    const statements = statementsAbout(readme, /回歸基線/);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/不能|不可/);
  });

  it("names page/main.ts as beyond the exam where the gap is described", () => {
    // The gap was written as "driver.ts" everywhere while page/main.ts — the
    // only source of the primary series and of the GPU string — went unnamed.
    const gap = statementsAbout(readme, /考卷到不了/);
    expect(gap).toHaveLength(1);
    expect(gap[0]).toContain("page/main.ts");
    expect(gap[0]).toContain("driver.ts");
  });

  it("records the first measured memory growth, its route, and its caveat", () => {
    const growth = statementsAbout(readme, /303\.21/);
    expect(growth).toHaveLength(1);
    // RIG.md's rule: a number must be traceable to the conditions that made it.
    // Four offroad-south p95 values sit directly above these, so the route has
    // to be on the number itself.
    expect(readme).toMatch(/xinyi-dense/);
    expect(readme).toMatch(/3 個樣本|三個樣本/);
  });
});

/**
 * The same disclosures, on the report side.
 *
 * Two KNOWN_LIMITATIONS mutants survived because nothing asserted the entries
 * themselves — only that the array was non-empty and mentioned a couple of
 * words. A limitation that ships in every artefact deserves the same treatment
 * as the README.
 */
describe("the report's own limitations cover each disclosed gap", () => {
  const text = KNOWN_LIMITATIONS.join("\n");

  it.each([
    ["the GPU-load flag has never been observed false here", /false/],
    ["the console Ctrl-C wiring is unverified", /Ctrl-C|SIGINT/],
    ["the output cannot adjudicate D1's 6 ms", /6 ms|D1/],
    ["page/main.ts is beyond the exam", /page\/main\.ts/],
    ["readGpu is the single source of the GPU string", /readGpu/],
    ["cross-run drift is not a regression baseline", /回歸基線/],
  ])("states: %s", (_topic, pattern) => {
    expect(text).toMatch(pattern);
  });

  it("keeps one entry per gap rather than one entry mentioning everything", () => {
    // A single paragraph listing all of them would satisfy every case above and
    // then vanish wholesale in one edit.
    expect(KNOWN_LIMITATIONS.length).toBeGreaterThanOrEqual(5);
  });
});
