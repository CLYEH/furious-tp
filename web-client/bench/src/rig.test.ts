/**
 * Exam for the reference-rig GPU check.
 *
 * The reference rig (FTP-47, owner-ruled) is a HYBRID GRAPHICS laptop: an
 * RTX 4060 and an Intel UHD, and which one Chrome ends up on varies with power
 * state, which display the window is on, and Windows' per-application graphics
 * preference. The same bench differs several-fold between them.
 *
 * So a frame-time file that does not say which GPU produced it is not a
 * measurement — it is a number labelled RTX that may have come from the iGPU.
 * This module is the thing that refuses to let that happen quietly.
 *
 * Grid — invariant x failure mode x time:
 *   I6 provenance
 *     - the run silently lands on the integrated GPU ..... at launch
 *     - the renderer string is missing entirely .......... at read time
 *     - a different discrete GPU passes as the rig ....... at check time
 *     - the rejection reason echoes an unbounded string .. at report time
 *   permissions / concurrency: N/A — a pure string check.
 */

import { describe, expect, it } from "vitest";

import { REFERENCE_RIG, checkRigGpu } from "./rig.ts";

/** Exactly what Chrome reports on the reference rig, copied from a real run. */
const RTX_4060 =
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)";

/** The other GPU in the same laptop — the failure this whole module exists for. */
const INTEL_UHD =
  "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A788) Direct3D11 vs_5_0 ps_5_0, D3D11)";

/** What a headless run without GPU access falls back to. */
const SWIFTSHADER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

describe("checkRigGpu", () => {
  it("accepts the reference rig's discrete GPU", () => {
    const result = checkRigGpu(RTX_4060);
    expect(result.accepted).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("rejects the integrated GPU in the same laptop", () => {
    // The control this ticket was told to provide: proof the assertion bites,
    // not merely that a good string passes.
    const result = checkRigGpu(INTEL_UHD);
    expect(result.accepted).toBe(false);
    expect(result.reason).not.toBeNull();
  });

  it("rejects a software rasteriser", () => {
    expect(checkRigGpu(SWIFTSHADER).accepted).toBe(false);
  });

  it("rejects a different discrete NVIDIA card", () => {
    // "NVIDIA" is not the check — being THE rig's GPU is. A 3060 would produce
    // perfectly plausible numbers against thresholds tuned for a 4060.
    const other =
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002520) Direct3D11 vs_5_0 ps_5_0, D3D11)";
    expect(checkRigGpu(other).accepted).toBe(false);
  });

  it("rejects an empty renderer string", () => {
    // "We could not tell" must never read the same as "it was fine".
    const result = checkRigGpu("");
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/未取得|empty|unknown/i);
  });

  it("says what it found as well as what it wanted", () => {
    const result = checkRigGpu(INTEL_UHD);
    expect(result.reason).toContain(REFERENCE_RIG.label);
    expect(result.reason).toMatch(/Intel/);
  });

  it("bounds the renderer string it quotes back", () => {
    // The renderer string comes from the driver. Project rule: never echo an
    // unbounded upstream string into an artefact.
    const result = checkRigGpu("X".repeat(20_000));
    expect(result.accepted).toBe(false);
    expect(result.reason!.length).toBeLessThan(500);
  });

  it("can be pointed at a different rig without editing the module", () => {
    // FTP-47 owns RIG.md. When the rig changes, the expectation is data.
    const other = { label: "Test GPU", gpuPattern: /Test GPU/ };
    expect(checkRigGpu("Test GPU", other).accepted).toBe(true);
    expect(checkRigGpu(RTX_4060, other).accepted).toBe(false);
  });
});
