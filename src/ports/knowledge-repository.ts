import type { ExpectedState } from '../application/commands.js';
import type { Page, PageRequest } from '../application/queries.js';
import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { LifecycleEvent, OutboxRecord } from '../domain/events.js';
import type { ContentUnitVersion } from '../domain/content-unit.js';
import type { DeltaPlan } from '../domain/delta-plan.js';
import type {
  DeleteReceipt,
  GenerationValidationReceipt,
  IndexGeneration
} from '../domain/index-generation.js';
import type { ProcessingRun } from '../domain/processing.js';
import type {
  ActivationId,
  OperationId,
  RevisionId,
  RunId,
  SourceId,
  SpaceId
} from '../domain/ids.js';
import type { KnowledgeSpace, PolicySnapshot } from '../domain/knowledge-space.js';
import type { ImportBatch, Source } from '../domain/source.js';
import type { EventTraceContext } from '../domain/trace.js';
import type {
  KnowledgeActivation,
  ProcessingRecipeVersion,
  RevisionDecision,
  RevisionLabel,
  RevisionState,
  RevisionView,
  SourceRevision
} from '../domain/versions.js';

export interface RepositoryFailure {
  readonly code:
    | 'not-found'
    | 'state-conflict'
    | 'idempotency-conflict'
    | 'integrity-check-failed'
    | 'stale-run-attempt'
    | 'adapter-failure';
  readonly summary: string;
  readonly retryable: boolean;
}

export interface RepositoryOperationRecord {
  readonly spaceId: SpaceId;
  readonly operationId: OperationId;
  readonly idempotencyKey: string;
  readonly commandDigest: DigestRef;
  readonly outcome: JsonValue;
  readonly traceContext?: EventTraceContext;
  readonly committedAt: Rfc3339Utc;
}

export interface RepositoryWriteSet {
  readonly space?: KnowledgeSpace;
  readonly policy?: PolicySnapshot;
  readonly source?: Source;
  readonly importBatch?: ImportBatch;
  readonly revision?: SourceRevision;
  readonly revisionState?: RevisionState;
  readonly revisionStates?: readonly RevisionState[];
  readonly label?: RevisionLabel;
  readonly decision?: RevisionDecision;
  readonly recipe?: ProcessingRecipeVersion;
  readonly contentUnits?: readonly ContentUnitVersion[];
  readonly deltaPlan?: DeltaPlan;
  readonly processingRun?: ProcessingRun;
  readonly generations?: readonly IndexGeneration[];
  readonly generationReceipt?: GenerationValidationReceipt;
  readonly deleteReceipts?: readonly DeleteReceipt[];
  readonly activation?: KnowledgeActivation;
  readonly events: readonly LifecycleEvent[];
}

export interface RepositoryCommitRequest {
  readonly spaceId: SpaceId;
  readonly intent?: 'domain' | 'import-staging';
  readonly expected: ExpectedState;
  readonly operation: RepositoryOperationRecord;
  readonly writes: RepositoryWriteSet;
}

export type RepositoryCommitResult =
  | {
      readonly ok: true;
      readonly kind: 'committed' | 'replayed';
      readonly operation: RepositoryOperationRecord;
      readonly events: readonly LifecycleEvent[];
    }
  | { readonly ok: false; readonly error: RepositoryFailure };

export interface RunClaim {
  readonly schemaVersion: '1.0';
  readonly spaceId: SpaceId;
  readonly runId: RunId;
  readonly workerId: string;
  readonly attempt: number;
  readonly fencingToken: number;
  readonly claimedAt: Rfc3339Utc;
  readonly leaseUntil: Rfc3339Utc;
}

export interface AcquireRunClaimRequest {
  readonly spaceId: SpaceId;
  readonly runId: RunId;
  readonly workerId: string;
  readonly now: Rfc3339Utc;
  readonly leaseUntil: Rfc3339Utc;
}

export type AcquireRunClaimResult =
  | { readonly ok: true; readonly value: RunClaim }
  | { readonly ok: false; readonly error: RepositoryFailure; readonly current: RunClaim | null };

export interface SideEffectReceipt {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly state: 'not-started' | 'committed' | 'external-commit-unknown';
  readonly digest: DigestRef | null;
}

export interface RunCheckpoint {
  readonly schemaVersion: '1.0';
  readonly spaceId: SpaceId;
  readonly runId: RunId;
  readonly stage: string;
  readonly attempt: number;
  readonly fencingToken: number;
  readonly inputRefs: JsonValue;
  readonly componentVersions: JsonValue;
  readonly sideEffects: readonly SideEffectReceipt[];
  readonly nextStep: string;
  readonly savedAt: Rfc3339Utc;
}

export type FencedWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RepositoryFailure };

export interface KnowledgeRepositoryDescriptor {
  readonly kind: 'knowledge-repository';
  readonly adapterId: string;
  readonly name: string;
  readonly version: string;
  readonly testingOnly: boolean;
}

export interface KnowledgeRepositoryCapabilities {
  readonly atomicCommit: boolean;
  readonly expectedStateCas: boolean;
  readonly idempotencyRecords: boolean;
  readonly stablePagination: boolean;
  readonly outbox: boolean;
  readonly runClaimFencing: boolean;
  readonly atomicQuerySnapshot: boolean;
  readonly spaceIsolation: 'physical' | 'logical-verified' | 'none';
}

export interface KnowledgeRepository {
  readonly descriptor: KnowledgeRepositoryDescriptor;
  readonly capabilities: KnowledgeRepositoryCapabilities;
  commit(request: RepositoryCommitRequest): Promise<RepositoryCommitResult>;
  getOperation(
    spaceId: SpaceId,
    idempotencyKey: string
  ): Promise<RepositoryOperationRecord | null>;
  getSpace(spaceId: SpaceId): Promise<KnowledgeSpace | null>;
  getPolicy(spaceId: SpaceId, policyId: string): Promise<PolicySnapshot | null>;
  listPolicies(spaceId: SpaceId, page: PageRequest): Promise<Page<PolicySnapshot>>;
  getSource(spaceId: SpaceId, sourceId: SourceId): Promise<Source | null>;
  listSources(spaceId: SpaceId, page: PageRequest): Promise<Page<Source>>;
  getImportBatch(spaceId: SpaceId, importBatchId: string): Promise<ImportBatch | null>;
  listImportBatches(spaceId: SpaceId, page: PageRequest): Promise<Page<ImportBatch>>;
  getRevision(
    spaceId: SpaceId,
    revisionId: RevisionId
  ): Promise<RevisionView | null>;
  getRevisionAt(
    spaceId: SpaceId,
    revisionId: RevisionId,
    at: Rfc3339Utc
  ): Promise<RevisionView | null>;
  listRevisions(
    spaceId: SpaceId,
    sourceId: SourceId,
    page: PageRequest
  ): Promise<Page<RevisionView>>;
  getRevisionByLabel(
    spaceId: SpaceId,
    sourceId: SourceId,
    label: string
  ): Promise<RevisionView | null>;
  getRevisionLabel(
    spaceId: SpaceId,
    sourceId: SourceId,
    label: string
  ): Promise<RevisionLabel | null>;
  getDecision(
    spaceId: SpaceId,
    revisionId: RevisionId
  ): Promise<RevisionDecision | null>;
  listDecisions(
    spaceId: SpaceId,
    revisionId: RevisionId,
    page: PageRequest
  ): Promise<Page<RevisionDecision>>;
  getCurrentRecipe(spaceId: SpaceId): Promise<ProcessingRecipeVersion | null>;
  getRecipe(spaceId: SpaceId, recipeId: string): Promise<ProcessingRecipeVersion | null>;
  listRecipes(
    spaceId: SpaceId,
    page: PageRequest
  ): Promise<Page<ProcessingRecipeVersion>>;
  getContentUnitVersion(
    spaceId: SpaceId,
    unitVersionId: string
  ): Promise<ContentUnitVersion | null>;
  listContentUnitsForRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
    page: PageRequest
  ): Promise<Page<ContentUnitVersion>>;
  getDeltaPlan(spaceId: SpaceId, deltaPlanId: string): Promise<DeltaPlan | null>;
  getRun(spaceId: SpaceId, runId: RunId): Promise<ProcessingRun | null>;
  listRuns(spaceId: SpaceId, page: PageRequest): Promise<Page<ProcessingRun>>;
  getGeneration(
    spaceId: SpaceId,
    generationId: string
  ): Promise<IndexGeneration | null>;
  listGenerations(spaceId: SpaceId, page: PageRequest): Promise<Page<IndexGeneration>>;
  getGenerationReceipt(
    spaceId: SpaceId,
    generationId: string
  ): Promise<GenerationValidationReceipt | null>;
  getQuerySnapshot(spaceId: SpaceId): Promise<import('../domain/activation.js').QuerySnapshot | null>;
  listDeleteReceipts(
    spaceId: SpaceId,
    generationId: string
  ): Promise<readonly DeleteReceipt[]>;
  getActiveActivation(spaceId: SpaceId): Promise<KnowledgeActivation | null>;
  getActivation(
    spaceId: SpaceId,
    activationId: ActivationId
  ): Promise<KnowledgeActivation | null>;
  listActivations(
    spaceId: SpaceId,
    page: PageRequest
  ): Promise<Page<KnowledgeActivation>>;
  listEvents(
    spaceId: SpaceId,
    page: PageRequest,
    aggregateId?: string
  ): Promise<Page<LifecycleEvent>>;
  listOutbox(spaceId: SpaceId, page: PageRequest): Promise<Page<OutboxRecord>>;
  markOutboxDelivered(
    spaceId: SpaceId,
    eventIds: readonly string[],
    deliveredAt: Rfc3339Utc
  ): Promise<void>;
  acquireRunClaim(request: AcquireRunClaimRequest): Promise<AcquireRunClaimResult>;
  getRunClaim(spaceId: SpaceId, runId: RunId): Promise<RunClaim | null>;
  saveCheckpoint(checkpoint: RunCheckpoint): Promise<FencedWriteResult>;
  getCheckpoint(spaceId: SpaceId, runId: RunId): Promise<RunCheckpoint | null>;
  close(): Promise<void>;
}
