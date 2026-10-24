/**
 * Managed chart meshes: the catalogue of published meshes (the s57Work
 * build's `charts/mesh/index.json`, on R2 by default), the ones the
 * plugin config ticks for download, and their copies on disk.
 *
 * On disk, under `<data dir>/mesh/`: one folder per mesh named as in the
 * catalogue (`01CGD`), the published mesh folder unpacked from its archive
 * (the mesh's own `index.json` — or `meshes.json` plus one sub-folder per
 * cluster — and the `.bin` tiles), plus a marker `.wrp-mesh.json` written
 * when the copy is complete, holding the catalogue entry it was taken
 * from. A download fetches the catalogue's `archive` (`<D>_mesh.tar.zst`)
 * into the hidden working folder `.dl-<D>/` (resumed where it stopped),
 * unpacks it into `<D>.new/` and swaps that into place when complete and
 * checked, so a route never sees a partial mesh; the previous copy, if
 * any, serves until then (plugin/mesharchive.ts). A mesh unticked in the
 * config is deleted, with its working folder.
 *
 * A local mesh (the `meshDir` folder you manage yourself) with the same
 * name as a published one: whichever was built later is used (localWins:
 * the sidecar's build date against the catalogue's or the marker's; a
 * local mesh without a date loses). It stops the download only when it is
 * the newer, and the router opens only the newer copy (meshesToOpen).
 *
 * The catalogue is read at start and once a day; a mesh whose catalogue
 * `build_date` is newer than its marker's is downloaded again. Downloads
 * run MESH_DOWNLOADS_AT_ONCE at a time, each in a child process
 * (childtask.ts `mesh-download`), which reports progress through
 * `.dl-<D>/progress.json`.
 *
 * The route worker does not use this class: it lists the markers under
 * the store directory itself when a route starts (worker/route.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runChildTask } from './childtask';
import { INTERNET_HOLD_RETRY_MS, type DownloadHold } from './internet';
import { DOWNLOAD_PROGRESS_FILE, downloadWorkDir, type MeshDownloadProgress } from './mesharchive';

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

/** The panel's per-mesh actions (POST /api/meshes/:name/:action): download, update and redownload add the name to the download list, remove and cancel drop it. */
export const MESH_ACTIONS = ['download', 'update', 'redownload', 'remove', 'cancel'] as const;
export type MeshAction = (typeof MESH_ACTIONS)[number];

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
  /**
   * The copy the router opens for this name: the download or a local
   * folder of the same name (whichever was built later; see localWins),
   * or null when there is neither.
   */
  using: 'download' | 'local' | null;
  /** Why that copy: the owner's "my folder" choice, the newer build, or the only copy there is. */
  using_why: 'choice' | 'newer' | 'only' | null;
  /** The owner's choice for a name with two copies: automatic (the newer build), the folder's copy, or the download. */
  copy_choice: 'auto' | 'local' | 'download';
  /** A local folder with the same name as this catalogue mesh, and its build date (null: none, or no sidecar). */
  local_dir: string | null;
  local_build_date: string | null;
  state: MeshState;
  /** While downloading: the archive's bytes fetched (phase download) or read and unpacked (phase unpack) of its size, and the files written. */
  progress: MeshDownloadProgress | null;
  catalog_build_date: string | null;
  disk_build_date: string | null;
  bytes: number | null;
  error: string | null;
}

export interface MeshesStatus {
  catalog_url: string;
  catalog_updated: string | null;
  catalog_error: string | null;
  /** Catalogue rows set aside that have no usable name ("row 3: no name"); a named one is reported on its own row. */
  catalog_problems: string[];
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
/** A daily pass looks at the internet state this often while it downloads. */
export const HOLD_CHECK_MS = 60 * 1000;
const CATALOG_TIMEOUT_MS = 30_000;
export const MARKER_FILE = '.wrp-mesh.json';
/** Meshes downloaded at the same time (the owner's choice, 2026-10-18). */
export const MESH_DOWNLOADS_AT_ONCE = 2;

/**
 * A catalogue entry's archive: the catalogue sits in `charts/mesh/`, and its
 * `archive` (`<D>_mesh.tar.zst`) is published in `charts/`, as its `dir`
 * (`mesh/<D>/`) is written relative to `charts/`.
 */
export function meshArchiveUrl(catalogUrl: string, mesh: CatalogMesh): string {
  return new URL(mesh.archive, new URL('../', catalogUrl)).toString();
}

/** The folder the archive holds the mesh under (`<D>_mesh`, its name without `.tar.zst`). */
export function meshArchiveTop(mesh: CatalogMesh): string {
  return path.basename(mesh.archive).replace(/\.tar\.zst$/, '');
}

/** A mesh name as a folder name: letters, digits, - and _ (the panel's actions take the same). */
const MESH_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** A catalogue `archive`: a bare file name ending .tar.zst (no slash, no scheme, not starting with a dot). */
const ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.tar\.zst$/;

/**
 * Why a catalogue row cannot be used, or null: every field this plugin reads
 * (the download's archive and build date, the panel's description from the
 * clusters, size and triangles), checked when the catalogue is read, so one
 * bad row is reported on its own mesh instead of failing the download with a
 * bare TypeError or the panel's status as a whole.
 */
export function catalogEntryProblem(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'not an object';
  const e = m as Record<string, unknown>;
  const text = (k: string): string | null => (typeof e[k] === 'string' && (e[k] as string).trim() ? (e[k] as string) : null);
  const name = text('name');
  if (!name) return 'no name';
  if (!MESH_NAME.test(name)) return `name ${JSON.stringify(name)} is not letters, digits, - and _`;
  const archive = text('archive');
  if (!archive) return 'no archive (the mesh archive file, e.g. 01CGD_mesh.tar.zst)';
  // A bare file name published beside the catalogue (meshArchiveUrl): never a URL or a path, so a catalogue cannot
  // send the plugin's downloads to another address.
  if (!ARCHIVE_NAME.test(archive)) return `archive ${archive} is not a .tar.zst file name (letters, digits, ., - and _; no path or URL)`;
  const built = text('build_date');
  if (!built || Number.isNaN(Date.parse(built))) return 'no valid build_date';
  if (e.chart_build_date != null && (typeof e.chart_build_date !== 'string' || Number.isNaN(Date.parse(e.chart_build_date))))
    return 'chart_build_date is not a date';
  const num = (k: string): boolean => typeof e[k] === 'number' && Number.isFinite(e[k]) && (e[k] as number) >= 0;
  if (!num('bytes')) return 'no valid bytes';
  if (!num('triangles')) return 'no valid triangles';
  if (!Array.isArray(e.clusters) || e.clusters.length === 0) return 'no clusters';
  for (const c of e.clusters) {
    const box = (c as { box?: unknown } | null)?.box;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(v => typeof v === 'number' && Number.isFinite(v)))
      return 'a cluster has no valid box [west, south, east, north]';
  }
  return null;
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

/**
 * Whether a local mesh is used instead of a published (catalogue or
 * downloaded) copy of the same name: when it was built at the same time or
 * later. A local mesh without a build date (no sidecar) never wins; a
 * published copy without one always loses to a dated local mesh.
 */
export function localWins(localBuildDate: string | null, publishedBuildDate: string | null): boolean {
  const l = localBuildDate ? Date.parse(localBuildDate) : NaN;
  if (Number.isNaN(l)) return false;
  const p = publishedBuildDate ? Date.parse(publishedBuildDate) : NaN;
  return Number.isNaN(p) || l >= p;
}

/**
 * The meshes a route opens, downloaded ones first: every ready download
 * and every local mesh, except one switched off in the config, and, where
 * a download and a local mesh share a name, only the newer of the two
 * (localWins). A route uses the first of these that covers a leg.
 */
export function meshesToOpen(
  downloaded: { name: string; dirs: string[]; build_date: string | null }[],
  local: { name: string; dirs: string[]; build_date: string | null }[],
  disabled: string[],
  preferLocal: string[] = [],
  preferDownload: string[] = []
): { name: string; dirs: string[]; source: 'download' | 'local' }[] {
  const localByName = new Map(local.map(m => [m.name, m]));
  const downloadedByName = new Map(downloaded.map(m => [m.name, m]));
  const out: { name: string; dirs: string[]; source: 'download' | 'local' }[] = [];
  // A name with both copies: the owner's explicit choice first ("my folder" or "downloaded"), else the newer build.
  const localChosen = (name: string, l: { build_date: string | null }, d: { build_date: string | null }): boolean =>
    preferLocal.includes(name) ? true : preferDownload.includes(name) ? false : localWins(l.build_date, d.build_date);
  for (const m of downloaded) {
    if (disabled.includes(m.name)) continue;
    const l = localByName.get(m.name);
    if (l && localChosen(m.name, l, m)) continue;
    out.push({ name: m.name, dirs: m.dirs, source: 'download' });
  }
  for (const m of local) {
    if (disabled.includes(m.name)) continue;
    const d = downloadedByName.get(m.name);
    if (d && !localChosen(m.name, m, d)) continue;
    out.push({ name: m.name, dirs: m.dirs, source: 'local' });
  }
  return out;
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
export interface LocalMesh {
  name: string;
  dir: string;
  dirs: string[];
  description: string;
  /** The sidecar's `build_date`, or null without a sidecar (or one without the date). */
  build_date: string | null;
  error: string | null;
}

export function localMeshes(meshDir: string | null): LocalMesh[] {
  if (!meshDir) return [];
  const one = (name: string, dir: string): LocalMesh => {
    const dirs = meshClusterDirs(dir);
    if (!dirs.length) return { name, dir, dirs, description: '', build_date: null, error: 'no index.json or meshes.json' };
    const parts: string[] = [];
    let buildDate: string | null = null;
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
        if (s.build_date) {
          parts.push(`mesh ${s.build_date.slice(0, 10)}`);
          buildDate = s.build_date;
        }
      }
      return { name, dir, dirs, description: `local: ${dir} · ${parts.join(' · ')}`, build_date: buildDate, error: null };
    } catch (err) {
      return { name, dir, dirs, description: `local: ${dir}`, build_date: buildDate, error: (err as Error).message };
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
    return [
      {
        name: path.basename(meshDir),
        dir: meshDir,
        dirs: [],
        description: `local: ${meshDir}`,
        build_date: null,
        error: (err as Error).message,
      },
    ];
  }
}

/** The ready meshes under a store directory: every folder with a complete marker (its build date from the marker). */
export function readyMeshDirs(storeDir: string): { name: string; dirs: string[]; build_date: string | null }[] {
  let names: string[];
  try {
    // `.new` is a copy in progress, `.old` the copy a swap replaced (gone once the swap's cleanup runs).
    names = fs.readdirSync(storeDir).filter(n => !n.startsWith('.') && !n.endsWith('.new') && !n.endsWith('.old'));
  } catch {
    return [];
  }
  const out: { name: string; dirs: string[]; build_date: string | null }[] = [];
  for (const n of names.sort()) {
    const dir = path.join(storeDir, n);
    const marker = readMarker(dir);
    if (!marker) continue;
    const dirs = meshClusterDirs(dir);
    if (dirs.length) out.push({ name: n, dirs, build_date: marker.build_date ?? null });
  }
  return out;
}

export class MeshManager {
  private catalog: Catalog | null = null;
  private catalogError: string | null = null;
  /** Catalogue rows set aside (catalogEntryProblem), by mesh name; never downloaded. */
  private catalogProblems = new Map<string, string>();
  /** Rows set aside that have no usable name. */
  private catalogUnnamed: string[] = [];
  private catalogUrl = DEFAULT_MESH_CATALOG_URL;
  private ticked: string[] = [];
  private disabled: string[] = [];
  private preferLocal: string[] = [];
  private preferDownload: string[] = [];
  /** Set when the list or a fresh request changed while a pass was running: that pass runs once more when it ends. */
  private again = false;
  private storeDir = '';
  private meshDir: string | null = null;
  private errors = new Map<string, string>();
  /**
   * Names to download again from scratch at the next pass, whatever the build on disk (the panel's "Download again"),
   * each with the number of its latest request: a request made while that mesh is downloading outlives the pass that
   * started before it, which clears a mark only when the number is the one it saw.
   */
  private fresh = new Map<string, number>();
  private freshSeq = 0;
  /** Names the owner asked for (Download, Update): the next pass fetches them even when the folder's copy is newer. */
  private requested = new Set<string>();
  private downloading = new Set<string>();
  private removing = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ctrl: AbortController | null = null;
  /** A refresh started before `run` (the coastline still downloading): `stop` aborts its read and its pass. */
  private refreshCtrl: AbortController | null = null;
  /** The pass running now (or queued): its signal and its promise. */
  private reconciling: { signal: AbortSignal; done: Promise<void> } | null = null;
  /**
   * The catalogue read in flight, if any: a pass and a `refresh` (and
   * concurrent refreshes) share it, so one read's result never lands on top
   * of a newer one's. Its signal is kept so a read aborted by `stop` is not
   * shared with the next `run`.
   */
  private catalogRead: { signal: AbortSignal; done: Promise<void> } | null = null;
  /** Counts catalogue reads; a read superseded by a newer one writes nothing. */
  private catalogSeq = 0;

  constructor(
    private readonly log: (m: string) => void,
    /** A mesh was downloaded or updated and is in place (its rough cuts are rebuilt then: index.ts). */
    private readonly onReady: (name: string) => void = () => undefined,
    /** Holds the daily pass (internet.ts); the panel's buttons do not wait. */
    private readonly internet?: DownloadHold
  ) {}

  /** Apply a configuration; the next `run` reconciles the store with it. */
  configure(
    catalogUrl: string,
    ticked: string[],
    storeDir: string,
    disabled: string[] = [],
    meshDir: string | null = null,
    preferLocal: string[] = [],
    preferDownload: string[] = []
  ): void {
    this.catalogUrl = catalogUrl;
    this.ticked = [...new Set(ticked.map(n => n.trim()).filter(Boolean))];
    this.disabled = [...new Set(disabled.map(n => n.trim()).filter(Boolean))];
    this.preferLocal = [...new Set(preferLocal.map(n => n.trim()).filter(Boolean))];
    this.preferDownload = [...new Set(preferDownload.map(n => n.trim()).filter(Boolean))];
    this.storeDir = storeDir;
    this.meshDir = meshDir;
  }

  /** The download list alone (the panel's actions change it without a restart). */
  setDownloads(ticked: string[]): void {
    this.ticked = [...new Set(ticked.map(n => n.trim()).filter(Boolean))];
  }

  /** Download this mesh again from scratch at the next pass, even when the copy on disk is the published build. */
  redownload(name: string): void {
    this.fresh.set(name, ++this.freshSeq);
  }

  /** Download or Update pressed: fetch at the next pass whatever a newer copy in the owner's folder says (resume kept). */
  request(name: string): void {
    this.requested.add(name);
  }

  /**
   * Stop the download running for this mesh and start the loop again, so
   * the pass runs with the list as it now is (the children are killed: a
   * download of another mesh running beside it resumes from its archive's
   * part; this one's working folder goes with the mesh when it has been
   * taken off the list). True when a download of that mesh was running.
   */
  cancel(name: string): boolean {
    if (!this.downloading.has(name)) return false;
    const running = !!this.ctrl;
    this.stop();
    if (running) this.run();
    return true;
  }

  /** How often a daily pass looks at the internet state while it downloads. */
  protected holdCheckMs = HOLD_CHECK_MS;
  /** Counts the owner's requests (refresh): a pass with one since the last pass ended is not stopped by the internet state. */
  private ownerAsks = 0;

  /**
   * Read the catalogue, download what is ticked and missing or stale, delete what is unticked; then again daily.
   * While the internet state holds downloads (internet.ts) the pass waits, looking again every 15 minutes; a pass
   * under way when it starts holding is stopped (the downloads resume from their parts later), unless the owner
   * asked for something meanwhile.
   */
  run(): void {
    this.stop();
    this.ctrl = new AbortController();
    const loop = async (): Promise<void> => {
      const signal = this.ctrl!.signal;
      let wasHeld: string | null = null;
      let asksSeen = this.ownerAsks;
      while (!signal.aborted) {
        const held = this.internet ? await this.internet.holdNow() : null;
        if (signal.aborted) break;
        if (held && held !== wasHeld) this.log(`catalogue and downloads wait: ${held}`);
        wasHeld = held;
        if (!held) {
          const internet = this.internet;
          const watch = internet?.active
            ? setInterval(() => {
                void internet.holdNow().then(why => {
                  if (!why || this.ownerAsks !== asksSeen || signal.aborted) return;
                  clearInterval(watch);
                  this.stop();
                  this.run();
                });
              }, this.holdCheckMs)
            : undefined;
          try {
            await this.reconcile(signal);
          } finally {
            clearInterval(watch);
          }
          asksSeen = this.ownerAsks;
        }
        // A stop during the pass has already aborted: no timer then, or it would hold the process a day.
        if (signal.aborted) break;
        await new Promise<void>(resolve => {
          const onAbort = (): void => {
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            resolve();
          };
          this.timer = setTimeout(
            () => {
              // One signal serves every wait: the listener must not pile up.
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            held ? INTERNET_HOLD_RETRY_MS : CATALOG_REFRESH_MS
          );
          signal.addEventListener('abort', onAbort, { once: true });
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
    this.ownerAsks++;
    const signal = this.ctrl?.signal ?? (this.refreshCtrl ??= new AbortController()).signal;
    // A running pass on this same signal is shared, not followed by one of its own, and may be past the name
    // just changed: it runs once more when it ends. (A refresh before `run` gets a pass of its own anyway.)
    if (this.reconciling && this.reconciling.signal === signal) this.again = true;
    await this.readCatalog(signal);
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
      .then(async () => {
        // Changes made while the pass ran (an action from the panel): one more pass, until none came in.
        while (this.again && !s.aborted) {
          this.again = false;
          await this.reconcileOnce(s);
        }
      })
      .finally(() => {
        if (this.reconciling?.done === done) this.reconciling = null;
      });
    this.reconciling = { signal: s, done };
    return done;
  }

  private async reconcileOnce(signal: AbortSignal): Promise<void> {
    await this.readCatalog(signal);
    if (signal.aborted) return;
    fs.mkdirSync(this.storeDir, { recursive: true });
    // Unticked meshes go, including stale .new and leftover .old folders.
    for (const n of this.onDisk()) {
      if (this.ticked.includes(n)) continue;
      this.removing.add(n);
      try {
        fs.rmSync(path.join(this.storeDir, n), { recursive: true, force: true });
        fs.rmSync(path.join(this.storeDir, `${n}.new`), { recursive: true, force: true });
        fs.rmSync(path.join(this.storeDir, `${n}.old`), { recursive: true, force: true });
        fs.rmSync(downloadWorkDir(this.storeDir, n), { recursive: true, force: true });
        this.log(`mesh ${n}: removed (not in the download list)`);
      } catch (err) {
        this.errors.set(n, `removal failed: ${(err as Error).message}`);
      }
      this.removing.delete(n);
    }
    // Ticked meshes: missing or older than the catalogue → download, MESH_DOWNLOADS_AT_ONCE at a time. A local
    // mesh of the same name stops the download only when it was built at the same time or later (localWins); a
    // ticked name that is only a local mesh (ticked in an earlier panel) is not a catalogue mesh.
    const localByName = new Map(localMeshes(this.meshDir).map(m => [m.name, m]));
    const jobs: { entry: CatalogMesh; freshSeq: number | undefined }[] = [];
    for (const n of this.ticked) {
      // An unusable catalogue row is reported on its row (status), not fetched; the copy on disk, if any, stays.
      if (this.catalogProblems.has(n)) continue;
      const local = localByName.get(n);
      const entry = this.catalog?.meshes.find(m => m.name === n);
      if (!entry) {
        if (this.catalog && !local) this.errors.set(n, 'not in the catalogue');
        continue;
      }
      // "Download again" fetches whatever the dates; a pressed Download or Update fetches past a newer folder copy;
      // otherwise a newer local copy, or a copy of the same build, means no download.
      const freshSeq = this.fresh.get(n);
      const again = freshSeq !== undefined;
      const asked = again || this.requested.has(n);
      if (!asked && local && localWins(local.build_date, entry.build_date)) continue;
      const marker = readMarker(path.join(this.storeDir, n));
      if (!again && marker && marker.build_date === entry.build_date) continue;
      jobs.push({ entry, freshSeq });
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < jobs.length && !signal.aborted) {
        const { entry, freshSeq } = jobs[next++];
        const n = entry.name;
        await this.download(entry, signal, freshSeq !== undefined);
        // A request stands until a download succeeds, so a failure is retried at the next pass; a fresh request
        // made while this download ran is newer than the one seen and stands too.
        if (!signal.aborted && !this.errors.has(n)) {
          this.requested.delete(n);
          if (this.fresh.get(n) === freshSeq) this.fresh.delete(n);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MESH_DOWNLOADS_AT_ONCE, jobs.length) }, worker));
  }

  /**
   * Read the catalogue, or join the read already in flight (unless that one
   * was aborted: then it is winding down and a fresh read starts).
   */
  private readCatalog(signal: AbortSignal): Promise<void> {
    const active = this.catalogRead;
    if (active && !active.signal.aborted) return active.done;
    const done = this.fetchCatalog(signal).finally(() => {
      if (this.catalogRead?.done === done) this.catalogRead = null;
    });
    this.catalogRead = { signal, done };
    return done;
  }

  private async fetchCatalog(signal: AbortSignal): Promise<void> {
    const seq = ++this.catalogSeq;
    try {
      const res = await fetch(this.catalogUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const c = (await res.json()) as Catalog;
      if (!c || !Array.isArray(c.meshes)) throw new Error('not a mesh catalogue (no meshes[])');
      if (seq !== this.catalogSeq) return; // a newer read has started: its result is the one that counts
      // Each row checked on its own: a bad one is set aside with its reason, the others serve.
      const meshes: CatalogMesh[] = [];
      const problems = new Map<string, string>();
      const unnamed: string[] = [];
      (c.meshes as unknown[]).forEach((m, i) => {
        const problem = catalogEntryProblem(m);
        if (!problem) {
          meshes.push(m as CatalogMesh);
          return;
        }
        const name = (m as { name?: unknown } | null)?.name;
        if (typeof name === 'string' && MESH_NAME.test(name)) problems.set(name, problem);
        else unnamed.push(`row ${i + 1}: ${problem}`);
      });
      // A name with a usable row is served by it, whether an unusable row of the same name comes before or after.
      for (const m of meshes) problems.delete(m.name);
      for (const [n, p] of problems) this.log(`mesh catalogue ${this.catalogUrl}: ${n}: unusable entry (${p}); not downloaded`);
      for (const u of unnamed) this.log(`mesh catalogue ${this.catalogUrl}: ${u}; skipped`);
      this.catalog = { ...c, meshes };
      this.catalogProblems = problems;
      this.catalogUnnamed = unnamed;
      this.catalogError = null;
    } catch (err) {
      if (seq !== this.catalogSeq) return;
      this.catalogError = (err as Error).message;
      this.log(`mesh catalogue ${this.catalogUrl}: ${this.catalogError}`);
    }
  }

  private async download(entry: CatalogMesh, signal: AbortSignal, fresh = false): Promise<void> {
    const dest = path.join(this.storeDir, entry.name);
    const tmp = `${dest}.new`;
    const work = downloadWorkDir(this.storeDir, entry.name);
    this.downloading.add(entry.name);
    this.errors.delete(entry.name);
    const t0 = Date.now();
    try {
      const url = meshArchiveUrl(this.catalogUrl, entry);
      this.log(`mesh ${entry.name}: downloading ${url} (${(entry.bytes / 1e9).toFixed(1)} GB unpacked)`);
      const r = await runChildTask(
        {
          task: 'mesh-download',
          url,
          work,
          dest: tmp,
          top: meshArchiveTop(entry),
          build: entry.build_date,
          bytes: entry.bytes,
          fresh,
        },
        6 * 3600_000,
        signal
      );
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
      // Swap: the old copy (if any) served until now. The archive goes once the mesh is in place.
      const old = `${dest}.old`;
      fs.rmSync(old, { recursive: true, force: true });
      if (fs.existsSync(dest)) fs.renameSync(dest, old);
      fs.renameSync(tmp, dest);
      fs.rmSync(old, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
      this.log(
        `mesh ${entry.name}: ready, ${r.files} files, ${(r.bytes / 1e9).toFixed(2)} GB in ${((Date.now() - t0) / 1000).toFixed(0)} s`
      );
      this.onReady(entry.name);
    } catch (err) {
      // Stopped (the child was killed): not an error; the next run resumes the copy.
      if (signal.aborted) return;
      this.errors.set(entry.name, (err as Error).message);
      this.log(`mesh ${entry.name}: download failed: ${(err as Error).message}`);
    } finally {
      this.downloading.delete(entry.name);
    }
  }

  /** The mesh names on disk: their folders, copies in progress and left over, and download working folders. */
  private onDisk(): string[] {
    try {
      return fs
        .readdirSync(this.storeDir)
        .map(n => (n.startsWith('.dl-') ? n.slice(4) : n.startsWith('.') ? '' : n.replace(/\.(new|old)$/, '')))
        .filter((n, i, a) => n !== '' && a.indexOf(n) === i);
    } catch {
      return [];
    }
  }

  private progressOf(name: string): MeshRow['progress'] {
    try {
      const p = JSON.parse(
        fs.readFileSync(path.join(downloadWorkDir(this.storeDir, name), DOWNLOAD_PROGRESS_FILE), 'utf8')
      ) as MeshDownloadProgress;
      return { phase: p.phase, bytes: p.bytes, total: p.total, files: p.files };
    } catch {
      return null;
    }
  }

  /**
   * Every mesh the catalogue lists (and any on disk the catalogue no longer
   * has), with its state, then the local meshes. A local mesh with the same
   * name as a catalogue or downloaded one is not a row of its own: that
   * row carries it (local_dir, local_build_date) and says which copy the
   * router opens (using; meshesToOpen).
   */
  status(): MeshesStatus {
    const local = localMeshes(this.meshDir);
    const localNames = new Set(local.map(m => m.name));
    const localByName = new Map(local.map(m => [m.name, m]));
    // A local mesh's name in the download list (ticked in an earlier panel) is not a catalogue mesh.
    const names = new Set<string>([
      ...(this.catalog?.meshes.map(m => m.name) ?? []),
      ...this.catalogProblems.keys(),
      ...this.onDisk(),
      ...this.ticked.filter(n => !localNames.has(n)),
    ]);
    const rows: MeshRow[] = [];
    for (const name of [...names].sort()) {
      const entry = this.catalog?.meshes.find(m => m.name === name) ?? null;
      const problem = this.catalogProblems.get(name);
      const marker = readMarker(path.join(this.storeDir, name));
      const ticked = this.ticked.includes(name);
      let state: MeshState = 'absent';
      if (this.removing.has(name)) state = 'removing';
      else if (this.downloading.has(name)) state = 'downloading';
      else if (this.errors.has(name) || (problem && !marker)) state = 'error';
      else if (marker && entry && marker.build_date !== entry.build_date) state = 'update';
      else if (marker) state = 'ready';
      const l = localByName.get(name);
      const usable = l && !l.error ? l : null;
      const choice: MeshRow['copy_choice'] = this.preferLocal.includes(name)
        ? 'local'
        : this.preferDownload.includes(name)
          ? 'download'
          : 'auto';
      let using: MeshRow['using'] = null;
      let usingWhy: MeshRow['using_why'] = null;
      if (usable && marker) {
        if (choice !== 'auto') [using, usingWhy] = [choice, 'choice'];
        else [using, usingWhy] = localWins(usable.build_date, marker.build_date) ? ['local', 'newer'] : ['download', 'newer'];
      } else if (usable) [using, usingWhy] = ['local', 'only'];
      else if (marker) [using, usingWhy] = ['download', 'only'];
      rows.push({
        name,
        title: DISTRICT_NAMES[name] ?? name,
        description: entry ? describeMesh(entry) : problem ? 'the catalogue entry is unusable' : 'not in the catalogue',
        source: 'catalog',
        ticked,
        enabled: !this.disabled.includes(name),
        using,
        using_why: usingWhy,
        copy_choice: choice,
        local_dir: l?.dir ?? null,
        local_build_date: l?.build_date ?? null,
        state,
        progress: state === 'downloading' ? this.progressOf(name) : null,
        catalog_build_date: entry?.build_date ?? null,
        disk_build_date: marker?.build_date ?? null,
        bytes: entry?.bytes ?? marker?.bytes ?? null,
        error: problem ? `the catalogue entry is unusable: ${problem}; not downloaded` : (this.errors.get(name) ?? null),
      });
    }
    // Local meshes (the folder managed by hand), after the catalogue's; one named like a row above is in that row.
    for (const m of local) {
      if (names.has(m.name)) continue;
      rows.push({
        name: m.name,
        title: DISTRICT_NAMES[m.name] ?? m.name,
        description: m.description,
        source: 'local',
        ticked: true,
        enabled: !this.disabled.includes(m.name),
        using: m.error ? null : 'local',
        using_why: m.error ? null : 'only',
        copy_choice: 'auto',
        local_dir: m.dir,
        local_build_date: m.build_date,
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
      catalog_problems: [...this.catalogUnnamed],
      store_dir: this.storeDir,
      meshes: rows,
    };
  }
}
