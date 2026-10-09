/**
 * Coarse navigability grid used as the substrate for the A* skeleton.
 * Row 0 is the southernmost row; column 0 is at the box's west edge.
 * Longitude indexing goes through the offset-from-west frame so boxes
 * crossing the antimeridian work.
 */

import type { BBox } from './geodesy';
import { bboxHeight, bboxWidth, lonOffsetFromWest, wrapLon } from './geodesy';
import type { LandTest } from './landmask';

export class GridSpec {
  readonly nx: number;
  readonly ny: number;

  constructor(
    readonly bbox: BBox,
    readonly resolutionDeg: number
  ) {
    if (!(resolutionDeg > 0)) throw new Error(`GridSpec: resolution must be > 0 (got ${resolutionDeg})`);
    this.nx = Math.max(1, Math.ceil(bboxWidth(bbox) / resolutionDeg));
    this.ny = Math.max(1, Math.ceil(bboxHeight(bbox) / resolutionDeg));
  }

  get cells(): number {
    return this.nx * this.ny;
  }

  /** Cell containing (lon, lat). May be out of range; callers check. */
  lonlatToIJ(lon: number, lat: number): [number, number] {
    const i = Math.floor((lat - this.bbox.south) / this.resolutionDeg);
    const j = Math.floor(lonOffsetFromWest(this.bbox, lon) / this.resolutionDeg);
    return [i, j];
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && i < this.ny && j >= 0 && j < this.nx;
  }

  /** Centre of cell (i, j). */
  ijToLonLat(i: number, j: number): [number, number] {
    const lon = wrapLon(this.bbox.west + (j + 0.5) * this.resolutionDeg);
    const lat = this.bbox.south + (i + 0.5) * this.resolutionDeg;
    return [lon, lat];
  }
}

export class NavigabilityGrid {
  constructor(
    readonly spec: GridSpec,
    /** 1 = passable water, 0 = land. Length nx*ny, row-major from the south. */
    readonly passable: Uint8Array
  ) {
    if (passable.length !== spec.cells) {
      throw new Error(`NavigabilityGrid: passable has ${passable.length} cells, spec has ${spec.cells}`);
    }
  }

  isPassable(i: number, j: number): boolean {
    return this.spec.inBounds(i, j) && this.passable[i * this.spec.nx + j] === 1;
  }
}

/**
 * Rasterise a coarse grid over `bbox` from the land mask: passable where
 * the cell centre is water. No depth information in this version.
 */
export function buildCoarseGrid(landMask: LandTest, bbox: BBox, resolutionDeg: number, maxCells = 100_000_000): NavigabilityGrid {
  const spec = new GridSpec(bbox, resolutionDeg);
  if (spec.cells > maxCells) {
    throw new Error(
      `buildCoarseGrid: ${spec.nx} x ${spec.ny} = ${(spec.cells / 1e6).toFixed(1)}M cells exceeds the cap of ` +
        `${(maxCells / 1e6).toFixed(0)}M; use a coarser resolution or a smaller bbox`
    );
  }
  const passable = new Uint8Array(spec.cells);
  for (let i = 0; i < spec.ny; i++) {
    const lat = bbox.south + (i + 0.5) * resolutionDeg;
    const base = i * spec.nx;
    for (let j = 0; j < spec.nx; j++) {
      const lon = wrapLon(bbox.west + (j + 0.5) * resolutionDeg);
      passable[base + j] = landMask.isLand(lon, lat) ? 0 : 1;
    }
  }
  return new NavigabilityGrid(spec, passable);
}

/**
 * The cells at Chebyshev distance exactly `r` from a centre, as (dRow, dCol)
 * offsets, rows outer and columns inner (the order every ring search in
 * the engine used). `fn` returns true to stop; the result says whether it
 * did.
 */
export function forEachRingCell(r: number, fn: (dRow: number, dCol: number) => boolean | void): boolean {
  for (let di = -r; di <= r; di++) {
    for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      if (fn(di, dj) === true) return true;
    }
  }
  return false;
}
