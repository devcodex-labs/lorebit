import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebit,
  createLorebitId,
  digestBytes
} from '../../dist/index.js';
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
    questionScope: { allowed: ['lorebit'], denied: [] },
    admission: { allowedSourceKinds: ['document'], requiredMetadata: [] },
    evidence: {
      minimumCitations: 1,
      allowedEvidenceKinds: ['primary'],
      onInsufficientEvidence: 'empty'
    },
    defaultResult: { allowPartial: false, allowHistorical: true, emptyResult: 'empty' },
    access: { requiredLabels: ['public'], excludedLabels: ['secret'], failClosed: true },
    exposure: { hiddenFields: [], hiddenContentLabels: [] },
    retention: { auditDays: 365, contentDays: null, tombstoneOnExpiry: true },
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
    actorRef: { type: 'integration', id: 'ingest-index' },
    reason: key,
    occurredAt: clock.now(),
    expected,
    payload
  };
}

async function fixture() {
  const repository = new InMemoryKnowledgeRepository();
  const contentStore = new InMemoryContentStore();
  const transformer = new PassThroughTransformer();
  const embeddingModel = new DeterministicEmbeddingModel(8);
  const vectorIndex = new InMemoryVectorIndex(8);
  const keywordIndex = new InMemoryKeywordIndex();
  const eventSink = new RecordingEventSink();
  const clock = new FakeClock('2026-08-13T08:00:00.000Z');
  const ids = new DeterministicIdGenerator('ingest');
  const created = await createLorebit({
    repository,
    contentStore,
    transformer,
    embeddingModel,
    vectorIndex,
    keywordIndex,
    eventSink,
    clock,
    idGenerator: ids
  });
  assert.equal(created.ok, true);
  return {
    runtime: created.value,
    repository,
    contentStore,
    vectorIndex,
    keywordIndex,
    eventSink,
    clock,
    ids
  };
}

async function seedLifecycle(f) {
  const { runtime, contentStore, clock, ids } = f;
  const spaceId = createLorebitId('space', 'docs');
  const policyId = createLorebitId('policy', 'p1');
  const sourceId = createLorebitId('source', 'guide');
  const recipeId = createLorebitId('recipe', 'r1');
  const revisionId = createLorebitId('revision', 'r1');
  assert.equal((await runtime.execute(envelope(ids, clock, {
    type: 'space.create',
    spaceId,
    policyId,
    name: 'Docs',
    description: 'B2 fixture',
    metadata: {},
    policy: policy(clock)
  }, {}, 'space'))).ok, true);
  clock.advanceMilliseconds(1);
  assert.equal((await runtime.execute(envelope(ids, clock, {
    type: 'source.register',
    spaceId,
    sourceId,
    kind: 'document',
    name: 'Guide',
    locator: { kind: 'url', value: 'https://example.test/guide', fragment: null },
    ownership: { ownerRef: 'test', license: null, usageTerms: null },
    parentSourceId: null,
    visibilityLabels: ['public'],
    metadata: {}
  }, {}, 'source'))).ok, true);
  clock.advanceMilliseconds(1);
  assert.equal((await runtime.execute(envelope(ids, clock, {
    type: 'recipe.register',
    spaceId,
    recipeId,
    configuration: { transformer: 'pass-through', embedding: 'deterministic-8' },
    compatibility: []
  }, { recipeId: null }, 'recipe'))).ok, true);
  const bytes = new TextEncoder().encode('Lorebit keeps knowledge versions explicit.');
  const digest = await digestBytes(bytes);
  const content = {
    schemaVersion: '1.0',
    spaceId,
    contentId: createLorebitId('content', 'guide-r1'),
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    digest
  };
  assert.equal((await contentStore.putImmutable({ ref: content, bytes })).ok, true);
  clock.advanceMilliseconds(1);
  assert.equal((await runtime.execute(envelope(ids, clock, {
    type: 'revision.submit',
    spaceId,
    sourceId,
    revisionId,
    snapshot: {
      content,
      rawDigest: digest,
      normalizedDigest: digest,
      capturedAt: clock.now()
    },
    changeSet: { kind: 'content', summary: 'initial', changes: {} },
    metadata: { classification: 'public' },
    derivedFromRevisionIds: [],
    effectiveFrom: clock.now(),
    effectiveUntil: null
  }, { source: { sourceId, sequence: 1, revisionId: null } }, 'revision'))).ok, true);
  clock.advanceMilliseconds(1);
  assert.equal((await runtime.execute(envelope(ids, clock, {
    type: 'revision.decision',
    spaceId,
    sourceId,
    revisionId,
    decisionId: createLorebitId('decision', 'approved'),
    status: 'approved'
  }, {}, 'decision'))).ok, true);
  return { spaceId, policyId, sourceId, recipeId, revisionId };
}

test('ingest → delta → shadow build → receipt → atomic activation', async () => {
  const f = await fixture();
  const ids = await seedLifecycle(f);
  const runId = createLorebitId('run', 'r1');
  const generationId = createLorebitId('generation', 'g1');
  f.clock.advanceMilliseconds(1);
  const processCommand = envelope(f.ids, f.clock, {
    type: 'processing.run',
    spaceId: ids.spaceId,
    sourceId: ids.sourceId,
    revisionId: ids.revisionId,
    recipeId: ids.recipeId,
    runId,
    generationId,
    baseGenerationId: null
  }, {
    source: { sourceId: ids.sourceId, revisionId: ids.revisionId },
    recipeId: ids.recipeId
  }, 'process');
  const processed = await f.runtime.execute(processCommand);
  assert.equal(processed.ok, true);
  assert.equal(processed.value.run.status, 'partial');
  assert.equal(processed.value.deltaPlan.summary.added, 1);
  assert.equal(processed.value.units[0].visibilityDigest.algorithm, 'sha-256');
  assert.equal((await f.repository.getRevision(ids.spaceId, ids.revisionId)).state.status, 'processing');
  const replayed = await f.runtime.execute(structuredClone(processCommand));
  assert.equal(replayed.ok, true);
  assert.equal(replayed.diagnostics[0].code, 'idempotent-replay');

  f.clock.advanceMilliseconds(1);
  const built = await f.runtime.execute(envelope(f.ids, f.clock, {
    type: 'generation.build',
    spaceId: ids.spaceId,
    generationId,
    runId
  }, {
    run: { runId, sequence: processed.value.run.sequence, status: 'partial' }
  }, 'build'));
  assert.equal(built.ok, true);
  assert.equal(built.value.generation.status, 'validating');
  assert.equal((await f.runtime.getQuerySnapshot(ids.spaceId)).ok, false);
  assert.equal((await f.vectorIndex.count(ids.spaceId, generationId)).value, 1);
  assert.equal((await f.keywordIndex.count(ids.spaceId, generationId)).value, 1);

  f.clock.advanceMilliseconds(1);
  const validated = await f.runtime.execute(envelope(f.ids, f.clock, {
    type: 'generation.validate',
    spaceId: ids.spaceId,
    generationId,
    receiptValidForMilliseconds: 60_000
  }, {
    generation: { generationId, sequence: built.value.generation.sequence, status: 'validating' }
  }, 'validate'));
  assert.equal(validated.ok, true);
  assert.equal(validated.value.generation.status, 'ready');
  assert.equal(validated.value.receipt.status, 'passed');
  assert.equal(validated.value.receipt.namespaceIsolated, true);
  const validatedRun = await f.runtime.getRun(ids.spaceId, runId);
  assert.equal(validatedRun.value.status, 'succeeded');
  assert.deepEqual(
    validatedRun.value.stages.map((stage) => stage.stage),
    ['load-content', 'transform', 'plan-delta', 'embed', 'index', 'validate']
  );
  assert.equal((await f.repository.getActiveActivation(ids.spaceId)), null);

  f.clock.advanceMilliseconds(1);
  const activated = await f.runtime.execute(envelope(f.ids, f.clock, {
    type: 'generation.activate',
    spaceId: ids.spaceId,
    generationId,
    activationId: createLorebitId('activation', 'a1'),
    policyId: ids.policyId
  }, {
    generation: { generationId, sequence: validated.value.generation.sequence, status: 'ready' },
    activationId: null,
    policyId: ids.policyId
  }, 'activate'));
  assert.equal(activated.ok, true);
  assert.equal(activated.value.generation.status, 'active');
  assert.equal(activated.value.querySnapshot.generationId, generationId);
  assert.equal((await f.runtime.getRun(ids.spaceId, runId)).value.stages.at(-1).stage, 'activate');
  assert.deepEqual(activated.value.querySnapshot.revisions, [{
    sourceId: ids.sourceId,
    revisionId: ids.revisionId
  }]);
  assert.equal((await f.repository.getRevision(ids.spaceId, ids.revisionId)).state.status, 'active');
  assert.equal(f.runtime.profile().core, 'deterministic-m2-processing');
  assert.equal(f.runtime.readiness().operations.activation, true);
  assert.equal(f.eventSink.events.some((event) => event.eventType === 'generation.ready'), true);
});

test('createLorebit rejects partial and dimension-incompatible B2 adapter sets', async () => {
  const repository = new InMemoryKnowledgeRepository();
  const contentStore = new InMemoryContentStore();
  const partial = await createLorebit({
    repository,
    contentStore,
    transformer: new PassThroughTransformer()
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.error.code, 'configuration-invalid');
  const mismatch = await createLorebit({
    repository: new InMemoryKnowledgeRepository(),
    contentStore: new InMemoryContentStore(),
    transformer: new PassThroughTransformer(),
    embeddingModel: new DeterministicEmbeddingModel(8),
    vectorIndex: new InMemoryVectorIndex(4)
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'model-incompatible');
});
