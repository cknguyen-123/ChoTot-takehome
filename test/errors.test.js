import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import { createApp } from '../src/app.js';
import { AppError, createErrorHandler, notFoundHandler } from '../src/http/errors.js';
import { createLogger, silentLogger } from '../src/logger.js';
import { startTestServer } from './helpers/http.js';

let server;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function assertErrorShape(body, code) {
  assert.equal(typeof body.error, 'object');
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
}

describe('application error responses', () => {
  it('unknown route → 404 in the API error shape', async () => {
    server = await startTestServer(createApp({ logger: silentLogger }));
    const res = await fetch(`${server.baseUrl}/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assertErrorShape(await res.json(), 'not_found');
  });

  it('malformed JSON body → 400 invalid_json', async () => {
    server = await startTestServer(createApp({ logger: silentLogger }));
    const res = await fetch(`${server.baseUrl}/v1/listings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title": ',
    });
    assert.equal(res.status, 400);
    assertErrorShape(await res.json(), 'invalid_json');
  });

  it('body over the size limit → 413 payload_too_large', async () => {
    server = await startTestServer(createApp({ logger: silentLogger }));
    const res = await fetch(`${server.baseUrl}/v1/listings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x'.repeat(100 * 1024) }),
    });
    assert.equal(res.status, 413);
    assertErrorShape(await res.json(), 'payload_too_large');
  });

  it('does not advertise the framework', async () => {
    server = await startTestServer(createApp({ logger: silentLogger }));
    const res = await fetch(`${server.baseUrl}/livez`);
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('error handler', () => {
  function appThatThrows(err, logger = silentLogger) {
    const app = express();
    app.get('/sync', () => { throw err; });
    app.get('/async', async () => { throw err; });
    app.use(notFoundHandler);
    app.use(createErrorHandler(logger));
    return app;
  }

  for (const route of ['/sync', '/async']) {
    it(`maps AppError to its status and code (${route})`, async () => {
      server = await startTestServer(appThatThrows(new AppError(422, 'unknown_seller', 'Seller not found')));
      const res = await fetch(`${server.baseUrl}${route}`);
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { error: { code: 'unknown_seller', message: 'Seller not found' } });
    });

    it(`hides unexpected errors behind 500 internal_error and logs them (${route})`, async () => {
      const lines = [];
      const logger = createLogger({ write: (_lvl, line) => lines.push(JSON.parse(line)) });
      server = await startTestServer(appThatThrows(new Error('relation "listings" does not exist'), logger));

      const res = await fetch(`${server.baseUrl}${route}`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assertErrorShape(body, 'internal_error');
      assert.ok(!JSON.stringify(body).includes('relation'), 'internal details must not leak');

      const logged = lines.find((l) => l.msg === 'unhandled error');
      assert.ok(logged, 'error must be logged');
      assert.equal(logged.err.message, 'relation "listings" does not exist');
    });
  }
});
