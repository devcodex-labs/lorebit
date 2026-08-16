import type { JsonValue } from '../wire/json-value.js';
import type { TelemetrySpan } from '../domain/trace.js';

export type TelemetryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'backpressure' | 'sink-failure'; readonly summary: string; readonly retryable: boolean };

export interface TelemetrySink {
  readonly descriptor: { readonly kind: 'telemetry'; readonly adapterId: string; readonly name: string; readonly version: string; readonly testingOnly: boolean };
  readonly capabilities: { readonly maxBuffered: number; readonly redactedByDefault: true; readonly traceContext: 'w3c'; readonly semanticConvention: string | null };
  recordSpan(span: TelemetrySpan): Promise<TelemetryResult>;
  recordMetric(name: string, value: number, attributes: JsonValue): Promise<TelemetryResult>;
  close(): Promise<void>;
}

export function createNoopTelemetrySink(): TelemetrySink {
  return {
    descriptor: { kind: 'telemetry', adapterId: '@devcodex/lorebit:noop-telemetry', name: 'NoopTelemetrySink', version: '0.1', testingOnly: false },
    capabilities: { maxBuffered: 0, redactedByDefault: true, traceContext: 'w3c', semanticConvention: null },
    async recordSpan() { return { ok: true }; },
    async recordMetric() { return { ok: true }; },
    async close() {}
  };
}
