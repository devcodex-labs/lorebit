import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebit,
  createLorebitId,
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  defineGenerationModule,
  defineImportExportModule,
  digestCanonicalJson
} from '../../dist/index.js';
import {
  DeterministicEmbeddingModel,
  InMemoryContentStore,
  InMemoryDerivedArtifactStore,
  InMemoryKnowledgeRepository,
  PassThroughTransformer,
  ScriptedLanguageModel,
  SeededRandom
} from '../../dist/testing/index.js';
import { createQueryFixture, envelope, queryRequest } from '../fixtures/query-runtime.mjs';

class BlockingEmbeddingModel {
  #delegate = new DeterministicEmbeddingModel(8);
  #armed = false;
  #waiters = [];
  #enteredResolve = null;
  entered = Promise.resolve();

  get descriptor() { return this.#delegate.descriptor; }
  get capabilities() { return this.#delegate.capabilities; }

  arm() {
    this.#armed = true;
    this.entered = new Promise((resolve) => { this.#enteredResolve = resolve; });
  }

  release() {
    this.#armed = false;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async embed(texts, options) {
    if (this.#armed) {
      this.#enteredResolve?.();
      this.#enteredResolve = null;
      await new Promise((resolve) => this.#waiters.push(resolve));
    }
    return this.#delegate.embed(texts, options);
  }

  close() { return this.#delegate.close(); }
}

class BlockingContentStore {
  #delegate = new InMemoryContentStore();
  #armed = false;
  #waiters = [];
  #enteredResolve = null;
  entered = Promise.resolve();

  get descriptor() { return this.#delegate.descriptor; }
  get capabilities() { return this.#delegate.capabilities; }

  armPut() {
    this.#armed = true;
    this.entered = new Promise((resolve) => { this.#enteredResolve = resolve; });
  }

  release() {
    this.#armed = false;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async putImmutable(request) {
    if (this.#armed) {
      this.#enteredResolve?.();
      this.#enteredResolve = null;
      await new Promise((resolve) => this.#waiters.push(resolve));
    }
    return this.#delegate.putImmutable(request);
  }

  get(ref) { return this.#delegate.get(ref); }
  has(ref) { return this.#delegate.has(ref); }
  tombstone(ref, reason, observedAt) { return this.#delegate.tombstone(ref, reason, observedAt); }
  close() { return this.#delegate.close(); }
}

class BlockingTransformer {
  #delegate = new PassThroughTransformer('testing:blocking-transformer');
  #armed = false;
  #waiters = [];
  #enteredResolve = null;
  entered = Promise.resolve();

  get descriptor() { return this.#delegate.descriptor; }
  get capabilities() { return this.#delegate.capabilities; }

  arm() {
    this.#armed = true;
    this.entered = new Promise((resolve) => { this.#enteredResolve = resolve; });
  }

  release() {
    this.#armed = false;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async transform(request) {
    if (this.#armed) {
      this.#enteredResolve?.();
      this.#enteredResolve = null;
      await new Promise((resolve) => this.#waiters.push(resolve));
    }
    return this.#delegate.transform(request);
  }

  close() { return this.#delegate.close(); }
}

test('E2E-18 / RES-04 / RES-05: query lane has bounded concurrency, queue backpressure, cancellation, deadline and byte limits', async (t) => {
  const embeddingModel = new BlockingEmbeddingModel();
  const fixture = await createQueryFixture({
    embeddingModel,
    resourceLimits: {
      queryConcurrency: 1,
      maxQueuedOperations: 1,
      maxInFlightBytes: 1_024
    }
  });
  t.after(() => fixture.runtime.close());
  const request = await queryRequest(fixture);

  embeddingModel.arm();
  const first = fixture.runtime.retrieve(request);
  await embeddingModel.entered;
  const queuedController = new AbortController();
  const queued = fixture.runtime.retrieve(request, { signal: queuedController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.runtime.resourceSnapshot(), {
    queued: 1,
    repositoryInFlight: 0,
    queryInFlight: 1,
    generateInFlight: 0,
    processingInFlight: 0,
    importInFlight: 0,
    rebuildInFlight: 0,
    inFlightBytes: new TextEncoder().encode(request.query).byteLength,
    closing: false
  });

  const saturated = await fixture.runtime.retrieve(request);
  assert.equal(saturated.ok, false);
  assert.equal(saturated.error.code, 'resource-saturated');
  queuedController.abort();
  const cancelled = await queued;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'cancelled');
  embeddingModel.release();
  assert.equal((await first).ok, true);

  const expired = await fixture.runtime.retrieve(request, { deadlineAt: fixture.clock.now() });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'deadline-exceeded');

  const smallBudgetFixture = await createQueryFixture({
    seed: 'small-budget',
    content: 'x',
    resourceLimits: { maxInFlightBytes: 8 }
  });
  t.after(() => smallBudgetFixture.runtime.close());
  const overBudget = await smallBudgetFixture.runtime.retrieve(await queryRequest(smallBudgetFixture));
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.error.code, 'resource-limit-exceeded');
});

test('RES-04: generate lane rejects unbounded queues and preserves deterministic completion order', async (t) => {
  let releaseModel;
  let enteredModel;
  const entered = new Promise((resolve) => { enteredModel = resolve; });
  const model = new ScriptedLanguageModel([
    async (request) => {
      enteredModel();
      await new Promise((resolve) => { releaseModel = resolve; });
      return {
        ok: true,
        text: `first:${request.context.evidence[0].citation.citationId}`,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 2, calls: 1, estimatedCost: null },
        providerRequestId: 'first'
      };
    },
    {
      ok: true,
      text: 'second',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 1, calls: 1, estimatedCost: null },
      providerRequestId: 'second'
    }
  ]);
  const fixture = await createQueryFixture({
    generation: defineGenerationModule(model),
    resourceLimits: { generateConcurrency: 1, maxQueuedOperations: 1 },
    random: new SeededRandom(11)
  });
  t.after(() => fixture.runtime.close());
  const request = await queryRequest(fixture, { mode: 'generate' });
  const first = fixture.runtime.generate(request);
  await entered;
  const second = fixture.runtime.generate(request);
  await new Promise((resolve) => setImmediate(resolve));
  const third = await fixture.runtime.generate(request);
  assert.equal(third.ok, false);
  assert.equal(third.error.code, 'resource-saturated');
  releaseModel();
  const completed = await Promise.all([first, second]);
  assert.equal(completed.every((result) => result.ok), true);
  assert.deepEqual(completed.map((result) => result.value.generation.providerRequestId), ['first', 'second']);
});

test('E2E-18 processing commands use the bounded processing lane and queued cancellation never reaches the transformer', async (t) => {
  const transformer = new BlockingTransformer();
  const fixture = await createQueryFixture({
    seed: 'processing-lane',
    transformer,
    resourceLimits: { processingConcurrency: 1, maxQueuedOperations: 1 }
  });
  t.after(() => {
    transformer.release();
    return fixture.runtime.close();
  });
  const processingEnvelope = (suffix) => envelope(fixture.ids, fixture.clock, {
    type: 'processing.run',
    spaceId: fixture.idsByKind.spaceId,
    sourceId: fixture.idsByKind.sourceId,
    revisionId: fixture.idsByKind.revisionId,
    recipeId: fixture.idsByKind.recipeId,
    runId: createLorebitId('run', `lane-${suffix}`),
    generationId: createLorebitId('generation', `lane-${suffix}`),
    baseGenerationId: fixture.idsByKind.generationId
  }, {
    source: { sourceId: fixture.idsByKind.sourceId, revisionId: fixture.idsByKind.revisionId },
    recipeId: fixture.idsByKind.recipeId
  }, `processing-lane-${suffix}`);

  transformer.arm();
  const active = fixture.runtime.execute(processingEnvelope('active'));
  await transformer.entered;
  const queuedController = new AbortController();
  const queued = fixture.runtime.execute(processingEnvelope('queued'), { signal: queuedController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.runtime.resourceSnapshot().processingInFlight, 1);
  assert.equal(fixture.runtime.resourceSnapshot().queued, 1);
  const saturated = await fixture.runtime.execute(processingEnvelope('saturated'));
  assert.equal(saturated.ok, false);
  assert.equal(saturated.error.code, 'resource-saturated');
  queuedController.abort();
  const cancelled = await queued;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'cancelled');
  transformer.release();
  assert.equal((await active).ok, true);
});

test('RES-10: close is idempotent, rejects queued work and cancels an in-flight adapter call within grace', async () => {
  const embeddingModel = new BlockingEmbeddingModel();
  const fixture = await createQueryFixture({
    seed: 'close-control',
    embeddingModel,
    resourceLimits: { queryConcurrency: 1, maxQueuedOperations: 1, cancellationGraceMilliseconds: 100 }
  });
  const request = await queryRequest(fixture);
  embeddingModel.arm();
  const active = fixture.runtime.retrieve(request);
  await embeddingModel.entered;
  const queued = fixture.runtime.retrieve(request);
  await new Promise((resolve) => setImmediate(resolve));

  const firstClose = fixture.runtime.close();
  const secondClose = fixture.runtime.close();
  assert.strictEqual(firstClose, secondClose);
  const queuedResult = await queued;
  assert.equal(queuedResult.ok, false);
  assert.equal(queuedResult.error.code, 'runtime-closing');
  const activeResult = await active;
  assert.equal(activeResult.ok, false);
  assert.equal(activeResult.error.code, 'cancelled');
  const receipt = await firstClose;
  assert.equal(receipt.state, 'closed');
  assert.equal(receipt.closedResources.includes('embeddingModel'), true);
  assert.equal(receipt.diagnostics.some((value) => value.includes('outlived cancellation grace')), true);
  assert.deepEqual(await secondClose, receipt);
  const afterClose = await fixture.runtime.retrieve(request);
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.error.code, 'runtime-closed');
  embeddingModel.release();
});

test('E2E-18 import lane is bounded and close leaves a cancelled partial import frozen, never active', async (t) => {
  const contentStore = new BlockingContentStore();
  const fixture = await createQueryFixture({
    seed: 'import-close-control',
    contentStore,
    importExport: defineImportExportModule(),
    resourceLimits: { importConcurrency: 1, maxQueuedOperations: 1, cancellationGraceMilliseconds: 100 }
  });
  t.after(() => {
    contentStore.release();
    return fixture.runtime.close();
  });
  const exportPlan = await fixture.runtime.planExport(fixture.idsByKind.spaceId);
  const exported = await fixture.runtime.executeExport(exportPlan.value);
  assert.equal(exported.ok, true);
  const firstTarget = createLorebitId('space', 'cancelled-import-one');
  const secondTarget = createLorebitId('space', 'cancelled-import-two');
  const firstPlan = await fixture.runtime.planImport(exported.value, firstTarget, { dryRun: false });
  const secondPlan = await fixture.runtime.planImport(exported.value, secondTarget, { dryRun: false });
  assert.equal(firstPlan.ok && secondPlan.ok, true);

  contentStore.armPut();
  const active = fixture.runtime.executeImport(firstPlan.value, exported.value);
  await contentStore.entered;
  const queued = fixture.runtime.executeImport(secondPlan.value, exported.value);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.runtime.resourceSnapshot().importInFlight, 1);
  assert.equal(fixture.runtime.resourceSnapshot().queued, 1);

  const close = fixture.runtime.close();
  const queuedResult = await queued;
  const activeResult = await active;
  assert.equal(queuedResult.ok, false);
  assert.equal(queuedResult.error.code, 'runtime-closing');
  assert.equal(activeResult.ok, false);
  assert.equal(activeResult.error.code, 'cancelled');
  const receipt = await close;
  assert.equal(receipt.diagnostics.some((value) => value.includes('outlived cancellation grace')), true);
  assert.equal((await fixture.repository.getSpace(firstTarget)).status, 'frozen');
  assert.equal(await fixture.repository.getSpace(secondTarget), null);
  contentStore.release();
});

test('E2E-18 rebuild lane rejects an expired recovery before mutating derived artifacts', async (t) => {
  const fixture = await createQueryFixture({ seed: 'rebuild-deadline', derivedArtifacts: new InMemoryDerivedArtifactStore() });
  t.after(() => fixture.runtime.close());
  const impact = await fixture.runtime.getImpact(
    fixture.idsByKind.spaceId,
    'integrity',
    fixture.idsByKind.generationId,
    ['vector-count']
  );
  assert.equal(impact.ok, true);
  const plan = await fixture.runtime.getRecoveryPlan(
    fixture.idsByKind.spaceId,
    'generation-invalid',
    impact.value
  );
  assert.equal(plan.ok, true);
  const expired = await fixture.runtime.executeRecovery(plan.value, { deadlineAt: fixture.clock.now() });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'deadline-exceeded');
  assert.equal(fixture.runtime.resourceSnapshot().rebuildInFlight, 0);
});

test('one hundred concurrent queries remain pinned to one active generation snapshot', async (t) => {
  const fixture = await createQueryFixture({ seed: 'concurrency-100' });
  t.after(() => fixture.runtime.close());
  const requests = await Promise.all(Array.from({ length: 100 }, (_, index) => queryRequest(fixture, {
    query: `How does lorebit preserve citation identity? ${index}`
  })));
  const results = await Promise.all(requests.map((request) => fixture.runtime.retrieve(request)));
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(
    [...new Set(results.map((result) => result.value.queryPlan.generationId))],
    [fixture.idsByKind.generationId]
  );
  assert.equal(results.every((result) => result.value.queryPlan.activationId === fixture.idsByKind.activationId), true);
});

test('RES-01 / RES-03: resource hard caps are validated at construction and derived artifacts remain scoped, expiring and lineage-invalidatable', async () => {
  const rejected = await createLorebit({
    repository: new InMemoryKnowledgeRepository(),
    contentStore: new InMemoryContentStore(),
    resourceLimits: { queryConcurrency: DEFAULT_RUNTIME_RESOURCE_LIMITS.queryConcurrency + 1 }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'configuration-invalid');

  const store = new InMemoryDerivedArtifactStore();
  const accessFingerprint = await digestCanonicalJson({ subject: 'resource-test' });
  const valueDigest = await digestCanonicalJson({ value: 'cached-context' });
  const key = {
    spaceId: createLorebitId('space', 'derived'),
    accessFingerprint: accessFingerprint.value,
    generationId: createLorebitId('generation', 'derived'),
    queryPlanId: createLorebitId('query-plan', 'derived'),
    kind: 'context',
    artifactId: 'context-1'
  };
  const artifact = {
    key,
    lineage: ['impact-lineage'],
    value: { value: 'cached-context' },
    valueDigest: valueDigest.value,
    utf8Bytes: 26,
    createdAt: '2026-08-13T10:00:00.000Z',
    expiresAt: '2026-08-13T10:01:00.000Z'
  };
  assert.equal((await store.put(artifact)).ok, true);
  assert.equal((await store.get(key, '2026-08-13T10:00:30.000Z')).ok, true);
  const invalidated = await store.invalidateLineage(key.spaceId, 'impact-lineage', '2026-08-13T10:00:40.000Z');
  assert.equal(invalidated.ok, true);
  assert.equal(invalidated.value[0].deleted, true);
  assert.equal((await store.get(key, '2026-08-13T10:00:41.000Z')).ok, false);

  assert.equal((await store.put(artifact)).ok, true);
  assert.equal((await store.get(key, '2026-08-13T10:01:00.000Z')).ok, false);
  await store.close();
});

test('RES-06 / RES-07 / RES-08: query, context and result buffers stop at deterministic limits with explanations', async (t) => {
  const oversizedModel = new ScriptedLanguageModel([{
    ok: true,
    text: 'x'.repeat(128),
    finishReason: 'length',
    usage: { inputTokens: 8, outputTokens: 128, calls: 1, estimatedCost: null },
    providerRequestId: 'oversized'
  }]);
  const fixture = await createQueryFixture({
    seed: 'result-bounds',
    generation: defineGenerationModule(oversizedModel),
    resourceLimits: { maxResultBytes: 32 }
  });
  t.after(() => fixture.runtime.close());

  const invalidTopK = await fixture.runtime.retrieve(await queryRequest(fixture, { topK: 101, candidateLimit: 101 }));
  assert.equal(invalidTopK.ok, false);
  assert.equal(invalidTopK.error.code, 'resource-limit-exceeded');

  const request = await queryRequest(fixture, { topK: 3, candidateLimit: 10 });
  const first = await fixture.runtime.retrieve(request);
  const second = await fixture.runtime.retrieve(request);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(
    first.value.retrieval.candidates.map((candidate) => candidate.unitVersionId),
    second.value.retrieval.candidates.map((candidate) => candidate.unitVersionId)
  );

  const context = await fixture.runtime.buildContext(await queryRequest(fixture, {
    mode: 'context',
    contextBudget: { maxEvidence: 1, maxUtf8Bytes: 256, maxTokens: 8 }
  }));
  assert.equal(context.ok, true);
  assert.equal(context.value.context.evidence.length, 1);
  assert.equal(context.value.context.excluded.some((entry) => entry.reason.startsWith('budget-')), true);

  const generated = await fixture.runtime.generate(await queryRequest(fixture, { mode: 'generate' }));
  assert.equal(generated.ok, true);
  assert.equal(generated.value.status, 'partial');
  assert.equal(generated.value.generation.text, null);
  assert.equal(generated.value.diagnostics.some((entry) => entry.code === 'resource-limit-exceeded'), true);
  assert.equal(generated.value.context.evidence.length > 0, true);
});
