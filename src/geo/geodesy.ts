/**
 * Spherical geodesy helpers. All distances in metres, angles in degrees
 * unless a name says otherwise. Longitudes are kept in [-180, 180).
 *
 * Earth radius: 6 371 008.8 m, the IUGG mean radius.
 */

import { DEG, R_EARTH_M, RAD } from './units';
import { norm360, wrapLon, lonOffset, unwrapLonNear } from './angles';

export { DEG, KTS_TO_MS, R_EARTH_M, RAD } from './units';
export { wrapLon } from './angles';

/** Great-circle distance in metres. */
export function haversineDistanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const la1 = lat1 * DEG;
  const la2 = lat2 * DEG;
  const dlat = la2 - la1;
  const dlon = (lon2 - lon1) * DEG;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Initial bearing in degrees, 0 = north, 90 = east, in [0, 360). */
export function haversineBearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const la1 = lat1 * DEG;
  const la2 = lat2 * DEG;
  const dlon = (lon2 - lon1) * DEG;
  const x = Math.sin(dlon) * Math.cos(la2);
  const y = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlon);
  return norm360(Math.atan2(x, y) * RAD);
}

/**
 * Advance (lon, lat) along a great circle by `distanceM` on `bearingDeg`.
 * Returns [lon, lat] with the longitude wrapped to [-180, 180).
 */
export function projectAlongBearing(lon: number, lat: number, bearingDeg: number, distanceM: number): [number, number] {
  const la1 = lat * DEG;
  const lo1 = lon * DEG;
  const brg = bearingDeg * DEG;
  const ang = distanceM / R_EARTH_M;
  const sinLat1 = Math.sin(la1);
  const cosLat1 = Math.cos(la1);
  const sinAng = Math.sin(ang);
  const cosAng = Math.cos(ang);
  const sinLat2 = Math.max(-1, Math.min(1, sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brg)));
  const lat2 = Math.asin(sinLat2);
  const y = Math.sin(brg) * sinAng * cosLat1;
  const x = cosAng - sinLat1 * sinLat2;
  let lon2 = lo1 + Math.atan2(y, x);
  lon2 = ((((lon2 + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return [lon2 * RAD, lat2 * RAD];
}

/**
 * Signed cross-track offset of a point from the great circle through
 * (refStart → refEnd), metres. Negative = left of the track, positive =
 * right (the standard cross-track formula's sign). Only consistency
 * matters to the caller, which bins by this value.
 */
export function perpendicularOffsetM(sLon: number, sLat: number, eLon: number, eLat: number, lon: number, lat: number): number {
  const bearingRef = haversineBearing(sLon, sLat, eLon, eLat) * DEG;
  const sLatR = sLat * DEG;
  const sLonR = sLon * DEG;
  const pLatR = lat * DEG;
  const pLonR = lon * DEG;
  const dlat = pLatR - sLatR;
  const dlon = pLonR - sLonR;
  const aHav = Math.sin(dlat / 2) ** 2 + Math.cos(sLatR) * Math.cos(pLatR) * Math.sin(dlon / 2) ** 2;
  const d13 = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, aHav))));
  const y = Math.sin(dlon) * Math.cos(pLatR);
  const x = Math.cos(sLatR) * Math.sin(pLatR) - Math.sin(sLatR) * Math.cos(pLatR) * Math.cos(dlon);
  const bearingToPt = Math.atan2(y, x);
  return R_EARTH_M * Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(bearingToPt - bearingRef))));
}

/**
 * Along-track distance from (lon1, lat1), on the great circle towards
 * (lon2, lat2), of the point closest to (pLon, pLat), metres (Aviation
 * Formulary; negative when the point is behind the start).
 */
export function alongTrackDistanceM(lon1: number, lat1: number, lon2: number, lat2: number, pLon: number, pLat: number): number {
  const d1pAng = haversineDistanceM(lon1, lat1, pLon, pLat) / R_EARTH_M;
  const dBrg = (haversineBearing(lon1, lat1, pLon, pLat) - haversineBearing(lon1, lat1, lon2, lat2)) * DEG;
  const xtAng = Math.asin(Math.max(-1, Math.min(1, Math.sin(d1pAng) * Math.sin(dBrg))));
  const cosXt = Math.cos(xtAng);
  if (Math.abs(cosXt) < 1e-12) return 0;
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d1pAng) / cosXt))) * R_EARTH_M;
  return Math.cos(dBrg) < 0 ? -at : at;
}

/**
 * Does the great-circle segment (lon1,lat1)→(lon2,lat2) come within `rM`
 * of (vLon, vLat)? Segment test, not endpoint test: cross-track plus
 * along-track, with the endpoints checked first.
 */
export function segmentWithinDisc(lon1: number, lat1: number, lon2: number, lat2: number, vLon: number, vLat: number, rM: number): boolean {
  const d1 = haversineDistanceM(lon1, lat1, vLon, vLat);
  if (d1 <= rM) return true;
  const d2 = haversineDistanceM(lon2, lat2, vLon, vLat);
  if (d2 <= rM) return true;
  const d12 = haversineDistanceM(lon1, lat1, lon2, lat2);
  if (d12 <= 0) return false;
  const brg12 = haversineBearing(lon1, lat1, lon2, lat2) * DEG;
  const brg1v = haversineBearing(lon1, lat1, vLon, vLat) * DEG;
  const d1vAng = d1 / R_EARTH_M;
  const sinXt = Math.max(-1, Math.min(1, Math.sin(d1vAng) * Math.sin(brg1v - brg12)));
  const dXt = Math.asin(sinXt) * R_EARTH_M;
  if (Math.abs(dXt) > rM) return false;
  if (Math.cos(brg1v - brg12) < 0) return false;
  const cosXtAng = Math.cos(dXt / R_EARTH_M);
  if (Math.abs(cosXtAng) < 1e-12) return false;
  const cosAt = Math.max(-1, Math.min(1, Math.cos(d1vAng) / cosXtAng));
  const dAt = Math.acos(cosAt) * R_EARTH_M;
  return dAt >= 0 && dAt <= d12;
}

/**
 * Sample `n` points along the great circle from a to b (inclusive of
 * both ends) by spherical linear interpolation. Writes into the
 * provided arrays starting at `offset`. Handles antimeridian crossing.
 */
export function slerpSamples(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  n: number,
  outLon: Float64Array,
  outLat: Float64Array,
  offset: number
): void {
  const la1 = lat1 * DEG;
  const lo1 = lon1 * DEG;
  const la2 = lat2 * DEG;
  const lo2 = lon2 * DEG;
  const dlat = la2 - la1;
  const dlon = lo2 - lo1;
  const aHav = Math.sin(dlat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlon / 2) ** 2;
  const d = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, aHav))));
  const sinD = Math.sin(d);
  const c1 = Math.cos(la1);
  const c2 = Math.cos(la2);
  const x1 = c1 * Math.cos(lo1);
  const y1 = c1 * Math.sin(lo1);
  const z1 = Math.sin(la1);
  const x2 = c2 * Math.cos(lo2);
  const y2 = c2 * Math.sin(lo2);
  const z2 = Math.sin(la2);
  for (let k = 0; k < n; k++) {
    const f = n === 1 ? 0 : k / (n - 1);
    let A: number;
    let B: number;
    if (sinD > 1e-12) {
      A = Math.sin((1 - f) * d) / sinD;
      B = Math.sin(f * d) / sinD;
    } else {
      A = 1;
      B = 0;
    }
    const x = A * x1 + B * x2;
    const y = A * y1 + B * y2;
    const z = A * z1 + B * z2;
    outLat[offset + k] = Math.atan2(z, Math.hypot(x, y)) * RAD;
    outLon[offset + k] = Math.atan2(y, x) * RAD;
  }
}

/** Axis-aligned lon/lat box. `west` may exceed `east` when crossing the antimeridian. */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Longitudinal width in degrees, taking the short way round if west > east. */
export function bboxWidth(b: BBox): number {
  const w = b.east - b.west;
  return w >= 0 ? w : w + 360;
}

export function bboxHeight(b: BBox): number {
  return b.north - b.south;
}

/** Offset of `lon` east of the box's west edge, in [0, 360). */
export function lonOffsetFromWest(b: BBox, lon: number): number {
  return lonOffset(lon, b.west);
}

export function bboxContains(b: BBox, lon: number, lat: number): boolean {
  if (lat < b.south || lat > b.north) return false;
  return lonOffsetFromWest(b, lon) <= bboxWidth(b);
}

/**
 * Enclosing box for a set of points, choosing the short way round the
 * antimeridian, with optional padding in degrees.
 */
export function bboxFromLonLat(lons: number[], lats: number[], padLon = 0, padLat = padLon): BBox {
  if (lons.length === 0 || lons.length !== lats.length) {
    throw new Error('bboxFromLonLat needs at least one point');
  }
  const ref = lons[0];
  let wmin = Infinity;
  let wmax = -Infinity;
  for (const L of lons) {
    const shifted = wrapLon(L - ref) + ref;
    if (shifted < wmin) wmin = shifted;
    if (shifted > wmax) wmax = shifted;
  }
  wmin -= padLon;
  wmax += padLon;
  let south = Math.min(...lats) - padLat;
  let north = Math.max(...lats) + padLat;
  if (south < -90) south = -90;
  if (north > 90) north = 90;
  if (wmax - wmin >= 360) {
    return { west: -180, south, east: 180, north };
  }
  return { west: wrapLon(wmin), south, east: wrapLon(wmax), north };
}

/**
 * Two boxes share at least a point. Longitude goes round: a box whose west is greater than its east crosses the date
 * line (BBox), and -180 and 180 are one meridian. Two boxes that do not cross are compared as plain numbers first, so
 * they answer as they always did; the comparison round the earth then adds only the boxes that meet across the date
 * line. (The chart meshes' indexes and a leg's area: a mesh may cross the date line, and so may a leg.)
 */
export function boxesMeet(a: BBox, b: BBox): boolean {
  if (!(a.south <= b.north && b.south <= a.north)) return false;
  if (a.west <= a.east && b.west <= b.east && a.west <= b.east && b.west <= a.east) return true;
  return lonOffset(b.west, a.west) <= bboxWidth(a) || lonOffset(a.west, b.west) <= bboxWidth(b);
}

/** A longitude that lies a turn outside -180 to 180 brought back inside; 180 and -180 themselves, and anything between, are left as they are. */
export function wrapEdge(lon: number): number {
  return unwrapLonNear(lon, 0);
}

/**
 * The box holding two boxes, the short way round: `b` is taken next to `a` (its west within half a turn of `a`'s
 * middle), so two boxes either side of the date line give a box across it (west greater than east), and two boxes
 * that do not cross give their plain union, the same numbers as the least west and the greatest east. All the way
 * round: -180 to 180.
 */
export function bboxUnion(a: BBox, b: BBox): BBox {
  const south = Math.min(a.south, b.south);
  const north = Math.max(a.north, b.north);
  const aw = a.west;
  const ae = a.east >= a.west ? a.east : a.east + 360;
  const bw = unwrapLonNear(b.west, (aw + ae) / 2);
  const be = (b.east >= b.west ? b.east : b.east + 360) + (bw - b.west);
  const west = Math.min(aw, bw);
  const east = Math.max(ae, be);
  if (east - west >= 360) return { west: -180, south, east: 180, north };
  return { west: wrapEdge(west), south, east: wrapEdge(east), north };
}

/** A position as the logs and messages write it: "41.4900, -71.3300" (latitude first, four decimals, about 10 m). */
export function latLonText(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}
