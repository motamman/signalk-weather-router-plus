/**
 * The coastline download at start (coastline.ts) while the internet state holds background downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Coastline } from './coastline';

test('a held start waits without downloading; Download pressed starts it anyway', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-coast-'));
  const statuses: string[] = [];
  const app = {
    setPluginStatus: (s: string) => {
      statuses.push(s);
      // Stopped as the download starts: the aborted signal ends it before any request is made.
      if (s.includes('downloading GSHHG')) coast.abort();
    },
    setPluginError: () => undefined,
    getDataDirPath: () => dataDir,
  };
  const coast: Coastline = new Coastline(app, () => undefined, {
    active: true,
    holdNow: async () => 'the internet connection is metered (network.internet.state)',
  });
  try {
    const done = coast.download(dataDir, () => true);
    await new Promise(r => setImmediate(r));
    assert.equal(statuses.length, 1);
    assert.match(statuses[0], /waits, the internet connection is metered/);
    assert.match(coast.held ?? '', /metered/, 'the reason the status answers while starting');
    assert.equal(coast.state.downloading, false, 'nothing downloads while held');
    coast.requestDownload();
    assert.equal(await done, false);
    assert.ok(
      statuses.some(s => s.includes('downloading GSHHG')),
      'the press starts the download'
    );
  } finally {
    coast.abort();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Download pressed while the start looks up the internet state downloads at once, without a second download', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-coast-'));
  const statuses: string[] = [];
  let lookedUp!: () => void;
  const lookup = new Promise<void>(r => (lookedUp = r));
  const app = {
    setPluginStatus: (s: string) => {
      statuses.push(s);
      if (s.includes('downloading GSHHG')) coast.abort();
    },
    setPluginError: () => undefined,
    getDataDirPath: () => dataDir,
  };
  const coast: Coastline = new Coastline(app, () => undefined, {
    active: true,
    holdNow: async () => {
      await lookup;
      return 'the internet connection is metered (network.internet.state)';
    },
  });
  try {
    const done = coast.download(dataDir, () => true);
    await new Promise(r => setImmediate(r));
    coast.requestDownload();
    assert.equal(coast.state.downloading, false, 'the press joins the start, it does not start a fetch of its own');
    lookedUp();
    assert.equal(await done, false);
    assert.ok(!statuses.some(s => s.includes('waits')), 'not held after the press');
    assert.ok(statuses.some(s => s.includes('downloading GSHHG')));
  } finally {
    coast.abort();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a stop while the hold is reported ends the start at once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-coast-'));
  const app = {
    setPluginStatus: () => coast.abort(),
    setPluginError: () => undefined,
    getDataDirPath: () => dataDir,
  };
  const coast: Coastline = new Coastline(app, () => undefined, {
    active: true,
    holdNow: async () => 'the internet connection is metered (network.internet.state)',
  });
  try {
    const result = await Promise.race([coast.download(dataDir, () => true), new Promise(r => setTimeout(() => r('pending'), 500))]);
    assert.equal(result, false);
  } finally {
    coast.abort();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a stopped start whose lookup ends late leaves the new start its Download press', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-coast-'));
  const statuses: string[] = [];
  const lookups: (() => void)[] = [];
  const app = {
    setPluginStatus: (s: string) => {
      statuses.push(s);
      if (s.includes('downloading GSHHG')) coast.abort();
    },
    setPluginError: () => undefined,
    getDataDirPath: () => dataDir,
  };
  const coast: Coastline = new Coastline(app, () => undefined, {
    active: true,
    holdNow: () => new Promise(r => lookups.push(() => r('the internet connection is metered (network.internet.state)'))),
  });
  try {
    let first = true;
    const old = coast.download(dataDir, () => first);
    await new Promise(r => setImmediate(r));
    first = false;
    coast.abort();
    const next = coast.download(dataDir, () => true);
    await new Promise(r => setImmediate(r));
    lookups[0](); // the stopped start's lookup ends after the new start installed its press
    assert.equal(await old, false);
    coast.requestDownload();
    assert.equal(coast.state.downloading, false, 'the press goes to the new start, not to a fetch of its own');
    lookups[1]();
    assert.equal(await next, false);
    assert.ok(
      statuses.some(s => s.includes('downloading GSHHG')),
      'the new start downloads at the press'
    );
  } finally {
    coast.abort();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
