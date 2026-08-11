/**
 * Whether a leftover temp workspace may be deleted.
 *
 * The first version of the reclaimer decided by TRYING: `rm -rf` and treat a
 * failure as "still in use". That destroyed a concurrently running bench's page
 * directory and then reported the opposite — "still in use, left for next
 * time" — because rm succeeds on the unlocked files and only fails on the
 * locked profile ones. A partial deletion reported itself as a skip.
 *
 * A cleanup that claims to have kept its hands off while deleting live data is
 * worse than no cleanup: nothing downstream distrusts a step that says it did
 * nothing. So ownership is now explicit — a lock file naming the owning PID —
 * and the answer is decided BEFORE anything is removed.
 *
 * Every uncertain case keeps the directory. A stale workspace costs disk; a
 * deleted live one costs somebody's twenty-minute run.
 */

export const LOCK_FILE = "owner.pid";

export interface ReclaimQuestion {
  /** PID from the lock file; null when there is no lock, NaN when unreadable. */
  ownerPid: number | null;
  isRunning: (pid: number) => boolean;
  /**
   * How long ago the directory was created, in ms. Optional; when absent an
   * unlocked directory is treated as old.
   *
   * There is an unavoidable window between `mkdtemp` creating the directory and
   * the lock file landing inside it. A concurrent reclaimer arriving in that
   * window sees no owner and would delete a workspace that is mid-setup — the
   * same data-destroying shape as before, just narrower. A directory younger
   * than the grace period is therefore assumed to be someone's setup.
   */
  ageMs?: number;
}

/** Long enough to cover mkdtemp -> writeFile, short enough not to strand debris. */
export const SETUP_GRACE_MS = 30_000;

export interface ReclaimVerdict {
  reclaim: boolean;
  reason: string;
}

export function isReclaimable(question: ReclaimQuestion): ReclaimVerdict {
  const { ownerPid } = question;

  if (ownerPid === null) {
    if (question.ageMs !== undefined && question.ageMs < SETUP_GRACE_MS) {
      // Created moments ago and not yet locked: almost certainly another run
      // between mkdtemp and writing its lock.
      return { reclaim: false, reason: "剛建立且尚未上鎖,可能正在初始化" };
    }
    return { reclaim: true, reason: "沒有 owner 鎖,無人持有" };
  }
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    // A lock we cannot read is not a lock we may ignore.
    return { reclaim: false, reason: "owner 鎖無法解讀,保留" };
  }
  if (ownerPid === process.pid) {
    return { reclaim: false, reason: "這是本次執行自己的工作目錄" };
  }

  let running: boolean;
  try {
    running = question.isRunning(ownerPid);
  } catch {
    return { reclaim: false, reason: `無法確認 PID ${ownerPid} 是否存活,保留` };
  }

  return running
    ? { reclaim: false, reason: `PID ${ownerPid} 仍在執行,使用中` }
    : { reclaim: true, reason: `PID ${ownerPid} 已結束` };
}
