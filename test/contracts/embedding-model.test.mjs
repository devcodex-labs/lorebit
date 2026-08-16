import assert from 'node:assert/strict';
import test from 'node:test';

import { DeterministicEmbeddingModel } from '../../dist/testing/index.js';

test('EmbeddingModel is deterministic, dimensioned and bounded', async () => {
  const model = new DeterministicEmbeddingModel(8, 2, 32);
  const first = await model.embed(['alpha', 'beta']);
  const second = await model.embed(['alpha', 'beta']);
  assert.equal(first.ok, true);
  assert.deepEqual(first.vectors, second.vectors);
  assert.equal(first.vectors.every((vector) => vector.length === 8), true);
  const tooMany = await model.embed(['a', 'b', 'c']);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'input-too-large');
});

test('EmbeddingModel propagates AbortSignal without durable state', async () => {
  const model = new DeterministicEmbeddingModel();
  const controller = new AbortController();
  controller.abort();
  const result = await model.embed(['cancel'], { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
});
