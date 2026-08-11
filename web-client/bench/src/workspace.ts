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
}

export interface ReclaimVerdict {
  reclaim: boolean;
  reason: string;
}

export function isReclaimable(question: ReclaimQuestion): ReclaimVerdict {
  const { ownerPid } = question;

  if (ownerPid === null) {
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
