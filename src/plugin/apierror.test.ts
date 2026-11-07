/**
 * The two readers of a failed API answer's body (public/rp-core.js _apiError and _apiErrorText), run as the page runs
 * them, with the page's unit-text helper and its "server still loading" hook stubbed (as polarpicker.test.ts runs the
 * picker). A body read cut short by an abort (the request's channel superseded, the auth gate tripped) is not a
 * failure: the AbortError goes on to the caller, as fetch's own does when the abort comes before the headers. A body
 * that is not JSON is "HTTP <status>"; a 503 that says the forecast is loading is marked waiting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type ApiError = Error & { waiting?: boolean };

function readers() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-core.js'), 'utf8');
  const code = source
    .slice(source.indexOf('async function _errorBody'), source.indexOf('// Replan EventSource handle'))
    .replace(/^export /gm, '');
  const waiting: number[] = [];
  const context = { unitText: (s: string) => s, _serverWaiting: () => waiting.push(1) };
  const out = runInNewContext(`${code}\n({ apiError: _apiError, apiErrorText: _apiErrorText })`, context) as {
    apiError: (r: Response) => Promise<ApiError>;
    apiErrorText: (r: Response) => Promise<string>;
  };
  return { ...out, waiting };
}

/** An answer whose body read fails as an aborted one does: its stream errored with an AbortError. */
function aborted(status: number): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.error(new DOMException('The operation was aborted.', 'AbortError'));
      },
    }),
    { status }
  );
}

test('a body read cut short by an abort is not a failure: the AbortError goes on to the caller', async () => {
  const { apiError, apiErrorText } = readers();
  await assert.rejects(apiError(aborted(409)), { name: 'AbortError' });
  await assert.rejects(apiErrorText(aborted(409)), { name: 'AbortError' });
});

test('a body that is not JSON is the status; a JSON error is its text; a 503 still loading the forecast is marked waiting', async () => {
  const { apiError, apiErrorText, waiting } = readers();
  assert.equal(await apiErrorText(new Response('<html>', { status: 502 })), 'HTTP 502');
  assert.equal((await apiError(new Response('<html>', { status: 502 }))).message, 'HTTP 502');
  assert.equal(await apiErrorText(Response.json({ error: 'job is failed' }, { status: 409 })), 'job is failed');
  assert.deepEqual(waiting, []);
  const err = await apiError(Response.json({ error: 'loading the forecast', loading: { phase: 'decoding' } }, { status: 503 }));
  assert.equal(err.message, 'loading the forecast');
  assert.equal(err.waiting, true);
  assert.deepEqual(waiting, [1]);
});
