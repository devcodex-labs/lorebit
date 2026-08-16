import assert from 'node:assert/strict';
import test from 'node:test';

import { createLorebitId } from '../../dist/index.js';
import { InMemoryVectorIndex } from '../../dist/testing/index.js';

test('VectorIndex isolates generations, reuses lineage and keeps stable ranking', async () => {
  const index = new InMemoryVectorIndex(2);
  const spaceId = createLorebitId('space', 'vector');
  const first = createLorebitId('generation', 'v1');
  const second = createLorebitId('generation', 'v2');
  const unitA = createLorebitId('unit', 'a');
  const unitB = createLorebitId('unit', 'b');
  await index.createGeneration(spaceId, first, null);
  assert.equal((await index.upsert(spaceId, first, [
    { unitId: unitA, unitVersionId: createLorebitId('unit-version', 'a1'), vector: [1, 0], metadata: {} },
    { unitId: unitB, unitVersionId: createLorebitId('unit-version', 'b1'), vector: [1, 0], metadata: {} }
  ])).ok, true);
  await index.createGeneration(spaceId, second, first);
  assert.equal((await index.reuse(
    spaceId,
    second,
    unitA,
    createLorebitId('unit-version', 'a2'),
    { moved: true }
  )).ok, true);
  await index.delete(spaceId, second, [unitB]);
  assert.deepEqual(await index.manifest(spaceId, first), {
    ok: true,
    value: ['unit-version_a1', 'unit-version_b1']
  });
  assert.deepEqual(await index.manifest(spaceId, second), {
    ok: true,
    value: ['unit-version_a2']
  });
  const ranked = await index.query(spaceId, first, [1, 0], 2);
  assert.deepEqual(ranked.value.map((item) => item.unitId), [unitA, unitB]);
});

test('VectorIndex rejects dimension mismatch and cross-space lookup', async () => {
  const index = new InMemoryVectorIndex(2);
  const spaceId = createLorebitId('space', 'vector-a');
  const generationId = createLorebitId('generation', 'v1');
  await index.createGeneration(spaceId, generationId, null);
  const mismatch = await index.upsert(spaceId, generationId, [{
    unitId: createLorebitId('unit', 'a'),
    unitVersionId: createLorebitId('unit-version', 'a1'),
    vector: [1],
    metadata: {}
  }]);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'dimension-mismatch');
  const escaped = await index.count(createLorebitId('space', 'vector-b'), generationId);
  assert.equal(escaped.ok, false);
  assert.equal(escaped.code, 'generation-not-found');
});
