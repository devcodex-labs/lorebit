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
  RecordingEventSink
} from '../../dist/testing/index.js';

class VersionedTransformer {
  descriptor;
  capabilities = Object.freeze({
    deterministic: true,
    maxExpansionRatio: 1_000,
    mediaTypes: ['text/plain']
  });

  constructor(deploymentFingerprint = 'scenario:sections:v1') {
    this.descriptor = Object.freeze({
      kind: 'content-transformer',
      adapterId: 'scenario:versioned-transformer',
      name: 'VersionedTransformer',
      version: '1.0',
      deploymentFingerprint,
      testingOnly: true
    });
  }

  async transform(request) {
    if (request.options?.signal?.aborted) {
      return { ok: false, code: 'cancelled', summary: 'cancelled', diagnostics: [] };
    }
    const version = new TextDecoder().decode(request.content);
    const source = request.revision.locator;
    const row = (stableKey, text, unitPath, labels = ['public']) => ({
      stableKey,
      text,
      locator: { source, unitPath, start: 0, end: text.length },
      metadata: { section: stableKey },
      visibility: { labels },
      disposition: 'available'
    });
    const units = version === 'v1'
      ? [
          row('unchanged', 'alpha stable', '/a'),
          row('moved', 'beta stable', '/b'),
          row('changed', 'gamma v1', '/c'),
          row('deleted', 'delta removed', '/d'),
          row('visibility', 'epsilon stable', '/e')
        ]
      : [
          row('unchanged', 'alpha stable', '/a'),
          row('moved', 'beta stable', '/b-moved'),
          row('changed', 'gamma v2', '/c'),
          row('visibility', 'epsilon stable', '/e', ['restricted']),
          row('added', 'zeta added', '/f')
        ];
    return { ok: true, units, diagnostics: [] };
  }

  async close() {}
}

class CountingEmbeddingModel {
  delegate;
  descriptor;
  capabilities;
  inputCount = 0;

  constructor(fingerprint) {
    this.delegate = new DeterministicEmbeddingModel(8, 64, 1_000_000, fingerprint);
    this.descriptor = this.delegate.descriptor;
    this.capabilities = this.delegate.capabilities;
  }

  async embed(texts, options) {
    this.inputCount += texts.length;
    return this.delegate.embed(texts, options);
  }

  async close() {
    await this.delegate.close();
  }
}

function policy(clock) {
  return {
    changeKind: 'index-affecting',
    questionScope: { allowed: ['docs'], denied: [] },
    admission: { allowedSourceKinds: ['document'], requiredMetadata: [] },
    evidence: { minimumCitations: 1, allowedEvidenceKinds: ['primary'], onInsufficientEvidence: 'empty' },
    defaultResult: { allowPartial: false, allowHistorical: true, emptyResult: 'empty' },
    access: { requiredLabels: [], excludedLabels: [], failClosed: true },
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
    actorRef: { type: 'scenario', id: 'e2e-09-10' },
    reason: key,
    occurredAt: clock.now(),
    expected,
    payload
  };
}

async function createRuntime(shared, fingerprint) {
  const embeddingModel = new CountingEmbeddingModel(`${fingerprint}:embedding`);
  const vectorIndex = new InMemoryVectorIndex(8, `${fingerprint}:vector`);
  const keywordIndex = new InMemoryKeywordIndex(`${fingerprint}:keyword`);
  const created = await createLorebit({
    repository: shared.repository,
    contentStore: shared.contentStore,
    transformer: new VersionedTransformer(),
    embeddingModel,
    vectorIndex,
    keywordIndex,
    eventSink: shared.eventSink,
    clock: shared.clock,
    idGenerator: shared.ids
  });
  assert.equal(created.ok, true);
  return { runtime: created.value, embeddingModel, vectorIndex, keywordIndex };
}

async function putRevision(shared, runtime, ids, revisionId, version, sourceSequence, key) {
  const bytes = new TextEncoder().encode(version);
  const digest = await digestBytes(bytes);
  const content = {
    schemaVersion: '1.0',
    spaceId: ids.spaceId,
    contentId: createLorebitId('content', `${key}-${version}`),
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    digest
  };
  assert.equal((await shared.contentStore.putImmutable({ ref: content, bytes })).ok, true);
  shared.clock.advanceMilliseconds(1);
  const submitted = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'revision.submit',
    spaceId: ids.spaceId,
    sourceId: ids.sourceId,
    revisionId,
    snapshot: { content, rawDigest: digest, normalizedDigest: digest, capturedAt: shared.clock.now() },
    changeSet: { kind: 'content', summary: version, changes: { version } },
    metadata: {},
    derivedFromRevisionIds: [],
    effectiveFrom: shared.clock.now(),
    effectiveUntil: null
  }, {
    source: {
      sourceId: ids.sourceId,
      sequence: sourceSequence,
      revisionId: sourceSequence === 1 ? null : ids.previousRevisionId
    }
  }, `${key}-revision`));
  assert.equal(submitted.ok, true);
  shared.clock.advanceMilliseconds(1);
  assert.equal((await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'revision.decision',
    spaceId: ids.spaceId,
    sourceId: ids.sourceId,
    revisionId,
    decisionId: createLorebitId('decision', `${key}-approved`),
    status: 'approved'
  }, {}, `${key}-decision`))).ok, true);
}

async function prepareGeneration(shared, runtime, ids, recipeId, revisionId, runId, generationId, baseGenerationId, key) {
  shared.clock.advanceMilliseconds(1);
  const processed = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'processing.run',
    spaceId: ids.spaceId,
    runId,
    sourceId: ids.sourceId,
    revisionId,
    recipeId,
    generationId,
    baseGenerationId
  }, {
    source: { sourceId: ids.sourceId, revisionId },
    recipeId
  }, `${key}-process`));
  assert.equal(processed.ok, true);
  shared.clock.advanceMilliseconds(1);
  const built = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'generation.build',
    spaceId: ids.spaceId,
    generationId,
    runId
  }, {
    run: { runId, sequence: processed.value.run.sequence, status: 'partial' }
  }, `${key}-build`));
  assert.equal(built.ok, true);
  shared.clock.advanceMilliseconds(1);
  const validated = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'generation.validate',
    spaceId: ids.spaceId,
    generationId,
    receiptValidForMilliseconds: 60_000
  }, {
    generation: { generationId, sequence: built.value.generation.sequence, status: 'validating' }
  }, `${key}-validate`));
  assert.equal(validated.ok, true);
  return { processed, built, validated };
}

async function activate(shared, runtime, ids, prepared, generationId, activationId, predecessor, key) {
  shared.clock.advanceMilliseconds(1);
  const result = await runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'generation.activate',
    spaceId: ids.spaceId,
    generationId,
    activationId,
    policyId: ids.policyId
  }, {
    generation: {
      generationId,
      sequence: prepared.validated.value.generation.sequence,
      status: 'ready'
    },
    activationId: predecessor,
    policyId: ids.policyId
  }, `${key}-activate`));
  assert.equal(result.ok, true);
  return result;
}

test('E2E-09 delta reuse/delete and E2E-10 model/index rebuild keep old active', async () => {
  const shared = {
    repository: new InMemoryKnowledgeRepository(),
    contentStore: new InMemoryContentStore(),
    eventSink: new RecordingEventSink(),
    clock: new FakeClock('2026-08-13T09:00:00.000Z'),
    ids: new DeterministicIdGenerator('delta')
  };
  const firstProfile = await createRuntime(shared, 'profile-a');
  const ids = {
    spaceId: createLorebitId('space', 'delta'),
    policyId: createLorebitId('policy', 'p1'),
    sourceId: createLorebitId('source', 'document')
  };
  assert.equal((await firstProfile.runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'space.create',
    spaceId: ids.spaceId,
    policyId: ids.policyId,
    name: 'Delta',
    description: 'E2E-09/10',
    metadata: {},
    policy: policy(shared.clock)
  }, {}, 'space'))).ok, true);
  shared.clock.advanceMilliseconds(1);
  assert.equal((await firstProfile.runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'source.register',
    spaceId: ids.spaceId,
    sourceId: ids.sourceId,
    kind: 'document',
    name: 'Document',
    locator: { kind: 'url', value: 'https://example.test/delta', fragment: null },
    ownership: { ownerRef: 'test', license: null, usageTerms: null },
    parentSourceId: null,
    visibilityLabels: ['public'],
    metadata: {}
  }, {}, 'source'))).ok, true);
  const recipe1 = createLorebitId('recipe', 'r1');
  shared.clock.advanceMilliseconds(1);
  assert.equal((await firstProfile.runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'recipe.register',
    spaceId: ids.spaceId,
    recipeId: recipe1,
    configuration: { transformer: 'sections-v1', embedding: 'profile-a' },
    compatibility: []
  }, { recipeId: null }, 'recipe-1'))).ok, true);

  const revision1 = createLorebitId('revision', 'r1');
  await putRevision(shared, firstProfile.runtime, { ...ids, previousRevisionId: null }, revision1, 'v1', 1, 'v1');
  const generation1 = createLorebitId('generation', 'g1');
  const prepared1 = await prepareGeneration(
    shared,
    firstProfile.runtime,
    ids,
    recipe1,
    revision1,
    createLorebitId('run', 'r1'),
    generation1,
    null,
    'g1'
  );
  const activation1 = await activate(
    shared,
    firstProfile.runtime,
    ids,
    prepared1,
    generation1,
    createLorebitId('activation', 'a1'),
    null,
    'g1'
  );
  assert.equal(firstProfile.embeddingModel.inputCount, 5);

  const revision2 = createLorebitId('revision', 'r2');
  await putRevision(
    shared,
    firstProfile.runtime,
    { ...ids, previousRevisionId: revision1 },
    revision2,
    'v2',
    2,
    'v2'
  );
  const generation2 = createLorebitId('generation', 'g2');
  const prepared2 = await prepareGeneration(
    shared,
    firstProfile.runtime,
    ids,
    recipe1,
    revision2,
    createLorebitId('run', 'r2'),
    generation2,
    generation1,
    'g2'
  );
  assert.deepEqual(prepared2.processed.value.deltaPlan.summary, {
    added: 1,
    changed: 1,
    unchanged: 1,
    moved: 1,
    deleted: 1,
    'visibility-changed': 1,
    quarantined: 0,
    unknown: 0
  });
  assert.equal(firstProfile.embeddingModel.inputCount, 7);
  assert.equal(prepared2.built.value.deleteReceipts.length, 1);
  assert.equal(prepared2.built.value.deleteReceipts[0].vectorDeleted, true);
  assert.equal((await firstProfile.runtime.getQuerySnapshot(ids.spaceId)).value.generationId, generation1);
  const activation2 = await activate(
    shared,
    firstProfile.runtime,
    ids,
    prepared2,
    generation2,
    createLorebitId('activation', 'a2'),
    activation1.value.activation.activationId,
    'g2'
  );
  assert.equal((await shared.repository.getGeneration(ids.spaceId, generation1)).status, 'retired');
  assert.equal((await firstProfile.vectorIndex.count(ids.spaceId, generation2)).value, 5);

  const recipe2 = createLorebitId('recipe', 'r2');
  shared.clock.advanceMilliseconds(1);
  assert.equal((await firstProfile.runtime.execute(envelope(shared.ids, shared.clock, {
    type: 'recipe.register',
    spaceId: ids.spaceId,
    recipeId: recipe2,
    configuration: { transformer: 'sections-v1', embedding: 'profile-b' },
    compatibility: []
  }, { recipeId: recipe1 }, 'recipe-2'))).ok, true);
  const secondProfile = await createRuntime(shared, 'profile-b');
  const generation3 = createLorebitId('generation', 'g3');
  const prepared3 = await prepareGeneration(
    shared,
    secondProfile.runtime,
    ids,
    recipe2,
    revision2,
    createLorebitId('run', 'r3'),
    generation3,
    generation2,
    'g3'
  );
  assert.equal(prepared3.processed.value.deltaPlan.summary.unchanged, 5);
  assert.equal(secondProfile.embeddingModel.inputCount, 5);
  assert.equal((await secondProfile.runtime.getQuerySnapshot(ids.spaceId)).value.generationId, generation2);
  await activate(
    shared,
    secondProfile.runtime,
    ids,
    prepared3,
    generation3,
    createLorebitId('activation', 'a3'),
    activation2.value.activation.activationId,
    'g3'
  );
  assert.equal((await shared.repository.getGeneration(ids.spaceId, generation2)).status, 'retired');
  assert.equal((await secondProfile.runtime.getQuerySnapshot(ids.spaceId)).value.generationId, generation3);
});
