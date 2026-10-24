/**
 * The connection state published by the signalk-internet plugin
 * (vessels.self network.internet.state). While it says the link costs
 * money per byte (metered), carries no traffic (offline) or is caught by a
 * sign-in page (captive), nothing here downloads on its own: the forecast
 * and current refresh rounds use what is on disk, the coastline and the
 * chart meshes wait. What the owner starts (Refresh, Download coastline,
 * the mesh panel's buttons, a route) still downloads.
 *
 * The state counts only while signalk-internet is enabled: Signal K keeps
 * the last value a disabled plugin published until it restarts. Without
 * the plugin, or with any other state, downloads run as they always did.
 */

import { MINUTE_MS } from '../geo/units';

export const INTERNET_STATE_PATH = 'network.internet.state';
export const INTERNET_PLUGIN_ID = 'signalk-internet';

/** Held work (the coastline download, the meshes' pass) looks at the state again after this long. */
export const INTERNET_HOLD_RETRY_MS = 15 * MINUTE_MS;
/** Whether signalk-internet is enabled is looked up again when the answer is older than this. */
export const PLUGIN_CHECK_MS = 30_000;
/** At start, how long to wait for signalk-internet's first state before the first downloads. */
export const FIRST_STATE_WAIT_MS = 30_000;
const FIRST_STATE_STEP_MS = 1000;

const HOLDING_STATES: ReadonlySet<string> = new Set(['metered', 'offline', 'captive']);

/** The state's value: `getSelfPath` answers the leaf (`{ value, $source, timestamp }`); a bare value is taken too. */
export function internetState(getSelfPath: ((path: string) => unknown) | undefined): unknown {
  let node: unknown;
  try {
    node = getSelfPath?.(INTERNET_STATE_PATH);
  } catch {
    return undefined;
  }
  return node !== null && typeof node === 'object' ? (node as { value?: unknown }).value : node;
}

/** Why background downloads wait for this state, or null when they may run. */
export function internetHold(getSelfPath: ((path: string) => unknown) | undefined): string | null {
  const value = internetState(getSelfPath);
  if (typeof value !== 'string' || !HOLDING_STATES.has(value)) return null;
  return `the internet connection is ${value} (${INTERNET_STATE_PATH})`;
}

export interface InternetApp {
  getSelfPath?: (path: string) => unknown;
  getFeatures?: (onlyEnabled?: boolean) => Promise<{ plugins: { id: string; enabled: boolean }[] }>;
}

/** What held background work asks (coastline.ts, meshes.ts). */
export interface DownloadHold {
  /** signalk-internet is enabled (at the last lookup): without it nothing is held or watched. */
  readonly active: boolean;
  /** Why background downloads wait now, or null, with the lookup renewed first. */
  holdNow(): Promise<string | null>;
}

/** The state, read only while signalk-internet is enabled. */
export class InternetGate implements DownloadHold {
  private enabled = false;
  private checkedAt = 0;
  private checking: Promise<void> | null = null;
  /** At start: waiting for signalk-internet's first state (notStartedReason). */
  settling = false;

  constructor(private readonly app: InternetApp) {}

  get active(): boolean {
    return this.enabled;
  }

  /** Look up whether signalk-internet is enabled (a server without getFeatures has no answer: not enabled). */
  check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        const f = await this.app.getFeatures?.(true);
        this.enabled = !!f?.plugins.some(p => p.id === INTERNET_PLUGIN_ID && p.enabled);
      } catch {
        this.enabled = false;
      }
      this.checkedAt = Date.now();
    })().finally(() => (this.checking = null));
    return this.checking;
  }

  /** Why background downloads wait now, or null. Sync: an old lookup is renewed for the next call. */
  hold(): string | null {
    if (Date.now() - this.checkedAt > PLUGIN_CHECK_MS) void this.check();
    return this.enabled ? internetHold(p => this.app.getSelfPath?.(p)) : null;
  }

  /** As `hold`, with the lookup renewed first (work that waited minutes). */
  async holdNow(): Promise<string | null> {
    await this.check();
    return this.hold();
  }

  /**
   * Before the first downloads: with signalk-internet enabled but no state
   * published yet (it starts beside this plugin), wait for one, up to
   * FIRST_STATE_WAIT_MS. False when `current` turns false meanwhile.
   */
  async settle(current: () => boolean, waitMs = FIRST_STATE_WAIT_MS, stepMs = FIRST_STATE_STEP_MS): Promise<boolean> {
    await this.check();
    const until = Date.now() + waitMs;
    this.settling = this.enabled && internetState(p => this.app.getSelfPath?.(p)) === undefined;
    try {
      while (this.settling && Date.now() < until) {
        await new Promise(r => setTimeout(r, stepMs));
        if (!current()) return false;
        this.settling = internetState(p => this.app.getSelfPath?.(p)) === undefined;
      }
    } finally {
      this.settling = false;
    }
    return current();
  }
}
