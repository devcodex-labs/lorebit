import { LifecycleService } from '../application/services/lifecycle-service.js';
import { ProcessingService } from '../application/services/processing-service.js';
import { GenerationService } from '../application/services/generation-service.js';
import { QueryService } from '../application/services/query-service.js';
import { ContextService } from '../application/services/context-service.js';
import { GenerationRuntimeService } from '../application/services/generation-runtime-service.js';
import { RecoveryService } from '../application/services/recovery-service.js';
import { ResourceScheduler } from '../application/services/resource-scheduler.js';
import { TransferService } from '../application/services/transfer-service.js';
import { createSystemIdGenerator, type IdGenerator } from '../domain/ids.js';
import { lorebitFailure } from '../domain/diagnostics.js';
import { failed, successful, type LorebitOutcome } from '../domain/outcomes.js';
import { createSystemClock, type Clock } from '../ports/clock.js';
import type { ContentStore } from '../ports/content-store.js';
import { createNoopEventSink, type EventSink } from '../ports/event-sink.js';
import type { KnowledgeRepository } from '../ports/knowledge-repository.js';
import type { ContentTransformer } from '../ports/content-transformer.js';
import type { EmbeddingModel } from '../ports/embedding-model.js';
import type { VectorIndex } from '../ports/vector-index.js';
import type { KeywordIndex } from '../ports/keyword-index.js';
import type { Reranker } from '../ports/reranker.js';
import type { TokenCounter } from '../ports/token-counter.js';
import type { SecurityHook } from '../ports/security-hooks.js';
import type { DerivedArtifactStore } from '../ports/derived-artifact-store.js';
import { createNoopTelemetrySink, type TelemetrySink } from '../ports/telemetry.js';
import type { GenerationModuleConfig } from '../modules/generation.js';
import type { EvaluationModule } from '../modules/evaluation.js';
import type { ImportExportModuleConfig } from '../modules/import-export.js';
import {
  resolveProcessingResourceLimits,
  type ProcessingResourceLimits
} from '../domain/processing.js';
import {
  resolveRuntimeResourceLimits,
  type RuntimeResourceLimits
} from '../domain/resources.js';
import { LifecycleRuntime, type Lorebit } from './lifecycle-runtime.js';
import { IngestRuntime } from './ingest-runtime.js';
import { MaintenanceRuntime } from './maintenance-runtime.js';
import { QueryRuntime } from './query-runtime.js';

export interface CreateLorebitOptions {
  readonly repository: KnowledgeRepository;
  readonly contentStore: ContentStore;
  readonly eventSink?: EventSink;
  readonly transformer?: ContentTransformer;
  readonly embeddingModel?: EmbeddingModel;
  readonly vectorIndex?: VectorIndex;
  readonly keywordIndex?: KeywordIndex;
  readonly reranker?: Reranker;
  readonly tokenCounter?: TokenCounter;
  readonly securityHooks?: readonly SecurityHook[];
  readonly generation?: GenerationModuleConfig;
  readonly evaluation?: EvaluationModule;
  readonly importExport?: ImportExportModuleConfig;
  readonly derivedArtifacts?: DerivedArtifactStore;
  readonly telemetry?: TelemetrySink;
  readonly processingLimits?: Partial<ProcessingResourceLimits>;
  readonly resourceLimits?: Partial<RuntimeResourceLimits>;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly random?: { next(): number; hex(bytes: number): string };
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && methods.every(
    (method) => typeof Reflect.get(value, method) === 'function'
  );
}

function createSystemRandom(): { next(): number; hex(bytes: number): string } {
  return {
    next() {
      const value = new Uint32Array(1);
      globalThis.crypto.getRandomValues(value);
      return value[0]! / 0x1_0000_0000;
    },
    hex(bytes) {
      const value = new Uint8Array(bytes);
      globalThis.crypto.getRandomValues(value);
      return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('');
    }
  };
}

export async function createLorebit(
  options: CreateLorebitOptions
): Promise<LorebitOutcome<Lorebit>> {
  const operation = {
    operationId: createSystemIdGenerator().next('operation'),
    kind: 'runtime' as const
  };
  if (typeof options !== 'object' || options === null) {
    return failed(
      lorebitFailure('configuration-invalid', 'createLorebit options are required.'),
      operation
    );
  }
  if (!hasMethods(options.repository, [
    'commit',
    'getOperation',
    'getSpace',
    'listEvents',
    'acquireRunClaim',
    'saveCheckpoint',
    'close'
  ])) {
    return failed(
      lorebitFailure('configuration-invalid', 'KnowledgeRepository contract is incomplete.'),
      operation
    );
  }
  if (
    options.repository.descriptor?.kind !== 'knowledge-repository' ||
    options.repository.capabilities?.atomicCommit !== true ||
    options.repository.capabilities.expectedStateCas !== true ||
    options.repository.capabilities.idempotencyRecords !== true ||
    options.repository.capabilities.stablePagination !== true ||
    options.repository.capabilities.outbox !== true ||
    options.repository.capabilities.runClaimFencing !== true ||
    options.repository.capabilities.spaceIsolation === 'none'
  ) {
    return failed(
      lorebitFailure(
        'capability-unavailable',
        'KnowledgeRepository lacks an M1 consistency or isolation capability.'
      ),
      operation
    );
  }
  const processingPorts = [options.transformer, options.embeddingModel, options.vectorIndex];
  const configuredProcessingPorts = processingPorts.filter((value) => value !== undefined).length;
  if (configuredProcessingPorts !== 0 && configuredProcessingPorts !== processingPorts.length) {
    return failed(
      lorebitFailure(
        'configuration-invalid',
        'transformer, embeddingModel and vectorIndex must be configured together.'
      ),
      operation
    );
  }
  const processingEnabled = configuredProcessingPorts === processingPorts.length;
  const processingLimits = resolveProcessingResourceLimits(options.processingLimits);
  if (processingLimits === null) {
    return failed(
      lorebitFailure('configuration-invalid', 'processingLimits must be positive safe integers within hard caps.'),
      operation
    );
  }
  const resourceLimits = resolveRuntimeResourceLimits(options.resourceLimits);
  if (resourceLimits === null) {
    return failed(
      lorebitFailure('configuration-invalid', 'resourceLimits must be positive safe integers within hard caps.'),
      operation
    );
  }
  if (options.keywordIndex !== undefined && !processingEnabled) {
    return failed(
      lorebitFailure('configuration-invalid', 'keywordIndex requires the processing adapter set.'),
      operation
    );
  }
  if ((options.reranker !== undefined || options.tokenCounter !== undefined || (options.securityHooks?.length ?? 0) > 0) && !processingEnabled) {
    return failed(
      lorebitFailure('configuration-invalid', 'Query capabilities require the processing adapter set.'),
      operation
    );
  }
  if (options.generation !== undefined && !processingEnabled) {
    return failed(
      lorebitFailure('configuration-invalid', 'The generation module requires retrieve/context processing adapters.'),
      operation
    );
  }
  if (processingEnabled) {
    const transformer = options.transformer!;
    const embeddingModel = options.embeddingModel!;
    const vectorIndex = options.vectorIndex!;
    if (
      !hasMethods(transformer, ['transform', 'close']) ||
      !hasMethods(embeddingModel, ['embed', 'close']) ||
      !hasMethods(vectorIndex, ['createGeneration', 'upsert', 'reuse', 'delete', 'count', 'manifest', 'query', 'close']) ||
      (options.keywordIndex !== undefined &&
        !hasMethods(options.keywordIndex, ['createGeneration', 'upsert', 'reuse', 'delete', 'count', 'manifest', 'query', 'close']))
    ) {
      return failed(lorebitFailure('configuration-invalid', 'A processing or index adapter contract is incomplete.'), operation);
    }
    if (
      transformer.descriptor.kind !== 'content-transformer' ||
      embeddingModel.descriptor.kind !== 'embedding-model' ||
      vectorIndex.descriptor.kind !== 'vector-index' ||
      embeddingModel.capabilities.dimension !== vectorIndex.capabilities.dimension ||
      embeddingModel.capabilities.maxBatchSize < 1 ||
      embeddingModel.capabilities.maxInputUtf8Bytes < 1
    ) {
      return failed(lorebitFailure('model-incompatible', 'Embedding and vector index capabilities are incompatible.'), operation);
    }
    if (
      options.repository.capabilities.atomicQuerySnapshot !== true ||
      vectorIndex.capabilities.namespaceIsolation === 'none' ||
      vectorIndex.capabilities.generationIsolation !== true ||
      vectorIndex.capabilities.deleteGuarantee !== 'verified' ||
      vectorIndex.capabilities.activation !== 'repository-transaction' ||
      (options.keywordIndex !== undefined &&
        (options.keywordIndex.descriptor.kind !== 'keyword-index' ||
          options.keywordIndex.capabilities.namespaceIsolation === 'none' ||
          options.keywordIndex.capabilities.generationIsolation !== true ||
          options.keywordIndex.capabilities.deleteGuarantee !== 'verified'))
    ) {
      return failed(
        lorebitFailure('capability-unavailable', 'Index adapters lack B2 isolation, deletion or activation guarantees.'),
        operation
      );
    }
    if (
      options.vectorIndex!.capabilities.filter === undefined ||
      options.vectorIndex!.capabilities.filter.pushdown === 'none' ||
      (options.keywordIndex !== undefined && options.keywordIndex.capabilities.filter === undefined)
    ) {
      return failed(lorebitFailure('capability-unavailable', 'Query indexes must declare filter pushdown semantics.'), operation);
    }
    if (options.embeddingModel!.descriptor.dataBoundary === undefined) {
      return failed(lorebitFailure('configuration-invalid', 'EmbeddingModel must declare its data boundary.'), operation);
    }
  }
  if (options.reranker !== undefined && (!hasMethods(options.reranker, ['rerank', 'close']) || options.reranker.descriptor.kind !== 'reranker' || options.reranker.descriptor.dataBoundary === undefined)) {
    return failed(lorebitFailure('configuration-invalid', 'Reranker contract or data boundary is incomplete.'), operation);
  }
  if (options.tokenCounter !== undefined && (!hasMethods(options.tokenCounter, ['count', 'close']) || options.tokenCounter.descriptor.kind !== 'token-counter')) {
    return failed(lorebitFailure('configuration-invalid', 'TokenCounter contract is incomplete.'), operation);
  }
  const securityHooks = options.securityHooks ?? [];
  if (securityHooks.some((hook) => !hasMethods(hook, ['execute', 'close']) || hook.descriptor.kind !== 'security-hook')) {
    return failed(lorebitFailure('configuration-invalid', 'SecurityHook contract is incomplete.'), operation);
  }
  if (options.generation !== undefined) {
    const model = options.generation.languageModel;
    if (
      options.generation.enabled !== true ||
      !hasMethods(model, ['generate', 'close']) ||
      model.descriptor?.kind !== 'language-model' ||
      model.descriptor.dataBoundary === undefined ||
      model.capabilities?.retryOwner !== 'runtime' ||
      !Number.isSafeInteger(model.capabilities.maxContextTokens) ||
      model.capabilities.maxContextTokens < 1 ||
      !Number.isSafeInteger(model.capabilities.maxInputUtf8Bytes) ||
      model.capabilities.maxInputUtf8Bytes < 1 ||
      !Number.isSafeInteger(model.capabilities.maxOutputUtf8Bytes) ||
      model.capabilities.maxOutputUtf8Bytes < 1
    ) {
      return failed(lorebitFailure('configuration-invalid', 'LanguageModel contract, limits or data boundary is incomplete.'), operation);
    }
  }
  if (options.evaluation !== undefined && !hasMethods(options.evaluation, ['evaluate', 'compare', 'applyGate', 'recordFeedback', 'listFeedback', 'close'])) {
    return failed(lorebitFailure('configuration-invalid', 'Evaluation module contract is incomplete.'), operation);
  }
  if (options.importExport !== undefined && (
    options.importExport.enabled !== true ||
    typeof options.importExport.allowIncrementalExport !== 'boolean' ||
    typeof options.importExport.requireDryRunBeforeMigration !== 'boolean'
  )) {
    return failed(lorebitFailure('configuration-invalid', 'Import/export module configuration is incomplete.'), operation);
  }
  if (options.importExport !== undefined && !hasMethods(options.repository, [
    'listSources',
    'listPolicies',
    'listRecipes',
    'listGenerations',
    'listActivations',
    'listRuns',
    'listImportBatches',
    'listDecisions'
  ])) {
    return failed(lorebitFailure('configuration-invalid', 'Full snapshot transfer requires bounded repository history readers.'), operation);
  }
  if (options.importExport?.allowIncrementalExport === true) {
    return failed(
      lorebitFailure(
        'capability-unavailable',
        'Incremental export requires an ordered change cursor and tombstone stream; v0.1 only enables verified full snapshots.'
      ),
      operation
    );
  }
  if (options.derivedArtifacts !== undefined && (
    !hasMethods(options.derivedArtifacts, ['put', 'get', 'invalidateLineage', 'delete', 'size', 'close']) ||
    options.derivedArtifacts.descriptor?.kind !== 'derived-artifact-store' ||
    options.derivedArtifacts.capabilities?.lineageInvalidation !== true ||
    options.derivedArtifacts.capabilities.deleteReceipt !== true ||
    options.derivedArtifacts.capabilities.spaceIsolation === 'none'
  )) {
    return failed(lorebitFailure('configuration-invalid', 'DerivedArtifactStore lacks bounded lineage invalidation guarantees.'), operation);
  }
  if (!hasMethods(options.contentStore, ['putImmutable', 'get', 'has', 'tombstone', 'close'])) {
    return failed(
      lorebitFailure('configuration-invalid', 'ContentStore contract is incomplete.'),
      operation
    );
  }
  if (
    options.contentStore.descriptor?.kind !== 'content-store' ||
    options.contentStore.capabilities?.contentAddressed !== true ||
    options.contentStore.capabilities.immutableWrite !== true ||
    options.contentStore.capabilities.tombstone !== true ||
    options.contentStore.capabilities.spaceIsolation === 'none'
  ) {
    return failed(
      lorebitFailure(
        'capability-unavailable',
        'ContentStore lacks an M1 immutability or isolation capability.'
      ),
      operation
    );
  }
  const eventSink = options.eventSink ?? createNoopEventSink();
  if (!hasMethods(eventSink, ['publish', 'close'])) {
    return failed(
      lorebitFailure('configuration-invalid', 'EventSink contract is incomplete.'),
      operation
    );
  }
  const telemetry = options.telemetry ?? createNoopTelemetrySink();
  if (
    !hasMethods(telemetry, ['recordSpan', 'recordMetric', 'close']) ||
    telemetry.descriptor?.kind !== 'telemetry' ||
    telemetry.capabilities?.redactedByDefault !== true ||
    telemetry.capabilities.traceContext !== 'w3c'
  ) {
    return failed(lorebitFailure('configuration-invalid', 'TelemetrySink contract or redaction guarantee is incomplete.'), operation);
  }
  const clock = options.clock ?? createSystemClock();
  const ids = options.idGenerator ?? createSystemIdGenerator();
  const random = options.random ?? createSystemRandom();
  if (!hasMethods(clock, ['now']) || !hasMethods(ids, ['next']) || !hasMethods(random, ['next', 'hex'])) {
    return failed(
      lorebitFailure('configuration-invalid', 'Clock, IdGenerator or runtime random source contract is incomplete.'),
      operation
    );
  }
  const service = new LifecycleService({
    repository: options.repository,
    contentStore: options.contentStore,
    eventSink,
    clock,
    ids
  });
  const processingService = processingEnabled
    ? new ProcessingService({
        repository: options.repository,
        contentStore: options.contentStore,
        transformer: options.transformer!,
        eventSink,
        clock,
        ids,
        limits: processingLimits
      })
    : undefined;
  const generationService = processingEnabled
    ? new GenerationService({
        repository: options.repository,
        contentStore: options.contentStore,
        embeddingModel: options.embeddingModel!,
        vectorIndex: options.vectorIndex!,
        ...(options.keywordIndex === undefined ? {} : { keywordIndex: options.keywordIndex }),
        eventSink,
        clock,
        ids,
        limits: processingLimits
      })
    : undefined;
  const queryService = processingEnabled
    ? new QueryService({
        repository: options.repository,
        contentStore: options.contentStore,
        embeddingModel: options.embeddingModel!,
        vectorIndex: options.vectorIndex!,
        ...(options.keywordIndex === undefined ? {} : { keywordIndex: options.keywordIndex }),
        ...(options.reranker === undefined ? {} : { reranker: options.reranker }),
        securityHooks,
        clock,
        ids
      })
    : undefined;
  const contextService = processingEnabled
    ? new ContextService({
        repository: options.repository,
        ...(options.tokenCounter === undefined ? {} : { tokenCounter: options.tokenCounter }),
        securityHooks,
        clock,
        ids
      })
    : undefined;
  const scheduler = new ResourceScheduler(resourceLimits, clock);
  const generationRuntimeService = options.generation === undefined
    ? undefined
    : new GenerationRuntimeService({
        repository: options.repository,
        model: options.generation.languageModel,
        securityHooks,
        telemetry,
        limits: resourceLimits,
        clock,
        ids,
        random
      });
  const queryRuntime = processingEnabled
    ? new QueryRuntime({
        query: queryService!,
        context: contextService!,
        ...(generationRuntimeService === undefined ? {} : { generation: generationRuntimeService }),
        scheduler,
        telemetry,
        clock,
        ids,
        random,
        limits: resourceLimits
      })
    : undefined;
  const recovery = processingEnabled
    ? new RecoveryService({
        repository: options.repository,
        vectorIndex: options.vectorIndex!,
        ...(options.keywordIndex === undefined ? {} : { keywordIndex: options.keywordIndex }),
        ...(options.derivedArtifacts === undefined ? {} : { derivedArtifacts: options.derivedArtifacts }),
        telemetry,
        clock,
        ids
      })
    : undefined;
  const transfer = options.importExport === undefined
    ? undefined
    : new TransferService({
        repository: options.repository,
        contentStore: options.contentStore,
        clock,
        ids,
        limits: resourceLimits,
        allowIncrementalExport: options.importExport.allowIncrementalExport,
        requireDryRunBeforeMigration: options.importExport.requireDryRunBeforeMigration,
        securityHooks
      });
  const processingResources = processingEnabled
    ? [
        ...(options.keywordIndex === undefined
          ? []
          : [{ name: 'keywordIndex', close: () => options.keywordIndex!.close() }]),
        { name: 'vectorIndex', close: () => options.vectorIndex!.close() },
        { name: 'embeddingModel', close: () => options.embeddingModel!.close() },
        { name: 'transformer', close: () => options.transformer!.close() }
      ]
    : [];
  return successful(
    new LifecycleRuntime({
      service,
      ids,
      scheduler,
      telemetry,
      clock,
      random,
      ...(processingService === undefined
        ? {}
        : {
            ingest: new IngestRuntime(processingService, options.repository),
            maintenance: new MaintenanceRuntime(generationService!, options.repository),
            query: queryRuntime!,
            recovery: recovery!
          }),
      ...(transfer === undefined ? {} : { transfer }),
      ...(options.evaluation === undefined ? {} : { evaluation: options.evaluation }),
      closeResources: [
        { name: 'eventSink', close: () => eventSink.close() },
        ...securityHooks.map((hook) => ({ name: `securityHook:${hook.descriptor.hookId}`, close: () => hook.close() })),
        ...(options.tokenCounter === undefined ? [] : [{ name: 'tokenCounter', close: () => options.tokenCounter!.close() }]),
        ...(options.reranker === undefined ? [] : [{ name: 'reranker', close: () => options.reranker!.close() }]),
        ...(options.generation === undefined ? [] : [{ name: 'languageModel', close: () => options.generation!.languageModel.close() }]),
        ...(options.derivedArtifacts === undefined ? [] : [{ name: 'derivedArtifacts', close: () => options.derivedArtifacts!.close() }]),
        ...(options.evaluation === undefined ? [] : [{ name: 'evaluation', close: async () => { options.evaluation!.close(); } }]),
        { name: 'telemetry', close: () => telemetry.close() },
        ...processingResources,
        { name: 'contentStore', close: () => options.contentStore.close() },
        { name: 'repository', close: () => options.repository.close() }
      ]
    }),
    operation
  );
}
