/**
 * Which machine, and specifically which GPU, a measurement came from.
 *
 * The reference rig (FTP-47, owner-ruled) is a hybrid-graphics laptop:
 *
 *   NVIDIA GeForce RTX 4060 Laptop GPU, 8 GB   <- the rig's GPU
 *   Intel UHD Graphics                          <- also present, drives the panel
 *
 * Chrome can end up on either, and which one it picks moves with the power
 * state, which display the window is on, and Windows' per-application graphics
 * preference. The same route differs several-fold between them.
 *
 * That makes the renderer string load-bearing rather than informational: a
 * report that does not pin it is a number labelled RTX that may have come from
 * the iGPU — worse than no report, because it looks usable. So the check below
 * is an assertion, and failing it invalidates the whole report exactly like an
 * interrupted run does.
 *
 * `bench/RIG.md` (FTP-47) is the authority on the rig's specification and is
 * NOT in this ticket's scope. The expectation here is data, so pointing the
 * harness at a different rig does not mean editing this module.
 */

export interface RigExpectation {
  /** Human-readable name, quoted in the rejection so the reader knows what was wanted. */
  label: string;
  /** The renderer string must match this to be accepted. */
  gpuPattern: RegExp;
}

export const REFERENCE_RIG: RigExpectation = {
  label: "NVIDIA GeForce RTX 4060 Laptop GPU",
  // Anchored on the model, not merely on the vendor: an RTX 3060 is also
  // "NVIDIA" and would produce entirely plausible numbers against thresholds
  // that were tuned for a 4060.
  gpuPattern: /NVIDIA[^)]*RTX\s*4060/i,
};

export interface RigGpuCheck {
  accepted: boolean;
  reason: string | null;
}

/** The renderer string comes from the graphics driver, so it is bounded before it is quoted. */
const MAX_RENDERER_CHARS = 200;
const boundedRenderer = (renderer: string): string =>
  renderer.length <= MAX_RENDERER_CHARS
    ? renderer
    : `${renderer.slice(0, MAX_RENDERER_CHARS)}…(共 ${renderer.length} 字元)`;

export function checkRigGpu(
  renderer: string,
  expectation: RigExpectation = REFERENCE_RIG,
): RigGpuCheck {
  if (renderer === "") {
    // "We could not tell" must never read the same as "it was fine".
    return { accepted: false, reason: `未取得 WebGL renderer 字串,無法確認這次是哪顆 GPU 產出的` };
  }
  if (!expectation.gpuPattern.test(renderer)) {
    return {
      accepted: false,
      reason:
        `這次量測不是在 reference rig 的 GPU 上跑的:期望 ${expectation.label},` +
        `實際 ${boundedRenderer(renderer)}`,
    };
  }
  return { accepted: true, reason: null };
}
