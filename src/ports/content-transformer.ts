import type { ExecutionOptions } from '../application/commands.js';
import type { ProcessingRecipeVersion, SourceRevision } from '../domain/versions.js';
import type { Diagnostic } from '../domain/diagnostics.js';
import type { TransformedContentUnit } from '../domain/content-unit.js';
import type { Source } from '../domain/source.js';

export interface TransformContentRequest {
  readonly revision: SourceRevision;
  readonly source: Source;
  readonly recipe: ProcessingRecipeVersion;
  readonly content: Uint8Array;
  readonly options?: ExecutionOptions;
}

export type TransformContentResult =
  | {
      readonly ok: true;
      readonly units: readonly TransformedContentUnit[];
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly code: 'transform-failed' | 'content-quarantined' | 'cancelled';
      readonly summary: string;
      readonly diagnostics: readonly Diagnostic[];
    };

export interface ContentTransformer {
  readonly descriptor: {
    readonly kind: 'content-transformer';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly testingOnly: boolean;
  };
  readonly capabilities: {
    readonly deterministic: boolean;
    readonly maxExpansionRatio: number;
    readonly mediaTypes: readonly string[];
  };
  transform(request: TransformContentRequest): Promise<TransformContentResult>;
  close(): Promise<void>;
}
