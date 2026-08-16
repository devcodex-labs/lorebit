import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONTEXT_BUDGET, createLorebitId } from '../../dist/index.js';

test('QueryPlan identity is not one of the five version clocks', () => {
  const queryPlanId = createLorebitId('query-plan', 'q1');
  assert.equal(queryPlanId, 'query-plan_q1');
  assert.deepEqual(DEFAULT_CONTEXT_BUDGET, {
    maxEvidence: 50,
    maxUtf8Bytes: 262144,
    maxTokens: 8192
  });
  assert.equal(Object.isFrozen(DEFAULT_CONTEXT_BUDGET), true);
});
