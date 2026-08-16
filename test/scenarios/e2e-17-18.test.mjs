import assert from 'node:assert/strict';
import test from 'node:test';

import { defineGenerationModule } from '../../dist/index.js';
import { ScriptedLanguageModel } from '../../dist/testing/index.js';
import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

test('E2E-17/18 invalid model output remains a bounded partial result and close remains idempotent', async () => {
  const model = new ScriptedLanguageModel([{
    ok: false,
    code: 'invalid-output',
    summary: 'untrusted provider detail',
    retryable: false,
    retryAfterMs: null,
    usage: { inputTokens: 3, outputTokens: 0, calls: 1, estimatedCost: null }
  }]);
  const fixture = await createQueryFixture({
    seed: 'e2e17-18',
    generation: defineGenerationModule(model)
  });
  const result = await fixture.runtime.generate(await queryRequest(fixture, { mode: 'generate' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'partial');
  assert.equal(result.value.generation.finishReason, 'invalid');
  assert.equal(result.value.context.evidence.length > 0, true);
  assert.equal(result.value.diagnostics.some((entry) => entry.code === 'generation-invalid'), true);
  const first = fixture.runtime.close();
  const second = fixture.runtime.close();
  assert.strictEqual(first, second);
  assert.deepEqual(await first, await second);
});
