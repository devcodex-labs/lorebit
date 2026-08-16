import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvaluationModule,
  digestEvaluationCase
} from '../../dist/index.js';
import {
  DeterministicIdGenerator,
  FakeClock
} from '../../dist/testing/index.js';
import { createQueryFixture } from '../fixtures/query-runtime.mjs';

test('E2E-12: evaluation records method/version/uncertainty and enforces regression quality gates', async (t) => {
  const evaluationClock = new FakeClock('2026-08-13T09:00:00.000Z');
  const evaluationIds = new DeterministicIdGenerator('evaluation');
  const evaluation = createEvaluationModule({
    clock: evaluationClock,
    ids: evaluationIds,
    evaluator: {
      method: 'fixture-claim-attribution',
      evaluator: 'deterministic-test-evaluator',
      model: null,
      version: '1.2.0',
      deterministic: true,
      async evaluate() {
        return {
          support: 'supported',
          faithfulness: 0.95,
          conflictScore: 0,
          uncertainty: 0.05,
          limitations: ['fixture evaluator only']
        };
      }
    }
  });
  const fixture = await createQueryFixture({ evaluation });
  t.after(() => fixture.runtime.close());

  const versionRefs = {
    policyId: fixture.idsByKind.policyId,
    activationId: fixture.idsByKind.activationId,
    recipeId: fixture.idsByKind.recipeId,
    generationId: fixture.idsByKind.generationId,
    revisionIds: [fixture.idsByKind.revisionId]
  };
  const evaluationCaseDefinition = {
    caseId: 'case-1',
    spaceId: fixture.idsByKind.spaceId,
    question: 'How are citations preserved?',
    expectedScope: 'lorebit',
    expectedSourceIds: [fixture.idsByKind.sourceId],
    expectedCitationIds: ['citation-expected'],
    constraints: { requireCitation: true },
    versionRefs
  };
  const evaluationCase = { ...evaluationCaseDefinition, fixtureDigest: await digestEvaluationCase(evaluationCaseDefinition) };
  const observation = {
    caseId: 'case-1',
    retrievedSourceIds: [fixture.idsByKind.sourceId],
    citationIds: ['citation-expected'],
    contextCompliant: true,
    generationConstraintPass: true,
    versionRefs,
    claims: [{ claimId: 'claim-1', claim: 'Citations preserve version identity.', citationIds: ['citation-expected'] }],
    evidence: [{ citationId: 'citation-expected', content: 'Evidence fixture.' }]
  };

  const baseline = await fixture.runtime.evaluate({
    suiteId: 'suite-runtime',
    targetRef: 'baseline',
    cases: [evaluationCase],
    observations: [observation]
  });
  assert.equal(baseline.ok, true);
  assert.equal(baseline.value.method, 'fixture-claim-attribution');
  assert.equal(baseline.value.version, '1.2.0');
  assert.equal(baseline.value.uncertainty, 0.05);
  assert.equal(baseline.value.cases[0].claims[0].limitations.some((value) => value.includes('probabilistic evaluation')), true);

  evaluationClock.advanceMilliseconds(1);
  const candidate = await fixture.runtime.evaluate({
    suiteId: 'suite-runtime',
    targetRef: 'candidate',
    cases: [evaluationCase],
    observations: [{ ...observation, retrievedSourceIds: [], citationIds: [] }]
  });
  assert.equal(candidate.ok, true);
  const comparison = await fixture.runtime.compareEvaluations(baseline.value, candidate.value);
  assert.equal(comparison.ok, true);
  assert.equal(comparison.value.regressions.includes('retrievalRecall'), true);
  assert.equal(comparison.value.regressions.includes('citationCompleteness'), true);

  const gate = await fixture.runtime.applyQualityGate(candidate.value, {
    gateId: 'release-gate',
    minimums: { retrievalRecall: 0.9, citationCompleteness: 0.9 },
    maximumRegression: 0.05,
    requireNoUncoveredClaims: true
  }, comparison.value);
  assert.equal(gate.ok, true);
  assert.equal(gate.value.status, 'failed');
  assert.equal(gate.value.failures.some((failure) => failure.startsWith('retrievalRecall:regression')), true);
  const mismatchedGate = await fixture.runtime.applyQualityGate(baseline.value, {
    gateId: 'wrong-target-gate',
    minimums: {},
    maximumRegression: 0.05,
    requireNoUncoveredClaims: false
  }, comparison.value);
  assert.equal(mismatchedGate.ok, false);
  assert.equal(mismatchedGate.error.code, 'invalid-request');

  const feedback = {
    feedbackId: 'feedback-1',
    caseId: 'case-1',
    kind: 'human',
    rating: 4,
    labels: ['useful'],
    comment: 'Citation was useful.',
    actorRef: 'reviewer:test',
    createdAt: evaluationClock.now()
  };
  assert.equal((await fixture.runtime.recordEvaluationFeedback(feedback)).ok, true);
  const duplicateFeedback = await fixture.runtime.recordEvaluationFeedback(feedback);
  assert.equal(duplicateFeedback.ok, false);
  assert.equal(duplicateFeedback.error.code, 'invalid-request');
  const listed = await fixture.runtime.listEvaluationFeedback('case-1');
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.value, [feedback]);
});

test('disabled claim evaluator marks uncovered scope instead of claiming factual proof', async (t) => {
  const clock = new FakeClock('2026-08-13T09:30:00.000Z');
  const evaluation = createEvaluationModule({ clock, ids: new DeterministicIdGenerator('disabled-eval') });
  const fixture = await createQueryFixture({ evaluation });
  t.after(() => fixture.runtime.close());
  const versionRefs = {
    policyId: fixture.idsByKind.policyId,
    activationId: fixture.idsByKind.activationId,
    recipeId: fixture.idsByKind.recipeId,
    generationId: fixture.idsByKind.generationId,
    revisionIds: [fixture.idsByKind.revisionId]
  };
  const caseDefinition = {
    caseId: 'uncovered',
    spaceId: fixture.idsByKind.spaceId,
    question: 'Is this claim proven?',
    expectedScope: 'lorebit',
    expectedSourceIds: [],
    expectedCitationIds: [],
    constraints: {},
    versionRefs
  };
  const result = await fixture.runtime.evaluate({
    suiteId: 'suite-uncovered',
    targetRef: 'candidate',
    cases: [{ ...caseDefinition, fixtureDigest: await digestEvaluationCase(caseDefinition) }],
    observations: [{
      caseId: 'uncovered',
      retrievedSourceIds: [],
      citationIds: [],
      contextCompliant: true,
      generationConstraintPass: null,
      versionRefs,
      claims: [{ claimId: 'claim-uncovered', claim: 'Unproven claim.', citationIds: [] }],
      evidence: []
    }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.cases[0].claims[0].support, 'uncovered');
  assert.equal(result.value.cases[0].claims[0].method, 'disabled');
  assert.equal(result.value.uncertainty, 1);
});

test('evaluation fixtures are content-addressed and version mismatches remain uncovered', async (t) => {
  const clock = new FakeClock('2026-08-13T09:45:00.000Z');
  const evaluation = createEvaluationModule({ clock, ids: new DeterministicIdGenerator('pinned-eval') });
  const fixture = await createQueryFixture({ seed: 'pinned-eval', evaluation });
  t.after(() => fixture.runtime.close());
  const versionRefs = {
    policyId: fixture.idsByKind.policyId,
    activationId: fixture.idsByKind.activationId,
    recipeId: fixture.idsByKind.recipeId,
    generationId: fixture.idsByKind.generationId,
    revisionIds: [fixture.idsByKind.revisionId]
  };
  const definition = {
    caseId: 'pinned-case',
    spaceId: fixture.idsByKind.spaceId,
    question: 'Which generation produced this evidence?',
    expectedScope: 'lorebit',
    expectedSourceIds: [fixture.idsByKind.sourceId],
    expectedCitationIds: [],
    constraints: {},
    versionRefs
  };
  const fixtureDigest = await digestEvaluationCase(definition);
  const cases = [{ ...definition, fixtureDigest }];
  const mismatchedVersion = { ...versionRefs, generationId: null };
  const evaluated = await fixture.runtime.evaluate({
    suiteId: 'pinned-suite',
    targetRef: 'candidate',
    cases,
    observations: [{
      caseId: 'pinned-case',
      retrievedSourceIds: [fixture.idsByKind.sourceId],
      citationIds: [],
      contextCompliant: true,
      generationConstraintPass: null,
      versionRefs: mismatchedVersion,
      claims: [],
      evidence: []
    }]
  });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.value.cases[0].versionMatch, false);
  assert.equal(evaluated.value.cases[0].retrievalRecall, null);
  assert.equal(evaluated.value.cases[0].uncovered.includes('version-mismatch'), true);
  assert.equal(evaluated.value.aggregate.versionCompliance, 0);

  const tampered = await fixture.runtime.evaluate({
    suiteId: 'pinned-suite',
    targetRef: 'tampered',
    cases: [{ ...cases[0], question: 'Changed without updating digest.' }],
    observations: []
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.error.code, 'invalid-request');

  const otherSuite = { ...evaluated.value, suiteId: 'other-suite', evaluationId: fixture.ids.next('evaluation') };
  const comparison = await fixture.runtime.compareEvaluations(evaluated.value, otherSuite);
  assert.equal(comparison.ok, false);
  assert.equal(comparison.error.code, 'invalid-request');
});
