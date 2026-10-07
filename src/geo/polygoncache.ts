/**
 * Decoded coastline polygons kept per thread, so the same records are not
 * decoded from the shapefile again for every box that touches them.
 *
 * Before (brain, 2026-10-06): a route decoded every polygon touching each
 * leg's box and each stop's box (nine decodes for a four-leg route, the
 * North American mainland ring alone 13 MB each time), and the data
 * worker decoded them again for every raster it built for the map (253
 * rasters when a new region was viewed). Each decode allocated and dropped
 * the ring coordinates; the allocator kept the freed space.
 *
 * Now `forEach(path, clip, fn)` gives, in file order, exactly the polygons
 * `readShapefilePolygons(path, clip)` gives (the same bounding-box test on
 * the same records, through the ShapefileIndex), decoding only those not
 * in the cache. Entries are kept under a byte budget, least recently used
 * dropped first; a box whose polygons exceed the budget streams through
 * the cache (decode, use, drop the oldest) and is no worse than before.
 * One cache per thread: each worker has its own module instance.
 */

import type { BBox } from './geodesy';
import { ShapefileIndex, type ShapePolygon } from './shapefile';

/** Resident bytes of a polygon: its ring coordinates plus a little per ring. */
export function polygonBytes(s: ShapePolygon): number {
  let b = 64;
  for (const r of s.rings) b += r.coords.byteLength + 48;
  return b;
}

/**
 * Budget per thread. Small on purpose: every worker has its own cache, and
 * a 128 MB budget per worker let the caches hold 105 MB together on brain
 * (2026-10-06).
 */
export const POLYGON_CACHE_DEFAULT_BYTES = 24 * 1024 * 1024;
/**
 * Records larger than this are decoded, used and dropped, never kept: the
 * continents (13–30 MB each in GSHHG full resolution) would take the whole
 * budget, and every worker kept its own copy.
 */
export const POLYGON_CACHE_MAX_RECORD_BYTES = 2 * 1024 * 1024;

interface Entry {
  shape: ShapePolygon;
  bytes: number;
}

export class PolygonCache {
  /** Insertion order = recency: a hit is re-inserted at the end. */
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  hits = 0;
  decodes = 0;
  evictions = 0;

  constructor(
    readonly budgetBytes: number = POLYGON_CACHE_DEFAULT_BYTES,
    readonly maxRecordBytes: number = POLYGON_CACHE_MAX_RECORD_BYTES
  ) {}

  private key(path: string, recordNumber: number): string {
    return `${path}#${recordNumber}`;
  }

  private get(k: string): ShapePolygon | null {
    const e = this.entries.get(k);
    if (!e) return null;
    this.entries.delete(k);
    this.entries.set(k, e);
    this.hits++;
    return e.shape;
  }

  private put(k: string, shape: ShapePolygon): void {
    const bytes = polygonBytes(shape);
    if (bytes > this.maxRecordBytes) return; // too big to keep (see POLYGON_CACHE_MAX_RECORD_BYTES)
    const old = this.entries.get(k);
    if (old) {
      this.entries.delete(k);
      this.bytes -= old.bytes;
    }
    this.entries.set(k, { shape, bytes });
    this.bytes += bytes;
    for (const [ok, oe] of this.entries) {
      if (this.bytes <= this.budgetBytes || ok === k) break;
      this.entries.delete(ok);
      this.bytes -= oe.bytes;
      this.evictions++;
    }
  }

  /**
   * Every polygon of `path` whose box intersects `clip`, in file order,
   * one at a time (as readShapefilePolygons(path, clip) would list them).
   * Returns how many were given.
   */
  forEach(path: string, clip: BBox, fn: (s: ShapePolygon) => void): number {
    const ix = ShapefileIndex.open(path);
    const hits = ix.hitIndices(clip);
    let reader: ReturnType<ShapefileIndex['openReader']> | null = null;
    let n = 0;
    try {
      for (const i of hits) {
        const k = this.key(path, ix.recordNumber(i));
        let s = this.get(k);
        if (!s) {
          if (!reader) reader = ix.openReader();
          s = reader.decode(i);
          this.decodes++;
          if (!s) continue; // null shape or no ring: never cached, never listed (as readShapefilePolygons)
          this.put(k, s);
        }
        fn(s);
        n++;
      }
    } finally {
      reader?.close();
    }
    return n;
  }

  /** The polygons of `paths` intersecting `clip`, file by file in file order (the fromShapefiles list). */
  read(paths: readonly string[], clip: BBox): ShapePolygon[] {
    const out: ShapePolygon[] = [];
    for (const p of paths) this.forEach(p, clip, s => out.push(s));
    return out;
  }

  /** Drop everything (tests; a changed coastline). */
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): { entries: number; bytes: number; budget_bytes: number; hits: number; decodes: number; evictions: number } {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      budget_bytes: this.budgetBytes,
      hits: this.hits,
      decodes: this.decodes,
      evictions: this.evictions,
    };
  }
}

/** The thread's cache (every worker thread has its own module instance). */
export const polygonCache = new PolygonCache();
