import type { ExecutionOptions } from '../application/commands.js';
import type { ContentUnitId, GenerationId, SpaceId } from '../domain/ids.js';
import type {
  KeywordCandidate,
  KeywordIndex,
  KeywordIndexResult,
  KeywordRecord,
  KeywordQueryOptions
} from '../ports/keyword-index.js';
import { matchesFilterExpression } from '../domain/filter.js';

function generationKey(spaceId: SpaceId, generationId: GenerationId): string {
  return `${spaceId}\u0000${generationId}`;
}

function terms(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

export class InMemoryKeywordIndex implements KeywordIndex {
  readonly descriptor;
  readonly capabilities = Object.freeze({
    namespaceIsolation: 'logical-verified' as const,
    generationIsolation: true,
    deleteGuarantee: 'verified' as const,
    stableOrder: true
    ,filter: {
      pushdown: 'full' as const,
      predicates: ['eq', 'neq', 'in', 'exists', 'lt', 'lte', 'gt', 'gte'] as const,
      booleanOperators: ['and', 'or', 'not'] as const,
      nullSemantics: 'lorebit-v1' as const
    }
  });
  readonly #generations = new Map<string, Map<string, KeywordRecord>>();
  queryCalls = 0;
  #closed = false;

  constructor(deploymentFingerprint = 'testing:keyword:default') {
    this.descriptor = Object.freeze({
      kind: 'keyword-index' as const,
      adapterId: '@devcodex/lorebit/testing:in-memory-keyword-index',
      name: 'InMemoryKeywordIndex',
      version: '0.1',
      deploymentFingerprint,
      testingOnly: true
    });
  }

  async createGeneration(
    spaceId: SpaceId,
    generationId: GenerationId,
    parentGenerationId: GenerationId | null
  ): Promise<KeywordIndexResult<{ readonly created: true }>> {
    if (this.#closed) return this.#failure('index-failure', 'Keyword index is closed.');
    const key = generationKey(spaceId, generationId);
    if (this.#generations.has(key)) return { ok: true, value: { created: true } };
    let records = new Map<string, KeywordRecord>();
    if (parentGenerationId !== null) {
      const parent = this.#generations.get(generationKey(spaceId, parentGenerationId));
      if (parent === undefined) {
        return this.#failure('generation-not-found', 'Parent keyword generation was not found.');
      }
      records = structuredClone(parent);
    }
    this.#generations.set(key, records);
    return { ok: true, value: { created: true } };
  }

  async upsert(
    spaceId: SpaceId,
    generationId: GenerationId,
    records: readonly KeywordRecord[],
    options: ExecutionOptions = {}
  ): Promise<KeywordIndexResult<{ readonly upserted: number }>> {
    if (options.signal?.aborted === true) return this.#failure('cancelled', 'Keyword upsert was cancelled.');
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    if (generation === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Keyword generation was not found.');
    }
    for (const record of records) generation.set(record.unitId, structuredClone(record));
    return { ok: true, value: { upserted: records.length } };
  }

  async delete(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitIds: readonly ContentUnitId[]
  ): Promise<KeywordIndexResult<{ readonly deleted: readonly ContentUnitId[] }>> {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    if (generation === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Keyword generation was not found.');
    }
    const deleted = unitIds.filter((unitId) => generation.delete(unitId));
    return { ok: true, value: { deleted } };
  }

  async reuse(
    spaceId: SpaceId,
    generationId: GenerationId,
    unitId: ContentUnitId,
    nextUnitVersionId: KeywordRecord['unitVersionId'],
    metadata: KeywordRecord['metadata']
  ): Promise<KeywordIndexResult<{ readonly reused: true }>> {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    const current = generation?.get(unitId);
    if (current === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Reusable keyword record was not found.');
    }
    generation?.set(unitId, {
      ...current,
      unitVersionId: nextUnitVersionId,
      metadata: structuredClone(metadata)
    });
    return { ok: true, value: { reused: true } };
  }

  async count(spaceId: SpaceId, generationId: GenerationId): Promise<KeywordIndexResult<number>> {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    return generation === undefined || this.#closed
      ? this.#failure('generation-not-found', 'Keyword generation was not found.')
      : { ok: true, value: generation.size };
  }

  async manifest(spaceId: SpaceId, generationId: GenerationId) {
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    return generation === undefined || this.#closed
      ? this.#failure('generation-not-found', 'Keyword generation was not found.')
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
    query: string,
    topK: number,
    options: KeywordQueryOptions = {}
  ): Promise<KeywordIndexResult<readonly KeywordCandidate[]>> {
    this.queryCalls += 1;
    if (options.signal?.aborted === true) return this.#failure('cancelled', 'Keyword query was cancelled.');
    if (!Number.isSafeInteger(topK) || topK < 1) {
      return this.#failure('index-failure', 'topK must be a positive safe integer.');
    }
    const generation = this.#generations.get(generationKey(spaceId, generationId));
    if (generation === undefined || this.#closed) {
      return this.#failure('generation-not-found', 'Keyword generation was not found.');
    }
    const queryTerms = terms(query);
    const ordered = Array.from(generation.values())
      .filter((record) => options.filter === undefined || matchesFilterExpression(
        options.filter.compiled.expression,
        record.metadata,
        options.filter.schema
      ))
      .map((record) => {
        const recordTerms = terms(record.text);
        const matches = Array.from(queryTerms).filter((term) => recordTerms.has(term)).length;
        return { record, score: queryTerms.size === 0 ? 0 : matches / queryTerms.size };
      })
      .filter(({ score }) => score > 0)
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

  #failure<C extends 'generation-not-found' | 'cancelled' | 'index-failure'>(
    code: C,
    summary: string
  ): Extract<KeywordIndexResult<never>, { ok: false }> {
    return { ok: false, code, summary, retryable: false };
  }
}
