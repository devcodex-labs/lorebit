import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { GenerationId, ImpactId, SpaceId } from './ids.js';

export type ImpactChangeKind = 'source' | 'policy' | 'recipe' | 'model' | 'index' | 'access' | 'withdraw' | 'integrity';
export type ImpactDisposition = 'affected' | 'reusable' | 'invalidated' | 'must-delete' | 'unknown';

export interface ImpactItem {
  readonly artifactKind: 'revision' | 'content-unit' | 'embedding' | 'index' | 'citation' | 'context' | 'cache' | 'default-query' | 'access-guarantee' | 'result-guarantee';
  readonly artifactId: string;
  readonly disposition: ImpactDisposition;
  readonly reason: string;
  readonly lineage: readonly string[];
}

export interface ImpactReport {
  readonly schemaVersion: '1.0';
  readonly impactId: ImpactId;
  readonly spaceId: SpaceId;
  readonly changeKind: ImpactChangeKind;
  readonly changeRef: string;
  readonly activeGenerationId: GenerationId | null;
  readonly items: readonly ImpactItem[];
  readonly currentGuarantees: readonly string[];
  readonly lostGuarantees: readonly string[];
  readonly requiresRebuild: boolean;
  readonly requiresMaintenance: boolean;
  readonly inputDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
}

export interface RebuildPlan {
  readonly schemaVersion: '1.0';
  readonly planId: string;
  readonly impactId: ImpactId;
  readonly spaceId: SpaceId;
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  readonly batches: readonly {
    readonly batchId: string;
    readonly action: 'reprocess' | 'reembed' | 'reindex' | 'invalidate' | 'delete' | 'verify';
    readonly artifactIds: readonly string[];
    readonly preconditions: JsonValue;
  }[];
  readonly status: 'planned' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled';
  readonly completionCriteria: readonly string[];
  readonly rollbackPoint: string;
  readonly createdAt: Rfc3339Utc;
}
