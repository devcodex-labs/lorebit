import assert from 'node:assert/strict';
import test from 'node:test';

import * as lorebit from '../../dist/index.js';
import * as testing from '../../dist/testing/index.js';
import { createQueryFixture } from '../fixtures/query-runtime.mjs';

test('B4 public root exposes provider-neutral module factories and resource/trace contracts', () => {
  for (const name of [
    'createLorebit',
    'defineGenerationModule',
    'createEvaluationModule',
    'defineImportExportModule',
    'resolveRuntimeResourceLimits',
    'createNoopTelemetrySink',
    'createTraceContextSnapshot',
    'decodeTraceCarrier'
  ]) assert.equal(typeof lorebit[name], 'function', `${name} must be a public function`);
  assert.equal(lorebit.DEFAULT_RUNTIME_RESOURCE_LIMITS.queryConcurrency, 16);
  assert.equal(lorebit.HARD_RUNTIME_RESOURCE_LIMITS.generateConcurrency, 4);
  for (const internalName of ['GenerationRuntimeService', 'RecoveryService', 'ResourceScheduler', 'TransferService']) {
    assert.equal(internalName in lorebit, false, `${internalName} must stay internal`);
  }
});

test('B4 testing entry exposes only explicit deterministic adapters', () => {
  for (const name of [
    'ScriptedLanguageModel',
    'InMemoryDerivedArtifactStore',
    'RecordingTelemetry',
    'SeededRandom'
  ]) assert.equal(typeof testing[name], 'function', `${name} must be a testing export`);
  assert.equal('ResourceScheduler' in testing, false);
});

test('disabled optional B4 modules return capability-unavailable without weakening retrieve/context', async (t) => {
  const fixture = await createQueryFixture({ seed: 'optional-b4' });
  t.after(() => fixture.runtime.close());
  assert.equal(fixture.runtime.readiness().operations.retrieve, true);
  assert.equal(fixture.runtime.readiness().operations.context, true);
  assert.equal(fixture.runtime.readiness().operations.generate, false);
  assert.equal((await fixture.runtime.generate({ spaceId: fixture.idsByKind.spaceId, query: 'x', mode: 'generate', access: { fingerprint: (await lorebit.digestCanonicalJson({ subject: 'x' })).value, allowedLabels: ['public'], deniedLabels: [], attributes: {} } })).error.code, 'capability-unavailable');
  assert.equal((await fixture.runtime.evaluate({ suiteId: 'x', targetRef: 'x', cases: [], observations: [] })).error.code, 'capability-unavailable');
  assert.equal((await fixture.runtime.planExport(fixture.idsByKind.spaceId)).error.code, 'capability-unavailable');
});
