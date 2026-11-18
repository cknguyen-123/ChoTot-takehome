import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { silentLogger } from '../src/logger.js';
import { startTestServer } from './helpers/http.js';

let server;

async function start(options = {}) {
  server = await startTestServer(createApp({ logger: silentLogger, ...options }));
  return server.baseUrl;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('GET /livez', () => {
  it('returns 200 {status: "ok"}', async () => {
    const base = await start();
    const res = await fetch(`${base}/livez`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('stays 200 even when readiness checks fail', async () => {
    const base = await start({
      readinessChecks: [{ name: 'db', run: () => { throw new Error('down'); } }],
    });
    const res = await fetch(`${base}/livez`);
    assert.equal(res.status, 200);
  });
});

describe('GET /readyz', () => {
  it('returns 200 when there are no checks', async () => {
    const base = await start();
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  it('returns 200 and lists every check when all pass (sync and async)', async () => {
    const base = await start({
      readinessChecks: [
        { name: 'seed', run: () => {} },
        { name: 'db', run: async () => {} },
      ],
    });
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', checks: { seed: 'ok', db: 'ok' } });
  });

  it('returns 503 when any check throws, without leaking the error message', async () => {
    const base = await start({
      readinessChecks: [
        { name: 'seed', run: () => {} },
        { name: 'db', run: async () => { throw new Error('password authentication failed'); } },
      ],
    });
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { status: 'unavailable', checks: { seed: 'ok', db: 'failed' } });
    assert.ok(!JSON.stringify(body).includes('password'));
  });

  it('returns 503 when a check does not finish within the timeout', async () => {
    const base = await start({
      readinessCheckTimeoutMs: 50,
      readinessChecks: [{ name: 'slow', run: () => new Promise((r) => setTimeout(r, 1_000)) }],
    });
    const started = Date.now();
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 503);
    assert.deepEqual((await res.json()).checks, { slow: 'failed' });
    assert.ok(Date.now() - started < 900, 'readyz must not wait for the slow check');
  });

  it('reflects state changes between calls (e.g. shutdown)', async () => {
    let shuttingDown = false;
    const base = await start({
      readinessChecks: [{ name: 'accepting_traffic', run: () => { if (shuttingDown) throw new Error('x'); } }],
    });
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    shuttingDown = true;
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  });
});
