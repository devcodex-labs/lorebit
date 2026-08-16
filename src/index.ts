export const LOREBIT_CONTRACT_VERSION = '0.1';
export const LOREBIT_WIRE_SCHEMA_VERSION = '1.0';

export {
  decodeJsonValue,
  isJsonValue,
  type JsonPrimitive,
  type JsonValue,
  type JsonValueDecodeResult,
  type JsonValueFailure,
  type JsonValueFailureCode
} from './wire/json-value.js';
export {
  canonicalizeJson,
  type CanonicalJsonFailure,
  type CanonicalJsonResult
} from './wire/canonical-json.js';
export {
  decodeRfc3339Utc,
  formatRfc3339Utc,
  type Rfc3339Failure,
  type Rfc3339Result,
  type Rfc3339Utc
} from './wire/rfc3339.js';
export {
  digestBytes,
  digestCanonicalJson,
  decodeDigestRef,
  type DigestDecodeResult,
  type DigestRef,
  type DigestResult
} from './wire/digest.js';
export {
  unsupportedSchemaVersion,
  type SchemaCodec,
  type SchemaDecodeResult,
  type SchemaFailure
} from './wire/schema-codec.js';
export {
  createLorebitId,
  createSystemIdGenerator,
  decodeLorebitId,
  type ActivationId,
  type ContentId,
  type ContentUnitId,
  type ContentUnitVersionId,
  type CitationId,
  type DeltaPlanId,
  type DecisionId,
  type EventId,
  type EvaluationId,
  type ExportId,
  type GenerationId,
  type IdDecodeResult,
  type IdGenerator,
  type ImportBatchId,
  type ImportPlanId,
  type ImpactId,
  type LorebitId,
  type LorebitIdKind,
  type OperationId,
  type OutboxId,
  type PolicyId,
  type QueryPlanId,
  type RecipeId,
  type RecoveryId,
  type ReceiptId,
  type ResultId,
  type RevisionId,
  type RunId,
  type MigrationId,
  type SourceId,
  type SpaceId
} from './domain/ids.js';
export {
  compileFilterExpression,
  decodeFilterExpression,
  matchesFilterExpression,
  DEFAULT_QUERY_FILTER_SCHEMA,
  type CompiledFilter,
  type FilterCompileResult,
  type FilterExpression,
  type FilterFieldDefinition,
  type FilterFieldType,
  type FilterPredicateOperator,
  type FilterPredicateReceipt,
  type FilterSchema,
  type FilterSupport
} from './domain/filter.js';
export {
  DEFAULT_CONTEXT_BUDGET,
  type AccessContext,
  type ContextBudget,
  type GenerationOutput,
  type KnowledgeQueryRequest,
  type KnowledgeResult,
  type KnowledgeResultStatus,
  type QueryPlanSnapshot,
  type RetrievalCandidate,
  type RetrievalResult,
  type RetrievalRoute
} from './domain/query-plan.js';
export {
  type ImpactChangeKind,
  type ImpactDisposition,
  type ImpactItem,
  type ImpactReport,
  type RebuildPlan
} from './domain/impact.js';
export {
  type RecoveryActionKind,
  type RecoveryExecutionReceipt,
  type RecoveryPlan,
  type RecoveryStep
} from './domain/recovery.js';
export {
  type EvaluationCase,
  type ClaimEvaluation,
  type EvaluationComparison,
  type EvaluationFeedback,
  type EvaluationRun,
  type EvaluationVersionRefs,
  type QualityGate,
  type QualityGateResult
} from './domain/evaluation.js';
export {
  type ExportManifest,
  type ExportPackage,
  type ExportPlan,
  type ImportPlan,
  type ImportReceipt,
  type MigrationPlan,
  type MigrationReceipt
} from './domain/transfer.js';
export {
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  HARD_RUNTIME_RESOURCE_LIMITS,
  resolveRuntimeResourceLimits,
  type ResourceObservation,
  type RuntimeResourceLimits
} from './domain/resources.js';
export {
  createTraceContextSnapshot,
  decodeTraceCarrier,
  type EventTraceContext,
  type TelemetrySpan,
  type TraceContextSnapshot
} from './domain/trace.js';
export {
  validateCitation,
  type Citation,
  type CitationValidation
} from './domain/citation.js';
export {
  type ContextEvidence,
  type ContextExclusion,
  type ContextPack,
  type ContextProvenance
} from './domain/context-pack.js';
export {
  DEFAULT_SECURITY_POLICY,
  decideDataEgress,
  redactDiagnosticText,
  securityPolicyFromExtensions,
  type DataEgressDecision,
  type ModelDataBoundary,
  type SecurityHookAction,
  type SecurityHookPoint,
  type SecurityHookRecord,
  type SecurityPolicy
} from './domain/security.js';
export {
  type ContentLocator,
  type ContentUnitIdentity,
  type ContentUnitVersion,
  type TransformedContentUnit
} from './domain/content-unit.js';
export {
  summarizeDelta,
  type DeltaItem,
  type DeltaKind,
  type DeltaPlan
} from './domain/delta-plan.js';
export {
  canTransitionProcessingRun,
  DEFAULT_PROCESSING_RESOURCE_LIMITS,
  HARD_PROCESSING_RESOURCE_LIMITS,
  resolveProcessingResourceLimits,
  type ProcessingResourceLimits,
  type ProcessingRun,
  type ProcessingRunStatus,
  type ProcessingStage,
  type StageRun
} from './domain/processing.js';
export {
  canTransitionIndexGeneration,
  type DeleteReceipt,
  type GenerationValidationReceipt,
  type IndexGeneration,
  type IndexGenerationStatus
} from './domain/index-generation.js';
export { type QuerySnapshot } from './domain/activation.js';
export {
  type AdapterDescriptor,
  type CapabilityManifest,
  type CapabilityVerificationReceipt
} from './domain/capability.js';
export {
  canTransitionKnowledgeSpace,
  type AccessPolicy,
  type AdmissionPolicy,
  type DefaultResultPolicy,
  type EvidencePolicy,
  type ExposurePolicy,
  type KnowledgeSpace,
  type KnowledgeSpaceStatus,
  type PolicySnapshot,
  type QuestionScope,
  type RetentionPolicy,
  type SpaceReadiness
} from './domain/knowledge-space.js';
export {
  canTransitionSource,
  type ImportBatch,
  type ImportBatchError,
  type ImmutableContentRef,
  type Source,
  type SourceLocator,
  type SourceOwnership,
  type SourceSnapshotRef,
  type SourceStatus,
  type SyncCursor
} from './domain/source.js';
export {
  canTransitionRevision,
  type ChangeSet,
  type ChangeSetInput,
  type DecisionStatus,
  type IndexGenerationReference,
  type KnowledgeActivation,
  type ProcessingRecipeVersion,
  type RevisionDecision,
  type RevisionLabel,
  type RevisionSelector,
  type RevisionState,
  type RevisionStatus,
  type RevisionView,
  type SourceRevision
} from './domain/versions.js';
export {
  diagnostic,
  lorebitFailure,
  type Diagnostic,
  type LorebitFailure,
  type LorebitFailureCode,
  type RecoveryAction
} from './domain/diagnostics.js';
export {
  failed,
  successful,
  type LorebitOutcome,
  type OperationRef
} from './domain/outcomes.js';
export {
  type AggregateRef,
  type LifecycleEvent,
  type OutboxRecord
} from './domain/events.js';
export {
  type ProvenanceRevisionRef,
  type ResultProvenance
} from './domain/provenance.js';
export {
  validateDurableCommandEnvelope,
  type ActorRef,
  type ArchiveSpaceCommand,
  type ActivateGenerationCommand,
  type BuildGenerationCommand,
  type CancelProcessingRunCommand,
  type CreateSpaceCommand,
  type DurableCommandEnvelope,
  type DurableEnvelopeValidationResult,
  type ExecutionOptions,
  type ExpectedState,
  type FreezeSpaceCommand,
  type LifecycleCommandPayload,
  type LorebitCommandPayload,
  type PolicyDefinition,
  type RecordRevisionDecisionCommand,
  type RecordImportBatchCommand,
  type RegisterRecipeCommand,
  type RegisterSourceCommand,
  type ResumeProcessingCommand,
  type RetireGenerationCommand,
  type RunProcessingCommand,
  type ReopenSpaceCommand,
  type RestoreRevisionCommand,
  type RollbackRevisionCommand,
  type SetRevisionLabelCommand,
  type SignalSourceAvailabilityCommand,
  type SubmitRevisionCommand,
  type TraceCarrier,
  type TransitionRevisionCommand,
  type UpdatePolicyCommand,
  type UpdateSpaceCommand,
  type ValidateGenerationCommand,
  type WithdrawRevisionCommand
} from './application/commands.js';
export {
  eventCursor,
  type EventPage,
  type EventQuery,
  type Page,
  type PageRequest,
  type PolicyPage,
  type ResolveRevisionResult,
  type RevisionQuery,
  type VersionDifference
} from './application/queries.js';
export type { LifecycleMutation } from './application/services/lifecycle-service.js';
export type { ProcessingRunResult } from './application/services/processing-service.js';
export type {
  GenerationActivationResult,
  GenerationBuildResult,
  GenerationValidationResult
} from './application/services/generation-service.js';
export {
  type ContentTransformer,
  type TransformContentRequest,
  type TransformContentResult
} from './ports/content-transformer.js';
export {
  type EmbeddingModel,
  type EmbeddingResult,
  type EmbeddingUsage
} from './ports/embedding-model.js';
export {
  type VectorCandidate,
  type VectorIndex,
  type VectorQueryOptions,
  type VectorIndexResult,
  type VectorRecord
} from './ports/vector-index.js';
export {
  type KeywordCandidate,
  type KeywordIndex,
  type KeywordQueryOptions,
  type KeywordIndexResult,
  type KeywordRecord
} from './ports/keyword-index.js';
export {
  type RerankCandidate,
  type RerankedCandidate,
  type Reranker,
  type RerankerResult
} from './ports/reranker.js';
export {
  type TokenCounter,
  type TokenCountResult
} from './ports/token-counter.js';
export {
  type SecurityHook,
  type SecurityHookInput,
  type SecurityHookResult
} from './ports/security-hooks.js';
export {
  type LanguageModel,
  type LanguageModelRequest,
  type LanguageModelResult,
  type LanguageModelUsage
} from './ports/language-model.js';
export {
  type DerivedArtifact,
  type DerivedArtifactDeleteReceipt,
  type DerivedArtifactKey,
  type DerivedArtifactStore,
  type DerivedArtifactStoreResult
} from './ports/derived-artifact-store.js';
export {
  createNoopTelemetrySink,
  type TelemetryResult,
  type TelemetrySink
} from './ports/telemetry.js';
export {
  createSystemClock,
  type Clock
} from './ports/clock.js';
export {
  type ContentDeleteReceipt,
  type ContentStore,
  type ContentStoreFailure,
  type ContentStoreResult,
  type PutImmutableContentRequest
} from './ports/content-store.js';
export {
  createNoopEventSink,
  type EventSink,
  type EventSinkPublishResult
} from './ports/event-sink.js';
export {
  type AcquireRunClaimRequest,
  type AcquireRunClaimResult,
  type FencedWriteResult,
  type KnowledgeRepository,
  type KnowledgeRepositoryCapabilities,
  type KnowledgeRepositoryDescriptor,
  type RepositoryCommitRequest,
  type RepositoryCommitResult,
  type RepositoryFailure,
  type RepositoryOperationRecord,
  type RepositoryWriteSet,
  type RunCheckpoint,
  type RunClaim,
  type SideEffectReceipt
} from './ports/knowledge-repository.js';
export {
  createLorebit,
  type CreateLorebitOptions
} from './runtime/create-lorebit.js';
export {
  defineGenerationModule,
  type GenerationModuleConfig
} from './modules/generation.js';
export {
  createEvaluationModule,
  digestEvaluationCase,
  type ClaimEvaluator,
  type ClaimEvaluatorInput,
  type EvaluationModule,
  type EvaluationCaseDefinition,
  type EvaluationRunInput
} from './modules/evaluation.js';
export {
  defineImportExportModule,
  type ImportExportModuleConfig
} from './modules/import-export.js';
export type {
  CloseOptions,
  CloseReceipt,
  Lorebit,
  LorebitMutation,
  LorebitReadiness,
  LorebitRuntimeProfile,
  LorebitRuntimeState
} from './runtime/lifecycle-runtime.js';
