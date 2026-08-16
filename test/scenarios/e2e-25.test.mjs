import assert from 'node:assert/strict';
import test from 'node:test';

import { defineGenerationModule } from '../../dist/index.js';
import { DeterministicTokenCounter, RecordingTelemetry, ScriptedLanguageModel, SeededRandom } from '../../dist/testing/index.js';
import { createQueryFixture, envelope, queryRequest } from '../fixtures/query-runtime.mjs';

test('E2E-25 W3C parent-child trace links query orchestration to generation without raw content', async (t) => {
  const telemetry = new RecordingTelemetry();
  const languageModel = new ScriptedLanguageModel([(modelRequest) => ({
    ok: true,
    text: `Generated from ${modelRequest.context.evidence[0].citation.citationId}.`,
    finishReason: 'stop',
    usage: {
      inputTokens: modelRequest.context.usage.tokens ?? 9,
      outputTokens: 4,
      calls: 1,
      estimatedCost: { amount: 0.002, currency: 'USD', precision: 'estimated' }
    },
    providerRequestId: 'e2e25-usage'
  })]);
  const fixture = await createQueryFixture({
    seed: 'e2e25',
    generation: defineGenerationModule(languageModel),
    tokenCounter: new DeterministicTokenCounter(),
    telemetry,
    random: new SeededRandom(25)
  });
  t.after(() => fixture.runtime.close());
  telemetry.spans.length = 0;
  telemetry.metrics.length = 0;
  const request = await queryRequest(fixture, { mode: 'generate' });
  const result = await fixture.runtime.generate(request, {
    trace: { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' }
  });
  assert.equal(result.ok, true);
  assert.equal(telemetry.spans.length, 2);
  assert.deepEqual([...new Set(telemetry.spans.map((span) => span.traceId))], ['11111111111111111111111111111111']);
  assert.equal(telemetry.spans.some((span) => telemetry.spans.some((parent) => span.parentSpanId === parent.spanId)), true);
  assert.equal(JSON.stringify(telemetry.spans).includes(request.query), false);
  assert.equal(JSON.stringify(telemetry.spans).includes(result.value.generation.text), false);
  assert.equal(telemetry.metrics.some((metric) => metric.name === 'lorebit.generation.calls'), true);
  assert.equal(
    telemetry.metrics.some((metric) => metric.name === 'lorebit.generation.input_tokens'),
    true,
    JSON.stringify(telemetry.metrics)
  );
  assert.equal(telemetry.metrics.some((metric) => metric.name === 'lorebit.generation.output_tokens'), true);
  assert.equal(telemetry.metrics.some((metric) => metric.name === 'lorebit.generation.estimated_cost'), true);
});

test('E2E-25 lifecycle trace reaches operation, event, and outbox records without entering command identity', async (t) => {
  const telemetry = new RecordingTelemetry();
  const fixture = await createQueryFixture({ telemetry, random: new SeededRandom(26), seed: 'e2e25-event' });
  t.after(() => fixture.runtime.close());
  telemetry.spans.length = 0;
  telemetry.metrics.length = 0;
  const source = await fixture.runtime.getSource(fixture.idsByKind.spaceId, fixture.idsByKind.sourceId);
  assert.equal(source.ok, true);
  fixture.clock.advanceMilliseconds(1);
  const command = envelope(fixture.ids, fixture.clock, {
    type: 'source.signal',
    spaceId: fixture.idsByKind.spaceId,
    sourceId: fixture.idsByKind.sourceId,
    status: 'unavailable'
  }, {
    source: {
      sourceId: fixture.idsByKind.sourceId,
      sequence: source.value.sequence,
      revisionId: source.value.currentRevisionId
    }
  }, 'e2e25-traced-source-signal');
  const traceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
  const signalled = await fixture.runtime.execute(command, { trace: { traceparent } });
  assert.equal(signalled.ok, true);

  const events = await fixture.runtime.listEvents(fixture.idsByKind.spaceId, { limit: 1000 }, fixture.idsByKind.sourceId);
  assert.equal(events.ok, true);
  const event = events.value.items.find((candidate) => candidate.operationId === command.operationId);
  assert.notEqual(event, undefined);
  assert.equal(event.traceContext.traceparent.startsWith('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-'), true);
  assert.notEqual(event.traceContext.traceparent, traceparent);

  const operation = await fixture.repository.getOperation(fixture.idsByKind.spaceId, command.idempotencyKey);
  assert.equal(operation.traceContext.traceparent, event.traceContext.traceparent);
  const outbox = await fixture.repository.listOutbox(fixture.idsByKind.spaceId, { limit: 1000 });
  const outboxRecord = outbox.items.find((candidate) => candidate.event.eventId === event.eventId);
  assert.notEqual(outboxRecord, undefined);
  assert.equal(outboxRecord.event.traceContext.traceparent, event.traceContext.traceparent);
  assert.equal(telemetry.spans.some((span) => span.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(JSON.stringify(event.traceContext).includes('Lorebit knowledge version retrieval'), false);
});

test('E2E-25 telemetry sink failures never change lifecycle or query outcomes', async (t) => {
  const failingTelemetry = {
    descriptor: Object.freeze({ kind: 'telemetry', adapterId: 'test:failing-telemetry', name: 'FailingTelemetry', version: '0.1', testingOnly: true }),
    capabilities: Object.freeze({ maxBuffered: 1, redactedByDefault: true, traceContext: 'w3c', semanticConvention: null }),
    async recordSpan() { throw new Error('telemetry unavailable'); },
    async recordMetric() { throw new Error('telemetry unavailable'); },
    async close() {}
  };
  const fixture = await createQueryFixture({ telemetry: failingTelemetry, seed: 'e2e25-failing-telemetry' });
  t.after(() => fixture.runtime.close());
  const request = await queryRequest(fixture);
  const result = await fixture.runtime.retrieve(request);
  assert.equal(result.ok, true);
});
