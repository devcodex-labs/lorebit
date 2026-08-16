import type { ExpectedState } from '../application/commands.js';
import type { Page, PageRequest } from '../application/queries.js';
import { createLorebitId, type ActivationId, type RevisionId, type RunId, type SourceId, type SpaceId } from '../domain/ids.js';
import type { LifecycleEvent, OutboxRecord } from '../domain/events.js';
import type { ContentUnitVersion } from '../domain/content-unit.js';
import type { DeltaPlan } from '../domain/delta-plan.js';
import type {
  DeleteReceipt,
  GenerationValidationReceipt,
  IndexGeneration
} from '../domain/index-generation.js';
import { canTransitionIndexGeneration } from '../domain/index-generation.js';
import { canTransitionProcessingRun, type ProcessingRun } from '../domain/processing.js';
import type { KnowledgeSpace, PolicySnapshot } from '../domain/knowledge-space.js';
import type { ImportBatch, Source } from '../domain/source.js';
import type {
  KnowledgeActivation,
  ProcessingRecipeVersion,
  RevisionDecision,
  RevisionLabel,
  RevisionState,
  RevisionView,
  SourceRevision
} from '../domain/versions.js';
import { isJsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  AcquireRunClaimRequest,
  AcquireRunClaimResult,
  FencedWriteResult,
  KnowledgeRepository,
  RepositoryCommitRequest,
  RepositoryCommitResult,
  RepositoryFailure,
  RepositoryOperationRecord,
  RunCheckpoint,
  RunClaim
} from '../ports/knowledge-repository.js';

interface RepositorySpaceState {
  space: KnowledgeSpace | null;
  readonly policies: Map<string, PolicySnapshot>;
  readonly sources: Map<string, Source>;
  readonly importBatches: Map<string, ImportBatch>;
  readonly revisions: Map<string, SourceRevision>;
  readonly revisionStates: Map<string, RevisionState>;
  readonly revisionStateHistory: Map<string, RevisionState[]>;
  readonly labels: Map<string, RevisionLabel>;
  readonly decisions: Map<string, RevisionDecision>;
  readonly latestDecisionIds: Map<string, string>;
  readonly recipes: Map<string, ProcessingRecipeVersion>;
  currentRecipeId: string | null;
  readonly contentUnits: Map<string, ContentUnitVersion>;
  readonly deltaPlans: Map<string, DeltaPlan>;
  readonly runs: Map<string, ProcessingRun>;
  readonly generations: Map<string, IndexGeneration>;
  readonly generationReceipts: Map<string, GenerationValidationReceipt>;
  readonly deleteReceipts: Map<string, DeleteReceipt[]>;
  readonly activations: Map<string, KnowledgeActivation>;
  activeActivationId: string | null;
  readonly events: LifecycleEvent[];
  readonly eventIds: Set<string>;
  readonly aggregateSequences: Map<string, number>;
  readonly outbox: Map<string, OutboxRecord>;
  readonly operations: Map<string, RepositoryOperationRecord>;
  readonly claims: Map<string, RunClaim>;
  readonly checkpoints: Map<string, RunCheckpoint[]>;
}

function createState(): RepositorySpaceState {
  return {
    space: null,
    policies: new Map(),
    sources: new Map(),
    importBatches: new Map(),
    revisions: new Map(),
    revisionStates: new Map(),
    revisionStateHistory: new Map(),
    labels: new Map(),
    decisions: new Map(),
    latestDecisionIds: new Map(),
    recipes: new Map(),
    currentRecipeId: null,
    contentUnits: new Map(),
    deltaPlans: new Map(),
    runs: new Map(),
    generations: new Map(),
    generationReceipts: new Map(),
    deleteReceipts: new Map(),
    activations: new Map(),
    activeActivationId: null,
    events: [],
    eventIds: new Set(),
    aggregateSequences: new Map(),
    outbox: new Map(),
    operations: new Map(),
    claims: new Map(),
    checkpoints: new Map()
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function repositoryFailure(
  code: RepositoryFailure['code'],
  summary: string,
  retryable = false
): RepositoryFailure {
  return { code, summary, retryable };
}

function sameDigest(
  left: RepositoryOperationRecord['commandDigest'],
  right: RepositoryOperationRecord['commandDigest']
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function labelKey(sourceId: SourceId, label: string): string {
  return `${sourceId}\u0000${label}`;
}

function validatePage(page: PageRequest): void {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1_000) {
    throw new RangeError('Repository page limit must be a safe integer from 1 to 1000.');
  }
}

function paginate<T>(
  values: readonly T[],
  page: PageRequest,
  stableKey: (value: T) => string
): Page<T> {
  validatePage(page);
  const after = page.after === undefined ? null : decodeURIComponent(page.after);
  const remaining = after === null
    ? values
    : values.filter((value) => stableKey(value) > after);
  const items = remaining.slice(0, page.limit).map(clone);
  const hasMore = remaining.length > items.length;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last !== undefined
      ? encodeURIComponent(stableKey(last))
      : null
  };
}

function eventAggregateKey(event: LifecycleEvent): string {
  return `${event.aggregate.kind}\u0000${event.aggregate.id}`;
}

function validateExpected(
  state: RepositorySpaceState,
  expected: ExpectedState,
  spaceId: SpaceId
): RepositoryFailure | null {
  if (expected.space !== undefined) {
    if (expected.space.spaceId !== spaceId) {
      return repositoryFailure('state-conflict', 'Expected space does not match commit scope.');
    }
    if (state.space === null) {
      return repositoryFailure('state-conflict', 'Expected space does not exist.');
    }
    if (
      expected.space.sequence !== undefined &&
      state.space.sequence !== expected.space.sequence
    ) {
      return repositoryFailure('state-conflict', 'Space sequence precondition failed.');
    }
    if (
      expected.space.status !== undefined &&
      state.space.status !== expected.space.status
    ) {
      return repositoryFailure('state-conflict', 'Space status precondition failed.');
    }
  }
  if (expected.policyId !== undefined) {
    const actual = state.space?.currentPolicyId ?? null;
    if (actual !== expected.policyId) {
      return repositoryFailure('state-conflict', 'Policy predecessor precondition failed.');
    }
  }
  if (expected.source !== undefined) {
    const source = state.sources.get(expected.source.sourceId);
    if (source === undefined) {
      if (
        expected.source.sequence !== undefined ||
        (expected.source.revisionId !== undefined && expected.source.revisionId !== null)
      ) {
        return repositoryFailure('state-conflict', 'Source predecessor precondition failed.');
      }
    } else {
      if (
        expected.source.sequence !== undefined &&
        source.sequence !== expected.source.sequence
      ) {
        return repositoryFailure('state-conflict', 'Source sequence precondition failed.');
      }
      if (
        expected.source.revisionId !== undefined &&
        source.currentRevisionId !== expected.source.revisionId
      ) {
        return repositoryFailure('state-conflict', 'Revision predecessor precondition failed.');
      }
    }
  }
  if (expected.recipeId !== undefined && state.currentRecipeId !== expected.recipeId) {
    return repositoryFailure('state-conflict', 'Recipe predecessor precondition failed.');
  }
  if (
    expected.activationId !== undefined &&
    state.activeActivationId !== expected.activationId
  ) {
    return repositoryFailure('state-conflict', 'Activation predecessor precondition failed.');
  }
  if (expected.run !== undefined) {
    const run = state.runs.get(expected.run.runId);
    if (run === undefined) {
      return repositoryFailure('state-conflict', 'Expected ProcessingRun does not exist.');
    }
    if (expected.run.sequence !== undefined && run.sequence !== expected.run.sequence) {
      return repositoryFailure('state-conflict', 'ProcessingRun sequence precondition failed.');
    }
    if (expected.run.status !== undefined && run.status !== expected.run.status) {
      return repositoryFailure('state-conflict', 'ProcessingRun status precondition failed.');
    }
  }
  if (expected.generation !== undefined) {
    const generation = state.generations.get(expected.generation.generationId);
    if (generation === undefined) {
      return repositoryFailure('state-conflict', 'Expected IndexGeneration does not exist.');
    }
    if (
      expected.generation.sequence !== undefined &&
      generation.sequence !== expected.generation.sequence
    ) {
      return repositoryFailure('state-conflict', 'IndexGeneration sequence precondition failed.');
    }
    if (
      expected.generation.status !== undefined &&
      generation.status !== expected.generation.status
    ) {
      return repositoryFailure('state-conflict', 'IndexGeneration status precondition failed.');
    }
  }
  if (expected.fencingToken !== undefined) {
    const runId = expected.run?.runId;
    const claim = runId === undefined ? undefined : state.claims.get(runId);
    if (claim === undefined || claim.fencingToken !== expected.fencingToken) {
      return repositoryFailure('stale-run-attempt', 'Run fencing token precondition failed.');
    }
  }
  return null;
}

function validateScope(request: RepositoryCommitRequest): RepositoryFailure | null {
  const facts: Array<{ readonly spaceId: SpaceId } | undefined> = [
    request.writes.space,
    request.writes.policy,
    request.writes.source,
    request.writes.importBatch,
    request.writes.revision,
    request.writes.revisionState,
    request.writes.label,
    request.writes.decision,
    request.writes.recipe,
    request.writes.deltaPlan,
    request.writes.processingRun,
    request.writes.generationReceipt,
    request.writes.activation
  ];
  facts.push(...(request.writes.contentUnits ?? []));
  facts.push(...(request.writes.revisionStates ?? []));
  facts.push(...(request.writes.generations ?? []));
  facts.push(...(request.writes.deleteReceipts ?? []));
  if (facts.some((fact) => fact !== undefined && fact.spaceId !== request.spaceId)) {
    return repositoryFailure('integrity-check-failed', 'A write escaped its space scope.');
  }
  if (
    request.operation.spaceId !== request.spaceId ||
    request.writes.events.some((event) => event.aggregate.spaceId !== request.spaceId)
  ) {
    return repositoryFailure('integrity-check-failed', 'Operation or event scope mismatch.');
  }
  if (!isJsonValue(request.operation.outcome)) {
    return repositoryFailure('integrity-check-failed', 'Operation outcome is not a wire value.');
  }
  return null;
}

function validateWrites(
  state: RepositorySpaceState,
  request: RepositoryCommitRequest
): RepositoryFailure | null {
  const writes = request.writes;
  if (writes.space !== undefined) {
    if (state.space === null) {
      const validInitialStatus = writes.space.status === 'open' ||
        (request.intent === 'import-staging' && writes.space.status === 'frozen');
      if (writes.space.sequence !== 1 || !validInitialStatus) {
        return repositoryFailure('integrity-check-failed', 'New spaces must start open, or explicitly frozen as import staging, at sequence 1.');
      }
    } else if (
      writes.space.spaceId !== state.space.spaceId ||
      writes.space.sequence !== state.space.sequence + 1 ||
      writes.space.createdAt !== state.space.createdAt
    ) {
      return repositoryFailure('state-conflict', 'Space write is not the next immutable projection.');
    }
  }
  if (writes.policy !== undefined) {
    if (state.policies.has(writes.policy.policyId)) {
      return repositoryFailure('state-conflict', 'Policy ids are immutable and cannot be reused.');
    }
    const current = state.space === null
      ? null
      : state.policies.get(state.space.currentPolicyId) ?? null;
    if (
      (current === null &&
        (writes.policy.sequence !== 1 || writes.policy.predecessorPolicyId !== null)) ||
      (current !== null &&
        (writes.policy.sequence !== current.sequence + 1 ||
          writes.policy.predecessorPolicyId !== current.policyId))
    ) {
      return repositoryFailure('state-conflict', 'Policy write is not the next policy clock value.');
    }
  }
  if (writes.source !== undefined) {
    const current = state.sources.get(writes.source.sourceId);
    if (
      (current === undefined && writes.source.sequence !== 1) ||
      (current !== undefined && writes.source.sequence !== current.sequence + 1)
    ) {
      return repositoryFailure('state-conflict', 'Source write is not the next source projection.');
    }
  }
  if (
    writes.importBatch !== undefined &&
    state.importBatches.has(writes.importBatch.importBatchId)
  ) {
    return repositoryFailure('state-conflict', 'ImportBatch ids are immutable.');
  }
  if (writes.revision !== undefined) {
    if (state.revisions.has(writes.revision.revisionId)) {
      return repositoryFailure('state-conflict', 'SourceRevision ids are immutable.');
    }
    const revisions = Array.from(state.revisions.values()).filter(
      (revision) => revision.sourceId === writes.revision?.sourceId
    );
    const nextSequence = revisions.length === 0
      ? 1
      : Math.max(...revisions.map((revision) => revision.sequence)) + 1;
    if (writes.revision.sequence !== nextSequence) {
      return repositoryFailure('state-conflict', 'Revision write is not the next revision clock value.');
    }
  }
  const revisionStateWrites = [
    ...(writes.revisionState === undefined ? [] : [writes.revisionState]),
    ...(writes.revisionStates ?? [])
  ];
  const writtenRevisionIds = new Set<string>();
  for (const revisionState of revisionStateWrites) {
    if (writtenRevisionIds.has(revisionState.revisionId)) {
      return repositoryFailure('integrity-check-failed', 'Revision state was written twice in one commit.');
    }
    writtenRevisionIds.add(revisionState.revisionId);
    const current = state.revisionStates.get(revisionState.revisionId);
    if (
      (current === undefined &&
        (writes.revision === undefined || revisionState.sequence !== 1)) ||
      (current !== undefined && revisionState.sequence !== current.sequence + 1)
    ) {
      return repositoryFailure('state-conflict', 'Revision state projection is not sequential.');
    }
  }
  if (writes.label !== undefined) {
    const current = state.labels.get(labelKey(writes.label.sourceId, writes.label.label));
    const expectedSequence = current === undefined ? 1 : current.sequence + 1;
    if (writes.label.sequence !== expectedSequence) {
      return repositoryFailure('state-conflict', 'Revision label projection is not sequential.');
    }
  }
  if (writes.decision !== undefined && state.decisions.has(writes.decision.decisionId)) {
    return repositoryFailure('state-conflict', 'Decision ids are immutable.');
  }
  if (writes.recipe !== undefined) {
    if (state.recipes.has(writes.recipe.recipeId)) {
      return repositoryFailure('state-conflict', 'Recipe ids are immutable.');
    }
    const current = state.currentRecipeId === null
      ? null
      : state.recipes.get(state.currentRecipeId) ?? null;
    if (
      (current === null &&
        (writes.recipe.sequence !== 1 || writes.recipe.predecessorRecipeId !== null)) ||
      (current !== null &&
        (writes.recipe.sequence !== current.sequence + 1 ||
          writes.recipe.predecessorRecipeId !== current.recipeId))
    ) {
      return repositoryFailure('state-conflict', 'Recipe write is not the next recipe clock value.');
    }
  }
  for (const unit of writes.contentUnits ?? []) {
    if (state.contentUnits.has(unit.unitVersionId)) {
      return repositoryFailure('state-conflict', 'ContentUnitVersion ids are immutable.');
    }
  }
  if (
    writes.deltaPlan !== undefined &&
    state.deltaPlans.has(writes.deltaPlan.deltaPlanId)
  ) {
    return repositoryFailure('state-conflict', 'DeltaPlan ids are immutable.');
  }
  if (writes.processingRun !== undefined) {
    const current = state.runs.get(writes.processingRun.runId);
    if (
      (current === undefined && writes.processingRun.sequence !== 1) ||
      (current !== undefined &&
        (writes.processingRun.sequence !== current.sequence + 1 ||
          !canTransitionProcessingRun(current.status, writes.processingRun.status) ||
          writes.processingRun.startedAt !== current.startedAt ||
          writes.processingRun.inputDigest.value !== current.inputDigest.value))
    ) {
      return repositoryFailure('state-conflict', 'ProcessingRun write is not sequential.');
    }
  }
  for (const generation of writes.generations ?? []) {
    const current = state.generations.get(generation.generationId);
    if (
      (current === undefined && (generation.sequence !== 1 || generation.status !== 'planned')) ||
      (current !== undefined &&
        (generation.sequence !== current.sequence + 1 ||
          !canTransitionIndexGeneration(current.status, generation.status) ||
          generation.createdAt !== current.createdAt ||
          generation.runId !== current.runId ||
          generation.inputManifestDigest.value !== current.inputManifestDigest.value))
    ) {
      return repositoryFailure('state-conflict', 'IndexGeneration write is not a valid next projection.');
    }
  }
  if (
    writes.generationReceipt !== undefined &&
    state.generationReceipts.has(writes.generationReceipt.generationId)
  ) {
    return repositoryFailure('state-conflict', 'GenerationValidationReceipt is immutable.');
  }
  if (writes.activation !== undefined) {
    if (state.activations.has(writes.activation.activationId)) {
      return repositoryFailure('state-conflict', 'Activation ids are immutable.');
    }
    if (writes.activation.predecessorActivationId !== state.activeActivationId) {
      return repositoryFailure('state-conflict', 'Activation predecessor does not match active state.');
    }
    const candidate = (writes.generations ?? []).find(
      (generation) => generation.generationId === writes.activation?.generation.generationId
    ) ?? state.generations.get(writes.activation.generation.generationId);
    const receipt = writes.generationReceipt?.generationId === candidate?.generationId
      ? writes.generationReceipt
      : state.generationReceipts.get(writes.activation.generation.generationId);
    if (
      candidate?.status !== 'active' ||
      receipt?.status !== 'passed' ||
      receipt.inputManifestDigest.value !== writes.activation.generation.inputManifestDigest.value
    ) {
      return repositoryFailure('integrity-check-failed', 'Activation lacks an active validated generation.');
    }
  }
  const aggregateSequences = new Map(state.aggregateSequences);
  for (const event of writes.events) {
    if (state.eventIds.has(event.eventId)) {
      return repositoryFailure('integrity-check-failed', 'Event ids are immutable.');
    }
    const key = eventAggregateKey(event);
    const nextSequence = (aggregateSequences.get(key) ?? 0) + 1;
    if (event.aggregateSequence !== nextSequence) {
      return repositoryFailure('state-conflict', 'Event aggregate sequence contains a gap.');
    }
    aggregateSequences.set(key, nextSequence);
  }
  return null;
}

export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  readonly descriptor = Object.freeze({
    kind: 'knowledge-repository' as const,
    adapterId: '@devcodex/lorebit/testing:in-memory-knowledge-repository',
    name: 'InMemoryKnowledgeRepository',
    version: '0.1',
    testingOnly: true
  });
  readonly capabilities = Object.freeze({
    atomicCommit: true,
    expectedStateCas: true,
    idempotencyRecords: true,
    stablePagination: true,
    outbox: true,
    runClaimFencing: true,
    atomicQuerySnapshot: true,
    spaceIsolation: 'logical-verified' as const
  });
  readonly #spaces = new Map<string, RepositorySpaceState>();
  #closed = false;

  async commit(request: RepositoryCommitRequest): Promise<RepositoryCommitResult> {
    if (this.#closed) {
      return {
        ok: false,
        error: repositoryFailure('adapter-failure', 'Repository is closed.')
      };
    }
    const current = this.#spaces.get(request.spaceId) ?? createState();
    const existing = current.operations.get(request.operation.idempotencyKey);
    if (existing !== undefined) {
      if (!sameDigest(existing.commandDigest, request.operation.commandDigest)) {
        return {
          ok: false,
          error: repositoryFailure(
            'idempotency-conflict',
            'The idempotency key is already bound to another command.'
          )
        };
      }
      return {
        ok: true,
        kind: 'replayed',
        operation: clone(existing),
        events: []
      };
    }
    const scopeFailure = validateScope(request);
    if (scopeFailure !== null) {
      return { ok: false, error: scopeFailure };
    }
    const expectedFailure = validateExpected(current, request.expected, request.spaceId);
    if (expectedFailure !== null) {
      return { ok: false, error: expectedFailure };
    }
    const writeFailure = validateWrites(current, request);
    if (writeFailure !== null) {
      return { ok: false, error: writeFailure };
    }

    const next = clone(current);
    const writes = request.writes;
    if (writes.space !== undefined) next.space = clone(writes.space);
    if (writes.policy !== undefined) next.policies.set(writes.policy.policyId, clone(writes.policy));
    if (writes.source !== undefined) next.sources.set(writes.source.sourceId, clone(writes.source));
    if (writes.importBatch !== undefined) {
      next.importBatches.set(writes.importBatch.importBatchId, clone(writes.importBatch));
    }
    if (writes.revision !== undefined) next.revisions.set(writes.revision.revisionId, clone(writes.revision));
    if (writes.revisionState !== undefined) {
      next.revisionStates.set(writes.revisionState.revisionId, clone(writes.revisionState));
      const history = next.revisionStateHistory.get(writes.revisionState.revisionId) ?? [];
      history.push(clone(writes.revisionState));
      next.revisionStateHistory.set(writes.revisionState.revisionId, history);
    }
    for (const revisionState of writes.revisionStates ?? []) {
      next.revisionStates.set(revisionState.revisionId, clone(revisionState));
      const history = next.revisionStateHistory.get(revisionState.revisionId) ?? [];
      history.push(clone(revisionState));
      next.revisionStateHistory.set(revisionState.revisionId, history);
    }
    if (writes.label !== undefined) {
      next.labels.set(labelKey(writes.label.sourceId, writes.label.label), clone(writes.label));
    }
    if (writes.decision !== undefined) {
      next.decisions.set(writes.decision.decisionId, clone(writes.decision));
      next.latestDecisionIds.set(writes.decision.revisionId, writes.decision.decisionId);
    }
    if (writes.recipe !== undefined) {
      next.recipes.set(writes.recipe.recipeId, clone(writes.recipe));
      next.currentRecipeId = writes.recipe.recipeId;
    }
    for (const unit of writes.contentUnits ?? []) {
      next.contentUnits.set(unit.unitVersionId, clone(unit));
    }
    if (writes.deltaPlan !== undefined) {
      next.deltaPlans.set(writes.deltaPlan.deltaPlanId, clone(writes.deltaPlan));
    }
    if (writes.processingRun !== undefined) {
      next.runs.set(writes.processingRun.runId, clone(writes.processingRun));
    }
    for (const generation of writes.generations ?? []) {
      next.generations.set(generation.generationId, clone(generation));
    }
    if (writes.generationReceipt !== undefined) {
      next.generationReceipts.set(
        writes.generationReceipt.generationId,
        clone(writes.generationReceipt)
      );
    }
    for (const receipt of writes.deleteReceipts ?? []) {
      const receipts = next.deleteReceipts.get(receipt.generationId) ?? [];
      receipts.push(clone(receipt));
      next.deleteReceipts.set(receipt.generationId, receipts);
    }
    if (writes.activation !== undefined) {
      next.activations.set(writes.activation.activationId, clone(writes.activation));
      next.activeActivationId = writes.activation.activationId;
    }
    for (const event of writes.events) {
      const eventCopy = clone(event);
      next.events.push(eventCopy);
      next.eventIds.add(event.eventId);
      next.aggregateSequences.set(eventAggregateKey(event), event.aggregateSequence);
      const rawId = event.eventId.slice(event.eventId.indexOf('_') + 1);
      const outboxId = createLorebitId('outbox', rawId);
      next.outbox.set(event.eventId, {
        outboxId,
        spaceId: request.spaceId,
        event: eventCopy,
        status: 'pending',
        attemptCount: 0,
        deliveredAt: null
      });
    }
    next.operations.set(request.operation.idempotencyKey, clone(request.operation));
    this.#spaces.set(request.spaceId, next);
    return {
      ok: true,
      kind: 'committed',
      operation: clone(request.operation),
      events: clone(writes.events)
    };
  }

  async getOperation(
    spaceId: SpaceId,
    idempotencyKey: string
  ): Promise<RepositoryOperationRecord | null> {
    return clone(this.#spaces.get(spaceId)?.operations.get(idempotencyKey) ?? null);
  }

  async getSpace(spaceId: SpaceId): Promise<KnowledgeSpace | null> {
    return clone(this.#spaces.get(spaceId)?.space ?? null);
  }

  async getPolicy(spaceId: SpaceId, policyId: string): Promise<PolicySnapshot | null> {
    return clone(this.#spaces.get(spaceId)?.policies.get(policyId) ?? null);
  }

  async listPolicies(spaceId: SpaceId, page: PageRequest): Promise<Page<PolicySnapshot>> {
    const values = Array.from(this.#spaces.get(spaceId)?.policies.values() ?? []).sort(
      (left, right) => left.sequence - right.sequence || left.policyId.localeCompare(right.policyId)
    );
    return paginate(values, page, (policy) =>
      `${String(policy.sequence).padStart(12, '0')}|${policy.policyId}`
    );
  }

  async getSource(spaceId: SpaceId, sourceId: SourceId): Promise<Source | null> {
    return clone(this.#spaces.get(spaceId)?.sources.get(sourceId) ?? null);
  }

  async listSources(spaceId: SpaceId, page: PageRequest): Promise<Page<Source>> {
    const values = Array.from(this.#spaces.get(spaceId)?.sources.values() ?? []).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.sourceId.localeCompare(right.sourceId)
    );
    return paginate(values, page, (source) => `${source.createdAt}|${source.sourceId}`);
  }

  async getImportBatch(spaceId: SpaceId, importBatchId: string): Promise<ImportBatch | null> {
    return clone(this.#spaces.get(spaceId)?.importBatches.get(importBatchId) ?? null);
  }

  async listImportBatches(spaceId: SpaceId, page: PageRequest): Promise<Page<ImportBatch>> {
    const values = Array.from(this.#spaces.get(spaceId)?.importBatches.values() ?? []).sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.importBatchId.localeCompare(right.importBatchId)
    );
    return paginate(values, page, (batch) => `${batch.createdAt}|${batch.importBatchId}`);
  }

  async getRevision(
    spaceId: SpaceId,
    revisionId: RevisionId
  ): Promise<RevisionView | null> {
    const state = this.#spaces.get(spaceId);
    const revision = state?.revisions.get(revisionId);
    const revisionState = state?.revisionStates.get(revisionId);
    return revision === undefined || revisionState === undefined
      ? null
      : clone({ revision, state: revisionState });
  }

  async getRevisionAt(
    spaceId: SpaceId,
    revisionId: RevisionId,
    at: Rfc3339Utc
  ): Promise<RevisionView | null> {
    const state = this.#spaces.get(spaceId);
    const revision = state?.revisions.get(revisionId);
    const revisionState = state?.revisionStateHistory
      .get(revisionId)
      ?.filter((item) => item.changedAt <= at)
      .toSorted(
        (left, right) =>
          left.changedAt.localeCompare(right.changedAt) || left.sequence - right.sequence
      )
      .at(-1);
    return revision === undefined || revisionState === undefined
      ? null
      : clone({ revision, state: revisionState });
  }

  async listRevisions(
    spaceId: SpaceId,
    sourceId: SourceId,
    page: PageRequest
  ): Promise<Page<RevisionView>> {
    const state = this.#spaces.get(spaceId);
    const values = Array.from(state?.revisions.values() ?? [])
      .filter((revision) => revision.sourceId === sourceId)
      .map((revision) => ({
        revision,
        state: state?.revisionStates.get(revision.revisionId)
      }))
      .filter((value): value is RevisionView => value.state !== undefined)
      .sort(
        (left, right) =>
          left.revision.sequence - right.revision.sequence ||
          left.revision.revisionId.localeCompare(right.revision.revisionId)
      );
    return paginate(values, page, (view) =>
      `${String(view.revision.sequence).padStart(12, '0')}|${view.revision.revisionId}`
    );
  }

  async getRevisionByLabel(
    spaceId: SpaceId,
    sourceId: SourceId,
    label: string
  ): Promise<RevisionView | null> {
    const record = this.#spaces.get(spaceId)?.labels.get(labelKey(sourceId, label));
    return record === undefined ? null : this.getRevision(spaceId, record.revisionId);
  }

  async getRevisionLabel(
    spaceId: SpaceId,
    sourceId: SourceId,
    label: string
  ): Promise<RevisionLabel | null> {
    return clone(this.#spaces.get(spaceId)?.labels.get(labelKey(sourceId, label)) ?? null);
  }

  async getDecision(
    spaceId: SpaceId,
    revisionId: RevisionId
  ): Promise<RevisionDecision | null> {
    const state = this.#spaces.get(spaceId);
    const decisionId = state?.latestDecisionIds.get(revisionId);
    return decisionId === undefined ? null : clone(state?.decisions.get(decisionId) ?? null);
  }

  async listDecisions(
    spaceId: SpaceId,
    revisionId: RevisionId,
    page: PageRequest
  ): Promise<Page<RevisionDecision>> {
    const values = Array.from(this.#spaces.get(spaceId)?.decisions.values() ?? [])
      .filter((decision) => decision.revisionId === revisionId)
      .sort(
        (left, right) =>
          left.decidedAt.localeCompare(right.decidedAt) ||
          left.decisionId.localeCompare(right.decisionId)
      );
    return paginate(values, page, (decision) =>
      `${decision.decidedAt}|${decision.decisionId}`
    );
  }

  async getCurrentRecipe(spaceId: SpaceId): Promise<ProcessingRecipeVersion | null> {
    const state = this.#spaces.get(spaceId);
    return state?.currentRecipeId === null || state?.currentRecipeId === undefined
      ? null
      : clone(state.recipes.get(state.currentRecipeId) ?? null);
  }

  async getRecipe(spaceId: SpaceId, recipeId: string): Promise<ProcessingRecipeVersion | null> {
    return clone(this.#spaces.get(spaceId)?.recipes.get(recipeId) ?? null);
  }

  async listRecipes(
    spaceId: SpaceId,
    page: PageRequest
  ): Promise<Page<ProcessingRecipeVersion>> {
    const values = Array.from(this.#spaces.get(spaceId)?.recipes.values() ?? []).sort(
      (left, right) => left.sequence - right.sequence || left.recipeId.localeCompare(right.recipeId)
    );
    return paginate(values, page, (recipe) =>
      `${String(recipe.sequence).padStart(12, '0')}|${recipe.recipeId}`
    );
  }

  async getContentUnitVersion(
    spaceId: SpaceId,
    unitVersionId: string
  ): Promise<ContentUnitVersion | null> {
    return clone(this.#spaces.get(spaceId)?.contentUnits.get(unitVersionId) ?? null);
  }

  async listContentUnitsForRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
    page: PageRequest
  ): Promise<Page<ContentUnitVersion>> {
    const values = Array.from(this.#spaces.get(spaceId)?.contentUnits.values() ?? [])
      .filter((unit) => unit.revisionId === revisionId)
      .sort(
        (left, right) =>
          left.identity.unitId.localeCompare(right.identity.unitId, 'en') ||
          left.unitVersionId.localeCompare(right.unitVersionId, 'en')
      );
    return paginate(values, page, (unit) => `${unit.identity.unitId}|${unit.unitVersionId}`);
  }

  async getDeltaPlan(spaceId: SpaceId, deltaPlanId: string): Promise<DeltaPlan | null> {
    return clone(this.#spaces.get(spaceId)?.deltaPlans.get(deltaPlanId) ?? null);
  }

  async getRun(spaceId: SpaceId, runId: RunId): Promise<ProcessingRun | null> {
    return clone(this.#spaces.get(spaceId)?.runs.get(runId) ?? null);
  }

  async listRuns(spaceId: SpaceId, page: PageRequest): Promise<Page<ProcessingRun>> {
    const values = Array.from(this.#spaces.get(spaceId)?.runs.values() ?? []).sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId)
    );
    return paginate(values, page, (run) => `${run.startedAt}|${run.runId}`);
  }

  async getGeneration(
    spaceId: SpaceId,
    generationId: string
  ): Promise<IndexGeneration | null> {
    return clone(this.#spaces.get(spaceId)?.generations.get(generationId) ?? null);
  }

  async listGenerations(spaceId: SpaceId, page: PageRequest): Promise<Page<IndexGeneration>> {
    const values = Array.from(this.#spaces.get(spaceId)?.generations.values() ?? []).sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.generationId.localeCompare(right.generationId)
    );
    return paginate(values, page, (generation) =>
      `${generation.createdAt}|${generation.generationId}`
    );
  }

  async getGenerationReceipt(
    spaceId: SpaceId,
    generationId: string
  ): Promise<GenerationValidationReceipt | null> {
    return clone(this.#spaces.get(spaceId)?.generationReceipts.get(generationId) ?? null);
  }

  async getQuerySnapshot(spaceId: SpaceId) {
    const activation = await this.getActiveActivation(spaceId);
    return activation === null
      ? null
      : {
          schemaVersion: '1.0' as const,
          spaceId,
          activationId: activation.activationId,
          policyId: activation.policyId,
          generationId: activation.generation.generationId,
          revisions: activation.revisions,
          revisionManifestDigest: activation.revisionManifestDigest,
          capturedAt: activation.createdAt
        };
  }

  async listDeleteReceipts(
    spaceId: SpaceId,
    generationId: string
  ): Promise<readonly DeleteReceipt[]> {
    return clone(this.#spaces.get(spaceId)?.deleteReceipts.get(generationId) ?? []);
  }

  async getActiveActivation(spaceId: SpaceId): Promise<KnowledgeActivation | null> {
    const state = this.#spaces.get(spaceId);
    return state?.activeActivationId === null || state?.activeActivationId === undefined
      ? null
      : clone(state.activations.get(state.activeActivationId) ?? null);
  }

  async getActivation(
    spaceId: SpaceId,
    activationId: ActivationId
  ): Promise<KnowledgeActivation | null> {
    return clone(this.#spaces.get(spaceId)?.activations.get(activationId) ?? null);
  }

  async listActivations(
    spaceId: SpaceId,
    page: PageRequest
  ): Promise<Page<KnowledgeActivation>> {
    const values = Array.from(this.#spaces.get(spaceId)?.activations.values() ?? []).sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.activationId.localeCompare(right.activationId)
    );
    return paginate(values, page, (activation) =>
      `${activation.createdAt}|${activation.activationId}`
    );
  }

  async listEvents(
    spaceId: SpaceId,
    page: PageRequest,
    aggregateId?: string
  ): Promise<Page<LifecycleEvent>> {
    const values = Array.from(this.#spaces.get(spaceId)?.events ?? [])
      .filter((event) => aggregateId === undefined || event.aggregate.id === aggregateId)
      .sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) ||
          left.eventId.localeCompare(right.eventId)
      );
    return paginate(values, page, (event) => `${event.occurredAt}|${event.eventId}`);
  }

  async listOutbox(spaceId: SpaceId, page: PageRequest): Promise<Page<OutboxRecord>> {
    const values = Array.from(this.#spaces.get(spaceId)?.outbox.values() ?? []).sort(
      (left, right) =>
        left.event.occurredAt.localeCompare(right.event.occurredAt) ||
        left.event.eventId.localeCompare(right.event.eventId)
    );
    return paginate(values, page, (record) =>
      `${record.event.occurredAt}|${record.event.eventId}`
    );
  }

  async markOutboxDelivered(
    spaceId: SpaceId,
    eventIds: readonly string[],
    deliveredAt: Rfc3339Utc
  ): Promise<void> {
    const current = this.#spaces.get(spaceId);
    if (current === undefined || eventIds.length === 0) return;
    const next = clone(current);
    for (const eventId of eventIds) {
      const record = next.outbox.get(eventId);
      if (record !== undefined) {
        next.outbox.set(eventId, {
          ...record,
          status: 'delivered',
          attemptCount: record.attemptCount + 1,
          deliveredAt
        });
      }
    }
    this.#spaces.set(spaceId, next);
  }

  async acquireRunClaim(request: AcquireRunClaimRequest): Promise<AcquireRunClaimResult> {
    const currentState = this.#spaces.get(request.spaceId);
    if (currentState?.space === null || currentState === undefined) {
      return {
        ok: false,
        error: repositoryFailure('not-found', 'Run claim space does not exist.'),
        current: null
      };
    }
    if (request.leaseUntil <= request.now) {
      return {
        ok: false,
        error: repositoryFailure('state-conflict', 'Run claim lease must end after now.'),
        current: null
      };
    }
    const existing = currentState.claims.get(request.runId);
    if (
      existing !== undefined &&
      existing.leaseUntil > request.now &&
      existing.workerId !== request.workerId
    ) {
      return {
        ok: false,
        error: repositoryFailure('state-conflict', 'Another worker holds the unexpired run lease.', true),
        current: clone(existing)
      };
    }
    const claim: RunClaim = existing !== undefined && existing.leaseUntil > request.now
      ? { ...existing, leaseUntil: request.leaseUntil }
      : {
          schemaVersion: '1.0',
          spaceId: request.spaceId,
          runId: request.runId,
          workerId: request.workerId,
          attempt: (existing?.attempt ?? 0) + 1,
          fencingToken: (existing?.fencingToken ?? 0) + 1,
          claimedAt: request.now,
          leaseUntil: request.leaseUntil
        };
    const next = clone(currentState);
    next.claims.set(request.runId, claim);
    this.#spaces.set(request.spaceId, next);
    return { ok: true, value: clone(claim) };
  }

  async getRunClaim(spaceId: SpaceId, runId: RunId): Promise<RunClaim | null> {
    return clone(this.#spaces.get(spaceId)?.claims.get(runId) ?? null);
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<FencedWriteResult> {
    const current = this.#spaces.get(checkpoint.spaceId);
    const claim = current?.claims.get(checkpoint.runId);
    if (
      current === undefined ||
      claim === undefined ||
      claim.fencingToken !== checkpoint.fencingToken ||
      claim.attempt !== checkpoint.attempt ||
      checkpoint.savedAt > claim.leaseUntil
    ) {
      return {
        ok: false,
        error: repositoryFailure(
          'stale-run-attempt',
          'Checkpoint fencing token or lease is stale.'
        )
      };
    }
    const next = clone(current);
    const history = next.checkpoints.get(checkpoint.runId) ?? [];
    history.push(clone(checkpoint));
    next.checkpoints.set(checkpoint.runId, history);
    this.#spaces.set(checkpoint.spaceId, next);
    return { ok: true };
  }

  async getCheckpoint(spaceId: SpaceId, runId: RunId): Promise<RunCheckpoint | null> {
    const history = this.#spaces.get(spaceId)?.checkpoints.get(runId) ?? [];
    return clone(history.at(-1) ?? null);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
