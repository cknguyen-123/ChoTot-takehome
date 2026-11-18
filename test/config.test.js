import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses defaults when nothing is set', () => {
    const config = loadConfig({});
    assert.equal(config.port, 8080);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.shutdownTimeoutMs, 10_000);
    assert.equal(config.readinessCheckTimeoutMs, 2_000);
  });

  it('treats empty strings as unset', () => {
    assert.equal(loadConfig({ PORT: '' }).port, 8080);
  });

  it('reads PORT', () => {
    assert.equal(loadConfig({ PORT: '8081' }).port, 8081);
  });

  for (const bad of ['abc', '0', '70000', '80.5', '-1']) {
    it(`rejects PORT="${bad}"`, () => {
      assert.throws(() => loadConfig({ PORT: bad }), /PORT must be an integer/);
    });
  }

  it('rejects an unknown LOG_LEVEL', () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/);
  });

  it('returns a frozen object', () => {
    assert.ok(Object.isFrozen(loadConfig({})));
  });
});
