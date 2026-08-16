import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvaluationModule, digestEvaluationCase } from '../../dist/index.js';
import { DeterministicIdGenerator, FakeClock } from '../../dist/testing/index.js';
import { createQueryFixture } from '../fixtures/query-runtime.mjs';

test('E2E-12 evaluator failure becomes uncovered uncertainty without leaking provider details', async (t) => {
  const clock = new FakeClock('2026-08-13T11:10:00.000Z');
  const evaluation = createEvaluationModule({
    clock,
    ids: new DeterministicIdGenerator('e2e12'),
    evaluator: {
      method: 'fault-injection',
      evaluator: 'scripted-evaluator',
      model: 'scripted-evaluator-model',
      version: '1.0',
      deterministic: true,
      async evaluate() { throw new Error('Bearer evaluator-secret'); }
    }
  });
  const fixture = await createQueryFixture({ seed: 'e2e12', evaluation });
  t.after(() => fixture.runtime.close());
  const versionRefs = {
    policyId: fixture.idsByKind.policyId,
    activationId: fixture.idsByKind.activationId,
    recipeId: fixture.idsByKind.recipeId,
    generationId: fixture.idsByKind.generationId,
    revisionIds: [fixture.idsByKind.revisionId]
  };
  const caseDefinition = {
    caseId: 'e2e12-case',
    spaceId: fixture.idsByKind.spaceId,
    question: 'Is the claim supported?',
    expectedScope: 'lorebit',
    expectedSourceIds: [],
    expectedCitationIds: [],
    constraints: {},
    versionRefs
  };
  const result = await fixture.runtime.evaluate({
    suiteId: 'e2e12-suite',
    targetRef: 'candidate',
    cases: [{ ...caseDefinition, fixtureDigest: await digestEvaluationCase(caseDefinition) }],
    observations: [{
      caseId: 'e2e12-case',
      retrievedSourceIds: [],
      citationIds: [],
      contextCompliant: true,
      generationConstraintPass: null,
      versionRefs,
      claims: [{ claimId: 'claim-1', claim: 'A claim.', citationIds: [] }],
      evidence: []
    }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.cases[0].claims[0].support, 'uncovered');
  assert.equal(result.value.cases[0].claims[0].uncertainty, 1);
  assert.equal(JSON.stringify(result).includes('evaluator-secret'), false);
});
