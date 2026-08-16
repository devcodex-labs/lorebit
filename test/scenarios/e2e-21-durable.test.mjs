import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebit,
  createLorebitId,
  digestCanonicalJson,
  validateDurableCommandEnvelope
} from '../../dist/index.js';
import {
  DeterministicIdGenerator,
  FakeClock,
  InMemoryContentStore,
  InMemoryKnowledgeRepository,
  RecordingEventSink
} from '../../dist/testing/index.js';

function plus(instant, milliseconds) {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

async function policy(clock) {
  return {
    changeKind: 'query-only',
    questionScope: { allowed: ['durable'], denied: [] },
    admission: { allowedSourceKinds: ['document'], requiredMetadata: [] },
    evidence: {
      minimumCitations: 1,
      allowedEvidenceKinds: ['primary'],
      onInsufficientEvidence: 'reject'
    },
    defaultResult: {
      allowPartial: false,
      allowHistorical: false,
      emptyResult: 'insufficient-evidence'
    },
    access: { requiredLabels: [], excludedLabels: [], failClosed: true },
    exposure: { hiddenFields: [], hiddenContentLabels: [] },
    retention: { auditDays: 30, contentDays: null, tombstoneOnExpiry: true },
    extensions: {},
    validFrom: clock.now(),
    validUntil: null
  };
}

test('E2E-21 durable replay and 100 deterministic fencing races', async () => {
  const repository = new InMemoryKnowledgeRepository();
  const contentStore = new InMemoryContentStore();
  const clock = new FakeClock('2026-08-13T07:00:00.000Z');
  const ids1 = new DeterministicIdGenerator('worker1');
  const sink1 = new RecordingEventSink();
  const firstRuntime = await createLorebit({
    repository,
    contentStore,
    clock,
    idGenerator: ids1,
    eventSink: sink1
  });
  assert.equal(firstRuntime.ok, true);

  const spaceId = createLorebitId('space', 'durable');
  const createCommand = {
    schemaVersion: '1.0',
    commandType: 'space.create',
    operationId: ids1.next('operation'),
    idempotencyKey: 'durable-space',
    actorRef: { type: 'worker', id: 'one' },
    reason: 'persist before execution',
    occurredAt: clock.now(),
    expected: {},
    payload: {
      type: 'space.create',
      spaceId,
      policyId: createLorebitId('policy', 'durable-p1'),
      name: 'Durable commands',
      description: '',
      metadata: {},
      policy: await policy(clock)
    }
  };
  assert.deepEqual(validateDurableCommandEnvelope(createCommand), { ok: true });
  const persisted = JSON.stringify(createCommand);
  assert.equal(persisted.includes('AbortSignal'), false);
  assert.equal(persisted.includes('traceparent'), false);

  const committed = await firstRuntime.value.execute(createCommand, {
    signal: new AbortController().signal,
    trace: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }
  });
  assert.equal(committed.ok, true);
  assert.equal(sink1.events.length, 1);

  const ids2 = new DeterministicIdGenerator('worker2');
  const sink2 = new RecordingEventSink();
  const secondRuntime = await createLorebit({
    repository,
    contentStore,
    clock,
    idGenerator: ids2,
    eventSink: sink2
  });
  assert.equal(secondRuntime.ok, true);
  const replayed = await secondRuntime.value.execute(JSON.parse(persisted));
  assert.equal(replayed.ok, true);
  assert.equal(replayed.diagnostics[0].code, 'idempotent-replay');
  assert.equal(sink1.events.length, 1);
  assert.equal(sink2.events.length, 0);

  const withLiveControlInsideDurable = {
    ...JSON.parse(persisted),
    signal: { aborted: false }
  };
  const rejectedWire = validateDurableCommandEnvelope(withLiveControlInsideDurable);
  assert.equal(rejectedWire.ok, false);
  assert.equal(rejectedWire.error.code, 'schema-invalid');
  assert.doesNotThrow(() => validateDurableCommandEnvelope({
    ...JSON.parse(persisted),
    payload: null
  }));
  assert.equal(validateDurableCommandEnvelope({
    ...JSON.parse(persisted),
    payload: null
  }).ok, false);
  const elapsedDeadline = {
    ...JSON.parse(persisted),
    requestedDeadlineAt: createCommand.occurredAt
  };
  assert.equal(validateDurableCommandEnvelope(elapsedDeadline).error.code, 'invalid-request');

  const base = clock.now();
  let lastCheckpoint;
  for (let index = 1; index <= 100; index += 1) {
    const runId = createLorebitId('run', `race-${index}`);
    const firstClaim = await secondRuntime.value.acquireRunClaim({
      spaceId,
      runId,
      workerId: 'worker-a',
      now: base,
      leaseUntil: plus(base, 10)
    });
    assert.equal(firstClaim.ok, true);
    assert.equal(firstClaim.value.fencingToken, 1);

    const blocked = await secondRuntime.value.acquireRunClaim({
      spaceId,
      runId,
      workerId: 'worker-b',
      now: plus(base, 1),
      leaseUntil: plus(base, 20)
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'state-conflict');

    const takeover = await secondRuntime.value.acquireRunClaim({
      spaceId,
      runId,
      workerId: 'worker-b',
      now: plus(base, 11),
      leaseUntil: plus(base, 30)
    });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.value.attempt, 2);
    assert.equal(takeover.value.fencingToken, 2);

    const stale = await secondRuntime.value.saveCheckpoint({
      schemaVersion: '1.0',
      spaceId,
      runId,
      stage: 'provider-call',
      attempt: 1,
      fencingToken: 1,
      inputRefs: { source: `source-${index}` },
      componentVersions: { runtime: '0.1' },
      sideEffects: [],
      nextStep: 'write-receipt',
      savedAt: plus(base, 12)
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'stale-run-attempt');

    const current = await secondRuntime.value.saveCheckpoint({
      schemaVersion: '1.0',
      spaceId,
      runId,
      stage: 'provider-call',
      attempt: 2,
      fencingToken: 2,
      inputRefs: { source: `source-${index}` },
      componentVersions: { runtime: '0.1' },
      sideEffects: [
        {
          effectId: `effect-${index}`,
          idempotencyKey: `provider-${index}`,
          state: index === 100 ? 'external-commit-unknown' : 'committed',
          digest: null
        }
      ],
      nextStep: index === 100 ? 'reconcile' : 'complete',
      savedAt: plus(base, 12)
    });
    assert.equal(current.ok, true);
    if (index === 100) {
      lastCheckpoint = await repository.getCheckpoint(spaceId, runId);
    }
  }

  assert.equal(lastCheckpoint.sideEffects[0].state, 'external-commit-unknown');
  assert.equal(lastCheckpoint.nextStep, 'reconcile');
  assert.equal(lastCheckpoint.fencingToken, 2);
  const claim = await repository.getRunClaim(
    spaceId,
    createLorebitId('run', 'race-100')
  );
  assert.equal(claim.workerId, 'worker-b');
  assert.equal(claim.fencingToken, 2);

  const closeReceipt = await secondRuntime.value.close();
  assert.equal(closeReceipt.state, 'closed');
  assert.deepEqual(closeReceipt.closedResources, ['eventSink', 'telemetry', 'contentStore', 'repository']);
  assert.deepEqual(await secondRuntime.value.close(), closeReceipt);
  const afterClose = await secondRuntime.value.getSpace(spaceId);
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.error.code, 'runtime-closed');
  await firstRuntime.value.close();
});
