import type {
  CancelProcessingRunCommand,
  DurableCommandEnvelope,
  ExecutionOptions,
  ProcessingCommandPayload,
  ResumeProcessingCommand,
  RunProcessingCommand
} from '../commands.js';
import { validateDurableCommandEnvelope } from '../commands.js';
import { digestCanonicalJson, digestBytes } from '../../wire/digest.js';
import { decodeJsonValue, type JsonValue } from '../../wire/json-value.js';
import type { Rfc3339Utc } from '../../wire/rfc3339.js';
import { currentExecutionTrace } from '../execution-observability.js';
import { diagnostic, lorebitFailure, type Diagnostic } from '../../domain/diagnostics.js';
import type { ContentUnitVersion, TransformedContentUnit } from '../../domain/content-unit.js';
import { summarizeDelta, type DeltaItem, type DeltaPlan } from '../../domain/delta-plan.js';
import type { LifecycleEvent } from '../../domain/events.js';
import {
  createLorebitId,
  type IdGenerator,
  type OperationId,
  type SpaceId
} from '../../domain/ids.js';
import { failed, successful, type LorebitOutcome, type OperationRef } from '../../domain/outcomes.js';
import type { ProcessingResourceLimits, ProcessingRun, StageRun } from '../../domain/processing.js';
import type { Source } from '../../domain/source.js';
import {
  canTransitionRevision,
  type ProcessingRecipeVersion,
  type RevisionState,
  type SourceRevision
} from '../../domain/versions.js';
import type { Clock } from '../../ports/clock.js';
import type { ContentStore } from '../../ports/content-store.js';
import type { ContentTransformer } from '../../ports/content-transformer.js';
import type { EventSink } from '../../ports/event-sink.js';
import type {
  KnowledgeRepository,
  RepositoryCommitResult,
  RepositoryFailure,
  RunClaim
} from '../../ports/knowledge-repository.js';

export interface ProcessingRunResult {
  readonly run: ProcessingRun;
  readonly deltaPlan: DeltaPlan;
  readonly units: readonly ContentUnitVersion[];
}

interface ProcessingServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly contentStore: ContentStore;
  readonly transformer: ContentTransformer;
  readonly eventSink: EventSink;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly limits: ProcessingResourceLimits;
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

function sameDigest(
  left: import('../../wire/digest.js').DigestRef,
  right: import('../../wire/digest.js').DigestRef
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function mapRepositoryFailure(error: RepositoryFailure) {
  return lorebitFailure(error.code, error.summary, error.retryable);
}

export class ProcessingService {
  readonly #repository: KnowledgeRepository;
  readonly #contentStore: ContentStore;
  readonly #transformer: ContentTransformer;
  readonly #eventSink: EventSink;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #limits: ProcessingResourceLimits;

  constructor(dependencies: ProcessingServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#contentStore = dependencies.contentStore;
    this.#transformer = dependencies.transformer;
    this.#eventSink = dependencies.eventSink;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#limits = dependencies.limits;
  }

  async estimateBytes(envelope: DurableCommandEnvelope<RunProcessingCommand | ResumeProcessingCommand | CancelProcessingRunCommand>): Promise<number> {
    if (envelope.payload.type === 'processing.cancel') return 0;
    const revisionId = envelope.payload.type === 'processing.run'
      ? envelope.payload.revisionId
      : (await this.#repository.getRun(envelope.payload.spaceId, envelope.payload.runId))?.revisionId ?? null;
    if (revisionId === null) return 0;
    const revision = await this.#repository.getRevision(envelope.payload.spaceId, revisionId);
    if (revision === null) return 0;
    const expanded = Math.ceil(revision.revision.snapshot.content.byteLength * Math.max(1, this.#transformer.capabilities.maxExpansionRatio));
    return Math.min(this.#limits.maxNormalizedBytes, expanded);
  }

  async run(
    envelope: DurableCommandEnvelope<RunProcessingCommand>,
    options: ExecutionOptions = {}
  ): Promise<LorebitOutcome<ProcessingRunResult>> {
    const operation = operationRef(envelope.operationId);
    const validation = validateDurableCommandEnvelope(envelope);
    if (!validation.ok) {
      return failed(lorebitFailure(validation.error.code, validation.error.summary), operation);
    }
    if (
      envelope.expected.source?.sourceId !== envelope.payload.sourceId ||
      envelope.expected.source.revisionId !== envelope.payload.revisionId ||
      envelope.expected.recipeId !== envelope.payload.recipeId
    ) {
      return failed(
        lorebitFailure(
          'invalid-request',
          'processing.run requires expected source revision and recipe.'
        ),
        operation
      );
    }
    const digest = await digestCanonicalJson(envelope);
    if (!digest.ok) return failed(lorebitFailure('schema-invalid', digest.error.summary), operation);
    const existing = await this.#repository.getOperation(
      envelope.payload.spaceId,
      envelope.idempotencyKey
    );
    if (existing !== null) {
      if (existing.commandDigest.value !== digest.value.value) {
        return failed(lorebitFailure('idempotency-conflict', 'Idempotency key payload changed.'), operation);
      }
      return this.#replayRun(envelope.payload.spaceId, envelope.payload.runId, operation);
    }

    const [revision, recipe, source, baseGeneration] = await Promise.all([
      this.#repository.getRevision(envelope.payload.spaceId, envelope.payload.revisionId),
      this.#repository.getRecipe(envelope.payload.spaceId, envelope.payload.recipeId),
      this.#repository.getSource(envelope.payload.spaceId, envelope.payload.sourceId),
      envelope.payload.baseGenerationId === null
        ? Promise.resolve(null)
        : this.#repository.getGeneration(
            envelope.payload.spaceId,
            envelope.payload.baseGenerationId
          )
    ]);
    if (
      revision === null ||
      revision.revision.sourceId !== envelope.payload.sourceId ||
      recipe === null ||
      source === null
    ) {
      return failed(lorebitFailure('not-found', 'Revision, source or recipe was not found.'), operation);
    }
    if (['superseded', 'withdrawn', 'archived'].includes(revision.state.status)) {
      return failed(lorebitFailure('invalid-state-transition', `Cannot process a ${revision.state.status} revision.`), operation);
    }
    if (
      envelope.payload.baseGenerationId !== null &&
      (baseGeneration === null || !['ready', 'active', 'retired'].includes(baseGeneration.status))
    ) {
      return failed(lorebitFailure('generation-stale', 'Base generation is unavailable.'), operation);
    }
    if (!await this.#contentStore.has(revision.revision.snapshot.content)) {
      return failed(lorebitFailure('not-found', 'Revision content is unavailable.'), operation);
    }
    const inputDigest = await digestCanonicalJson({
      revisionId: revision.revision.revisionId,
      revisionDigest: revision.revision.snapshot.normalizedDigest,
      recipeId: recipe.recipeId,
      recipeFingerprint: recipe.fingerprint,
      baseGenerationId: envelope.payload.baseGenerationId
    });
    if (!inputDigest.ok) throw new TypeError(inputDigest.error.summary);
    const run: ProcessingRun = {
      schemaVersion: '1.0',
      runId: envelope.payload.runId,
      spaceId: envelope.payload.spaceId,
      sourceId: envelope.payload.sourceId,
      revisionId: envelope.payload.revisionId,
      recipeId: envelope.payload.recipeId,
      generationId: envelope.payload.generationId,
      baseGenerationId: envelope.payload.baseGenerationId,
      status: 'running',
      sequence: 1,
      cancellationRequested: false,
      stages: [],
      deltaPlanId: null,
      unitCount: 0,
      inputDigest: inputDigest.value,
      outputDigest: null,
      diagnostics: [],
      startedAt: envelope.occurredAt,
      updatedAt: envelope.occurredAt,
      completedAt: null,
      actorRef: actor(envelope),
      reason: envelope.reason,
      metadata: {},
      components: {
        transformer: {
          adapterId: this.#transformer.descriptor.adapterId,
          version: this.#transformer.descriptor.version,
          deploymentFingerprint: this.#transformer.descriptor.deploymentFingerprint
        },
        recipeFingerprint: recipe.fingerprint
      }
    };
    const startEvent = await this.#event(
      envelope,
      run.runId,
      'processing.run-started',
      { runId: run.runId, revisionId: run.revisionId, recipeId: run.recipeId }
    );
    const processingState = this.#processingState(revision.state, envelope);
    const events = [startEvent];
    if (processingState !== null) {
      events.push(await this.#revisionEvent(
        envelope,
        revision.revision.revisionId,
        'revision.processing-started',
        { revisionId: revision.revision.revisionId, runId: run.runId }
      ));
    }
    const committed = await this.#repository.commit({
      spaceId: run.spaceId,
      expected: envelope.expected,
      operation: {
        spaceId: run.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: digest.value,
        outcome: { kind: 'processing-run-started', runId: run.runId },
        committedAt: this.#clock.now()
      },
      writes: {
        processingRun: run,
        ...(processingState === null ? {} : { revisionState: processingState }),
        events
      }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(run.spaceId, committed);
    const claim = await this.#claim(run, options);
    if (!claim.ok) return failed(mapRepositoryFailure(claim.error), operation);
    return this.#process(run, revision.revision, source, recipe, claim.value, envelope, options);
  }

  async resume(
    envelope: DurableCommandEnvelope<ResumeProcessingCommand>,
    options: ExecutionOptions = {}
  ): Promise<LorebitOutcome<ProcessingRunResult>> {
    const operation = operationRef(envelope.operationId);
    const validation = validateDurableCommandEnvelope(envelope);
    if (!validation.ok) {
      return failed(lorebitFailure(validation.error.code, validation.error.summary), operation);
    }
    const digest = await digestCanonicalJson(envelope);
    if (!digest.ok) return failed(lorebitFailure('schema-invalid', digest.error.summary), operation);
    const existing = await this.#repository.getOperation(
      envelope.payload.spaceId,
      envelope.idempotencyKey
    );
    if (existing !== null) {
      if (existing.commandDigest.value !== digest.value.value) {
        return failed(lorebitFailure('idempotency-conflict', 'Idempotency key payload changed.'), operation);
      }
      return this.#replayRun(envelope.payload.spaceId, envelope.payload.runId, operation);
    }
    const run = await this.#repository.getRun(envelope.payload.spaceId, envelope.payload.runId);
    if (run === null) return failed(lorebitFailure('not-found', 'ProcessingRun was not found.'), operation);
    if (run.status === 'succeeded') {
      const result = await this.#loadResult(run.spaceId, run.runId);
      return result === null
        ? failed(lorebitFailure('integrity-check-failed', 'Completed run facts are incomplete.'), operation)
        : successful(result, operation);
    }
    if (!['running', 'partial', 'failed'].includes(run.status)) {
      return failed(lorebitFailure('invalid-state-transition', `Cannot resume a ${run.status} run.`), operation);
    }
    const [revision, recipe, source] = await Promise.all([
      this.#repository.getRevision(run.spaceId, run.revisionId),
      this.#repository.getRecipe(run.spaceId, run.recipeId),
      this.#repository.getSource(run.spaceId, run.sourceId)
    ]);
    if (revision === null || recipe === null || source === null) {
      return failed(lorebitFailure('not-found', 'Run revision, source or recipe is unavailable.'), operation);
    }
    if (['superseded', 'withdrawn', 'archived'].includes(revision.state.status)) {
      return failed(lorebitFailure('invalid-state-transition', `Cannot resume processing for a ${revision.state.status} revision.`), operation);
    }
    const resumed: ProcessingRun = run.status === 'running'
      ? run
      : {
          ...run,
          status: 'running',
          sequence: run.sequence + 1,
          cancellationRequested: false,
          updatedAt: envelope.occurredAt,
          completedAt: null
        };
    const event = await this.#event(envelope, run.runId, 'processing.run-resumed', {
      runId: run.runId,
      from: run.status,
      sequence: resumed.sequence
    });
    const processingState = this.#processingState(revision.state, envelope);
    const events = [event];
    if (processingState !== null) {
      events.push(await this.#revisionEvent(
        envelope,
        revision.revision.revisionId,
        'revision.processing-resumed',
        { revisionId: revision.revision.revisionId, runId: run.runId }
      ));
    }
    const committed = await this.#repository.commit({
      spaceId: run.spaceId,
      expected: envelope.expected,
      operation: {
        spaceId: run.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: digest.value,
        outcome: { kind: 'processing-run-resumed', runId: run.runId },
        committedAt: this.#clock.now()
      },
      writes: {
        ...(resumed === run ? {} : { processingRun: resumed }),
        ...(processingState === null ? {} : { revisionState: processingState }),
        events
      }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(run.spaceId, committed);
    const claim = await this.#claim(resumed, options);
    if (!claim.ok) return failed(mapRepositoryFailure(claim.error), operation);
    return this.#process(resumed, revision.revision, source, recipe, claim.value, envelope, options);
  }

  async cancel(
    envelope: DurableCommandEnvelope<CancelProcessingRunCommand>
  ): Promise<LorebitOutcome<ProcessingRun>> {
    const operation = operationRef(envelope.operationId);
    const validation = validateDurableCommandEnvelope(envelope);
    if (!validation.ok) {
      return failed(lorebitFailure(validation.error.code, validation.error.summary), operation);
    }
    const digest = await digestCanonicalJson(envelope);
    if (!digest.ok) throw new TypeError(digest.error.summary);
    const existing = await this.#repository.getOperation(
      envelope.payload.spaceId,
      envelope.idempotencyKey
    );
    if (existing !== null) {
      if (!sameDigest(existing.commandDigest, digest.value)) {
        return failed(lorebitFailure('idempotency-conflict', 'Idempotency key payload changed.'), operation);
      }
      const replayed = await this.#repository.getRun(envelope.payload.spaceId, envelope.payload.runId);
      return replayed === null
        ? failed(lorebitFailure('integrity-check-failed', 'Replayed cancelled run is missing.'), operation)
        : successful(replayed, operation, [diagnostic('idempotent-replay', 'info', 'Returned the durable cancellation state.')]);
    }
    const run = await this.#repository.getRun(envelope.payload.spaceId, envelope.payload.runId);
    if (run === null) return failed(lorebitFailure('not-found', 'ProcessingRun was not found.'), operation);
    if (!['queued', 'running', 'partial'].includes(run.status)) {
      return failed(lorebitFailure('invalid-state-transition', `Cannot cancel a ${run.status} run.`), operation);
    }
    const cancelled: ProcessingRun = {
      ...run,
      status: 'cancelled',
      sequence: run.sequence + 1,
      cancellationRequested: true,
      updatedAt: envelope.occurredAt,
      completedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, run.runId, 'processing.run-cancelled', {
      runId: run.runId,
      previousStatus: run.status
    });
    const revision = await this.#repository.getRevision(run.spaceId, run.revisionId);
    const revisionState = revision?.state.status === 'processing'
      ? this.#terminalRevisionState(revision.state, envelope, 'Processing was cancelled.')
      : null;
    const events = [event];
    if (revisionState !== null) {
      events.push(await this.#revisionEvent(
        envelope,
        run.revisionId,
        'revision.processing-failed',
        { revisionId: run.revisionId, runId: run.runId, cause: 'cancelled' }
      ));
    }
    const committed = await this.#repository.commit({
      spaceId: run.spaceId,
      expected: envelope.expected,
      operation: {
        spaceId: run.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: digest.value,
        outcome: asWireValue({ kind: 'processing-run-cancelled', runId: run.runId }),
        committedAt: this.#clock.now()
      },
      writes: {
        processingRun: cancelled,
        ...(revisionState === null ? {} : { revisionState }),
        events
      }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(run.spaceId, committed);
    return successful(cancelled, operation);
  }

  async #process(
    run: ProcessingRun,
    revision: SourceRevision,
    source: Source,
    recipe: ProcessingRecipeVersion,
    claim: RunClaim,
    envelope: DurableCommandEnvelope<RunProcessingCommand | ResumeProcessingCommand>,
    options: ExecutionOptions
  ): Promise<LorebitOutcome<ProcessingRunResult>> {
    const operation = operationRef(envelope.operationId);
    const loaded = await this.#contentStore.get(revision.snapshot.content);
    if (!loaded.ok) {
      return this.#finishFailure(run, claim, envelope, 'failed', 'Revision content could not be loaded.');
    }
    if (loaded.value.byteLength > this.#limits.maxSourceBytes) {
      return this.#finishFailure(
        run,
        claim,
        envelope,
        'failed',
        `Source exceeds the configured ${this.#limits.maxSourceBytes} byte processing limit.`
      );
    }
    const transformed = await this.#transformer.transform({
      revision,
      source,
      recipe,
      content: loaded.value,
      options
    });
    if (!transformed.ok) {
      return this.#finishFailure(
        run,
        claim,
        envelope,
        transformed.code === 'cancelled' ? 'cancelled' : 'failed',
        transformed.summary,
        transformed.diagnostics
      );
    }
    const uniqueKeys = new Set(transformed.units.map((unit) => unit.stableKey));
    if (
      uniqueKeys.size !== transformed.units.length ||
      transformed.units.some((unit) => unit.stableKey.length === 0)
    ) {
      return this.#finishFailure(
        run,
        claim,
        envelope,
        'failed',
        'Transformer returned duplicate or empty stable unit keys.'
      );
    }
    const outputBytes = transformed.units.reduce(
      (total, unit) => total + new TextEncoder().encode(unit.text).byteLength,
      0
    );
    if (
      transformed.units.length > this.#limits.maxUnitsPerRevision ||
      outputBytes > this.#limits.maxNormalizedBytes ||
      transformed.units.some(
        (unit) => new TextEncoder().encode(unit.text).byteLength > this.#limits.maxUnitBytes
      )
    ) {
      return this.#finishFailure(
        run,
        claim,
        envelope,
        'failed',
        'Transformed content exceeds a configured processing resource limit.'
      );
    }
    const maxBytes = Math.max(
      loaded.value.byteLength,
      Math.floor(loaded.value.byteLength * this.#transformer.capabilities.maxExpansionRatio)
    );
    if (outputBytes > maxBytes) {
      return this.#finishFailure(
        run,
        claim,
        envelope,
        'failed',
        'Transformer output exceeded its declared expansion ratio.'
      );
    }
    const baseUnits = await this.#baseUnits(run);
    const units: ContentUnitVersion[] = [];
    const unitsToWrite: ContentUnitVersion[] = [];
    for (const transformedUnit of transformed.units) {
      const unit = await this.#materializeUnit(
        run,
        revision,
        recipe,
        transformedUnit,
        baseUnits
      );
      if (!unit.ok) {
        return this.#finishFailure(run, claim, envelope, 'failed', unit.summary);
      }
      units.push(unit.value);
      if (unit.write) unitsToWrite.push(unit.value);
    }
    const deltaPlan = await this.#planDelta(run, units, baseUnits);
    const outputDigest = await digestCanonicalJson({
      units: units.map((unit) => unit.unitVersionId),
      deltaPlan: deltaPlan.planDigest
    });
    if (!outputDigest.ok) throw new TypeError(outputDigest.error.summary);
    const now = this.#clock.now();
    const stages = await this.#stages(run, revision, units, deltaPlan, now);
    const current = await this.#repository.getRun(run.spaceId, run.runId);
    if (current?.cancellationRequested === true || options.signal?.aborted === true) {
      return this.#finishFailure(run, claim, envelope, 'cancelled', 'Processing was cancelled.');
    }
    const completed: ProcessingRun = {
      ...run,
      status: 'partial',
      sequence: run.sequence + 1,
      stages,
      deltaPlanId: deltaPlan.deltaPlanId,
      unitCount: units.length,
      outputDigest: outputDigest.value,
      diagnostics: transformed.diagnostics,
      updatedAt: now,
      completedAt: null
    };
    const event = await this.#event(envelope, run.runId, 'processing.content-prepared', {
      runId: run.runId,
      deltaPlanId: deltaPlan.deltaPlanId,
      unitCount: units.length,
      outputDigest: completed.outputDigest
    });
    const internalOperationId = this.#ids.next('operation');
    const internalDigest = await digestCanonicalJson({
      runId: run.runId,
      fencingToken: claim.fencingToken,
      outputDigest: completed.outputDigest
    });
    if (!internalDigest.ok) throw new TypeError(internalDigest.error.summary);
    const committed = await this.#repository.commit({
      spaceId: run.spaceId,
      expected: {
        run: { runId: run.runId, sequence: run.sequence, status: 'running' },
        fencingToken: claim.fencingToken
      },
      operation: {
        spaceId: run.spaceId,
        operationId: internalOperationId,
        idempotencyKey: `run-complete:${run.runId}:${claim.fencingToken}`,
        commandDigest: internalDigest.value,
        outcome: asWireValue({ kind: 'processing-content-prepared', runId: run.runId }),
        committedAt: now
      },
      writes: { contentUnits: unitsToWrite, deltaPlan, processingRun: completed, events: [event] }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(run.spaceId, committed);
    return successful({ run: completed, deltaPlan, units }, operation);
  }

  async #materializeUnit(
    run: ProcessingRun,
    revision: SourceRevision,
    recipe: ProcessingRecipeVersion,
    transformed: TransformedContentUnit,
    baseUnits: readonly ContentUnitVersion[]
  ): Promise<
    | { readonly ok: true; readonly value: ContentUnitVersion; readonly write: boolean }
    | { readonly ok: false; readonly summary: string }
  > {
    const identityDigest = await digestCanonicalJson({
      spaceId: run.spaceId,
      sourceId: run.sourceId,
      stableKey: transformed.stableKey
    });
    if (!identityDigest.ok) return { ok: false, summary: identityDigest.error.summary };
    const unitId = createLorebitId('unit', identityDigest.value.value.slice(0, 40));
    const textBytes = new TextEncoder().encode(transformed.text);
    const textDigest = await digestBytes(textBytes);
    const contentId = createLorebitId('content', textDigest.value.slice(0, 40));
    const textRef = {
      schemaVersion: '1.0' as const,
      spaceId: run.spaceId,
      contentId,
      mediaType: 'text/plain; charset=utf-8',
      byteLength: textBytes.byteLength,
      digest: textDigest
    };
    const stored = await this.#contentStore.putImmutable({ ref: textRef, bytes: textBytes });
    if (!stored.ok) return { ok: false, summary: stored.error.summary };
    const predecessor = baseUnits.find((unit) => unit.identity.unitId === unitId) ?? null;
    const metadataDigest = await digestCanonicalJson(transformed.metadata);
    const visibilityDigest = await digestCanonicalJson(transformed.visibility);
    if (!metadataDigest.ok || !visibilityDigest.ok) {
      return { ok: false, summary: 'ContentUnitVersion metadata digest failed.' };
    }
    const versionDigest = await digestCanonicalJson({
      unitId,
      revisionId: revision.revisionId,
      recipeId: recipe.recipeId,
      predecessorUnitVersionId: predecessor?.unitVersionId ?? null,
      textDigest,
      locator: transformed.locator,
      metadataDigest: metadataDigest.value,
      visibilityDigest: visibilityDigest.value,
      disposition: transformed.disposition
    });
    if (!versionDigest.ok) return { ok: false, summary: versionDigest.error.summary };
    const value: ContentUnitVersion = {
        schemaVersion: '1.0',
        unitVersionId: createLorebitId('unit-version', versionDigest.value.value.slice(0, 40)),
        spaceId: run.spaceId,
        identity: { unitId, spaceId: run.spaceId, sourceId: run.sourceId, stableKey: transformed.stableKey },
        revisionId: revision.revisionId,
        recipeId: recipe.recipeId,
        predecessorUnitVersionId: predecessor?.unitVersionId ?? null,
        text: textRef,
        textDigest,
        locator: transformed.locator,
        metadata: transformed.metadata,
        metadataDigest: metadataDigest.value,
        visibility: transformed.visibility,
        visibilityDigest: visibilityDigest.value,
        disposition: transformed.disposition,
        createdAt: this.#clock.now()
    };
    const existing = await this.#repository.getContentUnitVersion(
      run.spaceId,
      value.unitVersionId
    );
    if (existing !== null) {
      const { createdAt: _existingCreatedAt, ...existingFacts } = existing;
      const { createdAt: _nextCreatedAt, ...nextFacts } = value;
      const [existingDigest, nextDigest] = await Promise.all([
        digestCanonicalJson(existingFacts),
        digestCanonicalJson(nextFacts)
      ]);
      if (
        !existingDigest.ok ||
        !nextDigest.ok ||
        !sameDigest(existingDigest.value, nextDigest.value)
      ) {
        return { ok: false, summary: 'Existing ContentUnitVersion conflicts with deterministic output.' };
      }
      return { ok: true, value: existing, write: false };
    }
    return {
      ok: true,
      value,
      write: true
    };
  }

  async #baseUnits(run: ProcessingRun): Promise<ContentUnitVersion[]> {
    if (run.baseGenerationId === null) return [];
    const generation = await this.#repository.getGeneration(run.spaceId, run.baseGenerationId);
    if (generation === null) return [];
    const units = await Promise.all(
      generation.unitVersionIds.map((id) =>
        this.#repository.getContentUnitVersion(run.spaceId, id)
      )
    );
    return units.filter(
      (unit): unit is ContentUnitVersion => unit !== null && unit.identity.sourceId === run.sourceId
    );
  }

  async #planDelta(
    run: ProcessingRun,
    units: readonly ContentUnitVersion[],
    baseUnits: readonly ContentUnitVersion[]
  ): Promise<DeltaPlan> {
    const nextById = new Map(units.map((unit) => [unit.identity.unitId, unit]));
    const baseById = new Map(baseUnits.map((unit) => [unit.identity.unitId, unit]));
    const unitIds = Array.from(new Set([...nextById.keys(), ...baseById.keys()]))
      .sort((left, right) => left.localeCompare(right, 'en'));
    const items: DeltaItem[] = unitIds.map((unitId) => {
      const previous = baseById.get(unitId) ?? null;
      const next = nextById.get(unitId) ?? null;
      if (previous === null) {
        const disposition = next?.disposition;
        return {
          unitId,
          kind: disposition === 'quarantined'
            ? 'quarantined'
            : disposition === 'unknown'
              ? 'unknown'
              : 'added',
          previousUnitVersionId: null,
          nextUnitVersionId: next?.unitVersionId ?? null,
          reuse: 'none',
          reason: disposition === 'quarantined'
            ? 'The new candidate unit is quarantined.'
            : disposition === 'unknown'
              ? 'The new candidate unit disposition is unknown and fails closed.'
              : 'Stable unit identity is new in the candidate revision.'
        };
      }
      if (next === null) {
        return {
          unitId,
          kind: 'deleted',
          previousUnitVersionId: previous.unitVersionId,
          nextUnitVersionId: null,
          reuse: 'none',
          reason: 'Stable unit identity is absent from the candidate revision.'
        };
      }
      const sameText = previous.textDigest.value === next.textDigest.value;
      const sameLocator = JSON.stringify(previous.locator) === JSON.stringify(next.locator);
      const sameMetadata = previous.metadataDigest.value === next.metadataDigest.value;
      const sameVisibility = previous.visibilityDigest.value === next.visibilityDigest.value;
      if (next.disposition === 'quarantined') {
        return {
          unitId,
          kind: 'quarantined',
          previousUnitVersionId: previous.unitVersionId,
          nextUnitVersionId: next.unitVersionId,
          reuse: 'none',
          reason: 'The candidate unit is quarantined and cannot reuse searchable artifacts.'
        };
      }
      if (next.disposition === 'unknown') {
        return {
          unitId,
          kind: 'unknown',
          previousUnitVersionId: previous.unitVersionId,
          nextUnitVersionId: next.unitVersionId,
          reuse: 'none',
          reason: 'The candidate unit disposition is unknown and fails closed.'
        };
      }
      if (!sameVisibility) {
        return {
          unitId,
          kind: 'visibility-changed',
          previousUnitVersionId: previous.unitVersionId,
          nextUnitVersionId: next.unitVersionId,
          reuse: sameText ? 'embedding-only' : 'none',
          reason: 'Visibility projection changed and all searchable index projections must be rewritten.'
        };
      }
      return {
        unitId,
        kind: sameText && sameMetadata ? (sameLocator ? 'unchanged' : 'moved') : 'changed',
        previousUnitVersionId: previous.unitVersionId,
        nextUnitVersionId: next.unitVersionId,
        reuse: sameText && sameMetadata ? 'embedding-and-index' : 'none',
        reason: sameText && sameMetadata
          ? sameLocator
            ? 'Content and locator are unchanged; artifact values are reusable.'
            : 'Content is unchanged but locator moved; artifact values are reusable with new lineage.'
          : 'Content digest changed and derived artifacts must be recomputed.'
      };
    });
    const inputDigest = await digestCanonicalJson({
      base: baseUnits.map((unit) => unit.unitVersionId),
      next: units.map((unit) => unit.unitVersionId)
    });
    const planDigest = await digestCanonicalJson(items);
    if (!inputDigest.ok || !planDigest.ok) throw new TypeError('DeltaPlan digest failed.');
    return {
      schemaVersion: '1.0',
      deltaPlanId: this.#ids.next('delta-plan'),
      spaceId: run.spaceId,
      runId: run.runId,
      revisionId: run.revisionId,
      baseGenerationId: run.baseGenerationId,
      items,
      summary: summarizeDelta(items),
      inputDigest: inputDigest.value,
      planDigest: planDigest.value,
      createdAt: this.#clock.now()
    };
  }

  async #stages(
    run: ProcessingRun,
    revision: SourceRevision,
    units: readonly ContentUnitVersion[],
    deltaPlan: DeltaPlan,
    at: Rfc3339Utc
  ): Promise<readonly StageRun[]> {
    const unitDigest = await digestCanonicalJson(units.map((unit) => unit.unitVersionId));
    if (!unitDigest.ok) throw new TypeError(unitDigest.error.summary);
    return [
      {
        stage: 'load-content',
        attempt: 1,
        status: 'succeeded',
        startedAt: run.startedAt,
        completedAt: at,
        inputDigest: revision.snapshot.rawDigest,
        outputDigest: revision.snapshot.normalizedDigest,
        diagnostics: []
      },
      {
        stage: 'transform',
        attempt: 1,
        status: 'succeeded',
        startedAt: run.startedAt,
        completedAt: at,
        inputDigest: revision.snapshot.normalizedDigest,
        outputDigest: unitDigest.value,
        diagnostics: []
      },
      {
        stage: 'plan-delta',
        attempt: 1,
        status: 'succeeded',
        startedAt: run.startedAt,
        completedAt: at,
        inputDigest: deltaPlan.inputDigest,
        outputDigest: deltaPlan.planDigest,
        diagnostics: []
      }
    ];
  }

  async #finishFailure(
    run: ProcessingRun,
    claim: RunClaim,
    envelope: DurableCommandEnvelope<RunProcessingCommand | ResumeProcessingCommand>,
    status: 'failed' | 'cancelled',
    summary: string,
    diagnostics: readonly Diagnostic[] = []
  ): Promise<LorebitOutcome<ProcessingRunResult>> {
    const operation = operationRef(envelope.operationId);
    const now = this.#clock.now();
    const failureDiagnostic = diagnostic(
      status === 'cancelled' ? 'processing-cancelled' : 'processing-failed',
      status === 'cancelled' ? 'warning' : 'error',
      summary,
      { retryable: status === 'failed' }
    );
    const failedRun: ProcessingRun = {
      ...run,
      status,
      sequence: run.sequence + 1,
      cancellationRequested: status === 'cancelled',
      diagnostics: [...diagnostics, failureDiagnostic],
      updatedAt: now,
      completedAt: now
    };
    const event = await this.#event(envelope, run.runId, `processing.run-${status}`, {
      runId: run.runId,
      status,
      summary
    });
    const revision = await this.#repository.getRevision(run.spaceId, run.revisionId);
    const revisionState = revision?.state.status === 'processing'
      ? this.#terminalRevisionState(revision.state, envelope, summary)
      : null;
    const events = [event];
    if (revisionState !== null) {
      events.push(await this.#revisionEvent(
        envelope,
        run.revisionId,
        'revision.processing-failed',
        { revisionId: run.revisionId, runId: run.runId, cause: status }
      ));
    }
    const internalOperationId = this.#ids.next('operation');
    const internalDigest = await digestCanonicalJson({
      runId: run.runId,
      status,
      fencingToken: claim.fencingToken,
      summary
    });
    if (!internalDigest.ok) throw new TypeError(internalDigest.error.summary);
    const committed = await this.#repository.commit({
      spaceId: run.spaceId,
      expected: {
        run: { runId: run.runId, sequence: run.sequence, status: 'running' },
        fencingToken: claim.fencingToken
      },
      operation: {
        spaceId: run.spaceId,
        operationId: internalOperationId,
        idempotencyKey: `run-${status}:${run.runId}:${claim.fencingToken}`,
        commandDigest: internalDigest.value,
        outcome: asWireValue({ kind: `processing-run-${status}`, runId: run.runId }),
        committedAt: now
      },
      writes: {
        processingRun: failedRun,
        ...(revisionState === null ? {} : { revisionState }),
        events
      }
    });
    if (!committed.ok) return failed(mapRepositoryFailure(committed.error), operation);
    await this.#deliver(run.spaceId, committed);
    return failed(
      lorebitFailure(status === 'cancelled' ? 'cancelled' : 'adapter-failure', summary, status === 'failed'),
      operation,
      failedRun.diagnostics
    );
  }

  async #claim(run: ProcessingRun, options: ExecutionOptions) {
    const now = this.#clock.now();
    const leaseMilliseconds = options.leaseMilliseconds ?? 60_000;
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      return {
        ok: false as const,
        error: {
          code: 'state-conflict' as const,
          summary: 'leaseMilliseconds must be a positive safe integer.',
          retryable: false
        },
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

  async #loadResult(spaceId: SpaceId, runId: ProcessingRun['runId']): Promise<ProcessingRunResult | null> {
    const run = await this.#repository.getRun(spaceId, runId);
    if (run === null || run.deltaPlanId === null) return null;
    const [deltaPlan, units] = await Promise.all([
      this.#repository.getDeltaPlan(spaceId, run.deltaPlanId),
      this.#allRevisionUnits(spaceId, run.revisionId)
    ]);
    return deltaPlan === null ? null : { run, deltaPlan, units };
  }

  async #replayRun(
    spaceId: SpaceId,
    runId: ProcessingRun['runId'],
    operation: OperationRef
  ): Promise<LorebitOutcome<ProcessingRunResult>> {
    const run = await this.#repository.getRun(spaceId, runId);
    if (run === null) {
      return failed(lorebitFailure('integrity-check-failed', 'Replayed ProcessingRun is missing.'), operation);
    }
    if (run.status === 'succeeded' || run.status === 'partial') {
      const result = await this.#loadResult(spaceId, runId);
      return result === null
        ? failed(lorebitFailure('integrity-check-failed', 'Replayed run facts are incomplete.'), operation)
        : successful(result, operation, [diagnostic('idempotent-replay', 'info', 'Returned the durable ProcessingRun outcome.')]);
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      return failed(
        lorebitFailure(run.status === 'cancelled' ? 'cancelled' : 'adapter-failure', `ProcessingRun is ${run.status}.`),
        operation,
        run.diagnostics
      );
    }
    return failed(lorebitFailure('processing-incomplete', `ProcessingRun is ${run.status}.`, true), operation, run.diagnostics);
  }

  async #allRevisionUnits(spaceId: SpaceId, revisionId: SourceRevision['revisionId']): Promise<ContentUnitVersion[]> {
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

  async #event(
    envelope: DurableCommandEnvelope<ProcessingCommandPayload>,
    aggregateId: string,
    eventType: string,
    payload: unknown
  ): Promise<LifecycleEvent> {
    const page = await this.#repository.listEvents(
      envelope.payload.spaceId,
      { limit: 1_000 },
      aggregateId
    );
    const wirePayload = asWireValue(payload);
    const payloadDigest = await digestCanonicalJson(wirePayload);
    if (!payloadDigest.ok) throw new TypeError(payloadDigest.error.summary);
    return {
      schemaVersion: '1.0',
      eventId: this.#ids.next('event'),
      eventType,
      aggregate: { kind: 'run', id: aggregateId, spaceId: envelope.payload.spaceId },
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

  async #revisionEvent(
    envelope: DurableCommandEnvelope<ProcessingCommandPayload>,
    revisionId: string,
    eventType: string,
    payload: unknown
  ): Promise<LifecycleEvent> {
    const page = await this.#repository.listEvents(
      envelope.payload.spaceId,
      { limit: 1_000 },
      revisionId
    );
    const wirePayload = asWireValue(payload);
    const payloadDigest = await digestCanonicalJson(wirePayload);
    if (!payloadDigest.ok) throw new TypeError(payloadDigest.error.summary);
    return {
      schemaVersion: '1.0',
      eventId: this.#ids.next('event'),
      eventType,
      aggregate: { kind: 'revision', id: revisionId, spaceId: envelope.payload.spaceId },
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

  #processingState(
    current: RevisionState,
    envelope: DurableCommandEnvelope<ProcessingCommandPayload>
  ): RevisionState | null {
    if (current.status === 'processing' || current.status === 'active') return null;
    if (!canTransitionRevision(current.status, 'processing')) return null;
    return {
      ...current,
      status: 'processing',
      sequence: current.sequence + 1,
      changedAt: envelope.occurredAt,
      actorRef: actor(envelope),
      reason: envelope.reason
    };
  }

  #terminalRevisionState(
    current: RevisionState,
    envelope: DurableCommandEnvelope<ProcessingCommandPayload>,
    summary: string
  ): RevisionState {
    return {
      ...current,
      status: 'failed',
      sequence: current.sequence + 1,
      changedAt: this.#clock.now(),
      actorRef: actor(envelope),
      reason: `${envelope.reason}: ${summary}`
    };
  }

  async #deliver(
    spaceId: SpaceId,
    commit: Extract<RepositoryCommitResult, { ok: true }>
  ): Promise<void> {
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
      // Canonical facts and outbox remain committed for an explicit replay.
    }
  }
}
