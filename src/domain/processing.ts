import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  DeltaPlanId,
  GenerationId,
  RecipeId,
  RevisionId,
  RunId,
  SourceId,
  SpaceId
} from './ids.js';
import type { Diagnostic } from './diagnostics.js';

export type ProcessingRunStatus =
  | 'queued'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ProcessingStage =
  | 'load-content'
  | 'transform'
  | 'plan-delta'
  | 'embed'
  | 'index'
  | 'validate'
  | 'activate';

export interface StageRun {
  readonly stage: ProcessingStage;
  readonly attempt: number;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt: Rfc3339Utc;
  readonly completedAt: Rfc3339Utc | null;
  readonly inputDigest: DigestRef;
  readonly outputDigest: DigestRef | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProcessingRun {
  readonly schemaVersion: '1.0';
  readonly runId: RunId;
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly recipeId: RecipeId;
  readonly generationId: GenerationId;
  readonly baseGenerationId: GenerationId | null;
  readonly status: ProcessingRunStatus;
  readonly sequence: number;
  readonly cancellationRequested: boolean;
  readonly stages: readonly StageRun[];
  readonly deltaPlanId: DeltaPlanId | null;
  readonly unitCount: number;
  readonly inputDigest: DigestRef;
  readonly outputDigest: DigestRef | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly startedAt: Rfc3339Utc;
  readonly updatedAt: Rfc3339Utc;
  readonly completedAt: Rfc3339Utc | null;
  readonly actorRef: string;
  readonly reason: string;
  readonly metadata: JsonValue;
  readonly components: {
    readonly transformer: {
      readonly adapterId: string;
      readonly version: string;
      readonly deploymentFingerprint: string;
    };
    readonly recipeFingerprint: DigestRef;
  };
}

export interface ProcessingResourceLimits {
  readonly maxSourceBytes: number;
  readonly maxNormalizedBytes: number;
  readonly maxUnitBytes: number;
  readonly maxUnitsPerRevision: number;
}

export const DEFAULT_PROCESSING_RESOURCE_LIMITS: ProcessingResourceLimits = Object.freeze({
  maxSourceBytes: 10 * 1024 * 1024,
  maxNormalizedBytes: 32 * 1024 * 1024,
  maxUnitBytes: 64 * 1024,
  maxUnitsPerRevision: 20_000
});

export const HARD_PROCESSING_RESOURCE_LIMITS: ProcessingResourceLimits = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxNormalizedBytes: 128 * 1024 * 1024,
  maxUnitBytes: 256 * 1024,
  maxUnitsPerRevision: 100_000
});

export function resolveProcessingResourceLimits(
  input: Partial<ProcessingResourceLimits> = {}
): ProcessingResourceLimits | null {
  const value = { ...DEFAULT_PROCESSING_RESOURCE_LIMITS, ...input };
  for (const key of Object.keys(value) as (keyof ProcessingResourceLimits)[]) {
    if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < 1 ||
      value[key] > HARD_PROCESSING_RESOURCE_LIMITS[key]
    ) return null;
  }
  return Object.freeze(value);
}

const RUN_TRANSITIONS: Readonly<Record<ProcessingRunStatus, readonly ProcessingRunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['partial', 'succeeded', 'failed', 'cancelled'],
  partial: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['running'],
  cancelled: []
};

export function canTransitionProcessingRun(
  from: ProcessingRunStatus,
  to: ProcessingRunStatus
): boolean {
  return from === to || RUN_TRANSITIONS[from].includes(to);
}
