import { decodeJsonValue, type JsonValue } from '../wire/json-value.js';
import { decodeRfc3339Utc, type Rfc3339Utc } from '../wire/rfc3339.js';
import { decodeDigestRef } from '../wire/digest.js';
import { decodeLorebitId } from '../domain/ids.js';
import type {
  ActivationId,
  DecisionId,
  GenerationId,
  ImportBatchId,
  OperationId,
  PolicyId,
  RecipeId,
  RevisionId,
  RunId,
  SourceId,
  SpaceId
} from '../domain/ids.js';
import type {
  AccessPolicy,
  AdmissionPolicy,
  DefaultResultPolicy,
  EvidencePolicy,
  ExposurePolicy,
  QuestionScope,
  RetentionPolicy
} from '../domain/knowledge-space.js';
import type {
  SourceLocator,
  SourceOwnership,
  SourceSnapshotRef,
  SourceStatus,
  SyncCursor
} from '../domain/source.js';
import type {
  ChangeSetInput,
  DecisionStatus,
  RevisionStatus
} from '../domain/versions.js';

export interface ActorRef {
  readonly type: string;
  readonly id: string;
}

export interface TraceCarrier {
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}

/** Live process controls are deliberately not part of the durable envelope. */
export interface ExecutionOptions {
  readonly signal?: AbortSignal;
  readonly trace?: TraceCarrier;
  readonly deadlineAt?: Rfc3339Utc;
  readonly workerId?: string;
  readonly leaseMilliseconds?: number;
}

export interface ExpectedState {
  readonly space?: {
    readonly spaceId: SpaceId;
    readonly sequence?: number;
    readonly status?: 'open' | 'frozen' | 'archived';
  };
  readonly policyId?: PolicyId | null;
  readonly source?: {
    readonly sourceId: SourceId;
    readonly sequence?: number;
    readonly revisionId?: RevisionId | null;
  };
  readonly recipeId?: RecipeId | null;
  readonly activationId?: string | null;
  readonly fencingToken?: number;
  readonly run?: {
    readonly runId: RunId;
    readonly sequence?: number;
    readonly status?: 'queued' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled';
  };
  readonly generation?: {
    readonly generationId: GenerationId;
    readonly sequence?: number;
    readonly status?:
      | 'planned'
      | 'building'
      | 'validating'
      | 'ready'
      | 'active'
      | 'retired'
      | 'failed'
      | 'cancelled';
  };
}

export interface PolicyDefinition {
  readonly changeKind: 'query-only' | 'access-projection' | 'index-affecting';
  readonly questionScope: QuestionScope;
  readonly admission: AdmissionPolicy;
  readonly evidence: EvidencePolicy;
  readonly defaultResult: DefaultResultPolicy;
  readonly access: AccessPolicy;
  readonly exposure: ExposurePolicy;
  readonly retention: RetentionPolicy;
  readonly extensions: JsonValue;
  readonly validFrom: Rfc3339Utc;
  readonly validUntil: Rfc3339Utc | null;
}

export interface CreateSpaceCommand {
  readonly type: 'space.create';
  readonly spaceId: SpaceId;
  readonly policyId: PolicyId;
  readonly name: string;
  readonly description: string;
  readonly metadata: JsonValue;
  readonly policy: PolicyDefinition;
}

export interface UpdateSpaceCommand {
  readonly type: 'space.update';
  readonly spaceId: SpaceId;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonValue;
}

export interface FreezeSpaceCommand {
  readonly type: 'space.freeze';
  readonly spaceId: SpaceId;
}

export interface ReopenSpaceCommand {
  readonly type: 'space.reopen';
  readonly spaceId: SpaceId;
}

export interface ArchiveSpaceCommand {
  readonly type: 'space.archive';
  readonly spaceId: SpaceId;
}

export interface UpdatePolicyCommand {
  readonly type: 'policy.update';
  readonly spaceId: SpaceId;
  readonly policyId: PolicyId;
  readonly policy: PolicyDefinition;
}

export interface RegisterSourceCommand {
  readonly type: 'source.register';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly kind: string;
  readonly name: string;
  readonly locator: SourceLocator;
  readonly ownership: SourceOwnership;
  readonly parentSourceId: SourceId | null;
  readonly importBatchId?: ImportBatchId;
  readonly syncCursor?: SyncCursor;
  readonly visibilityLabels: readonly string[];
  readonly metadata: JsonValue;
}

export interface SignalSourceAvailabilityCommand {
  readonly type: 'source.signal';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly status: Exclude<SourceStatus, 'registered'>;
  readonly syncCursor?: SyncCursor;
}

export interface RecordImportBatchCommand {
  readonly type: 'import.record';
  readonly spaceId: SpaceId;
  readonly importBatchId: ImportBatchId;
  readonly sourceIds: readonly SourceId[];
  readonly manifest: JsonValue;
  readonly status: 'complete' | 'partial' | 'failed';
  readonly acceptedCount: number;
  readonly failedCount: number;
  readonly errors: readonly {
    readonly sourceRef: string;
    readonly code: string;
    readonly summary: string;
  }[];
}

export interface SubmitRevisionCommand {
  readonly type: 'revision.submit';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly snapshot: SourceSnapshotRef;
  readonly locator?: SourceLocator;
  readonly changeSet: ChangeSetInput;
  readonly metadata: JsonValue;
  readonly derivedFromRevisionIds: readonly RevisionId[];
  readonly effectiveFrom: Rfc3339Utc;
  readonly effectiveUntil: Rfc3339Utc | null;
}

export interface TransitionRevisionCommand {
  readonly type: 'revision.transition';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly status: RevisionStatus;
}

export interface SetRevisionLabelCommand {
  readonly type: 'revision.label';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly label: string;
}

export interface RecordRevisionDecisionCommand {
  readonly type: 'revision.decision';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly decisionId: DecisionId;
  readonly status: DecisionStatus;
}

export interface WithdrawRevisionCommand {
  readonly type: 'revision.withdraw';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
}

export interface RestoreRevisionCommand {
  readonly type: 'revision.restore';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly fromRevisionId: RevisionId;
  readonly newRevisionId: RevisionId;
}

export interface RollbackRevisionCommand {
  readonly type: 'revision.rollback';
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly targetRevisionId: RevisionId;
  readonly newRevisionId: RevisionId;
}

export interface RegisterRecipeCommand {
  readonly type: 'recipe.register';
  readonly spaceId: SpaceId;
  readonly recipeId: RecipeId;
  readonly configuration: JsonValue;
  readonly compatibility: readonly string[];
}

export interface RunProcessingCommand {
  readonly type: 'processing.run';
  readonly spaceId: SpaceId;
  readonly runId: RunId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly recipeId: RecipeId;
  readonly generationId: GenerationId;
  readonly baseGenerationId: GenerationId | null;
}

export interface ResumeProcessingCommand {
  readonly type: 'processing.resume';
  readonly spaceId: SpaceId;
  readonly runId: RunId;
}

export interface CancelProcessingRunCommand {
  readonly type: 'processing.cancel';
  readonly spaceId: SpaceId;
  readonly runId: RunId;
}

export interface BuildGenerationCommand {
  readonly type: 'generation.build';
  readonly spaceId: SpaceId;
  readonly generationId: GenerationId;
  readonly runId: RunId;
}

export interface ValidateGenerationCommand {
  readonly type: 'generation.validate';
  readonly spaceId: SpaceId;
  readonly generationId: GenerationId;
  readonly receiptValidForMilliseconds: number;
}

export interface ActivateGenerationCommand {
  readonly type: 'generation.activate';
  readonly spaceId: SpaceId;
  readonly generationId: GenerationId;
  readonly activationId: ActivationId;
  readonly policyId: PolicyId;
}

export interface RetireGenerationCommand {
  readonly type: 'generation.retire';
  readonly spaceId: SpaceId;
  readonly generationId: GenerationId;
}

export type LifecycleCommandPayload =
  | CreateSpaceCommand
  | UpdateSpaceCommand
  | FreezeSpaceCommand
  | ReopenSpaceCommand
  | ArchiveSpaceCommand
  | UpdatePolicyCommand
  | RegisterSourceCommand
  | SignalSourceAvailabilityCommand
  | RecordImportBatchCommand
  | SubmitRevisionCommand
  | TransitionRevisionCommand
  | SetRevisionLabelCommand
  | RecordRevisionDecisionCommand
  | WithdrawRevisionCommand
  | RestoreRevisionCommand
  | RollbackRevisionCommand
  | RegisterRecipeCommand;

export type ProcessingCommandPayload =
  | RunProcessingCommand
  | ResumeProcessingCommand
  | CancelProcessingRunCommand
  | BuildGenerationCommand
  | ValidateGenerationCommand
  | ActivateGenerationCommand
  | RetireGenerationCommand;

export type LorebitCommandPayload = LifecycleCommandPayload | ProcessingCommandPayload;

export interface DurableCommandEnvelope<P extends LorebitCommandPayload> {
  readonly schemaVersion: '1.0';
  readonly commandType: P['type'];
  readonly operationId: OperationId;
  readonly idempotencyKey: string;
  readonly actorRef: ActorRef;
  readonly reason: string;
  readonly occurredAt: Rfc3339Utc;
  readonly requestedDeadlineAt?: Rfc3339Utc;
  readonly expected: ExpectedState;
  readonly payload: P;
}

export type DurableEnvelopeValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'schema-invalid' | 'invalid-request';
        readonly summary: string;
      };
    };

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function hasOnlyKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(input, key)) &&
    Object.keys(input).every((key) => allowed.has(key));
}

function isStringArray(input: unknown): input is readonly string[] {
  return Array.isArray(input) && input.every((item) => typeof item === 'string');
}

function isSafeNonNegativeInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
}

function isLorebitId(kind: Parameters<typeof decodeLorebitId>[0], input: unknown): boolean {
  return decodeLorebitId(kind, input).ok;
}

function isLocator(input: unknown): boolean {
  return isRecord(input) &&
    hasOnlyKeys(input, ['kind', 'value', 'fragment']) &&
    ['url', 'file', 'external', 'section', 'custom'].includes(String(input.kind)) &&
    typeof input.value === 'string' &&
    (input.fragment === null || typeof input.fragment === 'string');
}

function isSyncCursor(input: unknown): boolean {
  return isRecord(input) &&
    hasOnlyKeys(input, ['kind', 'value', 'observedAt']) &&
    (input.kind === 'snapshot' || input.kind === 'incremental') &&
    typeof input.value === 'string' &&
    decodeRfc3339Utc(input.observedAt).ok;
}

function isPolicyDefinition(input: unknown): boolean {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'changeKind',
    'questionScope',
    'admission',
    'evidence',
    'defaultResult',
    'access',
    'exposure',
    'retention',
    'extensions',
    'validFrom',
    'validUntil'
  ])) return false;
  const questionScope = input.questionScope;
  const admission = input.admission;
  const evidence = input.evidence;
  const defaultResult = input.defaultResult;
  const access = input.access;
  const exposure = input.exposure;
  const retention = input.retention;
  return ['query-only', 'access-projection', 'index-affecting'].includes(String(input.changeKind)) &&
    isRecord(questionScope) &&
    hasOnlyKeys(questionScope, ['allowed', 'denied']) &&
    isStringArray(questionScope.allowed) &&
    isStringArray(questionScope.denied) &&
    isRecord(admission) &&
    hasOnlyKeys(admission, ['allowedSourceKinds', 'requiredMetadata']) &&
    isStringArray(admission.allowedSourceKinds) &&
    isStringArray(admission.requiredMetadata) &&
    isRecord(evidence) &&
    hasOnlyKeys(evidence, [
      'minimumCitations',
      'allowedEvidenceKinds',
      'onInsufficientEvidence'
    ]) &&
    isSafeNonNegativeInteger(evidence.minimumCitations) &&
    isStringArray(evidence.allowedEvidenceKinds) &&
    ['empty', 'partial', 'reject'].includes(String(evidence.onInsufficientEvidence)) &&
    isRecord(defaultResult) &&
    hasOnlyKeys(defaultResult, ['allowPartial', 'allowHistorical', 'emptyResult']) &&
    typeof defaultResult.allowPartial === 'boolean' &&
    typeof defaultResult.allowHistorical === 'boolean' &&
    ['empty', 'insufficient-evidence'].includes(String(defaultResult.emptyResult)) &&
    isRecord(access) &&
    hasOnlyKeys(access, ['requiredLabels', 'excludedLabels', 'failClosed']) &&
    isStringArray(access.requiredLabels) &&
    isStringArray(access.excludedLabels) &&
    access.failClosed === true &&
    isRecord(exposure) &&
    hasOnlyKeys(exposure, ['hiddenFields', 'hiddenContentLabels']) &&
    isStringArray(exposure.hiddenFields) &&
    isStringArray(exposure.hiddenContentLabels) &&
    isRecord(retention) &&
    hasOnlyKeys(retention, ['auditDays', 'contentDays', 'tombstoneOnExpiry']) &&
    isSafeNonNegativeInteger(retention.auditDays) &&
    (retention.contentDays === null || isSafeNonNegativeInteger(retention.contentDays)) &&
    typeof retention.tombstoneOnExpiry === 'boolean' &&
    decodeRfc3339Utc(input.validFrom).ok &&
    (input.validUntil === null || decodeRfc3339Utc(input.validUntil).ok);
}

function isContentSnapshot(input: unknown): boolean {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'content',
    'rawDigest',
    'normalizedDigest',
    'capturedAt'
  ])) return false;
  const content = input.content;
  return isRecord(content) &&
    hasOnlyKeys(content, [
      'schemaVersion',
      'spaceId',
      'contentId',
      'mediaType',
      'byteLength',
      'digest'
    ]) &&
    content.schemaVersion === '1.0' &&
    isLorebitId('space', content.spaceId) &&
    isLorebitId('content', content.contentId) &&
    typeof content.mediaType === 'string' &&
    content.mediaType.length > 0 &&
    isSafeNonNegativeInteger(content.byteLength) &&
    decodeDigestRef(content.digest).ok &&
    decodeDigestRef(input.rawDigest).ok &&
    decodeDigestRef(input.normalizedDigest).ok &&
    decodeRfc3339Utc(input.capturedAt).ok;
}

const PAYLOAD_SHAPES: Readonly<Record<
  LorebitCommandPayload['type'],
  { readonly required: readonly string[]; readonly optional?: readonly string[] }
>> = {
  'space.create': {
    required: ['type', 'spaceId', 'policyId', 'name', 'description', 'metadata', 'policy']
  },
  'space.update': {
    required: ['type', 'spaceId'],
    optional: ['name', 'description', 'metadata']
  },
  'space.freeze': { required: ['type', 'spaceId'] },
  'space.reopen': { required: ['type', 'spaceId'] },
  'space.archive': { required: ['type', 'spaceId'] },
  'policy.update': { required: ['type', 'spaceId', 'policyId', 'policy'] },
  'source.register': {
    required: [
      'type',
      'spaceId',
      'sourceId',
      'kind',
      'name',
      'locator',
      'ownership',
      'parentSourceId',
      'visibilityLabels',
      'metadata'
    ],
    optional: ['importBatchId', 'syncCursor']
  },
  'source.signal': {
    required: ['type', 'spaceId', 'sourceId', 'status'],
    optional: ['syncCursor']
  },
  'import.record': {
    required: [
      'type',
      'spaceId',
      'importBatchId',
      'sourceIds',
      'manifest',
      'status',
      'acceptedCount',
      'failedCount',
      'errors'
    ]
  },
  'revision.submit': {
    required: [
      'type',
      'spaceId',
      'sourceId',
      'revisionId',
      'snapshot',
      'changeSet',
      'metadata',
      'derivedFromRevisionIds',
      'effectiveFrom',
      'effectiveUntil'
    ],
    optional: ['locator']
  },
  'revision.transition': {
    required: ['type', 'spaceId', 'sourceId', 'revisionId', 'status']
  },
  'revision.label': {
    required: ['type', 'spaceId', 'sourceId', 'revisionId', 'label']
  },
  'revision.decision': {
    required: ['type', 'spaceId', 'sourceId', 'revisionId', 'decisionId', 'status']
  },
  'revision.withdraw': {
    required: ['type', 'spaceId', 'sourceId', 'revisionId']
  },
  'revision.restore': {
    required: ['type', 'spaceId', 'sourceId', 'fromRevisionId', 'newRevisionId']
  },
  'revision.rollback': {
    required: ['type', 'spaceId', 'sourceId', 'targetRevisionId', 'newRevisionId']
  },
  'recipe.register': {
    required: ['type', 'spaceId', 'recipeId', 'configuration', 'compatibility']
  },
  'processing.run': {
    required: [
      'type',
      'spaceId',
      'runId',
      'sourceId',
      'revisionId',
      'recipeId',
      'generationId',
      'baseGenerationId'
    ]
  },
  'processing.resume': { required: ['type', 'spaceId', 'runId'] },
  'processing.cancel': { required: ['type', 'spaceId', 'runId'] },
  'generation.build': { required: ['type', 'spaceId', 'generationId', 'runId'] },
  'generation.validate': {
    required: ['type', 'spaceId', 'generationId', 'receiptValidForMilliseconds']
  },
  'generation.activate': {
    required: ['type', 'spaceId', 'generationId', 'activationId', 'policyId']
  },
  'generation.retire': { required: ['type', 'spaceId', 'generationId'] }
};

function payloadValidationFailure(input: unknown): string | null {
  if (!isRecord(input) || typeof input.type !== 'string') {
    return 'Command payload must be an object with a type.';
  }
  const shape = PAYLOAD_SHAPES[input.type as LorebitCommandPayload['type']];
  if (shape === undefined) return 'Command payload type is unsupported.';
  if (!hasOnlyKeys(input, shape.required, shape.optional ?? [])) {
    return 'Command payload has missing or unknown fields.';
  }
  if (!isLorebitId('space', input.spaceId)) return 'Command payload has an invalid spaceId.';

  switch (input.type) {
    case 'space.create':
      return isLorebitId('policy', input.policyId) &&
        typeof input.name === 'string' &&
        typeof input.description === 'string' &&
        isPolicyDefinition(input.policy)
        ? null
        : 'space.create payload is invalid.';
    case 'space.update':
      return (input.name === undefined || typeof input.name === 'string') &&
        (input.description === undefined || typeof input.description === 'string')
        ? null
        : 'space.update payload is invalid.';
    case 'space.freeze':
    case 'space.reopen':
    case 'space.archive':
      return null;
    case 'policy.update':
      return isLorebitId('policy', input.policyId) && isPolicyDefinition(input.policy)
        ? null
        : 'policy.update payload is invalid.';
    case 'source.register': {
      const ownership = input.ownership;
      return isLorebitId('source', input.sourceId) &&
        typeof input.kind === 'string' &&
        typeof input.name === 'string' &&
        isLocator(input.locator) &&
        isRecord(ownership) &&
        hasOnlyKeys(ownership, ['ownerRef', 'license', 'usageTerms']) &&
        typeof ownership.ownerRef === 'string' &&
        (ownership.license === null || typeof ownership.license === 'string') &&
        (ownership.usageTerms === null || typeof ownership.usageTerms === 'string') &&
        (input.parentSourceId === null || isLorebitId('source', input.parentSourceId)) &&
        (input.importBatchId === undefined || isLorebitId('import', input.importBatchId)) &&
        (input.syncCursor === undefined || isSyncCursor(input.syncCursor)) &&
        isStringArray(input.visibilityLabels)
        ? null
        : 'source.register payload is invalid.';
    }
    case 'source.signal':
      return isLorebitId('source', input.sourceId) &&
        ['available', 'unavailable', 'drifted', 'permission-changed', 'quarantined', 'archived']
          .includes(String(input.status)) &&
        (input.syncCursor === undefined || isSyncCursor(input.syncCursor))
        ? null
        : 'source.signal payload is invalid.';
    case 'import.record':
      return isLorebitId('import', input.importBatchId) &&
        Array.isArray(input.sourceIds) &&
        input.sourceIds.every((id) => isLorebitId('source', id)) &&
        ['complete', 'partial', 'failed'].includes(String(input.status)) &&
        isSafeNonNegativeInteger(input.acceptedCount) &&
        isSafeNonNegativeInteger(input.failedCount) &&
        Array.isArray(input.errors) &&
        input.errors.every(
          (error) => isRecord(error) &&
            hasOnlyKeys(error, ['sourceRef', 'code', 'summary']) &&
            typeof error.sourceRef === 'string' &&
            typeof error.code === 'string' &&
            typeof error.summary === 'string'
        )
        ? null
        : 'import.record payload is invalid.';
    case 'revision.submit': {
      const changeSet = input.changeSet;
      return isLorebitId('source', input.sourceId) &&
        isLorebitId('revision', input.revisionId) &&
        isContentSnapshot(input.snapshot) &&
        (input.locator === undefined || isLocator(input.locator)) &&
        isRecord(changeSet) &&
        hasOnlyKeys(changeSet, ['kind', 'summary', 'changes']) &&
        ['content', 'source-metadata', 'locator', 'policy', 'access-projection', 'recipe']
          .includes(String(changeSet.kind)) &&
        typeof changeSet.summary === 'string' &&
        Array.isArray(input.derivedFromRevisionIds) &&
        input.derivedFromRevisionIds.every((id) => isLorebitId('revision', id)) &&
        decodeRfc3339Utc(input.effectiveFrom).ok &&
        (input.effectiveUntil === null || decodeRfc3339Utc(input.effectiveUntil).ok)
        ? null
        : 'revision.submit payload is invalid.';
    }
    case 'revision.transition':
      return isLorebitId('source', input.sourceId) &&
        isLorebitId('revision', input.revisionId) &&
        ['draft', 'processing', 'partial', 'active', 'failed', 'superseded', 'withdrawn', 'archived']
          .includes(String(input.status))
        ? null
        : 'revision.transition payload is invalid.';
    case 'revision.label':
      return isLorebitId('source', input.sourceId) &&
        isLorebitId('revision', input.revisionId) &&
        typeof input.label === 'string'
        ? null
        : 'revision.label payload is invalid.';
    case 'revision.decision':
      return isLorebitId('source', input.sourceId) &&
        isLorebitId('revision', input.revisionId) &&
        isLorebitId('decision', input.decisionId) &&
        ['pending', 'approved', 'rejected'].includes(String(input.status))
        ? null
        : 'revision.decision payload is invalid.';
    case 'revision.withdraw':
      return isLorebitId('source', input.sourceId) && isLorebitId('revision', input.revisionId)
        ? null
        : 'revision.withdraw payload is invalid.';
    case 'revision.restore':
      return isLorebitId('source', input.sourceId) &&
        isLorebitId('revision', input.fromRevisionId) &&
        isLorebitId('revision', input.newRevisionId)
        ? null
        : 'revision.restore payload is invalid.';
    case 'revision.rollback':
      return isLorebitId('source', input.sourceId) &&
        isLorebitId('revision', input.targetRevisionId) &&
        isLorebitId('revision', input.newRevisionId)
        ? null
        : 'revision.rollback payload is invalid.';
    case 'recipe.register':
      return isLorebitId('recipe', input.recipeId) && isStringArray(input.compatibility)
        ? null
        : 'recipe.register payload is invalid.';
    case 'processing.run':
      return isLorebitId('run', input.runId) &&
        isLorebitId('source', input.sourceId) &&
        isLorebitId('revision', input.revisionId) &&
        isLorebitId('recipe', input.recipeId) &&
        isLorebitId('generation', input.generationId) &&
        (input.baseGenerationId === null || isLorebitId('generation', input.baseGenerationId))
        ? null
        : 'processing.run payload is invalid.';
    case 'processing.resume':
    case 'processing.cancel':
      return isLorebitId('run', input.runId)
        ? null
        : `${input.type} payload is invalid.`;
    case 'generation.build':
      return isLorebitId('generation', input.generationId) && isLorebitId('run', input.runId)
        ? null
        : 'generation.build payload is invalid.';
    case 'generation.validate':
      return isLorebitId('generation', input.generationId) &&
        isSafeNonNegativeInteger(input.receiptValidForMilliseconds) &&
        input.receiptValidForMilliseconds > 0
        ? null
        : 'generation.validate payload is invalid.';
    case 'generation.activate':
      return isLorebitId('generation', input.generationId) &&
        isLorebitId('activation', input.activationId) &&
        isLorebitId('policy', input.policyId)
        ? null
        : 'generation.activate payload is invalid.';
    case 'generation.retire':
      return isLorebitId('generation', input.generationId)
        ? null
        : 'generation.retire payload is invalid.';
    default:
      return 'Command payload type is unsupported.';
  }
}

function expectedStateIsValid(input: unknown): boolean {
  if (!isRecord(input) || !hasOnlyKeys(input, [], [
    'space',
    'policyId',
    'source',
    'recipeId',
    'activationId',
    'fencingToken',
    'run',
    'generation'
  ])) return false;
  if (input.space !== undefined) {
    if (!isRecord(input.space) || !hasOnlyKeys(input.space, ['spaceId'], ['sequence', 'status'])) {
      return false;
    }
    if (!isLorebitId('space', input.space.spaceId)) return false;
    if (input.space.sequence !== undefined && !isSafeNonNegativeInteger(input.space.sequence)) return false;
    if (
      input.space.status !== undefined &&
      !['open', 'frozen', 'archived'].includes(String(input.space.status))
    ) return false;
  }
  if (input.source !== undefined) {
    if (!isRecord(input.source) || !hasOnlyKeys(input.source, ['sourceId'], ['sequence', 'revisionId'])) {
      return false;
    }
    if (!isLorebitId('source', input.source.sourceId)) return false;
    if (input.source.sequence !== undefined && !isSafeNonNegativeInteger(input.source.sequence)) return false;
    if (
      input.source.revisionId !== undefined &&
      input.source.revisionId !== null &&
      !isLorebitId('revision', input.source.revisionId)
    ) return false;
  }
  if (input.run !== undefined) {
    if (!isRecord(input.run) || !hasOnlyKeys(input.run, ['runId'], ['sequence', 'status'])) {
      return false;
    }
    if (!isLorebitId('run', input.run.runId)) return false;
    if (input.run.sequence !== undefined && !isSafeNonNegativeInteger(input.run.sequence)) return false;
    if (
      input.run.status !== undefined &&
      !['queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled']
        .includes(String(input.run.status))
    ) return false;
  }
  if (input.generation !== undefined) {
    if (
      !isRecord(input.generation) ||
      !hasOnlyKeys(input.generation, ['generationId'], ['sequence', 'status'])
    ) return false;
    if (!isLorebitId('generation', input.generation.generationId)) return false;
    if (
      input.generation.sequence !== undefined &&
      !isSafeNonNegativeInteger(input.generation.sequence)
    ) return false;
    if (
      input.generation.status !== undefined &&
      !['planned', 'building', 'validating', 'ready', 'active', 'retired', 'failed', 'cancelled']
        .includes(String(input.generation.status))
    ) return false;
  }
  return (input.policyId === undefined || input.policyId === null || isLorebitId('policy', input.policyId)) &&
    (input.recipeId === undefined || input.recipeId === null || isLorebitId('recipe', input.recipeId)) &&
    (input.activationId === undefined || input.activationId === null || isLorebitId('activation', input.activationId)) &&
    (input.fencingToken === undefined || isSafeNonNegativeInteger(input.fencingToken));
}

export function validateDurableCommandEnvelope(
  input: unknown
): DurableEnvelopeValidationResult {
  const wire = decodeJsonValue(input);
  if (!wire.ok) {
    return {
      ok: false,
      error: {
        code: 'schema-invalid',
        summary: `Durable command is not a wire value: ${wire.error.summary}`
      }
    };
  }
  const topLevelKeys = new Set([
    'schemaVersion',
    'commandType',
    'operationId',
    'idempotencyKey',
    'actorRef',
    'reason',
    'occurredAt',
    'requestedDeadlineAt',
    'expected',
    'payload'
  ]);
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.keys(input).some((key) => !topLevelKeys.has(key))
  ) {
    return {
      ok: false,
      error: {
        code: 'schema-invalid',
        summary: 'Durable command contains an unknown top-level field.'
      }
    };
  }
  const value = input as Partial<DurableCommandEnvelope<LorebitCommandPayload>>;
  if (
    value.schemaVersion !== '1.0' ||
    typeof value.commandType !== 'string' ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    value.commandType !== value.payload.type ||
    typeof value.idempotencyKey !== 'string' ||
    value.idempotencyKey.length === 0 ||
    typeof value.reason !== 'string' ||
    value.reason.length === 0 ||
    value.operationId === undefined ||
    !isLorebitId('operation', value.operationId) ||
    value.actorRef === undefined ||
    typeof value.actorRef !== 'object' ||
    value.actorRef === null ||
    Object.keys(value.actorRef).some((key) => key !== 'type' && key !== 'id') ||
    typeof value.actorRef.type !== 'string' ||
    value.actorRef.type.length === 0 ||
    typeof value.actorRef.id !== 'string' ||
    value.actorRef.id.length === 0 ||
    !expectedStateIsValid(value.expected)
  ) {
    return {
      ok: false,
      error: { code: 'invalid-request', summary: 'Durable command fields are incomplete.' }
    };
  }
  const payloadFailure = payloadValidationFailure(value.payload);
  if (payloadFailure !== null) {
    return {
      ok: false,
      error: { code: 'schema-invalid', summary: payloadFailure }
    };
  }
  if (!decodeRfc3339Utc(value.occurredAt).ok) {
    return {
      ok: false,
      error: { code: 'schema-invalid', summary: 'occurredAt must use the RFC 3339 wire codec.' }
    };
  }
  if (
    value.requestedDeadlineAt !== undefined &&
    !decodeRfc3339Utc(value.requestedDeadlineAt).ok
  ) {
    return {
      ok: false,
      error: {
        code: 'schema-invalid',
        summary: 'requestedDeadlineAt must use the RFC 3339 wire codec.'
      }
    };
  }
  if (
    value.requestedDeadlineAt !== undefined &&
    value.requestedDeadlineAt <= (value.occurredAt as Rfc3339Utc)
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid-request',
        summary: 'requestedDeadlineAt must be later than occurredAt.'
      }
    };
  }
  return { ok: true };
}
