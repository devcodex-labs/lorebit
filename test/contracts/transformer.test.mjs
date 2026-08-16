import assert from 'node:assert/strict';
import test from 'node:test';

import { PassThroughTransformer } from '../../dist/testing/index.js';

function request(content, signal) {
  return {
    source: { visibilityLabels: ['public'] },
    revision: {
      locator: { kind: 'url', value: 'https://example.test/docs', fragment: null },
      metadata: { classification: 'public' }
    },
    recipe: {},
    content,
    options: signal === undefined ? {} : { signal }
  };
}

test('ContentTransformer preserves locator and visibility projection', async () => {
  const transformer = new PassThroughTransformer();
  const result = await transformer.transform(request(new TextEncoder().encode('Lorebit')));
  assert.equal(result.ok, true);
  assert.equal(result.units[0].stableKey, 'document');
  assert.equal(result.units[0].locator.source.value, 'https://example.test/docs');
  assert.deepEqual(result.units[0].visibility, { labels: ['public'] });
  assert.equal(result.units[0].disposition, 'available');
});

test('ContentTransformer quarantines malformed UTF-8 and propagates cancellation', async () => {
  const transformer = new PassThroughTransformer();
  const malformed = await transformer.transform(request(new Uint8Array([0xc3, 0x28])));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'content-quarantined');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await transformer.transform(request(new Uint8Array(), controller.signal));
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'cancelled');
});
