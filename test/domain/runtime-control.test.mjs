import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTraceContextSnapshot,
  decodeTraceCarrier,
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  HARD_RUNTIME_RESOURCE_LIMITS,
  resolveRuntimeResourceLimits
} from '../../dist/index.js';

test('W3C trace carrier accepts canonical context and rebuilds invalid input without baggage', () => {
  const valid = decodeTraceCarrier({
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    tracestate: 'vendor=value'
  });
  assert.deepEqual(valid, {
    ok: true,
    traceId: '0123456789abcdef0123456789abcdef',
    parentSpanId: '0123456789abcdef',
    traceFlags: '01',
    tracestate: 'vendor=value'
  });
  assert.equal(decodeTraceCarrier({ traceparent: '00-00000000000000000000000000000000-0123456789abcdef-01' }).ok, false);
  assert.equal(decodeTraceCarrier({ traceparent: '00-0123456789abcdef0123456789abcdef-0000000000000000-01' }).ok, false);

  const rebuilt = createTraceContextSnapshot(
    { traceparent: 'provider-secret-invalid' },
    '2026-08-13T10:00:00.000Z',
    { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
  );
  assert.equal(rebuilt.validIncoming, false);
  assert.equal(rebuilt.traceId, 'a'.repeat(32));
  assert.equal(rebuilt.parentSpanId, null);
  assert.equal(rebuilt.traceparent, `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  assert.deepEqual(rebuilt.baggage, {});
  assert.equal(JSON.stringify(rebuilt).includes('provider-secret-invalid'), false);
});

test('runtime resource defaults are bounded and callers may only lower hard caps', () => {
  assert.deepEqual(resolveRuntimeResourceLimits(), DEFAULT_RUNTIME_RESOURCE_LIMITS);
  assert.equal(resolveRuntimeResourceLimits({ queryConcurrency: 1 }).queryConcurrency, 1);
  assert.equal(resolveRuntimeResourceLimits({ queryConcurrency: HARD_RUNTIME_RESOURCE_LIMITS.queryConcurrency + 1 }), null);
  assert.equal(resolveRuntimeResourceLimits({ retryBaseMilliseconds: 2_000, retryMaxMilliseconds: 100 }), null);
  assert.equal(resolveRuntimeResourceLimits({ maxQueuedOperations: 0 }), null);
});
