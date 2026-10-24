/**
 * The internet state gate (internet.ts): which signalk-internet states hold background downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNET_PLUGIN_ID, INTERNET_STATE_PATH, InternetGate, internetHold } from './internet';

const leaf = (value: unknown) => (p: string) =>
  p === INTERNET_STATE_PATH ? { value, $source: 'signalk-internet', timestamp: '' } : undefined;

test('metered, offline and captive hold background downloads, with the state in the reason', () => {
  for (const state of ['metered', 'offline', 'captive']) {
    const why = internetHold(leaf(state));
    assert.ok(why?.includes(state), `${state}: ${why}`);
  }
  assert.match(internetHold(() => 'metered') ?? '', /metered/, 'a bare value is read too');
});

test('online, any other value, no state or no signalk-internet: downloads run as before', () => {
  assert.equal(internetHold(leaf('online')), null);
  assert.equal(internetHold(leaf('something-new')), null);
  assert.equal(internetHold(leaf(null)), null);
  assert.equal(
    internetHold(() => undefined),
    null
  );
  assert.equal(internetHold(undefined), null);
  assert.equal(
    internetHold(() => {
      throw new Error('no self yet');
    }),
    null
  );
});

function gateApp(plugins: { id: string; enabled: boolean }[] | null, state: { value: unknown }) {
  return {
    getSelfPath: (p: string) => (p === INTERNET_STATE_PATH && state.value !== undefined ? { value: state.value } : undefined),
    getFeatures: plugins === null ? undefined : async () => ({ plugins }),
  };
}

test('InternetGate: the state holds only while signalk-internet is enabled; a value it left behind holds nothing', async () => {
  const state = { value: 'metered' as unknown };
  const on = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], state));
  assert.match((await on.holdNow()) ?? '', /metered/);
  assert.equal(on.active, true);
  const off = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: false }], state));
  assert.equal(await off.holdNow(), null, 'disabled: the stale value is ignored');
  assert.equal(off.active, false);
  const none = new InternetGate(gateApp([], state));
  assert.equal(await none.holdNow(), null);
  const oldServer = new InternetGate(gateApp(null, state));
  assert.equal(await oldServer.holdNow(), null, 'no getFeatures: as without the plugin');
});

test('InternetGate.settle: waits for the first state while signalk-internet is enabled; returns at once without it', async () => {
  const state = { value: undefined as unknown };
  const none = new InternetGate(gateApp([], state));
  const t0 = Date.now();
  assert.equal(await none.settle(() => true, 1000, 10), true);
  assert.ok(Date.now() - t0 < 100, 'no wait without the plugin');

  const on = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], state));
  const settled = on.settle(() => true, 5000, 10);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(on.settling, true);
  state.value = 'metered';
  assert.equal(await settled, true);
  assert.equal(on.settling, false);
  assert.match(on.hold() ?? '', /metered/, 'the first round is held');

  const silent = new InternetGate(gateApp([{ id: INTERNET_PLUGIN_ID, enabled: true }], { value: undefined }));
  assert.equal(await silent.settle(() => true, 50, 10), true, 'a plugin that never publishes delays the start at most waitMs');
  let current = true;
  const stopped = silent.settle(() => current, 5000, 10);
  current = false;
  assert.equal(await stopped, false);
});
