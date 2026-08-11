/**
 * Browser entry point. `public/index.html` loads the built bundle and calls
 * `start()`; everything below it is testable without a GPU.
 */

import { bootScene } from "./scene/boot.js";

export { bootScene } from "./scene/boot.js";
export { M1_BBOX_WGS84, INITIAL_CAMERA, isInsideM1Bbox } from "./config/scene.js";
export { NLSC_BUILDING_TILESET_URL } from "./config/nlsc.js";

/** What the e2e harness reads to decide whether the scene really came up. */
export interface SceneProbe {
  ready: boolean;
  tilesetLoaded: boolean;
  /** The tiles for the opening view have arrived — "there is something to see". */
  initialTilesLoaded: boolean;
  allTilesLoaded: boolean;
  framesRendered: number;
  /** Where the camera actually ended up, read back from the renderer. */
  camera: { longitude: number; latitude: number; height: number } | null;
  warnings: string[];
  error: string | null;
}

type ProbeHost = { __ftpScene?: SceneProbe };

export async function start(containerId: string): Promise<void> {
  const probe: SceneProbe = {
    ready: false,
    tilesetLoaded: false,
    initialTilesLoaded: false,
    allTilesLoaded: false,
    framesRendered: 0,
    camera: null,
    warnings: [],
    error: null,
  };
  (globalThis as ProbeHost).__ftpScene = probe;

  const container = document.getElementById(containerId);
  if (!container) {
    probe.error = `找不到場景容器 #${containerId}`;
    probe.ready = true;
    return;
  }

  try {
    const scene = await bootScene(container);
    probe.tilesetLoaded = scene.tileset !== null;
    probe.warnings = scene.warnings;
    scene.widget.scene.postRender.addEventListener(() => {
      probe.framesRendered += 1;
      // Read back rather than echo the config: this is where the camera IS,
      // which is what the screenshot is a picture of.
      const c = scene.widget.camera.positionCartographic;
      probe.camera = {
        longitude: (c.longitude * 180) / Math.PI,
        latitude: (c.latitude * 180) / Math.PI,
        height: c.height,
      };
    });
    if (scene.tileset) {
      scene.tileset.initialTilesLoaded.addEventListener(() => {
        probe.initialTilesLoaded = true;
      });
      scene.tileset.allTilesLoaded.addEventListener(() => {
        probe.allTilesLoaded = true;
      });
    }
  } catch (cause) {
    probe.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    probe.ready = true;
  }
}
