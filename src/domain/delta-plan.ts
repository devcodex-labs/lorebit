import type { DigestRef } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ContentUnitId,
  ContentUnitVersionId,
  DeltaPlanId,
  GenerationId,
  RevisionId,
  RunId,
  SpaceId
} from './ids.js';

export type DeltaKind =
  | 'added'
  | 'changed'
  | 'unchanged'
  | 'moved'
  | 'deleted'
  | 'visibility-changed'
  | 'quarantined'
  | 'unknown';

export interface DeltaItem {
  readonly unitId: ContentUnitId;
  readonly kind: DeltaKind;
  readonly previousUnitVersionId: ContentUnitVersionId | null;
  readonly nextUnitVersionId: ContentUnitVersionId | null;
  readonly reuse: 'none' | 'embedding-and-index' | 'embedding-only';
  readonly reason: string;
}

export interface DeltaPlan {
  readonly schemaVersion: '1.0';
  readonly deltaPlanId: DeltaPlanId;
  readonly spaceId: SpaceId;
  readonly runId: RunId;
  readonly revisionId: RevisionId;
  readonly baseGenerationId: GenerationId | null;
  readonly items: readonly DeltaItem[];
  readonly summary: Readonly<Record<DeltaKind, number>>;
  readonly inputDigest: DigestRef;
  readonly planDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
}

export function summarizeDelta(items: readonly DeltaItem[]): Readonly<Record<DeltaKind, number>> {
  const summary: Record<DeltaKind, number> = {
    added: 0,
    changed: 0,
    unchanged: 0,
    moved: 0,
    deleted: 0,
    'visibility-changed': 0,
    quarantined: 0,
    unknown: 0
  };
  for (const item of items) summary[item.kind] += 1;
  return summary;
}
