import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RUNTIME_RESOURCE_LIMITS } from '../../dist/index.js';
import { FakeClock } from '../../dist/testing/index.js';
import { ResourceScheduler } from '../../dist/application/services/resource-scheduler.js';

test('resource scheduler keeps query/generate lanes independent and closes queued work deterministically', async () => {
  const clock = new FakeClock('2026-08-13T11:00:00.000Z');
  const scheduler = new ResourceScheduler({
    ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
    queryConcurrency: 1,
    generateConcurrency: 1,
    maxQueuedOperations: 2
  }, clock);
  let releaseQuery;
  let releaseGenerate;
  const query = scheduler.schedule('query', 10, () => new Promise((resolve) => { releaseQuery = () => resolve('query'); }));
  const generate = scheduler.schedule('generate', 20, () => new Promise((resolve) => { releaseGenerate = () => resolve('generate'); }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduler.snapshot(), {
    queued: 0,
    repositoryInFlight: 0,
    queryInFlight: 1,
    generateInFlight: 1,
    processingInFlight: 0,
    importInFlight: 0,
    rebuildInFlight: 0,
    inFlightBytes: 30,
    closing: false
  });
  const queued = scheduler.schedule('query', 5, async () => 'queued');
  scheduler.close();
  const rejected = await queued;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'runtime-closing');
  releaseQuery();
  releaseGenerate();
  assert.equal((await query).ok, true);
  assert.equal((await generate).ok, true);
});

test('E2E-18 scheduler gives repository, processing, import and rebuild independent bounded lanes', async () => {
  const clock = new FakeClock('2026-08-13T11:05:00.000Z');
  const scheduler = new ResourceScheduler({
    ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
    repositoryConcurrency: 1,
    processingConcurrency: 1,
    importConcurrency: 1,
    rebuildConcurrency: 1,
    maxQueuedOperations: 4
  }, clock);
  const releases = new Map();
  const hold = (kind) => scheduler.schedule(kind, 10, () => new Promise((resolve) => releases.set(kind, resolve)));
  const active = [hold('repository'), hold('processing'), hold('import'), hold('rebuild')];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduler.snapshot(), {
    queued: 0,
    repositoryInFlight: 1,
    queryInFlight: 0,
    generateInFlight: 0,
    processingInFlight: 1,
    importInFlight: 1,
    rebuildInFlight: 1,
    inFlightBytes: 40,
    closing: false
  });
  const queued = [
    scheduler.schedule('repository', 1, async () => 'queued-repository'),
    scheduler.schedule('processing', 1, async () => 'queued-processing'),
    scheduler.schedule('import', 1, async () => 'queued-import'),
    scheduler.schedule('rebuild', 1, async () => 'queued-rebuild')
  ];
  const saturated = await scheduler.schedule('processing', 1, async () => 'must-not-run');
  assert.equal(saturated.ok, false);
  assert.equal(saturated.code, 'resource-saturated');
  scheduler.close();
  const rejected = await Promise.all(queued);
  assert.equal(rejected.every((result) => !result.ok && result.code === 'runtime-closing'), true);
  for (const [kind, release] of releases) release(kind);
  assert.equal((await Promise.all(active)).every((result) => result.ok), true);
});
