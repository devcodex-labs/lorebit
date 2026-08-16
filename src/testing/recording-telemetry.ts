import type { JsonValue } from '../wire/json-value.js';
import type { TelemetrySpan } from '../domain/trace.js';
import type { TelemetryResult, TelemetrySink } from '../ports/telemetry.js';

export class RecordingTelemetry implements TelemetrySink {
  readonly descriptor = Object.freeze({ kind: 'telemetry' as const, adapterId: '@devcodex/lorebit/testing:recording-telemetry', name: 'RecordingTelemetry', version: '0.1', testingOnly: true });
  readonly capabilities;
  readonly spans: TelemetrySpan[] = [];
  readonly metrics: Array<{ readonly name: string; readonly value: number; readonly attributes: JsonValue }> = [];
  #closed = false;

  constructor(maxBuffered = 10_000, semanticConvention: string | null = null) {
    this.capabilities = Object.freeze({ maxBuffered, redactedByDefault: true as const, traceContext: 'w3c' as const, semanticConvention });
  }

  async recordSpan(span: TelemetrySpan): Promise<TelemetryResult> {
    if (this.#closed) return { ok: false, code: 'sink-failure', summary: 'Telemetry is closed.', retryable: false };
    if (this.spans.length + this.metrics.length >= this.capabilities.maxBuffered) return { ok: false, code: 'backpressure', summary: 'Telemetry buffer is full.', retryable: true };
    this.spans.push(structuredClone(span));
    return { ok: true };
  }

  async recordMetric(name: string, value: number, attributes: JsonValue): Promise<TelemetryResult> {
    if (this.#closed) return { ok: false, code: 'sink-failure', summary: 'Telemetry is closed.', retryable: false };
    if (this.spans.length + this.metrics.length >= this.capabilities.maxBuffered) return { ok: false, code: 'backpressure', summary: 'Telemetry buffer is full.', retryable: true };
    this.metrics.push(structuredClone({ name, value, attributes }));
    return { ok: true };
  }

  async close() { this.#closed = true; }
}
