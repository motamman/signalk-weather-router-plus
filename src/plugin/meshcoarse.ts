/**
 * The rough cuts of the chart meshes (engine/mesh/coarse.ts) on disk, and
 * the two child tasks that use them (childtask.ts): `mesh-coarse` builds
 * one mesh's rough cut for one boat, `mesh-reach` finds a leg's reach on
 * it (whether water connects the ends, and the box of the tiles it runs
 * through). Both read mesh tiles, so they run in child processes and the
 * tiles never stay in Signal K's memory.
 *
 * Kept under `<data dir>/mesh-coarse/`, two files per mesh build, boat,
 * buffer and Drawbridges choice:
 * `<build key>-v<version>-d<draught>-a<air draft>-b<buffer>-<o|x>.json`
 * (the pieces and links; o: opening bridges open, x: avoided) and the same
 * name with `.bnd` (the tile-boundary triangles, raw
 * Int32: the count blocked, the count of opening bridges, then the ids of
 * each, ascending), the build key a hash of the mesh's index.json (a new
 * build is a new key). The `.bnd` is written first: a `.json` means both
 * are there. Built after a mesh is downloaded or updated, on the plugin
 * configuration's Rebuild button, and by a route that needs one not built
 * yet; never at plugin start (the owner's choice, 2026-10-12).
 *
 * Beside a map, one joins file per other mesh it overlaps
 * (engine/mesh/joins.ts, part 5): the same name with `.joins-<the other
 * mesh's build key>.bin`, raw Int32: JOINS_VERSION, the count, then per
 * join this mesh's tile position and piece (local number), the other
 * mesh's tile position and piece. Built in the same pass as the map, before
 * it is written, and on its own (`mesh-joins`) when the other mesh is a
 * build the map has none for (downloaded or updated since). The owner
 * accepted the time, once per boat and build (2026-10-13; measured: 05CGD's
 * build 18.9 s, with its joins to 07CGD 59.3 s; 08CGD's 30.6 s and 117.5 s).
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BBox, boxesMeet, latLonText } from '../geo/geodesy';
import {
  boundarySeeds,
  buildCoarseMap,
  type CoarseMap,
  type CoarseRules,
  COARSE_VERSION,
  coarseRoute,
  meshRulesOf,
  PieceGraph,
  tilePieces,
} from '../engine/mesh/coarse';
import { JoinFinder, JOINS_VERSION } from '../engine/mesh/joins';
import { type BoundarySeeds, PagedMesh, type PagedTile } from '../engine/mesh/paged';
import type { MeshRules } from '../engine/mesh/route';
import { MeshStore } from '../engine/mesh/store';
import { DEFAULT_OVERHEAD_M, DEFAULT_UKC_M } from '../vessel/vessel';

export const COARSE_DIR = 'mesh-coarse';
/** Rough cuts kept per mesh build (other boats' maps beyond these are removed, oldest first). */
export const COARSE_KEEP_PER_MESH = 4;

/** The key of a mesh build: a hash of its index.json (one per cluster folder). */
export function coarseKey(meshDir: string): string {
  return createHash('sha1')
    .update(fs.readFileSync(path.join(meshDir, 'index.json')))
    .digest('hex')
    .slice(0, 16);
}

/** The rough-cut file (.json) of a mesh folder for a boat, buffer and Drawbridges choice. */
export function coarseFile(dataDir: string, meshDir: string, rules: CoarseRules): string {
  const r = rules;
  return path.join(
    dataDir,
    COARSE_DIR,
    `${coarseKey(meshDir)}-v${COARSE_VERSION}-d${r.draughtM.toFixed(2)}-a${r.airDraftM.toFixed(2)}-u${r.underKeelClearanceM.toFixed(2)}-o${r.overheadClearanceM.toFixed(2)}-b${r.bufferM.toFixed(2)}-${r.openingBridges === 'avoid' ? 'x' : 'o'}.json`
  );
}

/**
 * A rough cut's rules from a mesh leg's (the buffer absent: none; opening bridges absent: open), each length to the
 * centimetre the file name carries (coarseFile): one file is one set of rules, so a boat or buffer that differs
 * only past the centimetre (2.31648 m, a buffer of 9.999999999999988 m saved in feet) reads the cut the name
 * promises instead of being refused by it (readCoarseMap compares exactly).
 */
export function coarseRulesOf(
  rules: Pick<MeshRules, 'draughtM' | 'airDraftM' | 'bufferM' | 'openingBridges' | 'underKeelClearanceM' | 'overheadClearanceM'>
): CoarseRules {
  const cm = (m: number): number => Math.round(m * 100) / 100;
  return {
    draughtM: cm(rules.draughtM),
    airDraftM: cm(rules.airDraftM),
    underKeelClearanceM: cm(rules.underKeelClearanceM ?? DEFAULT_UKC_M),
    overheadClearanceM: cm(rules.overheadClearanceM ?? DEFAULT_OVERHEAD_M),
    bufferM: cm(rules.bufferM ?? 0),
    openingBridges: rules.openingBridges === 'avoid' ? 'avoid' : 'open',
  };
}

/** A build lock older than this is from a build that died (the child tasks' own limit is 15 minutes). */
const BUILD_LOCK_STALE_MS = 20 * 60_000;
/** How often a build waiting on another's lock looks again. */
const BUILD_LOCK_POLL_MS = 1000;
/** A lock's guard without a pid older than this was left by a step that died before writing it (a step holds it for one read, stat and remove). */
const GUARD_STALE_MS = 30_000;
/** When this process started (process-wide, worker threads included): a guard with this pid dated before it is an earlier process's. */
const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid on a lock's first line, or 0. */
function lockPid(text: string): number {
  const pid = Number(text.split('\n')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * A lock as it is on disk: its date and its text, or undefined when it is gone. The text is null for a lock that is
 * there and cannot be read as a file (a folder of that name, as a lock made with mkdir is; a file this process may
 * not read). Such a lock names no process, so only its age says whether it is still held; waiting on it is a poll,
 * where reading it again at once never ended.
 */
function lockOnDisk(lock: string): { text: string | null; mtimeMs: number } | undefined {
  let mtimeMs: number;
  const gone = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
  try {
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch (err) {
    if (gone(err)) return undefined;
    throw err;
  }
  try {
    return { text: fs.readFileSync(lock, 'utf8'), mtimeMs };
  } catch (err) {
    return gone(err) ? undefined : { text: null, mtimeMs };
  }
}

/**
 * Remove `lock` when `same` holds for its contents and date, holding `<lock>.guard` (created exclusively), so a stale
 * lock's removal and its owner's release never interleave and neither removes a lock taken anew meanwhile. False
 * when another holds the guard (try again). A guard left by a process that died inside this synchronous step is
 * removed: its pid gone; this process's pid on a guard dated before this process started (the pid reused); or no pid
 * (died before writing it) and older than GUARD_STALE_MS. A guard whose owner is alive is never removed for its age.
 */
function removeLockIf(lock: string, same: (text: string | null, mtimeMs: number) => boolean): boolean {
  const guard = `${lock}.guard`;
  let fd: number;
  try {
    fd = fs.openSync(guard, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      const pid = lockPid(fs.readFileSync(guard, 'utf8'));
      const mtimeMs = fs.statSync(guard).mtimeMs;
      const dead =
        pid === 0 ? Date.now() - mtimeMs > GUARD_STALE_MS : pid === process.pid ? mtimeMs < PROCESS_START_MS : !processAlive(pid);
      if (dead) fs.rmSync(guard, { force: true });
    } catch {
      /* gone meanwhile */
    }
    return false;
  }
  try {
    try {
      fs.writeSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    const on = lockOnDisk(lock);
    // Gone already, or the lock to remove (a folder with what it holds).
    if (on && same(on.text, on.mtimeMs)) fs.rmSync(lock, { force: true, recursive: true });
    return true;
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

/**
 * Run `build` for `file` (a rough cut, or a joins file) holding `<file>.lock`, created exclusively, so the main
 * thread's rebuild and a route's own build never build the same file at once (each in its own child process, the
 * same work twice). A build finding the lock taken waits for it to go, then calls `build` itself unless the file is
 * built by then (result null: the other build made it; `waited` tells the caller). What built means is the caller's
 * to say, `opts.built`: roughCutBuilt for a rough cut, joinsBuilt for a joins file; this has no test of its own. A
 * lock left by a process that is gone, or older than BUILD_LOCK_STALE_MS, is removed; one that cannot be read as a
 * file (lockOnDisk) by its age alone. Cancelled through `signal` while waiting.
 */
export async function withBuildLock<T>(
  file: string,
  build: () => Promise<T>,
  opts: { built: () => boolean; signal?: AbortSignal; onWait?: () => void }
): Promise<{ waited: boolean; result: T | null }> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // This call's own token (pid first): only the lock that still holds it is this call's to release.
  const token = `${process.pid}\n${randomUUID()}\n`;
  const pause = (): Promise<void> => new Promise(r => setTimeout(r, BUILD_LOCK_POLL_MS));
  let waited = false;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('build cancelled');
    let fd: number | null = null;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      try {
        // Another build finished while this one waited: its file is the same one this would write.
        if (waited && opts.built()) return { waited, result: null };
        return { waited, result: await build() };
      } finally {
        while (!removeLockIf(lock, text => text === token)) await pause();
      }
    }
    // Taken: the holder's pid and the lock's age decide whether it is still building.
    const on = lockOnDisk(lock);
    if (!on) continue; // gone meanwhile: try again
    const { text, mtimeMs } = on;
    const pid = text === null ? 0 : lockPid(text);
    const stale = Date.now() - mtimeMs > BUILD_LOCK_STALE_MS || (pid !== 0 && pid !== process.pid && !processAlive(pid));
    if (stale) {
      // Removed only while it is still the lock inspected (same contents and date), not one taken anew since.
      if (!removeLockIf(lock, (t, m) => t === text && m === mtimeMs)) await pause();
      continue;
    }
    if (!waited) opts.onWait?.();
    waited = true;
    await new Promise(r => setTimeout(r, BUILD_LOCK_POLL_MS));
  }
}

/**
 * A rough cut taken into use: its map and boundary file dated now, so pruneCoarse, which keeps the newest
 * COARSE_KEEP_PER_MESH per build by date, never removes the one a route is reading. Best effort: a file that cannot be
 * re-dated is still used.
 */
export function markCoarseUsed(mapFile: string): void {
  const now = new Date();
  for (const f of [mapFile, boundaryFile(mapFile)]) {
    try {
      fs.utimesSync(f, now, now);
    } catch {
      /* gone or read-only: the route reads it as it is */
    }
  }
}

/**
 * Whether a rough cut is built: its map file is there. The file's name carries the mesh build, the version and the
 * rules (coarseFile), and it is written last, by a rename, after its boundary file: one that is there is the one wanted.
 */
export function roughCutBuilt(mapFile: string): boolean {
  return fs.existsSync(mapFile);
}

/** The tile-boundary file (.bnd) beside a rough-cut file. */
export function boundaryFile(mapFile: string): string {
  return mapFile.replace(/\.json$/, '.bnd');
}

export function writeBoundary(file: string, b: BoundarySeeds): void {
  const out = new Int32Array(2 + b.blocked.length + b.bridges.length);
  out[0] = b.blocked.length;
  out[1] = b.bridges.length;
  out.set(b.blocked, 2);
  out.set(b.bridges, 2 + b.blocked.length);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  fs.renameSync(tmp, file);
}

export function readBoundary(file: string): BoundarySeeds {
  const buf = fs.readFileSync(file);
  const all = new Int32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const nb = all[0];
  const nr = all[1];
  if (all.length !== 2 + nb + nr) throw new Error(`${path.basename(file)}: ${all.length} values, expected ${2 + nb + nr}`);
  return { blocked: all.subarray(2, 2 + nb), bridges: all.subarray(2 + nb) };
}

/** Whether two mesh folders' extents (their indexes) meet: only then can their waters join. */
export function meshesMeet(dirA: string, dirB: string): boolean {
  return boxesMeet(MeshStore.open(dirA).index, MeshStore.open(dirB).index);
}

/** The joins file of a rough cut (its map file) towards another mesh folder. */
export function joinsFile(mapFile: string, otherDir: string): string {
  return mapFile.replace(/\.json$/, `.joins-${coarseKey(otherDir)}.bin`);
}

export function writeJoins(file: string, joins: Int32Array): void {
  const out = new Int32Array(2 + joins.length);
  out[0] = JOINS_VERSION;
  out[1] = joins.length / 4;
  out.set(joins, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  fs.renameSync(tmp, file);
}

/** A joins file's joins (4 numbers each), or null when there is none, it is of another version or it is cut short. */
export function readJoins(file: string): Int32Array | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  // Whole 32-bit numbers only: a file cut inside one is not a joins file (and a typed array of it cannot be made).
  if (buf.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) return null;
  const all = new Int32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (all.length < 2 || all[0] !== JOINS_VERSION || all.length !== 2 + 4 * all[1]) return null;
  return all.subarray(2);
}

/**
 * Whether a joins file is built: there and read as joins (readJoins). Its name carries no version (a rough cut's
 * does: roughCutBuilt), so a file of another version, or cut short, is there and not built, and is built again; a test
 * of the file being there took it as built, and its reader (meshwaters.ts) then found no joins.
 */
export function joinsBuilt(file: string): boolean {
  return readJoins(file) !== null;
}

/** The other mesh's tile-boundary record for the rules: from its rough cut's `.bnd` when there, else read and written now. */
function boundaryOf(store: MeshStore, mapFile: string, rules: CoarseRules): BoundarySeeds {
  const f = boundaryFile(mapFile);
  if (fs.existsSync(f)) return readBoundary(f);
  const b = boundarySeeds(store, rules);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeBoundary(f, b);
  return b;
}

/**
 * The joins from mesh A (paged under the rules, its boundary record) to another mesh: a finder in A's frame, and a
 * record of each join as A's tile position and piece, B's tile position and piece, each once.
 */
function joinsTo(pa: PagedMesh, storeA: MeshStore, other: { dir: string; mapFile: string }, rules: CoarseRules) {
  const storeB = MeshStore.open(other.dir);
  // B in A's frame: the same scale, laid out about the same longitude (paged.ts centred).
  const pb = new PagedMesh(storeB, meshRulesOf(rules), pa.cl, boundaryOf(storeB, other.mapFile, rules)).centred(pa.frameLon);
  const finder = new JoinFinder({ store: storeA, pm: pa }, { store: storeB, pm: pb });
  const bPieces = new Map<number, Int32Array>();
  const seen = new Set<string>();
  const out: number[] = [];
  let ms = 0;
  return {
    /** Record the joins of one tile of A (its pieces, local numbers), when it meets B. */
    tile(idx: number, T: PagedTile, pieceOf: Int32Array): void {
      if (!finder.meetsB(T.bbox)) return;
      const t0 = Date.now();
      finder.scanTile(T, (a, u) => {
        const U = pb.tileOf(u);
        let up = bPieces.get(U.idx);
        if (!up) {
          up = tilePieces(U).pieceOf;
          bPieces.set(U.idx, up);
        }
        const k = `${idx},${pieceOf[a - T.first]},${U.idx},${up[u - U.first]}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(idx, pieceOf[a - T.first], U.idx, up[u - U.first]);
      });
      ms += Date.now() - t0;
    },
    result: (): { joins: Int32Array; ms: number } => ({ joins: Int32Array.from(out), ms }),
  };
}

/**
 * Remove the rough cuts of builds no longer in use (`liveKeys`) or of
 * another version, and beyond COARSE_KEEP_PER_MESH per build the least recently built or used (markCoarseUsed)
 * (a map, its boundary file and its joins files go together); and joins
 * files towards a build no longer in use. Returns how many maps went.
 */
export function pruneCoarse(dataDir: string, liveKeys: Set<string>): number {
  const dir = path.join(dataDir, COARSE_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return 0;
  }
  let removed = 0;
  const joinsOf = (n: string): string[] => {
    const base = n.replace(/\.json$/, '.joins-');
    try {
      return fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.bin'));
    } catch {
      return [];
    }
  };
  const rm = (n: string): void => {
    fs.rmSync(path.join(dir, n), { force: true });
    fs.rmSync(boundaryFile(path.join(dir, n)), { force: true });
    for (const j of joinsOf(n)) fs.rmSync(path.join(dir, j), { force: true });
    removed++;
  };
  // Joins towards a build no longer in use go on their own.
  for (const n of names)
    for (const j of joinsOf(n))
      if (!liveKeys.has(j.replace(/^.*\.joins-/, '').replace(/\.bin$/, ''))) fs.rmSync(path.join(dir, j), { force: true });
  const byKey = new Map<string, { name: string; mtimeMs: number }[]>();
  for (const n of names) {
    const [key, version] = n.split('-');
    const p = path.join(dir, n);
    if (!liveKeys.has(key) || version !== `v${COARSE_VERSION}`) {
      rm(n);
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    const list = byKey.get(key) ?? [];
    list.push({ name: n, mtimeMs });
    byKey.set(key, list);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of list.slice(COARSE_KEEP_PER_MESH)) rm(old.name);
  }
  return removed;
}

/** A rough cut read from disk for a mesh and the rules, or why it cannot be used (another build or other rules). */
export function readCoarseMap(file: string, store: MeshStore, rules: CoarseRules, name: string): CoarseMap | string {
  const map = JSON.parse(fs.readFileSync(file, 'utf8')) as CoarseMap;
  if (
    map.version !== COARSE_VERSION ||
    map.triangles !== store.index.triangles ||
    map.draughtM !== rules.draughtM ||
    map.airDraftM !== rules.airDraftM ||
    map.underKeelClearanceM !== rules.underKeelClearanceM ||
    map.overheadClearanceM !== rules.overheadClearanceM ||
    map.bufferM !== rules.bufferM ||
    map.openingBridges !== rules.openingBridges
  )
    return `the rough cut of ${name} on disk is for another build of the mesh or other rules; rebuild it in the plugin configuration`;
  return map;
}

export interface MeshCoarseTask {
  task: 'mesh-coarse';
  dir: string;
  out: string;
  rules: CoarseRules;
  /** The other meshes whose extent meets this one's, each with its rough-cut map file for the rules: joins to each. */
  joins?: { dir: string; mapFile: string; name: string }[];
}

export interface MeshCoarseResult {
  pieces: number;
  links: number;
  /** Tile-boundary triangles blocked for the boat, and opening bridges among the boundary triangles. */
  boundaryBlocked: number;
  boundaryBridges: number;
  /** Bytes of the two files. */
  bytes: number;
  ms: number;
  /** The joins to each other mesh: how many, and the time they took inside the build. */
  joins: { name: string; joins: number; ms: number }[];
}

/**
 * Build one mesh folder's rough cut and write it, the boundary file first (each to a temporary name, then renamed:
 * a reader never sees half a file, and a map on disk has its boundary file beside it). Two passes over the tiles:
 * the boundary record, then every tile read through the paged mesh with it (the search's blocked sets).
 */
export function runMeshCoarseTask(t: MeshCoarseTask): MeshCoarseResult {
  const t0 = Date.now();
  const store = MeshStore.open(t.dir);
  const boundary = boundarySeeds(store, t.rules);
  fs.mkdirSync(path.dirname(t.out), { recursive: true });
  writeBoundary(boundaryFile(t.out), boundary);
  const ix = store.index;
  const pm = new PagedMesh(store, meshRulesOf(t.rules), Math.cos((((ix.south + ix.north) / 2) * Math.PI) / 180), boundary);
  // The joins to the other meshes, found in the same tile reads as the map.
  const others = (t.joins ?? []).map(o => ({ ...o, rec: joinsTo(pm, store, o, t.rules) }));
  const map = buildCoarseMap(store, t.rules, pm, (idx, T, pieceOf) => {
    for (const o of others) o.rec.tile(idx, T, pieceOf);
  });
  const joins: MeshCoarseResult['joins'] = [];
  for (const o of others) {
    const r = o.rec.result();
    writeJoins(joinsFile(t.out, o.dir), r.joins);
    joins.push({ name: o.name, joins: r.joins.length / 4, ms: r.ms });
  }
  const text = JSON.stringify(map);
  const tmp = `${t.out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, t.out);
  return {
    pieces: map.pieces.length,
    links: map.links.length,
    boundaryBlocked: boundary.blocked.length,
    boundaryBridges: boundary.bridges.length,
    bytes: text.length + 4 * (2 + boundary.blocked.length + boundary.bridges.length),
    ms: Date.now() - t0,
    joins,
  };
}

export interface MeshJoinsTask {
  task: 'mesh-joins';
  /** The mesh the joins are from, with its rough-cut map file (built: its boundary record is used). */
  dir: string;
  mapFile: string;
  rules: CoarseRules;
  /** The other mesh, with its rough-cut map file for the rules (its boundary record, read or written). */
  other: { dir: string; mapFile: string; name: string };
}

/**
 * One mesh's joins to another on their own (the other is a build the rough cut has none for): every tile of this mesh
 * meeting the other read under the rules with its boundary record, as the build reads it.
 */
export function runMeshJoinsTask(t: MeshJoinsTask): { joins: number; ms: number } {
  const t0 = Date.now();
  const store = MeshStore.open(t.dir);
  const ix = store.index;
  const pm = new PagedMesh(
    store,
    meshRulesOf(t.rules),
    Math.cos((((ix.south + ix.north) / 2) * Math.PI) / 180),
    readBoundary(boundaryFile(t.mapFile))
  );
  const rec = joinsTo(pm, store, t.other, t.rules);
  for (let idx = 0; idx < pm.tileCount; idx++) {
    const T = pm.tile(idx);
    rec.tile(idx, T, tilePieces(T).pieceOf);
    pm.drop(idx);
  }
  const r = rec.result();
  writeJoins(joinsFile(t.mapFile, t.other.dir), r.joins);
  return { joins: r.joins.length / 4, ms: Date.now() - t0 };
}

export interface MeshReachTask {
  task: 'mesh-reach';
  dir: string;
  mapFile: string;
  /** The leg's start, its waypoint circles in order, its end; a circle (radiusM) for an approximate waypoint. */
  points: { lon: number; lat: number; radiusM?: number; name: string }[];
  rules: CoarseRules;
  /** The request's areas to avoid. */
  avoid?: MeshRules['avoid'];
}

export type MeshReachResult =
  | {
      ok: true;
      box: BBox;
      lengthM: number;
      chainTiles: number;
      /**
       * Per point after the start: for an approximate waypoint, the point the leg aims at (the waypoint itself, or
       * the nearest usable water connected to the start), the triangle it was chosen in (global id: the point can
       * lie on a corner shared with a triangle of other water), and how far it lies from the waypoint; null for an
       * exact one.
       */
      aims: ({ lon: number; lat: number; tri: number; movedM: number } | null)[];
    }
  | { ok: false; reason: string };

/**
 * A leg's reach on the rough cut, under the request's rules (the rough cut's, plus its areas to avoid: PieceGraph).
 * The start and every exact point must lie on usable water connected to the start; an approximate waypoint aims at
 * itself when it does, else at the nearest usable water that does (part 3; the owner's choice: moved, with a
 * warning when outside its circle). Then the chains of pieces from each point to the next give the box of tiles
 * the water runs through.
 */
export function runMeshReachTask(t: MeshReachTask): MeshReachResult {
  const store = MeshStore.open(t.dir);
  const map = JSON.parse(fs.readFileSync(t.mapFile, 'utf8')) as CoarseMap;
  if (
    map.version !== COARSE_VERSION ||
    map.triangles !== store.index.triangles ||
    map.draughtM !== t.rules.draughtM ||
    map.airDraftM !== t.rules.airDraftM ||
    map.underKeelClearanceM !== t.rules.underKeelClearanceM ||
    map.overheadClearanceM !== t.rules.overheadClearanceM ||
    map.bufferM !== t.rules.bufferM ||
    map.openingBridges !== t.rules.openingBridges
  )
    return {
      ok: false,
      reason: 'the rough cut on disk is for another build of the mesh or other rules; rebuild it in the plugin configuration',
    };
  const lats = t.points.map(p => p.lat);
  const cl = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const pm = new PagedMesh(store, meshRulesOf(t.rules, t.avoid), cl, readBoundary(boundaryFile(t.mapFile)));
  const graph = new PieceGraph(map, pm);
  // Each point's pieces: of every usable triangle it touches (a corner or an edge can touch water of two groups).
  const piecesAt = (lon: number, lat: number): number[] => {
    const out: number[] = [];
    for (const tri of pm.locateAll(...pm.toXY(lon, lat))) {
      const q = graph.pieceOf(tri);
      if (q !== null && !out.includes(q)) out.push(q);
    }
    return out;
  };
  const at = t.points.map(p => (p.radiusM === undefined || p === t.points[0] ? piecesAt(p.lon, p.lat) : []));
  // The route's water: a connected group the start and every exact point touch.
  let groups: number[] | null = null;
  for (let k = 0; k < t.points.length; k++) {
    const p = t.points[k];
    if (k > 0 && p.radiusM !== undefined) continue;
    if (!at[k].length) return { ok: false, reason: unusable(pm, pm.locate(...pm.toXY(p.lon, p.lat), true), p.name, t.rules.bufferM) };
    const here = [...new Set(at[k].map(q => graph.component(q)))];
    groups = groups === null ? here : groups.filter(c => here.includes(c));
    if (!groups.length) return { ok: false, reason: noWater(p.name, t.rules) };
  }
  const group = groups![0];
  const pieces: number[] = [];
  const aims: ({ lon: number; lat: number; tri: number; movedM: number } | null)[] = [];
  for (let k = 0; k < t.points.length; k++) {
    const p = t.points[k];
    if (k === 0 || p.radiusM === undefined) {
      pieces.push(at[k].find(q => graph.component(q) === group)!);
      if (k > 0) aims.push(null);
      continue;
    }
    // An approximate waypoint: itself when it is usable water of the route's group, else the nearest that is.
    const nu = pm.nearestUsable(...pm.toXY(p.lon, p.lat), graph.waterOf([group]));
    if (!nu) return { ok: false, reason: noWater(p.name, t.rules) };
    const [lon, lat] = nu.distM > 0 ? pm.fromXY(nu.x, nu.y) : [p.lon, p.lat];
    pieces.push(graph.pieceOf(nu.tri)!);
    aims.push({ lon, lat, tri: nu.tri, movedM: nu.distM });
  }
  const chains: number[][] = [];
  for (let k = 1; k < pieces.length; k++) chains.push(coarseRoute(graph, pieces[k - 1], pieces[k])!);
  const r = graph.reach(chains);
  return { ok: true, box: r.box, lengthM: r.lengthM, chainTiles: r.chainTiles, aims };
}

/** Why a point's water is not usable: outside the mesh, blocked (with the charted depth), or within the buffer. */
function unusable(pm: PagedMesh, g: number, name: string, bufferM: number): string {
  if (g < 0) return `${name} is not on a triangle of the mesh`;
  const T = pm.tileOf(g);
  const l = g - T.first;
  if (!T.ruleBlocked[l]) return `${name} is within the buffer ({length:${bufferM}}) of water the boat cannot use`;
  const d = T.depth[l];
  return `${name} is on water the boat cannot use${d !== -999 ? ` (charted depth {depth:${d}})` : ' (a hazard, mark, structure, clearance or area to avoid)'}`;
}

function noWater(name: string, rules: CoarseRules): string {
  return `no water on the chart mesh connects the start and ${name} for this boat (draught {depth:${rules.draughtM}}, air draft {length:${rules.airDraftM}}${rules.bufferM > 0 ? `, keeping {length:${rules.bufferM}} from water it cannot use` : ''})`;
}

export interface MeshSnapTask {
  task: 'mesh-snap';
  dir: string;
  mapFile: string;
  /** The route's exact stops in this mesh, in route order (start, exact waypoints, end), each with its name. */
  points: { lon: number; lat: number; name: string }[];
  rules: CoarseRules;
  avoid?: MeshRules['avoid'];
  /** The farthest a stop is moved, metres (the owner's choice, 2026-10-12: 1,000 m); farther is an error. */
  maxMoveM: number;
}

/**
 * Per point: where it goes (itself when its water is usable and connected), how far, and why it moved;
 * `outsideGroup`: its water is not the route's on this mesh (moved to the route's with a warning, or, when that is
 * farther than the limit, left where it is for the leg's plan through other waters).
 */
export type MeshSnapResult =
  | { ok: true; points: { lon: number; lat: number; movedM: number; why: string | null; outsideGroup: boolean }[] }
  | { ok: false; reason: string };

/**
 * Snap the route's exact stops in one mesh (docs/drafts/mesh-no-gshhg-design.md, part 2; the owner's choices of
 * 2026-10-12): a stop on water the boat cannot use under the route's rules (blocked, in the buffer, or on land: no
 * triangle), or on water not connected to the route's, moves to the nearest usable water connected to the route,
 * at most `maxMoveM`. The route's water is the connected group of the last stop in this mesh (the destination, or
 * where the route leaves the mesh): its own when it is usable, else that of the usable water nearest it. So a start
 * in a pond moves out to water connected to the destination. A stop on usable water whose nearest route water is
 * farther than the limit stays (part 5: this mesh alone does not say whether open water or another mesh joins them).
 */
export function runMeshSnapTask(t: MeshSnapTask): MeshSnapResult {
  const store = MeshStore.open(t.dir);
  const map = JSON.parse(fs.readFileSync(t.mapFile, 'utf8')) as CoarseMap;
  if (
    map.version !== COARSE_VERSION ||
    map.triangles !== store.index.triangles ||
    map.draughtM !== t.rules.draughtM ||
    map.airDraftM !== t.rules.airDraftM ||
    map.underKeelClearanceM !== t.rules.underKeelClearanceM ||
    map.overheadClearanceM !== t.rules.overheadClearanceM ||
    map.bufferM !== t.rules.bufferM ||
    map.openingBridges !== t.rules.openingBridges
  )
    return {
      ok: false,
      reason: 'the rough cut on disk is for another build of the mesh or other rules; rebuild it in the plugin configuration',
    };
  const lats = t.points.map(p => p.lat);
  const cl = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const pm = new PagedMesh(store, meshRulesOf(t.rules, t.avoid), cl, readBoundary(boundaryFile(t.mapFile)));
  const graph = new PieceGraph(map, pm);
  const groupOf = (g: number): number | null => {
    const p = graph.pieceOf(g);
    return p === null ? null : graph.component(p);
  };
  // The groups of the usable water a point touches (a corner or an edge can touch water of two groups).
  const groupsAt = (px: number, py: number): number[] => [
    ...new Set(pm.locateAll(px, py).flatMap(tri => (groupOf(tri) === null ? [] : [groupOf(tri)!]))),
  ];
  // The route's water: the last stop's connected group (its own water, or the usable water nearest it); of several
  // its point touches, one the first stop touches too.
  const last = t.points[t.points.length - 1];
  const [lx, ly] = pm.toXY(last.lon, last.lat);
  let lastGroups = groupsAt(lx, ly);
  if (!lastGroups.length) {
    const nu = pm.nearestUsable(lx, ly);
    if (!nu) return { ok: false, reason: 'the chart mesh has no water this boat can use' };
    lastGroups = [groupOf(nu.tri)!];
  }
  const firstGroups = groupsAt(...pm.toXY(t.points[0].lon, t.points[0].lat));
  const group = lastGroups.find(c => firstGroups.includes(c)) ?? lastGroups[0];
  const out: Extract<MeshSnapResult, { ok: true }>['points'] = [];
  for (const p of t.points) {
    const [px, py] = pm.toXY(p.lon, p.lat);
    const here = groupsAt(px, py);
    if (here.includes(group)) {
      out.push({ lon: p.lon, lat: p.lat, movedM: 0, why: null, outsideGroup: false });
      continue;
    }
    const usable = here.length > 0;
    const why = usable
      ? 'its water does not connect to the route for this boat'
      : whyUnusable(pm, pm.locate(px, py, true), t.rules.bufferM);
    const nu = pm.nearestUsable(px, py, graph.waterOf([group]));
    if (!nu)
      return {
        ok: false,
        reason: `${p.name}, at ${latLonText(p.lat, p.lon)}, ${why}, and no usable water connected to the route was found`,
      };
    const [lon, lat] = pm.fromXY(nu.x, nu.y);
    // Usable water of its own that this mesh does not connect to the route's within the limit: the stop stays; its
    // leg is planned through the other waters (other charts, open water beyond them; engine/mesh/waters.ts), or fails
    // there saying the two waters do not connect.
    if (usable && nu.distM > t.maxMoveM) {
      out.push({ lon: p.lon, lat: p.lat, movedM: 0, why: null, outsideGroup: true });
      continue;
    }
    if (nu.distM > t.maxMoveM) {
      // The route's water is the last stop's: when this stop's nearest usable water is close but the nearest water
      // connected to the last stop is far, the last stop sits in water the boat cannot reach from here (an enclosed
      // pond, a bridged basin), and that is what to say.
      const near = pm.nearestUsable(px, py);
      const isolatedEnd = p !== last && near !== null && near.distM <= t.maxMoveM;
      return {
        ok: false,
        reason: isolatedEnd
          ? `${last.name} is in water this boat cannot reach from ${p.name} on the chart mesh (the water near ${p.name} does not connect to it); the nearest water connected to ${last.name} is {length:${nu.distM.toFixed(0)}} from ${p.name}, at ${latLonText(lat, lon)}; move ${last.name} into water the boat can enter, or ${p.name} there`
          : `${p.name}, at ${latLonText(p.lat, p.lon)}, ${why}; the nearest water this boat can use, connected to the route, is {length:${nu.distM.toFixed(0)}} away at ${latLonText(lat, lon)}, more than {length:${t.maxMoveM}}; move it there or into deeper water`,
      };
    }
    out.push({ lon, lat, movedM: nu.distM, why, outsideGroup: usable });
  }
  return { ok: true, points: out };
}

/** Why a point's water is not usable on the mesh: on land (no triangle), blocked (with what blocks it), or in the buffer. */
function whyUnusable(pm: PagedMesh, g: number, bufferM: number): string {
  if (g < 0) return 'is on land';
  const T = pm.tileOf(g);
  const l = g - T.first;
  if (!T.ruleBlocked[l]) return `is within {length:${bufferM}} of water the boat cannot use`;
  const d = T.depth[l];
  return d !== -999
    ? `is on charted depth {depth:${d}}, too shallow for this boat`
    : 'is on a hazard, mark, structure, low clearance or area to avoid';
}
