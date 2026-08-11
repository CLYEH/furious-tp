/**
 * The Cesium scene (RFC D1).
 *
 * Deliberately bare. D1's revert trigger is quantified — "空場景 + NLSC tiles 的
 * 基礎 frame 開銷 > 6ms" — and FTP-48/49 measure exactly what this file builds.
 * So: `CesiumWidget`, not `Viewer` (the ticket's Out of Scope excludes UI, and
 * the widget bar is not part of what D1 is budgeting), no imagery layer, and
 * **nothing that caps or smooths the frame rate** — capping it would make the
 * bench measure the cap instead of the renderer.
 */

import {
  Cartesian3,
  Cesium3DTileset,
  CesiumWidget,
  Color,
  Math as CesiumMath,
} from "cesium";

import { NLSC_BUILDING_TILESET_URL } from "../config/nlsc.js";
import { messageOf } from "../errors.js";
import { INITIAL_CAMERA } from "../config/scene.js";
import {
  type TilesetAlert,
  checkTilesetFingerprint,
  describeAlert,
  localStorageWatchStore,
  memoryWatchStore,
} from "../nlsc/fingerprint.js";
import { STATUS_ELEMENT_ID, createStatusTracker } from "./status.js";
import { loadNlscTileset } from "./tileset.js";

export interface SceneHandle {
  widget: CesiumWidget;
  tileset: Cesium3DTileset | null;
  warnings: string[];
}

/**
 * localStorage is unavailable in some privacy modes, and merely touching it can
 * throw. Falling back keeps the scene alive; the caller is told it happened.
 */
function watchStore(onWarning: (message: string) => void) {
  try {
    const storage = globalThis.localStorage;
    if (storage) return localStorageWatchStore(storage);
  } catch (cause) {
    onWarning(`瀏覽器不提供 localStorage,tileset 指紋改為單次比對:${String(cause)}`);
  }
  return memoryWatchStore();
}

export async function bootScene(container: HTMLElement): Promise<SceneHandle> {
  const statusElement = document.getElementById(STATUS_ELEMENT_ID);
  const status = createStatusTracker((text) => {
    if (statusElement) statusElement.textContent = text;
  });
  const warn = (message: string): void => status.warn(message);

  const widget = new CesiumWidget(container, {
    // No imagery layer: the buildings and the terrain shell are the subject,
    // and an imagery provider would pull in a credentialled third-party
    // service this project does not use.
    baseLayer: false,
  });
  widget.scene.globe.baseColor = Color.fromCssColorString("#3a3f45");

  widget.camera.setView({
    destination: Cartesian3.fromDegrees(
      INITIAL_CAMERA.longitude,
      INITIAL_CAMERA.latitude,
      INITIAL_CAMERA.height,
    ),
    orientation: {
      heading: CesiumMath.toRadians(INITIAL_CAMERA.headingDegrees),
      pitch: CesiumMath.toRadians(INITIAL_CAMERA.pitchDegrees),
      roll: CesiumMath.toRadians(INITIAL_CAMERA.rollDegrees),
    },
  });

  const tileset = await loadNlscTileset(NLSC_BUILDING_TILESET_URL, {
    load: (url) => Cesium3DTileset.fromUrl(url),
    onWarning: warn,
  });
  if (tileset) widget.scene.primitives.add(tileset);
  status.setTilesetLoaded(tileset !== null);

  // D5. Kicked off without blocking the scene: the fingerprint costs one more
  // request for a document the service refuses to let anyone cache, and the
  // frame budget is not going to pay for it.
  //
  // `.catch` rather than `void`: a fire-and-forget promise that can reject is a
  // silent failure channel, and it was one. A malformed stored record threw
  // before either guard inside the check, and `void` turned that into an
  // unhandled rejection nobody saw — on every load of that browser, forever.
  // The shape check upstream handles that particular record; this makes the
  // CLASS of it visible rather than invisible.
  checkTilesetFingerprint({
    url: NLSC_BUILDING_TILESET_URL,
    store: watchStore(warn),
    emit: (alert: TilesetAlert) => {
      warn(describeAlert(alert));
    },
  }).catch((cause: unknown) => {
    warn(`tileset 指紋檢查失敗,本次未執行改版偵測:${messageOf(cause)}`);
  });

  return { widget, tileset, warnings: status.warnings };
}
