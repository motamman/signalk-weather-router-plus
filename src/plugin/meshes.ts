/**
 * Managed chart meshes: the catalogue of published meshes (the s57Work
 * build's `charts/mesh/index.json`, on R2 by default), the ones the
 * plugin config ticks for download, and their copies on disk.
 *
 * On disk, under `<data dir>/mesh/`: one folder per mesh named as in the
 * catalogue (`01CGD`), a mirror of the published `charts/mesh/<D>/`
 * folder (the mesh's own `index.json` — or `meshes.json` plus one
 * sub-folder per cluster — and the `.bin` tiles), plus a marker
 * `.wrp-mesh.json` written when the copy is complete, holding the
 * catalogue entry it was taken from. A download goes into `<D>.new/` and
 * is swapped into place when complete, so a route never sees a partial
 * mesh; the previous copy, if any, serves until then. A mesh unticked in
 * the config is deleted.
 *
 * The catalogue is read at start and once a day; a mesh whose catalogue
 * `build_date` is newer than its marker's is downloaded again. Downloads
 * run one at a time in a child process (childtask.ts `mesh-download`),
 * which reports progress through `<D>.new/.progress.json`.
 *
 * The route worker does not use this class: it lists the markers under
 * the store directory itself when a route starts (worker/route.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runChildTask } from './childtask';

/** One mesh as the catalogue lists it (s57Work build-mesh.yml, "Write charts/mesh/index.json"). */
export interface CatalogMesh {
  name: string;
  /** Relative to the catalogue's folder, e.g. `mesh/01CGD/`. */
  dir: string;
  archive: string;
  sidecar: string;
  build_date: string;
  chart_build_date: string | null;
  format: { magic: string; index_version: number; tile_deg: number; multi_cluster: boolean };
  triangles: number;
  bytes: number;
  clusters: { dir: string; box: [number, number, number, number] }[];
}

export interface Catalog {
  version: number;
  updated: string;
  meshes: CatalogMesh[];
}

/** The marker a complete copy carries. */
export interface MeshMarker {
  name: string;
  build_date: string;
  catalog: string;
  files: number;
  bytes: number;
  completed: string;
}

export type MeshState = 'absent' | 'downloading' | 'ready' | 'update' | 'error' | 'removing';

/** One row for the config panel and /api/status. */
export interface MeshRow {
  name: string;
  /** From DISTRICT_NAMES, else the name. */
  title: string;
  /** Built from the catalogue entry: area, dates, size, triangles, clusters. */
  description: string;
  /** `catalog`: listed by the catalogue (downloadable); `local`: found under the meshDir folder. */
  source: 'catalog' | 'local';
  ticked: boolean;
  /** A mesh the router opens (false: switched off in the config, kept on disk). */
  enabled: boolean;
  state: MeshState;
  /** Files copied so far and in total, while downloading. */
  progress: { files: number; total: number; bytes: number } | null;
  catalog_build_date: string | null;
  disk_build_date: string | null;
  bytes: number | null;
  error: string | null;
}

export interface MeshesStatus {
  catalog_url: string;
  catalog_updated: string | null;
  catalog_error: string | null;
  store_dir: string;
  meshes: MeshRow[];
}

/** The US Coast Guard districts the s57Work builds are named after (enc-sources.yaml). */
export const DISTRICT_NAMES: Record<string, string> = {
  '01CGD': 'District 1 — New England (ME, NH, MA, RI, CT, eastern NY)',
  '05CGD': 'District 5 — Mid-Atlantic (NJ, PA, DE, MD, VA, DC, NC)',
  '07CGD': 'District 7 — Southeast (SC, GA, Florida east coast, PR, USVI)',
  '08CGD': 'District 8 — Gulf Coast (Florida west coast, AL, MS, LA, TX)',
  '09CGD': 'District 9 — Great Lakes (OH, MI, IN, IL, WI, MN, western NY, northern PA)',
  '11CGD': 'District 11 — Southern California',
  '13CGD': 'District 13 — Pacific Northwest (OR, WA)',
  '14CGD': 'District 14 — Hawaii and the Pacific islands',
  '17CGD': 'District 17 — Alaska',
};

export const DEFAULT_MESH_CATALOG_URL = 'https://pub-281728c6a69f4f549cf0ec4e83f9fcde.r2.dev/US-ENC/charts/mesh/index.json';
/** The catalogue is read again this often. */
export const CATALOG_REFRESH_MS = 24 * 3600 * 1000;
const CATALOG_TIMEOUT_MS = 30_000;
export const MARKER_FILE = '.wrp-mesh.json';
export const PROGRESS_FILE = '.progress.json';

/** The folder a catalogue entry's files are read from: the catalogue URL's folder plus the entry's `dir`. */
export function meshBaseUrl(catalogUrl: string, mesh: CatalogMesh): string {
  const folder = catalogUrl.replace(/\/[^/]*$/, '/');
  // The catalogue sits in charts/mesh/; its `dir` is written relative to charts/ (`mesh/<D>/`).
  const dir = mesh.dir.replace(/^mesh\//, '').replace(/\/$/, '');
  return new URL(dir + '/', folder).toString();
}

/** A human line for a catalogue entry: area, chart and build dates, size, triangles. */
export function describeMesh(m: CatalogMesh): string {
  const boxes = m.clusters.map(c => c.box);
  const west = Math.min(...boxes.map(b => b[0]));
  const south = Math.min(...boxes.map(b => b[1]));
  const east = Math.max(...boxes.map(b => b[2]));
  const north = Math.max(...boxes.map(b => b[3]));
  const deg = (v: number, pos: string, neg: string): string => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;
  const parts = [
    `${deg(south, 'N', 'S')}–${deg(north, 'N', 'S')}, ${deg(west, 'E', 'W')}–${deg(east, 'E', 'W')}${m.clusters.length > 1 ? ` in ${m.clusters.length} parts` : ''}`,
    m.chart_build_date ? `chart ${m.chart_build_date.slice(0, 10)}` : null,
    `mesh ${m.build_date.slice(0, 10)}`,
    `${(m.bytes / 1e9).toFixed(1)} GB`,
    `${(m.triangles / 1e6).toFixed(1)} M triangles`,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function readMarker(dir: string): MeshMarker | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8')) as MeshMarker;
  } catch {
    return null;
  }
}

/**
 * The directories a router opens for a mesh folder: the folder itself
 * (one cluster, `index.json` at its root) or each cluster sub-folder of a
 * multi-cluster mesh (`meshes.json`).
 */
export function meshClusterDirs(dir: string): string[] {
  try {
    if (fs.existsSync(path.join(dir, 'index.json'))) return [dir];
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'meshes.json'), 'utf8')) as { meshes: { dir: string }[] };
    return m.meshes.map(c => path.join(dir, c.dir));
  } catch {
    return [];
  }
}

/**
 * Local meshes under the `meshDir` folder you manage yourself: the folder
 * is one mesh when it holds `index.json` or `meshes.json`, else every
 * sub-folder that does is a mesh named after the sub-folder. Described
 * from its index (extent, triangles); the s57Work sidecar
 * `<name>_mesh.json` beside it adds the chart and build dates when present.
 */
export function localMeshes(
  meshDir: string | null
): { name: string; dir: string; dirs: string[]; description: string; error: string | null }[] {
  if (!meshDir) return [];
  const one = (name: string, dir: string): { name: string; dir: string; dirs: string[]; description: string; error: string | null } => {
    const dirs = meshClusterDirs(dir);
    if (!dirs.length) return { name, dir, dirs, description: '', error: 'no index.json or meshes.json' };
    const parts: string[] = [];
    try {
      let tri = 0;
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (const d of dirs) {
        const ix = JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8')) as {
          west: number;
          south: number;
          east: number;
          north: number;
          triangles: number;
        };
        tri += ix.triangles;
        west = Math.min(west, ix.west);
        south = Math.min(south, ix.south);
        east = Math.max(east, ix.east);
        north = Math.max(north, ix.north);
      }
      const deg = (v: number, pos: string, neg: string): string => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;
      parts.push(
        `${deg(south, 'N', 'S')}–${deg(north, 'N', 'S')}, ${deg(west, 'E', 'W')}–${deg(east, 'E', 'W')}${dirs.length > 1 ? ` in ${dirs.length} parts` : ''}`
      );
      parts.push(`${(tri / 1e6).toFixed(1)} M triangles`);
      const side = [path.join(path.dirname(dir), `${name}_mesh.json`), path.join(dir, `${name}_mesh.json`)].find(p => fs.existsSync(p));
      if (side) {
        const s = JSON.parse(fs.readFileSync(side, 'utf8')) as { build_date?: string; chart_build_date?: string | null };
        if (s.chart_build_date) parts.push(`chart ${s.chart_build_date.slice(0, 10)}`);
        if (s.build_date) parts.push(`mesh ${s.build_date.slice(0, 10)}`);
      }
      return { name, dir, dirs, description: `local: ${dir} · ${parts.join(' · ')}`, error: null };
    } catch (err) {
      return { name, dir, dirs, description: `local: ${dir}`, error: (err as Error).message };
    }
  };
  try {
    if (meshClusterDirs(meshDir).length) return [one(path.basename(meshDir).replace(/_mesh$/, ''), meshDir)];
    return fs
      .readdirSync(meshDir)
      .filter(n => !n.startsWith('.'))
      .sort()
      .map(n => path.join(meshDir, n))
      .filter(d => {
        try {
          return fs.statSync(d).isDirectory() && meshClusterDirs(d).length > 0;
        } catch {
          return false;
        }
      })
      .map(d => one(path.basename(d).replace(/_mesh$/, ''), d));
  } catch (err) {
    return [{ name: path.basename(meshDir), dir: meshDir, dirs: [], description: `local: ${meshDir}`, error: (err as Error).message }];
  }
}

/** The ready meshes under a store directory: every folder with a complete marker. */
export function readyMeshDirs(storeDir: string): { name: string; dirs: string[] }[] {
  let names: string[];
  try {
    names = fs.readdirSync(storeDir).filter(n => !n.startsWith('.') && !n.endsWith('.new'));
  } catch {
    return [];
  }
  const out: { name: string; dirs: string[] }[] = [];
  for (const n of names.sort()) {
    const dir = path.join(storeDir, n);
    if (!readMarker(dir)) continue;
    const dirs = meshClusterDirs(dir);
    if (dirs.length) out.push({ name: n, dirs });
  }
  return out;
}

export class MeshManager {
  private catalog: Catalog | null = null;
  private catalogError: string | null = null;
  private catalogUrl = DEFAULT_MESH_CATALOG_URL;
  private ticked: string[] = [];
  private disabled: string[] = [];
  private storeDir = '';
  private meshDir: string | null = null;
  private errors = new Map<string, string>();
  private downloading: string | null = null;
  private removing = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ctrl: AbortController | null = null;
  /** A refresh started before `run` (the coastline still downloading): `stop` aborts its read and its pass. */
  private refreshCtrl: AbortController | null = null;
  /** The pass running now (or queued): its signal and its promise. */
  private reconciling: { signal: AbortSignal; done: Promise<void> } | null = null;
  /** The catalogue read a `refresh` is waiting on: concurrent refreshes share it. */
  private catalogRead: Promise<void> | null = null;

  constructor(private readonly log: (m: string) => void) {}

  /** Apply a configuration; the next `run` reconciles the store with it. */
  configure(catalogUrl: string, ticked: string[], storeDir: string, disabled: string[] = [], meshDir: string | null = null): void {
    this.catalogUrl = catalogUrl;
    this.ticked = [...new Set(ticked.map(n => n.trim()).filter(Boolean))];
    this.disabled = [...new Set(disabled.map(n => n.trim()).filter(Boolean))];
    this.storeDir = storeDir;
    this.meshDir = meshDir;
  }

  /** Read the catalogue, download what is ticked and missing or stale, delete what is unticked; then again daily. */
  run(): void {
    this.stop();
    this.ctrl = new AbortController();
    const loop = async (): Promise<void> => {
      const signal = this.ctrl!.signal;
      while (!signal.aborted) {
        await this.reconcile(signal);
        await new Promise<void>(resolve => {
          this.timer = setTimeout(resolve, CATALOG_REFRESH_MS);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    };
    void loop();
  }

  /**
   * The panel's "Read the catalogue now" button: read the catalogue at once
   * (awaited, the same timeout as at start) and then run the usual pass in
   * the background (download what is ticked and missing or stale, delete
   * what is unticked). Not awaited past the read: a pass may download
   * gigabytes, and a pass already running (its downloads included) is
   * shared, not doubled nor waited for. Concurrent refreshes share one
   * read. Before `run` (the plugin still downloading the coastline) the
   * work runs on a controller of its own, which `stop` aborts like the
   * loop's.
   */
  async refresh(): Promise<void> {
    const signal = this.ctrl?.signal ?? (this.refreshCtrl ??= new AbortController()).signal;
    if (!this.catalogRead) {
      this.catalogRead = this.fetchCatalog(signal).finally(() => {
        this.catalogRead = null;
      });
    }
    await this.catalogRead;
    if (signal.aborted) return;
    void this.reconcile(signal).catch(() => undefined);
  }

  stop(): void {
    this.ctrl?.abort();
    this.ctrl = null;
    this.refreshCtrl?.abort();
    this.refreshCtrl = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * One pass now (start, or a saved configuration). Serialised: a caller
   * with the pass's own signal shares it; any other caller (a new `run`
   * after `stop`, whose signal is fresh while the old pass winds down on
   * its aborted one) waits for it and then gets a pass of its own.
   */
  reconcile(signal?: AbortSignal): Promise<void> {
    const s = signal ?? new AbortController().signal;
    const active = this.reconciling;
    if (active && active.signal === s) return active.done;
    const done = (active ? active.done.catch(() => undefined) : Promise.resolve())
      .then(() => this.reconcileOnce(s))
      .finally(() => {
        if (this.reconciling?.done === done) this.reconciling = null;
      });
    this.reconciling = { signal: s, done };
    return done;
  }

  private async reconcileOnce(signal: AbortSignal): Promise<void> {
    await this.fetchCatalog(signal);
    if (signal.aborted) return;
    fs.mkdirSync(this.storeDir, { recursive: true });
    // Unticked meshes go, including stale .new folders.
    for (const n of this.onDisk()) {
      if (this.ticked.includes(n)) continue;
      this.removing.add(n);
      try {
        fs.rmSync(path.join(this.storeDir, n), { recursive: true, force: true });
        fs.rmSync(path.join(this.storeDir, `${n}.new`), { recursive: true, force: true });
        this.log(`mesh ${n}: removed (not in the download list)`);
      } catch (err) {
        this.errors.set(n, `removal failed: ${(err as Error).message}`);
      }
      this.removing.delete(n);
    }
    // Ticked meshes: missing or older than the catalogue → download, one at a time. A local mesh's name is not one.
    const localNames = new Set(localMeshes(this.meshDir).map(m => m.name));
    for (const n of this.ticked) {
      if (signal.aborted) return;
      if (localNames.has(n)) continue;
      const entry = this.catalog?.meshes.find(m => m.name === n);
      if (!entry) {
        if (this.catalog) this.errors.set(n, 'not in the catalogue');
        continue;
      }
      const marker = readMarker(path.join(this.storeDir, n));
      if (marker && marker.build_date === entry.build_date) continue;
      await this.download(entry, signal);
    }
  }

  private async fetchCatalog(signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch(this.catalogUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const c = (await res.json()) as Catalog;
      if (!c || !Array.isArray(c.meshes)) throw new Error('not a mesh catalogue (no meshes[])');
      this.catalog = c;
      this.catalogError = null;
    } catch (err) {
      this.catalogError = (err as Error).message;
      this.log(`mesh catalogue ${this.catalogUrl}: ${this.catalogError}`);
    }
  }

  private async download(entry: CatalogMesh, signal: AbortSignal): Promise<void> {
    const dest = path.join(this.storeDir, entry.name);
    const tmp = `${dest}.new`;
    this.downloading = entry.name;
    this.errors.delete(entry.name);
    const t0 = Date.now();
    try {
      this.log(`mesh ${entry.name}: downloading ${(entry.bytes / 1e9).toFixed(1)} GB from ${meshBaseUrl(this.catalogUrl, entry)}`);
      const r = await runChildTask({ task: 'mesh-download', base: meshBaseUrl(this.catalogUrl, entry), dest: tmp }, 6 * 3600_000, signal);
      if (signal.aborted) return;
      const marker: MeshMarker = {
        name: entry.name,
        build_date: entry.build_date,
        catalog: this.catalogUrl,
        files: r.files,
        bytes: r.bytes,
        completed: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(tmp, MARKER_FILE), JSON.stringify(marker, null, 1));
      fs.rmSync(path.join(tmp, PROGRESS_FILE), { force: true });
      // Swap: the old copy (if any) served until now.
      const old = `${dest}.old`;
      fs.rmSync(old, { recursive: true, force: true });
      if (fs.existsSync(dest)) fs.renameSync(dest, old);
      fs.renameSync(tmp, dest);
      fs.rmSync(old, { recursive: true, force: true });
      this.log(
        `mesh ${entry.name}: ready, ${r.files} files, ${(r.bytes / 1e9).toFixed(2)} GB in ${((Date.now() - t0) / 1000).toFixed(0)} s`
      );
    } catch (err) {
      // Stopped (the child was killed): not an error; the next run resumes the copy.
      if (signal.aborted) return;
      this.errors.set(entry.name, (err as Error).message);
      this.log(`mesh ${entry.name}: download failed: ${(err as Error).message}`);
    } finally {
      this.downloading = null;
    }
  }

  private onDisk(): string[] {
    try {
      return fs
        .readdirSync(this.storeDir)
        .filter(n => !n.startsWith('.'))
        .map(n => n.replace(/\.(new|old)$/, ''))
        .filter((n, i, a) => a.indexOf(n) === i);
    } catch {
      return [];
    }
  }

  private progressOf(name: string): MeshRow['progress'] {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(this.storeDir, `${name}.new`, PROGRESS_FILE), 'utf8')) as {
        files: number;
        total: number;
        bytes: number;
      };
      return { files: p.files, total: p.total, bytes: p.bytes };
    } catch {
      return null;
    }
  }

  /** Every mesh the catalogue lists (and any on disk the catalogue no longer has), with its state. */
  status(): MeshesStatus {
    const local = localMeshes(this.meshDir);
    const localNames = new Set(local.map(m => m.name));
    // A local mesh's name in the download list (ticked in an earlier panel) is not a catalogue mesh.
    const names = new Set<string>([
      ...(this.catalog?.meshes.map(m => m.name) ?? []),
      ...this.onDisk(),
      ...this.ticked.filter(n => !localNames.has(n)),
    ]);
    const rows: MeshRow[] = [];
    for (const name of [...names].sort()) {
      const entry = this.catalog?.meshes.find(m => m.name === name) ?? null;
      const marker = readMarker(path.join(this.storeDir, name));
      const ticked = this.ticked.includes(name);
      let state: MeshState = 'absent';
      if (this.removing.has(name)) state = 'removing';
      else if (this.downloading === name) state = 'downloading';
      else if (this.errors.has(name)) state = 'error';
      else if (marker && entry && marker.build_date !== entry.build_date) state = 'update';
      else if (marker) state = 'ready';
      rows.push({
        name,
        title: DISTRICT_NAMES[name] ?? name,
        description: entry ? describeMesh(entry) : 'not in the catalogue',
        source: 'catalog',
        ticked,
        enabled: !this.disabled.includes(name),
        state,
        progress: state === 'downloading' ? this.progressOf(name) : null,
        catalog_build_date: entry?.build_date ?? null,
        disk_build_date: marker?.build_date ?? null,
        bytes: entry?.bytes ?? marker?.bytes ?? null,
        error: this.errors.get(name) ?? null,
      });
    }
    // Local meshes (the folder managed by hand), after the catalogue's.
    for (const m of local) {
      rows.push({
        name: m.name,
        title: DISTRICT_NAMES[m.name] ?? m.name,
        description: m.description,
        source: 'local',
        ticked: true,
        enabled: !this.disabled.includes(m.name),
        state: m.error ? 'error' : 'ready',
        progress: null,
        catalog_build_date: null,
        disk_build_date: null,
        bytes: null,
        error: m.error,
      });
    }
    return {
      catalog_url: this.catalogUrl,
      catalog_updated: this.catalog?.updated ?? null,
      catalog_error: this.catalogError,
      store_dir: this.storeDir,
      meshes: rows,
    };
  }
}
