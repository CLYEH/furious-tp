/**
 * The one place the NLSC service is named.
 *
 * FTP-5 (Spike R1) concluded direct streaming: the client talks to the official
 * service, there is no caching proxy and no dynamic backend. Two findings from
 * that spike are load-bearing here and are not free to change casually:
 *
 *  - **Building service code 22, not 0.** Code 0 is the documented Taipei code
 *    but was already serving undecodable content when the spike ran; code 22
 *    ("臺北市建物模型 1.0 版") is the endpoint that was measured end to end.
 *    Code 22 does not appear in the official code table, so it may be withdrawn
 *    without notice — which is the reason this file exists as the single point
 *    of change (FTP-5 R5(a)).
 *  - **The request must stay "simple".** The service answers a CORS preflight
 *    with 405, so any request carrying custom headers is blocked by the browser
 *    before it is sent; and it returns `access-control-allow-origin: *` next to
 *    `access-control-allow-credentials: true`, which a credentialled request
 *    refuses. Hence: no headers, credentials omitted.
 */

export const NLSC_TILES_ORIGIN = "https://3dtiles.nlsc.gov.tw";

/** Building service code. See the note above before changing this. */
export const NLSC_BUILDING_SERVICE_CODE = "22";

export const NLSC_BUILDING_TILESET_URL = `${NLSC_TILES_ORIGIN}/building/tiles3d/${NLSC_BUILDING_SERVICE_CODE}/tileset.json`;

/**
 * Request init for every NLSC call. Deliberately header-free — adding one
 * turns the request into a preflighted request, and the preflight 405s.
 */
export const NLSC_FETCH_INIT: RequestInit = {
  mode: "cors",
  credentials: "omit",
};
