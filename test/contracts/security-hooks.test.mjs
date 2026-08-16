import assert from 'node:assert/strict';
import test from 'node:test';

import { ScriptedSecurityHook } from '../../dist/testing/index.js';
import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

test('required beforeQuery hook can normalize without changing scope', async (t) => {
  const hook = new ScriptedSecurityHook(['beforeQuery'], {
    beforeQuery: (input) => ({ ok: true, action: 'normalize', reason: 'unicode-normalization', output: { ...input.payload, query: 'lorebit citations' }, evidenceRef: 'scan:1' })
  });
  const fixture = await createQueryFixture({
    securityHooks: [hook],
    policyExtensions: { security: { requiredHooks: ['beforeQuery'], dataClassification: 'public' } }
  });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.retrieve(await queryRequest(fixture));
  assert.equal(result.ok, true);
  assert.equal(result.value.queryPlan.normalizedQuery, 'lorebit citations');
  assert.equal(result.value.queryPlan.securityHooks[0].action, 'normalize');
  assert.equal(hook.calls.length, 1);
});

test('required hook failure is a stable fail-closed outcome', async (t) => {
  const hook = new ScriptedSecurityHook(['beforeQuery'], {
    beforeQuery: { ok: false, code: 'hook-timeout', summary: 'scanner token=secret', retryable: true }
  });
  const fixture = await createQueryFixture({
    securityHooks: [hook],
    policyExtensions: { security: { requiredHooks: ['beforeQuery'], dataClassification: 'restricted' } }
  });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.retrieve(await queryRequest(fixture));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'security-hook-failed');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
