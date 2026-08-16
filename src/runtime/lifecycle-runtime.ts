import type {
  DurableCommandEnvelope,
  ExecutionOptions,
  LifecycleCommandPayload,
  LorebitCommandPayload,
  ProcessingCommandPayload
} from '../application/commands.js';
import type { PageRequest, RevisionQuery } from '../application/queries.js';
import {
  LifecycleService,
  type LifecycleMutation
} from '../application/services/lifecycle-service.js';
import { lorebitFailure, type LorebitFailureCode } from '../domain/diagnostics.js';
import { RecoveryService, type GenerationAuditResult } from '../application/services/recovery-service.js';
import { TransferService } from '../application/services/transfer-service.js';
import type { RunClaim, RunCheckpoint } from '../ports/knowledge-repository.js';
import type { GenerationId, IdGenerator, RevisionId, RunId, SourceId, SpaceId } from '../domain/ids.js';
import { failed, successful, type LorebitOutcome, type OperationRef } from '../domain/outcomes.js';
import type { KnowledgeSpace, SpaceReadiness } from '../domain/knowledge-space.js';
import type { ImportBatch, Source } from '../domain/source.js';
import type { RevisionDecision, RevisionView } from '../domain/versions.js';
import type { Page, ResolveRevisionResult, VersionDifference } from '../application/queries.js';
import type { LifecycleEvent } from '../domain/events.js';
import type { DeltaPlan } from '../domain/delta-plan.js';
import type { GenerationValidationReceipt, IndexGeneration } from '../domain/index-generation.js';
import type { ProcessingRun } from '../domain/processing.js';
import { IngestRuntime, type IngestMutation } from './ingest-runtime.js';
import { MaintenanceRuntime, type MaintenanceMutation } from './maintenance-runtime.js';
import type { QuerySnapshot } from '../domain/activation.js';
import type { KnowledgeQueryRequest, KnowledgeResult } from '../domain/query-plan.js';
import { QueryRuntime } from './query-runtime.js';
import type { ImpactChangeKind, ImpactReport, RebuildPlan } from '../domain/impact.js';
import type { RecoveryExecutionReceipt, RecoveryPlan } from '../domain/recovery.js';
import type { ExportPackage, ExportPlan, ImportPlan, ImportReceipt, MigrationPlan, MigrationReceipt } from '../domain/transfer.js';
import type { EvaluationComparison, EvaluationFeedback, EvaluationRun, QualityGate, QualityGateResult } from '../domain/evaluation.js';
import type { EvaluationModule, EvaluationRunInput } from '../modules/evaluation.js';
import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import { ResourceScheduler, type ScheduledOperationKind } from '../application/services/resource-scheduler.js';
import { bindExecutionTrace } from '../application/execution-observability.js';
import { createTraceContextSnapshot, type TelemetrySpan } from '../domain/trace.js';
import type { TelemetrySink } from '../ports/telemetry.js';
import type { Clock } from '../ports/clock.js';

function estimatedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export type LorebitRuntimeState = 'ready' | 'degraded' | 'draining' | 'closed';

export interface LorebitRuntimeProfile {
  readonly schemaVersion: '1.0';
  readonly runtime: '@devcodex/lorebit';
  readonly contractVersion: '0.1';
  readonly state: LorebitRuntimeState;
  readonly core: 'deterministic-m1' | 'deterministic-m2-processing';
  readonly retrieveContext: 'unavailable' | 'deterministic';
  readonly completeRag: 'unavailable' | 'configured';
  readonly providerClass: 'testing-or-user-supplied-storage';
}

export interface LorebitReadiness {
  readonly state: LorebitRuntimeState;
  readonly operations: {
    readonly lifecycle: boolean;
    readonly durableReplay: boolean;
    readonly processing: boolean;
    readonly index: boolean;
    readonly activation: boolean;
    readonly retrieve: boolean;
    readonly context: boolean;
    readonly generate: boolean;
  };
  readonly guarantees: readonly string[];
  readonly limitations: readonly string[];
}

export interface CloseOptions {
  readonly deadline?: AbortSignal;
}

export interface CloseReceipt {
  readonly state: 'closed';
  readonly closedResources: readonly string[];
  readonly diagnostics: readonly string[];
}

interface LifecycleRuntimeDependencies {
  readonly service: LifecycleService;
  readonly ids: IdGenerator;
  readonly ingest?: IngestRuntime;
  readonly maintenance?: MaintenanceRuntime;
  readonly query?: QueryRuntime;
  readonly scheduler: ResourceScheduler;
  readonly telemetry: TelemetrySink;
  readonly clock: Clock;
  readonly random: { next(): number; hex(bytes: number): string };
  readonly recovery?: RecoveryService;
  readonly transfer?: TransferService;
  readonly evaluation?: EvaluationModule;
  readonly closeResources: readonly {
    readonly name: string;
    close(): Promise<void>;
  }[];
}

export class LifecycleRuntime {
  readonly #service: LifecycleService;
  readonly #ids: IdGenerator;
  readonly #ingest: IngestRuntime | undefined;
  readonly #maintenance: MaintenanceRuntime | undefined;
  readonly #query: QueryRuntime | undefined;
  readonly #scheduler: ResourceScheduler;
  readonly #telemetry: TelemetrySink;
  readonly #clock: Clock;
  readonly #random: LifecycleRuntimeDependencies['random'];
  readonly #recovery: RecoveryService | undefined;
  readonly #transfer: TransferService | undefined;
  readonly #evaluation: EvaluationModule | undefined;
  readonly #closeResources: LifecycleRuntimeDependencies['closeResources'];
  #state: LorebitRuntimeState = 'ready';
  #queryUnsafe = false;
  #inFlight = 0;
  #idleWaiters: Array<() => void> = [];
  #closePromise: Promise<CloseReceipt> | null = null;

  constructor(dependencies: LifecycleRuntimeDependencies) {
    this.#service = dependencies.service;
    this.#ids = dependencies.ids;
    this.#ingest = dependencies.ingest;
    this.#maintenance = dependencies.maintenance;
    this.#query = dependencies.query;
    this.#scheduler = dependencies.scheduler;
    this.#telemetry = dependencies.telemetry;
    this.#clock = dependencies.clock;
    this.#random = dependencies.random;
    this.#recovery = dependencies.recovery;
    this.#transfer = dependencies.transfer;
    this.#evaluation = dependencies.evaluation;
    this.#closeResources = dependencies.closeResources;
  }

  profile(): LorebitRuntimeProfile {
    return {
      schemaVersion: '1.0',
      runtime: '@devcodex/lorebit',
      contractVersion: '0.1',
      state: this.#state,
      core: this.#ingest === undefined ? 'deterministic-m1' : 'deterministic-m2-processing',
      retrieveContext: this.#query === undefined ? 'unavailable' : 'deterministic',
      completeRag: this.#query?.canGenerate() === true ? 'configured' : 'unavailable',
      providerClass: 'testing-or-user-supplied-storage'
    };
  }

  readiness(): LorebitReadiness {
    const acceptsOperations = this.#state === 'ready' || this.#state === 'degraded';
    return {
      state: this.#state,
      operations: {
        lifecycle: acceptsOperations,
        durableReplay: acceptsOperations,
        processing: acceptsOperations && this.#ingest !== undefined,
        index: acceptsOperations && this.#maintenance !== undefined,
        activation: acceptsOperations && this.#maintenance !== undefined,
        retrieve: acceptsOperations && this.#query !== undefined && !this.#queryUnsafe,
        context: acceptsOperations && this.#query !== undefined && !this.#queryUnsafe,
        generate: acceptsOperations && this.#query?.canGenerate() === true && !this.#queryUnsafe
      },
      guarantees: [
        'space-isolation',
        'immutable-revision-history',
        'expected-predecessor-cas',
        'idempotent-command-replay',
        'append-only-events-and-outbox',
        'run-claim-fencing',
        ...(this.#query === undefined ? [] : [
          'active-query-snapshot',
          'pre-retrieval-filter-fail-closed',
          'citation-double-validation',
          'trusted-directive-untrusted-evidence-partition',
          'bounded-runtime-resources',
          ...(this.#query.canGenerate() ? [
            'generation-input-provenance',
            'generation-fallback-preserves-context'
          ] : [])
        ])
      ],
      limitations: this.#ingest === undefined
        ? [
            ...(this.#state === 'degraded' ? ['runtime degraded by adapter receipt or integrity evidence'] : []),
            'B1 deterministic M1 candidate only',
            'no processing, index, retrieval, context or generation capability',
            'no production provider profile has been verified'
          ]
        : this.#query === undefined ? [
            ...(this.#state === 'degraded' ? ['runtime degraded by adapter receipt or integrity evidence'] : []),
            'B2 processing and shadow-index deterministic substrate only',
            'no retrieval, context or LLM generation capability',
            'no production provider profile has been verified'
          ] : this.#query.canGenerate() ? [
            ...(this.#state === 'degraded' ? ['runtime degraded by adapter receipt or integrity evidence'] : []),
            'B4 complete RAG profile is configured with a caller-supplied LanguageModel',
            'generation provenance does not prove claim correctness',
            'no production provider profile has been verified'
          ] : [
            ...(this.#state === 'degraded' ? ['runtime degraded by adapter receipt or integrity evidence'] : []),
            'B4 deterministic retrieve/context profile with impact, recovery and resource governance',
            'no LanguageModel generation or production provider profile has been verified'
          ]
    };
  }

  retrieve(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'retrieve'>>> {
    return this.#run(undefined, () => this.#query === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Query adapters are not configured.'),
          { operationId: 'operation_query-unavailable' as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#queryUnsafe
        ? Promise.resolve(failed(
            lorebitFailure('maintenance-required', 'Query integrity is degraded; validate and activate a repaired generation before querying.'),
            this.#operation('query')
          ))
        : this.#query.retrieve(request, options).then((result) => {
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#state = 'degraded';
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#queryUnsafe = true;
          return result;
        }));
  }

  buildContext(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'context'>>> {
    return this.#run(undefined, () => this.#query === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Context adapters are not configured.'),
          { operationId: 'operation_context-unavailable' as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#queryUnsafe
        ? Promise.resolve(failed(
            lorebitFailure('maintenance-required', 'Query integrity is degraded; validate and activate a repaired generation before querying.'),
            this.#operation('query')
          ))
        : this.#query.buildContext(request, options).then((result) => {
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#state = 'degraded';
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#queryUnsafe = true;
          return result;
        }));
  }

  generate(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'generate'>>> {
    return this.#run(undefined, () => this.#query === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Query adapters are not configured.'),
          this.#operation('query')
        ))
      : this.#queryUnsafe
        ? Promise.resolve(failed(
            lorebitFailure('maintenance-required', 'Query integrity is degraded; validate and activate a repaired generation before querying.'),
            this.#operation('query')
          ))
        : this.#query.generate(request, options).then((result) => {
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#state = 'degraded';
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#queryUnsafe = true;
          return result;
        }));
  }

  query(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'retrieve'> | KnowledgeResult<'context'> | KnowledgeResult<'generate'>>> {
    return this.#run(undefined, () => this.#query === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Query adapters are not configured.'),
          { operationId: 'operation_query-unavailable' as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#queryUnsafe
        ? Promise.resolve(failed(
            lorebitFailure('maintenance-required', 'Query integrity is degraded; validate and activate a repaired generation before querying.'),
            this.#operation('query')
          ))
        : this.#query.query(request, options).then((result) => {
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#state = 'degraded';
          if (!result.ok && ['receipt-stale', 'generation-stale', 'integrity-check-failed', 'filter-not-enforceable'].includes(result.error.code)) this.#queryUnsafe = true;
          return result;
        }));
  }

  auditGeneration(spaceId: SpaceId, generationId: GenerationId, options?: ExecutionOptions): Promise<LorebitOutcome<GenerationAuditResult>> {
    return this.#scheduledModule(
      'rebuild',
      spaceId,
      estimatedUtf8Bytes({ spaceId, generationId }),
      options,
      this.#recovery,
      'Recovery and integrity auditing require processing adapters.',
      'integrity-check-failed',
      async (service, effectiveOptions) => {
        const result = await service.auditGeneration(spaceId, generationId, effectiveOptions);
        if (result.status === 'failed') {
          this.#state = 'degraded';
          this.#queryUnsafe = true;
        }
        return result;
      }
    );
  }

  getImpact(
    spaceId: SpaceId,
    changeKind: ImpactChangeKind,
    changeRef: string,
    failedProbes: readonly string[] = []
  ): Promise<LorebitOutcome<ImpactReport>> {
    return this.#module(this.#recovery, 'Impact analysis requires processing adapters.', 'integrity-check-failed', (service) => service.planImpact(spaceId, changeKind, changeRef, failedProbes));
  }

  planRebuild(impact: ImpactReport): Promise<LorebitOutcome<RebuildPlan>> {
    return this.#module(this.#recovery, 'Rebuild planning requires processing adapters.', 'integrity-check-failed', (service) => service.planRebuild(impact));
  }

  getRecoveryPlan(
    spaceId: SpaceId,
    failureCode: LorebitFailureCode,
    impact: ImpactReport | null = null
  ): Promise<LorebitOutcome<RecoveryPlan>> {
    return this.#module(this.#recovery, 'Recovery planning requires processing adapters.', 'integrity-check-failed', (service) => service.planRecovery(spaceId, failureCode, impact));
  }

  executeRecovery(plan: RecoveryPlan, options?: ExecutionOptions): Promise<LorebitOutcome<RecoveryExecutionReceipt>> {
    return this.#scheduledModule('rebuild', plan.spaceId, estimatedUtf8Bytes(plan), options, this.#recovery, 'Recovery execution requires processing adapters.', 'integrity-check-failed', (service, effectiveOptions) => service.executeRecovery(plan, effectiveOptions));
  }

  planExport(spaceId: SpaceId, options: {
    readonly mode?: 'full' | 'incremental';
    readonly includeContent?: boolean;
    readonly includeDerived?: boolean;
    readonly includeEvents?: boolean;
    readonly includeProvenance?: boolean;
    readonly baseManifestDigest?: DigestRef | null;
    readonly watermark?: string | null;
    readonly dataClassification?: 'public' | 'internal' | 'restricted';
  } = {}): Promise<LorebitOutcome<ExportPlan>> {
    return this.#module(this.#transfer, 'Import/export module is not configured.', 'migration-failure', (service) => service.planExport(spaceId, options));
  }

  executeExport(plan: ExportPlan, options?: ExecutionOptions): Promise<LorebitOutcome<ExportPackage>> {
    return this.#scheduledModule('import', plan.spaceId, plan.estimatedUtf8Bytes, options, this.#transfer, 'Import/export module is not configured.', 'migration-failure', (service, effectiveOptions) => service.executeExport(plan, effectiveOptions));
  }

  planImport(value: ExportPackage, targetSpaceId: SpaceId, options: {
    readonly conflictPolicy?: 'reject' | 'remap' | 'quarantine';
    readonly dryRun?: boolean;
    readonly idMappings?: Readonly<Record<string, string>>;
  } = {}): Promise<LorebitOutcome<ImportPlan>> {
    return this.#module(this.#transfer, 'Import/export module is not configured.', 'migration-failure', (service) => service.planImport(value, targetSpaceId, options));
  }

  executeImport(plan: ImportPlan, value: ExportPackage, options?: ExecutionOptions): Promise<LorebitOutcome<ImportReceipt>> {
    return this.#scheduledModule('import', plan.targetSpaceId, estimatedUtf8Bytes(value.payload), options, this.#transfer, 'Import/export module is not configured.', 'migration-failure', (service, effectiveOptions) => service.executeImport(plan, value, effectiveOptions));
  }

  planMigration(sourceSchema: string, targetSchema: string, input: JsonValue, options: {
    readonly dryRun?: boolean;
    readonly requiresMaintenance?: boolean;
  } = {}): Promise<LorebitOutcome<MigrationPlan>> {
    return this.#module(this.#transfer, 'Import/export module is not configured.', 'migration-failure', (service) => service.planMigration(sourceSchema, targetSchema, input, options));
  }

  executeMigration(plan: MigrationPlan, input: JsonValue, options?: ExecutionOptions): Promise<LorebitOutcome<MigrationReceipt>> {
    return this.#scheduledModule('import', 'migration', estimatedUtf8Bytes(input), options, this.#transfer, 'Import/export module is not configured.', 'migration-failure', (service, effectiveOptions) => service.executeMigration(plan, input, null, effectiveOptions));
  }

  evaluate(input: EvaluationRunInput): Promise<LorebitOutcome<EvaluationRun>> {
    return this.#module(this.#evaluation, 'Evaluation module is not configured.', 'invalid-request', (module) => module.evaluate(input));
  }

  compareEvaluations(baseline: EvaluationRun, candidate: EvaluationRun): Promise<LorebitOutcome<EvaluationComparison>> {
    return this.#module(this.#evaluation, 'Evaluation module is not configured.', 'invalid-request', (module) => module.compare(baseline, candidate));
  }

  applyQualityGate(run: EvaluationRun, gate: QualityGate, comparison?: EvaluationComparison): Promise<LorebitOutcome<QualityGateResult>> {
    return this.#module(this.#evaluation, 'Evaluation module is not configured.', 'invalid-request', (module) => module.applyGate(run, gate, comparison));
  }

  recordEvaluationFeedback(feedback: EvaluationFeedback): Promise<LorebitOutcome<{ readonly recorded: true }>> {
    return this.#module(this.#evaluation, 'Evaluation module is not configured.', 'invalid-request', (module) => {
      module.recordFeedback(feedback);
      return { recorded: true as const };
    });
  }

  listEvaluationFeedback(caseId?: string): Promise<LorebitOutcome<readonly EvaluationFeedback[]>> {
    return this.#module(this.#evaluation, 'Evaluation module is not configured.', 'invalid-request', (module) => module.listFeedback(caseId));
  }

  resourceSnapshot(): ReturnType<ResourceScheduler['snapshot']> {
    return this.#scheduler.snapshot();
  }

  execute<P extends LorebitCommandPayload>(
    envelope: DurableCommandEnvelope<P>,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<LorebitMutation>> {
    return this.#run(envelope.operationId, () => {
      if (envelope.payload.type.startsWith('processing.')) {
        return this.#ingest === undefined
          ? Promise.resolve(failed(
              lorebitFailure('capability-unavailable', 'Processing adapters are not configured.'),
              { operationId: envelope.operationId, kind: 'command' }
            ))
          : this.#ingest.estimateBytes(envelope as DurableCommandEnvelope<Extract<ProcessingCommandPayload, { type: `processing.${string}` }>>).then((estimatedBytes) => this.#scheduled(
              'processing',
              envelope.payload.spaceId,
              estimatedBytes,
              options,
              { operationId: envelope.operationId, kind: 'command' },
              (effectiveOptions) => this.#ingest!.execute(
                envelope as DurableCommandEnvelope<Extract<ProcessingCommandPayload, { type: `processing.${string}` }>>,
                effectiveOptions
              )
            ));
      }
      if (envelope.payload.type.startsWith('generation.')) {
        if (this.#maintenance === undefined) {
          return Promise.resolve(failed(
            lorebitFailure('capability-unavailable', 'Index generation adapters are not configured.'),
            { operationId: envelope.operationId, kind: 'command' }
          ));
        }
        return this.#maintenance.estimateBytes(envelope as DurableCommandEnvelope<Extract<ProcessingCommandPayload, { type: `generation.${string}` }>>).then((estimatedBytes) => this.#scheduled(
          'processing',
          envelope.payload.spaceId,
          estimatedBytes,
          options,
          { operationId: envelope.operationId, kind: 'command' },
          (effectiveOptions) => this.#maintenance!.execute(
            envelope as DurableCommandEnvelope<Extract<ProcessingCommandPayload, { type: `generation.${string}` }>>,
            effectiveOptions
          )
        )).then((result) => {
          if (
            !result.ok &&
            ['receipt-stale', 'generation-invalid', 'integrity-check-failed'].includes(result.error.code)
          ) {
            this.#state = 'degraded';
          } else if (result.ok && envelope.payload.type === 'generation.activate') {
            this.#state = 'ready';
            this.#queryUnsafe = false;
          }
          return result;
        });
      }
      return this.#scheduled(
        'repository',
        envelope.payload.spaceId,
        0,
        options,
        { operationId: envelope.operationId, kind: 'command' },
        (effectiveOptions) => this.#service.execute(
          envelope as DurableCommandEnvelope<LifecycleCommandPayload>,
          effectiveOptions
        )
      );
    });
  }

  getRun(spaceId: SpaceId, runId: RunId): Promise<LorebitOutcome<ProcessingRun>> {
    return this.#run(undefined, () => this.#ingest === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Processing adapters are not configured.'),
          { operationId: `operation_query-${runId}` as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#ingest.getRun(spaceId, runId));
  }

  getDeltaPlan(spaceId: SpaceId, deltaPlanId: string): Promise<LorebitOutcome<DeltaPlan>> {
    return this.#run(undefined, () => this.#ingest === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Processing adapters are not configured.'),
          { operationId: `operation_query-${deltaPlanId}` as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#ingest.getDeltaPlan(spaceId, deltaPlanId));
  }

  getGeneration(
    spaceId: SpaceId,
    generationId: GenerationId
  ): Promise<LorebitOutcome<IndexGeneration>> {
    return this.#run(undefined, () => this.#maintenance === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Index generation adapters are not configured.'),
          { operationId: `operation_query-${generationId}` as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#maintenance.getGeneration(spaceId, generationId));
  }

  getGenerationReceipt(
    spaceId: SpaceId,
    generationId: GenerationId
  ): Promise<LorebitOutcome<GenerationValidationReceipt>> {
    return this.#run(undefined, () => this.#maintenance === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Index generation adapters are not configured.'),
          { operationId: `operation_receipt-${generationId}` as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#maintenance.getGenerationReceipt(spaceId, generationId));
  }

  getQuerySnapshot(spaceId: SpaceId): Promise<LorebitOutcome<QuerySnapshot>> {
    return this.#run(undefined, () => this.#maintenance === undefined
      ? Promise.resolve(failed(
          lorebitFailure('capability-unavailable', 'Index generation adapters are not configured.'),
          { operationId: `operation_query-${spaceId}` as import('../domain/ids.js').OperationId, kind: 'query' }
        ))
      : this.#maintenance.getQuerySnapshot(spaceId));
  }

  getSpace(spaceId: SpaceId): Promise<LorebitOutcome<KnowledgeSpace>> {
    return this.#run(undefined, () => this.#service.getSpace(spaceId));
  }

  getSource(spaceId: SpaceId, sourceId: SourceId): Promise<LorebitOutcome<Source>> {
    return this.#run(undefined, () => this.#service.getSource(spaceId, sourceId));
  }

  getImportBatch(
    spaceId: SpaceId,
    importBatchId: string
  ): Promise<LorebitOutcome<ImportBatch>> {
    return this.#run(undefined, () => this.#service.getImportBatch(spaceId, importBatchId));
  }

  listImportBatches(
    spaceId: SpaceId,
    page: PageRequest
  ): Promise<LorebitOutcome<Page<ImportBatch>>> {
    return this.#run(undefined, () => this.#service.listImportBatches(spaceId, page));
  }

  spaceReadiness(spaceId: SpaceId): Promise<LorebitOutcome<SpaceReadiness>> {
    return this.#run(undefined, () => this.#service.spaceReadiness(spaceId));
  }

  getRevision(
    spaceId: SpaceId,
    revisionId: RevisionId
  ): Promise<LorebitOutcome<RevisionView>> {
    return this.#run(undefined, () => this.#service.getRevision(spaceId, revisionId));
  }

  listRevisions(
    spaceId: SpaceId,
    sourceId: SourceId,
    page: PageRequest
  ): Promise<LorebitOutcome<Page<RevisionView>>> {
    return this.#run(undefined, () => this.#service.listRevisions(spaceId, sourceId, page));
  }

  listRevisionDecisions(
    spaceId: SpaceId,
    revisionId: RevisionId,
    page: PageRequest
  ): Promise<LorebitOutcome<Page<RevisionDecision>>> {
    return this.#run(
      undefined,
      () => this.#service.listRevisionDecisions(spaceId, revisionId, page)
    );
  }

  listEvents(
    spaceId: SpaceId,
    page: PageRequest,
    aggregateId?: string
  ): Promise<LorebitOutcome<Page<LifecycleEvent>>> {
    return this.#run(
      undefined,
      () => aggregateId === undefined
        ? this.#service.listEvents(spaceId, page)
        : this.#service.listEvents(spaceId, page, aggregateId)
    );
  }

  resolveRevision(
    query: RevisionQuery
  ): Promise<LorebitOutcome<ResolveRevisionResult>> {
    return this.#run(undefined, () => this.#service.resolveRevision(query));
  }

  compareRevisions(
    spaceId: SpaceId,
    leftId: RevisionId,
    rightId: RevisionId
  ): Promise<LorebitOutcome<VersionDifference>> {
    return this.#run(undefined, () => this.#service.compareRevisions(spaceId, leftId, rightId));
  }

  comparePolicies(
    spaceId: SpaceId,
    leftId: string,
    rightId: string
  ): Promise<LorebitOutcome<VersionDifference>> {
    return this.#run(undefined, () => this.#service.comparePolicies(spaceId, leftId, rightId));
  }

  compareRecipes(
    spaceId: SpaceId,
    leftId: string,
    rightId: string
  ): Promise<LorebitOutcome<VersionDifference>> {
    return this.#run(undefined, () => this.#service.compareRecipes(spaceId, leftId, rightId));
  }

  flushOutbox(
    spaceId: SpaceId,
    page?: PageRequest
  ): Promise<LorebitOutcome<{ readonly delivered: number; readonly pending: number }>> {
    return this.#run(
      undefined,
      () => page === undefined
        ? this.#service.flushOutbox(spaceId)
        : this.#service.flushOutbox(spaceId, page)
    );
  }

  acquireRunClaim(request: {
    readonly spaceId: SpaceId;
    readonly runId: RunId;
    readonly workerId: string;
    readonly now: RunCheckpoint['savedAt'];
    readonly leaseUntil: RunCheckpoint['savedAt'];
  }): Promise<LorebitOutcome<RunClaim>> {
    return this.#run(undefined, () => this.#service.acquireRunClaim(request));
  }

  saveCheckpoint(
    checkpoint: RunCheckpoint
  ): Promise<LorebitOutcome<{ readonly saved: true }>> {
    return this.#run(undefined, () => this.#service.saveCheckpoint(checkpoint));
  }

  close(options: CloseOptions = {}): Promise<CloseReceipt> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#state = 'draining';
    this.#scheduler.close();
    this.#closePromise = this.#finishClose(options);
    return this.#closePromise;
  }

  async #run<T>(
    requestedOperationId: DurableCommandEnvelope<LifecycleCommandPayload>['operationId'] | undefined,
    operation: () => Promise<LorebitOutcome<T>>
  ): Promise<LorebitOutcome<T>> {
    if (this.#state === 'draining' || this.#state === 'closed') {
      const operationId = requestedOperationId ??
        // Query callers receive a runtime-scoped stable placeholder after close.
        ('operation_runtime-closed' as DurableCommandEnvelope<LifecycleCommandPayload>['operationId']);
      return failed(
        lorebitFailure(
          this.#state === 'closed' ? 'runtime-closed' : 'runtime-closing',
          this.#state === 'closed'
            ? 'Runtime is closed.'
            : 'Runtime is draining and no longer accepts new operations.'
        ),
        { operationId, kind: 'runtime' }
      );
    }
    this.#inFlight += 1;
    try {
      return await operation();
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    }
  }

  #operation(kind: OperationRef['kind']): OperationRef {
    return { operationId: this.#ids.next('operation'), kind };
  }

  async #scheduled<T>(
    kind: ScheduledOperationKind,
    spaceId: string,
    estimatedBytes: number,
    options: ExecutionOptions | undefined,
    operation: OperationRef,
    execute: (effectiveOptions: ExecutionOptions) => Promise<LorebitOutcome<T>>
  ): Promise<LorebitOutcome<T>> {
    const startedAt = this.#clock.now();
    const trace = createTraceContextSnapshot(options?.trace, startedAt, { traceId: this.#random.hex(16), spanId: this.#random.hex(8) });
    const spanId = this.#random.hex(8);
    const traceparent = `00-${trace.traceId}-${spanId}-${trace.traceFlags}`;
    const scheduled = await this.#scheduler.schedule<LorebitOutcome<T>>(kind, estimatedBytes, async (effectiveOptions) => {
      const executionTrace = { ...trace, traceparent };
      const unbind = bindExecutionTrace(operation.operationId, executionTrace);
      try {
        return await execute({
          ...effectiveOptions,
          trace: {
            traceparent,
            ...(trace.tracestate === null ? {} : { tracestate: trace.tracestate })
          }
        });
      } finally {
        unbind();
      }
    }, options);
    const outcome: LorebitOutcome<T> = scheduled.ok
      ? scheduled.value
      : failed<T>(lorebitFailure(scheduled.code, scheduled.summary, scheduled.retryAfterMs !== null), operation);
    const completedAt = this.#clock.now();
    const code = outcome.ok ? 'ok' : outcome.error.code;
    await this.#safeMetric('lorebit.runtime.operations', 1, { spaceId, kind, code });
    await this.#safeMetric('lorebit.runtime.operation_duration_ms', Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), { spaceId, kind, code });
    await this.#safeSpan({
      schemaVersion: '1.0',
      traceId: trace.traceId,
      spanId,
      parentSpanId: trace.parentSpanId,
      name: `lorebit.${kind}`,
      scope: { spaceId, operationId: operation.operationId, queryPlanId: null, generationId: null },
      attributes: { code, queued: scheduled.observation.queued, inFlight: scheduled.observation.inFlight, inFlightBytes: scheduled.observation.inFlightBytes, validIncomingTrace: trace.validIncoming },
      startedAt,
      completedAt,
      status: outcome.ok ? 'ok' : 'error'
    });
    return outcome;
  }

  #scheduledModule<TModule, TValue>(
    kind: ScheduledOperationKind,
    spaceId: string,
    estimatedBytes: number,
    options: ExecutionOptions | undefined,
    module: TModule | undefined,
    unavailableSummary: string,
    failureCode: LorebitFailureCode,
    execute: (available: TModule, effectiveOptions: ExecutionOptions) => TValue | Promise<TValue>
  ): Promise<LorebitOutcome<TValue>> {
    if (module === undefined) return this.#module(module, unavailableSummary, failureCode, (available) => execute(available, options ?? {}));
    const operation = this.#operation('query');
    return this.#run(undefined, () => this.#scheduled(
      kind,
      spaceId,
      estimatedBytes,
      options,
      operation,
      async (effectiveOptions) => {
        try {
          return successful(await execute(module, effectiveOptions), operation);
        } catch (error) {
          const structuredCode = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
            ? Reflect.get(error, 'code') as LorebitFailureCode
            : null;
          return failed(lorebitFailure(structuredCode ?? failureCode, 'The requested module operation failed validation or execution.'), operation);
        }
      }
    ));
  }

  async #safeMetric(name: string, value: number, attributes: JsonValue): Promise<void> {
    try { await this.#telemetry.recordMetric(name, value, attributes); } catch { /* Telemetry is observational and never changes domain outcomes. */ }
  }

  async #safeSpan(span: TelemetrySpan): Promise<void> {
    try { await this.#telemetry.recordSpan(span); } catch { /* Telemetry is observational and never changes domain outcomes. */ }
  }

  #module<TModule, TValue>(
    module: TModule | undefined,
    unavailableSummary: string,
    failureCode: LorebitFailureCode,
    execute: (available: TModule) => TValue | Promise<TValue>
  ): Promise<LorebitOutcome<TValue>> {
    return this.#run(undefined, async () => {
      const operation = this.#operation('query');
      if (module === undefined) {
        return failed(lorebitFailure('capability-unavailable', unavailableSummary), operation);
      }
      try {
        return successful(await execute(module), operation);
      } catch (error) {
        const structuredCode = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
          ? Reflect.get(error, 'code') as LorebitFailureCode
          : null;
        return failed(
          lorebitFailure(structuredCode ?? failureCode, 'The requested module operation failed validation or execution.'),
          operation
        );
      }
    });
  }

  async #finishClose(options: CloseOptions): Promise<CloseReceipt> {
    const diagnostics: string[] = [];
    const closedResources: string[] = [];
    if (this.#inFlight > 0) {
      await Promise.race([
        new Promise<void>((resolve) => this.#idleWaiters.push(resolve)),
        new Promise<void>((resolve) => {
          if (options.deadline?.aborted === true) {
            resolve();
          } else {
            options.deadline?.addEventListener('abort', () => resolve(), { once: true });
          }
        })
      ]);
      if (this.#inFlight > 0) {
        diagnostics.push(`${this.#inFlight} in-flight operation(s) outlived the close deadline.`);
      }
    }
    const resourceSnapshot = this.#scheduler.snapshot();
    const detachedOperations = resourceSnapshot.repositoryInFlight
      + resourceSnapshot.queryInFlight
      + resourceSnapshot.generateInFlight
      + resourceSnapshot.processingInFlight
      + resourceSnapshot.importInFlight
      + resourceSnapshot.rebuildInFlight;
    if (detachedOperations > 0) {
      diagnostics.push(`${detachedOperations} adapter operation(s) outlived cancellation grace; late results remain isolated.`);
    }
    for (const resource of this.#closeResources) {
      try {
        await resource.close();
        closedResources.push(resource.name);
      } catch {
        diagnostics.push(`Failed to close ${resource.name}.`);
      }
    }
    this.#state = 'closed';
    return { state: 'closed', closedResources, diagnostics };
  }
}

export type LorebitMutation = LifecycleMutation | IngestMutation | MaintenanceMutation;
export type Lorebit = LifecycleRuntime;
