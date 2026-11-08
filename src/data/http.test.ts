import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBodyWithRetry, fetchWithRetry, OfflineError, parseRetryAfterMs, setNetworkObserver } from './http';

function responder(
  answers: (number | Error)[],
  body = 'ok',
  headers: Record<string, string> = {}
): { fetchImpl: typeof fetch; calls: number } {
  const st = { calls: 0 };
  const fetchImpl = (async () => {
    const a = answers[Math.min(st.calls, answers.length - 1)];
    st.calls++;
    if (a instanceof Error) throw a;
    return new Response(body, { status: a, headers });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return st.calls;
    },
  } as { fetchImpl: typeof fetch; calls: number };
}

test('fetchWithRetry: 5xx and network errors are retried with 2, 4, 8 s backoff plus jitter; then the answer is returned', async () => {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const r = responder([503, new Error('ECONNRESET'), 200], 'payload');
  const out = await fetchWithRetry(
    'http://x/y',
    {},
    {
      timeoutMs: 1000,
      retries: 6,
      fetchImpl: r.fetchImpl,
      sleepImpl: async ms => {
        sleeps.push(ms);
      },
      log: m => logs.push(m),
      tag: 'test',
      readBody: true,
    }
  );
  assert.equal(out.status, 200);
  assert.equal(new TextDecoder().decode(out.body!), 'payload');
  assert.equal(r.calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] >= 2000 && sleeps[0] < 2500, `first backoff ${sleeps[0]}`);
  assert.ok(sleeps[1] >= 4000 && sleeps[1] < 4500, `second backoff ${sleeps[1]}`);
  assert.ok(logs[0].startsWith('test: retry 1/5 for http://x/y after 2.'), logs[0]);
});

test('fetchWithRetry: Retry-After raises the backoff; 404 is returned without a retry; retries exhausted throw the last error', async () => {
  const sleeps: number[] = [];
  const r = responder([429, 200], 'ok', { 'retry-after': '10' });
  await fetchWithRetry(
    'http://x',
    {},
    {
      timeoutMs: 1000,
      retries: 3,
      fetchImpl: r.fetchImpl,
      sleepImpl: async ms => {
        sleeps.push(ms);
      },
    }
  );
  assert.ok(sleeps[0] >= 10000 && sleeps[0] < 10500, `retry-after backoff ${sleeps[0]}`);
  const nf = responder([404]);
  const out = await fetchWithRetry(
    'http://x',
    {},
    { timeoutMs: 1000, retries: 3, fetchImpl: nf.fetchImpl, sleepImpl: async () => undefined }
  );
  assert.equal(out.status, 404);
  assert.equal(out.body, null);
  assert.equal(nf.calls, 1);
  class MyErr extends Error {}
  const bad = responder([500]);
  await assert.rejects(
    fetchWithRetry(
      'http://x',
      {},
      { timeoutMs: 1000, retries: 2, fetchImpl: bad.fetchImpl, sleepImpl: async () => undefined, makeError: m => new MyErr(m) }
    ),
    (e: unknown) => e instanceof MyErr && /HTTP 500/.test((e as Error).message)
  );
  assert.equal(bad.calls, 2);
});

test('fetchWithRetry: no connection (DNS, no network) throws OfflineError at once; one refusing or unreachable host and a reset are retried', async () => {
  const fetchFail = (code: string): typeof fetch =>
    (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
    }) as unknown as typeof fetch;
  const seen: [string, string | null][] = [];
  setNetworkObserver((state, detail) => seen.push([state, detail]));
  try {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN']) {
      const sleeps: number[] = [];
      await assert.rejects(
        fetchWithRetry(
          'https://data.example/x',
          {},
          { timeoutMs: 1000, retries: 6, fetchImpl: fetchFail(code), sleepImpl: async ms => void sleeps.push(ms) }
        ),
        (e: unknown) => e instanceof OfflineError && e.message.includes(code) && e.message.includes('data.example')
      );
      assert.equal(sleeps.length, 0, `${code}: no backoff`);
    }
    // undici's happy-eyeballs: an AggregateError of the attempts, each with its code.
    const agg = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new AggregateError([
          Object.assign(new Error('a'), { code: 'ENETUNREACH' }),
          Object.assign(new Error('b'), { code: 'ECONNREFUSED' }),
        ]),
      });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchWithRetry('https://x', {}, { timeoutMs: 1000, retries: 3, fetchImpl: agg, sleepImpl: async () => undefined }),
      OfflineError
    );
    assert.ok(seen.length >= 5 && seen.every(([s]) => s === 'offline'));
    // One server refusing, or a router saying it cannot reach that host: the link works, so retried (and the
    // ECMWF client then fails over to the next mirror), not "no internet connection".
    for (const code of ['ECONNREFUSED', 'EHOSTUNREACH']) {
      const sleeps: number[] = [];
      await assert.rejects(
        fetchWithRetry(
          'https://x',
          {},
          { timeoutMs: 1000, retries: 3, fetchImpl: fetchFail(code), sleepImpl: async ms => void sleeps.push(ms) }
        ),
        (e: unknown) => !(e instanceof OfflineError)
      );
      assert.equal(sleeps.length, 2, `${code}: retried with backoff`);
    }
    assert.ok(
      seen.every(([s]) => s === 'offline'),
      'a refusing host does not change what the link is known to be'
    );
    // A reset mid-transfer is a failed download, retried as before; the answer after it says the link is up.
    const reset = responder([Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 200]);
    const out = await fetchWithRetry(
      'https://x',
      {},
      { timeoutMs: 1000, retries: 3, fetchImpl: reset.fetchImpl, sleepImpl: async () => undefined }
    );
    assert.equal(out.status, 200);
    assert.equal(reset.calls, 2);
    assert.deepEqual(seen[seen.length - 1], ['ok', null]);
  } finally {
    setNetworkObserver(null);
  }
});

test('parseRetryAfterMs: seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('7'), 7000);
  assert.equal(parseRetryAfterMs(null), null);
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(parseRetryAfterMs('Thu, 01 Oct 2026 00:00:30 GMT', now), 30000);
  assert.equal(parseRetryAfterMs('garbage'), null);
});

test('fetchBodyWithRetry: the answer carries its body, read inside the attempt; fetchWithRetry reads it only when asked', async () => {
  const opts = { timeoutMs: 1000, retries: 2, sleepImpl: async () => undefined };
  const withBody = await fetchBodyWithRetry('http://x/y', {}, { ...opts, fetchImpl: responder([200], 'payload').fetchImpl });
  assert.equal(new TextDecoder().decode(withBody.body), 'payload');
  const without = await fetchWithRetry('http://x/y', {}, { ...opts, fetchImpl: responder([200], 'payload').fetchImpl });
  assert.equal(without.body, null);
  const asked = await fetchWithRetry('http://x/y', {}, { ...opts, readBody: true, fetchImpl: responder([200], 'payload').fetchImpl });
  assert.ok(asked.body);
  assert.equal(new TextDecoder().decode(asked.body), 'payload');
});

// The runner's own limit: without the fix the drained body never ends, and the test would wait for ever, not fail.
test(
  "fetchWithRetry: a retriable answer's body is not read: one that never ends does not hold the next attempt",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls > 1) return new Response('payload', { status: 200 });
      // A 503 whose body never ends; as fetch does, the request's signal aborting ends it.
      const body = new ReadableStream({
        start(c) {
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      });
      return new Response(body, { status: 503 });
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry(
      'http://x/y',
      {},
      { timeoutMs: 1000, retries: 2, readBody: true, fetchImpl, sleepImpl: async () => undefined }
    );
    assert.equal(r.status, 200);
    assert.equal(calls, 2, 'the next attempt started');
  }
);
