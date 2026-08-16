import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { TraceCarrier } from '../application/commands.js';

export interface TraceContextSnapshot {
  readonly schemaVersion: '1.0';
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly traceFlags: string;
  readonly traceparent: string;
  readonly tracestate: string | null;
  readonly baggage: Readonly<Record<string, string>>;
  readonly validIncoming: boolean;
  readonly observedAt: Rfc3339Utc;
}

export interface EventTraceContext {
  readonly schemaVersion: '1.0';
  readonly traceparent: string;
  readonly tracestate: string | null;
}

export interface TelemetrySpan {
  readonly schemaVersion: '1.0';
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly scope: { readonly spaceId: string; readonly operationId: string | null; readonly queryPlanId: string | null; readonly generationId: string | null };
  readonly attributes: JsonValue;
  readonly startedAt: Rfc3339Utc;
  readonly completedAt: Rfc3339Utc;
  readonly status: 'ok' | 'error';
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE = /^[\x20-\x7E]{0,512}$/;

export function decodeTraceCarrier(input: TraceCarrier | undefined):
  | { readonly ok: true; readonly traceId: string; readonly parentSpanId: string; readonly traceFlags: string; readonly tracestate: string | null }
  | { readonly ok: false; readonly summary: string } {
  if (input === undefined) return { ok: false, summary: 'Trace carrier is absent.' };
  const matched = TRACEPARENT.exec(input.traceparent);
  if (matched === null || matched[1] === '0'.repeat(32) || matched[2] === '0'.repeat(16)) return { ok: false, summary: 'traceparent is invalid.' };
  if (input.tracestate !== undefined && !TRACESTATE.test(input.tracestate)) return { ok: false, summary: 'tracestate is invalid.' };
  return { ok: true, traceId: matched[1]!, parentSpanId: matched[2]!, traceFlags: matched[3]!, tracestate: input.tracestate ?? null };
}

export function createTraceContextSnapshot(
  carrier: TraceCarrier | undefined,
  observedAt: Rfc3339Utc,
  fallback: { readonly traceId: string; readonly spanId: string }
): TraceContextSnapshot {
  const decoded = decodeTraceCarrier(carrier);
  const traceId = decoded.ok ? decoded.traceId : fallback.traceId;
  const parentSpanId = decoded.ok ? decoded.parentSpanId : null;
  const carrierSpanId = decoded.ok ? decoded.parentSpanId : fallback.spanId;
  const traceFlags = decoded.ok ? decoded.traceFlags : '01';
  return {
    schemaVersion: '1.0',
    traceId,
    parentSpanId,
    traceFlags,
    traceparent: `00-${traceId}-${carrierSpanId}-${traceFlags}`,
    tracestate: decoded.ok ? decoded.tracestate : null,
    baggage: {},
    validIncoming: decoded.ok,
    observedAt
  };
}
