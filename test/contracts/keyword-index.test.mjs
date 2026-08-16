import assert from 'node:assert/strict';
import test from 'node:test';

import { createLorebitId } from '../../dist/index.js';
import { InMemoryKeywordIndex } from '../../dist/testing/index.js';

test('KeywordIndex clones generations and returns stable token-overlap ranking', async () => {
  const index = new InMemoryKeywordIndex();
  const spaceId = createLorebitId('space', 'keyword');
  const first = createLorebitId('generation', 'k1');
  const second = createLorebitId('generation', 'k2');
  const unitA = createLorebitId('unit', 'a');
  const unitB = createLorebitId('unit', 'b');
  await index.createGeneration(spaceId, first, null);
  await index.upsert(spaceId, first, [
    { unitId: unitA, unitVersionId: createLorebitId('unit-version', 'a1'), text: 'alpha beta', metadata: {} },
    { unitId: unitB, unitVersionId: createLorebitId('unit-version', 'b1'), text: 'alpha gamma', metadata: {} }
  ]);
  const ranked = await index.query(spaceId, first, 'alpha', 2);
  assert.deepEqual(ranked.value.map((item) => item.unitId), [unitA, unitB]);
  await index.createGeneration(spaceId, second, first);
  await index.delete(spaceId, second, [unitA]);
  assert.equal((await index.count(spaceId, first)).value, 2);
  assert.equal((await index.count(spaceId, second)).value, 1);
});
