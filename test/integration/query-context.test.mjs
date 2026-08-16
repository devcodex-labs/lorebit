import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeterministicReranker,
  DeterministicTokenCounter
} from '../../dist/testing/index.js';
import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

test('active snapshot → hybrid retrieve → rerank → citations → structured context', async (t) => {
  const reranker = new DeterministicReranker();
  const tokenCounter = new DeterministicTokenCounter();
  const fixture = await createQueryFixture({ reranker, tokenCounter });
  t.after(() => fixture.runtime.close());

  const request = await queryRequest(fixture, {
    rerank: true,
    trustedDirective: 'Answer only from cited evidence.',
    knownConflicts: [{
      conflictId: 'conflict-tone',
      unitIds: [],
      summary: 'No automatic winner is selected.'
    }]
  });
  const retrieved = await fixture.runtime.retrieve(request);
  assert.equal(retrieved.ok, true);
  assert.equal(retrieved.value.mode, 'retrieve');
  assert.equal(retrieved.value.queryPlan.route, 'hybrid');
  assert.equal(retrieved.value.queryPlan.filter.fullness, 'full');
  assert.equal(retrieved.value.queryPlan.reranker.adapterId, reranker.descriptor.adapterId);
  assert.equal(retrieved.value.citations.length > 0, true);
  assert.equal(retrieved.value.retrieval.candidates.every((candidate) => candidate.trust === 'untrusted-retrieved-data'), true);
  assert.equal(retrieved.value.provenance.queryPlanDigest.value, retrieved.value.queryPlan.digest.value);

  const contextual = await fixture.runtime.buildContext({ ...request, mode: 'context' });
  assert.equal(contextual.ok, true);
  assert.equal(contextual.value.mode, 'context');
  assert.equal(contextual.value.context.trustedDirective.source, 'caller');
  assert.equal(contextual.value.context.evidence.every((entry) => entry.trust === 'untrusted-retrieved-data'), true);
  assert.equal(contextual.value.context.provenance.manifestDigest.value, contextual.value.provenance.contextManifestDigest.value);
  assert.equal(contextual.value.context.usage.tokens > 0, true);
  assert.equal(contextual.value.citations.length, contextual.value.context.evidence.length);
  assert.equal(fixture.runtime.profile().retrieveContext, 'deterministic');
  assert.equal(fixture.runtime.readiness().operations.retrieve, true);
  assert.equal(fixture.runtime.readiness().operations.context, true);
});

test('context remains bounded and explains exclusions when TokenCounter is absent', async (t) => {
  const fixture = await createQueryFixture();
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.buildContext(await queryRequest(fixture, {
    mode: 'context',
    contextBudget: { maxEvidence: 1, maxUtf8Bytes: 256, maxTokens: 8 }
  }));
  assert.equal(result.ok, true);
  assert.equal(result.value.context.evidence.length, 1);
  assert.equal(result.value.context.excluded.some((entry) => entry.reason === 'budget-evidence'), true);
  assert.equal(result.value.context.usage.tokens, null);
  assert.equal(result.value.limitations.some((value) => value.includes('token estimate unavailable')), true);
});
