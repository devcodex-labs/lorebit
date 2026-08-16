import type { ExecutionOptions } from '../application/commands.js';

export type TokenCountResult =
  | { readonly ok: true; readonly tokens: number }
  | { readonly ok: false; readonly code: 'input-too-large' | 'cancelled' | 'counter-failure'; readonly summary: string };

export interface TokenCounter {
  readonly descriptor: {
    readonly kind: 'token-counter';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
  };
  readonly capabilities: {
    readonly tokenizer: string;
    readonly model: string;
    readonly maxInputUtf8Bytes: number;
    readonly deterministic: boolean;
  };
  count(text: string, options?: ExecutionOptions): Promise<TokenCountResult>;
  close(): Promise<void>;
}
