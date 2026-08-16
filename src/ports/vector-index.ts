import type { ExecutionOptions } from '../application/commands.js';
import type { JsonValue } from '../wire/json-value.js';
import type {
  ContentUnitId,
  ContentUnitVersionId,
  GenerationId,
  SpaceId
} from '../domain/ids.js';
import type { CompiledFilter, FilterSchema, FilterSupport } from '../domain/filter.js';

export interface VectorQueryOptions extends ExecutionOptions {
  readonly filter?: {
    readonly compiled: CompiledFilter;
    readonly schema: FilterSchema;
  };
}

export interface VectorRecord {
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly vector: readonly number[];
  readonly metadata: JsonValue;
}

export interface VectorCandidate {
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly score: number;
  readonly rank: number;
  readonly metadata: JsonValue;
}

export type VectorIndexResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'generation-not-found' | 'dimension-mismatch' | 'cancelled' | 'index-failure';
      readonly summary: string;
      readonly retryable: boolean;
    };

export interface VectorIndex {
  readonly descriptor: {
    readonly kind: 'vector-index';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
  };
  readonly capabilities: {
    readonly dimension: number;
    readonly metric: 'cosine' | 'dot';
    readonly namespaceIsolation: 'physical' | 'logical-verified' | 'none';
    readonly generationIsolation: boolean;
    readonly deleteGuarantee: 'verified' | 'best-effort' | 'none';
    readonly activation: 'repository-transaction' | 'maintenance-only' | 'none';
    readonly stableOrder: boolean;
    readonly filter: FilterSupport;
  };
  createGeneration(
    spaceId: SpaceId,
    generationId: GenerationId,
    parentGenerationId: GenerationId | null
  ): Promise<VectorIndexResult<{ readonly created: true }>>;
  upsert(
    spaceId: SpaceId,
    generationId: GenerationId,
    records: readonly VectorRecord[],
    options?: ExecutionOptions
  ): Promise<VectorIndexResult<{ readonly upserted: number }>>;
  reuse(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitId: ContentUnitId,
    nextUnitVersionId: ContentUnitVersionId,
    metadata: JsonValue
  ): Promise<VectorIndexResult<{ readonly reused: true }>>;
  delete(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitIds: readonly ContentUnitId[]
  ): Promise<VectorIndexResult<{ readonly deleted: readonly ContentUnitId[] }>>;
  count(spaceId: SpaceId, generationId: GenerationId): Promise<VectorIndexResult<number>>;
  manifest(
    spaceId: SpaceId,
    generationId: GenerationId
  ): Promise<VectorIndexResult<readonly ContentUnitVersionId[]>>;
  query(
    spaceId: SpaceId,
    generationId: GenerationId,
    vector: readonly number[],
    topK: number,
    options?: VectorQueryOptions
  ): Promise<VectorIndexResult<readonly VectorCandidate[]>>;
  close(): Promise<void>;
}
