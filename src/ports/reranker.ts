import type { ExecutionOptions } from '../application/commands.js';
import type { ModelDataBoundary } from '../domain/security.js';
import type { ContentUnitId, ContentUnitVersionId } from '../domain/ids.js';

export interface RerankCandidate {
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly content: string;
  readonly originalRank: number;
}

export interface RerankedCandidate {
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly score: number;
  readonly rank: number;
}

export type RerankerResult =
  | { readonly ok: true; readonly candidates: readonly RerankedCandidate[]; readonly usage: { readonly candidates: number; readonly utf8Bytes: number } }
  | { readonly ok: false; readonly code: 'input-too-large' | 'cancelled' | 'model-failure'; readonly summary: string; readonly retryable: boolean };

export interface Reranker {
  readonly descriptor: {
    readonly kind: 'reranker';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
    readonly dataBoundary: ModelDataBoundary;
  };
  readonly capabilities: {
    readonly model: string;
    readonly maxCandidates: number;
    readonly maxInputUtf8Bytes: number;
    readonly deterministic: boolean;
    readonly stableOrder: boolean;
  };
  rerank(query: string, candidates: readonly RerankCandidate[], options?: ExecutionOptions): Promise<RerankerResult>;
  close(): Promise<void>;
}
