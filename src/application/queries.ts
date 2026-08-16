import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { EventId, RevisionId, SourceId, SpaceId } from '../domain/ids.js';
import type { LifecycleEvent } from '../domain/events.js';
import type { PolicySnapshot } from '../domain/knowledge-space.js';
import type { RevisionSelector, RevisionView } from '../domain/versions.js';

export interface PageRequest {
  readonly limit: number;
  readonly after?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface RevisionQuery {
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly selector: RevisionSelector;
}

export type ResolveRevisionResult =
  | { readonly kind: 'resolved'; readonly value: RevisionView }
  | {
      readonly kind: 'limitation';
      readonly code: 'history-unavailable' | 'no-active-revision';
      readonly summary: string;
    }
  | { readonly kind: 'not-found' };

export interface VersionDifference {
  readonly kind: 'revision' | 'policy' | 'recipe' | 'generation';
  readonly leftId: RevisionId | string;
  readonly rightId: RevisionId | string;
  readonly changedFields: readonly string[];
}

export interface EventQuery {
  readonly spaceId: SpaceId;
  readonly aggregateId?: string;
  readonly from?: Rfc3339Utc;
  readonly through?: Rfc3339Utc;
  readonly page: PageRequest;
}

export type EventPage = Page<LifecycleEvent>;
export type PolicyPage = Page<PolicySnapshot>;

export function eventCursor(event: Pick<LifecycleEvent, 'occurredAt' | 'eventId'>): string {
  return `${event.occurredAt}|${event.eventId satisfies EventId}`;
}
