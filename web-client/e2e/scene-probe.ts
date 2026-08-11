import type { Page } from "@playwright/test";

export interface SceneProbe {
  ready: boolean;
  tilesetLoaded: boolean;
  initialTilesLoaded: boolean;
  allTilesLoaded: boolean;
  framesRendered: number;
  camera: { longitude: number; latitude: number; height: number } | null;
  warnings: string[];
  error: string | null;
}

type ProbeHost = { __ftpScene?: SceneProbe };

export async function waitForSceneReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (globalThis as ProbeHost).__ftpScene?.ready === true,
    undefined,
    { timeout: 120_000 },
  );
}

export async function readSceneProbe(page: Page): Promise<SceneProbe> {
  return page.evaluate(() => (globalThis as ProbeHost).__ftpScene as SceneProbe);
}

export interface FrameStats {
  width: number;
  height: number;
  sampled: number;
  distinctColours: number;
  /** Share of sampled pixels that are not the single most common colour. */
  nonDominantShare: number;
}

/**
 * Measures the frame the user actually sees.
 *
 * Via a Playwright screenshot rather than by reading the WebGL canvas back:
 * a WebGL drawing buffer is cleared once it has been composited, so
 * `drawImage(canvas)` outside a render callback yields a blank image unless the
 * context was created with `preserveDrawingBuffer`. Turning that on would slow
 * down the very scene FTP-48/49 exist to measure, so the measurement moves
 * instead of the scene. (This is not hypothetical: reading the canvas directly
 * reported "1 distinct colour" for a frame that was rendering buildings.)
 *
 * Deliberately not a screenshot comparison either. A pixel snapshot that gets
 * regenerated whenever it fails asserts nothing, and one that does not fails on
 * every driver difference. What "the buildings are there" really means is a
 * property: a frame with geometry in it has many colours and no single colour
 * covering nearly all of it. The empty-scene failure has exactly one.
 */
export async function readRenderedFrameStats(page: Page): Promise<FrameStats> {
  const png = await page.screenshot({ type: "png" });
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const off = document.createElement("canvas");
    off.width = bitmap.width;
    off.height = bitmap.height;
    const ctx = off.getContext("2d");
    if (!ctx) throw new Error("no 2d context for sampling");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;

    const counts = new Map<string, number>();
    let sampled = 0;
    // Stride is a prime number of pixels, so the sample cannot line up with
    // repeating structure in the frame.
    for (let i = 0; i < data.length; i += 4 * 37) {
      const key = `${(data[i] ?? 0) >> 3},${(data[i + 1] ?? 0) >> 3},${(data[i + 2] ?? 0) >> 3}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      sampled += 1;
    }
    const dominant = Math.max(...counts.values());
    return {
      width: off.width,
      height: off.height,
      sampled,
      distinctColours: counts.size,
      nonDominantShare: sampled === 0 ? 0 : 1 - dominant / sampled,
    };
  }, dataUrl);
}
