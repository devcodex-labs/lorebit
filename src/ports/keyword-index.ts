import type { ExecutionOptions } from '../application/commands.js';
import type { JsonValue } from '../wire/json-value.js';
import type {
  ContentUnitId,
  ContentUnitVersionId,
  GenerationId,
  SpaceId
} from '../domain/ids.js';
import type { CompiledFilter, FilterSchema, FilterSupport } from '../domain/filter.js';

export interface KeywordQueryOptions extends ExecutionOptions {
  readonly filter?: {
    readonly compiled: CompiledFilter;
    readonly schema: FilterSchema;
  };
}

export interface KeywordRecord {
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly text: string;
  readonly metadata: JsonValue;
}

export interface KeywordCandidate {
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly score: number;
  readonly rank: number;
  readonly metadata: JsonValue;
}

export type KeywordIndexResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'generation-not-found' | 'cancelled' | 'index-failure';
      readonly summary: string;
      readonly retryable: boolean;
    };

export interface KeywordIndex {
  readonly descriptor: {
    readonly kind: 'keyword-index';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
  };
  readonly capabilities: {
    readonly namespaceIsolation: 'physical' | 'logical-verified' | 'none';
    readonly generationIsolation: boolean;
    readonly deleteGuarantee: 'verified' | 'best-effort' | 'none';
    readonly stableOrder: boolean;
    readonly filter: FilterSupport;
  };
  createGeneration(
    spaceId: SpaceId,
    generationId: GenerationId,
    parentGenerationId: GenerationId | null
  ): Promise<KeywordIndexResult<{ readonly created: true }>>;
  upsert(
    spaceId: SpaceId,
    generationId: GenerationId,
    records: readonly KeywordRecord[],
    options?: ExecutionOptions
  ): Promise<KeywordIndexResult<{ readonly upserted: number }>>;
  reuse(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitId: ContentUnitId,
    nextUnitVersionId: ContentUnitVersionId,
    metadata: JsonValue
  ): Promise<KeywordIndexResult<{ readonly reused: true }>>;
  delete(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitIds: readonly ContentUnitId[]
  ): Promise<KeywordIndexResult<{ readonly deleted: readonly ContentUnitId[] }>>;
  count(spaceId: SpaceId, generationId: GenerationId): Promise<KeywordIndexResult<number>>;
  manifest(
    spaceId: SpaceId,
    generationId: GenerationId
  ): Promise<KeywordIndexResult<readonly ContentUnitVersionId[]>>;
  query(
    spaceId: SpaceId,
    generationId: GenerationId,
    query: string,
    topK: number,
    options?: KeywordQueryOptions
  ): Promise<KeywordIndexResult<readonly KeywordCandidate[]>>;
  close(): Promise<void>;
}
