import type { OperationId } from '../domain/ids.js';
import type { TraceContextSnapshot } from '../domain/trace.js';
import type { EventTraceContext } from '../domain/trace.js';

const activeTraces = new Map<OperationId, { readonly value: EventTraceContext; count: number }>();

export function bindExecutionTrace(operationId: OperationId, snapshot: TraceContextSnapshot): () => void {
  const value: EventTraceContext = {
    schemaVersion: '1.0',
    traceparent: snapshot.traceparent,
    tracestate: snapshot.tracestate
  };
  const current = activeTraces.get(operationId);
  if (current === undefined) activeTraces.set(operationId, { value, count: 1 });
  else current.count += 1;
  return () => {
    const bound = activeTraces.get(operationId);
    if (bound === undefined) return;
    bound.count -= 1;
    if (bound.count === 0) activeTraces.delete(operationId);
  };
}

export function currentExecutionTrace(operationId: OperationId): EventTraceContext | null {
  return activeTraces.get(operationId)?.value ?? null;
}
