/**
 * Route definitions and the scripted autopilot (RFC D6: "量測路線 = 腳本化
 * autopilot(固定 spline + 固定速度,非人手駕駛)").
 *
 * Two properties carry the whole module:
 *
 *  1. **The path is a pure function of the frame index.** Not of elapsed time.
 *     A wall-clock autopilot flies a shorter route on a slower machine, so the
 *     two runs AC1 compares would have covered different ground — and their p95
 *     values would differ for a reason that has nothing to do with the renderer.
 *     Fixed simulated timestep is what makes "可重播" true rather than hoped for.
 *
 *  2. **Constant speed means constant metres per frame**, which requires
 *     reparameterising the spline by arc length. Sampling the spline parameter
 *     uniformly instead makes the camera crawl where waypoints are dense and
 *     sprint where they are sparse, so the frame times would describe how the
 *     author spaced the file rather than how expensive the scene is.
 *
 * This stage's autopilot is a CAMERA on a spline, not a vehicle. Vehicle physics
 * is FTP-42/43 and road geometry is FTP-33/41; neither exists yet.
 */

export const ROUTE_KINDS = ["dense-buildings", "high-speed-straight", "off-road"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export interface Waypoint {
  readonly longitude: number;
  readonly latitude: number;
  /** Ellipsoidal height in metres, matching src/config/scene.ts. */
  readonly height: number;
  readonly headingDegrees: number;
  readonly pitchDegrees: number;
  readonly rollDegrees: number;
}

export interface RouteDefinition {
  readonly id: string;
  readonly title: string;
  readonly kind: RouteKind;
  readonly description: string;
  readonly durationSeconds: number;
  /** Simulated frames per second. Nothing throttles to this; it sets the path resolution. */
  readonly stepHz: number;
  readonly waypoints: readonly Waypoint[];
}

export interface CameraPose {
  longitude: number;
  latitude: number;
  height: number;
  headingDegrees: number;
  pitchDegrees: number;
  rollDegrees: number;
}

export interface Autopilot {
  readonly frameCount: number;
  readonly totalMetres: number;
  readonly speedMps: number;
  poseAt(frameIndex: number): CameraPose;
}

export class RouteError extends Error {
  override name = "RouteError";
}

const ROUTE_KEYS = [
  "id",
  "title",
  "kind",
  "description",
  "durationSeconds",
  "stepHz",
  "waypoints",
] as const;

const WAYPOINT_KEYS = [
  "longitude",
  "latitude",
  "height",
  "headingDegrees",
  "pitchDegrees",
  "rollDegrees",
] as const;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RouteError(`${what} 必須是物件,收到 ${Array.isArray(value) ? "array" : String(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Unknown keys are rejected, not ignored.
 *
 * `stepHZ: 120` sitting next to a correct `stepHz: 60` is the realistic typo in
 * a hand-written file. Ignoring it means the route runs at a rate the author did
 * not intend and every number it produces is plausible and wrong.
 */
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new RouteError(`${what} 有未知欄位 ${key}(可能是拼錯的欄位名)`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (value === undefined) throw new RouteError(`${what} 缺少 ${key}`);
  if (typeof value !== "string" || value === "") {
    throw new RouteError(`${what} 的 ${key} 必須是非空字串`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, what: string): number {
  const value = record[key];
  if (value === undefined) throw new RouteError(`${what} 缺少 ${key}`);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RouteError(`${what} 的 ${key} 必須是有限數字,收到 ${String(value)}`);
  }
  return value;
}

function requirePositive(record: Record<string, unknown>, key: string, what: string): number {
  const value = requireNumber(record, key, what);
  if (value <= 0) throw new RouteError(`${what} 的 ${key} 必須大於 0,收到 ${value}`);
  return value;
}

function parseWaypoint(value: unknown, index: number): Waypoint {
  const what = `waypoint[${index}]`;
  const record = asRecord(value, what);
  rejectUnknownKeys(record, WAYPOINT_KEYS, what);

  const longitude = requireNumber(record, "longitude", what);
  if (longitude < -180 || longitude > 180) {
    throw new RouteError(`${what} 的 longitude 超出範圍:${longitude}`);
  }
  const latitude = requireNumber(record, "latitude", what);
  if (latitude < -90 || latitude > 90) {
    throw new RouteError(`${what} 的 latitude 超出範圍:${latitude}`);
  }

  return {
    longitude,
    latitude,
    height: requireNumber(record, "height", what),
    headingDegrees: requireNumber(record, "headingDegrees", what),
    pitchDegrees: requireNumber(record, "pitchDegrees", what),
    rollDegrees: requireNumber(record, "rollDegrees", what),
  };
}

export function parseRoute(value: unknown): RouteDefinition {
  const record = asRecord(value, "route");
  rejectUnknownKeys(record, ROUTE_KEYS, "route");

  const id = requireString(record, "id", "route");
  const title = requireString(record, "title", "route");
  const description = requireString(record, "description", "route");

  const kindValue = record["kind"];
  if (kindValue === undefined) throw new RouteError("route 缺少 kind");
  if (typeof kindValue !== "string" || !(ROUTE_KINDS as readonly string[]).includes(kindValue)) {
    throw new RouteError(`route 的 kind 不是已知類型:${String(kindValue)}`);
  }
  const kind = kindValue as RouteKind;

  const durationSeconds = requirePositive(record, "durationSeconds", "route");
  const stepHz = requirePositive(record, "stepHz", "route");

  const rawWaypoints = record["waypoints"];
  if (rawWaypoints === undefined) throw new RouteError("route 缺少 waypoints");
  if (!Array.isArray(rawWaypoints)) {
    throw new RouteError("route 的 waypoints 必須是陣列");
  }
  if (rawWaypoints.length < 2) {
    throw new RouteError(`route 至少需要 2 個 waypoint,收到 ${rawWaypoints.length}`);
  }
  const waypoints = rawWaypoints.map(parseWaypoint);

  // A fractional frame count would leave the last frame half a step short of
  // the end of the spline, making the route's endpoint depend on rounding.
  const steps = durationSeconds * stepHz;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    throw new RouteError(
      `route 的 durationSeconds x stepHz 必須是整數,${durationSeconds} x ${stepHz} = ${steps}`,
    );
  }

  return { id, title, kind, description, durationSeconds, stepHz, waypoints };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
const METRES_PER_DEGREE_LATITUDE = 111_132;

/**
 * Local equirectangular metres about the route's first waypoint.
 *
 * "Constant speed" has to be constant in metres, and a degree of longitude is
 * not a degree of latitude — at Taipei's 25 degrees north it is about 9% shorter.
 * Interpolating raw degrees would make an east-west leg travel slower than a
 * north-south one at the same nominal rate. Good to well under 1% over the few
 * kilometres an M1 route covers, which is far finer than anything downstream.
 */
function projector(origin: Waypoint) {
  const metresPerDegreeLongitude = METRES_PER_DEGREE_LATITUDE * Math.cos(origin.latitude * DEG);
  return {
    toLocal: (wp: Waypoint): Vec3 => ({
      x: (wp.longitude - origin.longitude) * metresPerDegreeLongitude,
      y: (wp.latitude - origin.latitude) * METRES_PER_DEGREE_LATITUDE,
      z: wp.height - origin.height,
    }),
    toGeodetic: (p: Vec3) => ({
      longitude: origin.longitude + p.x / metresPerDegreeLongitude,
      latitude: origin.latitude + p.y / METRES_PER_DEGREE_LATITUDE,
      height: origin.height + p.z,
    }),
  };
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

const lerpVec = (a: Vec3, b: Vec3, f: number): Vec3 => ({
  x: lerp(a.x, b.x, f),
  y: lerp(a.y, b.y, f),
  z: lerp(a.z, b.z, f),
});

const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/**
 * Centripetal Catmull-Rom (Barry-Goldman form, alpha = 0.5).
 *
 * Centripetal rather than uniform because the M1 routes have deliberately
 * uneven waypoint spacing (a tight turn next to a long straight), and uniform
 * Catmull-Rom forms cusps and self-intersections exactly there — which would
 * whip the camera around and put a hitch in the measurement that the scene did
 * not cause.
 */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, f: number): Vec3 {
  // Coincident control points would make a knot span zero and divide by zero.
  // Duplicated endpoints (below) are exactly that case, so it is not defensive.
  const knot = (a: Vec3, b: Vec3): number => Math.max(Math.sqrt(distance(a, b)), 1e-6);

  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = lerp(t1, t2, f);

  const a1 = lerpVec(p0, p1, (t - t0) / (t1 - t0));
  const a2 = lerpVec(p1, p2, (t - t1) / (t2 - t1));
  const a3 = lerpVec(p2, p3, (t - t2) / (t3 - t2));
  const b1 = lerpVec(a1, a2, (t - t0) / (t2 - t0));
  const b2 = lerpVec(a2, a3, (t - t1) / (t3 - t1));
  return lerpVec(b1, b2, (t - t1) / (t2 - t1));
}

/** Shortest way around the circle: 350 -> 10 is +20 degrees, not -340. */
function lerpAngleDegrees(a: number, b: number, f: number): number {
  const delta = (((b - a + 540) % 360) - 180);
  return normaliseDegrees(a + delta * f);
}

const normaliseDegrees = (value: number): number => ((value % 360) + 360) % 360;

/** Spline samples per segment used to build the arc-length table. */
const ARC_SAMPLES_PER_SEGMENT = 1024;

export function createAutopilot(route: RouteDefinition): Autopilot {
  const origin = route.waypoints[0]!;
  const { toLocal, toGeodetic } = projector(origin);
  const points = route.waypoints.map(toLocal);
  const segmentCount = points.length - 1;

  // Endpoints are duplicated so the first and last segments have the
  // neighbours the formula needs; the curve then starts and ends exactly on
  // the first and last waypoint.
  const control = (index: number): Vec3 => points[Math.min(Math.max(index, 0), points.length - 1)]!;

  /** Position at spline parameter u, where integer u is a waypoint index. */
  const positionAtU = (u: number): Vec3 => {
    const segment = Math.min(Math.max(Math.floor(u), 0), segmentCount - 1);
    const f = u - segment;
    return catmullRom(
      control(segment - 1),
      control(segment),
      control(segment + 1),
      control(segment + 2),
      f,
    );
  };

  // Arc-length table: cumulative distance along the curve at uniformly spaced
  // parameter values. This is what turns "uniform in u" into "uniform in metres".
  const sampleCount = segmentCount * ARC_SAMPLES_PER_SEGMENT;
  const cumulative = new Float64Array(sampleCount + 1);
  let previous = positionAtU(0);
  for (let k = 1; k <= sampleCount; k++) {
    const point = positionAtU((k / sampleCount) * segmentCount);
    cumulative[k] = cumulative[k - 1]! + distance(previous, point);
    previous = point;
  }
  const totalMetres = cumulative[sampleCount]!;
  if (!(totalMetres > 0)) {
    throw new RouteError(`route ${route.id} 的長度為 0,所有 waypoint 重疊`);
  }

  /** Invert the table: the parameter u at which `metres` have been travelled. */
  const uAtDistance = (metres: number): number => {
    if (metres <= 0) return 0;
    if (metres >= totalMetres) return segmentCount;
    let low = 0;
    let high = sampleCount;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (cumulative[mid]! <= metres) low = mid;
      else high = mid;
    }
    const spanStart = cumulative[low]!;
    const spanEnd = cumulative[high]!;
    const withinSpan = spanEnd > spanStart ? (metres - spanStart) / (spanEnd - spanStart) : 0;
    return ((low + withinSpan) / sampleCount) * segmentCount;
  };

  const frameCount = Math.round(route.durationSeconds * route.stepHz) + 1;

  return {
    frameCount,
    totalMetres,
    speedMps: totalMetres / route.durationSeconds,
    poseAt(frameIndex: number): CameraPose {
      if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) {
        throw new RangeError(
          `poseAt: frameIndex 必須是 0..${frameCount - 1} 的整數,收到 ${String(frameIndex)}`,
        );
      }

      // The only thing the pose depends on. No clock, no cursor, no previous
      // call — which is the whole of property 1 in the header.
      const progress = frameIndex / (frameCount - 1);
      const u = uAtDistance(totalMetres * progress);
      const geodetic = toGeodetic(positionAtU(u));

      const segment = Math.min(Math.max(Math.floor(u), 0), segmentCount - 1);
      const f = u - segment;
      const from = route.waypoints[segment]!;
      const to = route.waypoints[segment + 1]!;

      return {
        ...geodetic,
        // Heading wraps; pitch is bounded to [-90, 90] and roll is held near
        // zero by every route this milestone ships, so neither needs the
        // shortest-arc treatment and both read more predictably without it.
        headingDegrees: lerpAngleDegrees(from.headingDegrees, to.headingDegrees, f),
        pitchDegrees: lerp(from.pitchDegrees, to.pitchDegrees, f),
        rollDegrees: lerp(from.rollDegrees, to.rollDegrees, f),
      };
    },
  };
}
