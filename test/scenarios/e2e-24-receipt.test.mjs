import assert from 'node:assert/strict';
import test from 'node:test';

import { createLorebit, createLorebitId, digestBytes } from '../../dist/index.js';
import {
  DeterministicEmbeddingModel,
  DeterministicIdGenerator,
  FakeClock,
  InMemoryContentStore,
  InMemoryKeywordIndex,
  InMemoryKnowledgeRepository,
  InMemoryVectorIndex,
  PassThroughTransformer,
  RecordingEventSink
} from '../../dist/testing/index.js';

function policy(clock) {
  return {
    changeKind: 'index-affecting',
    questionScope: { allowed: ['receipt'], denied: [] },
    admission: { allowedSourceKinds: ['document'], requiredMetadata: [] },
    evidence: { minimumCitations: 1, allowedEvidenceKinds: ['primary'], onInsufficientEvidence: 'empty' },
    defaultResult: { allowPartial: false, allowHistorical: true, emptyResult: 'empty' },
    access: { requiredLabels: [], excludedLabels: [], failClosed: true },
    exposure: { hiddenFields: [], hiddenContentLabels: [] },
    retention: { auditDays: 30, contentDays: null, tombstoneOnExpiry: true },
    extensions: {},
    validFrom: clock.now(),
    validUntil: null
  };
}

function envelope(ids, clock, payload, expected, key) {
  return {
    schemaVersion: '1.0',
    commandType: payload.type,
    operationId: ids.next('operation'),
    idempotencyKey: key,
    actorRef: { type: 'scenario', id: 'e2e-24' },
    reason: key,
    occurredAt: clock.now(),
    expected,
    payload
  };
}

async function runtimeFor(shared, fingerprint) {
  const created = await createLorebit({
    repository: shared.repository,
    contentStore: shared.contentStore,
    transformer: new PassThroughTransformer(`${fingerprint}:transformer`),
    embeddingModel: new DeterministicEmbeddingModel(8, 64, 1_000_000, `${fingerprint}:embedding`),
    vectorIndex: new InMemoryVectorIndex(8, `${fingerprint}:vector`),
    keywordIndex: new InMemoryKeywordIndex(`${fingerprint}:keyword`),
    eventSink: shared.events,
    clock: shared.clock,
    idGenerator: shared.ids
  });
  assert.equal(created.ok, true);
  return created.value;
}

async function processAndValidate(shared, runtime, facts, suffix, validity = 60_000) {
  const runId = createLorebitId('run', suffix);
  const generationId = createLorebitId('generation', suffix);
  shared.clock.advanceMilliseconds(1);
  const processed = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'processing.run',
    spaceId: facts.spaceId,
    runId,
    sourceId: facts.sourceId,
    revisionId: facts.revisionId,
    recipeId: facts.recipeId,
    generationId,
    baseGenerationId: null
  }, {
    source: { sourceId: facts.sourceId, revisionId: facts.revisionId },
    recipeId: facts.recipeId
  }, `${suffix}-process`));
  assert.equal(processed.ok, true);
  shared.clock.advanceMilliseconds(1);
  const built = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'generation.build',
    spaceId: facts.spaceId,
    generationId,
    runId
  }, {
    run: { runId, sequence: processed.value.run.sequence, status: 'partial' }
  }, `${suffix}-build`));
  assert.equal(built.ok, true);
  shared.clock.advanceMilliseconds(1);
  const validated = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'generation.validate',
    spaceId: facts.spaceId,
    generationId,
    receiptValidForMilliseconds: validity
  }, {
    generation: { generationId, sequence: built.value.generation.sequence, status: 'validating' }
  }, `${suffix}-validate`));
  assert.equal(validated.ok, true);
  return { runId, generationId, validated };
}

async function activate(shared, runtime, facts, prepared, suffix) {
  return runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'generation.activate',
    spaceId: facts.spaceId,
    generationId: prepared.generationId,
    activationId: createLorebitId('activation', suffix),
    policyId: facts.policyId
  }, {
    generation: {
      generationId: prepared.generationId,
      sequence: prepared.validated.value.generation.sequence,
      status: 'ready'
    },
    activationId: null,
    policyId: facts.policyId
  }, `${suffix}-activate`));
}

test('E2E-24 stale deployment/receipt degrades readiness; fresh probes recover; cancel never activates', async () => {
  const shared = {
    repository: new InMemoryKnowledgeRepository(),
    contentStore: new InMemoryContentStore(),
    events: new RecordingEventSink(),
    clock: new FakeClock('2026-08-13T10:00:00.000Z'),
    ids: new DeterministicIdGenerator('receipt')
  };
  const runtimeA = await runtimeFor(shared, 'deployment-a');
  const facts = {
    spaceId: createLorebitId('space', 'receipt'),
    policyId: createLorebitId('policy', 'p1'),
    sourceId: createLorebitId('source', 'source'),
    recipeId: createLorebitId('recipe', 'r1'),
    revisionId: createLorebitId('revision', 'r1')
  };
  assert.equal((await runtimeA.execute(envelope(shared.ids, shared.clock, {
    type: 'space.create',
    spaceId: facts.spaceId,
    policyId: facts.policyId,
    name: 'Receipt',
    description: 'receipt drift',
    metadata: {},
    policy: policy(shared.clock)
  }, {}, 'space'))).ok, true);
  shared.clock.advanceMilliseconds(1);
  assert.equal((await runtimeA.execute(envelope(shared.ids, shared.clock, {
    type: 'source.register',
    spaceId: facts.spaceId,
    sourceId: facts.sourceId,
    kind: 'document',
    name: 'Source',
    locator: { kind: 'url', value: 'https://example.test/receipt', fragment: null },
    ownership: { ownerRef: 'test', license: null, usageTerms: null },
    parentSourceId: null,
    visibilityLabels: ['public'],
    metadata: {}
  }, {}, 'source'))).ok, true);
  shared.clock.advanceMilliseconds(1);
  assert.equal((await runtimeA.execute(envelope(shared.ids, shared.clock, {
    type: 'recipe.register',
    spaceId: facts.spaceId,
    recipeId: facts.recipeId,
    configuration: { profile: 'receipt' },
    compatibility: []
  }, { recipeId: null }, 'recipe'))).ok, true);
  const bytes = new TextEncoder().encode('receipt-bound content');
  const digest = await digestBytes(bytes);
  const content = {
    schemaVersion: '1.0',
    spaceId: facts.spaceId,
    contentId: createLorebitId('content', 'r1'),
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    digest
  };
  await shared.contentStore.putImmutable({ ref: content, bytes });
  shared.clock.advanceMilliseconds(1);
  assert.equal((await runtimeA.execute(envelope(shared.ids, shared.clock, {
    type: 'revision.submit',
    spaceId: facts.spaceId,
    sourceId: facts.sourceId,
    revisionId: facts.revisionId,
    snapshot: { content, rawDigest: digest, normalizedDigest: digest, capturedAt: shared.clock.now() },
    changeSet: { kind: 'content', summary: 'r1', changes: {} },
    metadata: {},
    derivedFromRevisionIds: [],
    effectiveFrom: shared.clock.now(),
    effectiveUntil: null
  }, { source: { sourceId: facts.sourceId, sequence: 1, revisionId: null } }, 'revision'))).ok, true);
  shared.clock.advanceMilliseconds(1);
  assert.equal((await runtimeA.execute(envelope(shared.ids, shared.clock, {
    type: 'revision.decision',
    spaceId: facts.spaceId,
    sourceId: facts.sourceId,
    revisionId: facts.revisionId,
    decisionId: createLorebitId('decision', 'approved'),
    status: 'approved'
  }, {}, 'decision'))).ok, true);

  const staleCandidate = await processAndValidate(shared, runtimeA, facts, 'stale', 5);
  const runtimeB = await runtimeFor(shared, 'deployment-b');
  const deploymentDrift = await activate(shared, runtimeB, facts, staleCandidate, 'drift');
  assert.equal(deploymentDrift.ok, false);
  assert.equal(deploymentDrift.error.code, 'receipt-stale');
  assert.equal(runtimeB.readiness().state, 'degraded');
  assert.equal(runtimeB.readiness().limitations[0].includes('degraded'), true);
  assert.equal(await shared.repository.getActiveActivation(facts.spaceId), null);

  shared.clock.advanceMilliseconds(6);
  const expired = await activate(shared, runtimeA, facts, staleCandidate, 'expired');
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'receipt-stale');
  assert.equal(runtimeA.profile().state, 'degraded');

  const freshCandidate = await processAndValidate(shared, runtimeB, facts, 'fresh');
  shared.clock.advanceMilliseconds(1);
  const recovered = await activate(shared, runtimeB, facts, freshCandidate, 'fresh');
  assert.equal(recovered.ok, true);
  assert.equal(runtimeB.readiness().state, 'ready');
  assert.equal(recovered.value.querySnapshot.generationId, freshCandidate.generationId);

  const revision2 = createLorebitId('revision', 'r2');
  const bytes2 = new TextEncoder().encode('cancelled candidate');
  const digest2 = await digestBytes(bytes2);
  const content2 = {
    ...content,
    contentId: createLorebitId('content', 'r2'),
    byteLength: bytes2.byteLength,
    digest: digest2
  };
  await shared.contentStore.putImmutable({ ref: content2, bytes: bytes2 });
  shared.clock.advanceMilliseconds(1);
  assert.equal((await runtimeB.execute(envelope(shared.ids, shared.clock, {
    type: 'revision.submit',
    spaceId: facts.spaceId,
    sourceId: facts.sourceId,
    revisionId: revision2,
    snapshot: { content: content2, rawDigest: digest2, normalizedDigest: digest2, capturedAt: shared.clock.now() },
    changeSet: { kind: 'content', summary: 'cancel', changes: {} },
    metadata: {},
    derivedFromRevisionIds: [],
    effectiveFrom: shared.clock.now(),
    effectiveUntil: null
  }, { source: { sourceId: facts.sourceId, sequence: 2, revisionId: facts.revisionId } }, 'cancel-revision'))).ok, true);
  const controller = new AbortController();
  controller.abort();
  const cancelledGeneration = createLorebitId('generation', 'cancelled');
  shared.clock.advanceMilliseconds(1);
  const cancelled = await runtimeB.execute(envelope(shared.ids, shared.clock, {
    type: 'processing.run',
    spaceId: facts.spaceId,
    runId: createLorebitId('run', 'cancelled'),
    sourceId: facts.sourceId,
    revisionId: revision2,
    recipeId: facts.recipeId,
    generationId: cancelledGeneration,
    baseGenerationId: freshCandidate.generationId
  }, {
    source: { sourceId: facts.sourceId, revisionId: revision2 },
    recipeId: facts.recipeId
  }, 'cancel-process'), { signal: controller.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(await shared.repository.getGeneration(facts.spaceId, cancelledGeneration), null);
  assert.equal((await runtimeB.getQuerySnapshot(facts.spaceId)).value.generationId, freshCandidate.generationId);
});
