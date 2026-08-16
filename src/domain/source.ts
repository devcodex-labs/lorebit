import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ContentId,
  ImportBatchId,
  RevisionId,
  SourceId,
  SpaceId
} from './ids.js';

export type SourceStatus =
  | 'registered'
  | 'available'
  | 'unavailable'
  | 'drifted'
  | 'permission-changed'
  | 'quarantined'
  | 'archived';

export interface SyncCursor {
  readonly kind: 'snapshot' | 'incremental';
  readonly value: string;
  readonly observedAt: Rfc3339Utc;
}

export interface ImportBatchError {
  readonly sourceRef: string;
  readonly code: string;
  readonly summary: string;
}

export interface ImportBatch {
  readonly schemaVersion: '1.0';
  readonly importBatchId: ImportBatchId;
  readonly spaceId: SpaceId;
  readonly sourceIds: readonly SourceId[];
  readonly submittedBy: string;
  readonly manifestDigest: DigestRef;
  readonly status: 'complete' | 'partial' | 'failed';
  readonly acceptedCount: number;
  readonly failedCount: number;
  readonly errors: readonly ImportBatchError[];
  readonly createdAt: Rfc3339Utc;
}

export interface SourceLocator {
  readonly kind: 'url' | 'file' | 'external' | 'section' | 'custom';
  readonly value: string;
  readonly fragment: string | null;
}

export interface ImmutableContentRef {
  readonly schemaVersion: '1.0';
  readonly spaceId: SpaceId;
  readonly contentId: ContentId;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: DigestRef;
}

export interface SourceSnapshotRef {
  readonly content: ImmutableContentRef;
  readonly rawDigest: DigestRef;
  readonly normalizedDigest: DigestRef;
  readonly capturedAt: Rfc3339Utc;
}

export interface SourceOwnership {
  readonly ownerRef: string;
  readonly license: string | null;
  readonly usageTerms: string | null;
}

export interface Source {
  readonly schemaVersion: '1.0';
  readonly sourceId: SourceId;
  readonly spaceId: SpaceId;
  readonly kind: string;
  readonly name: string;
  readonly status: SourceStatus;
  readonly sequence: number;
  readonly locator: SourceLocator;
  readonly ownership: SourceOwnership;
  readonly parentSourceId: SourceId | null;
  readonly importBatchId: ImportBatchId | null;
  readonly syncCursor: SyncCursor | null;
  readonly currentRevisionId: RevisionId | null;
  readonly visibilityLabels: readonly string[];
  readonly metadata: JsonValue;
  readonly createdAt: Rfc3339Utc;
  readonly updatedAt: Rfc3339Utc;
}

const SOURCE_TRANSITIONS: Readonly<Record<SourceStatus, readonly SourceStatus[]>> = {
  registered: ['available', 'unavailable', 'drifted', 'permission-changed', 'quarantined', 'archived'],
  available: ['unavailable', 'drifted', 'permission-changed', 'quarantined', 'archived'],
  unavailable: ['available', 'drifted', 'permission-changed', 'quarantined', 'archived'],
  drifted: ['available', 'unavailable', 'permission-changed', 'quarantined', 'archived'],
  'permission-changed': ['available', 'unavailable', 'drifted', 'quarantined', 'archived'],
  quarantined: ['available', 'unavailable', 'archived'],
  archived: []
};

export function canTransitionSource(from: SourceStatus, to: SourceStatus): boolean {
  return from === to || SOURCE_TRANSITIONS[from].includes(to);
}
