import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import { distanceMetres, LATITUDE, LONGITUDE } from './patrol-rules';

/**
 * A route's geofence (ADR 0056): where a patrol of it stays. A circle, or
 * a simple polygon of 3 to 50 vertices (`[lat, lng]`, not closed: the last
 * vertex joins the first). A route version keeps it, as everything else it
 * asks.
 */
export type Geofence =
  | { circle: { lat: number; lng: number; radiusM: number } }
  | { polygon: [number, number][] };

export const GEOFENCE_RADIUS_M = { min: 10, max: 5000 } as const;
export const GEOFENCE_VERTICES = { min: 3, max: 50 } as const;

/**
 * A point less precise than this says nothing about the fence: it neither
 * opens an exit nor closes one.
 */
export const GEOFENCE_MAX_ACCURACY_M = 100;

const inRange = (v: unknown, r: { min: number; max: number }) =>
  typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max;

/**
 * Checks a geofence as given, with its field errors under `prefix`; the
 * fence normalized, or null with errors pushed. Exactly one of a circle
 * and a polygon; a polygon whose edges cross, or with no area, is refused
 * (INVALID_VALUE).
 */
export function checkGeofence(
  input: { circle?: unknown; polygon?: unknown },
  fields: FieldError[],
  prefix: string,
): Geofence | null {
  const before = fields.length;
  const hasCircle = input.circle !== undefined && input.circle !== null;
  const hasPolygon = input.polygon !== undefined && input.polygon !== null;
  if (hasCircle === hasPolygon) {
    fields.push({
      field: `${prefix}.circle`,
      code: hasCircle
        ? FieldErrorCode.FIELD_NOT_ALLOWED
        : FieldErrorCode.FIELD_REQUIRED,
    });
    return null;
  }
  if (hasCircle) {
    const c = input.circle as {
      lat?: unknown;
      lng?: unknown;
      radiusM?: unknown;
    };
    if (!inRange(c.lat, LATITUDE))
      fields.push({
        field: `${prefix}.circle.lat`,
        code: FieldErrorCode.INVALID_NUMBER,
        params: { ...LATITUDE },
      });
    if (!inRange(c.lng, LONGITUDE))
      fields.push({
        field: `${prefix}.circle.lng`,
        code: FieldErrorCode.INVALID_NUMBER,
        params: { ...LONGITUDE },
      });
    if (!inRange(c.radiusM, GEOFENCE_RADIUS_M) || !Number.isInteger(c.radiusM))
      fields.push({
        field: `${prefix}.circle.radiusM`,
        code: FieldErrorCode.INVALID_NUMBER,
        params: { ...GEOFENCE_RADIUS_M },
      });
    if (fields.length > before) return null;
    return {
      circle: {
        lat: c.lat as number,
        lng: c.lng as number,
        radiusM: c.radiusM as number,
      },
    };
  }
  const field = `${prefix}.polygon`;
  const p = input.polygon;
  if (
    !Array.isArray(p) ||
    p.length < GEOFENCE_VERTICES.min ||
    p.length > GEOFENCE_VERTICES.max
  ) {
    fields.push({
      field,
      code: FieldErrorCode.INVALID_LENGTH,
      params: { ...GEOFENCE_VERTICES },
    });
    return null;
  }
  const vertices = p as unknown[];
  if (
    !vertices.every(
      (v) =>
        Array.isArray(v) &&
        v.length === 2 &&
        inRange(v[0], LATITUDE) &&
        inRange(v[1], LONGITUDE),
    )
  ) {
    fields.push({ field, code: FieldErrorCode.INVALID_FORMAT });
    return null;
  }
  const polygon = (vertices as [number, number][]).map(
    ([lat, lng]) => [lat, lng] as [number, number],
  );
  if (!isSimple(project(polygon))) {
    fields.push({ field, code: FieldErrorCode.INVALID_VALUE });
    return null;
  }
  return { polygon };
}

/** A stored geofence as the database holds it; null for none or unreadable. */
export function geofenceOf(value: unknown): Geofence | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { circle?: unknown; polygon?: unknown };
  if (v.circle && typeof v.circle === 'object')
    return {
      circle: v.circle as { lat: number; lng: number; radiusM: number },
    };
  if (Array.isArray(v.polygon))
    return { polygon: v.polygon as [number, number][] };
  return null;
}

/**
 * How far outside the fence a position is, in whole metres: 0 on or
 * inside it. A polygon is measured on a plane around its first vertex —
 * exact enough at a compound's size.
 */
export function metresOutside(
  fence: Geofence,
  at: { lat: number; lng: number },
): number {
  if ('circle' in fence)
    return Math.max(0, distanceMetres(fence.circle, at) - fence.circle.radiusM);
  const origin = fence.polygon[0];
  const ring = project(fence.polygon, origin);
  const [x, y] = toPlane(origin, [at.lat, at.lng]);
  if (contains(ring, x, y)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    best = Math.min(best, segmentDistance(x, y, a, b));
  }
  return Math.round(best);
}

/**
 * Whether a point is outside the fence: further out than its accuracy.
 * Null when it is too imprecise to say (GEOFENCE_MAX_ACCURACY_M).
 */
export function isOutside(
  fence: Geofence,
  p: { lat: number; lng: number; accuracyM: number | null },
): boolean | null {
  const accuracy = p.accuracyM ?? 0;
  if (accuracy > GEOFENCE_MAX_ACCURACY_M) return null;
  return metresOutside(fence, p) > accuracy;
}

/** An exit as the walk sees it: when it began, and when it ended if it did. */
export interface ExitSpan {
  leftAt: Date;
  backAt: Date | null;
  /** The latest point of it outside: how long it is known to last. */
  lastOutsideAt: Date;
}

/**
 * Walks a run's new points, in time order, from where the last walk left
 * off (its open exit, if any): an outside point opens an exit, the next
 * inside point closes it; a point that says nothing is passed over. The
 * exits it touched, in order: the one it continued, closed or not, then
 * those it opened.
 */
export function walkExits(
  open: { leftAt: Date } | null,
  points: readonly { at: Date; outside: boolean | null }[],
): ExitSpan[] {
  const touched: ExitSpan[] = [];
  let current: ExitSpan | null = open
    ? { leftAt: open.leftAt, backAt: null, lastOutsideAt: open.leftAt }
    : null;
  if (current) touched.push(current);
  for (const p of points) {
    if (p.outside === null) continue;
    if (p.outside) {
      if (!current) {
        current = { leftAt: p.at, backAt: null, lastOutsideAt: p.at };
        touched.push(current);
      } else current.lastOutsideAt = p.at;
    } else if (current) {
      current.backAt = p.at;
      current = null;
    }
  }
  return touched;
}

/**
 * Whether an exit lasted the threshold: to its return when it came back,
 * else to its latest point outside. The sweep measures an open one to now
 * instead (or to the run's end).
 */
export const exitLasted = (e: ExitSpan, thresholdMs: number): boolean =>
  (e.backAt ?? e.lastOutsideAt).getTime() - e.leftAt.getTime() >= thresholdMs;

// ----------------------------------------------------------------------------
// A plane around a vertex
// ----------------------------------------------------------------------------

type XY = [number, number];
const M_PER_DEG = 111_320;

function toPlane(origin: [number, number], [lat, lng]: [number, number]): XY {
  const cos = Math.cos((origin[0] * Math.PI) / 180);
  return [(lng - origin[1]) * M_PER_DEG * cos, (lat - origin[0]) * M_PER_DEG];
}

function project(
  polygon: [number, number][],
  origin: [number, number] = polygon[0],
): XY[] {
  return polygon.map((v) => toPlane(origin, v));
}

/** Even–odd ray casting; a point on an edge counts as inside. */
function contains(ring: XY[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (segmentDistance(x, y, ring[i], ring[j]) < 1e-6) return true;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function segmentDistance(x: number, y: number, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t =
    len === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

const cross = (o: XY, a: XY, b: XY) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Two segments that meet, ends included. */
function meet(a: XY, b: XY, c: XY, d: XY): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  )
    return true;
  const on = (p: XY, q: XY, r: XY) =>
    cross(p, q, r) === 0 &&
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1]);
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

/** No two edges cross or touch, but neighbours at their shared vertex; some area. */
function isSimple(ring: XY[]): boolean {
  const n = ring.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) / 2 < 1) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const neighbours = j === i + 1 || (i === 0 && j === n - 1);
      if (neighbours) continue;
      if (meet(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]))
        return false;
    }
  return true;
}
