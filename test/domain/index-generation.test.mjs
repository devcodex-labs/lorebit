import assert from 'node:assert/strict';
import test from 'node:test';

import { canTransitionIndexGeneration } from '../../dist/index.js';

test('IndexGeneration keeps shadow build, validation and activation separate', () => {
  assert.equal(canTransitionIndexGeneration('planned', 'building'), true);
  assert.equal(canTransitionIndexGeneration('building', 'validating'), true);
  assert.equal(canTransitionIndexGeneration('validating', 'ready'), true);
  assert.equal(canTransitionIndexGeneration('ready', 'active'), true);
  assert.equal(canTransitionIndexGeneration('building', 'active'), false);
  assert.equal(canTransitionIndexGeneration('failed', 'active'), false);
  assert.equal(canTransitionIndexGeneration('cancelled', 'ready'), false);
});
