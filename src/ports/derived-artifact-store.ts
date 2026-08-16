import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { GenerationId, QueryPlanId, SpaceId } from '../domain/ids.js';

export interface DerivedArtifactKey {
  readonly spaceId: SpaceId;
  readonly accessFingerprint: DigestRef;
  readonly generationId: GenerationId;
  readonly queryPlanId: QueryPlanId;
  readonly kind: 'context' | 'citation' | 'result' | 'evaluation' | 'export';
  readonly artifactId: string;
}

export interface DerivedArtifact {
  readonly key: DerivedArtifactKey;
  readonly lineage: readonly string[];
  readonly value: JsonValue;
  readonly valueDigest: DigestRef;
  readonly utf8Bytes: number;
  readonly expiresAt: Rfc3339Utc;
  readonly createdAt: Rfc3339Utc;
}

export interface DerivedArtifactDeleteReceipt {
  readonly key: DerivedArtifactKey;
  readonly deleted: boolean;
  readonly observedAt: Rfc3339Utc;
}

export type DerivedArtifactStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'not-found' | 'limit' | 'cancelled' | 'store-failure'; readonly summary: string };

export interface DerivedArtifactStore {
  readonly descriptor: { readonly kind: 'derived-artifact-store'; readonly adapterId: string; readonly name: string; readonly version: string; readonly deploymentFingerprint: string; readonly testingOnly: boolean };
  readonly capabilities: { readonly maxEntries: number; readonly maxUtf8Bytes: number; readonly ttl: boolean; readonly lineageInvalidation: boolean; readonly deleteReceipt: boolean; readonly spaceIsolation: 'physical' | 'logical-verified' | 'none' };
  put(artifact: DerivedArtifact): Promise<DerivedArtifactStoreResult<{ readonly stored: true }>>;
  get(key: DerivedArtifactKey, now: Rfc3339Utc): Promise<DerivedArtifactStoreResult<DerivedArtifact>>;
  invalidateLineage(spaceId: SpaceId, lineageRef: string, at: Rfc3339Utc): Promise<DerivedArtifactStoreResult<readonly DerivedArtifactDeleteReceipt[]>>;
  delete(key: DerivedArtifactKey, at: Rfc3339Utc): Promise<DerivedArtifactStoreResult<DerivedArtifactDeleteReceipt>>;
  size(): Promise<{ readonly entries: number; readonly utf8Bytes: number }>;
  close(): Promise<void>;
}
