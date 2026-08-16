import type { ExecutionOptions } from '../application/commands.js';
import type { ModelDataBoundary } from '../domain/security.js';
import type { Reranker, RerankerResult } from '../ports/reranker.js';

function terms(value: string): Set<string> {
  return new Set(value.normalize('NFC').toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

export class DeterministicReranker implements Reranker {
  readonly descriptor;
  readonly capabilities;
  calls = 0;
  #closed = false;

  constructor(
    maxCandidates = 200,
    maxInputUtf8Bytes = 2_000_000,
    deploymentFingerprint = 'testing:reranker:default',
    dataBoundary: ModelDataBoundary = {
      deploymentClass: 'local',
      providerProfile: 'lorebit-testing-local',
      region: null,
      trainingUse: 'none',
      retention: 'none',
      attestationRef: 'testing:deterministic-reranker'
    }
  ) {
    this.descriptor = Object.freeze({
      kind: 'reranker' as const,
      adapterId: '@devcodex/lorebit/testing:deterministic-reranker',
      name: 'DeterministicReranker',
      version: '0.1',
      deploymentFingerprint,
      testingOnly: true,
      dataBoundary: Object.freeze({ ...dataBoundary })
    });
    this.capabilities = Object.freeze({
      model: 'lorebit-token-overlap-v1',
      maxCandidates,
      maxInputUtf8Bytes,
      deterministic: true,
      stableOrder: true
    });
  }

  async rerank(query: string, candidates: Parameters<Reranker['rerank']>[1], options: ExecutionOptions = {}): Promise<RerankerResult> {
    this.calls += 1;
    if (this.#closed) return { ok: false, code: 'model-failure', summary: 'Reranker is closed.', retryable: false };
    if (options.signal?.aborted === true) return { ok: false, code: 'cancelled', summary: 'Reranking was cancelled.', retryable: false };
    if (candidates.length > this.capabilities.maxCandidates) return { ok: false, code: 'input-too-large', summary: 'Reranker candidate limit exceeded.', retryable: false };
    const utf8Bytes = new TextEncoder().encode(query + candidates.map((candidate) => candidate.content).join('')).byteLength;
    if (utf8Bytes > this.capabilities.maxInputUtf8Bytes) return { ok: false, code: 'input-too-large', summary: 'Reranker input byte limit exceeded.', retryable: false };
    const queryTerms = terms(query);
    const ordered = candidates.map((candidate) => {
      const candidateTerms = terms(candidate.content);
      const overlap = Array.from(queryTerms).filter((term) => candidateTerms.has(term)).length;
      return { candidate, score: queryTerms.size === 0 ? 0 : overlap / queryTerms.size };
    }).sort((left, right) =>
      right.score - left.score ||
      left.candidate.originalRank - right.candidate.originalRank ||
      left.candidate.unitId.localeCompare(right.candidate.unitId, 'en'));
    return {
      ok: true,
      candidates: ordered.map(({ candidate, score }, index) => ({
        unitId: candidate.unitId,
        unitVersionId: candidate.unitVersionId,
        score,
        rank: index + 1
      })),
      usage: { candidates: candidates.length, utf8Bytes }
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
