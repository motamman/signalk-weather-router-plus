/**
 * Minimal ESRI shapefile (.shp) reader for polygon land masks such as
 * GSHHG (`GSHHS_?_L1.shp`) or the OSM land-polygons export.
 *
 * Reads shape types 5 (Polygon), 15 (PolygonZ) and 25 (PolygonM). Each
 * record becomes one `ShapePolygon` with its rings; ring orientation is
 * not interpreted (the rasteriser uses even-odd filling, which is
 * orientation-independent and handles holes correctly).
 *
 * Only records whose bounding box intersects the requested box are
 * decoded, so scanning the 161 MB full-resolution GSHHG file for a
 * regional route costs one sequential read and very little memory.
 *
 * Format reference: ESRI Shapefile Technical Description (July 1998).
 * Byte layout below follows that document; offsets are byte offsets.
 */

import * as fs from 'node:fs';
import type { BBox } from './geodesy';
import { bboxWidth, lonOffsetFromWest } from './geodesy';

export interface Ring {
  /** Flat [lon0, lat0, lon1, lat1, ...]. First and last vertex coincide. */
  coords: Float64Array;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface ShapePolygon {
  recordNumber: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  rings: Ring[];
}

export class ShapefileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapefileError';
  }
}

const SHAPE_NULL = 0;
const SHAPE_POLYGON = 5;

/**
 * Record scratch buffers reused across calls (one set per thread: each
 * worker has its own module instance). A record is read into `content`
 * and parsed before the next read, so one buffer per use serves; it grows
 * to the largest record met (GSHHG's continents, tens of MB) and is kept.
 * Allocating it per call churned that through the allocator, which keeps
 * the freed space (brain, 2026-10-06).
 */
const CONTENT_BASE = 1 << 20;
const PTS_BASE = 1 << 12;
let contentScratch = Buffer.alloc(CONTENT_BASE);
function contentBuffer(n: number): Buffer {
  if (contentScratch.length < n) contentScratch = Buffer.alloc(n);
  return contentScratch;
}
let ptsScratch = new Float64Array(PTS_BASE);
/**
 * After a read: drop a scratch grown past its base size (a continent's
 * record is 13–27 MB), so a worker does not keep its largest record's
 * buffer for good (brain, 2026-10-06: 13–27 MB in each of four workers).
 */
function releaseScratch(): void {
  if (contentScratch.length > CONTENT_BASE) contentScratch = Buffer.alloc(CONTENT_BASE);
  if (ptsScratch.length > PTS_BASE) ptsScratch = new Float64Array(PTS_BASE);
}
const SHAPE_POLYGON_Z = 15;
const SHAPE_POLYGON_M = 25;

/**
 * Does an axis-aligned lon/lat box (in plain -180..180 coordinates)
 * intersect the possibly antimeridian-crossing `BBox`?
 */
function boxIntersects(b: BBox, minLon: number, minLat: number, maxLon: number, maxLat: number): boolean {
  if (maxLat < b.south || minLat > b.north) return false;
  const width = bboxWidth(b);
  if (width >= 360) return true;
  // Express both record-box edges as offsets east of b.west, in [0, 360).
  const o1 = lonOffsetFromWest(b, minLon);
  const o2 = lonOffsetFromWest(b, maxLon);
  // o1 > o2 means the record box straddles b.west itself, so it touches
  // offset 0, which is inside the clip box. Otherwise the record box is
  // [o1, o2] and intersects [0, width] iff o1 <= width (o1 is never < 0).
  return o1 > o2 || o1 <= width;
}

/** Validate the 100-byte main file header; returns the file length and shape type. */
function readHeader(fd: number, shpPath: string): { fileLengthBytes: number; shapeType: number } {
  const header = Buffer.alloc(100);
  if (fs.readSync(fd, header, 0, 100, 0) !== 100) {
    throw new ShapefileError(`${shpPath}: too short for a shapefile header`);
  }
  const fileCode = header.readInt32BE(0);
  if (fileCode !== 9994) throw new ShapefileError(`${shpPath}: bad file code ${fileCode}`);
  const fileLengthBytes = header.readInt32BE(24) * 2;
  const shapeType = header.readInt32LE(32);
  if (![SHAPE_POLYGON, SHAPE_POLYGON_Z, SHAPE_POLYGON_M].includes(shapeType)) {
    throw new ShapefileError(`${shpPath}: shape type ${shapeType} is not a polygon type`);
  }
  return { fileLengthBytes, shapeType };
}

/**
 * Decode one record's content (after the 8-byte record header). Returns
 * null for null shapes, shapes with no ring of 3+ points, or (when
 * `clip` is given) shapes whose bounding box misses it.
 */
function parseRecord(
  content: Buffer,
  contentLen: number,
  recordNumber: number,
  shapeType: number,
  shpPath: string,
  clip?: BBox
): ShapePolygon | null {
  const type = content.readInt32LE(0);
  if (type === SHAPE_NULL) return null;
  if (type !== shapeType) {
    throw new ShapefileError(`${shpPath}: record ${recordNumber} has shape type ${type}, file says ${shapeType}`);
  }
  const minLon = content.readDoubleLE(4);
  const minLat = content.readDoubleLE(12);
  const maxLon = content.readDoubleLE(20);
  const maxLat = content.readDoubleLE(28);
  if (clip && !boxIntersects(clip, minLon, minLat, maxLon, maxLat)) return null;

  const numParts = content.readInt32LE(36);
  const numPoints = content.readInt32LE(40);
  const partsOff = 44;
  const pointsOff = partsOff + 4 * numParts;
  const needed = pointsOff + 16 * numPoints;
  if (needed > contentLen) {
    throw new ShapefileError(`${shpPath}: record ${recordNumber} declares ${numPoints} points but has ${contentLen} bytes`);
  }
  const rings: Ring[] = [];
  for (let p = 0; p < numParts; p++) {
    const start = content.readInt32LE(partsOff + 4 * p);
    const end = p + 1 < numParts ? content.readInt32LE(partsOff + 4 * (p + 1)) : numPoints;
    if (end < start || end > numPoints) {
      throw new ShapefileError(`${shpPath}: record ${recordNumber} part ${p} range ${start}..${end} invalid`);
    }
    const n = end - start;
    if (n < 3) continue;
    const coords = new Float64Array(2 * n);
    let rMinLon = Infinity;
    let rMinLat = Infinity;
    let rMaxLon = -Infinity;
    let rMaxLat = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = pointsOff + 16 * (start + i);
      const x = content.readDoubleLE(o);
      const y = content.readDoubleLE(o + 8);
      coords[2 * i] = x;
      coords[2 * i + 1] = y;
      if (x < rMinLon) rMinLon = x;
      if (x > rMaxLon) rMaxLon = x;
      if (y < rMinLat) rMinLat = y;
      if (y > rMaxLat) rMaxLat = y;
    }
    rings.push({ coords, minLon: rMinLon, minLat: rMinLat, maxLon: rMaxLon, maxLat: rMaxLat });
  }
  return rings.length ? { recordNumber, minLon, minLat, maxLon, maxLat, rings } : null;
}

/**
 * Read polygons whose bounding box intersects `clip` (or all polygons
 * when `clip` is undefined). Returns them in file order.
 */
export function readShapefilePolygons(shpPath: string, clip?: BBox): ShapePolygon[] {
  const fd = fs.openSync(shpPath, 'r');
  try {
    const { fileLengthBytes, shapeType } = readHeader(fd, shpPath);
    const out: ShapePolygon[] = [];
    const recHeader = Buffer.alloc(8);
    let pos = 100;

    while (pos + 8 <= fileLengthBytes) {
      if (fs.readSync(fd, recHeader, 0, 8, pos) !== 8) break;
      const recordNumber = recHeader.readInt32BE(0);
      const contentLen = recHeader.readInt32BE(4) * 2;
      pos += 8;
      if (contentLen < 4) throw new ShapefileError(`${shpPath}: record ${recordNumber} has length ${contentLen}`);
      const content = contentBuffer(contentLen);
      if (fs.readSync(fd, content, 0, contentLen, pos) !== contentLen) {
        throw new ShapefileError(`${shpPath}: truncated record ${recordNumber}`);
      }
      pos += contentLen;
      const shape = parseRecord(content, contentLen, recordNumber, shapeType, shpPath, clip);
      if (shape) out.push(shape);
    }
    return out;
  } finally {
    fs.closeSync(fd);
    releaseScratch();
  }
}

/**
 * In-memory index of a polygon shapefile: every record's bounding box
 * and file offset (about 40 bytes per record; 7 MB for the 180 k records
 * of GSHHG full-resolution L1). Built with one chunked sequential read,
 * then `read(clip)` decodes only the records whose box intersects the
 * clip, with positioned reads, instead of rescanning the whole file.
 * Used for the on-demand overlay land masks; results equal
 * `readShapefilePolygons(path, clip)`.
 */
export class ShapefileIndex {
  readonly path: string;
  readonly count: number;
  private readonly shapeType: number;
  private readonly minLon: Float64Array;
  private readonly minLat: Float64Array;
  private readonly maxLon: Float64Array;
  private readonly maxLat: Float64Array;
  private readonly offset: Float64Array;
  private readonly length: Int32Array;
  private readonly recNo: Int32Array;

  private static cache = new Map<string, { mtimeMs: number; size: number; index: ShapefileIndex }>();

  /** Index for a file, rebuilt when the file changes. */
  static open(shpPath: string): ShapefileIndex {
    const st = fs.statSync(shpPath);
    const hit = ShapefileIndex.cache.get(shpPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.index;
    const index = new ShapefileIndex(shpPath);
    ShapefileIndex.cache.set(shpPath, { mtimeMs: st.mtimeMs, size: st.size, index });
    return index;
  }

  private constructor(shpPath: string) {
    this.path = shpPath;
    const fd = fs.openSync(shpPath, 'r');
    try {
      const { fileLengthBytes, shapeType } = readHeader(fd, shpPath);
      this.shapeType = shapeType;
      const cap0 = 1024;
      let cap = cap0;
      let minLon = new Float64Array(cap);
      let minLat = new Float64Array(cap);
      let maxLon = new Float64Array(cap);
      let maxLat = new Float64Array(cap);
      let offset = new Float64Array(cap);
      let length = new Int32Array(cap);
      let recNo = new Int32Array(cap);
      let n = 0;
      const CHUNK = 8 << 20;
      const buf = Buffer.alloc(CHUNK);
      let bufStart = 0; // file offset of buf[0]
      let bufLen = 0;
      const ensure = (pos: number, len: number): boolean => {
        if (pos >= bufStart && pos + len <= bufStart + bufLen) return true;
        bufStart = pos;
        bufLen = fs.readSync(fd, buf, 0, CHUNK, pos);
        return bufLen >= len;
      };
      let pos = 100;
      while (pos + 8 <= fileLengthBytes) {
        if (!ensure(pos, 8 + 36)) {
          // Short tail: a record smaller than 36 bytes (null shape) at EOF.
          if (!ensure(pos, 8)) break;
        }
        const o = pos - bufStart;
        const recordNumber = buf.readInt32BE(o);
        const contentLen = buf.readInt32BE(o + 4) * 2;
        if (contentLen < 4) throw new ShapefileError(`${shpPath}: record ${recordNumber} has length ${contentLen}`);
        const type = buf.readInt32LE(o + 8);
        if (type !== SHAPE_NULL && contentLen >= 36 && pos + 8 + 36 <= bufStart + bufLen) {
          if (type !== shapeType)
            throw new ShapefileError(`${shpPath}: record ${recordNumber} has shape type ${type}, file says ${shapeType}`);
          if (n === cap) {
            cap *= 2;
            const grow = <T extends Float64Array | Int32Array>(a: T): T => {
              const b = new (a.constructor as { new (n: number): T })(cap);
              b.set(a);
              return b;
            };
            minLon = grow(minLon);
            minLat = grow(minLat);
            maxLon = grow(maxLon);
            maxLat = grow(maxLat);
            offset = grow(offset);
            length = grow(length);
            recNo = grow(recNo);
          }
          minLon[n] = buf.readDoubleLE(o + 12);
          minLat[n] = buf.readDoubleLE(o + 20);
          maxLon[n] = buf.readDoubleLE(o + 28);
          maxLat[n] = buf.readDoubleLE(o + 36);
          offset[n] = pos + 8;
          length[n] = contentLen;
          recNo[n] = recordNumber;
          n++;
        }
        pos += 8 + contentLen;
      }
      this.count = n;
      this.minLon = minLon.slice(0, n);
      this.minLat = minLat.slice(0, n);
      this.maxLon = maxLon.slice(0, n);
      this.maxLat = maxLat.slice(0, n);
      this.offset = offset.slice(0, n);
      this.length = length.slice(0, n);
      this.recNo = recNo.slice(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Resident bytes of the index arrays. */
  bytes(): number {
    return this.count * (5 * 8 + 2 * 4);
  }

  /** Decode the records whose bounding box intersects `clip` (file order). */
  read(clip: BBox): ShapePolygon[] {
    const out: ShapePolygon[] = [];
    this.forEach(clip, s => out.push(s));
    return out;
  }

  /** Decode the records intersecting `clip` one at a time (file order), without holding them all. */
  forEach(clip: BBox, fn: (s: ShapePolygon) => void): number {
    const hits: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (boxIntersects(clip, this.minLon[i], this.minLat[i], this.maxLon[i], this.maxLat[i])) hits.push(i);
    }
    this.eachRecord(hits, fn);
    return hits.length;
  }

  /** Decode the records whose bounding box contains the point. */
  containing(lon: number, lat: number): ShapePolygon[] {
    const hits: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (lat < this.minLat[i] || lat > this.maxLat[i]) continue;
      if (lon < this.minLon[i] || lon > this.maxLon[i]) continue;
      hits.push(i);
    }
    return this.readRecords(hits);
  }

  /**
   * Exact even-odd point-in-polygon against every record whose box holds
   * the point, evaluated straight on the record bytes (no ring objects),
   * so a continent-sized record costs one read and one pass. Same rule as
   * pointInShape: all parts of a record together, so holes count.
   */
  containsPoint(lon: number, lat: number): boolean {
    const hits: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (lat < this.minLat[i] || lat > this.maxLat[i]) continue;
      if (lon < this.minLon[i] || lon > this.maxLon[i]) continue;
      hits.push(i);
    }
    if (hits.length === 0) return false;
    const fd = fs.openSync(this.path, 'r');
    try {
      for (const i of hits) {
        const len = this.length[i];
        const content = contentBuffer(len);
        if (fs.readSync(fd, content, 0, len, this.offset[i]) !== len)
          throw new ShapefileError(`${this.path}: truncated record ${this.recNo[i]}`);
        if (content.readInt32LE(0) === SHAPE_NULL) continue;
        const numParts = content.readInt32LE(36);
        const numPoints = content.readInt32LE(40);
        const pointsOff = 44 + 4 * numParts;
        if (pointsOff + 16 * numPoints > len)
          throw new ShapefileError(`${this.path}: record ${this.recNo[i]} declares ${numPoints} points but has ${len} bytes`);
        // Copy the coordinates into an aligned Float64Array (little-endian hosts).
        if (ptsScratch.length < 2 * numPoints) ptsScratch = new Float64Array(2 * numPoints);
        const pts = ptsScratch;
        const bytes = new Uint8Array(pts.buffer, 0, 16 * numPoints);
        content.copy(bytes, 0, pointsOff, pointsOff + 16 * numPoints);
        let inside = false;
        for (let p = 0; p < numParts; p++) {
          const start = content.readInt32LE(44 + 4 * p);
          const end = p + 1 < numParts ? content.readInt32LE(44 + 4 * (p + 1)) : numPoints;
          if (end - start < 3) continue;
          for (let a = start, b = end - 1; a < end; b = a++) {
            const yi = pts[2 * a + 1];
            const yj = pts[2 * b + 1];
            if (yi > lat !== yj > lat) {
              const xi = pts[2 * a];
              const xj = pts[2 * b];
              if (lon < xj + ((lat - yj) * (xi - xj)) / (yi - yj)) inside = !inside;
            }
          }
        }
        if (inside) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
      releaseScratch();
    }
  }

  private readRecords(idx: number[]): ShapePolygon[] {
    const out: ShapePolygon[] = [];
    this.eachRecord(idx, s => out.push(s));
    return out;
  }

  private eachRecord(idx: number[], fn: (s: ShapePolygon) => void): void {
    if (idx.length === 0) return;
    const r = this.openReader();
    try {
      for (const i of idx) {
        const shape = r.decode(i);
        if (shape) fn(shape);
      }
    } finally {
      r.close();
    }
  }

  /** Index positions (ascending = file order) of the records whose box intersects `clip`. */
  hitIndices(clip: BBox): number[] {
    const hits: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (boxIntersects(clip, this.minLon[i], this.minLat[i], this.maxLon[i], this.maxLat[i])) hits.push(i);
    }
    return hits;
  }

  /** Record number of index position `i`. */
  recordNumber(i: number): number {
    return this.recNo[i];
  }

  /**
   * A reader that decodes records by index position with one open file
   * (the polygon cache decodes only the records it lacks, in file order).
   * `decode` returns null for null shapes and shapes without a ring.
   */
  openReader(): { decode: (i: number) => ShapePolygon | null; close: () => void } {
    const fd = fs.openSync(this.path, 'r');
    return {
      decode: (i: number): ShapePolygon | null => {
        const len = this.length[i];
        const content = contentBuffer(len);
        if (fs.readSync(fd, content, 0, len, this.offset[i]) !== len) {
          throw new ShapefileError(`${this.path}: truncated record ${this.recNo[i]}`);
        }
        return parseRecord(content, len, this.recNo[i], this.shapeType, this.path);
      },
      close: () => {
        fs.closeSync(fd);
        releaseScratch();
      },
    };
  }
}

/**
 * Even-odd point-in-polygon over all rings of a shape. Holes are rings
 * too, so a point inside a lake inside land returns false.
 */
export function pointInShape(shape: ShapePolygon, lon: number, lat: number): boolean {
  if (lon < shape.minLon || lon > shape.maxLon || lat < shape.minLat || lat > shape.maxLat) return false;
  let inside = false;
  for (const ring of shape.rings) {
    if (lon < ring.minLon || lon > ring.maxLon || lat < ring.minLat || lat > ring.maxLat) continue;
    const c = ring.coords;
    const n = c.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = c[2 * i];
      const yi = c[2 * i + 1];
      const xj = c[2 * j];
      const yj = c[2 * j + 1];
      if (yi > lat !== yj > lat) {
        const xCross = xj + ((lat - yj) * (xi - xj)) / (yi - yj);
        if (lon < xCross) inside = !inside;
      }
    }
  }
  return inside;
}
