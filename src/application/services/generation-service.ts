import type {
  ActivateGenerationCommand,
  BuildGenerationCommand,
  DurableCommandEnvelope,
  ExecutionOptions,
  ProcessingCommandPayload,
  RetireGenerationCommand,
  ValidateGenerationCommand
} from '../commands.js';
import { validateDurableCommandEnvelope } from '../commands.js';
import type { ContentUnitVersion } from '../../domain/content-unit.js';
import { diagnostic } from '../../domain/diagnostics.js';
import { lorebitFailure } from '../../domain/diagnostics.js';
import type { DeltaPlan } from '../../domain/delta-plan.js';
import type { LifecycleEvent } from '../../domain/events.js';
import type {
  DeleteReceipt,
  GenerationValidationReceipt,
  IndexGeneration
} from '../../domain/index-generation.js';
import type {
  GenerationId,
  IdGenerator,
  OperationId,
  RevisionId,
  SpaceId
} from '../../domain/ids.js';
import { failed, successful, type LorebitOutcome, type OperationRef } from '../../domain/outcomes.js';
import type { ProcessingResourceLimits, ProcessingRun } from '../../domain/processing.js';
import type { KnowledgeActivation, RevisionState } from '../../domain/versions.js';
import type { Clock } from '../../ports/clock.js';
import type { ContentStore } from '../../ports/content-store.js';
import type { EmbeddingModel } from '../../ports/embedding-model.js';
import type { EventSink } from '../../ports/event-sink.js';
import type { KeywordIndex, KeywordRecord } from '../../ports/keyword-index.js';
import type {
  KnowledgeRepository,
  RepositoryCommitResult,
  RepositoryFailure,
  RunClaim
} from '../../ports/knowledge-repository.js';
import type { VectorIndex, VectorRecord } from '../../ports/vector-index.js';
import { digestCanonicalJson, type DigestRef } from '../../wire/digest.js';
import { decodeJsonValue, type JsonValue } from '../../wire/json-value.js';
import type { Rfc3339Utc } from '../../wire/rfc3339.js';
import { currentExecutionTrace } from '../execution-observability.js';

export interface GenerationBuildResult {
  readonly generation: IndexGeneration;
  readonly deleteReceipts: readonly DeleteReceipt[];
}

export interface GenerationValidationResult {
  readonly generation: IndexGeneration;
  readonly receipt: GenerationValidationReceipt;
}

export interface GenerationActivationResult {
  readonly generation: IndexGeneration;
  readonly activation: KnowledgeActivation;
  readonly querySnapshot: import('../../domain/activation.js').QuerySnapshot;
}

interface GenerationServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly contentStore: ContentStore;
  readonly embeddingModel: EmbeddingModel;
  readonly vectorIndex: VectorIndex;
  readonly keywordIndex?: KeywordIndex;
  readonly eventSink: EventSink;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly limits: ProcessingResourceLimits;
}

interface BuildContext {
  readonly run: ProcessingRun;
  readonly deltaPlan: DeltaPlan;
  readonly baseGeneration: IndexGeneration | null;
  readonly targetUnits: readonly ContentUnitVersion[];
  readonly revisionIds: readonly RevisionId[];
}

function operationRef(operationId: OperationId): OperationRef {
  return { operationId, kind: 'command' };
}

function asWireValue(input: unknown): JsonValue {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) throw new TypeError(decoded.error.summary);
  return decoded.value;
}

function actor(envelope: DurableCommandEnvelope<ProcessingCommandPayload>): string {
  return `${envelope.actorRef.type}:${envelope.actorRef.id}`;
}

function addMilliseconds(at: Rfc3339Utc, milliseconds: number): Rfc3339Utc {
  return new Date(Date.parse(at) + milliseconds).toISOString() as Rfc3339Utc;
}

function sameDigest(left: DigestRef, right: DigestRef): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function mapRepositoryFailure(error: RepositoryFailure) {
  return lorebitFailure(error.code, error.summary, error.retryable);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isAborted(options: ExecutionOptions): boolean {
  return options.signal?.aborted === true;
}

export class GenerationService {
  readonly #repository: KnowledgeRepository;
  readonly #contentStore: ContentStore;
  readonly #embeddingModel: EmbeddingModel;
  readonly #vectorIndex: VectorIndex;
  readonly #keywordIndex: KeywordIndex | undefined;
  readonly #eventSink: EventSink;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #limits: ProcessingResourceLimits;

  constructor(dependencies: GenerationServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#contentStore = dependencies.contentStore;
    this.#embeddingModel = dependencies.embeddingModel;
    this.#vectorIndex = dependencies.vectorIndex;
    this.#keywordIndex = dependencies.keywordIndex;
    this.#eventSink = dependencies.eventSink;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#limits = dependencies.limits;
  }

  async estimateBytes(envelope: DurableCommandEnvelope<BuildGenerationCommand | ValidateGenerationCommand | ActivateGenerationCommand | RetireGenerationCommand>): Promise<number> {
    if (envelope.payload.type !== 'generation.build') return 0;
    const run = await this.#repository.getRun(envelope.payload.spaceId, envelope.payload.runId);
    if (run === null) return 0;
    const units: ContentUnitVersion[] = [];
    let after: string | undefined;
    do {
      const page = await this.#repository.listContentUnitsForRevision(
        envelope.payload.spaceId,
        run.revisionId,
        after === undefined ? { limit: 1_000 } : { limit: 1_000, after }
      );
      units.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    const bytes = units.reduce((total, unit) => total + unit.text.byteLength, 0);
    return Math.min(this.#limits.maxNormalizedBytes, bytes);
  }

  async build(
    envelope: DurableCommandEnvelope<BuildGenerationCommand>,
    options: ExecutionOptions = {}
  ): Promise<LorebitOutcome<GenerationBuildResult>> {
    const operation = operationRef(envelope.operationId);
    const invalid = validateDurableCommandEnvelope(envelope);
    if (!invalid.ok) return failed(lorebitFailure(invalid.error.code, invalid.error.summary), operation);
    const commandDigest = await digestCanonicalJson(envelope);
    if (!commandDigest.ok) return failed(lorebitFailure('schema-invalid', commandDigest.error.summary), operation);
    const replay = await this.#repository.getOperation(envelope.payload.spaceId, envelope.idempotencyKey);
    if (replay !== null) {
      if (!sameDigest(replay.commandDigest, commandDigest.value)) {
        return failed(lorebitFailure('idempotency-conflict', 'Idempotency key payload changed.'), operation);
      }
      const generation = await this.#repository.getGeneration(
        envelope.payload.spaceId,
        envelope.payload.generationId
      );
      return generation === null
        ? failed(lorebitFailure('integrity-check-failed', 'Replayed generation is missing.'), operation)
        : successful({
            generation,
            deleteReceipts: await this.#repository.listDeleteReceipts(
              generation.spaceId,
              generation.generationId
            )
          }, operation, [diagnostic('idempotent-replay', 'info', 'Returned the durable generation state.')]);
    }

    const context = await this.#buildContext(envelope.payload.spaceId, envelope.payload.runId);
    if (!context.ok) return failed(context.error, operation);
    if (context.value.run.generationId !== envelope.payload.generationId) {
      return failed(lorebitFailure('invalid-request', 'ProcessingRun is bound to another generation.'), operation);
    }
    if (
      envelope.expected.run?.runId !== context.value.run.runId ||
      envelope.expected.run.status !== 'partial' ||
      envelope.expected.run.sequence !== context.value.run.sequence
    ) {
      return failed(lorebitFailure('invalid-request', 'generation.build requires the exact prepared run precondition.'), operation);
    }
    const existingGeneration = await this.#repository.getGeneration(
      envelope.payload.spaceId,
      envelope.payload.generationId
    );
    if (existingGeneration !== null) {
      return failed(lorebitFailure('state-conflict', 'Generation id is already in use.'), operation);
    }
    const adapterManifestDigest = await this.#adapterManifestDigest();
    const inputManifestDigest = await digestCanonicalJson({
      spaceId: envelope.payload.spaceId,
      generationId: envelope.payload.generationId,
      parentGenerationId: context.value.run.baseGenerationId,
      revisionIds: context.value.revisionIds,
      unitVersionIds: context.value.targetUnits.map((unit) => unit.unitVersionId),
      recipeId: context.value.run.recipeId,
      processingComponents: context.value.run.components,
      deltaPlanDigest: context.value.deltaPlan.planDigest,
      adapterManifestDigest
    });
    if (!inputManifestDigest.ok) throw new TypeError(inputManifestDigest.error.summary);
    const now = this.#clock.now();
    const planned: IndexGeneration = {
      schemaVersion: '1.0',
      generationId: envelope.payload.generationId,
      spaceId: envelope.payload.spaceId,
      parentGenerationId: context.value.run.baseGenerationId,
      runId: context.value.run.runId,
      recipeId: context.value.run.recipeId,
      revisionIds: context.value.revisionIds,
      unitVersionIds: context.value.targetUnits.map((unit) => unit.unitVersionId),
      deltaPlanId: context.value.deltaPlan.deltaPlanId,
      embedding: {
        adapterId: this.#embeddingModel.descriptor.adapterId,
        model: this.#embeddingModel.capabilities.model,
        version: this.#embeddingModel.descriptor.version,
        deploymentFingerprint: this.#embeddingModel.descriptor.deploymentFingerprint,
        dimension: this.#embeddingModel.capabilities.dimension
      },
      vectorIndex: {
        adapterId: this.#vectorIndex.descriptor.adapterId,
        version: this.#vectorIndex.descriptor.version,
        deploymentFingerprint: this.#vectorIndex.descriptor.deploymentFingerprint
      },
      keywordIndex: this.#keywordIndex === undefined ? null : {
        adapterId: this.#keywordIndex.descriptor.adapterId,
        version: this.#keywordIndex.descriptor.version,
        deploymentFingerprint: this.#keywordIndex.descriptor.deploymentFingerprint
      },
      inputManifestDigest: inputManifestDigest.value,
      artifactManifestDigest: null,
      status: 'planned',
      sequence: 1,
      diagnostics: [],
      createdAt: now,
      updatedAt: now
    };
    const event = await this.#event(envelope, 'generation', planned.generationId, 'generation.planned', {
      generationId: planned.generationId,
      runId: planned.runId,
      inputManifestDigest: planned.inputManifestDigest
    });
    const committed = await this.#repository.commit({
      spaceId: planned.spaceId,
      expected: envelope.expected,
      operation: {
        spaceId: planned.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: commandDigest.value,
        outcome: asWireValue({ kind: 'generation-planned', generationId: planned.generationId }),
        committedAt: now
      },
      writes: { generations: [planned], events: [event] }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(planned.spaceId, committed);

    const claim = await this.#claim(context.value.run, options);
    if (!claim.ok) return failed(mapRepositoryFailure(claim.error), operation);
    if (isAborted(options)) {
      return this.#finishBuild(planned, claim.value, envelope, 'cancelled', 'Generation build was cancelled.');
    }
    const building = await this.#transition(
      planned,
      'building',
      context.value.run,
      claim.value,
      envelope,
      'generation.building'
    );
    if (!building.ok) return failed(mapRepositoryFailure(building.error), operation);

    const built = await this.#writeIndexes(context.value, building.value, options);
    if (!built.ok) {
      return this.#finishBuild(building.value, claim.value, envelope, built.cancelled ? 'cancelled' : 'failed', built.summary);
    }
    if (isAborted(options)) {
      return this.#finishBuild(building.value, claim.value, envelope, 'cancelled', 'Generation build was cancelled.');
    }
    const vectorManifest = await this.#vectorIndex.manifest(building.value.spaceId, building.value.generationId);
    const keywordManifest = this.#keywordIndex === undefined
      ? null
      : await this.#keywordIndex.manifest(building.value.spaceId, building.value.generationId);
    if (!vectorManifest.ok || (keywordManifest !== null && !keywordManifest.ok)) {
      return this.#finishBuild(building.value, claim.value, envelope, 'failed', 'Index artifact manifest could not be read.');
    }
    const artifactManifestDigest = await digestCanonicalJson({
      vector: vectorManifest.value,
      keyword: keywordManifest?.ok === true ? keywordManifest.value : null
    });
    if (!artifactManifestDigest.ok) throw new TypeError(artifactManifestDigest.error.summary);
    const validating: IndexGeneration = {
      ...building.value,
      status: 'validating',
      sequence: building.value.sequence + 1,
      artifactManifestDigest: artifactManifestDigest.value,
      updatedAt: this.#clock.now()
    };
    const embeddingOutputDigest = await digestCanonicalJson({
      embedding: validating.embedding,
      unitVersionIds: validating.unitVersionIds
    });
    if (!embeddingOutputDigest.ok) throw new TypeError(embeddingOutputDigest.error.summary);
    const builtRun: ProcessingRun = {
      ...context.value.run,
      status: 'partial',
      sequence: context.value.run.sequence + 1,
      stages: [
        ...context.value.run.stages,
        {
          stage: 'embed',
          attempt: claim.value.attempt,
          status: 'succeeded',
          startedAt: building.value.updatedAt,
          completedAt: validating.updatedAt,
          inputDigest: context.value.run.outputDigest ?? context.value.run.inputDigest,
          outputDigest: embeddingOutputDigest.value,
          diagnostics: []
        },
        {
          stage: 'index',
          attempt: claim.value.attempt,
          status: 'succeeded',
          startedAt: building.value.updatedAt,
          completedAt: validating.updatedAt,
          inputDigest: embeddingOutputDigest.value,
          outputDigest: artifactManifestDigest.value,
          diagnostics: []
        }
      ],
      outputDigest: artifactManifestDigest.value,
      updatedAt: validating.updatedAt,
      completedAt: null
    };
    const completedEvent = await this.#event(
      envelope,
      'generation',
      validating.generationId,
      'generation.shadow-built',
      {
        generationId: validating.generationId,
        artifactManifestDigest: validating.artifactManifestDigest,
        unitCount: validating.unitVersionIds.length
      }
    );
    const runEvent = await this.#event(
      envelope,
      'run',
      builtRun.runId,
      'processing.index-built',
      {
        runId: builtRun.runId,
        generationId: validating.generationId,
        artifactManifestDigest: validating.artifactManifestDigest
      }
    );
    const finalCommit = await this.#internalCommit(
      validating.spaceId,
      {
        run: { runId: context.value.run.runId, sequence: context.value.run.sequence, status: 'partial' },
        generation: {
          generationId: building.value.generationId,
          sequence: building.value.sequence,
          status: building.value.status
        },
        fencingToken: claim.value.fencingToken
      },
      `generation-shadow-built:${validating.generationId}:${claim.value.fencingToken}`,
      { kind: 'generation-shadow-built', generationId: validating.generationId },
      {
        processingRun: builtRun,
        generations: [validating],
        deleteReceipts: built.deleteReceipts,
        events: [completedEvent, runEvent]
      }
    );
    if (!finalCommit.ok) return failed(mapRepositoryFailure(finalCommit.error), operation);
    await this.#deliver(validating.spaceId, finalCommit);
    return successful({ generation: validating, deleteReceipts: built.deleteReceipts }, operation);
  }

  async validate(
    envelope: DurableCommandEnvelope<ValidateGenerationCommand>
  ): Promise<LorebitOutcome<GenerationValidationResult>> {
    const operation = operationRef(envelope.operationId);
    const invalid = validateDurableCommandEnvelope(envelope);
    if (!invalid.ok) return failed(lorebitFailure(invalid.error.code, invalid.error.summary), operation);
    const commandDigest = await digestCanonicalJson(envelope);
    if (!commandDigest.ok) return failed(lorebitFailure('schema-invalid', commandDigest.error.summary), operation);
    const replay = await this.#repository.getOperation(envelope.payload.spaceId, envelope.idempotencyKey);
    if (replay !== null) {
      if (!sameDigest(replay.commandDigest, commandDigest.value)) {
        return failed(lorebitFailure('idempotency-conflict', 'Idempotency key payload changed.'), operation);
      }
      const [generation, receipt] = await Promise.all([
        this.#repository.getGeneration(envelope.payload.spaceId, envelope.payload.generationId),
        this.#repository.getGenerationReceipt(envelope.payload.spaceId, envelope.payload.generationId)
      ]);
      return generation === null || receipt === null
        ? failed(lorebitFailure('integrity-check-failed', 'Replayed validation facts are incomplete.'), operation)
        : successful({ generation, receipt }, operation, [diagnostic('idempotent-replay', 'info', 'Returned the durable validation receipt.')]);
    }
    const generation = await this.#repository.getGeneration(envelope.payload.spaceId, envelope.payload.generationId);
    if (generation === null) return failed(lorebitFailure('not-found', 'Generation was not found.'), operation);
    if (generation.status !== 'validating' || generation.artifactManifestDigest === null) {
      return failed(lorebitFailure('invalid-state-transition', 'Only a built validating generation can be validated.'), operation);
    }
    if (
      envelope.expected.generation?.generationId !== generation.generationId ||
      envelope.expected.generation.sequence !== generation.sequence ||
      envelope.expected.generation.status !== 'validating'
    ) {
      return failed(lorebitFailure('invalid-request', 'generation.validate requires the exact validating generation precondition.'), operation);
    }
    const [vectorCount, vectorManifest, keywordCount, keywordManifest, deleteReceipts] = await Promise.all([
      this.#vectorIndex.count(generation.spaceId, generation.generationId),
      this.#vectorIndex.manifest(generation.spaceId, generation.generationId),
      this.#keywordIndex?.count(generation.spaceId, generation.generationId) ?? Promise.resolve(null),
      this.#keywordIndex?.manifest(generation.spaceId, generation.generationId) ?? Promise.resolve(null),
      this.#repository.listDeleteReceipts(generation.spaceId, generation.generationId)
    ]);
    const keywordOk = keywordCount === null || (keywordCount.ok && keywordManifest?.ok === true);
    const artifactDigest = vectorManifest.ok && keywordOk
      ? await digestCanonicalJson({
          vector: vectorManifest.value,
          keyword: keywordManifest?.ok === true ? keywordManifest.value : null
        })
      : null;
    const expectedIds = [...generation.unitVersionIds].sort((left, right) => left.localeCompare(right, 'en'));
    const vectorIds = vectorManifest.ok ? [...vectorManifest.value] : [];
    const keywordIds = keywordManifest?.ok === true ? [...keywordManifest.value] : null;
    const units = await Promise.all(
      generation.unitVersionIds.slice(0, 10).map((id) => this.#repository.getContentUnitVersion(generation.spaceId, id))
    );
    const adapterManifestDigest = await this.#adapterManifestDigest();
    const adapterMatches = this.#adaptersMatchGeneration(generation);
    const namespaceIsolated = this.#vectorIndex.capabilities.namespaceIsolation !== 'none' &&
      (this.#keywordIndex === undefined || this.#keywordIndex.capabilities.namespaceIsolation !== 'none');
    const deletePropagationComplete = deleteReceipts.every(
      (receipt) => receipt.vectorDeleted && receipt.keywordDeleted
    );
    const passed = vectorCount.ok &&
      vectorManifest.ok &&
      keywordOk &&
      vectorCount.value === expectedIds.length &&
      (keywordCount === null || (keywordCount.ok && keywordCount.value === expectedIds.length)) &&
      sameIds(vectorIds, expectedIds) &&
      (keywordIds === null || sameIds(keywordIds, expectedIds)) &&
      artifactDigest?.ok === true &&
      sameDigest(artifactDigest.value, generation.artifactManifestDigest) &&
      units.every((unit) => unit !== null && unit.locator.unitPath.length > 0 && unit.disposition === 'available') &&
      namespaceIsolated &&
      deletePropagationComplete &&
      adapterMatches;
    const validatedAt = this.#clock.now();
    const receipt: GenerationValidationReceipt = {
      schemaVersion: '1.0',
      receiptId: this.#ids.next('receipt'),
      generationId: generation.generationId,
      spaceId: generation.spaceId,
      runtimeContractVersion: '0.1',
      inputManifestDigest: generation.inputManifestDigest,
      artifactManifestDigest: generation.artifactManifestDigest,
      adapterManifestDigest,
      expectedUnitCount: expectedIds.length,
      vectorUnitCount: vectorCount.ok ? vectorCount.value : -1,
      keywordUnitCount: keywordCount === null ? null : keywordCount.ok ? keywordCount.value : -1,
      deleteReceipts,
      probes: [
        'generation-pinned-manifest',
        'stable-unit-count',
        'locator-sample',
        'namespace-isolation',
        'delete-propagation',
        'adapter-manifest-binding'
      ],
      locatorSampleCount: units.filter((unit) => unit !== null).length,
      namespaceIsolated,
      deletePropagationComplete,
      validatorVersion: '@devcodex/lorebit:0.1',
      status: passed ? 'passed' : 'failed',
      validatedAt,
      validUntil: addMilliseconds(validatedAt, envelope.payload.receiptValidForMilliseconds)
    };
    const next: IndexGeneration = {
      ...generation,
      status: passed ? 'ready' : 'failed',
      sequence: generation.sequence + 1,
      diagnostics: passed ? generation.diagnostics : [
        ...generation.diagnostics,
        diagnostic('generation-validation-failed', 'error', 'Shadow generation integrity validation failed.')
      ],
      updatedAt: validatedAt
    };
    const run = await this.#repository.getRun(generation.spaceId, generation.runId);
    if (run === null || run.status !== 'partial') {
      return failed(lorebitFailure('integrity-check-failed', 'Generation ProcessingRun is not prepared for validation.'), operation);
    }
    const receiptDigest = await digestCanonicalJson(receipt);
    if (!receiptDigest.ok) throw new TypeError(receiptDigest.error.summary);
    const validatedRun: ProcessingRun = {
      ...run,
      status: passed ? 'succeeded' : 'failed',
      sequence: run.sequence + 1,
      stages: [
        ...run.stages,
        {
          stage: 'validate',
          attempt: 1,
          status: passed ? 'succeeded' : 'failed',
          startedAt: generation.updatedAt,
          completedAt: validatedAt,
          inputDigest: generation.artifactManifestDigest,
          outputDigest: receiptDigest.value,
          diagnostics: passed ? [] : next.diagnostics
        }
      ],
      diagnostics: passed ? run.diagnostics : [...run.diagnostics, ...next.diagnostics],
      updatedAt: validatedAt,
      completedAt: validatedAt
    };
    const event = await this.#event(
      envelope,
      'generation',
      generation.generationId,
      passed ? 'generation.ready' : 'generation.validation-failed',
      { generationId: generation.generationId, receiptId: receipt.receiptId, status: receipt.status }
    );
    const runEvent = await this.#event(
      envelope,
      'run',
      run.runId,
      passed ? 'processing.run-succeeded' : 'processing.validation-failed',
      { runId: run.runId, generationId: generation.generationId, receiptId: receipt.receiptId }
    );
    const committed = await this.#repository.commit({
      spaceId: generation.spaceId,
      expected: {
        ...envelope.expected,
        run: { runId: run.runId, sequence: run.sequence, status: 'partial' }
      },
      operation: {
        spaceId: generation.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: commandDigest.value,
        outcome: asWireValue({ kind: 'generation-validated', generationId: generation.generationId, status: receipt.status }),
        committedAt: validatedAt
      },
      writes: {
        processingRun: validatedRun,
        generations: [next],
        generationReceipt: receipt,
        events: [event, runEvent]
      }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(generation.spaceId, committed);
    return passed
      ? successful({ generation: next, receipt }, operation)
      : failed(lorebitFailure('generation-invalid', 'Shadow generation did not pass integrity validation.'), operation, next.diagnostics);
  }

  async activate(
    envelope: DurableCommandEnvelope<ActivateGenerationCommand>
  ): Promise<LorebitOutcome<GenerationActivationResult>> {
    const operation = operationRef(envelope.operationId);
    const invalid = validateDurableCommandEnvelope(envelope);
    if (!invalid.ok) return failed(lorebitFailure(invalid.error.code, invalid.error.summary), operation);
    const commandDigest = await digestCanonicalJson(envelope);
    if (!commandDigest.ok) return failed(lorebitFailure('schema-invalid', commandDigest.error.summary), operation);
    const replay = await this.#repository.getOperation(envelope.payload.spaceId, envelope.idempotencyKey);
    if (replay !== null) {
      if (!sameDigest(replay.commandDigest, commandDigest.value)) {
        return failed(lorebitFailure('idempotency-conflict', 'Idempotency key payload changed.'), operation);
      }
      const [generation, activation] = await Promise.all([
        this.#repository.getGeneration(envelope.payload.spaceId, envelope.payload.generationId),
        this.#repository.getActivation(envelope.payload.spaceId, envelope.payload.activationId)
      ]);
      const querySnapshot = activation === null ? null : {
        schemaVersion: '1.0' as const,
        spaceId: activation.spaceId,
        activationId: activation.activationId,
        policyId: activation.policyId,
        generationId: activation.generation.generationId,
        revisions: activation.revisions,
        revisionManifestDigest: activation.revisionManifestDigest,
        capturedAt: activation.createdAt
      };
      return generation === null || activation === null || querySnapshot === null
        ? failed(lorebitFailure('integrity-check-failed', 'Replayed activation facts are incomplete.'), operation)
        : successful({ generation, activation, querySnapshot }, operation, [diagnostic('idempotent-replay', 'info', 'Returned the durable activation snapshot.')]);
    }
    const [generation, receipt, active, space, policy] = await Promise.all([
      this.#repository.getGeneration(envelope.payload.spaceId, envelope.payload.generationId),
      this.#repository.getGenerationReceipt(envelope.payload.spaceId, envelope.payload.generationId),
      this.#repository.getActiveActivation(envelope.payload.spaceId),
      this.#repository.getSpace(envelope.payload.spaceId),
      this.#repository.getPolicy(envelope.payload.spaceId, envelope.payload.policyId)
    ]);
    if (generation === null || receipt === null || space === null || policy === null) {
      return failed(lorebitFailure('not-found', 'Generation, receipt, space or policy was not found.'), operation);
    }
    if (
      envelope.expected.generation?.generationId !== generation.generationId ||
      envelope.expected.generation.sequence !== generation.sequence ||
      envelope.expected.generation.status !== 'ready' ||
      envelope.expected.activationId !== (active?.activationId ?? null) ||
      envelope.expected.policyId !== policy.policyId
    ) {
      return failed(lorebitFailure('invalid-request', 'generation.activate requires exact generation, activation and policy preconditions.'), operation);
    }
    if (space.currentPolicyId !== policy.policyId || generation.status !== 'ready') {
      return failed(lorebitFailure('state-conflict', 'Candidate policy or generation is no longer current and ready.'), operation);
    }
    const currentAdapterManifest = await this.#adapterManifestDigest();
    if (
      receipt.status !== 'passed' ||
      receipt.validUntil < this.#clock.now() ||
      !sameDigest(receipt.inputManifestDigest, generation.inputManifestDigest) ||
      generation.artifactManifestDigest === null ||
      !sameDigest(receipt.artifactManifestDigest, generation.artifactManifestDigest) ||
      !sameDigest(receipt.adapterManifestDigest, currentAdapterManifest) ||
      !this.#adaptersMatchGeneration(generation)
    ) {
      return failed(lorebitFailure('receipt-stale', 'Generation validation receipt is stale or no longer matches adapters.'), operation);
    }
    if (
      this.#vectorIndex.capabilities.activation !== 'repository-transaction' ||
      this.#repository.capabilities.atomicQuerySnapshot !== true
    ) {
      return failed(lorebitFailure('capability-unavailable', 'Online activation requires repository-transaction generation switching.'), operation);
    }
    const revisionViews = await Promise.all(
      generation.revisionIds.map((revisionId) => this.#repository.getRevision(generation.spaceId, revisionId))
    );
    const decisions = await Promise.all(
      generation.revisionIds.map((revisionId) => this.#repository.getDecision(generation.spaceId, revisionId))
    );
    if (
      revisionViews.some(
        (view) => view === null || !['processing', 'partial', 'active'].includes(view.state.status)
      ) ||
      decisions.some((decision) => decision?.status !== 'approved')
    ) {
      return failed(lorebitFailure('processing-incomplete', 'Every activated revision must exist and have an approved decision.'), operation);
    }
    const deltaPlan = await this.#repository.getDeltaPlan(generation.spaceId, generation.deltaPlanId);
    const containsLimitedUnits = deltaPlan?.items.some(
      (item) => item.kind === 'quarantined' || item.kind === 'unknown'
    ) === true;
    if (containsLimitedUnits && !policy.defaultResult.allowPartial) {
      return failed(lorebitFailure('processing-incomplete', 'Policy rejects activation with quarantined or unknown units.'), operation);
    }
    const revisions = revisionViews.map((view) => ({
      sourceId: view!.revision.sourceId,
      revisionId: view!.revision.revisionId
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en'));
    const revisionManifestDigest = await digestCanonicalJson(revisions);
    if (!revisionManifestDigest.ok) throw new TypeError(revisionManifestDigest.error.summary);
    const activation: KnowledgeActivation = {
      schemaVersion: '1.0',
      activationId: envelope.payload.activationId,
      spaceId: generation.spaceId,
      predecessorActivationId: active?.activationId ?? null,
      policyId: policy.policyId,
      generation: {
        generationId: generation.generationId,
        inputManifestDigest: generation.inputManifestDigest,
        recipeId: generation.recipeId
      },
      revisions,
      revisionManifestDigest: revisionManifestDigest.value,
      createdAt: envelope.occurredAt,
      actorRef: actor(envelope),
      reason: envelope.reason
    };
    const run = await this.#repository.getRun(generation.spaceId, generation.runId);
    if (run === null || run.status !== 'succeeded') {
      return failed(lorebitFailure('integrity-check-failed', 'Validated generation ProcessingRun is incomplete.'), operation);
    }
    const receiptDigest = await digestCanonicalJson(receipt);
    if (!receiptDigest.ok) throw new TypeError(receiptDigest.error.summary);
    const activatedRun: ProcessingRun = {
      ...run,
      sequence: run.sequence + 1,
      stages: [
        ...run.stages,
        {
          stage: 'activate',
          attempt: 1,
          status: 'succeeded',
          startedAt: envelope.occurredAt,
          completedAt: envelope.occurredAt,
          inputDigest: receiptDigest.value,
          outputDigest: activation.revisionManifestDigest,
          diagnostics: []
        }
      ],
      updatedAt: envelope.occurredAt,
      completedAt: envelope.occurredAt
    };
    const activeGeneration: IndexGeneration = {
      ...generation,
      status: 'active',
      sequence: generation.sequence + 1,
      updatedAt: envelope.occurredAt
    };
    const generationWrites: IndexGeneration[] = [activeGeneration];
    if (active !== null && active.generation.generationId !== generation.generationId) {
      const previous = await this.#repository.getGeneration(generation.spaceId, active.generation.generationId);
      if (previous === null || previous.status !== 'active') {
        return failed(lorebitFailure('integrity-check-failed', 'Active activation does not reference an active generation.'), operation);
      }
      generationWrites.push({
        ...previous,
        status: 'retired',
        sequence: previous.sequence + 1,
        updatedAt: envelope.occurredAt
      });
    }
    const revisionStates: RevisionState[] = [];
    for (const view of revisionViews) {
      if (view!.state.status !== 'active') {
        revisionStates.push({
          ...view!.state,
          status: 'active',
          sequence: view!.state.sequence + 1,
          changedAt: envelope.occurredAt,
          actorRef: actor(envelope),
          reason: envelope.reason
        });
      }
    }
    for (const previous of active?.revisions ?? []) {
      if (!revisions.some((current) => current.revisionId === previous.revisionId)) {
        const view = await this.#repository.getRevision(generation.spaceId, previous.revisionId);
        if (view !== null && view.state.status === 'active') {
          revisionStates.push({
            ...view.state,
            status: 'superseded',
            sequence: view.state.sequence + 1,
            changedAt: envelope.occurredAt,
            actorRef: actor(envelope),
            reason: envelope.reason
          });
        }
      }
    }
    const events: LifecycleEvent[] = [
      await this.#event(envelope, 'generation', generation.generationId, 'generation.activated', {
        generationId: generation.generationId,
        activationId: activation.activationId
      }),
      await this.#event(envelope, 'activation', activation.activationId, 'knowledge-activation.created', {
        activationId: activation.activationId,
        predecessorActivationId: activation.predecessorActivationId,
        generationId: generation.generationId,
        policyId: policy.policyId,
        revisionManifestDigest: activation.revisionManifestDigest
      }),
      await this.#event(envelope, 'run', run.runId, 'processing.activation-completed', {
        runId: run.runId,
        generationId: generation.generationId,
        activationId: activation.activationId
      })
    ];
    for (const state of revisionStates) {
      events.push(await this.#event(envelope, 'revision', state.revisionId, 'revision.projected-by-activation', {
        revisionId: state.revisionId,
        status: state.status,
        activationId: activation.activationId
      }));
    }
    const committed = await this.#repository.commit({
      spaceId: generation.spaceId,
      expected: {
        ...envelope.expected,
        run: { runId: run.runId, sequence: run.sequence, status: 'succeeded' }
      },
      operation: {
        spaceId: generation.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: commandDigest.value,
        outcome: asWireValue({ kind: 'generation-activated', generationId: generation.generationId, activationId: activation.activationId }),
        committedAt: envelope.occurredAt
      },
      writes: {
        processingRun: activatedRun,
        generations: generationWrites,
        activation,
        revisionStates,
        events
      }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(generation.spaceId, committed);
    const querySnapshot = await this.#repository.getQuerySnapshot(generation.spaceId);
    if (querySnapshot === null || querySnapshot.activationId !== activation.activationId) {
      return failed(lorebitFailure('integrity-check-failed', 'Atomic query snapshot was not observable after activation.'), operation);
    }
    return successful({ generation: activeGeneration, activation, querySnapshot }, operation);
  }

  async retire(
    envelope: DurableCommandEnvelope<RetireGenerationCommand>
  ): Promise<LorebitOutcome<IndexGeneration>> {
    const operation = operationRef(envelope.operationId);
    const invalid = validateDurableCommandEnvelope(envelope);
    if (!invalid.ok) return failed(lorebitFailure(invalid.error.code, invalid.error.summary), operation);
    const digest = await digestCanonicalJson(envelope);
    if (!digest.ok) return failed(lorebitFailure('schema-invalid', digest.error.summary), operation);
    const generation = await this.#repository.getGeneration(envelope.payload.spaceId, envelope.payload.generationId);
    if (generation === null) return failed(lorebitFailure('not-found', 'Generation was not found.'), operation);
    const active = await this.#repository.getActiveActivation(generation.spaceId);
    if (active?.generation.generationId === generation.generationId || generation.status !== 'ready') {
      return failed(lorebitFailure('invalid-state-transition', 'Only a non-active ready generation can be retired.'), operation);
    }
    const retired: IndexGeneration = {
      ...generation,
      status: 'retired',
      sequence: generation.sequence + 1,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'generation', generation.generationId, 'generation.retired', {
      generationId: generation.generationId
    });
    const committed = await this.#repository.commit({
      spaceId: generation.spaceId,
      expected: envelope.expected,
      operation: {
        spaceId: generation.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: digest.value,
        outcome: asWireValue({ kind: 'generation-retired', generationId: generation.generationId }),
        committedAt: envelope.occurredAt
      },
      writes: { generations: [retired], events: [event] }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(generation.spaceId, committed);
    return successful(retired, operation);
  }

  async #buildContext(spaceId: SpaceId, runId: ProcessingRun['runId']): Promise<
    { readonly ok: true; readonly value: BuildContext } |
    { readonly ok: false; readonly error: ReturnType<typeof lorebitFailure> }
  > {
    const run = await this.#repository.getRun(spaceId, runId);
    if (run === null || run.status !== 'partial' || run.deltaPlanId === null) {
      return { ok: false, error: lorebitFailure('processing-incomplete', 'A prepared ProcessingRun with DeltaPlan is required.') };
    }
    const [deltaPlan, runUnits, baseGeneration] = await Promise.all([
      this.#repository.getDeltaPlan(spaceId, run.deltaPlanId),
      this.#allRevisionUnits(spaceId, run.revisionId),
      run.baseGenerationId === null
        ? Promise.resolve(null)
        : this.#repository.getGeneration(spaceId, run.baseGenerationId)
    ]);
    if (deltaPlan === null || (run.baseGenerationId !== null && baseGeneration === null)) {
      return { ok: false, error: lorebitFailure('integrity-check-failed', 'ProcessingRun inputs are incomplete.') };
    }
    const baseUnits = baseGeneration === null
      ? []
      : (await Promise.all(baseGeneration.unitVersionIds.map((id) => this.#repository.getContentUnitVersion(spaceId, id))))
          .filter((unit): unit is ContentUnitVersion => unit !== null);
    if (baseUnits.length !== (baseGeneration?.unitVersionIds.length ?? 0)) {
      return { ok: false, error: lorebitFailure('integrity-check-failed', 'Base generation unit lineage is incomplete.') };
    }
    const targetByUnit = new Map(baseUnits.map((unit) => [unit.identity.unitId, unit]));
    const runByVersion = new Map(runUnits.map((unit) => [unit.unitVersionId, unit]));
    for (const item of deltaPlan.items) {
      if (item.nextUnitVersionId === null || item.kind === 'deleted' || item.kind === 'quarantined' || item.kind === 'unknown') {
        targetByUnit.delete(item.unitId);
      } else {
        const unit = runByVersion.get(item.nextUnitVersionId);
        if (unit === undefined || unit.disposition !== 'available') {
          return { ok: false, error: lorebitFailure('integrity-check-failed', 'DeltaPlan next unit is missing or unavailable.') };
        }
        targetByUnit.set(item.unitId, unit);
      }
    }
    const targetUnits = Array.from(targetByUnit.values()).sort(
      (left, right) => left.identity.unitId.localeCompare(right.identity.unitId, 'en')
    );
    if (targetUnits.length > this.#limits.maxUnitsPerRevision) {
      return { ok: false, error: lorebitFailure('resource-limit-exceeded', 'Generation exceeds the configured ContentUnit limit.') };
    }
    const revisionBySource = new Map<string, RevisionId>();
    for (const revisionId of baseGeneration?.revisionIds ?? []) {
      const view = await this.#repository.getRevision(spaceId, revisionId);
      if (view === null) return { ok: false, error: lorebitFailure('integrity-check-failed', 'Base generation revision lineage is incomplete.') };
      revisionBySource.set(view.revision.sourceId, revisionId);
    }
    revisionBySource.set(run.sourceId, run.revisionId);
    const revisionIds = Array.from(revisionBySource.entries())
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([, revisionId]) => revisionId);
    return { ok: true, value: { run, deltaPlan, baseGeneration, targetUnits, revisionIds } };
  }

  async #writeIndexes(
    context: BuildContext,
    generation: IndexGeneration,
    options: ExecutionOptions
  ): Promise<
    { readonly ok: true; readonly deleteReceipts: readonly DeleteReceipt[] } |
    { readonly ok: false; readonly summary: string; readonly cancelled: boolean }
  > {
    const base = context.baseGeneration;
    const vectorCanClone = base !== null &&
      base.vectorIndex.adapterId === generation.vectorIndex.adapterId &&
      base.vectorIndex.version === generation.vectorIndex.version &&
      base.vectorIndex.deploymentFingerprint === generation.vectorIndex.deploymentFingerprint &&
      base.embedding.adapterId === generation.embedding.adapterId &&
      base.embedding.model === generation.embedding.model &&
      base.embedding.version === generation.embedding.version &&
      base.embedding.deploymentFingerprint === generation.embedding.deploymentFingerprint &&
      base.embedding.dimension === generation.embedding.dimension &&
      (base.recipeId === generation.recipeId ||
        (await this.#repository.getRecipe(generation.spaceId, generation.recipeId))?.compatibility.includes(base.recipeId) === true);
    const keywordCanClone = base !== null &&
      generation.keywordIndex !== null &&
      base.keywordIndex?.adapterId === generation.keywordIndex.adapterId &&
      base.keywordIndex.version === generation.keywordIndex.version &&
      base.keywordIndex?.deploymentFingerprint === generation.keywordIndex.deploymentFingerprint;
    const vectorCreated = await this.#vectorIndex.createGeneration(
      generation.spaceId,
      generation.generationId,
      vectorCanClone ? base!.generationId : null
    );
    if (!vectorCreated.ok) return { ok: false, summary: vectorCreated.summary, cancelled: vectorCreated.code === 'cancelled' };
    if (this.#keywordIndex !== undefined) {
      const keywordCreated = await this.#keywordIndex.createGeneration(
        generation.spaceId,
        generation.generationId,
        keywordCanClone ? base!.generationId : null
      );
      if (!keywordCreated.ok) return { ok: false, summary: keywordCreated.summary, cancelled: keywordCreated.code === 'cancelled' };
    }
    const targetById = new Map(context.targetUnits.map((unit) => [unit.identity.unitId, unit]));
    const freshVector = vectorCanClone
      ? context.deltaPlan.items
          .filter((item) => item.kind === 'added' || item.kind === 'changed')
          .map((item) => targetById.get(item.unitId))
          .filter((unit): unit is ContentUnitVersion => unit !== undefined)
      : [...context.targetUnits];
    const freshKeyword = keywordCanClone
      ? context.deltaPlan.items
          .filter((item) => item.kind === 'added' || item.kind === 'changed')
          .map((item) => targetById.get(item.unitId))
          .filter((unit): unit is ContentUnitVersion => unit !== undefined)
      : [...context.targetUnits];
    if (vectorCanClone) {
      for (const item of context.deltaPlan.items) {
        if (!['unchanged', 'moved', 'visibility-changed'].includes(item.kind) || item.nextUnitVersionId === null) continue;
        const unit = targetById.get(item.unitId);
        if (unit === undefined) return { ok: false, summary: 'Reusable vector lineage is incomplete.', cancelled: false };
        const reused = await this.#vectorIndex.reuse(
          generation.spaceId,
          generation.generationId,
          item.unitId,
          item.nextUnitVersionId,
          this.#indexMetadata(unit)
        );
        if (!reused.ok) return { ok: false, summary: reused.summary, cancelled: reused.code === 'cancelled' };
      }
    }
    if (this.#keywordIndex !== undefined && keywordCanClone) {
      for (const item of context.deltaPlan.items) {
        if (!['unchanged', 'moved', 'visibility-changed'].includes(item.kind) || item.nextUnitVersionId === null) continue;
        const unit = targetById.get(item.unitId);
        if (unit === undefined) return { ok: false, summary: 'Reusable keyword lineage is incomplete.', cancelled: false };
        const reused = await this.#keywordIndex.reuse(
          generation.spaceId,
          generation.generationId,
          item.unitId,
          item.nextUnitVersionId,
          this.#indexMetadata(unit)
        );
        if (!reused.ok) return { ok: false, summary: reused.summary, cancelled: reused.code === 'cancelled' };
      }
    }
    const vectorWrite = await this.#embedAndUpsert(generation, freshVector, options);
    if (!vectorWrite.ok) return vectorWrite;
    if (this.#keywordIndex !== undefined) {
      const keywordWrite = await this.#keywordUpsert(generation, freshKeyword, options);
      if (!keywordWrite.ok) return keywordWrite;
    }
    const deleteReceipts: DeleteReceipt[] = [];
    for (const item of context.deltaPlan.items) {
      if (!['deleted', 'quarantined', 'unknown'].includes(item.kind) || item.previousUnitVersionId === null) continue;
      const vectorDelete = vectorCanClone
        ? await this.#vectorIndex.delete(generation.spaceId, generation.generationId, [item.unitId])
        : { ok: true as const, value: { deleted: [] } };
      const keywordDelete = this.#keywordIndex === undefined || !keywordCanClone
        ? { ok: true as const, value: { deleted: [] } }
        : await this.#keywordIndex.delete(generation.spaceId, generation.generationId, [item.unitId]);
      if (!vectorDelete.ok || !keywordDelete.ok) {
        const summary = !vectorDelete.ok
          ? vectorDelete.summary
          : !keywordDelete.ok
            ? keywordDelete.summary
            : 'Index deletion failed.';
        const cancelled = (!vectorDelete.ok && vectorDelete.code === 'cancelled') ||
          (!keywordDelete.ok && keywordDelete.code === 'cancelled');
        return {
          ok: false,
          summary,
          cancelled
        };
      }
      deleteReceipts.push({
        spaceId: generation.spaceId,
        generationId: generation.generationId,
        unitId: item.unitId,
        unitVersionId: item.previousUnitVersionId,
        vectorDeleted: true,
        keywordDeleted: true,
        observedAt: this.#clock.now()
      });
    }
    return { ok: true, deleteReceipts };
  }

  async #embedAndUpsert(
    generation: IndexGeneration,
    units: readonly ContentUnitVersion[],
    options: ExecutionOptions
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly summary: string; readonly cancelled: boolean }> {
    const batchSize = Math.max(1, this.#embeddingModel.capabilities.maxBatchSize);
    for (let offset = 0; offset < units.length; offset += batchSize) {
      if (isAborted(options)) return { ok: false, summary: 'Embedding was cancelled.', cancelled: true };
      const batch = units.slice(offset, offset + batchSize);
      const loaded = await Promise.all(batch.map((unit) => this.#contentStore.get(unit.text)));
      if (loaded.some((value) => !value.ok)) return { ok: false, summary: 'Content unit text could not be loaded.', cancelled: false };
      const texts = loaded.map((value) => new TextDecoder().decode(value.ok ? value.value : new Uint8Array()));
      const embedded = await this.#embeddingModel.embed(texts, options);
      if (!embedded.ok) return { ok: false, summary: embedded.summary, cancelled: embedded.code === 'cancelled' };
      if (embedded.vectors.length !== batch.length) return { ok: false, summary: 'Embedding model returned the wrong vector count.', cancelled: false };
      const records: VectorRecord[] = batch.map((unit, index) => ({
        unitId: unit.identity.unitId,
        unitVersionId: unit.unitVersionId,
        vector: embedded.vectors[index]!,
        metadata: this.#indexMetadata(unit)
      }));
      const written = await this.#vectorIndex.upsert(generation.spaceId, generation.generationId, records, options);
      if (!written.ok) return { ok: false, summary: written.summary, cancelled: written.code === 'cancelled' };
    }
    return { ok: true };
  }

  async #keywordUpsert(
    generation: IndexGeneration,
    units: readonly ContentUnitVersion[],
    options: ExecutionOptions
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly summary: string; readonly cancelled: boolean }> {
    if (this.#keywordIndex === undefined) return { ok: true };
    const records: KeywordRecord[] = [];
    for (const unit of units) {
      if (isAborted(options)) return { ok: false, summary: 'Keyword indexing was cancelled.', cancelled: true };
      const loaded = await this.#contentStore.get(unit.text);
      if (!loaded.ok) return { ok: false, summary: loaded.error.summary, cancelled: false };
      records.push({
        unitId: unit.identity.unitId,
        unitVersionId: unit.unitVersionId,
        text: new TextDecoder().decode(loaded.value),
        metadata: this.#indexMetadata(unit)
      });
    }
    const written = await this.#keywordIndex.upsert(generation.spaceId, generation.generationId, records, options);
    return written.ok
      ? { ok: true }
      : { ok: false, summary: written.summary, cancelled: written.code === 'cancelled' };
  }

  #indexMetadata(unit: ContentUnitVersion): JsonValue {
    return asWireValue({
      spaceId: unit.spaceId,
      sourceId: unit.identity.sourceId,
      revisionId: unit.revisionId,
      unitId: unit.identity.unitId,
      unitVersionId: unit.unitVersionId,
      visibility: unit.visibility,
      visibilityDigest: unit.visibilityDigest,
      metadata: unit.metadata,
      metadataDigest: unit.metadataDigest,
      locator: unit.locator,
      disposition: unit.disposition
    });
  }

  async #allRevisionUnits(spaceId: SpaceId, revisionId: RevisionId): Promise<ContentUnitVersion[]> {
    const values: ContentUnitVersion[] = [];
    let after: string | undefined;
    do {
      const page = after === undefined
        ? await this.#repository.listContentUnitsForRevision(spaceId, revisionId, { limit: 1_000 })
        : await this.#repository.listContentUnitsForRevision(spaceId, revisionId, { limit: 1_000, after });
      values.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    return values;
  }

  async #adapterManifestDigest(): Promise<DigestRef> {
    const result = await digestCanonicalJson({
      embeddingModel: {
        descriptor: this.#embeddingModel.descriptor,
        capabilities: this.#embeddingModel.capabilities
      },
      vectorIndex: {
        descriptor: this.#vectorIndex.descriptor,
        capabilities: this.#vectorIndex.capabilities
      },
      keywordIndex: this.#keywordIndex === undefined ? null : {
        descriptor: this.#keywordIndex.descriptor,
        capabilities: this.#keywordIndex.capabilities
      }
    });
    if (!result.ok) throw new TypeError(result.error.summary);
    return result.value;
  }

  #adaptersMatchGeneration(generation: IndexGeneration): boolean {
    return generation.embedding.adapterId === this.#embeddingModel.descriptor.adapterId &&
      generation.embedding.model === this.#embeddingModel.capabilities.model &&
      generation.embedding.version === this.#embeddingModel.descriptor.version &&
      generation.embedding.deploymentFingerprint === this.#embeddingModel.descriptor.deploymentFingerprint &&
      generation.embedding.dimension === this.#embeddingModel.capabilities.dimension &&
      generation.vectorIndex.adapterId === this.#vectorIndex.descriptor.adapterId &&
      generation.vectorIndex.version === this.#vectorIndex.descriptor.version &&
      generation.vectorIndex.deploymentFingerprint === this.#vectorIndex.descriptor.deploymentFingerprint &&
      ((generation.keywordIndex === null && this.#keywordIndex === undefined) ||
        (generation.keywordIndex !== null && this.#keywordIndex !== undefined &&
          generation.keywordIndex.adapterId === this.#keywordIndex.descriptor.adapterId &&
          generation.keywordIndex.version === this.#keywordIndex.descriptor.version &&
          generation.keywordIndex.deploymentFingerprint === this.#keywordIndex.descriptor.deploymentFingerprint));
  }

  async #claim(run: ProcessingRun, options: ExecutionOptions) {
    const now = this.#clock.now();
    const leaseMilliseconds = options.leaseMilliseconds ?? 60_000;
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      return {
        ok: false as const,
        error: { code: 'state-conflict' as const, summary: 'leaseMilliseconds must be positive.', retryable: false },
        current: null
      };
    }
    return this.#repository.acquireRunClaim({
      spaceId: run.spaceId,
      runId: run.runId,
      workerId: options.workerId ?? 'local-worker',
      now,
      leaseUntil: addMilliseconds(now, leaseMilliseconds)
    });
  }

  async #transition(
    generation: IndexGeneration,
    status: 'building',
    run: ProcessingRun,
    claim: RunClaim,
    envelope: DurableCommandEnvelope<BuildGenerationCommand>,
    eventType: string
  ) {
    const next: IndexGeneration = {
      ...generation,
      status,
      sequence: generation.sequence + 1,
      updatedAt: this.#clock.now()
    };
    const event = await this.#event(envelope, 'generation', generation.generationId, eventType, {
      generationId: generation.generationId,
      status
    });
    const committed = await this.#internalCommit(
      generation.spaceId,
      {
        run: { runId: run.runId, sequence: run.sequence, status: 'partial' },
        generation: { generationId: generation.generationId, sequence: generation.sequence, status: generation.status },
        fencingToken: claim.fencingToken
      },
      `generation-${status}:${generation.generationId}:${claim.fencingToken}`,
      { kind: `generation-${status}`, generationId: generation.generationId },
      { generations: [next], events: [event] }
    );
    return committed.ok ? { ok: true as const, value: next } : committed;
  }

  async #finishBuild(
    generation: IndexGeneration,
    claim: RunClaim,
    envelope: DurableCommandEnvelope<BuildGenerationCommand>,
    status: 'failed' | 'cancelled',
    summary: string
  ): Promise<LorebitOutcome<GenerationBuildResult>> {
    const operation = operationRef(envelope.operationId);
    const run = await this.#repository.getRun(generation.spaceId, generation.runId);
    if (run === null) return failed(lorebitFailure('integrity-check-failed', 'Generation run disappeared.'), operation);
    const next: IndexGeneration = {
      ...generation,
      status,
      sequence: generation.sequence + 1,
      diagnostics: [...generation.diagnostics, diagnostic(`generation-${status}`, status === 'failed' ? 'error' : 'warning', summary)],
      updatedAt: this.#clock.now()
    };
    const failedRun: ProcessingRun = {
      ...run,
      status,
      sequence: run.sequence + 1,
      stages: [
        ...run.stages,
        {
          stage: 'index',
          attempt: claim.attempt,
          status,
          startedAt: generation.updatedAt,
          completedAt: next.updatedAt,
          inputDigest: generation.inputManifestDigest,
          outputDigest: null,
          diagnostics: next.diagnostics
        }
      ],
      diagnostics: [...run.diagnostics, ...next.diagnostics],
      updatedAt: next.updatedAt,
      completedAt: next.updatedAt
    };
    const event = await this.#event(envelope, 'generation', generation.generationId, `generation.${status}`, {
      generationId: generation.generationId,
      summary
    });
    const runEvent = await this.#event(envelope, 'run', run.runId, `processing.run-${status}`, {
      runId: run.runId,
      generationId: generation.generationId,
      summary
    });
    const committed = await this.#internalCommit(
      generation.spaceId,
      {
        run: { runId: run.runId, sequence: run.sequence, status: 'partial' },
        generation: { generationId: generation.generationId, sequence: generation.sequence, status: generation.status },
        fencingToken: claim.fencingToken
      },
      `generation-${status}:${generation.generationId}:${claim.fencingToken}`,
      { kind: `generation-${status}`, generationId: generation.generationId },
      { processingRun: failedRun, generations: [next], events: [event, runEvent] }
    );
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(generation.spaceId, committed);
    return failed(lorebitFailure(status === 'cancelled' ? 'cancelled' : 'generation-failure', summary), operation, next.diagnostics);
  }

  async #internalCommit(
    spaceId: SpaceId,
    expected: import('../commands.js').ExpectedState,
    idempotencyKey: string,
    outcome: unknown,
    writes: import('../../ports/knowledge-repository.js').RepositoryWriteSet
  ) {
    const operationId = this.#ids.next('operation');
    const commandDigest = await digestCanonicalJson({ idempotencyKey, outcome });
    if (!commandDigest.ok) throw new TypeError(commandDigest.error.summary);
    return this.#repository.commit({
      spaceId,
      expected,
      operation: {
        spaceId,
        operationId,
        idempotencyKey,
        commandDigest: commandDigest.value,
        outcome: asWireValue(outcome),
        committedAt: this.#clock.now()
      },
      writes
    });
  }

  async #event(
    envelope: DurableCommandEnvelope<ProcessingCommandPayload>,
    kind: LifecycleEvent['aggregate']['kind'],
    aggregateId: string,
    eventType: string,
    payload: unknown
  ): Promise<LifecycleEvent> {
    const page = await this.#repository.listEvents(envelope.payload.spaceId, { limit: 1_000 }, aggregateId);
    const wirePayload = asWireValue(payload);
    const payloadDigest = await digestCanonicalJson(wirePayload);
    if (!payloadDigest.ok) throw new TypeError(payloadDigest.error.summary);
    return {
      schemaVersion: '1.0',
      eventId: this.#ids.next('event'),
      eventType,
      aggregate: { kind, id: aggregateId, spaceId: envelope.payload.spaceId },
      aggregateSequence: (page.items.at(-1)?.aggregateSequence ?? 0) + 1,
      operationId: envelope.operationId,
      causationId: envelope.operationId,
      correlationId: envelope.operationId,
      ...(currentExecutionTrace(envelope.operationId) === null ? {} : { traceContext: currentExecutionTrace(envelope.operationId)! }),
      occurredAt: this.#clock.now(),
      payloadDigest: payloadDigest.value,
      payload: wirePayload
    };
  }

  async #deliver(spaceId: SpaceId, commit: Extract<RepositoryCommitResult, { ok: true }>): Promise<void> {
    if (commit.events.length === 0) return;
    try {
      const delivered = await this.#eventSink.publish(commit.events);
      if (delivered.ok) {
        await this.#repository.markOutboxDelivered(
          spaceId,
          commit.events.map((event) => event.eventId),
          this.#clock.now()
        );
      }
    } catch {
      // Canonical facts and outbox remain committed for explicit replay.
    }
  }
}
