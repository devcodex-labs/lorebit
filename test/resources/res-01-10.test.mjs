import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_PROCESSING_RESOURCE_LIMITS,
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  HARD_PROCESSING_RESOURCE_LIMITS,
  HARD_RUNTIME_RESOURCE_LIMITS
} from '../../dist/index.js';

test('RES-01–RES-10 frozen deterministic resource matrix is represented by executable constants', () => {
  const matrix = {
    'RES-01': [DEFAULT_PROCESSING_RESOURCE_LIMITS.maxSourceBytes, HARD_PROCESSING_RESOURCE_LIMITS.maxSourceBytes],
    'RES-02': [DEFAULT_RUNTIME_RESOURCE_LIMITS.importMaxSources, DEFAULT_RUNTIME_RESOURCE_LIMITS.importMaxUtf8Bytes],
    'RES-03': [DEFAULT_PROCESSING_RESOURCE_LIMITS.maxUnitBytes, HARD_PROCESSING_RESOURCE_LIMITS.maxUnitsPerRevision],
    'RES-04': [
      DEFAULT_RUNTIME_RESOURCE_LIMITS.processingConcurrency,
      DEFAULT_RUNTIME_RESOURCE_LIMITS.importConcurrency,
      DEFAULT_RUNTIME_RESOURCE_LIMITS.rebuildConcurrency,
      DEFAULT_RUNTIME_RESOURCE_LIMITS.queryConcurrency,
      DEFAULT_RUNTIME_RESOURCE_LIMITS.generateConcurrency
    ],
    'RES-05': [DEFAULT_RUNTIME_RESOURCE_LIMITS.maxQueuedOperations, HARD_RUNTIME_RESOURCE_LIMITS.maxQueuedOperations],
    'RES-06': [20, 100, 200],
    'RES-07': [DEFAULT_CONTEXT_BUDGET.maxEvidence, DEFAULT_CONTEXT_BUDGET.maxUtf8Bytes, DEFAULT_CONTEXT_BUDGET.maxTokens],
    'RES-08': [DEFAULT_RUNTIME_RESOURCE_LIMITS.maxResultBytes, DEFAULT_RUNTIME_RESOURCE_LIMITS.maxInFlightBytes],
    'RES-09': [DEFAULT_RUNTIME_RESOURCE_LIMITS.retryMaxAttempts, DEFAULT_RUNTIME_RESOURCE_LIMITS.retryBaseMilliseconds, DEFAULT_RUNTIME_RESOURCE_LIMITS.retryMaxMilliseconds],
    'RES-10': [DEFAULT_RUNTIME_RESOURCE_LIMITS.cancellationGraceMilliseconds]
  };
  assert.deepEqual(Object.keys(matrix), Array.from({ length: 10 }, (_, index) => `RES-${String(index + 1).padStart(2, '0')}`));
  assert.equal(Object.values(matrix).every((values) => values.every((value) => Number.isSafeInteger(value) && value > 0)), true);
  assert.equal(DEFAULT_RUNTIME_RESOURCE_LIMITS.queryConcurrency <= HARD_RUNTIME_RESOURCE_LIMITS.queryConcurrency, true);
  assert.equal(DEFAULT_RUNTIME_RESOURCE_LIMITS.processingConcurrency, 4);
  assert.equal(DEFAULT_PROCESSING_RESOURCE_LIMITS.maxUnitBytes <= HARD_PROCESSING_RESOURCE_LIMITS.maxUnitBytes, true);
});
