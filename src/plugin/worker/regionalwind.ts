/**
 * Which regional wind runs (signalk-grib-downloader runs decoded by the
 * data worker) apply to a route area at a departure: the newest decoded
 * run of each source whose grid is finer than the global forecast's, is
 * not over before the departure, and meets the area. Listed here, loaded
 * by the caller: the route worker windows them with its memory accounting
 * (route.ts), the mesh leg's child process windows them itself
 * (plugin/meshlegtask.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bboxWidth, type BBox } from '../../geo/geodesy';
import { type DecodedRun, openDecodedRun } from '../../data/decoded';
import { isFinerThanGlobal } from './regional';

export interface RegionalRun {
  name: string;
  run: DecodedRun;
  grid: DecodedRun['index']['grid'];
  firstMs: number;
  lastMs: number;
}

export function regionalRunsFor(root: string, area: BBox, departureMs: number, globalDLon: number): RegionalRun[] {
  let sources: string[];
  try {
    sources = fs.readdirSync(root).filter(n => !n.startsWith('.'));
  } catch {
    return [];
  }
  const out: RegionalRun[] = [];
  for (const name of sources) {
    let cycles: string[];
    try {
      cycles = fs
        .readdirSync(path.join(root, name))
        .filter(n => /^\d{10}$/.test(n))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    // The newest decoded run of the source.
    const { run } = cycles.length ? openDecodedRun(path.join(root, name, cycles[0])) : { run: null };
    if (!run) continue;
    const g = run.index.grid;
    // Only a grid finer than the global forecast's is layered over it.
    if (!isFinerThanGlobal(g.dLon, globalDLon)) continue;
    const steps = run.index.steps;
    const firstMs = steps[0].validMs;
    const lastMs = steps[steps.length - 1].validMs;
    if (lastMs < departureMs) continue; // over before the route starts
    // Does the route area meet the regional grid? Latitudes, and for a
    // grid that does not go all the way round the longitudes too: the
    // area's west edge is taken to within 180° of the grid's west edge
    // and its east edge compared the same way, so an area that starts
    // west of the grid and reaches into it is found.
    const gNorth = g.lat0 + (g.nLat - 1) * g.dLat;
    if (area.north < g.lat0 || area.south > gNorth) continue;
    if (!g.wrapLon) {
      const gEast = g.lon0 + (g.nLon - 1) * g.dLon;
      const aw = g.lon0 + (((area.west - g.lon0 + 540) % 360) - 180);
      const ae = aw + bboxWidth(area);
      if (ae < g.lon0 || aw > gEast) continue;
    }
    out.push({ name, run, grid: g, firstMs, lastMs });
  }
  return out;
}
