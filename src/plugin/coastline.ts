/**
 * The downloaded GSHHG coastline (geo/gshhg.ts) when the plugin config
 * names none: download with retries, the state the status and the config
 * panel show, and the manual Download button.
 *
 * Extracted from index.ts (docs/plans/structural-cleanup.md, phase 2.3).
 */

import { MINUTE_MS } from '../geo/units';
import { ensureGshhg, gshhgInstalled } from '../geo/gshhg';
import { siText } from './unittext';
import { INTERNET_HOLD_RETRY_MS, type DownloadHold } from './internet';

/** Downloaded-coastline state (status `coastline`, config panel). */
export interface CoastlineState {
  downloading: boolean;
  message: string | null;
  error: string | null;
  path: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A failed coastline download is tried again after this long. */
export const COASTLINE_RETRY_MS = 10 * MINUTE_MS;

export class Coastline {
  readonly state: CoastlineState = { downloading: false, message: null, error: null, path: null, startedAt: null, finishedAt: null };
  /** Downloaded GSHHG coastline, used when the plugin config names none. */
  autoPath: string | null = null;
  /** Why the download at start waits now (internet.ts), or null (notStartedReason). */
  held: string | null = null;
  /** The download running, if any (one at a time), with the signal that cancels it. */
  private run: { promise: Promise<string | null>; signal: AbortSignal } | null = null;
  /** Wakes a start waiting to retry the download. */
  private wake: (() => void) | null = null;
  /** Cancels the download (and its retry wait) on stop. */
  private ctrl: AbortController | null = null;
  /** Cancels a download started from the config panel, on stop. */
  private manualCtrl: AbortController | null = null;

  constructor(
    private readonly app: { setPluginStatus: (s: string) => void; setPluginError: (s: string) => void; getDataDirPath: () => string },
    private readonly log: (m: string) => void,
    /** Holds the download at start (internet.ts); the Download button does not wait. */
    private readonly internet?: DownloadHold
  ) {}

  /** Stop: cancel a running download and its retry wait. */
  abort(): void {
    this.ctrl?.abort();
    this.ctrl = null;
    this.manualCtrl?.abort();
    this.manualCtrl = null;
  }

  /**
   * No coastline configured: download GSHHG (geo/gshhg.ts), trying again
   * every 10 minutes after a failure, until it is in place or the plugin
   * stops. While the internet state holds downloads (internet.ts) it waits,
   * looking again every 15 minutes, unless Download is pressed. True when
   * the coastline is ready and this start is still current.
   */
  async download(dataDir: string, stillCurrent: () => boolean): Promise<boolean> {
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const current = (): boolean => stillCurrent() && !ctrl.signal.aborted;
    let pressed = false;
    for (;;) {
      // Already on disk: nothing to download, so nothing to hold.
      let held: string | null = null;
      if (!pressed && !gshhgInstalled(dataDir) && this.internet) {
        // A Download press during the lookup is a press, not a second download beside this one.
        const wake = (): void => {
          pressed = true;
        };
        this.wake = wake;
        try {
          held = await this.internet.holdNow();
        } finally {
          // A newer start (after a stop) may have put its own in place meanwhile.
          if (this.wake === wake) this.wake = null;
        }
        if (pressed) held = null;
      }
      if (!current()) return false;
      this.held = held;
      if (held) {
        this.app.setPluginStatus(
          siText(
            `no coastline configured: the GSHHG download ({dataSize:149000000}) waits, ${held}; press Download coastline in the plugin config to download it now`
          )
        );
        const woke = await this.wait(ctrl.signal, INTERNET_HOLD_RETRY_MS);
        this.held = null;
        if (woke === 'stopped' || !current()) return false;
        pressed = woke === 'pressed';
        continue;
      }
      // Values in Signal K base units (siText): the client converts.
      this.app.setPluginStatus(siText('no coastline configured: downloading GSHHG ({dataSize:149000000}, once)'));
      const shp = await this.fetch(dataDir, ctrl.signal, m => {
        if (current()) this.app.setPluginStatus(siText(m));
      });
      if (!current()) return false; // stopped
      if (shp) {
        this.autoPath = shp;
        return true;
      }
      const at = new Date(Date.now() + COASTLINE_RETRY_MS).toISOString().slice(11, 16);
      this.app.setPluginError(
        `coastline download failed: ${this.state.error}; trying again at ${at} UTC (or press Download coastline in the plugin config, or set a coastline shapefile)`
      );
      const woke = await this.wait(ctrl.signal, COASTLINE_RETRY_MS);
      if (woke === 'stopped' || !current()) return false;
      pressed = woke === 'pressed';
    }
  }

  /** Wait `ms`, a Download press (wakes it) or a stop, whichever comes first. */
  private wait(signal: AbortSignal, ms: number): Promise<'timer' | 'pressed' | 'stopped'> {
    return new Promise(resolve => {
      // Stopped already (a status callback can stop the plugin): the abort event has passed.
      if (signal.aborted) {
        resolve('stopped');
        return;
      }
      const onAbort = (): void => done('stopped');
      const timer = setTimeout(() => done('timer'), ms);
      const wake = (): void => done('pressed');
      const done = (v: 'timer' | 'pressed' | 'stopped'): void => {
        clearTimeout(timer);
        // One signal serves every wait: the listener must not pile up.
        signal.removeEventListener('abort', onAbort);
        if (this.wake === wake) this.wake = null;
        resolve(v);
      };
      this.wake = wake;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * One GSHHG download (geo/gshhg.ts) with its state for the status and
   * the config panel. Resolves the .shp, or null on failure (the error is
   * in `this.state.error`); a download already running is joined.
   */
  fetch(dataDir: string, signal: AbortSignal, onProgress: (m: string) => void = () => undefined): Promise<string | null> {
    // An aborted run (stopped) is not joined: a new start downloads afresh.
    if (this.run && !this.run.signal.aborted) return this.run.promise;
    // This run's token: a stale run's late callbacks must not touch a newer run's state.
    const run: { promise: Promise<string | null>; signal: AbortSignal } = { promise: Promise.resolve(null), signal };
    const isCurrent = (): boolean => this.run === run;
    this.run = run;
    this.state.downloading = true;
    this.state.error = null;
    this.state.path = null;
    this.state.startedAt = new Date().toISOString();
    run.promise = ensureGshhg(
      dataDir,
      m => {
        this.log(m);
        if (isCurrent()) this.state.message = m;
        onProgress(m);
      },
      { signal }
    )
      .then(
        shp => {
          if (isCurrent()) {
            this.state.path = shp;
            this.state.message = `ready: ${shp}`;
          }
          return shp;
        },
        (err: Error) => {
          if (isCurrent()) this.state.error = err.message;
          return null;
        }
      )
      .finally(() => {
        if (!isCurrent()) return;
        this.state.downloading = false;
        this.state.finishedAt = new Date().toISOString();
        this.run = null;
      });
    return run.promise;
  }

  /**
   * Download pressed in the config panel: wake a start waiting to retry,
   * or download now (also while a coastline is configured: the panel then
   * offers to switch to it).
   */
  requestDownload(): void {
    if (this.run && !this.run.signal.aborted) return;
    if (this.wake) {
      this.wake();
      return;
    }
    const ctrl = new AbortController();
    this.manualCtrl = ctrl;
    void this.fetch(this.app.getDataDirPath(), ctrl.signal);
  }
}
