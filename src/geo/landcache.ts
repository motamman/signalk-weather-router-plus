/**
 * On-demand land masks for the overlay and conditions endpoints.
 *
 * With a global forecast there is no "region" to pre-rasterise, and a
 * global raster at routing resolution is far too large. Instead each
 * overlay request gets a raster over its own bbox at a resolution
 * matched to the request's sample spacing, built from the configured
 * coastline shapefiles through an in-memory record index (so only the
 * polygons touching the bbox are read). Recent rasters are kept in an
 * in-memory LRU and, when a cache directory is given, saved to disk
 * (gzip) so a box seen before is never rasterised again, even after a
 * restart: the coastline does not change. The polygons themselves are
 * dropped after rasterising.
 * Point queries (conditions `is_land`) use the exact even-odd
 * point-in-polygon test on the few records whose box holds the point.
 *
 * Routing does not use this: it builds its own per-route mask at the
 * routing resolution (worker.ts landMaskFor).
 */

import { shorelinePaths, shorelineLevel } from './shapefile';
import * as crypto from 'node:crypto';
import { wrapLon, lonOffset } from './angles';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { BBox } from './geodesy';
import { bboxWidth } from './geodesy';
import { LandMask } from './landmask';
import { ShapefileIndex } from './shapefile';

export interface LandLookup {
  isLand(lon: number, lat: number): boolean;
}

/** What the overlay code needs from a land source. */
export interface OverlayLand {
  /** Raster land lookup valid inside `bbox`, at a resolution suited to samples `spacingDeg` apart. */
  forBBox(bbox: BBox, spacingDeg: number): LandLookup;
  /** Exact point test. */
  isLandAt(lon: number, lat: number): boolean;
}

export interface OnDemandLandOptions {
  /** Rasters kept (LRU). */
  maxEntries?: number;
  /** Cell budget per raster (1 byte per cell). */
  maxCells?: number;
  /** Directory for rasters saved on disk; none = memory only. */
  cacheDir?: string;
  /** Disk budget for saved rasters, bytes (least recently used pruned first). */
  diskBudgetBytes?: number;
  log?: (msg: string) => void;
}

/** Raster resolutions offered, finest first (degrees). */
export const OVERLAY_LAND_RESOLUTIONS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25];

interface Entry {
  bbox: BBox;
  res: number;
  mask: LandMask;
}

/**
 * Resolution for samples `spacingDeg` apart: a quarter of the spacing
 * (so a sample's cell is small next to the gap between samples), snapped
 * down to the offered set, then coarsened until the snapped bbox fits
 * the cell budget.
 */
export function chooseOverlayResolution(bbox: BBox, spacingDeg: number, maxCells: number): number {
  const target = Math.max(OVERLAY_LAND_RESOLUTIONS[0], spacingDeg / 4);
  let i = 0;
  while (i + 1 < OVERLAY_LAND_RESOLUTIONS.length && OVERLAY_LAND_RESOLUTIONS[i + 1] <= target) i++;
  for (; i < OVERLAY_LAND_RESOLUTIONS.length; i++) {
    const r = OVERLAY_LAND_RESOLUTIONS[i];
    const b = snapBBox(bbox, r);
    if (Math.ceil(bboxWidth(b) / r) * Math.ceil((b.north - b.south) / r) <= maxCells) return r;
  }
  return OVERLAY_LAND_RESOLUTIONS[OVERLAY_LAND_RESOLUTIONS.length - 1];
}

/**
 * Expand a bbox outward to multiples of 256 raster cells so nearby
 * viewports (pans, the several layers of one view) share a raster.
 */
export function snapBBox(b: BBox, res: number): BBox {
  const u = res * 256;
  const south = Math.max(-90, Math.floor(b.south / u) * u);
  const north = Math.min(90, Math.ceil(b.north / u) * u);
  const width = bboxWidth(b);
  let west = Math.floor(b.west / u) * u;
  let east = west + Math.ceil((b.west - west + width) / u) * u;
  if (east - west >= 360) {
    west = -180;
    east = 180;
  } else {
    west = wrapLon(west);
    east = wrapLon(east);
    if (east === -180) east = 180;
  }
  return { west: round9(west), south: round9(south), east: round9(east), north: round9(north) };
}

function round9(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/** Does `outer` contain `inner` (both possibly crossing the antimeridian)? */
function bboxWithin(inner: BBox, outer: BBox): boolean {
  if (inner.south < outer.south - 1e-9 || inner.north > outer.north + 1e-9) return false;
  const ow = bboxWidth(outer);
  if (ow >= 360) return true;
  const off = lonOffset(inner.west, outer.west);
  return off + bboxWidth(inner) <= ow + 1e-9;
}

export class OnDemandLand implements OverlayLand {
  readonly paths: string[];
  private readonly maxEntries: number;
  private readonly maxCells: number;
  private readonly log: (msg: string) => void;
  private entries: Entry[] = [];
  private indexes: ShapefileIndex[] | null = null;
  /** Disk cache directory for this coastline (fingerprinted), or null. */
  private readonly diskDir: string | null;
  private readonly diskBudgetBytes: number;
  private writesSincePrune = 0;
  /** Running totals of the saved rasters (null until the first scan). */
  private diskTotals: { files: number; bytes: number } | null = null;
  /** Build time of the most recent raster, ms (diagnostics). */
  lastBuildMs = 0;
  builds = 0;
  hits = 0;
  diskHits = 0;
  diskWrites = 0;

  constructor(paths: string[], opts: OnDemandLandOptions = {}) {
    paths = shorelinePaths(paths);
    this.paths = paths;
    this.maxEntries = opts.maxEntries ?? 8;
    this.maxCells = opts.maxCells ?? 4_000_000;
    this.diskBudgetBytes = opts.diskBudgetBytes ?? 256e6;
    this.log = opts.log ?? (() => undefined);
    this.diskDir = opts.cacheDir ? path.join(opts.cacheDir, coastlineFingerprint(paths)) : null;
  }

  private diskFile(res: number, b: BBox): string {
    return path.join(this.diskDir!, `${res}_${b.west}_${b.south}_${b.east}_${b.north}.bin.gz`);
  }

  /** A raster saved earlier for exactly this snapped box and resolution, or null. */
  private readDisk(res: number, snapped: BBox): LandMask | null {
    if (!this.diskDir) return null;
    const f = this.diskFile(res, snapped);
    try {
      const raster = new Uint8Array(zlib.gunzipSync(fs.readFileSync(f)));
      const mask = LandMask.fromRaster({ bbox: snapped, resolutionDeg: res, raster });
      const now = new Date();
      fs.utimesSync(f, now, now); // recency for pruning
      return mask;
    } catch {
      return null; // absent, or unreadable (rebuilt and rewritten)
    }
  }

  private writeDisk(res: number, snapped: BBox, mask: LandMask): void {
    if (!this.diskDir) return;
    try {
      fs.mkdirSync(this.diskDir, { recursive: true });
      const f = this.diskFile(res, snapped);
      const tmp = `${f}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      const gz = zlib.gzipSync(mask.serializeRaster().raster, { level: 6 });
      fs.writeFileSync(tmp, gz);
      fs.renameSync(tmp, f);
      this.diskWrites++;
      if (this.diskTotals) {
        this.diskTotals.files++;
        this.diskTotals.bytes += gz.length;
      }
      if (++this.writesSincePrune >= 16) {
        this.writesSincePrune = 0;
        this.pruneDisk();
      }
    } catch (err) {
      this.log(`overlay land: could not save raster: ${(err as Error).message}`);
    }
  }

  /** The saved rasters: path, size and last use. */
  private scanDisk(): { f: string; size: number; t: number }[] {
    if (!this.diskDir) return [];
    let names: string[];
    try {
      names = fs.readdirSync(this.diskDir);
    } catch {
      return []; // no directory yet
    }
    const out: { f: string; size: number; t: number }[] = [];
    for (const n of names) {
      if (!n.endsWith('.bin.gz')) continue;
      const f = path.join(this.diskDir, n);
      try {
        const st = fs.statSync(f);
        out.push({ f, size: st.size, t: st.mtimeMs });
      } catch {
        // gone since readdir
      }
    }
    return out;
  }

  /** Remove least recently used saved rasters until under the disk budget. */
  private pruneDisk(): void {
    const files = this.scanDisk();
    let total = files.reduce((a, x) => a + x.size, 0);
    let count = files.length;
    if (total > this.diskBudgetBytes) {
      files.sort((a, b) => a.t - b.t);
      for (const x of files) {
        if (total <= this.diskBudgetBytes) break;
        try {
          fs.rmSync(x.f, { force: true });
          total -= x.size;
          count--;
        } catch {
          // gone already
        }
      }
    }
    this.diskTotals = { files: count, bytes: total };
  }

  /** Bytes and files of the saved rasters (status): one scan, then running totals. */
  diskStats(): { dir: string | null; files: number; bytes: number } {
    if (!this.diskDir) return { dir: null, files: 0, bytes: 0 };
    if (!this.diskTotals) {
      const files = this.scanDisk();
      this.diskTotals = { files: files.length, bytes: files.reduce((a, x) => a + x.size, 0) };
    }
    return { dir: this.diskDir, files: this.diskTotals?.files ?? 0, bytes: this.diskTotals?.bytes ?? 0 };
  }

  private index(): ShapefileIndex[] {
    if (!this.indexes) {
      const t = Date.now();
      this.indexes = this.paths.map(p => ShapefileIndex.open(p));
      const n = this.indexes.reduce((a, i) => a + i.count, 0);
      const kb = this.indexes.reduce((a, i) => a + i.bytes(), 0) / 1024;
      this.log(`land index: ${n} records from ${this.paths.length} file(s), ${kb.toFixed(0)} kB, ${Date.now() - t} ms`);
    }
    return this.indexes;
  }

  forBBox(bbox: BBox, spacingDeg: number): LandMask {
    const res = chooseOverlayResolution(bbox, spacingDeg, this.maxCells);
    const snapped = snapBBox(bbox, res);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.res === res && bboxWithin(bbox, e.bbox)) {
        this.entries.splice(i, 1);
        this.entries.push(e);
        this.hits++;
        return e.mask;
      }
    }
    const fromDisk = this.readDisk(res, snapped);
    if (fromDisk) {
      this.diskHits++;
      this.entries.push({
        bbox: snapped,
        res,
        mask: fromDisk,
      });
      while (this.entries.length > this.maxEntries) this.entries.shift();
      return fromDisk;
    }
    const t = Date.now();
    // Stream the polygons into the raster one at a time and keep only the
    // raster: a whole-world view touches ~180 k GSHHG records (150 MB of
    // coordinates) that are never held together.
    let polygons = 0;
    const indexes = this.index();
    const mask = LandMask.rasterStreamed(snapped, res, add => {
      for (const ix of indexes) polygons += ix.forEach(snapped, add);
    });
    this.lastBuildMs = Date.now() - t;
    this.builds++;
    this.log(
      `overlay land raster ${snapped.west}..${snapped.east} × ${snapped.south}..${snapped.north} at ${res}°: ${mask.nx}x${mask.ny}, ${polygons} polygons, ${this.lastBuildMs} ms`
    );
    this.entries.push({ bbox: snapped, res, mask });
    while (this.entries.length > this.maxEntries) this.entries.shift();
    this.writeDisk(res, snapped, mask);
    return mask;
  }

  isLandAt(lon: number, lat: number): boolean {
    const l = wrapLon(lon);
    let level = 0;
    for (const ix of this.index()) {
      const n = shorelineLevel(ix.path);
      if (n > level && [l, l + 360, l - 360].some(x => ix.containsPoint(x, lat))) level = n;
    }
    return level % 2 === 1;
  }

  /** Cache state for api/status. */
  stats(): {
    entries: number;
    cells: number;
    bytes: number;
    index_bytes: number;
    builds: number;
    hits: number;
    last_build_ms: number;
    disk_hits: number;
    disk_writes: number;
    disk: { dir: string | null; files: number; bytes: number };
  } {
    const cells = this.entries.reduce((a, e) => a + e.mask.nx * e.mask.ny, 0);
    return {
      disk_hits: this.diskHits,
      disk_writes: this.diskWrites,
      disk: this.diskStats(),
      entries: this.entries.length,
      cells,
      bytes: cells,
      index_bytes: this.indexes ? this.indexes.reduce((a, i) => a + i.bytes(), 0) : 0,
      builds: this.builds,
      hits: this.hits,
      last_build_ms: this.lastBuildMs,
    };
  }
}

/**
 * Folder name for one coastline: a hash of the shapefile paths, sizes and
 * modification times, so a changed coastline never reuses saved rasters.
 */
function coastlineFingerprint(paths: string[]): string {
  const h = crypto.createHash('sha256');
  h.update('hierarchy-v1');
  for (const p of paths) {
    h.update(p);
    try {
      const st = fs.statSync(p);
      h.update(`|${st.size}|${Math.floor(st.mtimeMs)}`);
    } catch {
      h.update('|missing');
    }
  }
  return `coast-${h.digest('hex').slice(0, 16)}`;
}
