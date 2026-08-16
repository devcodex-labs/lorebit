import assert from 'node:assert/strict';
import test from 'node:test';

import { canTransitionRevision } from '../../dist/index.js';

test('RevisionStatus allows processing paths and blocks history resurrection', () => {
  assert.equal(canTransitionRevision('draft', 'processing'), true);
  assert.equal(canTransitionRevision('processing', 'partial'), true);
  assert.equal(canTransitionRevision('processing', 'failed'), true);
  assert.equal(canTransitionRevision('processing', 'active'), true);
  assert.equal(canTransitionRevision('active', 'superseded'), true);
  assert.equal(canTransitionRevision('active', 'withdrawn'), true);
  assert.equal(canTransitionRevision('withdrawn', 'active'), false);
  assert.equal(canTransitionRevision('archived', 'draft'), false);
});

test('DecisionStatus is not accepted as a RevisionStatus transition', () => {
  assert.equal(canTransitionRevision('draft', 'approved'), false);
});
