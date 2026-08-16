import type { ExecutionOptions } from '../application/commands.js';
import type { ContentUnitId, GenerationId, SpaceId } from '../domain/ids.js';
import type {
  VectorCandidate,
  VectorIndex,
  VectorIndexResult,
  VectorRecord,
  VectorQueryOptions
} from '../ports/vector-index.js';
import { matchesFilterExpression } from '../domain/filter.js';

function generationKey(spaceId: SpaceId, generationId: GenerationId): string {
  return `${spaceId}\u0000${generationId}`;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

export class InMemoryVectorIndex implements VectorIndex {
  readonly descriptor;
  readonly capabilities;
  readonly #generations = new Map<string, Map<string, VectorRecord>>();
  queryCalls = 0;
  #closed = false;

  constructor(dimension = 8, deploymentFingerprint = 'testing:vector:default') {
    this.capabilities = Object.freeze({
      dimension,
      metric: 'cosine' as const,
      namespaceIsolation: 'logical-verified' as const,
      generationIsolation: true,
      deleteGuarantee: 'verified' as const,
      activation: 'repository-transaction' as const,
      stableOrder: true
      ,filter: {
        pushdown: 'full' as const,
        predicates: ['eq', 'neq', 'in', 'exists', 'lt', 'lte', 'gt', 'gte'] as const,
        booleanOperators: ['and', 'or', 'not'] as const,
        nullSemantics: 'lorebit-v1' as const
      }
    });
    this.descriptor = Object.freeze({
      kind: 'vector-index' as const,
      adapterId: '@devcodex/lorebit/testing:in-memory-vector-index',
      name: 'InMemoryVectorIndex',
      version: '0.1',
      deploymentFingerprint,
      testingOnly: true
    });
  }

  async createGeneration(
    spaceId: SpaceId,
    generationId: GenerationId,
    parentGenerationId: GenerationId | null
  ): Promise<VectorIndexResult<{ readonly created: true }>> {
    if (this.#closed) return this.#failure('index-failure', 'Vector index is closed.');
    const key = generationKey(spaceId, generationId);
    if (this.#generations.has(key)) return { ok: true, value: { created: true } };
    let records = new Map<string, VectorRecord>();
    if (parentGenerationId !== null) {
      const parent = this.#generations.get(generationKey(spaceId, parentGenerationId));
      if (parent === undefined) {
        return this.#failure('generation-not-found', 'Parent vector generation was not found.');
      }
      records = structuredClone(parent);
    }
    this.#generations.set(key, records);
    return { ok: true, value: { created: true } };
  }

  async upsert(
    spaceId: SpaceId,
    generationId: GenerationId,
    records: readonly VectorRecord[],
    options: ExecutionOptions = {}
  ): Promise<VectorIndexResult<{ readonly upserted: number }>> {
    if (options.signal?.aborted === true) return this.#failure('cancelled', 'Vector upsert was cancelled.');
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    if (generation === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Vector generation was not found.');
    }
    if (records.some((record) =>
      record.vector.length !== this.capabilities.dimension ||
      record.vector.some((value) => !Number.isFinite(value))
    )) {
      return this.#failure('dimension-mismatch', 'Vector dimension or numeric value is invalid.');
    }
    for (const record of records) generation.set(record.unitId, structuredClone(record));
    return { ok: true, value: { upserted: records.length } };
  }

  async delete(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitIds: readonly ContentUnitId[]
  ): Promise<VectorIndexResult<{ readonly deleted: readonly ContentUnitId[] }>> {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    if (generation === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Vector generation was not found.');
    }
    const deleted = unitIds.filter((unitId) => generation.delete(unitId));
    return { ok: true, value: { deleted } };
  }

  async reuse(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitId: ContentUnitId,
    nextUnitVersionId: VectorRecord['unitVersionId'],
    metadata: VectorRecord['metadata']
  ): Promise<VectorIndexResult<{ readonly reused: true }>> {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    const current = generation?.get(unitId);
    if (current === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Reusable vector record was not found.');
    }
    generation?.set(unitId, {
      ...current,
      unitVersionId: nextUnitVersionId,
      metadata: structuredClone(metadata)
    });
    return { ok: true, value: { reused: true } };
  }

  async count(spaceId: SpaceId, generationId: GenerationId): Promise<VectorIndexResult<number>> {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    return generation === undefined || this.#closed
      ? this.#failure('generation-not-found', 'Vector generation was not found.')
      : { ok: true, value: generation.size };
  }

  async manifest(spaceId: SpaceId, generationId: GenerationId) {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    return generation === undefined || this.#closed
      ? this.#failure('generation-not-found', 'Vector generation was not found.')
      : {
          ok: true as const,
          value: Array.from(generation.values())
            .map((record) => record.unitVersionId)
            .sort((left, right) => left.localeCompare(right, 'en'))
        };
  }

  async query(
    spaceId: SpaceId,
    generationId: GenerationId,
    vector: readonly number[],
    topK: number,
    options: VectorQueryOptions = {}
  ): Promise<VectorIndexResult<readonly VectorCandidate[]>> {
    this.queryCalls += 1;
    if (options.signal?.aborted === true) return this.#failure('cancelled', 'Vector query was cancelled.');
    if (vector.length !== this.capabilities.dimension) {
      return this.#failure('dimension-mismatch', 'Query vector dimension is invalid.');
    }
    if (!Number.isSafeInteger(topK) || topK < 1) {
      return this.#failure('index-failure', 'topK must be a positive safe integer.');
    }
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    if (generation === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Vector generation was not found.');
    }
    const ordered = Array.from(generation.values())
      .filter((record) => options.filter === undefined || matchesFilterExpression(
        options.filter.compiled.expression,
        record.metadata,
        options.filter.schema
      ))
      .map((record) => ({ record, score: cosine(vector, record.vector) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.record.unitId.localeCompare(right.record.unitId, 'en')
      )
      .slice(0, topK);
    return {
      ok: true,
      value: ordered.map(({ record, score }, index) => ({
        unitId: record.unitId,
        unitVersionId: record.unitVersionId,
        score,
        rank: index + 1,
        metadata: structuredClone(record.metadata)
      }))
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #failure<C extends 'generation-not-found' | 'dimension-mismatch' | 'cancelled' | 'index-failure'>(
    code: C,
    summary: string
  ): Extract<VectorIndexResult<never>, { ok: false }> {
    return { ok: false, code, summary, retryable: false };
  }
}
