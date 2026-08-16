import assert from 'node:assert/strict';
import test from 'node:test';

import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

test('100 concurrent runtime queries have unique plans and one frozen active generation', async (t) => {
  const fixture = await createQueryFixture({ seed: 'runtime-concurrency' });
  t.after(() => fixture.runtime.close());
  const request = await queryRequest(fixture);
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => fixture.runtime.retrieve({
    ...request,
    query: `${request.query} lorebit concurrency ${index}`
  })));
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(new Set(results.map((result) => result.value.queryPlan.queryPlanId)).size, 100);
  assert.deepEqual([...new Set(results.map((result) => result.value.queryPlan.generationId))], [fixture.idsByKind.generationId]);
  assert.deepEqual([...new Set(results.map((result) => result.value.queryPlan.activationId))], [fixture.idsByKind.activationId]);
});
