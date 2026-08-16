import type { EmbeddingModel, EmbeddingResult } from '../ports/embedding-model.js';
import type { ExecutionOptions } from '../application/commands.js';
import type { ModelDataBoundary } from '../domain/security.js';

export class DeterministicEmbeddingModel implements EmbeddingModel {
  readonly descriptor;
  readonly capabilities;
  calls = 0;
  #closed = false;

  constructor(
    dimension = 8,
    maxBatchSize = 64,
    maxInputUtf8Bytes = 1_000_000,
    deploymentFingerprint = 'testing:embedding:default',
    dataBoundary: ModelDataBoundary = {
      deploymentClass: 'local',
      providerProfile: 'lorebit-testing-local',
      region: null,
      trainingUse: 'none',
      retention: 'none',
      attestationRef: 'testing:deterministic-embedding'
    }
  ) {
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 1024) {
      throw new RangeError('Embedding dimension must be from 1 to 1024.');
    }
    this.capabilities = Object.freeze({
      model: 'lorebit-deterministic-sha256',
      dimension,
      maxBatchSize,
      maxInputUtf8Bytes,
      deterministic: true
    });
    this.descriptor = Object.freeze({
      kind: 'embedding-model' as const,
      adapterId: '@devcodex/lorebit/testing:deterministic-embedding-model',
      name: 'DeterministicEmbeddingModel',
      version: '0.1',
      deploymentFingerprint,
      testingOnly: true,
      dataBoundary: Object.freeze({ ...dataBoundary })
    });
  }

  async embed(
    texts: readonly string[],
    options: ExecutionOptions = {}
  ): Promise<EmbeddingResult> {
    this.calls += 1;
    if (this.#closed) {
      return { ok: false, code: 'model-failure', summary: 'Embedding model is closed.', retryable: false };
    }
    if (options.signal?.aborted === true) {
      return { ok: false, code: 'cancelled', summary: 'Embedding was cancelled.', retryable: false };
    }
    if (texts.length > this.capabilities.maxBatchSize) {
      return { ok: false, code: 'input-too-large', summary: 'Embedding batch exceeds maxBatchSize.', retryable: false };
    }
    const encoded = texts.map((text) => new TextEncoder().encode(text));
    const utf8Bytes = encoded.reduce((total, bytes) => total + bytes.byteLength, 0);
    if (utf8Bytes > this.capabilities.maxInputUtf8Bytes) {
      return { ok: false, code: 'input-too-large', summary: 'Embedding input exceeds byte limit.', retryable: false };
    }
    const vectors = [];
    for (const bytes of encoded) {
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      const vector = Array.from(
        { length: this.capabilities.dimension },
        (_, index) => ((digest[index % digest.length] ?? 0) / 127.5) - 1
      );
      const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      vectors.push(vector.map((value) => value / magnitude));
    }
    return { ok: true, vectors, usage: { inputCount: texts.length, utf8Bytes } };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
