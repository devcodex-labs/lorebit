import type { OperationId } from './ids.js';
import type { Diagnostic, LorebitFailure } from './diagnostics.js';

export interface OperationRef {
  readonly operationId: OperationId;
  readonly kind: 'command' | 'query' | 'runtime';
}

export type LorebitOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly diagnostics: readonly Diagnostic[];
      readonly operation: OperationRef;
    }
  | {
      readonly ok: false;
      readonly error: LorebitFailure;
      readonly diagnostics: readonly Diagnostic[];
      readonly operation: OperationRef;
    };

export function successful<T>(
  value: T,
  operation: OperationRef,
  diagnostics: readonly Diagnostic[] = []
): LorebitOutcome<T> {
  return { ok: true, value, diagnostics, operation };
}

export function failed<T>(
  error: LorebitFailure,
  operation: OperationRef,
  diagnostics: readonly Diagnostic[] = []
): LorebitOutcome<T> {
  return { ok: false, error, diagnostics, operation };
}
