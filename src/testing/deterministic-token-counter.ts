import type { ExecutionOptions } from '../application/commands.js';
import type { TokenCounter, TokenCountResult } from '../ports/token-counter.js';

export class DeterministicTokenCounter implements TokenCounter {
  readonly descriptor;
  readonly capabilities;
  #closed = false;

  constructor(maxInputUtf8Bytes = 1_000_000, deploymentFingerprint = 'testing:token-counter:default') {
    this.descriptor = Object.freeze({
      kind: 'token-counter' as const,
      adapterId: '@devcodex/lorebit/testing:deterministic-token-counter',
      name: 'DeterministicTokenCounter',
      version: '0.1',
      deploymentFingerprint,
      testingOnly: true
    });
    this.capabilities = Object.freeze({
      tokenizer: 'lorebit-unicode-word-v1',
      model: 'provider-neutral-estimate',
      maxInputUtf8Bytes,
      deterministic: true
    });
  }

  async count(text: string, options: ExecutionOptions = {}): Promise<TokenCountResult> {
    if (this.#closed) return { ok: false, code: 'counter-failure', summary: 'Token counter is closed.' };
    if (options.signal?.aborted === true) return { ok: false, code: 'cancelled', summary: 'Token counting was cancelled.' };
    if (new TextEncoder().encode(text).byteLength > this.capabilities.maxInputUtf8Bytes) {
      return { ok: false, code: 'input-too-large', summary: 'Token counter input exceeds its byte limit.' };
    }
    const tokens = text.normalize('NFC').match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length ?? 0;
    return { ok: true, tokens };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
