import type { JsonValue } from '../wire/json-value.js';

export type LorebitFailureCode =
  | 'invalid-request'
  | 'out-of-scope'
  | 'not-found'
  | 'schema-invalid'
  | 'digest-mismatch'
  | 'integrity-check-failed'
  | 'state-conflict'
  | 'idempotency-conflict'
  | 'stale-run-attempt'
  | 'capability-unavailable'
  | 'configuration-invalid'
  | 'model-incompatible'
  | 'receipt-stale'
  | 'invalid-state-transition'
  | 'processing-incomplete'
  | 'insufficient-evidence'
  | 'citation-invalid'
  | 'generation-stale'
  | 'access-denied'
  | 'filter-not-enforceable'
  | 'content-quarantined'
  | 'query-blocked'
  | 'data-egress-denied'
  | 'output-blocked'
  | 'security-hook-failed'
  | 'resource-limit-exceeded'
  | 'resource-saturated'
  | 'deadline-exceeded'
  | 'cancelled'
  | 'runtime-closing'
  | 'runtime-closed'
  | 'adapter-unavailable'
  | 'adapter-rate-limited'
  | 'adapter-failure'
  | 'external-commit-unknown'
  | 'maintenance-required'
  | 'migration-failure'
  | 'generation-failure'
  | 'generation-invalid';

export interface RecoveryAction {
  readonly code: string;
  readonly summary: string;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly summary: string;
  readonly affected: readonly string[];
  readonly currentGuarantees: readonly string[];
  readonly recovery: readonly RecoveryAction[];
  readonly retryable: boolean;
  readonly traceRef: string | null;
  readonly details?: JsonValue;
}

export interface LorebitFailure {
  readonly code: LorebitFailureCode;
  readonly summary: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export function lorebitFailure(
  code: LorebitFailureCode,
  summary: string,
  retryable = false,
  details?: JsonValue
): LorebitFailure {
  return details === undefined
    ? { code, summary, retryable }
    : { code, summary, retryable, details };
}

export function diagnostic(
  code: string,
  severity: Diagnostic['severity'],
  summary: string,
  options: {
    readonly affected?: readonly string[];
    readonly guarantees?: readonly string[];
    readonly recovery?: readonly RecoveryAction[];
    readonly retryable?: boolean;
    readonly traceRef?: string | null;
    readonly details?: JsonValue;
  } = {}
): Diagnostic {
  const base = {
    code,
    severity,
    summary,
    affected: options.affected ?? [],
    currentGuarantees: options.guarantees ?? [],
    recovery: options.recovery ?? [],
    retryable: options.retryable ?? false,
    traceRef: options.traceRef ?? null
  };
  return options.details === undefined ? base : { ...base, details: options.details };
}
