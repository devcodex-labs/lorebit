import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { EventId, OperationId, OutboxId, SpaceId } from './ids.js';
import type { EventTraceContext } from './trace.js';

export interface AggregateRef {
  readonly kind:
    | 'space'
    | 'policy'
    | 'source'
    | 'revision'
    | 'recipe'
    | 'activation'
    | 'generation'
    | 'import'
    | 'run';
  readonly id: string;
  readonly spaceId: SpaceId;
}

export interface LifecycleEvent {
  readonly schemaVersion: '1.0';
  readonly eventId: EventId;
  readonly eventType: string;
  readonly aggregate: AggregateRef;
  readonly aggregateSequence: number;
  readonly operationId: OperationId;
  readonly causationId: OperationId;
  readonly correlationId: string;
  readonly traceContext?: EventTraceContext;
  readonly occurredAt: Rfc3339Utc;
  readonly payloadDigest: DigestRef;
  readonly payload: JsonValue;
}

export interface OutboxRecord {
  readonly outboxId: OutboxId;
  readonly spaceId: SpaceId;
  readonly event: LifecycleEvent;
  readonly status: 'pending' | 'delivered';
  readonly attemptCount: number;
  readonly deliveredAt: Rfc3339Utc | null;
}
