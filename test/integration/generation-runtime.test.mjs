import assert from 'node:assert/strict';
import test from 'node:test';

import { defineGenerationModule } from '../../dist/index.js';
import {
  RecordingTelemetry,
  DeterministicTokenCounter,
  ScriptedLanguageModel,
  ScriptedSecurityHook,
  SeededRandom
} from '../../dist/testing/index.js';
import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

const usage = { inputTokens: 12, outputTokens: 4, calls: 1, estimatedCost: null };

test('optional LanguageModel completes the retrieve → context → generate profile with input provenance', async (t) => {
  const model = new ScriptedLanguageModel();
  const telemetry = new RecordingTelemetry();
  const fixture = await createQueryFixture({
    generation: defineGenerationModule(model),
    telemetry,
    random: new SeededRandom(42)
  });
  t.after(() => fixture.runtime.close());

  const request = await queryRequest(fixture, {
    mode: 'generate',
    trustedDirective: 'Answer only from the evidence and retain citations.'
  });
  const result = await fixture.runtime.generate(request, {
    trace: {
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      tracestate: 'lorebit=test'
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.mode, 'generate');
  assert.equal(result.value.generation.status, 'completed');
  assert.match(result.value.generation.text, /^Generated from citation_/);
  assert.equal(result.value.context.evidence.length > 0, true);
  assert.deepEqual(result.value.citations, result.value.context.evidence.map((entry) => entry.citation));
  assert.equal(result.value.provenance.contextManifestDigest.value, result.value.context.provenance.manifestDigest.value);
  assert.equal(result.value.provenance.modelRefs.includes('lorebit-scripted-model@0.1'), true);
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0].context.evidence.every((entry) => entry.trust === 'untrusted-retrieved-data'), true);
  assert.equal(fixture.runtime.profile().completeRag, 'configured');
  assert.equal(fixture.runtime.readiness().operations.generate, true);
  assert.equal(telemetry.spans.some((span) => span.traceId === '0123456789abcdef0123456789abcdef'), true);
  assert.equal(JSON.stringify(telemetry.spans).includes(request.query), false);
});

test('E2E-17: LanguageModel refusal returns a partial generation result while retaining context and citations', async (t) => {
  const model = new ScriptedLanguageModel([{
    ok: false,
    code: 'refused',
    summary: 'Provider-specific refusal details.',
    retryable: false,
    retryAfterMs: null,
    usage
  }]);
  const fixture = await createQueryFixture({
    generation: defineGenerationModule(model),
    random: new SeededRandom(7)
  });
  t.after(() => fixture.runtime.close());

  const result = await fixture.runtime.query(await queryRequest(fixture, { mode: 'generate' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'partial');
  assert.equal(result.value.generation.status, 'failed');
  assert.equal(result.value.generation.finishReason, 'refused');
  assert.equal(result.value.generation.text, null);
  assert.equal(result.value.context.evidence.length > 0, true);
  assert.equal(result.value.citations.length > 0, true);
  assert.equal(result.value.diagnostics.some((entry) => entry.code === 'generation-failure'), true);
  assert.equal(JSON.stringify(result.value.diagnostics).includes('Provider-specific refusal details.'), false);
});

test('afterGenerate security policy can block model output without discarding evidence', async (t) => {
  const hook = new ScriptedSecurityHook(['afterGenerate'], {
    afterGenerate(input) {
      return {
        ok: true,
        action: 'block',
        reason: 'scripted-output-policy',
        output: input.payload,
        evidenceRef: 'policy:test-output'
      };
    }
  });
  const fixture = await createQueryFixture({
    generation: defineGenerationModule(new ScriptedLanguageModel()),
    securityHooks: [hook]
  });
  t.after(() => fixture.runtime.close());

  const result = await fixture.runtime.generate(await queryRequest(fixture, { mode: 'generate' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'partial');
  assert.equal(result.value.generation.status, 'blocked');
  assert.equal(result.value.generation.text, null);
  assert.equal(result.value.context.evidence.length > 0, true);
  assert.equal(result.value.provenance.securityHooks.some((record) => record.point === 'afterGenerate' && record.action === 'block'), true);
});

test('remote generation egress is fail-closed before the LanguageModel receives context', async (t) => {
  const model = new ScriptedLanguageModel([], {
    deploymentClass: 'remote',
    providerProfile: 'remote-model-not-allowed',
    region: 'us-test-1',
    trainingUse: 'unknown',
    retention: 'unknown',
    attestationRef: null
  });
  const fixture = await createQueryFixture({ generation: defineGenerationModule(model) });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.generate(await queryRequest(fixture, { mode: 'generate' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'partial');
  assert.equal(result.value.generation.status, 'failed');
  assert.equal(result.value.context.evidence.length > 0, true);
  assert.equal(result.value.diagnostics.some((entry) => entry.code === 'data-egress-denied'), true);
  assert.equal(result.value.provenance.egressDecisions.some((decision) => decision.stage === 'generation' && !decision.allowed), true);
  assert.equal(model.requests.length, 0);
});

test('LanguageModel context-token capability is enforced before provider invocation', async (t) => {
  const delegate = new ScriptedLanguageModel();
  const model = {
    descriptor: delegate.descriptor,
    capabilities: { ...delegate.capabilities, maxContextTokens: 1 },
    generate: (request, options) => delegate.generate(request, options),
    close: () => delegate.close()
  };
  const fixture = await createQueryFixture({
    generation: defineGenerationModule(model),
    tokenCounter: new DeterministicTokenCounter()
  });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.generate(await queryRequest(fixture, { mode: 'generate' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'partial');
  assert.equal(result.value.diagnostics.some((entry) => entry.code === 'resource-limit-exceeded'), true);
  assert.equal(delegate.requests.length, 0);
});

test('invalid incoming trace is rebuilt, diagnosed and never propagated as raw carrier data', async (t) => {
  const telemetry = new RecordingTelemetry();
  const fixture = await createQueryFixture({ telemetry, random: new SeededRandom(99) });
  t.after(() => fixture.runtime.close());
  telemetry.spans.length = 0;
  telemetry.metrics.length = 0;
  const result = await fixture.runtime.retrieve(await queryRequest(fixture), {
    trace: { traceparent: 'secret-invalid-provider-carrier' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.some((entry) => entry.code === 'trace-carrier-invalid'), true);
  assert.equal(telemetry.spans.length, 1);
  assert.equal(telemetry.spans[0].attributes.validIncomingTrace, false);
  assert.match(telemetry.spans[0].traceId, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(telemetry.spans).includes('secret-invalid-provider-carrier'), false);
});

test('RES-09: runtime owns a bounded retry budget, aggregates usage and does not retry past deadline', async (t) => {
  const retryable = {
    ok: false,
    code: 'rate-limited',
    summary: 'provider retry detail',
    retryable: true,
    retryAfterMs: 0,
    usage: { inputTokens: 2, outputTokens: 0, calls: 1, estimatedCost: null }
  };
  const recoveredModel = new ScriptedLanguageModel([
    retryable,
    retryable,
    {
      ok: true,
      text: 'Recovered on the third bounded attempt.',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 6, calls: 1, estimatedCost: null },
      providerRequestId: 'attempt-3'
    }
  ]);
  const fixture = await createQueryFixture({
    seed: 'retry-budget',
    generation: defineGenerationModule(recoveredModel),
    random: { next: () => 0, hex: (bytes) => 'a'.repeat(bytes * 2) }
  });
  t.after(() => fixture.runtime.close());
  const recovered = await fixture.runtime.generate(await queryRequest(fixture, { mode: 'generate' }));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.generation.status, 'completed');
  assert.equal(recovered.value.generation.attempts.length, 3);
  assert.equal(recovered.value.generation.usage.calls, 3);
  assert.deepEqual(recovered.value.generation.attempts.map((attempt) => attempt.retryDelayMs), [0, 0, 0]);

  const deadlineModel = new ScriptedLanguageModel([retryable, retryable]);
  const deadlineFixture = await createQueryFixture({
    seed: 'retry-deadline',
    generation: defineGenerationModule(deadlineModel),
    random: { next: () => 0.99, hex: (bytes) => 'b'.repeat(bytes * 2) }
  });
  t.after(() => deadlineFixture.runtime.close());
  const deadlineAt = new Date(Date.parse(deadlineFixture.clock.now()) + 50).toISOString();
  const bounded = await deadlineFixture.runtime.generate(
    await queryRequest(deadlineFixture, { mode: 'generate' }),
    { deadlineAt }
  );
  assert.equal(bounded.ok, true);
  assert.equal(bounded.value.generation.status, 'failed');
  assert.equal(bounded.value.generation.attempts.length, 1);
  assert.equal(deadlineModel.requests.length, 1);
});

test('RES-10: in-flight generation cancellation and deadline propagate to the model while retaining context', async (t) => {
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const waitingStep = async (_request, options) => {
    enteredResolve();
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
    return {
      ok: false,
      code: 'cancelled',
      summary: 'adapter observed cancellation',
      retryable: false,
      retryAfterMs: null,
      usage: { inputTokens: 4, outputTokens: 0, calls: 1, estimatedCost: null }
    };
  };
  const model = new ScriptedLanguageModel([waitingStep]);
  const fixture = await createQueryFixture({
    seed: 'generation-cancel',
    generation: defineGenerationModule(model)
  });
  t.after(() => fixture.runtime.close());
  const controller = new AbortController();
  const pending = fixture.runtime.generate(
    await queryRequest(fixture, { mode: 'generate' }),
    { signal: controller.signal }
  );
  await entered;
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.value.status, 'partial');
  assert.equal(cancelled.value.context.evidence.length > 0, true);
  assert.equal(cancelled.value.diagnostics.some((entry) => entry.code === 'cancelled'), true);

  let deadlineEnteredResolve;
  const deadlineEntered = new Promise((resolve) => { deadlineEnteredResolve = resolve; });
  const deadlineModel = new ScriptedLanguageModel([async (_request, options) => {
    deadlineEnteredResolve();
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
    return {
      ok: false,
      code: 'cancelled',
      summary: 'adapter deadline cancellation',
      retryable: false,
      retryAfterMs: null,
      usage: { inputTokens: 4, outputTokens: 0, calls: 1, estimatedCost: null }
    };
  }]);
  const deadlineFixture = await createQueryFixture({
    seed: 'generation-deadline',
    generation: defineGenerationModule(deadlineModel)
  });
  t.after(() => deadlineFixture.runtime.close());
  const deadlineAt = new Date(Date.parse(deadlineFixture.clock.now()) + 25).toISOString();
  const deadlinePending = deadlineFixture.runtime.generate(
    await queryRequest(deadlineFixture, { mode: 'generate' }),
    { deadlineAt }
  );
  await deadlineEntered;
  const expired = await deadlinePending;
  assert.equal(expired.ok, true);
  assert.equal(expired.value.status, 'partial');
  assert.equal(expired.value.context.evidence.length > 0, true);
  assert.equal(expired.value.diagnostics.some((entry) => entry.code === 'deadline-exceeded'), true);
});
