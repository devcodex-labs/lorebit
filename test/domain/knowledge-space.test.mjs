import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canTransitionKnowledgeSpace,
  createLorebitId,
  decodeLorebitId
} from '../../dist/index.js';

test('KnowledgeSpace has a stable scoped identity', () => {
  const id = createLorebitId('space', 'tenant-a');
  assert.equal(id, 'space_tenant-a');
  assert.deepEqual(decodeLorebitId('space', id), { ok: true, value: id });
  assert.equal(decodeLorebitId('source', id).ok, false);
});

test('KnowledgeSpace lifecycle rejects reopening an archived space', () => {
  assert.equal(canTransitionKnowledgeSpace('open', 'frozen'), true);
  assert.equal(canTransitionKnowledgeSpace('frozen', 'open'), true);
  assert.equal(canTransitionKnowledgeSpace('open', 'archived'), true);
  assert.equal(canTransitionKnowledgeSpace('archived', 'open'), false);
});
