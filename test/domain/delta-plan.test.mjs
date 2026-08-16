import assert from 'node:assert/strict';
import test from 'node:test';

import { createLorebitId, summarizeDelta } from '../../dist/index.js';

test('DeltaPlan summary preserves every unique auditable classification', () => {
  const kinds = [
    'added',
    'changed',
    'unchanged',
    'moved',
    'deleted',
    'visibility-changed',
    'quarantined',
    'unknown'
  ];
  const items = kinds.map((kind, index) => ({
    unitId: createLorebitId('unit', `u${index}`),
    kind,
    previousUnitVersionId: null,
    nextUnitVersionId: null,
    reuse: 'none',
    reason: kind
  }));
  const summary = summarizeDelta(items);
  assert.deepEqual(Object.keys(summary), kinds);
  assert.equal(Object.values(summary).every((count) => count === 1), true);
});
