import type { ExecutionOptions } from '../application/commands.js';
import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { SecurityHookAction, SecurityHookPoint } from '../domain/security.js';

export interface SecurityHookInput {
  readonly point: SecurityHookPoint;
  readonly inputDigest: DigestRef;
  readonly payload: JsonValue;
}

export type SecurityHookResult =
  | {
      readonly ok: true;
      readonly action: SecurityHookAction;
      readonly reason: string;
      readonly output: JsonValue;
      readonly evidenceRef: string | null;
    }
  | {
      readonly ok: false;
      readonly code: 'hook-timeout' | 'hook-failure' | 'cancelled';
      readonly summary: string;
      readonly retryable: boolean;
    };

export interface SecurityHook {
  readonly descriptor: {
    readonly kind: 'security-hook';
    readonly hookId: string;
    readonly name: string;
    readonly version: string;
    readonly method: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
  };
  readonly capabilities: {
    readonly points: readonly SecurityHookPoint[];
    readonly actions: readonly SecurityHookAction[];
  };
  execute(input: SecurityHookInput, options?: ExecutionOptions): Promise<SecurityHookResult>;
  close(): Promise<void>;
}
