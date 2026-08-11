/**
 * Where the camera starts, and what counts as "the M1 area".
 *
 * The area is not defined here — `contracts/constants/` owns it (FTP-22). These
 * constants are that contract expressed in the units the renderer works in:
 *
 *  - `M1_BBOX_WGS84` is the WGS84 envelope of the contract's EPSG:3826 bbox,
 *    taken from the two corner vectors published in
 *    `contracts/constants/ecef_examples.json`.
 *  - `INITIAL_CAMERA` sits on the contract's 台北101 anchor from
 *    `contracts/constants/m1_area.json` — the densest part of the slice, which
 *    is what the acceptance screenshot needs to show.
 *
 * Both are checked against those files by the unit tests, so a contract change
 * this module has not followed fails rather than drifts.
 */

export interface BboxWgs84 {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export const M1_BBOX_WGS84: BboxWgs84 = {
  west: 121.5498908525,
  south: 25.0145340364,
  east: 121.5847170028,
  north: 25.0459993165,
};

export interface CameraView {
  readonly longitude: number;
  readonly latitude: number;
  /**
   * Ellipsoidal height, metres. Above 台北101 (508 m) so the tower reads as a
   * tower rather than as the thing the camera is buried inside, and low enough
   * that Xinyi fills the frame.
   */
  readonly height: number;
  readonly headingDegrees: number;
  readonly pitchDegrees: number;
  readonly rollDegrees: number;
}

export const INITIAL_CAMERA: CameraView = {
  longitude: 121.564544,
  latitude: 25.033944,
  height: 1200,
  headingDegrees: 20,
  pitchDegrees: -35,
  rollDegrees: 0,
};

/**
 * Edges belong to the box: the M1 area is closed, not half-open.
 *
 * The finiteness guards are redundant today — every comparison below is already
 * false for NaN and for an infinity, and mutation testing confirms removing
 * them changes no result. They stay because that is a property of `>=`/`<=`
 * specifically: the day this becomes a clamp, a distance test or a `Math.min`,
 * the NaN case starts passing silently and nothing else would notice.
 */
export function isInsideM1Bbox(longitude: number, latitude: number): boolean {
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= M1_BBOX_WGS84.west &&
    longitude <= M1_BBOX_WGS84.east &&
    latitude >= M1_BBOX_WGS84.south &&
    latitude <= M1_BBOX_WGS84.north
  );
}
