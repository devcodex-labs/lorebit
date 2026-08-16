import type { Rfc3339Utc } from '../wire/rfc3339.js';

export interface RuntimeResourceLimits {
  readonly importMaxSources: number;
  readonly importMaxUtf8Bytes: number;
  readonly repositoryConcurrency: number;
  readonly processingConcurrency: number;
  readonly importConcurrency: number;
  readonly rebuildConcurrency: number;
  readonly queryConcurrency: number;
  readonly generateConcurrency: number;
  readonly maxQueuedOperations: number;
  readonly maxInFlightBytes: number;
  readonly maxResultBytes: number;
  readonly repositoryDeadlineMilliseconds: number;
  readonly queryDeadlineMilliseconds: number;
  readonly contextDeadlineMilliseconds: number;
  readonly generateDeadlineMilliseconds: number;
  readonly processingDeadlineMilliseconds: number;
  readonly importDeadlineMilliseconds: number;
  readonly rebuildDeadlineMilliseconds: number;
  readonly retryMaxAttempts: number;
  readonly retryBaseMilliseconds: number;
  readonly retryMaxMilliseconds: number;
  readonly cancellationGraceMilliseconds: number;
}

export const DEFAULT_RUNTIME_RESOURCE_LIMITS: RuntimeResourceLimits = Object.freeze({
  importMaxSources: 100,
  importMaxUtf8Bytes: 100 * 1024 * 1024,
  repositoryConcurrency: 16,
  processingConcurrency: 4,
  importConcurrency: 4,
  rebuildConcurrency: 1,
  queryConcurrency: 16,
  generateConcurrency: 4,
  maxQueuedOperations: 1_000,
  maxInFlightBytes: 64 * 1024 * 1024,
  maxResultBytes: 16 * 1024 * 1024,
  repositoryDeadlineMilliseconds: 5_000,
  queryDeadlineMilliseconds: 15_000,
  contextDeadlineMilliseconds: 5_000,
  generateDeadlineMilliseconds: 60_000,
  processingDeadlineMilliseconds: 5 * 60_000,
  importDeadlineMilliseconds: 5 * 60_000,
  rebuildDeadlineMilliseconds: 30 * 60_000,
  retryMaxAttempts: 3,
  retryBaseMilliseconds: 100,
  retryMaxMilliseconds: 2_000,
  cancellationGraceMilliseconds: 100
});

export const HARD_RUNTIME_RESOURCE_LIMITS: RuntimeResourceLimits = Object.freeze({
  importMaxSources: 100,
  importMaxUtf8Bytes: 100 * 1024 * 1024,
  repositoryConcurrency: 16,
  processingConcurrency: 4,
  importConcurrency: 4,
  rebuildConcurrency: 1,
  queryConcurrency: 16,
  generateConcurrency: 4,
  maxQueuedOperations: 1_000,
  maxInFlightBytes: 64 * 1024 * 1024,
  maxResultBytes: 16 * 1024 * 1024,
  repositoryDeadlineMilliseconds: 5_000,
  queryDeadlineMilliseconds: 15_000,
  contextDeadlineMilliseconds: 5_000,
  generateDeadlineMilliseconds: 60_000,
  processingDeadlineMilliseconds: 5 * 60_000,
  importDeadlineMilliseconds: 5 * 60_000,
  rebuildDeadlineMilliseconds: 30 * 60_000,
  retryMaxAttempts: 3,
  retryBaseMilliseconds: 100,
  retryMaxMilliseconds: 2_000,
  cancellationGraceMilliseconds: 100
});

export function resolveRuntimeResourceLimits(input: Partial<RuntimeResourceLimits> = {}): RuntimeResourceLimits | null {
  const value = { ...DEFAULT_RUNTIME_RESOURCE_LIMITS, ...input };
  for (const key of Object.keys(HARD_RUNTIME_RESOURCE_LIMITS) as Array<keyof RuntimeResourceLimits>) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > HARD_RUNTIME_RESOURCE_LIMITS[key]) return null;
  }
  if (value.retryBaseMilliseconds > value.retryMaxMilliseconds) return null;
  return Object.freeze(value);
}

export interface ResourceObservation {
  readonly operationKind: 'repository' | 'query' | 'context' | 'generate' | 'processing' | 'import' | 'rebuild';
  readonly queued: number;
  readonly inFlight: number;
  readonly inFlightBytes: number;
  readonly attempt: number;
  readonly deadlineAt: Rfc3339Utc | null;
  readonly startedAt: Rfc3339Utc | null;
  readonly completedAt: Rfc3339Utc | null;
  readonly outcome: 'completed' | 'saturated' | 'limit' | 'deadline' | 'cancelled' | 'failed';
}
