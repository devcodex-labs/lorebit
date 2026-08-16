import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PROCESSING_RESOURCE_LIMITS,
  HARD_PROCESSING_RESOURCE_LIMITS,
  createLorebitId,
  resolveProcessingResourceLimits
} from '../../dist/index.js';

test('ContentUnit identities use distinct logical and version clocks', () => {
  assert.equal(createLorebitId('unit', 'guide'), 'unit_guide');
  assert.equal(createLorebitId('unit-version', 'guide-v1'), 'unit-version_guide-v1');
  assert.notEqual(createLorebitId('unit', 'guide'), createLorebitId('unit-version', 'guide-v1'));
});

test('processing limits are bounded by deterministic defaults and hard caps', () => {
  assert.equal(DEFAULT_PROCESSING_RESOURCE_LIMITS.maxSourceBytes, 10 * 1024 * 1024);
  assert.equal(HARD_PROCESSING_RESOURCE_LIMITS.maxUnitBytes, 256 * 1024);
  assert.equal(resolveProcessingResourceLimits({ maxUnitBytes: 128 * 1024 }).maxUnitBytes, 128 * 1024);
  assert.equal(resolveProcessingResourceLimits({ maxUnitBytes: 256 * 1024 + 1 }), null);
  assert.equal(resolveProcessingResourceLimits({ maxUnitsPerRevision: 0 }), null);
});
