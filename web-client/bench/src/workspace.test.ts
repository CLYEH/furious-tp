/**
 * Exam for temp-workspace reclamation.
 *
 * The first version destroyed a CONCURRENT run's page directory and then
 * printed the opposite: "1 directory still in use, left for next time", while
 * the running bench's own page directory had already been deleted underneath
 * it. `rm -rf` succeeds on the unlocked files and only fails on the locked
 * profile ones, so a partial deletion reported itself as a skip.
 *
 * A cleanup that says it kept its hands off while actually deleting is worse
 * than no cleanup at all: nothing downstream distrusts a step that claims to
 * have done nothing.
 *
 * Ownership is therefore explicit — a lock file naming the owning PID — rather
 * than inferred from whether deletion happened to fail.
 *
 * Grid — invariant x failure mode x time:
 *   data safety
 *     - a live run's workspace deleted .............. during a concurrent run
 *     - deletion reported as a skip ................. after the attempt
 *   housekeeping
 *     - abandoned workspaces accumulate for ever .... at startup
 *     - an unreadable lock treated as abandoned ..... at startup
 *   permissions / concurrency: the concurrency case IS the point of the file.
 */

import { describe, expect, it } from "vitest";

import { SETUP_GRACE_MS, isReclaimable } from "./workspace.ts";

/** Another process, not this one — the self-owned case is separate below. */
const OTHER = 4242;

describe("isReclaimable", () => {
  it("keeps a workspace whose owner is still running", () => {
    // The bug. Another bench had this open and it was deleted anyway.
    const verdict = isReclaimable({ ownerPid: OTHER, isRunning: (pid) => pid === OTHER });
    expect(verdict.reclaim).toBe(false);
    expect(verdict.reason).toMatch(/使用中|in use/i);
  });

  it("reclaims a workspace whose owner is gone", () => {
    const verdict = isReclaimable({ ownerPid: OTHER, isRunning: () => false });
    expect(verdict.reclaim).toBe(true);
  });

  it("keeps a just-created directory that has not been locked yet", () => {
    // The remaining window: mkdtemp creates the directory, and the lock lands a
    // moment later. A reclaimer arriving in between sees no owner and would
    // delete a workspace that is mid-setup — the same destructive shape as the
    // original bug, only narrower.
    const verdict = isReclaimable({ ownerPid: null, isRunning: () => false, ageMs: 1_000 });
    expect(verdict.reclaim).toBe(false);
    expect(verdict.reason).toMatch(/初始化|setup/i);
  });

  it("reclaims an old unlocked directory once the window has passed", () => {
    const verdict = isReclaimable({
      ownerPid: null,
      isRunning: () => false,
      ageMs: SETUP_GRACE_MS * 2,
    });
    expect(verdict.reclaim).toBe(true);
  });

  it("reclaims a workspace with no lock at all", () => {
    // Written by a version that predates locking, or by a run killed before it
    // could write one. Nothing owns it.
    const verdict = isReclaimable({ ownerPid: null, isRunning: () => true });
    expect(verdict.reclaim).toBe(true);
  });

  it("never reclaims its own workspace", () => {
    // The self-deletion case: the running process IS the owner.
    const verdict = isReclaimable({ ownerPid: process.pid, isRunning: () => true });
    expect(verdict.reclaim).toBe(false);
  });

  it("keeps a workspace when liveness cannot be determined", () => {
    // Unknown ownership must fall back to KEEPING it. Deleting on uncertainty
    // is how the original bug destroyed live data; a stale directory costs
    // disk, a deleted live one costs a run.
    const verdict = isReclaimable({
      ownerPid: 4242,
      isRunning: () => {
        throw new Error("cannot query");
      },
    });
    expect(verdict.reclaim).toBe(false);
    expect(verdict.reason).toMatch(/無法確認|unknown/i);
  });

  it("keeps a workspace whose lock is unreadable rather than assuming it is dead", () => {
    const verdict = isReclaimable({ ownerPid: Number.NaN, isRunning: () => false });
    expect(verdict.reclaim).toBe(false);
  });
});
