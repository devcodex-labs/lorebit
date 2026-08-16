import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebit,
  createLorebitId,
  defineImportExportModule,
  digestCanonicalJson
} from '../../dist/index.js';
import {
  InMemoryContentStore,
  InMemoryKnowledgeRepository,
  ScriptedSecurityHook
} from '../../dist/testing/index.js';
import { createQueryFixture, envelope } from '../fixtures/query-runtime.mjs';

test('E2E-23: full export/import round-trip preserves closure but never imports activation implicitly', async (t) => {
  const fixture = await createQueryFixture({
    importExport: defineImportExportModule()
  });
  t.after(() => fixture.runtime.close());

  const planned = await fixture.runtime.planExport(fixture.idsByKind.spaceId, {
    includeContent: true,
    includeEvents: true,
    includeProvenance: true
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.value.mode, 'full');
  assert.equal(planned.value.activationId, fixture.idsByKind.activationId);

  const exported = await fixture.runtime.executeExport(planned.value);
  assert.equal(exported.ok, true);
  assert.equal(exported.value.manifest.referenceClosureComplete, true);
  assert.equal(exported.value.manifest.objectCounts.sources, 1);
  assert.equal(exported.value.manifest.objectCounts.contentUnits > 0, true);
  assert.equal(exported.value.manifest.objectCounts.generations, 1);
  assert.equal(exported.value.manifest.objectCounts.generationReceipts, 1);
  assert.equal(exported.value.manifest.objectCounts.processingRuns, 1);
  assert.equal(exported.value.manifest.objectCounts.deltaPlans, 1);
  assert.equal(exported.value.manifest.objectCounts.activations, 1);
  assert.equal(exported.value.manifest.objectDigests.length > 0, true);

  const targetSpaceId = createLorebitId('space', 'roundtrip-target');
  const dryRunPlan = await fixture.runtime.planImport(exported.value, targetSpaceId);
  assert.equal(dryRunPlan.ok, true);
  const dryRun = await fixture.runtime.executeImport(dryRunPlan.value, exported.value);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.value.status, 'validated');
  assert.equal((await fixture.runtime.getSpace(targetSpaceId)).ok, false);

  const remappedSourceId = createLorebitId('source', 'roundtrip-remapped-guide');
  const importPlan = await fixture.runtime.planImport(exported.value, targetSpaceId, {
    dryRun: false,
    conflictPolicy: 'remap',
    idMappings: { [fixture.idsByKind.sourceId]: remappedSourceId }
  });
  assert.equal(importPlan.ok, true);
  const imported = await fixture.runtime.executeImport(importPlan.value, exported.value);
  assert.equal(imported.ok, true);
  assert.equal(imported.value.status, 'imported');
  assert.equal(imported.value.activated, false);
  assert.equal(imported.value.remapped[fixture.idsByKind.spaceId], targetSpaceId);
  assert.equal(imported.value.remapped[fixture.idsByKind.sourceId], remappedSourceId);
  assert.equal(imported.value.quarantined.some((entry) => entry.reason === 'activation-never-imported-implicitly'), true);
  assert.equal(imported.value.quarantined.some((entry) => entry.reason === 'generation-preserved-in-package-not-activated'), true);
  assert.equal(imported.value.quarantined.some((entry) => entry.reason === 'processing-run-preserved-in-package-not-resumed'), true);
  const target = await fixture.runtime.getSpace(targetSpaceId);
  assert.equal(target.ok, true);
  assert.equal(target.value.status, 'open');
  assert.equal(target.value.sequence, 2);
  const remappedSource = await fixture.runtime.getSource(targetSpaceId, remappedSourceId);
  assert.equal(remappedSource.ok, true);
  assert.notEqual(remappedSource.value.currentRevisionId, null);
  assert.equal((await fixture.runtime.getSource(targetSpaceId, fixture.idsByKind.sourceId)).ok, false);
  const targetSnapshot = await fixture.runtime.getQuerySnapshot(targetSpaceId);
  assert.equal(targetSnapshot.ok, false);

  const repeatedPlan = await fixture.runtime.planImport(exported.value, targetSpaceId, { dryRun: false });
  assert.equal(repeatedPlan.ok, true);
  const repeated = await fixture.runtime.executeImport(repeatedPlan.value, exported.value);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.value.status, 'failed');
  assert.deepEqual(repeated.value.conflicts, ['target-not-empty']);
});

test('full export freezes selected identities and rejects mutation of a selected object after planning', async (t) => {
  const fixture = await createQueryFixture({ seed: 'frozen-export', importExport: defineImportExportModule() });
  t.after(() => fixture.runtime.close());
  const plan = await fixture.runtime.planExport(fixture.idsByKind.spaceId);
  assert.equal(plan.ok, true);

  const laterSourceId = createLorebitId('source', 'registered-after-export-plan');
  fixture.clock.advanceMilliseconds(1);
  const added = await fixture.runtime.execute(envelope(fixture.ids, fixture.clock, {
    type: 'source.register',
    spaceId: fixture.idsByKind.spaceId,
    sourceId: laterSourceId,
    kind: 'document',
    name: 'Later source',
    locator: { kind: 'url', value: 'https://example.test/later', fragment: null },
    ownership: { ownerRef: 'test', license: null, usageTerms: null },
    parentSourceId: null,
    visibilityLabels: ['public'],
    metadata: {}
  }, {}, 'source-after-export-plan'));
  assert.equal(added.ok, true);
  const frozen = await fixture.runtime.executeExport(plan.value);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.value.payload.sources.some((source) => source.sourceId === laterSourceId), false);

  const secondPlan = await fixture.runtime.planExport(fixture.idsByKind.spaceId);
  assert.equal(secondPlan.ok, true);
  const selectedSource = await fixture.runtime.getSource(fixture.idsByKind.spaceId, fixture.idsByKind.sourceId);
  assert.equal(selectedSource.ok, true);
  fixture.clock.advanceMilliseconds(1);
  const mutated = await fixture.runtime.execute(envelope(fixture.ids, fixture.clock, {
    type: 'source.signal',
    spaceId: fixture.idsByKind.spaceId,
    sourceId: fixture.idsByKind.sourceId,
    status: 'unavailable',
    syncCursor: { kind: 'incremental', value: 'after-plan', observedAt: fixture.clock.now() }
  }, {
    source: {
      sourceId: fixture.idsByKind.sourceId,
      sequence: selectedSource.value.sequence,
      revisionId: selectedSource.value.currentRevisionId
    }
  }, 'mutate-selected-source-after-export-plan'));
  assert.equal(mutated.ok, true);
  const rejected = await fixture.runtime.executeExport(secondPlan.value);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'migration-failure');
});

test('derived-artifact export is unavailable until the adapter can enumerate a frozen artifact set', async (t) => {
  const fixture = await createQueryFixture({ seed: 'derived-export', importExport: defineImportExportModule() });
  t.after(() => fixture.runtime.close());
  const plan = await fixture.runtime.planExport(fixture.idsByKind.spaceId, { includeDerived: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, 'capability-unavailable');
});

test('E2E-18 export enters the import lane only when its frozen package estimate fits the in-flight budget', async (t) => {
  const fixture = await createQueryFixture({
    seed: 'export-byte-budget',
    content: 'x',
    importExport: defineImportExportModule(),
    resourceLimits: { maxInFlightBytes: 4 }
  });
  t.after(() => fixture.runtime.close());
  const plan = await fixture.runtime.planExport(fixture.idsByKind.spaceId);
  assert.equal(plan.ok, true);
  assert.equal(plan.value.estimatedUtf8Bytes > 4, true);
  const rejected = await fixture.runtime.executeExport(plan.value);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'resource-limit-exceeded');
});

test('tampered package and unknown migration major fail through stable runtime outcomes', async (t) => {
  const fixture = await createQueryFixture({ importExport: defineImportExportModule() });
  t.after(() => fixture.runtime.close());
  const plan = await fixture.runtime.planExport(fixture.idsByKind.spaceId);
  const exported = await fixture.runtime.executeExport(plan.value);

  const tampered = {
    ...exported.value,
    payload: { tampered: true }
  };
  const rejected = await fixture.runtime.planImport(
    tampered,
    createLorebitId('space', 'tampered-target')
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'migration-failure');

  const migration = await fixture.runtime.planMigration('1.0', '1.1', { value: 'stable' });
  assert.equal(migration.ok, true);
  const dryRun = await fixture.runtime.executeMigration(migration.value, { value: 'stable' });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.value.result, 'dry-run');
  const livePlan = await fixture.runtime.planMigration('1.0', '1.1', { value: 'stable' }, { dryRun: false });
  const migrated = await fixture.runtime.executeMigration(livePlan.value, { value: 'stable' });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.value.result, 'migrated');

  const unverifiedPlan = await fixture.runtime.planMigration('1.0', '1.1', { value: 'not-dry-run' }, { dryRun: false });
  const unverified = await fixture.runtime.executeMigration(unverifiedPlan.value, { value: 'not-dry-run' });
  assert.equal(unverified.ok, true);
  assert.equal(unverified.value.result, 'failed');

  const unknownMajor = await fixture.runtime.planMigration('2.0', '1.1', { value: 'blocked' });
  assert.equal(unknownMajor.ok, false);
  assert.equal(unknownMajor.error.code, 'migration-failure');

  const importTarget = createLorebitId('space', 'tampered-plan-target');
  const importPlan = await fixture.runtime.planImport(exported.value, importTarget);
  assert.equal(importPlan.ok, true);
  const tamperedImportPlan = { ...importPlan.value, dryRun: false };
  const tamperedImport = await fixture.runtime.executeImport(tamperedImportPlan, exported.value);
  assert.equal(tamperedImport.ok, false);
  assert.equal(tamperedImport.error.code, 'migration-failure');
  assert.equal(await fixture.repository.getSpace(importTarget), null);

  const migrationPlan = await fixture.runtime.planMigration('1.0', '1.1', { value: 'plan-integrity' });
  assert.equal(migrationPlan.ok, true);
  const tamperedMigration = await fixture.runtime.executeMigration(
    { ...migrationPlan.value, targetSchema: '1.2' },
    { value: 'plan-integrity' }
  );
  assert.equal(tamperedMigration.ok, false);
  assert.equal(tamperedMigration.error.code, 'migration-failure');
});

test('structural ID remap supports swaps and rejects collisions with unchanged package identities', async (t) => {
  const fixture = await createQueryFixture({ seed: 'remap-swap', importExport: defineImportExportModule() });
  t.after(() => fixture.runtime.close());
  const exportPlan = await fixture.runtime.planExport(fixture.idsByKind.spaceId);
  const exported = await fixture.runtime.executeExport(exportPlan.value);
  assert.equal(exported.ok, true);
  const original = exported.value.payload.sources[0];
  const otherId = createLorebitId('source', 'remap-other');
  const other = { ...original, sourceId: otherId, name: 'Other source', currentRevisionId: null };
  const sources = [...exported.value.payload.sources, other];
  const payload = { ...exported.value.payload, sources };
  const contentDigest = await digestCanonicalJson(payload);
  const sourceDigests = await Promise.all(sources.map(async (value) => ({
    kind: 'source',
    id: value.sourceId,
    digest: (await digestCanonicalJson(value)).value
  })));
  const manifest = {
    ...exported.value.manifest,
    objectCounts: { ...exported.value.manifest.objectCounts, sources: sources.length },
    objectDigests: [
      ...exported.value.manifest.objectDigests.filter((value) => value.kind !== 'source'),
      ...sourceDigests
    ],
    contentDigest: contentDigest.value
  };
  const packageDigest = await digestCanonicalJson({ manifest, payload });
  const twoSourcePackage = { ...exported.value, manifest, payload, packageDigest: packageDigest.value };
  const target = createLorebitId('space', 'remap-swap-target');

  const collision = await fixture.runtime.planImport(twoSourcePackage, target, {
    conflictPolicy: 'remap',
    idMappings: { [fixture.idsByKind.sourceId]: otherId }
  });
  assert.equal(collision.ok, false);
  assert.equal(collision.error.code, 'migration-failure');

  const plan = await fixture.runtime.planImport(twoSourcePackage, target, {
    dryRun: false,
    conflictPolicy: 'remap',
    idMappings: {
      [fixture.idsByKind.sourceId]: otherId,
      [otherId]: fixture.idsByKind.sourceId
    }
  });
  assert.equal(plan.ok, true);
  const imported = await fixture.runtime.executeImport(plan.value, twoSourcePackage);
  assert.equal(imported.ok, true);
  assert.equal(imported.value.status, 'imported');
  assert.equal((await fixture.repository.getSource(target, otherId)).name, original.name);
  assert.equal((await fixture.repository.getSource(target, fixture.idsByKind.sourceId)).name, 'Other source');
});

test('RES-02: import source and byte budgets reject the verified package before target mutation', async (t) => {
  const fixture = await createQueryFixture({
    seed: 'import-limits',
    importExport: defineImportExportModule(),
    resourceLimits: { importMaxSources: 2, importMaxUtf8Bytes: 1 }
  });
  t.after(() => fixture.runtime.close());
  const exportPlan = await fixture.runtime.planExport(fixture.idsByKind.spaceId);
  const exported = await fixture.runtime.executeExport(exportPlan.value);

  const source = exported.value.payload.sources[0];
  const sources = Array.from({ length: 3 }, (_, index) => ({
    ...source,
    sourceId: index === 0 ? source.sourceId : createLorebitId('source', `limit-${index + 1}`),
    name: `Limit source ${index + 1}`
  }));
  const payload = { ...exported.value.payload, sources };
  const contentDigest = await digestCanonicalJson(payload);
  const sourceDigests = await Promise.all(sources.map(async (value) => ({
    kind: 'source',
    id: value.sourceId,
    digest: (await digestCanonicalJson(value)).value
  })));
  const manifest = {
    ...exported.value.manifest,
    objectCounts: { ...exported.value.manifest.objectCounts, sources: sources.length },
    objectDigests: [
      ...exported.value.manifest.objectDigests.filter((value) => value.kind !== 'source'),
      ...sourceDigests
    ],
    contentDigest: contentDigest.value
  };
  const packageDigest = await digestCanonicalJson({ manifest, payload });
  const oversized = { ...exported.value, manifest, payload, packageDigest: packageDigest.value };
  const targetSpaceId = createLorebitId('space', 'import-limit-target');
  const plan = await fixture.runtime.planImport(oversized, targetSpaceId, { dryRun: false });
  assert.equal(plan.ok, true);
  const imported = await fixture.runtime.executeImport(plan.value, oversized);
  assert.equal(imported.ok, true);
  assert.equal(imported.value.status, 'failed');
  assert.equal(imported.value.conflicts.some((value) => value.startsWith('sources:3>2')), true);
  assert.equal(imported.value.conflicts.some((value) => value.startsWith('contentBytes:')), true);
  assert.equal((await fixture.runtime.getSpace(targetSpaceId)).ok, false);
});

test('export classification and required beforeExport hooks fail closed with auditable records', async (t) => {
  const missingHookFixture = await createQueryFixture({
    seed: 'export-required-hook',
    importExport: defineImportExportModule(),
    policyExtensions: {
      security: {
        requiredHooks: ['beforeExport'],
        dataClassification: 'internal'
      }
    }
  });
  t.after(() => missingHookFixture.runtime.close());
  const missingPlan = await missingHookFixture.runtime.planExport(missingHookFixture.idsByKind.spaceId);
  const missing = await missingHookFixture.runtime.executeExport(missingPlan.value);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'security-hook-failed');

  const hook = new ScriptedSecurityHook(['beforeExport']);
  const allowedFixture = await createQueryFixture({
    seed: 'export-allowed-hook',
    importExport: defineImportExportModule(),
    securityHooks: [hook],
    policyExtensions: {
      security: {
        requiredHooks: ['beforeExport'],
        dataClassification: 'internal'
      }
    }
  });
  t.after(() => allowedFixture.runtime.close());
  const allowedPlan = await allowedFixture.runtime.planExport(allowedFixture.idsByKind.spaceId);
  const allowed = await allowedFixture.runtime.executeExport(allowedPlan.value);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value.manifest.securityHooks.some((record) => record.point === 'beforeExport'), true);

  const restrictedFixture = await createQueryFixture({
    seed: 'export-classification',
    importExport: defineImportExportModule(),
    policyExtensions: { security: { dataClassification: 'restricted' } }
  });
  t.after(() => restrictedFixture.runtime.close());
  const restrictedPlan = await restrictedFixture.runtime.planExport(restrictedFixture.idsByKind.spaceId, { dataClassification: 'public' });
  const restricted = await restrictedFixture.runtime.executeExport(restrictedPlan.value);
  assert.equal(restricted.ok, false);
  assert.equal(restricted.error.code, 'access-denied');
});

test('metadata-only export cannot create target facts with unresolved content references', async (t) => {
  const fixture = await createQueryFixture({
    seed: 'metadata-export',
    importExport: defineImportExportModule()
  });
  t.after(() => fixture.runtime.close());
  const exportPlan = await fixture.runtime.planExport(fixture.idsByKind.spaceId, { includeContent: false });
  const exported = await fixture.runtime.executeExport(exportPlan.value);
  assert.equal(exported.ok, true);
  assert.equal(exported.value.manifest.omissions.some((entry) => entry.kind === 'content'), true);
  assert.equal(exported.value.manifest.objectCounts.blobs, 0);

  const targetSpaceId = createLorebitId('space', 'metadata-target');
  const importPlan = await fixture.runtime.planImport(exported.value, targetSpaceId);
  assert.equal(importPlan.ok, true);
  const dryRun = await fixture.runtime.executeImport(importPlan.value, exported.value);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.value.status, 'failed');
  assert.equal(dryRun.value.conflicts.some((value) => value.startsWith('content-missing:')), true);
  assert.equal((await fixture.runtime.getSpace(targetSpaceId)).ok, false);
});

test('incremental export stays fail-closed until ordered change and tombstone capabilities exist', async () => {
  const created = await createLorebit({
    repository: new InMemoryKnowledgeRepository(),
    contentStore: new InMemoryContentStore(),
    importExport: defineImportExportModule({ allowIncrementalExport: true })
  });
  assert.equal(created.ok, false);
  assert.equal(created.error.code, 'capability-unavailable');
});
