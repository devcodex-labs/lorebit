import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebit,
  createLorebitId,
  digestCanonicalJson,
  digestBytes
} from '../../dist/index.js';
import {
  DeterministicIdGenerator,
  FakeClock,
  InMemoryContentStore,
  InMemoryKnowledgeRepository,
  RecordingEventSink
} from '../../dist/testing/index.js';

async function createFixture() {
  const repository = new InMemoryKnowledgeRepository();
  const contentStore = new InMemoryContentStore();
  const clock = new FakeClock('2026-08-13T06:00:00.000Z');
  const ids = new DeterministicIdGenerator('e2e');
  const eventSink = new RecordingEventSink();
  const created = await createLorebit({ repository, contentStore, clock, idGenerator: ids, eventSink });
  assert.equal(created.ok, true);
  return { runtime: created.value, repository, contentStore, clock, ids, eventSink };
}

async function digest(value) {
  const result = await digestCanonicalJson(value);
  assert.equal(result.ok, true);
  return result.value;
}

async function policy(clock, marker, changeKind = 'query-only') {
  return {
    changeKind,
    questionScope: { allowed: ['lorebit'], denied: ['unrelated'] },
    admission: { allowedSourceKinds: ['document'], requiredMetadata: ['classification'] },
    evidence: {
      minimumCitations: 1,
      allowedEvidenceKinds: ['primary'],
      onInsufficientEvidence: 'empty'
    },
    defaultResult: { allowPartial: false, allowHistorical: true, emptyResult: 'empty' },
    access: { requiredLabels: ['public'], excludedLabels: ['secret'], failClosed: true },
    exposure: { hiddenFields: ['secret'], hiddenContentLabels: ['restricted'] },
    retention: { auditDays: 365, contentDays: null, tombstoneOnExpiry: true },
    extensions: { marker },
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
    actorRef: { type: 'scenario', id: 'e2e-01-08' },
    reason: key,
    occurredAt: clock.now(),
    expected,
    payload
  };
}

async function putContent(contentStore, spaceId, suffix, text) {
  const bytes = new TextEncoder().encode(text);
  const contentDigest = await digestBytes(bytes);
  const ref = {
    schemaVersion: '1.0',
    spaceId,
    contentId: createLorebitId('content', suffix),
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    digest: contentDigest
  };
  const stored = await contentStore.putImmutable({ ref, bytes });
  assert.equal(stored.ok, true);
  return {
    content: ref,
    rawDigest: contentDigest,
    normalizedDigest: contentDigest,
    capturedAt: '2026-08-13T06:00:00.000Z'
  };
}

async function revisionPayload({ spaceId, sourceId, revisionId, snapshot, marker }) {
  return {
    type: 'revision.submit',
    spaceId,
    sourceId,
    revisionId,
    snapshot,
    changeSet: {
      kind: 'content',
      summary: marker,
      changes: { marker }
    },
    metadata: { classification: 'public', marker },
    derivedFromRevisionIds: [],
    effectiveFrom: '2026-08-13T06:00:00.000Z',
    effectiveUntil: null
  };
}

async function nextAggregateSequence(repository, spaceId, aggregateId) {
  const events = await repository.listEvents(spaceId, { limit: 1_000 }, aggregateId);
  return (events.items.at(-1)?.aggregateSequence ?? 0) + 1;
}

async function event(ids, repository, spaceId, operationId, at, aggregate, eventType, payload) {
  return {
    schemaVersion: '1.0',
    eventId: ids.next('event'),
    eventType,
    aggregate: { ...aggregate, spaceId },
    aggregateSequence: await nextAggregateSequence(repository, spaceId, aggregate.id),
    operationId,
    causationId: operationId,
    correlationId: operationId,
    occurredAt: at,
    payloadDigest: await digest(payload),
    payload
  };
}

// B1 owns the repository-side activation transaction; B2 will replace this fixture
// boundary with validated generation commands and real index adapter orchestration.
async function seedValidatedActivation({
  repository,
  ids,
  clock,
  spaceId,
  sourceId,
  revisionId,
  policyId,
  recipeId,
  generationId,
  predecessorActivationId
}) {
  const source = await repository.getSource(spaceId, sourceId);
  const view = await repository.getRevision(spaceId, revisionId);
  assert.notEqual(source, null);
  assert.notEqual(view, null);
  const revisions = [{ sourceId, revisionId }];
  const manifest = await digest(revisions);
  const artifactManifest = await digest({ vector: [], keyword: null });
  const adapterManifest = await digest({ fixture: 'validated-generation-boundary' });
  const runId = ids.next('run');
  const deltaPlanId = ids.next('delta-plan');
  let generation = {
    schemaVersion: '1.0',
    generationId,
    spaceId,
    parentGenerationId: predecessorActivationId === null
      ? null
      : (await repository.getActiveActivation(spaceId)).generation.generationId,
    runId,
    recipeId,
    revisionIds: [revisionId],
    unitVersionIds: [],
    deltaPlanId,
    embedding: {
      adapterId: 'fixture:embedding',
      model: 'fixture',
      version: '0.1',
      dimension: 1
    },
    vectorIndex: { adapterId: 'fixture:vector', version: '0.1' },
    keywordIndex: null,
    inputManifestDigest: manifest,
    artifactManifestDigest: null,
    status: 'planned',
    sequence: 1,
    diagnostics: [],
    createdAt: clock.now(),
    updatedAt: clock.now()
  };
  for (const [status, eventType] of [
    ['planned', 'generation.planned'],
    ['building', 'generation.building'],
    ['validating', 'generation.shadow-built'],
    ['ready', 'generation.ready']
  ]) {
    const previous = status === 'planned' ? null : generation;
    if (previous !== null) {
      generation = {
        ...generation,
        status,
        sequence: generation.sequence + 1,
        artifactManifestDigest: status === 'validating' || status === 'ready'
          ? artifactManifest
          : generation.artifactManifestDigest,
        updatedAt: clock.now()
      };
    }
    const stageOperationId = ids.next('operation');
    const stageEvent = await event(
      ids,
      repository,
      spaceId,
      stageOperationId,
      clock.now(),
      { kind: 'generation', id: generationId },
      eventType,
      { generationId, status }
    );
    const receipt = status === 'ready' ? {
      schemaVersion: '1.0',
      receiptId: ids.next('receipt'),
      generationId,
      spaceId,
      runtimeContractVersion: '0.1',
      inputManifestDigest: manifest,
      artifactManifestDigest: artifactManifest,
      adapterManifestDigest: adapterManifest,
      expectedUnitCount: 0,
      vectorUnitCount: 0,
      keywordUnitCount: null,
      deleteReceipts: [],
      probes: ['fixture-boundary'],
      locatorSampleCount: 0,
      namespaceIsolated: true,
      deletePropagationComplete: true,
      validatorVersion: 'fixture:0.1',
      status: 'passed',
      validatedAt: clock.now(),
      validUntil: '2099-01-01T00:00:00.000Z'
    } : undefined;
    const stageCommit = await repository.commit({
      spaceId,
      expected: previous === null ? {} : {
        generation: {
          generationId,
          sequence: previous.sequence,
          status: previous.status
        }
      },
      operation: {
        spaceId,
        operationId: stageOperationId,
        idempotencyKey: `fixture-generation:${generationId}:${status}`,
        commandDigest: await digest({ generationId, status }),
        outcome: { kind: 'fixture-generation-stage', generationId, status },
        committedAt: clock.now()
      },
      writes: {
        generations: [generation],
        ...(receipt === undefined ? {} : { generationReceipt: receipt }),
        events: [stageEvent]
      }
    });
    assert.equal(stageCommit.ok, true);
  }
  const operationId = ids.next('operation');
  const activationId = ids.next('activation');
  const at = clock.now();
  const activation = {
    schemaVersion: '1.0',
    activationId,
    spaceId,
    predecessorActivationId,
    policyId,
    generation: { generationId, inputManifestDigest: manifest, recipeId },
    revisions,
    revisionManifestDigest: manifest,
    createdAt: at,
    actorRef: 'scenario:e2e-01-08',
    reason: 'validated generation fixture boundary'
  };
  const activatedGeneration = {
    ...generation,
    status: 'active',
    sequence: generation.sequence + 1,
    updatedAt: at
  };
  const generationWrites = [activatedGeneration];
  const generationEvents = [await event(
    ids,
    repository,
    spaceId,
    operationId,
    at,
    { kind: 'generation', id: generationId },
    'generation.activated',
    { generationId, activationId }
  )];
  if (predecessorActivationId !== null) {
    const previousActivation = await repository.getActivation(spaceId, predecessorActivationId);
    const previousGeneration = await repository.getGeneration(
      spaceId,
      previousActivation.generation.generationId
    );
    generationWrites.push({
      ...previousGeneration,
      status: 'retired',
      sequence: previousGeneration.sequence + 1,
      updatedAt: at
    });
    generationEvents.push(await event(
      ids,
      repository,
      spaceId,
      operationId,
      at,
      { kind: 'generation', id: previousGeneration.generationId },
      'generation.retired',
      { generationId: previousGeneration.generationId, replacementGenerationId: generationId }
    ));
  }
  const revisionState = {
    ...view.state,
    status: 'active',
    sequence: view.state.sequence + 1,
    changedAt: at,
    actorRef: 'scenario:e2e-01-08',
    reason: 'validated generation fixture boundary'
  };
  const revisionEvent = await event(
    ids,
    repository,
    spaceId,
    operationId,
    at,
    { kind: 'revision', id: revisionId },
    'revision.activated-by-validated-generation',
    { revisionId, activationId, generationId }
  );
  const activationEvent = await event(
    ids,
    repository,
    spaceId,
    operationId,
    at,
    { kind: 'activation', id: activationId },
    'knowledge-activation.created',
    { activationId, policyId, generationId, revisionManifestDigest: manifest }
  );
  const committed = await repository.commit({
    spaceId,
    expected: {
      source: { sourceId, sequence: source.sequence, revisionId },
      activationId: predecessorActivationId
    },
    operation: {
      spaceId,
      operationId,
      idempotencyKey: `activation:${activationId}`,
      commandDigest: await digest({ activation }),
      outcome: { kind: 'fixture-activation', activationId },
      committedAt: at
    },
    writes: {
      revisionState,
      generations: generationWrites,
      activation,
      events: [revisionEvent, activationEvent, ...generationEvents]
    }
  });
  assert.equal(committed.ok, true);
  return activation;
}

test('E2E-01–08 deterministic M1 lifecycle profile', async (t) => {
  const fixture = await createFixture();
  const { runtime, repository, contentStore, clock, ids, eventSink } = fixture;
  const spaceId = createLorebitId('space', 'docs');
  const sourceId = createLorebitId('source', 'handbook');
  const policy1 = createLorebitId('policy', 'p1');
  const recipe1 = createLorebitId('recipe', 'r1');
  const revision1 = createLorebitId('revision', 'r1');
  let activation1;
  let policyActivation;
  let winnerRevision;
  let winnerSourceSequence;
  let activation2;

  await t.test('E2E-01 creates scoped facts and an atomic activation snapshot', async () => {
    const createdSpace = await runtime.execute(envelope(ids, clock, {
      type: 'space.create',
      spaceId,
      policyId: policy1,
      name: 'Lorebit docs',
      description: 'knowledge lifecycle fixture',
      metadata: { owner: 'devcodex' },
      policy: await policy(clock, 'p1')
    }, {}, 'e2e01-space'));
    assert.equal(createdSpace.ok, true);

    clock.advanceMilliseconds(1);
    const importBatchId = createLorebitId('import', 'batch-1');
    const imported = await runtime.execute(envelope(ids, clock, {
      type: 'import.record',
      spaceId,
      importBatchId,
      sourceIds: [sourceId],
      manifest: { sourceIds: [sourceId], mode: 'snapshot' },
      status: 'complete',
      acceptedCount: 1,
      failedCount: 0,
      errors: []
    }, {}, 'e2e01-import'));
    assert.equal(imported.ok, true);

    clock.advanceMilliseconds(1);
    const registered = await runtime.execute(envelope(ids, clock, {
      type: 'source.register',
      spaceId,
      sourceId,
      kind: 'document',
      name: 'Handbook',
      locator: { kind: 'url', value: 'https://example.test/handbook', fragment: null },
      ownership: { ownerRef: 'devcodex', license: 'Apache-2.0', usageTerms: null },
      parentSourceId: null,
      importBatchId,
      syncCursor: {
        kind: 'snapshot',
        value: 'cursor-1',
        observedAt: clock.now()
      },
      visibilityLabels: ['public'],
      metadata: { classification: 'public' }
    }, {}, 'e2e01-source'));
    assert.equal(registered.ok, true);

    clock.advanceMilliseconds(1);
    const recipe = await runtime.execute(envelope(ids, clock, {
      type: 'recipe.register',
      spaceId,
      recipeId: recipe1,
      configuration: { chunk: 512 },
      compatibility: ['text/plain']
    }, { recipeId: null }, 'e2e01-recipe'));
    assert.equal(recipe.ok, true);

    const snapshot = await putContent(contentStore, spaceId, 'handbook-r1', 'Lorebit lifecycle v1');
    clock.advanceMilliseconds(1);
    const submitted = await runtime.execute(envelope(
      ids,
      clock,
      await revisionPayload({ spaceId, sourceId, revisionId: revision1, snapshot, marker: 'v1' }),
      { source: { sourceId, sequence: 1, revisionId: null } },
      'e2e01-revision'
    ));
    assert.equal(submitted.ok, true);

    const pendingDecision = await runtime.execute(envelope(ids, clock, {
      type: 'revision.decision',
      spaceId,
      sourceId,
      revisionId: revision1,
      decisionId: createLorebitId('decision', 'r1-pending'),
      status: 'pending'
    }, {}, 'e2e01-decision-pending'));
    assert.equal(pendingDecision.ok, true);
    clock.advanceMilliseconds(1);
    const approvedDecision = await runtime.execute(envelope(ids, clock, {
      type: 'revision.decision',
      spaceId,
      sourceId,
      revisionId: revision1,
      decisionId: createLorebitId('decision', 'r1-approved'),
      status: 'approved'
    }, {}, 'e2e01-decision-approved'));
    assert.equal(approvedDecision.ok, true);
    const decisions = await runtime.listRevisionDecisions(
      spaceId,
      revision1,
      { limit: 10 }
    );
    assert.equal(decisions.ok, true);
    assert.deepEqual(decisions.value.items.map((item) => item.status), ['pending', 'approved']);

    clock.advanceMilliseconds(1);
    const processing = await runtime.execute(envelope(ids, clock, {
      type: 'revision.transition',
      spaceId,
      sourceId,
      revisionId: revision1,
      status: 'processing'
    }, { source: { sourceId, sequence: 2, revisionId: revision1 } }, 'e2e01-processing'));
    assert.equal(processing.ok, true);

    clock.advanceMilliseconds(1);
    activation1 = await seedValidatedActivation({
      repository,
      ids,
      clock,
      spaceId,
      sourceId,
      revisionId: revision1,
      policyId: policy1,
      recipeId: recipe1,
      generationId: createLorebitId('generation', 'g1'),
      predecessorActivationId: null
    });
    const active = await runtime.resolveRevision({ spaceId, sourceId, selector: { kind: 'active' } });
    assert.equal(active.ok, true);
    assert.equal(active.value.kind, 'resolved');
    assert.equal(active.value.value.revision.revisionId, revision1);
  });

  await t.test('E2E-02 appends immutable revisions and deterministically deduplicates', async () => {
    const original = structuredClone(await repository.getRevision(spaceId, revision1));
    const snapshot2 = await putContent(contentStore, spaceId, 'handbook-r2', 'Lorebit lifecycle v2');
    const revision2 = createLorebitId('revision', 'r2');
    clock.advanceMilliseconds(1);
    const submitted = await runtime.execute(envelope(
      ids,
      clock,
      await revisionPayload({ spaceId, sourceId, revisionId: revision2, snapshot: snapshot2, marker: 'v2' }),
      { source: { sourceId, sequence: 2, revisionId: revision1 } },
      'e2e02-revision'
    ));
    assert.equal(submitted.ok, true);
    assert.equal(submitted.value.revision.revision.predecessorRevisionId, revision1);

    const duplicatePayload = await revisionPayload({
      spaceId,
      sourceId,
      revisionId: createLorebitId('revision', 'duplicate'),
      snapshot: snapshot2,
      marker: 'v2'
    });
    clock.advanceMilliseconds(1);
    const duplicate = await runtime.execute(envelope(
      ids,
      clock,
      duplicatePayload,
      { source: { sourceId, sequence: 3, revisionId: revision2 } },
      'e2e02-duplicate'
    ));
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.value.kind, 'revision-deduplicated');
    assert.equal(duplicate.value.revision.revision.revisionId, revision2);
    assert.deepEqual(await repository.getRevision(spaceId, revision1), original);

    const locatorRevisionId = createLorebitId('revision', 'locator');
    const locatorPayload = await revisionPayload({
      spaceId,
      sourceId,
      revisionId: locatorRevisionId,
      snapshot: snapshot2,
      marker: 'v2'
    });
    locatorPayload.locator = {
      kind: 'url',
      value: 'https://example.test/handbook-v2',
      fragment: null
    };
    locatorPayload.changeSet = {
      kind: 'locator',
      summary: 'source moved without changing content',
      changes: { from: '/handbook', to: '/handbook-v2' }
    };
    clock.advanceMilliseconds(1);
    const locatorChange = await runtime.execute(envelope(
      ids,
      clock,
      locatorPayload,
      { source: { sourceId, sequence: 3, revisionId: revision2 } },
      'e2e02-locator'
    ));
    assert.equal(locatorChange.ok, true);
    assert.equal(locatorChange.value.kind, 'revision-submitted');
    assert.equal(locatorChange.value.revision.revision.locator.value.endsWith('handbook-v2'), true);
    assert.equal((await repository.getSource(spaceId, sourceId)).locator.value.endsWith('handbook-v2'), true);
    const difference = await runtime.compareRevisions(spaceId, revision1, revision2);
    assert.equal(difference.ok, true);
    assert.equal(difference.value.changedFields.includes('snapshot'), true);
  });

  await t.test('E2E-03 lets exactly one expected-predecessor update win', async () => {
    const source = await repository.getSource(spaceId, sourceId);
    const snapshotA = await putContent(contentStore, spaceId, 'race-a', 'race A');
    const snapshotB = await putContent(contentStore, spaceId, 'race-b', 'race B');
    const revisionA = createLorebitId('revision', 'race-a');
    const revisionB = createLorebitId('revision', 'race-b');
    clock.advanceMilliseconds(1);
    const expected = {
      source: { sourceId, sequence: source.sequence, revisionId: source.currentRevisionId }
    };
    const [left, right] = await Promise.all([
      runtime.execute(envelope(
        ids,
        clock,
        await revisionPayload({ spaceId, sourceId, revisionId: revisionA, snapshot: snapshotA, marker: 'race-a' }),
        expected,
        'e2e03-a'
      )),
      runtime.execute(envelope(
        ids,
        clock,
        await revisionPayload({ spaceId, sourceId, revisionId: revisionB, snapshot: snapshotB, marker: 'race-b' }),
        expected,
        'e2e03-b'
      ))
    ]);
    const results = [left, right];
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.error.code === 'state-conflict').length, 1);
    winnerRevision = results.find((result) => result.ok).value.revision.revision.revisionId;
    const current = await repository.getSource(spaceId, sourceId);
    winnerSourceSequence = current.sequence;
    assert.equal(current.currentRevisionId, winnerRevision);
  });

  await t.test('E2E-04 keeps policy, recipe and revision clocks independent', async () => {
    const before = await repository.listRevisions(spaceId, sourceId, { limit: 100 });
    const policy2 = createLorebitId('policy', 'p2');
    clock.advanceMilliseconds(1);
    const queryOnly = await runtime.execute(envelope(ids, clock, {
      type: 'policy.update',
      spaceId,
      policyId: policy2,
      policy: await policy(clock, 'p2-query-only', 'query-only')
    }, {
      space: { spaceId, sequence: 1, status: 'open' },
      policyId: policy1,
      activationId: activation1.activationId
    }, 'e2e04-policy-query'));
    assert.equal(queryOnly.ok, true);
    assert.equal(queryOnly.value.activation.generation.generationId, activation1.generation.generationId);
    policyActivation = queryOnly.value.activation;

    const policy3 = createLorebitId('policy', 'p3');
    clock.advanceMilliseconds(1);
    const indexPolicy = await runtime.execute(envelope(ids, clock, {
      type: 'policy.update',
      spaceId,
      policyId: policy3,
      policy: await policy(clock, 'p3-index', 'index-affecting')
    }, {
      space: { spaceId, sequence: 2, status: 'open' },
      policyId: policy2,
      activationId: policyActivation.activationId
    }, 'e2e04-policy-index'));
    assert.equal(indexPolicy.ok, true);
    assert.equal('activation' in indexPolicy.value, false);

    clock.advanceMilliseconds(1);
    const recipe2 = await runtime.execute(envelope(ids, clock, {
      type: 'recipe.register',
      spaceId,
      recipeId: createLorebitId('recipe', 'r2'),
      configuration: { chunk: 256 },
      compatibility: ['text/plain']
    }, { recipeId: recipe1 }, 'e2e04-recipe'));
    assert.equal(recipe2.ok, true);
    const recipeDifference = await runtime.compareRecipes(
      spaceId,
      recipe1,
      createLorebitId('recipe', 'r2')
    );
    assert.equal(recipeDifference.ok, true);
    assert.equal(recipeDifference.value.changedFields.includes('configuration'), true);
    const after = await repository.listRevisions(spaceId, sourceId, { limit: 100 });
    assert.equal(after.items.length, before.items.length);
    assert.equal((await repository.getActiveActivation(spaceId)).policyId, policy2);
    assert.equal((await repository.getSpace(spaceId)).currentPolicyId, policy3);
    const policyDifference = await runtime.comparePolicies(spaceId, policy1, policy2);
    assert.equal(policyDifference.ok, true);
    assert.equal(policyDifference.value.changedFields.includes('extensions'), true);
  });

  await t.test('E2E-05 keeps default queries on the complete active snapshot', async () => {
    const active = await runtime.resolveRevision({ spaceId, sourceId, selector: { kind: 'active' } });
    assert.equal(active.ok, true);
    assert.equal(active.value.kind, 'resolved');
    assert.equal(active.value.value.revision.revisionId, revision1);
    assert.notEqual(winnerRevision, revision1);
    const initialReadiness = await runtime.spaceReadiness(spaceId);
    assert.equal(initialReadiness.value.state, 'ready');

    clock.advanceMilliseconds(1);
    const unavailable = await runtime.execute(envelope(ids, clock, {
      type: 'source.signal',
      spaceId,
      sourceId,
      status: 'unavailable',
      syncCursor: {
        kind: 'incremental',
        value: 'cursor-unavailable',
        observedAt: clock.now()
      }
    }, {
      source: { sourceId, sequence: winnerSourceSequence, revisionId: winnerRevision }
    }, 'e2e05-unavailable'));
    assert.equal(unavailable.ok, true);
    assert.equal((await runtime.spaceReadiness(spaceId)).value.state, 'limited');

    clock.advanceMilliseconds(1);
    const available = await runtime.execute(envelope(ids, clock, {
      type: 'source.signal',
      spaceId,
      sourceId,
      status: 'available',
      syncCursor: {
        kind: 'incremental',
        value: 'cursor-recovered',
        observedAt: clock.now()
      }
    }, {
      source: { sourceId, sequence: winnerSourceSequence + 1, revisionId: winnerRevision }
    }, 'e2e05-available'));
    assert.equal(available.ok, true);
    winnerSourceSequence += 2;
    assert.equal((await runtime.spaceReadiness(spaceId)).value.state, 'ready');
  });

  await t.test('E2E-06 atomically replaces policy, generation and revision manifest', async () => {
    clock.advanceMilliseconds(1);
    const processing = await runtime.execute(envelope(ids, clock, {
      type: 'revision.transition',
      spaceId,
      sourceId,
      revisionId: winnerRevision,
      status: 'processing'
    }, {
      source: { sourceId, sequence: winnerSourceSequence, revisionId: winnerRevision }
    }, 'e2e06-processing'));
    assert.equal(processing.ok, true);

    clock.advanceMilliseconds(1);
    activation2 = await seedValidatedActivation({
      repository,
      ids,
      clock,
      spaceId,
      sourceId,
      revisionId: winnerRevision,
      policyId: createLorebitId('policy', 'p3'),
      recipeId: createLorebitId('recipe', 'r2'),
      generationId: createLorebitId('generation', 'g2'),
      predecessorActivationId: policyActivation.activationId
    });
    const active = await repository.getActiveActivation(spaceId);
    assert.deepEqual(active, activation2);
    assert.equal(active.policyId, 'policy_p3');
    assert.equal(active.generation.generationId, 'generation_g2');
    assert.deepEqual(active.revisions, [{ sourceId, revisionId: winnerRevision }]);
  });

  await t.test('E2E-07 resolves active, pin, label and as-of without mixing generations', async () => {
    clock.advanceMilliseconds(1);
    const labeled = await runtime.execute(envelope(ids, clock, {
      type: 'revision.label',
      spaceId,
      sourceId,
      revisionId: revision1,
      label: 'legacy'
    }, {}, 'e2e07-label'));
    assert.equal(labeled.ok, true);

    const active = await runtime.resolveRevision({ spaceId, sourceId, selector: { kind: 'active' } });
    const pinned = await runtime.resolveRevision({
      spaceId,
      sourceId,
      selector: { kind: 'revision', revisionId: revision1 }
    });
    const byLabel = await runtime.resolveRevision({
      spaceId,
      sourceId,
      selector: { kind: 'label', label: 'legacy' }
    });
    const asOf = await runtime.resolveRevision({
      spaceId,
      sourceId,
      selector: { kind: 'as-of', at: policyActivation.createdAt }
    });
    assert.equal(active.value.value.revision.revisionId, winnerRevision);
    assert.equal(pinned.value.value.revision.revisionId, revision1);
    assert.equal(byLabel.value.value.revision.revisionId, revision1);
    assert.equal(asOf.value.value.revision.revisionId, revision1);
  });

  await t.test('E2E-08 withdraws default evidence and restores/rolls back by appending', async () => {
    clock.advanceMilliseconds(1);
    const withdrawn = await runtime.execute(envelope(ids, clock, {
      type: 'revision.withdraw',
      spaceId,
      sourceId,
      revisionId: winnerRevision
    }, {
      source: { sourceId, sequence: winnerSourceSequence, revisionId: winnerRevision },
      activationId: activation2.activationId
    }, 'e2e08-withdraw'));
    assert.equal(withdrawn.ok, true);
    assert.equal(withdrawn.value.activation.revisions.length, 0);
    const noDefault = await runtime.resolveRevision({ spaceId, sourceId, selector: { kind: 'active' } });
    assert.equal(noDefault.value.kind, 'limitation');
    assert.equal(noDefault.value.code, 'no-active-revision');
    assert.equal((await runtime.spaceReadiness(spaceId)).value.state, 'not-ready');
    const historical = await runtime.resolveRevision({
      spaceId,
      sourceId,
      selector: { kind: 'as-of', at: activation2.createdAt }
    });
    assert.equal(historical.value.kind, 'resolved');
    assert.equal(historical.value.value.revision.revisionId, winnerRevision);
    assert.equal(historical.value.value.state.status, 'active');

    const restoredId = createLorebitId('revision', 'restored');
    clock.advanceMilliseconds(1);
    const restored = await runtime.execute(envelope(ids, clock, {
      type: 'revision.restore',
      spaceId,
      sourceId,
      fromRevisionId: winnerRevision,
      newRevisionId: restoredId
    }, {
      source: { sourceId, sequence: winnerSourceSequence, revisionId: winnerRevision }
    }, 'e2e08-restore'));
    assert.equal(restored.ok, true);
    assert.equal(restored.value.revision.revision.revisionId, restoredId);
    assert.equal(restored.value.revision.revision.derivedFromRevisionIds[0], winnerRevision);

    const rolledBackId = createLorebitId('revision', 'rollback');
    clock.advanceMilliseconds(1);
    const rolledBack = await runtime.execute(envelope(ids, clock, {
      type: 'revision.rollback',
      spaceId,
      sourceId,
      targetRevisionId: revision1,
      newRevisionId: rolledBackId
    }, {
      source: { sourceId, sequence: winnerSourceSequence + 1, revisionId: restoredId }
    }, 'e2e08-rollback'));
    assert.equal(rolledBack.ok, true);
    assert.equal(rolledBack.value.revision.revision.revisionId, rolledBackId);
    assert.equal(rolledBack.value.revision.revision.derivedFromRevisionIds[0], revision1);
    assert.equal((await repository.getRevision(spaceId, winnerRevision)).state.status, 'withdrawn');
    assert.equal((await repository.listEvents(spaceId, { limit: 100 })).items.length > 10, true);
    assert.equal(eventSink.events.length > 10, true);
  });
});
