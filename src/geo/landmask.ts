/**
 * Land mask built from coastline polygons (GSHHG L1–L4 or OSM land
 * polygons), rasterised over a route bounding box.
 *
 * Two query paths, mirroring the routing engine this is ported from:
 *  - `isLandBulk` / `legsCrossLandBulk`: raster lookup; a leg is walked
 *    cell by cell (every cell its path crosses, finest patch first), used
 *    in the propagator's hot per-stage candidate filter.
 *  - `isLandExact` / `legCrossesLandExact`: even-odd point-in-polygon and
 *    segment-against-coastline-edge tests on the source polygons, used for
 *    endpoints and the final validation pass.
 *
 * The raster is conservative: a cell is land if its centre is inside a
 * polygon OR a polygon edge passes through it. That second rule stands
 * in for the buffered-polygon test in the original (peninsulas narrower
 * than a cell must still block a leg). `rasterStreamed` can also build a
 * centre-sampled raster (land iff the cell centre is inside a polygon),
 * used by the global water grid build.
 *
 * Local refinement: `refine(bbox, res)` rasterises a finer patch over a
 * small box (from the loaded polygons) that then answers `isLand` inside
 * it, so a passage the base resolution closes (a strait narrower than
 * two base cells) can be opened locally without a finer raster for the
 * whole route.
 */

import type { BBox } from './geodesy';
import { wrapLon, unwrapLonNear } from './angles';
import { bboxHeight, bboxWidth, lonOffsetFromWest, slerpSamples, haversineDistanceM } from './geodesy';
import { M_PER_DEG } from './units';
import { pointInShape, shorelinePaths, type ShapePolygon } from './shapefile';
import { polygonCache } from './polygoncache';
import { avoidAt, legHitsAvoid, type AvoidArea } from './avoid';

export interface SerializedLandRaster {
  bbox: BBox;
  resolutionDeg: number;
  raster: Uint8Array;
}

/** Finer raster over a small box that overrides the base raster inside it. */
export interface LandPatch {
  bbox: BBox;
  resolutionDeg: number;
  nx: number;
  ny: number;
  raster: Uint8Array;
}

export interface RasterStreamOptions {
  /** Also mark every cell a polygon edge passes through (default true: conservative). */
  edgeCells?: boolean;
  /** Explicit raster size (avoids ceil() rounding of width / res); must cover the bbox. */
  nx?: number;
  ny?: number;
}

export interface LandMaskOptions {
  /** Raster cell size in degrees. 0.002° ≈ 220 m at the equator. */
  resolutionDeg?: number;
  /** Degrees of margin loaded around the bbox so legs leaving it still see land. */
  bufferDeg?: number;
}

/**
 * What the router asks of land: the four checks the search, the tack
 * layout, the polish and the smoother make. The coastline raster
 * (LandMask) answers them; so does the chart mesh (engine/mesh/land.ts).
 */
export interface LandTest {
  /** Raster test: is the point unusable? */
  isLand(lon: number, lat: number): boolean;
  /** Exact test (polygons, or the mesh triangle): is the point unusable? */
  isLandExact(lon: number, lat: number): boolean;
  /** Exact test: does the straight path a→b touch anything unusable? */
  legCrossesLandExact(lonA: number, latA: number, lonB: number, latB: number): boolean;
  /** For each leg a→b: 1 when it crosses something unusable. */
  legsCrossLandBulk(lonsA: ArrayLike<number>, latsA: ArrayLike<number>, lonsB: ArrayLike<number>, latsB: ArrayLike<number>): Uint8Array;
}

export class LandMask implements LandTest {
  readonly bbox: BBox;
  readonly resolutionDeg: number;
  readonly nx: number;
  readonly ny: number;
  /** 1 = land, 0 = water. Row 0 is the southernmost row. */
  readonly raster: Uint8Array;
  readonly shapes: ShapePolygon[];
  /** Finer local rasters (see refine()); checked before the base raster. */
  readonly patches: LandPatch[] = [];
  /** Mark cells crossed by polygon edges (conservative raster). */
  private edgeCells = true;
  private boundaryPass = false;
  private fillValue = 1;
  /** Keep at least this far from land, metres: the raster is grown by it and the exact tests measure to the shoreline (0 = none). */
  readonly bufferM: number = 0;

  private constructor(
    shapes: ShapePolygon[],
    bbox: BBox,
    resolutionDeg: number,
    raster?: Uint8Array,
    dims?: { nx?: number; ny?: number; edgeCells?: boolean }
  ) {
    this.shapes = [...shapes].sort((a, b) => (a.level ?? 1) - (b.level ?? 1));
    this.bbox = bbox;
    this.resolutionDeg = resolutionDeg;
    this.nx = dims?.nx ?? Math.max(1, Math.ceil(bboxWidth(bbox) / resolutionDeg));
    this.ny = dims?.ny ?? Math.max(1, Math.ceil(bboxHeight(bbox) / resolutionDeg));
    if (dims?.edgeCells === false) this.edgeCells = false;
    const cells = this.nx * this.ny;
    if (cells > 400_000_000) {
      throw new Error(
        `LandMask raster of ${this.nx}x${this.ny} = ${(cells / 1e6).toFixed(0)}M cells is too large; ` +
          'use a coarser resolution or a smaller bbox'
      );
    }
    if (raster) {
      if (raster.length !== cells) throw new Error(`LandMask raster has ${raster.length} cells, expected ${cells}`);
      this.raster = raster;
    } else {
      this.raster = new Uint8Array(cells);
      this.rasterize();
    }
  }

  /** Structured-clone friendly raster form (no polygons; isLandExact is unavailable). */
  serializeRaster(): SerializedLandRaster {
    return { bbox: this.bbox, resolutionDeg: this.resolutionDeg, raster: this.raster };
  }

  static fromRaster(s: SerializedLandRaster): LandMask {
    return new LandMask([], s.bbox, s.resolutionDeg, s.raster);
  }

  /** True when polygon geometry is available for exact tests. */
  get hasPolygons(): boolean {
    return this.shapes.length > 0;
  }

  /**
   * Load every polygon from the given shapefiles that intersects `bbox`
   * (plus `bufferDeg` margin) and rasterise it. The polygons come from the
   * thread's polygon cache (polygoncache.ts): a route's legs and stops, or
   * a re-routed corridor box, decode each record once.
   */
  static fromShapefiles(paths: string[], bbox: BBox, opts: LandMaskOptions = {}): LandMask {
    const resolutionDeg = opts.resolutionDeg ?? 0.002;
    const buffer = opts.bufferDeg ?? 0.1;
    if (!(resolutionDeg > 0)) throw new Error(`LandMask resolutionDeg must be > 0 (got ${resolutionDeg})`);
    const width = bboxWidth(bbox);
    const padded: BBox = {
      west: width + 2 * buffer >= 360 ? -180 : wrapLon(bbox.west - buffer),
      east: width + 2 * buffer >= 360 ? 180 : wrapLon(bbox.east + buffer),
      south: Math.max(-90, bbox.south - buffer),
      north: Math.min(90, bbox.north + buffer),
    };
    const shapes: ShapePolygon[] = polygonCache.read(shorelinePaths(paths), padded);
    return new LandMask(shapes, padded, resolutionDeg);
  }

  /**
   * Finest resolution from `candidates` whose raster over `bbox` (plus
   * buffer) stays within `maxCells`. Falls back to the coarsest candidate.
   */
  static chooseResolution(bbox: BBox, maxCells = 25_000_000, bufferDeg = 0.1, candidates = [0.0005, 0.001, 0.002, 0.005, 0.01]): number {
    const w = Math.min(360, bboxWidth(bbox) + 2 * bufferDeg);
    const h = Math.min(180, bboxHeight(bbox) + 2 * bufferDeg);
    const sorted = [...candidates].sort((a, b) => a - b);
    for (const r of sorted) {
      if (Math.ceil(w / r) * Math.ceil(h / r) <= maxCells) return r;
    }
    return sorted[sorted.length - 1];
  }

  /** Build from already-decoded polygons (tests). */
  static fromPolygons(shapes: ShapePolygon[], bbox: BBox, resolutionDeg = 0.002): LandMask {
    return new LandMask(shapes, bbox, resolutionDeg);
  }

  /**
   * This mask keeping `bufferM` metres from land: a new mask over the
   * same polygons whose raster is the base raster grown by the buffer
   * (every cell within it of a land cell is land; a local patch made
   * later is grown the same way) and whose exact tests count a point
   * within the buffer of a shoreline edge as land and a move that comes
   * within it as crossing land. The raster stays conservative for the
   * exact tests: a cell not grown is more than the buffer from any land.
   * 0 or less: this mask itself.
   */
  withBuffer(bufferM: number): LandMask {
    if (!(bufferM > 0)) return this;
    const [kx, ky] = this.cellsFor(bufferM, this.resolutionDeg);
    const raster = dilate(this.raster, this.nx, this.ny, kx, ky);
    const m = new LandMask(this.shapes, this.bbox, this.resolutionDeg, raster, { nx: this.nx, ny: this.ny, edgeCells: this.edgeCells });
    (m as { bufferM: number }).bufferM = bufferM;
    return m;
  }

  /** Cells a buffer spans east-west and north-south at a resolution, conservative (the box's smallest cos(latitude)). */
  private cellsFor(bufferM: number, resolutionDeg: number): [number, number] {
    const cosLat = Math.max(0.05, Math.cos((Math.max(Math.abs(this.bbox.south), Math.abs(this.bbox.north)) * Math.PI) / 180));
    return [Math.ceil(bufferM / (resolutionDeg * M_PER_DEG * cosLat)), Math.ceil(bufferM / (resolutionDeg * M_PER_DEG))];
  }

  /**
   * Raster-only mask fed one polygon at a time: `feed` calls `add` for
   * each polygon, which is rasterised and can then be dropped, so memory
   * is bounded by the largest single polygon rather than all of them.
   * Feed levels in ascending order; conservative masks replay feed once
   * to mark all boundaries after the land/water fills.
   * The raster equals fromPolygons(all, bbox, res).raster; no polygons
   * are kept (isLandExact is unavailable).
   */
  static rasterStreamed(
    bbox: BBox,
    resolutionDeg: number,
    feed: (add: (s: ShapePolygon) => void) => void,
    opts: RasterStreamOptions = {}
  ): LandMask {
    const m = new LandMask([], bbox, resolutionDeg, undefined, { nx: opts.nx, ny: opts.ny, edgeCells: opts.edgeCells });
    feed(s => m.rasterizeShape(s));
    if (m.edgeCells) {
      m.boundaryPass = true;
      feed(s => m.rasterizeShape(s));
      m.boundaryPass = false;
    }
    return m;
  }

  // -------------------------------------------------------------------
  // Local refinement

  /**
   * Rasterise a finer conservative patch over `bbox` (clipped to the base
   * raster) from the loaded polygons; `isLand` then answers from it inside
   * the box. Needs polygons (a mask from fromShapefiles/fromPolygons).
   * Returns the patch, or null when the box is outside the base raster or
   * an equal-or-finer patch already covers it.
   */
  refine(bbox: BBox, resolutionDeg: number, maxCells = 4_000_000): LandPatch | null {
    if (!this.hasPolygons) throw new Error('LandMask.refine needs polygons (raster-only masks cannot be refined)');
    if (!(resolutionDeg > 0) || resolutionDeg >= this.resolutionDeg) return null;
    // Snap the box to base-cell boundaries inside the base raster.
    const res0 = this.resolutionDeg;
    const x0 = Math.max(0, Math.floor(lonOffsetFromWest(this.bbox, bbox.west) / res0));
    const w = bboxWidth(bbox);
    const x1 = Math.min(this.nx, Math.ceil((lonOffsetFromWest(this.bbox, bbox.west) + w) / res0));
    const y0 = Math.max(0, Math.floor((bbox.south - this.bbox.south) / res0));
    const y1 = Math.min(this.ny, Math.ceil((bbox.north - this.bbox.south) / res0));
    if (x1 <= x0 || y1 <= y0) return null;
    const west = this.bbox.west + x0 * res0;
    const south = this.bbox.south + y0 * res0;
    const k = Math.max(2, Math.round(res0 / resolutionDeg));
    const res = res0 / k;
    const nx = (x1 - x0) * k;
    const ny = (y1 - y0) * k;
    if (nx * ny > maxCells) throw new Error(`LandMask.refine: patch ${nx}x${ny} exceeds ${maxCells} cells`);
    const pb: BBox = {
      west: wrapLon(west),
      south,
      east: wrapLon(west + (x1 - x0) * res0),
      north: south + (y1 - y0) * res0,
    };
    for (const p of this.patches) {
      if (p.resolutionDeg <= res * 1.0001 && bboxCovers(p.bbox, pb)) return null;
    }
    let praster: Uint8Array;
    if (this.bufferM > 0) {
      // Land just outside the patch grows into it too: rasterise a margin of
      // the buffer around the patch, grow that, and keep the patch's cells.
      const [kx, ky] = this.cellsFor(this.bufferM, res);
      const ex = nx + 2 * kx;
      const ey = ny + 2 * ky;
      if (ex * ey > maxCells) throw new Error(`LandMask.refine: buffered patch ${ex}x${ey} exceeds ${maxCells} cells`);
      const eb: BBox = {
        west: wrapLon(west - kx * res),
        south: south - ky * res,
        east: wrapLon(west + (x1 - x0) * res0 + kx * res),
        north: south + (y1 - y0) * res0 + ky * res,
      };
      const shapes = this.shapes.filter(s => s.maxLat >= eb.south && s.minLat <= eb.north);
      const grown = dilate(LandMask.rasterStreamed(eb, res, add => shapes.forEach(add), { nx: ex, ny: ey }).raster, ex, ey, kx, ky);
      praster = new Uint8Array(nx * ny);
      for (let j = 0; j < ny; j++) praster.set(grown.subarray((j + ky) * ex + kx, (j + ky) * ex + kx + nx), j * nx);
    } else {
      const shapes = this.shapes.filter(s => s.maxLat >= pb.south && s.minLat <= pb.north);
      praster = LandMask.rasterStreamed(pb, res, add => shapes.forEach(add), { nx, ny }).raster;
    }
    const patch: LandPatch = { bbox: pb, resolutionDeg: res, nx, ny, raster: praster };
    // Finest first, so lookups hit the finest patch covering a point.
    this.patches.push(patch);
    this.patches.sort((a, b) => a.resolutionDeg - b.resolutionDeg);
    return patch;
  }

  /** Drop all local patches (a cached mask reused for another route). */
  clearPatches(): void {
    this.patches.length = 0;
  }

  /** Resolution that answers isLand at a position (finest patch covering it, else the base). */
  resolutionAt(lon: number, lat: number): number {
    for (const p of this.patches) {
      if (patchIndex(p, lon, lat) >= 0) return p.resolutionDeg;
    }
    return this.resolutionDeg;
  }

  /** Bytes held by the base raster and patches. */
  rasterBytes(): number {
    let b = this.raster.length;
    for (const p of this.patches) b += p.raster.length;
    return b;
  }

  // -------------------------------------------------------------------
  // Rasterisation

  private rasterize(): void {
    for (const shape of this.shapes) this.rasterizeShape(shape);
    if (this.edgeCells) {
      this.boundaryPass = true;
      for (const shape of this.shapes) this.rasterizeShape(shape);
      this.boundaryPass = false;
    }
  }

  private rasterizeShape(shape: ShapePolygon): void {
    this.fillValue = (shape.level ?? 1) % 2;
    const { nx, ny, resolutionDeg: res, raster } = this;
    const width = bboxWidth(this.bbox);
    const south = this.bbox.south;

    // Row centre latitude and the row index range covering a lat span.
    const rowOfLat = (lat: number): number => Math.floor((lat - south) / res);

    // Longitudes are converted to the offset frame (degrees east of
    // bbox.west). Rings crossing the frame seam are unwrapped so
    // consecutive vertices differ by < 180°, then processed in up to
    // three shifted copies (-360, 0, +360) so whichever copy overlaps
    // [0, width] gets filled.
    const rMinRow = Math.max(0, rowOfLat(shape.minLat));
    const rMaxRow = Math.min(ny - 1, rowOfLat(shape.maxLat));
    if (rMinRow > rMaxRow) return;

    const rings: Float64Array[] = [];
    for (const ring of shape.rings) {
      const c = ring.coords;
      const n = c.length / 2;
      const xs = new Float64Array(2 * n);
      let prev = lonOffsetFromWest(this.bbox, c[0]);
      xs[0] = prev;
      xs[1] = c[1];
      for (let i = 1; i < n; i++) {
        let x = lonOffsetFromWest(this.bbox, c[2 * i]);
        // Unwrap relative to the previous vertex.
        x = unwrapLonNear(x, prev);
        xs[2 * i] = x;
        xs[2 * i + 1] = c[2 * i + 1];
        prev = x;
      }
      rings.push(xs);
    }

    for (const shift of [-360, 0, 360]) {
      // Does any ring overlap [0, width] after this shift?
      let overlaps = false;
      for (const xs of rings) {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = 0; i < xs.length; i += 2) {
          const x = xs[i] + shift;
          if (x < mn) mn = x;
          if (x > mx) mx = x;
        }
        if (mx >= 0 && mn <= width) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) continue;
      this.fillShape(rings, shift, rMinRow, rMaxRow, nx, res, south, raster, width);
    }
  }

  /**
   * Scanline even-odd fill of one shape (all rings together) into the
   * raster, plus conservative marking of every cell an edge passes through.
   */
  private fillShape(
    rings: Float64Array[],
    shift: number,
    rowLo: number,
    rowHi: number,
    nx: number,
    res: number,
    south: number,
    raster: Uint8Array,
    width: number
  ): void {
    interface Edge {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      rowStart: number;
      rowEnd: number;
    }
    const buckets = new Map<number, Edge[]>();
    let edgeCount = 0;
    for (const xs of rings) {
      const n = xs.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xa = xs[2 * j] + shift;
        const ya = xs[2 * j + 1];
        const xb = xs[2 * i] + shift;
        const yb = xs[2 * i + 1];
        // Conservative boundary marking: every cell the edge touches.
        if (this.boundaryPass) this.markEdgeCells(xa, ya, xb, yb, nx, res, south, raster, width);
        if (this.boundaryPass || ya === yb) continue; // horizontal edges do not cross scanlines
        const y0 = Math.min(ya, yb);
        const y1 = Math.max(ya, yb);
        // Scanline at row centre lat = south + (row + 0.5) * res crosses the
        // edge when y0 <= lat < y1 (half-open to avoid double counting).
        let rowStart = Math.ceil((y0 - south) / res - 0.5);
        let rowEnd = Math.ceil((y1 - south) / res - 0.5) - 1;
        if (rowStart < rowLo) rowStart = rowLo;
        if (rowEnd > rowHi) rowEnd = rowHi;
        if (rowStart > rowEnd) continue;
        const e: Edge = { x0: xa, y0: ya, x1: xb, y1: yb, rowStart, rowEnd };
        let b = buckets.get(rowStart);
        if (!b) buckets.set(rowStart, (b = []));
        b.push(e);
        edgeCount++;
      }
    }
    if (edgeCount === 0) return;

    let active: Edge[] = [];
    const xsRow: number[] = [];
    for (let row = rowLo; row <= rowHi; row++) {
      const incoming = buckets.get(row);
      if (incoming) active.push(...incoming);
      if (active.length === 0) continue;
      const lat = south + (row + 0.5) * res;
      xsRow.length = 0;
      let anyLeft = false;
      for (const e of active) {
        if (row > e.rowEnd) continue;
        anyLeft = true;
        const t = (lat - e.y0) / (e.y1 - e.y0);
        xsRow.push(e.x0 + t * (e.x1 - e.x0));
      }
      if (!anyLeft) {
        active = [];
        continue;
      }
      if (row % 64 === 0) active = active.filter(e => row <= e.rowEnd);
      xsRow.sort((a, b) => a - b);
      const base = row * nx;
      for (let k = 0; k + 1 < xsRow.length; k += 2) {
        // Cells whose centre lies in [xsRow[k], xsRow[k+1]).
        let jStart = Math.ceil(xsRow[k] / res - 0.5);
        let jEnd = Math.ceil(xsRow[k + 1] / res - 0.5) - 1;
        if (jStart < 0) jStart = 0;
        if (jEnd > nx - 1) jEnd = nx - 1;
        for (let j = jStart; j <= jEnd; j++) raster[base + j] = this.fillValue;
      }
    }
  }

  /**
   * Mark every raster cell an edge passes through: an exact supercover
   * walk (Amanatides–Woo), including the cells around a corner the edge
   * passes exactly through, so a cell left as water has no polygon
   * boundary inside it (isLandExact relies on this).
   */
  private markEdgeCells(
    xa: number,
    ya: number,
    xb: number,
    yb: number,
    nx: number,
    res: number,
    south: number,
    raster: Uint8Array,
    width: number
  ): void {
    const ny = this.ny;
    // Quick reject when the edge is entirely outside the raster.
    if (Math.max(xa, xb) < 0 || Math.min(xa, xb) > width) return;
    if (Math.max(ya, yb) < south || Math.min(ya, yb) > south + ny * res) return;
    const x1 = xa / res;
    const y1 = (ya - south) / res;
    const x2 = xb / res;
    const y2 = (yb - south) / res;
    const mark = (j: number, i: number): void => {
      if (i >= 0 && i < ny && j >= 0 && j < nx) raster[i * nx + j] = 1;
    };
    let cx = Math.floor(x1);
    let cy = Math.floor(y1);
    const ex = Math.floor(x2);
    const ey = Math.floor(y2);
    mark(cx, cy);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx !== 0 ? (sx > 0 ? cx + 1 - x1 : x1 - cx) * tDx : Infinity;
    let tMaxY = dy !== 0 ? (sy > 0 ? cy + 1 - y1 : y1 - cy) * tDy : Infinity;
    // A vertex exactly on a cell border also touches the neighbour.
    if (x1 === cx) mark(cx - 1, cy);
    if (y1 === cy) mark(cx, cy - 1);
    const steps = Math.abs(ex - cx) + Math.abs(ey - cy);
    for (let s = 0; s < steps && Math.min(tMaxX, tMaxY) <= 1; s++) {
      if (Math.abs(tMaxX - tMaxY) < 1e-12) {
        // Through a corner: all four cells around it.
        mark(cx + sx, cy);
        mark(cx, cy + sy);
        cx += sx;
        cy += sy;
        tMaxX += tDx;
        tMaxY += tDy;
        s++;
      } else if (tMaxX < tMaxY) {
        cx += sx;
        tMaxX += tDx;
      } else {
        cy += sy;
        tMaxY += tDy;
      }
      mark(cx, cy);
    }
    mark(ex, ey);
  }

  // -------------------------------------------------------------------
  // Queries

  /** Raster cell index for a position, or -1 when outside the raster. */
  cellIndex(lon: number, lat: number): number {
    const i = Math.floor((lat - this.bbox.south) / this.resolutionDeg);
    if (i < 0 || i >= this.ny) return -1;
    const j = Math.floor(lonOffsetFromWest(this.bbox, lon) / this.resolutionDeg);
    if (j < 0 || j >= this.nx) return -1;
    return i * this.nx + j;
  }

  /** Raster land test (finest patch first). Positions outside the raster are reported as water. */
  isLand(lon: number, lat: number): boolean {
    if (this.patches.length) {
      for (const p of this.patches) {
        const pi = patchIndex(p, lon, lat);
        if (pi >= 0) return p.raster[pi] === 1;
      }
    }
    const idx = this.cellIndex(lon, lat);
    return idx >= 0 && this.raster[idx] === 1;
  }

  /** Raster land test for arrays. */
  isLandBulk(lons: ArrayLike<number>, lats: ArrayLike<number>): Uint8Array {
    const n = lons.length;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = this.isLand(lons[k], lats[k]) ? 1 : 0;
    return out;
  }

  /**
   * Exact even-odd polygon test against the loaded shapes. A point in a
   * water cell of the conservative raster (or of a patch) is water without
   * a polygon test: no polygon boundary passes through such a cell and its
   * centre is classified as water by the hierarchy, so the whole cell is water.
   */
  isLandExact(lon: number, lat: number): boolean {
    if (this.edgeCells && this.shapes.length) {
      for (const p of this.patches) {
        const pi = patchIndex(p, lon, lat);
        if (pi >= 0) {
          if (p.raster[pi] === 0) return false;
          break;
        }
      }
      const idx = this.cellIndex(lon, lat);
      if (idx >= 0 && this.raster[idx] === 0 && !this.inAnyPatch(lon, lat)) return false;
    }
    return this.isLandPolygons(lon, lat) || (this.bufferM > 0 && this.shoreWithin(lon, lat, this.bufferM));
  }

  /** Is any shoreline edge within `distM` of the point? (A local flat metric: fine for the buffer's few hundred metres.) */
  shoreWithin(lon: number, lat: number, distM: number): boolean {
    const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    const dLat = distM / M_PER_DEG;
    const dLon = dLat / cosLat;
    for (const s of this.shapes) {
      if (s.maxLon < lon - dLon || s.minLon > lon + dLon || s.maxLat < lat - dLat || s.minLat > lat + dLat) continue;
      for (const ring of s.rings) {
        if (ring.maxLon < lon - dLon || ring.minLon > lon + dLon || ring.maxLat < lat - dLat || ring.minLat > lat + dLat) continue;
        const c = ring.coords;
        const m = c.length / 2;
        for (let i = 0, j = m - 1; i < m; j = i++) {
          const ax = c[2 * j];
          const ay = c[2 * j + 1];
          const bx = c[2 * i];
          const by = c[2 * i + 1];
          if (
            Math.max(ax, bx) < lon - dLon ||
            Math.min(ax, bx) > lon + dLon ||
            Math.max(ay, by) < lat - dLat ||
            Math.min(ay, by) > lat + dLat
          )
            continue;
          if (pointSegmentM(lon, lat, ax, ay, bx, by, cosLat) <= distM) return true;
        }
      }
    }
    return false;
  }

  /** Point-in-polygon over every loaded shape (no raster shortcut). */
  isLandPolygons(lon: number, lat: number): boolean {
    let level = 0;
    for (const s of this.shapes) {
      if ((s.level ?? 1) > level && pointInShape(s, lon, lat)) level = s.level ?? 1;
    }
    return level % 2 === 1;
  }

  private inAnyPatch(lon: number, lat: number): boolean {
    for (const p of this.patches) if (patchIndex(p, lon, lat) >= 0) return true;
    return false;
  }

  /**
   * For each leg a→b, does its great-circle path pass through a land cell?
   * Every raster cell the path crosses is checked (finest patch where one
   * covers it), not samples along it, so land narrower than the gap
   * between samples cannot be stepped over. The raster is conservative
   * (every cell a coastline edge passes through is land), so a leg whose
   * cells are all water does not cross land.
   */
  legsCrossLandBulk(lonsA: ArrayLike<number>, latsA: ArrayLike<number>, lonsB: ArrayLike<number>, latsB: ArrayLike<number>): Uint8Array {
    const n = lonsA.length;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (this.legCrossesRaster(lonsA[k], latsA[k], lonsB[k], latsB[k])) out[k] = 1;
    return out;
  }

  /** Does the great-circle path a→b pass through a land cell (base raster or patch)? */
  legCrossesRaster(lonA: number, latA: number, lonB: number, latB: number): boolean {
    const { lons, lats } = greatCirclePieces(lonA, latA, lonB, latB);
    for (let k = 0; k + 1 < lons.length; k++) if (this.pieceHitsRaster(lons[k], lats[k], lons[k + 1], lats[k + 1])) return true;
    return false;
  }

  /** One straight piece (lon/lat plane) against the base raster, walking into a patch where one covers a base cell. */
  private pieceHitsRaster(lonP: number, latP: number, lonQ: number, latQ: number): boolean {
    const r = this.resolutionDeg;
    const xP = lonOffsetFromWest(this.bbox, lonP);
    let xQ = lonOffsetFromWest(this.bbox, lonQ);
    if (xQ - xP > 180) xQ -= 360;
    else if (xP - xQ > 180) xQ += 360;
    const yP = latP - this.bbox.south;
    const yQ = latQ - this.bbox.south;
    return walkGrid(xP / r, yP / r, xQ / r, yQ / r, (i, j, t0, t1) => {
      if (i < 0 || i >= this.nx || j < 0 || j >= this.ny) return false; // outside the raster: water, as isLand
      if (this.patches.length) {
        const lonC = this.bbox.west + (i + 0.5) * r;
        const latC = this.bbox.south + (j + 0.5) * r;
        for (const p of this.patches) {
          // Patches cover whole base cells, finest first, as isLand looks them up.
          if (patchIndex(p, lonC, latC) >= 0) {
            const xa = xP + (xQ - xP) * t0;
            const xb = xP + (xQ - xP) * t1;
            const ya = yP + (yQ - yP) * t0;
            const yb = yP + (yQ - yP) * t1;
            return this.pieceHitsPatch(p, this.bbox.west + xa, this.bbox.south + ya, this.bbox.west + xb, this.bbox.south + yb);
          }
        }
      }
      return this.raster[j * this.nx + i] === 1;
    });
  }

  private pieceHitsPatch(p: LandPatch, lonA: number, latA: number, lonB: number, latB: number): boolean {
    const r = p.resolutionDeg;
    const xa = lonOffsetFromWest(p.bbox, lonA);
    let xb = lonOffsetFromWest(p.bbox, lonB);
    if (xb - xa > 180) xb -= 360;
    else if (xa - xb > 180) xb += 360;
    return walkGrid(xa / r, (latA - p.bbox.south) / r, xb / r, (latB - p.bbox.south) / r, (i, j) => {
      // The piece lies in base cells the patch covers; clamp rounding at its edges.
      const ii = Math.min(p.nx - 1, Math.max(0, i));
      const jj = Math.min(p.ny - 1, Math.max(0, j));
      return p.raster[jj * p.nx + ii] === 1;
    });
  }

  /**
   * Exact check for the final validation: does the great-circle path a→b
   * touch land in the polygons? An end point inside land, or any crossing
   * or touching of a coastline edge, counts. Legs whose raster cells are
   * all water are clear without a polygon test (the raster is
   * conservative). No sampling: land of any width is found.
   */
  legCrossesLandExact(lonA: number, latA: number, lonB: number, latB: number): boolean {
    // The raster only speaks for its own box: outside it, fall through to the polygons.
    const inside = this.cellIndex(lonA, latA) >= 0 && this.cellIndex(lonB, latB) >= 0;
    if (inside && this.edgeCells && this.shapes.length && !this.legCrossesRaster(lonA, latA, lonB, latB)) return false;
    if (!this.shapes.length) return this.legCrossesRaster(lonA, latA, lonB, latB);
    if (this.isLandPolygons(lonA, latA) || this.isLandPolygons(lonB, latB)) return true;
    // The buffer: every edge within it of the move, searched in a box grown by it.
    const cosLatB = Math.max(0.05, Math.cos((((latA + latB) / 2) * Math.PI) / 180));
    const dLatB = this.bufferM > 0 ? this.bufferM / M_PER_DEG : 0;
    const dLonB = dLatB / cosLatB;
    const { lons, lats } = greatCirclePieces(lonA, latA, lonB, latB);
    for (let k = 0; k + 1 < lons.length; k++) {
      const x1 = lons[k];
      const y1 = lats[k];
      let x2 = lons[k + 1];
      const y2 = lats[k + 1];
      if (x2 - x1 > 180) x2 -= 360;
      else if (x1 - x2 > 180) x2 += 360;
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      for (const s of this.shapes) {
        if (s.maxLon < minX - dLonB || s.minLon > maxX + dLonB || s.maxLat < minY - dLatB || s.minLat > maxY + dLatB) continue;
        for (const ring of s.rings) {
          if (ring.maxLon < minX - dLonB || ring.minLon > maxX + dLonB || ring.maxLat < minY - dLatB || ring.minLat > maxY + dLatB)
            continue;
          const c = ring.coords;
          const m = c.length / 2;
          for (let i = 0, j = m - 1; i < m; j = i++) {
            const ax = c[2 * j];
            const ay = c[2 * j + 1];
            const bx = c[2 * i];
            const by = c[2 * i + 1];
            if (
              Math.max(ax, bx) < minX - dLonB ||
              Math.min(ax, bx) > maxX + dLonB ||
              Math.max(ay, by) < minY - dLatB ||
              Math.min(ay, by) > maxY + dLatB
            )
              continue;
            if (segmentsTouch(x1, y1, x2, y2, ax, ay, bx, by)) return true;
            if (dLatB > 0 && segmentsWithinM(x1, y1, x2, y2, ax, ay, bx, by, cosLatB) <= this.bufferM) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * This mask with areas to avoid (circles on Signal K notes) answering as
   * land: the four checks the router makes (isLand, isLandExact,
   * legCrossesLandExact, legsCrossLandBulk) also say "land" inside a circle
   * or for a leg through one. A view over this mask (its raster, patches and
   * shapes are shared, nothing is copied), made per route, so a mask held in
   * a cache is never changed. No areas: this mask itself.
   */
  withAvoid(areas: readonly AvoidArea[]): LandMask {
    if (!areas.length) return this;
    // The arrows below keep `this`: the underlying mask answers first.
    const view = Object.create(this) as LandMask;
    view.isLand = (lon: number, lat: number): boolean => this.isLand(lon, lat) || avoidAt(areas, lon, lat) !== null;
    view.isLandExact = (lon: number, lat: number): boolean => this.isLandExact(lon, lat) || avoidAt(areas, lon, lat) !== null;
    view.legCrossesLandExact = (lonA: number, latA: number, lonB: number, latB: number): boolean =>
      this.legCrossesLandExact(lonA, latA, lonB, latB) || legHitsAvoid(areas, lonA, latA, lonB, latB) !== null;
    view.legsCrossLandBulk = (
      lonsA: ArrayLike<number>,
      latsA: ArrayLike<number>,
      lonsB: ArrayLike<number>,
      latsB: ArrayLike<number>
    ): Uint8Array => {
      const out = this.legsCrossLandBulk(lonsA, latsA, lonsB, latsB);
      for (let k = 0; k < out.length; k++) if (!out[k] && legHitsAvoid(areas, lonsA[k], latsA[k], lonsB[k], latsB[k])) out[k] = 1;
      return out;
    };
    return view;
  }

  /** Fraction of raster cells that are land (diagnostics). */
  landFraction(): number {
    let c = 0;
    for (let i = 0; i < this.raster.length; i++) c += this.raster[i];
    return c / this.raster.length;
  }
}

/** Cell index of a position in a patch, or -1 outside it. */
function patchIndex(p: LandPatch, lon: number, lat: number): number {
  const i = Math.floor((lat - p.bbox.south) / p.resolutionDeg);
  if (i < 0 || i >= p.ny) return -1;
  const j = Math.floor(lonOffsetFromWest(p.bbox, lon) / p.resolutionDeg);
  if (j < 0 || j >= p.nx) return -1;
  return i * p.nx + j;
}

/** Does `outer` contain `inner` (antimeridian-aware)? */
function bboxCovers(outer: BBox, inner: BBox): boolean {
  const eps = 1e-9;
  if (inner.south < outer.south - eps || inner.north > outer.north + eps) return false;
  let off = lonOffsetFromWest(outer, inner.west);
  if (off > 360 - eps) off = 0;
  return off + bboxWidth(inner) <= bboxWidth(outer) + eps;
}

/** Longest straight (lon/lat) piece a great circle is split into: at most a few centimetres off the arc. */
const PIECE_MAX_M = 1000;

/** The great circle a→b as points ≤ PIECE_MAX_M apart (end points included). */
export function greatCirclePieces(lonA: number, latA: number, lonB: number, latB: number): { lons: Float64Array; lats: Float64Array } {
  const d = haversineDistanceM(lonA, latA, lonB, latB);
  const n = Math.max(2, Math.ceil(d / PIECE_MAX_M) + 1);
  const lons = new Float64Array(n);
  const lats = new Float64Array(n);
  slerpSamples(lonA, latA, lonB, latB, n, lons, lats, 0);
  lons[0] = lonA;
  lats[0] = latA;
  lons[n - 1] = lonB;
  lats[n - 1] = latB;
  return { lons, lats };
}

/**
 * Visit, in order, every grid cell (column i, row j; unit cells) the
 * straight segment (x0, y0)–(x1, y1) passes through, with the parameter
 * range of the segment inside it. Where the segment passes exactly
 * through a cell corner, the two side cells are visited too
 * (conservative). Stops, returning true, as soon as `visit` does.
 */
export function walkGrid(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (i: number, j: number, t0: number, t1: number) => boolean
): boolean {
  let i = Math.floor(x0);
  let j = Math.floor(y0);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (i + 1 - x0) / dx : stepX < 0 ? (x0 - i) / -dx : Infinity;
  let tMaxY = stepY > 0 ? (j + 1 - y0) / dy : stepY < 0 ? (y0 - j) / -dy : Infinity;
  let t = 0;
  const guard = Math.abs(Math.floor(x1) - i) + Math.abs(Math.floor(y1) - j) + 4;
  for (let k = 0; k <= guard; k++) {
    const tNext = Math.min(tMaxX, tMaxY, 1);
    if (visit(i, j, t, tNext)) return true;
    if (tNext >= 1) return false;
    if (Math.abs(tMaxX - tMaxY) < 1e-12) {
      if (visit(i + stepX, j, tNext, tNext) || visit(i, j + stepY, tNext, tNext)) return true;
      i += stepX;
      j += stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      i += stepX;
      tMaxX += tDeltaX;
    } else {
      j += stepY;
      tMaxY += tDeltaY;
    }
    t = tNext;
  }
  return false;
}

/**
 * The raster grown by kx cells east-west and ky north-south: a cell is
 * set when any cell within that window is. Two passes with a running
 * count, O(cells).
 */
export function dilate(raster: Uint8Array, nx: number, ny: number, kx: number, ky: number): Uint8Array {
  if (kx <= 0 && ky <= 0) return raster.slice();
  const tmp = new Uint8Array(raster.length);
  for (let j = 0; j < ny; j++) {
    const base = j * nx;
    let count = 0;
    for (let i = -kx; i < nx; i++) {
      const add = i + kx;
      if (add < nx && raster[base + add]) count++;
      const drop = i - kx - 1;
      if (drop >= 0 && raster[base + drop]) count--;
      if (i >= 0 && count > 0) tmp[base + i] = 1;
    }
  }
  const out = new Uint8Array(raster.length);
  for (let i = 0; i < nx; i++) {
    let count = 0;
    for (let j = -ky; j < ny; j++) {
      const add = j + ky;
      if (add < ny && tmp[add * nx + i]) count++;
      const drop = j - ky - 1;
      if (drop >= 0 && tmp[drop * nx + i]) count--;
      if (j >= 0 && count > 0) out[j * nx + i] = 1;
    }
  }
  return out;
}

/** Distance in metres from a point to a segment, all in degrees, on a flat metric with the given cos(latitude). */
function pointSegmentM(px: number, py: number, ax: number, ay: number, bx: number, by: number, cosLat: number): number {
  const sx = M_PER_DEG * cosLat;
  const sy = M_PER_DEG;
  const vx = (bx - ax) * sx;
  const vy = (by - ay) * sy;
  const wx = (px - ax) * sx;
  const wy = (py - ay) * sy;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? (wx * vx + wy * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Distance in metres between two segments that do not touch: the least of the four end-to-segment distances. */
function segmentsWithinM(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  q1x: number,
  q1y: number,
  q2x: number,
  q2y: number,
  cosLat: number
): number {
  return Math.min(
    pointSegmentM(p1x, p1y, q1x, q1y, q2x, q2y, cosLat),
    pointSegmentM(p2x, p2y, q1x, q1y, q2x, q2y, cosLat),
    pointSegmentM(q1x, q1y, p1x, p1y, p2x, p2y, cosLat),
    pointSegmentM(q2x, q2y, p1x, p1y, p2x, p2y, cosLat)
  );
}

/** Do segments p1–p2 and q1–q2 intersect or touch? */
function segmentsTouch(p1x: number, p1y: number, p2x: number, p2y: number, q1x: number, q1y: number, q2x: number, q2y: number): boolean {
  const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => {
    const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  };
  const on = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean =>
    Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by);
  const o1 = o(p1x, p1y, p2x, p2y, q1x, q1y);
  const o2 = o(p1x, p1y, p2x, p2y, q2x, q2y);
  const o3 = o(q1x, q1y, q2x, q2y, p1x, p1y);
  const o4 = o(q1x, q1y, q2x, q2y, p2x, p2y);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && on(p1x, p1y, p2x, p2y, q1x, q1y)) return true;
  if (o2 === 0 && on(p1x, p1y, p2x, p2y, q2x, q2y)) return true;
  if (o3 === 0 && on(q1x, q1y, q2x, q2y, p1x, p1y)) return true;
  if (o4 === 0 && on(q1x, q1y, q2x, q2y, p2x, p2y)) return true;
  return false;
}
