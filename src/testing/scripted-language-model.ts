import type { ExecutionOptions } from '../application/commands.js';
import type { ModelDataBoundary } from '../domain/security.js';
import type { LanguageModel, LanguageModelRequest, LanguageModelResult } from '../ports/language-model.js';

export type ScriptedLanguageModelStep =
  | LanguageModelResult
  | ((request: LanguageModelRequest, options: ExecutionOptions) => LanguageModelResult | Promise<LanguageModelResult>);

export class ScriptedLanguageModel implements LanguageModel {
  readonly descriptor;
  readonly capabilities;
  readonly requests: LanguageModelRequest[] = [];
  readonly #steps: ScriptedLanguageModelStep[];
  #closed = false;

  constructor(
    steps: readonly ScriptedLanguageModelStep[] = [],
    dataBoundary: ModelDataBoundary = { deploymentClass: 'local', providerProfile: 'lorebit-testing-local', region: null, trainingUse: 'none', retention: 'none', attestationRef: 'testing:scripted-language-model' }
  ) {
    this.#steps = [...steps];
    this.descriptor = Object.freeze({
      kind: 'language-model' as const,
      adapterId: '@devcodex/lorebit/testing:scripted-language-model',
      name: 'ScriptedLanguageModel',
      version: '0.1',
      deploymentFingerprint: 'testing:language-model:default',
      testingOnly: true,
      dataBoundary: Object.freeze({ ...dataBoundary })
    });
    this.capabilities = Object.freeze({
      model: 'lorebit-scripted-model',
      maxContextTokens: 8192,
      maxInputUtf8Bytes: 1024 * 1024,
      maxOutputUtf8Bytes: 1024 * 1024,
      deterministic: true,
      cancellation: true,
      retryOwner: 'runtime' as const
    });
  }

  async generate(request: LanguageModelRequest, options: ExecutionOptions = {}): Promise<LanguageModelResult> {
    this.requests.push(structuredClone(request));
    if (this.#closed) return this.#failure('model-failure', 'Model is closed.');
    if (options.signal?.aborted === true) return this.#failure('cancelled', 'Generation was cancelled.');
    const step = this.#steps.shift();
    if (typeof step === 'function') return step(request, options);
    if (step !== undefined) return structuredClone(step);
    const citation = request.context.evidence[0]?.citation.citationId ?? 'citation_none';
    return {
      ok: true,
      text: `Generated from ${citation}.`,
      finishReason: 'stop',
      usage: { inputTokens: request.context.usage.tokens, outputTokens: 4, calls: 1, estimatedCost: null },
      providerRequestId: 'scripted-default'
    };
  }

  async close(): Promise<void> { this.#closed = true; }

  #failure(code: Extract<LanguageModelResult, { ok: false }>['code'], summary: string): Extract<LanguageModelResult, { ok: false }> {
    return { ok: false, code, summary, retryable: false, retryAfterMs: null, usage: { inputTokens: null, outputTokens: null, calls: 1, estimatedCost: null } };
  }
}
