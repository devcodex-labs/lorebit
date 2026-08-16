import type { ExecutionOptions } from '../application/commands.js';
import type { ContextPack } from '../domain/context-pack.js';
import type { ModelDataBoundary } from '../domain/security.js';

export interface LanguageModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly calls: number;
  readonly estimatedCost: { readonly amount: number; readonly currency: string; readonly precision: 'exact' | 'estimated' } | null;
}

export interface LanguageModelRequest {
  readonly trustedDirective: ContextPack['trustedDirective'];
  readonly context: ContextPack;
  readonly maxOutputUtf8Bytes: number;
}

export type LanguageModelResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly finishReason: 'stop' | 'length';
      readonly usage: LanguageModelUsage;
      readonly providerRequestId: string | null;
    }
  | {
      readonly ok: false;
      readonly code: 'refused' | 'invalid-output' | 'rate-limited' | 'deadline' | 'cancelled' | 'model-failure';
      readonly summary: string;
      readonly retryable: boolean;
      readonly retryAfterMs: number | null;
      readonly usage: LanguageModelUsage;
    };

export interface LanguageModel {
  readonly descriptor: {
    readonly kind: 'language-model';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
    readonly dataBoundary: ModelDataBoundary;
  };
  readonly capabilities: {
    readonly model: string;
    readonly maxContextTokens: number;
    readonly maxInputUtf8Bytes: number;
    readonly maxOutputUtf8Bytes: number;
    readonly deterministic: boolean;
    readonly cancellation: boolean;
    readonly retryOwner: 'runtime';
  };
  generate(request: LanguageModelRequest, options?: ExecutionOptions): Promise<LanguageModelResult>;
  close(): Promise<void>;
}
