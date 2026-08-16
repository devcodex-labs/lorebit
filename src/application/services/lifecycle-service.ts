import type {
  DurableCommandEnvelope,
  ExecutionOptions,
  LifecycleCommandPayload,
  PolicyDefinition
} from '../commands.js';
import { validateDurableCommandEnvelope } from '../commands.js';
import type {
  Page,
  PageRequest,
  ResolveRevisionResult,
  RevisionQuery,
  VersionDifference
} from '../queries.js';
import { digestCanonicalJson, type DigestRef } from '../../wire/digest.js';
import { decodeJsonValue, type JsonValue } from '../../wire/json-value.js';
import type { Rfc3339Utc } from '../../wire/rfc3339.js';
import { currentExecutionTrace } from '../execution-observability.js';
import { diagnostic, lorebitFailure, type Diagnostic, type LorebitFailure } from '../../domain/diagnostics.js';
import type { LifecycleEvent } from '../../domain/events.js';
import type {
  IdGenerator,
  OperationId,
  RevisionId,
  SourceId,
  SpaceId
} from '../../domain/ids.js';
import {
  canTransitionKnowledgeSpace,
  type KnowledgeSpace,
  type PolicySnapshot,
  type SpaceReadiness
} from '../../domain/knowledge-space.js';
import { failed, successful, type LorebitOutcome, type OperationRef } from '../../domain/outcomes.js';
import {
  canTransitionSource,
  type ImportBatch,
  type Source
} from '../../domain/source.js';
import {
  canTransitionRevision,
  type KnowledgeActivation,
  type ProcessingRecipeVersion,
  type RevisionDecision,
  type RevisionLabel,
  type RevisionState,
  type RevisionView,
  type SourceRevision
} from '../../domain/versions.js';
import type { Clock } from '../../ports/clock.js';
import type { ContentStore } from '../../ports/content-store.js';
import type { EventSink } from '../../ports/event-sink.js';
import type {
  AcquireRunClaimRequest,
  AcquireRunClaimResult,
  FencedWriteResult,
  KnowledgeRepository,
  RepositoryCommitResult,
  RepositoryFailure,
  RepositoryWriteSet,
  RunCheckpoint,
  RunClaim
} from '../../ports/knowledge-repository.js';

export type LifecycleMutation =
  | {
      readonly kind: 'space-created';
      readonly space: KnowledgeSpace;
      readonly policy: PolicySnapshot;
    }
  | { readonly kind: 'space-updated'; readonly space: KnowledgeSpace }
  | {
      readonly kind: 'policy-updated';
      readonly space: KnowledgeSpace;
      readonly policy: PolicySnapshot;
      readonly activation?: KnowledgeActivation;
    }
  | { readonly kind: 'source-registered'; readonly source: Source }
  | { readonly kind: 'source-signaled'; readonly source: Source }
  | { readonly kind: 'import-batch-recorded'; readonly importBatch: ImportBatch }
  | {
      readonly kind: 'revision-submitted';
      readonly source: Source;
      readonly revision: RevisionView;
    }
  | { readonly kind: 'revision-deduplicated'; readonly revision: RevisionView }
  | {
      readonly kind: 'revision-transitioned';
      readonly revision: RevisionView;
      readonly activation?: KnowledgeActivation;
    }
  | { readonly kind: 'revision-labeled'; readonly label: RevisionLabel }
  | { readonly kind: 'revision-decision-recorded'; readonly decision: RevisionDecision }
  | {
      readonly kind: 'revision-restored' | 'revision-rolled-back';
      readonly source: Source;
      readonly revision: RevisionView;
    }
  | { readonly kind: 'recipe-registered'; readonly recipe: ProcessingRecipeVersion };

interface LifecycleServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly contentStore: ContentStore;
  readonly eventSink: EventSink;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type PreparedCommit =
  | {
      readonly ok: true;
      readonly value: LifecycleMutation;
      readonly writes: RepositoryWriteSet;
    }
  | { readonly ok: false; readonly error: LorebitFailure };

function commandOperation(operationId: OperationId): OperationRef {
  return { operationId, kind: 'command' };
}

function asWireValue(input: unknown): JsonValue {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) {
    throw new TypeError(`Internal lifecycle value violated the wire contract: ${decoded.error.summary}`);
  }
  return decoded.value;
}

function actorRef(
  envelope: DurableCommandEnvelope<LifecycleCommandPayload>
): string {
  return `${envelope.actorRef.type}:${envelope.actorRef.id}`;
}

function narrowEnvelope<P extends LifecycleCommandPayload>(
  envelope: DurableCommandEnvelope<LifecycleCommandPayload>,
  payload: P
): DurableCommandEnvelope<P> {
  return { ...envelope, commandType: payload.type, payload };
}

function mapRepositoryFailure(error: RepositoryFailure): LorebitFailure {
  return lorebitFailure(error.code, error.summary, error.retryable);
}

function policyFailure(policy: PolicyDefinition): LorebitFailure | null {
  if (
    !Number.isSafeInteger(policy.evidence.minimumCitations) ||
    policy.evidence.minimumCitations < 0
  ) {
    return lorebitFailure('invalid-request', 'minimumCitations must be a non-negative safe integer.');
  }
  if (
    !Number.isSafeInteger(policy.retention.auditDays) ||
    policy.retention.auditDays < 0 ||
    (policy.retention.contentDays !== null &&
      (!Number.isSafeInteger(policy.retention.contentDays) || policy.retention.contentDays < 0))
  ) {
    return lorebitFailure('invalid-request', 'Retention durations must be non-negative safe integers.');
  }
  if (policy.validUntil !== null && policy.validUntil <= policy.validFrom) {
    return lorebitFailure('invalid-request', 'Policy validUntil must be after validFrom.');
  }
  return null;
}

function requireExpected(
  condition: boolean,
  summary: string
): LorebitFailure | null {
  return condition ? null : lorebitFailure('invalid-request', summary);
}

export class LifecycleService {
  readonly #repository: KnowledgeRepository;
  readonly #contentStore: ContentStore;
  readonly #eventSink: EventSink;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(dependencies: LifecycleServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#contentStore = dependencies.contentStore;
    this.#eventSink = dependencies.eventSink;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async execute<P extends LifecycleCommandPayload>(
    envelope: DurableCommandEnvelope<P>,
    options: ExecutionOptions = {}
  ): Promise<LorebitOutcome<LifecycleMutation>> {
    const operation = commandOperation(envelope.operationId);
    const validation = validateDurableCommandEnvelope(envelope);
    if (!validation.ok) {
      return failed(
        lorebitFailure(validation.error.code, validation.error.summary),
        operation
      );
    }
    if (options.signal?.aborted === true) {
      return failed(lorebitFailure('cancelled', 'The live execution signal is already aborted.'), operation);
    }
    const now = this.#clock.now();
    if (
      envelope.requestedDeadlineAt !== undefined &&
      envelope.requestedDeadlineAt <= now
    ) {
      return failed(lorebitFailure('deadline-exceeded', 'The durable command deadline has elapsed.'), operation);
    }
    const digestResult = await digestCanonicalJson(envelope);
    if (!digestResult.ok) {
      return failed(
        lorebitFailure('schema-invalid', digestResult.error.summary),
        operation
      );
    }
    const existing = await this.#repository.getOperation(
      envelope.payload.spaceId,
      envelope.idempotencyKey
    );
    if (existing !== null) {
      if (
        existing.commandDigest.algorithm !== digestResult.value.algorithm ||
        existing.commandDigest.value !== digestResult.value.value
      ) {
        return failed(
          lorebitFailure(
            'idempotency-conflict',
            'The idempotency key is already bound to a different durable command.'
          ),
          operation
        );
      }
      return successful(
        existing.outcome as unknown as LifecycleMutation,
        operation,
        [
          diagnostic(
            'idempotent-replay',
            'info',
            'The original committed outcome was returned without repeating side effects.'
          )
        ]
      );
    }
    const prepared = await this.#prepare(
      envelope as DurableCommandEnvelope<LifecycleCommandPayload>
    );
    if (!prepared.ok) {
      return failed(prepared.error, operation);
    }
    const outcome = asWireValue(prepared.value);
    const committed = await this.#repository.commit({
      spaceId: envelope.payload.spaceId,
      expected: envelope.expected,
      operation: {
        spaceId: envelope.payload.spaceId,
        operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey,
        commandDigest: digestResult.value,
        outcome,
        ...(currentExecutionTrace(envelope.operationId) === null ? {} : { traceContext: currentExecutionTrace(envelope.operationId)! }),
        committedAt: now
      },
      writes: prepared.writes
    });
    if (!committed.ok) {
      return failed(mapRepositoryFailure(committed.error), operation);
    }
    const value = committed.kind === 'replayed'
      ? committed.operation.outcome as unknown as LifecycleMutation
      : prepared.value;
    const diagnostics: Diagnostic[] = [];
    if (committed.kind === 'replayed') {
      diagnostics.push(
        diagnostic(
          'idempotent-replay',
          'info',
          'The original committed outcome was returned without repeating side effects.'
        )
      );
    } else if (committed.events.length > 0) {
      await this.#deliverEvents(
        envelope.payload.spaceId,
        committed,
        diagnostics
      );
    }
    return successful(value, operation, diagnostics);
  }

  async getSpace(spaceId: SpaceId): Promise<LorebitOutcome<KnowledgeSpace>> {
    const operation = this.#queryOperation();
    const value = await this.#repository.getSpace(spaceId);
    return value === null
      ? failed(lorebitFailure('not-found', 'Knowledge space was not found.'), operation)
      : successful(value, operation);
  }

  async getSource(
    spaceId: SpaceId,
    sourceId: SourceId
  ): Promise<LorebitOutcome<Source>> {
    const operation = this.#queryOperation();
    const value = await this.#repository.getSource(spaceId, sourceId);
    return value === null
      ? failed(lorebitFailure('not-found', 'Source was not found in this space.'), operation)
      : successful(value, operation);
  }

  async getImportBatch(
    spaceId: SpaceId,
    importBatchId: string
  ): Promise<LorebitOutcome<ImportBatch>> {
    const operation = this.#queryOperation();
    const value = await this.#repository.getImportBatch(spaceId, importBatchId);
    return value === null
      ? failed(lorebitFailure('not-found', 'Import batch was not found in this space.'), operation)
      : successful(value, operation);
  }

  async listImportBatches(
    spaceId: SpaceId,
    page: PageRequest
  ): Promise<LorebitOutcome<Page<ImportBatch>>> {
    const operation = this.#queryOperation();
    const pageFailure = this.#pageFailure(page);
    if (pageFailure !== null) return failed(pageFailure, operation);
    return successful(await this.#repository.listImportBatches(spaceId, page), operation);
  }

  async spaceReadiness(spaceId: SpaceId): Promise<LorebitOutcome<SpaceReadiness>> {
    const operation = this.#queryOperation();
    const space = await this.#repository.getSpace(spaceId);
    if (space === null) {
      return failed(lorebitFailure('not-found', 'Knowledge space was not found.'), operation);
    }
    const activation = await this.#repository.getActiveActivation(spaceId);
    if (space.status === 'archived') {
      return successful(
        {
          state: 'not-ready',
          guarantees: ['history-retained'],
          limitations: ['space-archived'],
          missing: ['open-space']
        },
        operation
      );
    }
    if (activation === null || activation.revisions.length === 0) {
      return successful(
        {
          state: 'not-ready',
          guarantees: ['canonical-facts-queryable'],
          limitations: ['no-active-evidence'],
          missing: ['knowledge-activation']
        },
        operation
      );
    }
    const unavailable: string[] = [];
    for (const item of activation.revisions) {
      const source = await this.#repository.getSource(spaceId, item.sourceId);
      if (
        source === null ||
        source.status === 'unavailable' ||
        source.status === 'drifted' ||
        source.status === 'permission-changed' ||
        source.status === 'quarantined' ||
        source.status === 'archived'
      ) {
        unavailable.push(item.sourceId);
      }
    }
    return successful(
      {
        state: unavailable.length === 0 ? 'ready' : 'limited',
        guarantees: [
          'single-activation-snapshot',
          'policy-generation-revision-manifest-bound',
          'space-isolated'
        ],
        limitations: unavailable.map((sourceId) => `source-unavailable:${sourceId}`),
        missing: []
      },
      operation
    );
  }

  async getRevision(
    spaceId: SpaceId,
    revisionId: RevisionId
  ): Promise<LorebitOutcome<RevisionView>> {
    const operation = this.#queryOperation();
    const value = await this.#repository.getRevision(spaceId, revisionId);
    return value === null
      ? failed(lorebitFailure('not-found', 'Revision was not found in this space.'), operation)
      : successful(value, operation);
  }

  async listRevisions(
    spaceId: SpaceId,
    sourceId: SourceId,
    page: PageRequest
  ): Promise<LorebitOutcome<Page<RevisionView>>> {
    const operation = this.#queryOperation();
    const pageFailure = this.#pageFailure(page);
    if (pageFailure !== null) return failed(pageFailure, operation);
    return successful(
      await this.#repository.listRevisions(spaceId, sourceId, page),
      operation
    );
  }

  async listRevisionDecisions(
    spaceId: SpaceId,
    revisionId: RevisionId,
    page: PageRequest
  ): Promise<LorebitOutcome<Page<RevisionDecision>>> {
    const operation = this.#queryOperation();
    const pageFailure = this.#pageFailure(page);
    if (pageFailure !== null) return failed(pageFailure, operation);
    return successful(
      await this.#repository.listDecisions(spaceId, revisionId, page),
      operation
    );
  }

  async listEvents(
    spaceId: SpaceId,
    page: PageRequest,
    aggregateId?: string
  ): Promise<LorebitOutcome<Page<LifecycleEvent>>> {
    const operation = this.#queryOperation();
    const pageFailure = this.#pageFailure(page);
    if (pageFailure !== null) return failed(pageFailure, operation);
    const result = aggregateId === undefined
      ? await this.#repository.listEvents(spaceId, page)
      : await this.#repository.listEvents(spaceId, page, aggregateId);
    return successful(result, operation);
  }

  async resolveRevision(query: RevisionQuery): Promise<LorebitOutcome<ResolveRevisionResult>> {
    const operation = this.#queryOperation();
    let result: ResolveRevisionResult;
    switch (query.selector.kind) {
      case 'revision': {
        const value = await this.#repository.getRevision(
          query.spaceId,
          query.selector.revisionId
        );
        result = value === null ? { kind: 'not-found' } : { kind: 'resolved', value };
        break;
      }
      case 'label': {
        const value = await this.#repository.getRevisionByLabel(
          query.spaceId,
          query.sourceId,
          query.selector.label
        );
        result = value === null ? { kind: 'not-found' } : { kind: 'resolved', value };
        break;
      }
      case 'active': {
        const activation = await this.#repository.getActiveActivation(query.spaceId);
        const revisionId = activation?.revisions.find(
          (item) => item.sourceId === query.sourceId
        )?.revisionId;
        if (revisionId === undefined) {
          result = {
            kind: 'limitation',
            code: 'no-active-revision',
            summary: 'No active KnowledgeActivation contains this source.'
          };
        } else {
          const value = await this.#repository.getRevision(query.spaceId, revisionId);
          result = value === null ? { kind: 'not-found' } : { kind: 'resolved', value };
        }
        break;
      }
      case 'as-of': {
        const asOf = query.selector.at;
        const activations = await this.#allActivations(query.spaceId);
        const activation = activations
          .filter((item) => item.createdAt <= asOf)
          .at(-1);
        const revisionId = activation?.revisions.find(
          (item) => item.sourceId === query.sourceId
        )?.revisionId;
        if (revisionId === undefined) {
          result = {
            kind: 'limitation',
            code: 'history-unavailable',
            summary: 'No retained activation history can resolve this as-of selector.'
          };
        } else {
          const value = await this.#repository.getRevisionAt(
            query.spaceId,
            revisionId,
            asOf
          );
          result = value === null ? { kind: 'not-found' } : { kind: 'resolved', value };
        }
        break;
      }
    }
    return successful(result, operation);
  }

  async compareRevisions(
    spaceId: SpaceId,
    leftId: RevisionId,
    rightId: RevisionId
  ): Promise<LorebitOutcome<VersionDifference>> {
    const operation = this.#queryOperation();
    const [left, right] = await Promise.all([
      this.#repository.getRevision(spaceId, leftId),
      this.#repository.getRevision(spaceId, rightId)
    ]);
    if (left === null || right === null) {
      return failed(lorebitFailure('not-found', 'One or both revisions were not found.'), operation);
    }
    return successful(
      {
        kind: 'revision',
        leftId,
        rightId,
        changedFields: this.#changedFields(left.revision, right.revision, [
          'revisionId',
          'sequence',
          'predecessorRevisionId',
          'createdAt',
          'actorRef',
          'reason'
        ])
      },
      operation
    );
  }

  async comparePolicies(
    spaceId: SpaceId,
    leftId: string,
    rightId: string
  ): Promise<LorebitOutcome<VersionDifference>> {
    const operation = this.#queryOperation();
    const [left, right] = await Promise.all([
      this.#repository.getPolicy(spaceId, leftId),
      this.#repository.getPolicy(spaceId, rightId)
    ]);
    if (left === null || right === null) {
      return failed(lorebitFailure('not-found', 'One or both policies were not found.'), operation);
    }
    return successful(
      {
        kind: 'policy',
        leftId,
        rightId,
        changedFields: this.#changedFields(left, right, [
          'policyId',
          'predecessorPolicyId',
          'sequence',
          'createdAt',
          'actorRef',
          'reason'
        ])
      },
      operation
    );
  }

  async compareRecipes(
    spaceId: SpaceId,
    leftId: string,
    rightId: string
  ): Promise<LorebitOutcome<VersionDifference>> {
    const operation = this.#queryOperation();
    const [left, right] = await Promise.all([
      this.#repository.getRecipe(spaceId, leftId),
      this.#repository.getRecipe(spaceId, rightId)
    ]);
    if (left === null || right === null) {
      return failed(lorebitFailure('not-found', 'One or both recipes were not found.'), operation);
    }
    return successful(
      {
        kind: 'recipe',
        leftId,
        rightId,
        changedFields: this.#changedFields(left, right, [
          'recipeId',
          'predecessorRecipeId',
          'sequence',
          'createdAt',
          'actorRef',
          'reason'
        ])
      },
      operation
    );
  }

  async flushOutbox(
    spaceId: SpaceId,
    page: PageRequest = { limit: 100 }
  ): Promise<LorebitOutcome<{ readonly delivered: number; readonly pending: number }>> {
    const operation = this.#queryOperation();
    const pageFailure = this.#pageFailure(page);
    if (pageFailure !== null) return failed(pageFailure, operation);
    const records = await this.#repository.listOutbox(spaceId, page);
    const pending = records.items.filter((record) => record.status === 'pending');
    if (pending.length === 0) {
      return successful({ delivered: 0, pending: 0 }, operation);
    }
    try {
      const result = await this.#eventSink.publish(pending.map((record) => record.event));
      if (!result.ok) {
        return failed(
          lorebitFailure('adapter-failure', result.summary, result.retryable),
          operation,
          [
            diagnostic('event-delivery-pending', 'warning', result.summary, {
              guarantees: ['canonical-facts-committed', 'outbox-retained'],
              retryable: result.retryable
            })
          ]
        );
      }
      await this.#repository.markOutboxDelivered(
        spaceId,
        pending.map((record) => record.event.eventId),
        this.#clock.now()
      );
      return successful({ delivered: pending.length, pending: 0 }, operation);
    } catch {
      return failed(
        lorebitFailure('adapter-failure', 'EventSink threw while replaying the outbox.', true),
        operation
      );
    }
  }

  async acquireRunClaim(
    request: AcquireRunClaimRequest
  ): Promise<LorebitOutcome<RunClaim>> {
    const operation = this.#queryOperation();
    const result = await this.#repository.acquireRunClaim(request);
    return result.ok
      ? successful(result.value, operation)
      : failed(mapRepositoryFailure(result.error), operation);
  }

  async saveCheckpoint(
    checkpoint: RunCheckpoint
  ): Promise<LorebitOutcome<{ readonly saved: true }>> {
    const operation = this.#queryOperation();
    const wire = decodeJsonValue(checkpoint);
    if (!wire.ok) {
      return failed(lorebitFailure('schema-invalid', wire.error.summary), operation);
    }
    const result: FencedWriteResult = await this.#repository.saveCheckpoint(checkpoint);
    return result.ok
      ? successful({ saved: true }, operation)
      : failed(mapRepositoryFailure(result.error), operation);
  }

  #queryOperation(): OperationRef {
    return { operationId: this.#ids.next('operation'), kind: 'query' };
  }

  #pageFailure(page: PageRequest): LorebitFailure | null {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1_000) {
      return lorebitFailure('invalid-request', 'Page limit must be a safe integer from 1 to 1000.');
    }
    if (page.after !== undefined) {
      try {
        decodeURIComponent(page.after);
      } catch {
        return lorebitFailure('invalid-request', 'Page cursor is malformed.');
      }
    }
    return null;
  }

  #changedFields(
    left: object,
    right: object,
    ignored: readonly string[]
  ): readonly string[] {
    const ignoredSet = new Set(ignored);
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return Array.from(keys)
      .filter((key) => !ignoredSet.has(key))
      .filter((key) => {
        const leftValue = Reflect.get(left, key);
        const rightValue = Reflect.get(right, key);
        return JSON.stringify(leftValue) !== JSON.stringify(rightValue);
      })
      .sort((a, b) => a.localeCompare(b, 'en'));
  }

  async #prepare(
    envelope: DurableCommandEnvelope<LifecycleCommandPayload>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    switch (payload.type) {
      case 'space.create': return this.#createSpace(narrowEnvelope(envelope, payload));
      case 'space.update': return this.#updateSpace(narrowEnvelope(envelope, payload));
      case 'space.freeze': return this.#changeSpaceStatus(narrowEnvelope(envelope, payload), 'frozen');
      case 'space.reopen': return this.#changeSpaceStatus(narrowEnvelope(envelope, payload), 'open');
      case 'space.archive': return this.#changeSpaceStatus(narrowEnvelope(envelope, payload), 'archived');
      case 'policy.update': return this.#updatePolicy(narrowEnvelope(envelope, payload));
      case 'source.register': return this.#registerSource(narrowEnvelope(envelope, payload));
      case 'source.signal': return this.#signalSource(narrowEnvelope(envelope, payload));
      case 'import.record': return this.#recordImportBatch(narrowEnvelope(envelope, payload));
      case 'revision.submit': return this.#submitRevision(narrowEnvelope(envelope, payload));
      case 'revision.transition': return this.#transitionRevision(narrowEnvelope(envelope, payload));
      case 'revision.label': return this.#labelRevision(narrowEnvelope(envelope, payload));
      case 'revision.decision': return this.#recordDecision(narrowEnvelope(envelope, payload));
      case 'revision.withdraw': return this.#withdrawRevision(narrowEnvelope(envelope, payload));
      case 'revision.restore': return this.#copyRevision(narrowEnvelope(envelope, payload), 'restore');
      case 'revision.rollback': return this.#copyRevision(narrowEnvelope(envelope, payload), 'rollback');
      case 'recipe.register': return this.#registerRecipe(narrowEnvelope(envelope, payload));
    }
  }

  async #createSpace(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'space.create' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    if (payload.name.trim().length === 0) {
      return { ok: false, error: lorebitFailure('invalid-request', 'Space name is required.') };
    }
    const invalidPolicy = policyFailure(payload.policy);
    if (invalidPolicy !== null) return { ok: false, error: invalidPolicy };
    if (await this.#repository.getSpace(payload.spaceId) !== null) {
      return { ok: false, error: lorebitFailure('state-conflict', 'Space already exists.') };
    }
    const policyFingerprint = await digestCanonicalJson(payload.policy);
    if (!policyFingerprint.ok) throw new TypeError(policyFingerprint.error.summary);
    const policy = this.#policySnapshot(
      payload.spaceId,
      payload.policyId,
      null,
      1,
      payload.policy,
      policyFingerprint.value,
      envelope
    );
    const space: KnowledgeSpace = {
      schemaVersion: '1.0',
      spaceId: payload.spaceId,
      name: payload.name.trim(),
      description: payload.description,
      status: 'open',
      sequence: 1,
      currentPolicyId: payload.policyId,
      metadata: payload.metadata,
      createdAt: envelope.occurredAt,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(
      envelope,
      'space',
      payload.spaceId,
      'knowledge-space.created',
      { spaceId: payload.spaceId, policyId: payload.policyId }
    );
    return {
      ok: true,
      value: { kind: 'space-created', space, policy },
      writes: { space, policy, events: [event] }
    };
  }

  async #updateSpace(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'space.update' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = requireExpected(
      envelope.expected.space?.sequence !== undefined,
      'space.update requires expected.space.sequence.'
    );
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    const current = await this.#repository.getSpace(payload.spaceId);
    if (current === null) return { ok: false, error: lorebitFailure('not-found', 'Space was not found.') };
    if (current.status !== 'open') {
      return { ok: false, error: lorebitFailure('invalid-state-transition', 'Frozen or archived spaces cannot be edited.') };
    }
    if (payload.name === undefined && payload.description === undefined && payload.metadata === undefined) {
      return { ok: false, error: lorebitFailure('invalid-request', 'No space changes were provided.') };
    }
    if (payload.name !== undefined && payload.name.trim().length === 0) {
      return { ok: false, error: lorebitFailure('invalid-request', 'Space name cannot be empty.') };
    }
    const space: KnowledgeSpace = {
      ...current,
      name: payload.name?.trim() ?? current.name,
      description: payload.description ?? current.description,
      metadata: payload.metadata ?? current.metadata,
      sequence: current.sequence + 1,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'space', payload.spaceId, 'knowledge-space.updated', {
      spaceId: payload.spaceId,
      sequence: space.sequence
    });
    return { ok: true, value: { kind: 'space-updated', space }, writes: { space, events: [event] } };
  }

  async #changeSpaceStatus(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'space.freeze' | 'space.reopen' | 'space.archive' }>>,
    status: KnowledgeSpace['status']
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = requireExpected(
      envelope.expected.space?.sequence !== undefined &&
        envelope.expected.space.status !== undefined,
      `${payload.type} requires expected space sequence and status.`
    );
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    const current = await this.#repository.getSpace(payload.spaceId);
    if (current === null) return { ok: false, error: lorebitFailure('not-found', 'Space was not found.') };
    if (!canTransitionKnowledgeSpace(current.status, status)) {
      return {
        ok: false,
        error: lorebitFailure(
          'invalid-state-transition',
          `KnowledgeSpace cannot transition from ${current.status} to ${status}.`
        )
      };
    }
    const space: KnowledgeSpace = {
      ...current,
      status,
      sequence: current.sequence + 1,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'space', payload.spaceId, `knowledge-space.${status}`, {
      spaceId: payload.spaceId,
      from: current.status,
      to: status
    });
    return { ok: true, value: { kind: 'space-updated', space }, writes: { space, events: [event] } };
  }

  async #updatePolicy(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'policy.update' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = requireExpected(
      envelope.expected.policyId !== undefined && envelope.expected.space?.sequence !== undefined,
      'policy.update requires expected policy id and space sequence.'
    );
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    const invalidPolicy = policyFailure(payload.policy);
    if (invalidPolicy !== null) return { ok: false, error: invalidPolicy };
    const space = await this.#repository.getSpace(payload.spaceId);
    if (space === null) return { ok: false, error: lorebitFailure('not-found', 'Space was not found.') };
    if (space.status !== 'open') {
      return { ok: false, error: lorebitFailure('invalid-state-transition', 'Policy cannot change while the space is frozen or archived.') };
    }
    const current = await this.#repository.getPolicy(payload.spaceId, space.currentPolicyId);
    if (current === null) {
      return { ok: false, error: lorebitFailure('integrity-check-failed', 'Current policy is missing.') };
    }
    const policyFingerprint = await digestCanonicalJson(payload.policy);
    if (!policyFingerprint.ok) throw new TypeError(policyFingerprint.error.summary);
    const policy = this.#policySnapshot(
      payload.spaceId,
      payload.policyId,
      current.policyId,
      current.sequence + 1,
      payload.policy,
      policyFingerprint.value,
      envelope
    );
    const updatedSpace: KnowledgeSpace = {
      ...space,
      currentPolicyId: policy.policyId,
      sequence: space.sequence + 1,
      updatedAt: envelope.occurredAt
    };
    const events = [await this.#event(envelope, 'policy', policy.policyId, 'policy.snapshot-created', {
      spaceId: payload.spaceId,
      policyId: policy.policyId,
      predecessorPolicyId: policy.predecessorPolicyId,
      changeKind: policy.changeKind
    })];
    const active = await this.#repository.getActiveActivation(payload.spaceId);
    let activation: KnowledgeActivation | undefined;
    if (policy.changeKind === 'query-only' && active !== null) {
      if (envelope.expected.activationId !== active.activationId) {
        return {
          ok: false,
          error: lorebitFailure(
            'invalid-request',
            'A query-only policy activation requires expected.activationId.'
          )
        };
      }
      activation = {
        ...active,
        activationId: this.#ids.next('activation'),
        predecessorActivationId: active.activationId,
        policyId: policy.policyId,
        createdAt: envelope.occurredAt,
        actorRef: actorRef(envelope),
        reason: envelope.reason
      };
      events.push(await this.#event(
        envelope,
        'activation',
        activation.activationId,
        'knowledge-activation.policy-switched',
        {
          activationId: activation.activationId,
          predecessorActivationId: active.activationId,
          policyId: policy.policyId,
          generationId: activation.generation.generationId
        }
      ));
    }
    const value = activation === undefined
      ? { kind: 'policy-updated' as const, space: updatedSpace, policy }
      : { kind: 'policy-updated' as const, space: updatedSpace, policy, activation };
    return {
      ok: true,
      value,
      writes: activation === undefined
        ? { space: updatedSpace, policy, events }
        : { space: updatedSpace, policy, activation, events }
    };
  }

  async #registerSource(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'source.register' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    if (payload.name.trim().length === 0 || payload.kind.trim().length === 0) {
      return { ok: false, error: lorebitFailure('invalid-request', 'Source name and kind are required.') };
    }
    if (
      payload.locator.value.trim().length === 0 ||
      payload.ownership.ownerRef.trim().length === 0 ||
      (payload.syncCursor !== undefined && payload.syncCursor.value.trim().length === 0)
    ) {
      return {
        ok: false,
        error: lorebitFailure(
          'content-quarantined',
          'Source locator, ownership and optional sync cursor must be complete.'
        )
      };
    }
    const spaceFailure = await this.#requireOpenSpace(payload.spaceId);
    if (spaceFailure !== null) return { ok: false, error: spaceFailure };
    if (await this.#repository.getSource(payload.spaceId, payload.sourceId) !== null) {
      return { ok: false, error: lorebitFailure('state-conflict', 'Source already exists.') };
    }
    if (
      payload.parentSourceId !== null &&
      await this.#repository.getSource(payload.spaceId, payload.parentSourceId) === null
    ) {
      return { ok: false, error: lorebitFailure('not-found', 'Parent source was not found in this space.') };
    }
    if (
      payload.importBatchId !== undefined &&
      await this.#repository.getImportBatch(payload.spaceId, payload.importBatchId) === null
    ) {
      return { ok: false, error: lorebitFailure('not-found', 'Import batch was not found in this space.') };
    }
    const source: Source = {
      schemaVersion: '1.0',
      sourceId: payload.sourceId,
      spaceId: payload.spaceId,
      kind: payload.kind,
      name: payload.name.trim(),
      status: 'registered',
      sequence: 1,
      locator: payload.locator,
      ownership: payload.ownership,
      parentSourceId: payload.parentSourceId,
      importBatchId: payload.importBatchId ?? null,
      syncCursor: payload.syncCursor ?? null,
      currentRevisionId: null,
      visibilityLabels: [...payload.visibilityLabels],
      metadata: payload.metadata,
      createdAt: envelope.occurredAt,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'source', source.sourceId, 'source.registered', {
      spaceId: payload.spaceId,
      sourceId: source.sourceId,
      kind: source.kind
    });
    return { ok: true, value: { kind: 'source-registered', source }, writes: { source, events: [event] } };
  }

  async #signalSource(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'source.signal' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = requireExpected(
      envelope.expected.source?.sourceId === payload.sourceId &&
        envelope.expected.source.sequence !== undefined,
      'source.signal requires expected source sequence.'
    );
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    const source = await this.#repository.getSource(payload.spaceId, payload.sourceId);
    if (source === null) return { ok: false, error: lorebitFailure('not-found', 'Source was not found.') };
    if (!canTransitionSource(source.status, payload.status)) {
      return {
        ok: false,
        error: lorebitFailure(
          'invalid-state-transition',
          `Source cannot transition from ${source.status} to ${payload.status}.`
        )
      };
    }
    const updated: Source = {
      ...source,
      status: payload.status,
      syncCursor: payload.syncCursor ?? source.syncCursor,
      sequence: source.sequence + 1,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'source', source.sourceId, 'source.availability-signaled', {
      sourceId: source.sourceId,
      from: source.status,
      to: updated.status,
      syncCursor: updated.syncCursor
    });
    return {
      ok: true,
      value: { kind: 'source-signaled', source: updated },
      writes: { source: updated, events: [event] }
    };
  }

  async #recordImportBatch(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'import.record' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const spaceFailure = await this.#requireOpenSpace(payload.spaceId);
    if (spaceFailure !== null) return { ok: false, error: spaceFailure };
    if (
      !Number.isSafeInteger(payload.acceptedCount) ||
      !Number.isSafeInteger(payload.failedCount) ||
      payload.acceptedCount < 0 ||
      payload.failedCount < 0 ||
      payload.acceptedCount + payload.failedCount !== payload.sourceIds.length
    ) {
      return {
        ok: false,
        error: lorebitFailure(
          'invalid-request',
          'Import batch counts must be non-negative and cover the complete source manifest.'
        )
      };
    }
    if (
      (payload.status === 'complete' && payload.failedCount !== 0) ||
      (payload.status === 'failed' && payload.acceptedCount !== 0) ||
      payload.errors.length > payload.failedCount
    ) {
      return {
        ok: false,
        error: lorebitFailure('invalid-request', 'Import batch status and error counts are inconsistent.')
      };
    }
    if (new Set(payload.sourceIds).size !== payload.sourceIds.length) {
      return { ok: false, error: lorebitFailure('invalid-request', 'Import batch source ids must be unique.') };
    }
    if (await this.#repository.getImportBatch(payload.spaceId, payload.importBatchId) !== null) {
      return { ok: false, error: lorebitFailure('state-conflict', 'Import batch already exists.') };
    }
    const manifestDigest = await digestCanonicalJson(payload.manifest);
    if (!manifestDigest.ok) {
      return { ok: false, error: lorebitFailure('schema-invalid', manifestDigest.error.summary) };
    }
    const importBatch: ImportBatch = {
      schemaVersion: '1.0',
      importBatchId: payload.importBatchId,
      spaceId: payload.spaceId,
      sourceIds: [...payload.sourceIds],
      submittedBy: actorRef(envelope),
      manifestDigest: manifestDigest.value,
      status: payload.status,
      acceptedCount: payload.acceptedCount,
      failedCount: payload.failedCount,
      errors: payload.errors.map((error) => ({ ...error })),
      createdAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'import', importBatch.importBatchId, 'import.batch-recorded', {
      importBatchId: importBatch.importBatchId,
      status: importBatch.status,
      acceptedCount: importBatch.acceptedCount,
      failedCount: importBatch.failedCount,
      manifestDigest: importBatch.manifestDigest
    });
    return {
      ok: true,
      value: { kind: 'import-batch-recorded', importBatch },
      writes: { importBatch, events: [event] }
    };
  }

  async #submitRevision(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'revision.submit' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = requireExpected(
      envelope.expected.source?.sourceId === payload.sourceId &&
        Object.prototype.hasOwnProperty.call(envelope.expected.source, 'revisionId') &&
        envelope.expected.source.sequence !== undefined,
      'revision.submit requires expected source sequence and revision predecessor.'
    );
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    const spaceFailure = await this.#requireOpenSpace(payload.spaceId);
    if (spaceFailure !== null) return { ok: false, error: spaceFailure };
    const source = await this.#repository.getSource(payload.spaceId, payload.sourceId);
    if (source === null) return { ok: false, error: lorebitFailure('not-found', 'Source was not found.') };
    if (payload.snapshot.content.spaceId !== payload.spaceId) {
      return { ok: false, error: lorebitFailure('out-of-scope', 'ContentRef belongs to another space.') };
    }
    if (!await this.#contentStore.has(payload.snapshot.content)) {
      return {
        ok: false,
        error: lorebitFailure('content-quarantined', 'Immutable content is not present in the scoped ContentStore.')
      };
    }
    if (
      payload.snapshot.rawDigest.algorithm !== payload.snapshot.content.digest.algorithm ||
      payload.snapshot.rawDigest.value !== payload.snapshot.content.digest.value
    ) {
      return {
        ok: false,
        error: lorebitFailure(
          'digest-mismatch',
          'SourceSnapshot raw digest does not match the immutable ContentRef.'
        )
      };
    }
    if (
      payload.effectiveUntil !== null &&
      payload.effectiveUntil <= payload.effectiveFrom
    ) {
      return {
        ok: false,
        error: lorebitFailure('invalid-request', 'Revision effectiveUntil must be after effectiveFrom.')
      };
    }
    const metadataDigest = await digestCanonicalJson(payload.metadata);
    const changeSetDigest = await digestCanonicalJson(payload.changeSet.changes);
    if (!metadataDigest.ok || !changeSetDigest.ok) {
      return {
        ok: false,
        error: lorebitFailure('schema-invalid', 'Revision metadata or ChangeSet is not canonical JSON.')
      };
    }
    const locator = payload.locator ?? source.locator;
    const current = source.currentRevisionId === null
      ? null
      : await this.#repository.getRevision(payload.spaceId, source.currentRevisionId);
    if (
      current !== null &&
      current.revision.snapshot.normalizedDigest.value === payload.snapshot.normalizedDigest.value &&
      current.revision.metadataDigest.value === metadataDigest.value.value &&
      current.revision.locator.kind === locator.kind &&
      current.revision.locator.value === locator.value &&
      current.revision.locator.fragment === locator.fragment
    ) {
      const event = await this.#event(envelope, 'source', source.sourceId, 'revision.duplicate-detected', {
        sourceId: source.sourceId,
        reusedRevisionId: current.revision.revisionId,
        normalizedDigest: payload.snapshot.normalizedDigest
      });
      return {
        ok: true,
        value: { kind: 'revision-deduplicated', revision: current },
        writes: { events: [event] }
      };
    }
    const revision: SourceRevision = {
      schemaVersion: '1.0',
      revisionId: payload.revisionId,
      spaceId: payload.spaceId,
      sourceId: payload.sourceId,
      sequence: (current?.revision.sequence ?? 0) + 1,
      predecessorRevisionId: source.currentRevisionId,
      derivedFromRevisionIds: [...payload.derivedFromRevisionIds],
      replacesRevisionId: source.currentRevisionId,
      snapshot: payload.snapshot,
      locator,
      changeSet: { ...payload.changeSet, digest: changeSetDigest.value },
      metadata: payload.metadata,
      metadataDigest: metadataDigest.value,
      createdAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason,
      effectiveFrom: payload.effectiveFrom,
      effectiveUntil: payload.effectiveUntil
    };
    const state: RevisionState = {
      revisionId: revision.revisionId,
      spaceId: revision.spaceId,
      sourceId: revision.sourceId,
      status: 'draft',
      sequence: 1,
      changedAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason
    };
    const updatedSource: Source = {
      ...source,
      currentRevisionId: revision.revisionId,
      sequence: source.sequence + 1,
      locator: revision.locator,
      metadata: revision.metadata,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'revision', revision.revisionId, 'revision.submitted', {
      sourceId: source.sourceId,
      revisionId: revision.revisionId,
      predecessorRevisionId: revision.predecessorRevisionId,
      changeKind: revision.changeSet.kind
    });
    const view = { revision, state };
    return {
      ok: true,
      value: { kind: 'revision-submitted', source: updatedSource, revision: view },
      writes: { source: updatedSource, revision, revisionState: state, events: [event] }
    };
  }

  async #transitionRevision(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'revision.transition' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = this.#revisionExpectedFailure(envelope, payload.sourceId, payload.revisionId);
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    if (payload.status === 'active' || payload.status === 'superseded') {
      return {
        ok: false,
        error: lorebitFailure(
          'processing-incomplete',
          'Active/superseded projections require the B2 KnowledgeActivation transaction.'
        )
      };
    }
    return this.#writeRevisionState(envelope, payload.status, 'revision.status-changed');
  }

  async #withdrawRevision(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'revision.withdraw' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = this.#revisionExpectedFailure(envelope, payload.sourceId, payload.revisionId);
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    return this.#writeRevisionState(envelope, 'withdrawn', 'revision.withdrawn');
  }

  async #writeRevisionState(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'revision.transition' | 'revision.withdraw' }>>,
    status: RevisionState['status'],
    eventType: string
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const view = await this.#repository.getRevision(payload.spaceId, payload.revisionId);
    if (view === null || view.revision.sourceId !== payload.sourceId) {
      return { ok: false, error: lorebitFailure('not-found', 'Revision was not found in this source.') };
    }
    if (!canTransitionRevision(view.state.status, status)) {
      return {
        ok: false,
        error: lorebitFailure(
          'invalid-state-transition',
          `Revision cannot transition from ${view.state.status} to ${status}.`
        )
      };
    }
    const state: RevisionState = {
      ...view.state,
      status,
      sequence: view.state.sequence + 1,
      changedAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason
    };
    const event = await this.#event(envelope, 'revision', payload.revisionId, eventType, {
      revisionId: payload.revisionId,
      from: view.state.status,
      to: status
    });
    const events = [event];
    const currentActivation = await this.#repository.getActiveActivation(payload.spaceId);
    let activation: KnowledgeActivation | undefined;
    if (
      (status === 'withdrawn' || status === 'archived') &&
      currentActivation?.revisions.some(
        (item) => item.sourceId === payload.sourceId && item.revisionId === payload.revisionId
      ) === true
    ) {
      const revisions = currentActivation.revisions.filter(
        (item) => item.sourceId !== payload.sourceId
      );
      const manifestDigest = await digestCanonicalJson(revisions);
      if (!manifestDigest.ok) throw new TypeError(manifestDigest.error.summary);
      activation = {
        ...currentActivation,
        activationId: this.#ids.next('activation'),
        predecessorActivationId: currentActivation.activationId,
        revisions,
        revisionManifestDigest: manifestDigest.value,
        createdAt: envelope.occurredAt,
        actorRef: actorRef(envelope),
        reason: envelope.reason
      };
      events.push(await this.#event(
        envelope,
        'activation',
        activation.activationId,
        'knowledge-activation.retracted-source',
        {
          activationId: activation.activationId,
          predecessorActivationId: currentActivation.activationId,
          sourceId: payload.sourceId,
          revisionId: payload.revisionId,
          revisionManifestDigest: activation.revisionManifestDigest
        }
      ));
    }
    const value = activation === undefined
      ? { kind: 'revision-transitioned' as const, revision: { revision: view.revision, state } }
      : {
          kind: 'revision-transitioned' as const,
          revision: { revision: view.revision, state },
          activation
        };
    return {
      ok: true,
      value,
      writes: activation === undefined
        ? { revisionState: state, events }
        : { revisionState: state, activation, events }
    };
  }

  async #labelRevision(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'revision.label' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    if (payload.label.trim().length === 0 || payload.label.length > 128) {
      return { ok: false, error: lorebitFailure('invalid-request', 'Revision label must contain 1–128 characters.') };
    }
    const view = await this.#repository.getRevision(payload.spaceId, payload.revisionId);
    if (view === null || view.revision.sourceId !== payload.sourceId) {
      return { ok: false, error: lorebitFailure('not-found', 'Revision was not found in this source.') };
    }
    const current = await this.#repository.getRevisionLabel(
      payload.spaceId,
      payload.sourceId,
      payload.label
    );
    const label: RevisionLabel = {
      spaceId: payload.spaceId,
      sourceId: payload.sourceId,
      label: payload.label,
      revisionId: payload.revisionId,
      sequence: (current?.sequence ?? 0) + 1,
      changedAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason
    };
    const event = await this.#event(envelope, 'revision', payload.revisionId, 'revision.label-set', {
      revisionId: payload.revisionId,
      label: payload.label
    });
    return { ok: true, value: { kind: 'revision-labeled', label }, writes: { label, events: [event] } };
  }

  async #recordDecision(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'revision.decision' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const view = await this.#repository.getRevision(payload.spaceId, payload.revisionId);
    if (view === null || view.revision.sourceId !== payload.sourceId) {
      return { ok: false, error: lorebitFailure('not-found', 'Revision was not found in this source.') };
    }
    const decision: RevisionDecision = {
      decisionId: payload.decisionId,
      spaceId: payload.spaceId,
      sourceId: payload.sourceId,
      revisionId: payload.revisionId,
      status: payload.status,
      reason: envelope.reason,
      actorRef: actorRef(envelope),
      decidedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'revision', payload.revisionId, 'revision.decision-recorded', {
      revisionId: payload.revisionId,
      decisionId: payload.decisionId,
      status: payload.status
    });
    return {
      ok: true,
      value: { kind: 'revision-decision-recorded', decision },
      writes: { decision, events: [event] }
    };
  }

  async #copyRevision(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'revision.restore' | 'revision.rollback' }>>,
    mode: 'restore' | 'rollback'
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const source = await this.#repository.getSource(payload.spaceId, payload.sourceId);
    if (source === null) return { ok: false, error: lorebitFailure('not-found', 'Source was not found.') };
    const expectedFailure = requireExpected(
      envelope.expected.source?.sourceId === payload.sourceId &&
        envelope.expected.source.sequence !== undefined &&
        Object.prototype.hasOwnProperty.call(envelope.expected.source, 'revisionId'),
      `revision.${mode} requires expected source sequence and current revision.`
    );
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    const targetId = payload.type === 'revision.restore'
      ? payload.fromRevisionId
      : payload.targetRevisionId;
    const target = await this.#repository.getRevision(payload.spaceId, targetId);
    if (target === null || target.revision.sourceId !== payload.sourceId) {
      return { ok: false, error: lorebitFailure('not-found', 'Target revision was not found in this source.') };
    }
    if (mode === 'restore' && target.state.status !== 'withdrawn') {
      return { ok: false, error: lorebitFailure('invalid-state-transition', 'Only a withdrawn revision can be restored.') };
    }
    if (!await this.#contentStore.has(target.revision.snapshot.content)) {
      return { ok: false, error: lorebitFailure('not-found', 'Target immutable content is no longer retained.') };
    }
    const changeSet = await this.#copyChangeSet(mode, target.revision.revisionId);
    const newRevisionId = payload.newRevisionId;
    const revision: SourceRevision = {
      ...target.revision,
      revisionId: newRevisionId,
      sequence: await this.#nextRevisionSequence(payload.spaceId, payload.sourceId),
      predecessorRevisionId: source.currentRevisionId,
      derivedFromRevisionIds: [target.revision.revisionId],
      replacesRevisionId: mode === 'rollback' ? source.currentRevisionId : null,
      changeSet,
      createdAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason,
      effectiveFrom: envelope.occurredAt,
      effectiveUntil: null
    };
    const state: RevisionState = {
      revisionId: newRevisionId,
      spaceId: payload.spaceId,
      sourceId: payload.sourceId,
      status: 'draft',
      sequence: 1,
      changedAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason
    };
    const updatedSource: Source = {
      ...source,
      currentRevisionId: newRevisionId,
      sequence: source.sequence + 1,
      locator: revision.locator,
      metadata: revision.metadata,
      updatedAt: envelope.occurredAt
    };
    const event = await this.#event(envelope, 'revision', newRevisionId, `revision.${mode}-created`, {
      revisionId: newRevisionId,
      targetRevisionId: target.revision.revisionId,
      predecessorRevisionId: source.currentRevisionId
    });
    const kind = mode === 'restore' ? 'revision-restored' : 'revision-rolled-back';
    return {
      ok: true,
      value: { kind, source: updatedSource, revision: { revision, state } },
      writes: { source: updatedSource, revision, revisionState: state, events: [event] }
    };
  }

  async #registerRecipe(
    envelope: DurableCommandEnvelope<Extract<LifecycleCommandPayload, { type: 'recipe.register' }>>
  ): Promise<PreparedCommit> {
    const payload = envelope.payload;
    const expectedFailure = requireExpected(
      Object.prototype.hasOwnProperty.call(envelope.expected, 'recipeId'),
      'recipe.register requires expected recipe predecessor.'
    );
    if (expectedFailure !== null) return { ok: false, error: expectedFailure };
    const spaceFailure = await this.#requireOpenSpace(payload.spaceId);
    if (spaceFailure !== null) return { ok: false, error: spaceFailure };
    const current = await this.#repository.getCurrentRecipe(payload.spaceId);
    const fingerprint = await digestCanonicalJson({
      configuration: payload.configuration,
      compatibility: payload.compatibility
    });
    if (!fingerprint.ok) throw new TypeError(fingerprint.error.summary);
    const recipe: ProcessingRecipeVersion = {
      schemaVersion: '1.0',
      recipeId: payload.recipeId,
      spaceId: payload.spaceId,
      predecessorRecipeId: current?.recipeId ?? null,
      sequence: (current?.sequence ?? 0) + 1,
      fingerprint: fingerprint.value,
      configuration: payload.configuration,
      compatibility: [...payload.compatibility],
      createdAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason,
      deprecatedAt: null
    };
    const event = await this.#event(envelope, 'recipe', recipe.recipeId, 'recipe.registered', {
      recipeId: recipe.recipeId,
      predecessorRecipeId: recipe.predecessorRecipeId,
      fingerprint: recipe.fingerprint
    });
    return { ok: true, value: { kind: 'recipe-registered', recipe }, writes: { recipe, events: [event] } };
  }

  #policySnapshot(
    spaceId: SpaceId,
    policyId: PolicySnapshot['policyId'],
    predecessorPolicyId: PolicySnapshot['predecessorPolicyId'],
    sequence: number,
    definition: PolicyDefinition,
    fingerprint: DigestRef,
    envelope: DurableCommandEnvelope<LifecycleCommandPayload>
  ): PolicySnapshot {
    return {
      schemaVersion: '1.0',
      policyId,
      spaceId,
      predecessorPolicyId,
      sequence,
      changeKind: definition.changeKind,
      questionScope: definition.questionScope,
      admission: definition.admission,
      evidence: definition.evidence,
      defaultResult: definition.defaultResult,
      access: definition.access,
      exposure: definition.exposure,
      retention: definition.retention,
      extensions: definition.extensions,
      fingerprint,
      createdAt: envelope.occurredAt,
      actorRef: actorRef(envelope),
      reason: envelope.reason,
      validFrom: definition.validFrom,
      validUntil: definition.validUntil
    };
  }

  async #event(
    envelope: DurableCommandEnvelope<LifecycleCommandPayload>,
    kind: LifecycleEvent['aggregate']['kind'],
    aggregateId: string,
    eventType: string,
    payload: unknown
  ): Promise<LifecycleEvent> {
    const wirePayload = asWireValue(payload);
    const digest = await digestCanonicalJson(wirePayload);
    if (!digest.ok) throw new TypeError(digest.error.summary);
    const aggregateSequence = await this.#nextEventSequence(
      envelope.payload.spaceId,
      aggregateId
    );
    return {
      schemaVersion: '1.0',
      eventId: this.#ids.next('event'),
      eventType,
      aggregate: { kind, id: aggregateId, spaceId: envelope.payload.spaceId },
      aggregateSequence,
      operationId: envelope.operationId,
      causationId: envelope.operationId,
      correlationId: envelope.operationId,
      ...(currentExecutionTrace(envelope.operationId) === null ? {} : { traceContext: currentExecutionTrace(envelope.operationId)! }),
      occurredAt: envelope.occurredAt,
      payloadDigest: digest.value,
      payload: wirePayload
    };
  }

  async #nextEventSequence(spaceId: SpaceId, aggregateId: string): Promise<number> {
    let after: string | undefined;
    let last = 0;
    do {
      const page = after === undefined
        ? await this.#repository.listEvents(spaceId, { limit: 1_000 }, aggregateId)
        : await this.#repository.listEvents(spaceId, { limit: 1_000, after }, aggregateId);
      const finalEvent = page.items.at(-1);
      if (finalEvent !== undefined) last = finalEvent.aggregateSequence;
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    return last + 1;
  }

  async #nextRevisionSequence(spaceId: SpaceId, sourceId: SourceId): Promise<number> {
    let after: string | undefined;
    let last = 0;
    do {
      const page = after === undefined
        ? await this.#repository.listRevisions(spaceId, sourceId, { limit: 1_000 })
        : await this.#repository.listRevisions(spaceId, sourceId, { limit: 1_000, after });
      const finalRevision = page.items.at(-1);
      if (finalRevision !== undefined) last = finalRevision.revision.sequence;
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    return last + 1;
  }

  async #copyChangeSet(
    mode: 'restore' | 'rollback',
    targetRevisionId: RevisionId
  ): Promise<SourceRevision['changeSet']> {
    const changes = asWireValue({ mode, targetRevisionId });
    const digest = await digestCanonicalJson(changes);
    if (!digest.ok) throw new TypeError(digest.error.summary);
    return {
      kind: 'content',
      summary: `${mode} from immutable revision ${targetRevisionId}`,
      changes,
      digest: digest.value
    };
  }

  #revisionExpectedFailure(
    envelope: DurableCommandEnvelope<
      Extract<LifecycleCommandPayload, { type: 'revision.transition' | 'revision.withdraw' }>
    >,
    sourceId: SourceId,
    revisionId: RevisionId
  ): LorebitFailure | null {
    return requireExpected(
      envelope.expected.source?.sourceId === sourceId &&
        envelope.expected.source.sequence !== undefined &&
        envelope.expected.source.revisionId === revisionId,
      `${envelope.payload.type} requires the current source sequence and revision.`
    );
  }

  async #requireOpenSpace(spaceId: SpaceId): Promise<LorebitFailure | null> {
    const space = await this.#repository.getSpace(spaceId);
    if (space === null) return lorebitFailure('not-found', 'Space was not found.');
    return space.status === 'open'
      ? null
      : lorebitFailure('invalid-state-transition', 'Space is frozen or archived.');
  }

  async #allActivations(spaceId: SpaceId) {
    const values = [];
    let after: string | undefined;
    do {
      const page = after === undefined
        ? await this.#repository.listActivations(spaceId, { limit: 1_000 })
        : await this.#repository.listActivations(spaceId, { limit: 1_000, after });
      values.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    return values;
  }

  async #deliverEvents(
    spaceId: SpaceId,
    committed: Extract<RepositoryCommitResult, { ok: true }>,
    diagnostics: Diagnostic[]
  ): Promise<void> {
    try {
      const delivered = await this.#eventSink.publish(committed.events);
      if (delivered.ok) {
        await this.#repository.markOutboxDelivered(
          spaceId,
          committed.events.map((event) => event.eventId),
          this.#clock.now()
        );
      } else {
        diagnostics.push(
          diagnostic('event-delivery-pending', 'warning', delivered.summary, {
            affected: committed.events.map((event) => event.eventId),
            guarantees: ['canonical-facts-committed', 'outbox-retained'],
            recovery: [{ code: 'replay-outbox', summary: 'Retry pending outbox records.' }],
            retryable: delivered.retryable
          })
        );
      }
    } catch {
      diagnostics.push(
        diagnostic(
          'event-delivery-pending',
          'warning',
          'EventSink threw; canonical facts remain committed and outbox records remain pending.',
          {
            affected: committed.events.map((event) => event.eventId),
            guarantees: ['canonical-facts-committed', 'outbox-retained'],
            recovery: [{ code: 'replay-outbox', summary: 'Retry pending outbox records.' }],
            retryable: true
          }
        )
      );
    }
  }
}
