import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebitId,
  digestCanonicalJson
} from '../../dist/index.js';

import {
  InMemoryDerivedArtifactStore,
  RecordingTelemetry
} from '../../dist/testing/index.js';
import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

test('E2E-25: generation integrity audit produces Impact/Rebuild/Recovery evidence and fail-closes default query', async (t) => {
  const derivedArtifacts = new InMemoryDerivedArtifactStore();
  const telemetry = new RecordingTelemetry();
  const fixture = await createQueryFixture({ derivedArtifacts, telemetry });
  t.after(() => fixture.runtime.close());

  const initialSnapshot = await fixture.runtime.getQuerySnapshot(fixture.idsByKind.spaceId);
  assert.equal(initialSnapshot.ok, true);
  const healthy = await fixture.runtime.auditGeneration(
    fixture.idsByKind.spaceId,
    fixture.idsByKind.generationId
  );
  assert.equal(healthy.ok, true);
  assert.equal(healthy.value.status, 'passed');

  const retrieved = await fixture.runtime.retrieve(await queryRequest(fixture));
  assert.equal(retrieved.ok, true);
  const deleted = await fixture.vectorIndex.delete(
    fixture.idsByKind.spaceId,
    fixture.idsByKind.generationId,
    [retrieved.value.retrieval.candidates[0].unitId]
  );
  assert.equal(deleted.ok, true);

  const audit = await fixture.runtime.auditGeneration(
    fixture.idsByKind.spaceId,
    fixture.idsByKind.generationId
  );
  assert.equal(audit.ok, true);
  assert.equal(audit.value.status, 'failed');
  assert.equal(audit.value.probes.some((probe) => probe.name === 'vector-count' && !probe.passed), true);
  assert.equal(audit.value.impact.requiresRebuild, true);
  assert.equal(audit.value.impact.lostGuarantees.includes('default-query-safety'), true);
  assert.equal(audit.value.recovery.steps.some((step) => step.action === 'maintenance'), true);
  assert.equal(fixture.runtime.readiness().state, 'degraded');
  assert.equal(fixture.runtime.readiness().operations.retrieve, false);

  const blocked = await fixture.runtime.retrieve(await queryRequest(fixture));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'maintenance-required');

  const rebuild = await fixture.runtime.planRebuild(audit.value.impact);
  assert.equal(rebuild.ok, true);
  assert.equal(rebuild.value.priority, 'critical');
  assert.deepEqual(rebuild.value.batches.map((batch) => batch.action), ['invalidate', 'reindex', 'verify']);

  const accessFingerprint = await digestCanonicalJson({ subject: 'recovery-test' });
  const artifactValueDigest = await digestCanonicalJson({ cached: true });
  const artifactKey = {
    spaceId: fixture.idsByKind.spaceId,
    accessFingerprint: accessFingerprint.value,
    generationId: fixture.idsByKind.generationId,
    queryPlanId: createLorebitId('query-plan', 'recovery-cache'),
    kind: 'context',
    artifactId: 'recovery-cache'
  };
  assert.equal((await derivedArtifacts.put({
    key: artifactKey,
    lineage: [fixture.idsByKind.generationId],
    value: { cached: true },
    valueDigest: artifactValueDigest.value,
    utf8Bytes: 15,
    createdAt: fixture.clock.now(),
    expiresAt: '2026-08-13T09:00:00.000Z'
  })).ok, true);

  const recovery = await fixture.runtime.executeRecovery(audit.value.recovery);
  assert.equal(recovery.ok, true);
  assert.equal(recovery.value.activeStatePreserved, true);
  assert.equal(recovery.value.executedSteps.length > 0, true);
  assert.equal(recovery.value.result, 'partial');
  assert.equal(recovery.value.details.deletedDerivedArtifacts > 0, true);
  assert.equal((await derivedArtifacts.size()).entries, 0);
  const currentSnapshot = await fixture.runtime.getQuerySnapshot(fixture.idsByKind.spaceId);
  assert.equal(currentSnapshot.ok, true);
  assert.equal(currentSnapshot.value.activationId, initialSnapshot.value.activationId);
  assert.equal(telemetry.metrics.some((metric) => metric.name === 'lorebit.generation.integrity_failures' && metric.value > 0), true);
});

test('policy impact distinguishes reusable canonical facts from invalidated derived query guarantees', async (t) => {
  const fixture = await createQueryFixture();
  t.after(() => fixture.runtime.close());
  const impact = await fixture.runtime.getImpact(
    fixture.idsByKind.spaceId,
    'access',
    'policy:new-access-boundary'
  );
  assert.equal(impact.ok, true);
  assert.equal(impact.value.items.some((item) => item.artifactKind === 'citation' && item.disposition === 'invalidated'), true);
  assert.equal(impact.value.items.some((item) => item.artifactKind === 'content-unit' && item.disposition === 'reusable'), true);
  assert.equal(impact.value.currentGuarantees.includes('canonical-history'), true);
});
