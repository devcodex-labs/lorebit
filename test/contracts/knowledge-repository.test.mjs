import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebit,
  createLorebitId,
  digestCanonicalJson
} from '../../dist/index.js';
import {
  DeterministicIdGenerator,
  FakeClock,
  InMemoryContentStore,
  InMemoryKnowledgeRepository,
  RecordingEventSink
} from '../../dist/testing/index.js';

async function fixture(namespace = 'repo') {
  const repository = new InMemoryKnowledgeRepository();
  const contentStore = new InMemoryContentStore();
  const clock = new FakeClock('2026-08-13T06:00:00.000Z');
  const ids = new DeterministicIdGenerator(namespace);
  const events = new RecordingEventSink();
  const created = await createLorebit({ repository, contentStore, clock, idGenerator: ids, eventSink: events });
  assert.equal(created.ok, true);
  return { runtime: created.value, repository, contentStore, clock, ids, events };
}

async function policy(clock, marker) {
  return {
    changeKind: 'query-only',
    questionScope: { allowed: ['docs'], denied: [] },
    admission: { allowedSourceKinds: ['document'], requiredMetadata: [] },
    evidence: {
      minimumCitations: 1,
      allowedEvidenceKinds: ['primary'],
      onInsufficientEvidence: 'empty'
    },
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
    actorRef: { type: 'test', id: 'contract' },
    reason: `contract ${payload.type}`,
    occurredAt: clock.now(),
    expected,
    payload
  };
}

test('KnowledgeRepository enforces idempotency, CAS, outbox and space isolation', async () => {
  const { runtime, repository, clock, ids, events } = await fixture();
  assert.equal(repository.descriptor.testingOnly, true);
  assert.equal(repository.capabilities.atomicCommit, true);
  assert.equal(repository.capabilities.runClaimFencing, true);
  assert.equal(repository.capabilities.spaceIsolation, 'logical-verified');
  const spaceId = createLorebitId('space', 'repo-a');
  const create = envelope(ids, clock, {
    type: 'space.create',
    spaceId,
    policyId: createLorebitId('policy', 'repo-a-1'),
    name: 'Repository contract',
    description: 'fixture',
    metadata: {},
    policy: await policy(clock, 'p1')
  }, {}, 'create-space');

  const first = await runtime.execute(create);
  const replay = await runtime.execute(structuredClone(create));
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.diagnostics[0].code, 'idempotent-replay');
  assert.equal(events.events.length, 1);

  const conflictCommand = {
    ...structuredClone(create),
    operationId: ids.next('operation'),
    reason: 'different payload under same key',
    payload: { ...structuredClone(create.payload), name: 'Conflicting name' }
  };
  const idempotencyConflict = await runtime.execute(conflictCommand);
  assert.equal(idempotencyConflict.ok, false);
  assert.equal(idempotencyConflict.error.code, 'idempotency-conflict');

  const updateA = envelope(ids, clock, {
    type: 'space.update',
    spaceId,
    description: 'winner A'
  }, { space: { spaceId, sequence: 1, status: 'open' } }, 'update-a');
  const updateB = envelope(ids, clock, {
    type: 'space.update',
    spaceId,
    description: 'winner B'
  }, { space: { spaceId, sequence: 1, status: 'open' } }, 'update-b');
  const concurrent = await Promise.all([runtime.execute(updateA), runtime.execute(updateB)]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  assert.equal(concurrent.filter((result) => !result.ok && result.error.code === 'state-conflict').length, 1);

  events.failNext('temporary contract sink outage');
  const committedWithPendingEvent = await runtime.execute(envelope(ids, clock, {
    type: 'space.update',
    spaceId,
    description: 'outbox remains canonical'
  }, { space: { spaceId, sequence: 2, status: 'open' } }, 'update-outbox'));
  assert.equal(committedWithPendingEvent.ok, true);
  assert.equal(committedWithPendingEvent.diagnostics[0].code, 'event-delivery-pending');
  const beforeFlush = await repository.listOutbox(spaceId, { limit: 100 });
  assert.equal(beforeFlush.items.filter((record) => record.status === 'pending').length, 1);
  const flushed = await runtime.flushOutbox(spaceId);
  assert.equal(flushed.ok, true);
  assert.deepEqual(flushed.value, { delivered: 1, pending: 0 });

  const otherSpace = createLorebitId('space', 'repo-b');
  assert.equal(await repository.getSpace(otherSpace), null);
  const outbox = await repository.listOutbox(spaceId, { limit: 100 });
  assert.equal(outbox.items.every((record) => record.spaceId === spaceId), true);
  assert.equal(outbox.items.every((record) => record.status === 'delivered'), true);
  assert.equal(outbox.nextCursor, null);
});

test('KnowledgeRepository pagination is stable and bounded', async () => {
  const { runtime, repository, clock, ids } = await fixture('page');
  const spaceId = createLorebitId('space', 'page');
  await runtime.execute(envelope(ids, clock, {
    type: 'space.create',
    spaceId,
    policyId: createLorebitId('policy', 'page-1'),
    name: 'Pagination',
    description: '',
    metadata: {},
    policy: await policy(clock, 'page')
  }, {}, 'space'));

  for (let index = 1; index <= 4; index += 1) {
    clock.advanceMilliseconds(1);
    await runtime.execute(envelope(ids, clock, {
      type: 'source.register',
      spaceId,
      sourceId: createLorebitId('source', `page-${index}`),
      kind: 'document',
      name: `Source ${index}`,
      locator: { kind: 'external', value: `doc-${index}`, fragment: null },
      ownership: { ownerRef: 'test', license: null, usageTerms: null },
      parentSourceId: null,
      visibilityLabels: [],
      metadata: {}
    }, {}, `source-${index}`));
  }

  const first = await repository.listEvents(spaceId, { limit: 2 });
  const second = await repository.listEvents(spaceId, { limit: 2, after: first.nextCursor });
  const third = await repository.listEvents(spaceId, { limit: 2, after: second.nextCursor });
  const all = [...first.items, ...second.items, ...third.items];
  assert.equal(all.length, 5);
  assert.equal(new Set(all.map((event) => event.eventId)).size, 5);
  assert.deepEqual(
    all.map((event) => `${event.occurredAt}|${event.eventId}`),
    all.map((event) => `${event.occurredAt}|${event.eventId}`).toSorted()
  );
  await assert.rejects(() => repository.listEvents(spaceId, { limit: 0 }), RangeError);
});
