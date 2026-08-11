/**
 * The one piece of UI this ticket ships: the warning flag.
 *
 * The ticket's Out of Scope excludes UI "告警旗標除外" — this is that exception
 * and nothing more. FTP-45 owns the real degradation layer.
 */

export const STATUS_ELEMENT_ID = "scene-status";

export interface SceneStatus {
  tilesetLoaded: boolean;
  warnings: string[];
}

export function statusText(status: SceneStatus): string {
  const head = status.tilesetLoaded ? "NLSC 建物已載入" : "降級模式:無 NLSC 建物";
  if (status.warnings.length === 0) return head;
  return [head, ...status.warnings].join(" · ");
}

export interface StatusTracker {
  readonly warnings: string[];
  setTilesetLoaded(loaded: boolean): void;
  warn(message: string): void;
}

/**
 * Holds the two halves of the status so they cannot drift apart.
 *
 * They did drift: the first version re-rendered every warning with
 * `tilesetLoaded: false` hardcoded, so a fingerprint alert arriving after a
 * successful load flipped a scene full of buildings to "降級模式:無 NLSC 建物".
 * `statusText` was right the whole time and had a case pinning exactly that —
 * the bug was in the caller, which is why the state now lives in here with it.
 */
export function createStatusTracker(render: (text: string) => void): StatusTracker {
  const warnings: string[] = [];
  let tilesetLoaded = false;
  const emit = (): void => render(statusText({ tilesetLoaded, warnings }));
  return {
    warnings,
    setTilesetLoaded(loaded) {
      tilesetLoaded = loaded;
      emit();
    },
    warn(message) {
      warnings.push(message);
      emit();
    },
  };
}
