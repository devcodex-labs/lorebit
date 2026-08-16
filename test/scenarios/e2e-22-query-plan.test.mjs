import assert from 'node:assert/strict';
import test from 'node:test';

import { DeterministicReranker, DeterministicTokenCounter } from '../../dist/testing/index.js';
import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

test('E2E-22 every execution freezes route/filter/topK/reranker/budget into a distinct QueryPlanSnapshot', async (t) => {
  const fixture = await createQueryFixture({
    reranker: new DeterministicReranker(),
    tokenCounter: new DeterministicTokenCounter()
  });
  t.after(() => fixture.runtime.close());
  const semanticRequest = await queryRequest(fixture, { route: 'semantic', topK: 1, rerank: false });
  const semantic = await fixture.runtime.retrieve(semanticRequest);
  assert.equal(semantic.ok, true);
  const frozenPlan = structuredClone(semantic.value.queryPlan);
  semanticRequest.topK = 3;
  assert.deepEqual(semantic.value.queryPlan, frozenPlan);

  const keyword = await fixture.runtime.retrieve(await queryRequest(fixture, {
    route: 'keyword',
    topK: 2,
    filter: { op: 'eq', field: 'metadata.section', value: 2 }
  }));
  assert.equal(keyword.ok, true);
  const contextual = await fixture.runtime.buildContext(await queryRequest(fixture, {
    mode: 'context',
    route: 'hybrid',
    rerank: true,
    contextBudget: { maxEvidence: 1, maxUtf8Bytes: 128, maxTokens: 20 }
  }));
  assert.equal(contextual.ok, true);
  assert.equal(new Set([
    semantic.value.queryPlan.digest.value,
    keyword.value.queryPlan.digest.value,
    contextual.value.queryPlan.digest.value
  ]).size, 3);
  assert.equal(keyword.value.queryPlan.filter.predicates.some((entry) => entry.field === 'metadata.section'), true);
  assert.equal(contextual.value.queryPlan.reranker !== null, true);
  assert.deepEqual(contextual.value.queryPlan.contextBudget, { maxEvidence: 1, maxUtf8Bytes: 128, maxTokens: 20 });
  assert.equal(contextual.value.provenance.queryPlanDigest.value, contextual.value.queryPlan.digest.value);
});
