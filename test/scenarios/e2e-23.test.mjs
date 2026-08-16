import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RUNTIME_RESOURCE_LIMITS } from '../../dist/index.js';
import {
  DeterministicIdGenerator,
  FakeClock,
  InMemoryContentStore,
  InMemoryKnowledgeRepository
} from '../../dist/testing/index.js';
import { TransferService } from '../../dist/application/services/transfer-service.js';

test('E2E-23 migration failure injection distinguishes rollback from roll-forward boundary', async () => {
  const service = new TransferService({
    repository: new InMemoryKnowledgeRepository(),
    contentStore: new InMemoryContentStore(),
    clock: new FakeClock('2026-08-13T11:20:00.000Z'),
    ids: new DeterministicIdGenerator('e2e23'),
    limits: DEFAULT_RUNTIME_RESOURCE_LIMITS,
    allowIncrementalExport: false,
    requireDryRunBeforeMigration: true,
    securityHooks: []
  });
  const input = { schemaVersion: '1.0', value: 'migration-fixture' };
  const plan = await service.planMigration('1.0', '1.1', input);
  const rolledBack = await service.executeMigration(plan, input, 1);
  assert.equal(rolledBack.result, 'rolled-back');
  assert.deepEqual(rolledBack.completedSteps, []);
  const rollForward = await service.executeMigration(plan, input, 3);
  assert.equal(rollForward.result, 'roll-forward-required');
  assert.deepEqual(rollForward.completedSteps, [1, 2]);
});
