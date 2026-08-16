import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ActivationId,
  ContentUnitId,
  ContentUnitVersionId,
  GenerationId,
  PolicyId,
  QueryPlanId,
  ResultId,
  RevisionId,
  SourceId,
  SpaceId
} from './ids.js';
import type { CompiledFilter, FilterExpression } from './filter.js';
import type { SecurityHookRecord, DataEgressDecision } from './security.js';
import type { Citation } from './citation.js';
import type { ContextPack } from './context-pack.js';
import type { Diagnostic } from './diagnostics.js';
import type { ResultProvenance } from './provenance.js';

export type RetrievalRoute = 'semantic' | 'keyword' | 'hybrid';

export interface AccessContext {
  readonly fingerprint: DigestRef;
  readonly allowedLabels: readonly string[];
  readonly deniedLabels: readonly string[];
  readonly attributes: JsonValue;
}

export interface ContextBudget {
  readonly maxEvidence: number;
  readonly maxUtf8Bytes: number;
  readonly maxTokens: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = Object.freeze({
  maxEvidence: 50,
  maxUtf8Bytes: 256 * 1024,
  maxTokens: 8_192
});

export interface KnowledgeQueryRequest {
  readonly spaceId: SpaceId;
  readonly query: string;
  readonly mode: 'retrieve' | 'context' | 'generate';
  readonly access: AccessContext;
  readonly filter?: FilterExpression;
  readonly route?: RetrievalRoute;
  readonly topK?: number;
  readonly candidateLimit?: number;
  readonly rerank?: boolean;
  readonly allowEnhancementDowngrade?: boolean;
  readonly contextBudget?: Partial<ContextBudget>;
  readonly trustedDirective?: string;
  readonly knownConflicts?: readonly {
    readonly conflictId: string;
    readonly unitIds: readonly ContentUnitId[];
    readonly summary: string;
  }[];
}

export interface QueryPlanSnapshot {
  readonly schemaVersion: '1.0';
  readonly queryPlanId: QueryPlanId;
  readonly spaceId: SpaceId;
  readonly activationId: ActivationId;
  readonly policyId: PolicyId;
  readonly generationId: GenerationId;
  readonly revisions: readonly { readonly sourceId: SourceId; readonly revisionId: RevisionId }[];
  readonly normalizedQuery: string;
  readonly queryDigest: DigestRef;
  readonly accessContextDigest: DigestRef;
  readonly route: RetrievalRoute;
  readonly requestedRoute: RetrievalRoute;
  readonly filter: CompiledFilter;
  readonly topK: number;
  readonly candidateBudget: Readonly<Record<'semantic' | 'keyword', number>>;
  readonly merge: {
    readonly method: 'reciprocal-rank-fusion' | 'single-route-rank';
    readonly rrfK: 60;
    readonly semanticWeight: number;
    readonly keywordWeight: number;
    readonly tieBreak: 'source-priority-then-stable-id';
  };
  readonly reranker: { readonly adapterId: string; readonly version: string; readonly deploymentFingerprint: string } | null;
  readonly contextBudget: ContextBudget;
  readonly adapterRefs: readonly {
    readonly kind: string;
    readonly adapterId: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
  }[];
  readonly securityHooks: readonly SecurityHookRecord[];
  readonly egressDecisions: readonly DataEgressDecision[];
  readonly createdAt: Rfc3339Utc;
  readonly digest: DigestRef;
}

export interface RetrievalCandidate {
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly content: string;
  readonly trust: 'untrusted-retrieved-data';
  readonly finalRank: number;
  readonly score: number;
  readonly routeRanks: {
    readonly semantic: number | null;
    readonly keyword: number | null;
    readonly rerank: number | null;
  };
  readonly rankingExplanation: readonly string[];
  readonly citation: Citation;
}

export interface RetrievalResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly excluded: readonly {
    readonly unitVersionId: ContentUnitVersionId | null;
    readonly reason: string;
  }[];
}

export interface GenerationOutput {
  readonly status: 'completed' | 'failed' | 'blocked';
  readonly text: string | null;
  readonly model: string;
  readonly modelVersion: string;
  readonly finishReason: 'stop' | 'length' | 'refused' | 'invalid' | 'error';
  readonly attempts: readonly {
    readonly attempt: number;
    readonly outcome: string;
    readonly retryDelayMs: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  }[];
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly calls: number;
    readonly estimatedCost: { readonly amount: number; readonly currency: string; readonly precision: 'exact' | 'estimated' } | null;
  };
  readonly providerRequestId: string | null;
  readonly traceId: string;
}

export type KnowledgeResultStatus = 'complete' | 'partial' | 'empty' | 'insufficient-evidence';

export interface KnowledgeResult<M extends 'retrieve' | 'context' | 'generate'> {
  readonly schemaVersion: '1.0';
  readonly resultId: ResultId;
  readonly mode: M;
  readonly status: KnowledgeResultStatus;
  readonly retrieval: RetrievalResult;
  readonly context: M extends 'context' | 'generate' ? ContextPack : null;
  readonly generation: M extends 'generate' ? GenerationOutput : null;
  readonly citations: readonly Citation[];
  readonly guarantees: readonly string[];
  readonly limitations: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly queryPlan: QueryPlanSnapshot;
  readonly provenance: ResultProvenance;
}
