import type { ExecutionOptions } from '../application/commands.js';
import type { ModelDataBoundary } from '../domain/security.js';

export interface EmbeddingUsage {
  readonly inputCount: number;
  readonly utf8Bytes: number;
}

export type EmbeddingResult =
  | {
      readonly ok: true;
      readonly vectors: readonly (readonly number[])[];
      readonly usage: EmbeddingUsage;
    }
  | {
      readonly ok: false;
      readonly code: 'input-too-large' | 'cancelled' | 'model-failure';
      readonly summary: string;
      readonly retryable: boolean;
    };

export interface EmbeddingModel {
  readonly descriptor: {
    readonly kind: 'embedding-model';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
    readonly dataBoundary: ModelDataBoundary;
  };
  readonly capabilities: {
    readonly model: string;
    readonly dimension: number;
    readonly maxBatchSize: number;
    readonly maxInputUtf8Bytes: number;
    readonly deterministic: boolean;
  };
  embed(texts: readonly string[], options?: ExecutionOptions): Promise<EmbeddingResult>;
  close(): Promise<void>;
}
