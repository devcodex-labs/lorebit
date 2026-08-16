declare const lorebitIdBrand: unique symbol;

export type LorebitIdKind =
  | 'space'
  | 'policy'
  | 'source'
  | 'revision'
  | 'recipe'
  | 'generation'
  | 'activation'
  | 'result'
  | 'query-plan'
  | 'citation'
  | 'impact'
  | 'recovery'
  | 'export'
  | 'import-plan'
  | 'migration'
  | 'evaluation'
  | 'operation'
  | 'event'
  | 'run'
  | 'content'
  | 'unit'
  | 'unit-version'
  | 'delta-plan'
  | 'receipt'
  | 'decision'
  | 'import'
  | 'outbox';

export type LorebitId<K extends LorebitIdKind> = string & {
  readonly [lorebitIdBrand]: K;
};

export type SpaceId = LorebitId<'space'>;
export type PolicyId = LorebitId<'policy'>;
export type SourceId = LorebitId<'source'>;
export type RevisionId = LorebitId<'revision'>;
export type RecipeId = LorebitId<'recipe'>;
export type GenerationId = LorebitId<'generation'>;
export type ActivationId = LorebitId<'activation'>;
export type ResultId = LorebitId<'result'>;
export type QueryPlanId = LorebitId<'query-plan'>;
export type CitationId = LorebitId<'citation'>;
export type ImpactId = LorebitId<'impact'>;
export type RecoveryId = LorebitId<'recovery'>;
export type ExportId = LorebitId<'export'>;
export type ImportPlanId = LorebitId<'import-plan'>;
export type MigrationId = LorebitId<'migration'>;
export type EvaluationId = LorebitId<'evaluation'>;
export type OperationId = LorebitId<'operation'>;
export type EventId = LorebitId<'event'>;
export type RunId = LorebitId<'run'>;
export type ContentId = LorebitId<'content'>;
export type ContentUnitId = LorebitId<'unit'>;
export type ContentUnitVersionId = LorebitId<'unit-version'>;
export type DeltaPlanId = LorebitId<'delta-plan'>;
export type ReceiptId = LorebitId<'receipt'>;
export type DecisionId = LorebitId<'decision'>;
export type ImportBatchId = LorebitId<'import'>;
export type OutboxId = LorebitId<'outbox'>;

export interface IdGenerator {
  next<K extends LorebitIdKind>(kind: K): LorebitId<K>;
}

export type IdDecodeResult<K extends LorebitIdKind> =
  | { readonly ok: true; readonly value: LorebitId<K> }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'id-invalid';
        readonly summary: string;
      };
    };

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}_[A-Za-z0-9][A-Za-z0-9._~-]{0,126}$/;

export function decodeLorebitId<K extends LorebitIdKind>(
  kind: K,
  input: unknown
): IdDecodeResult<K> {
  const prefix = `${kind}_`;
  if (
    typeof input !== 'string' ||
    !input.startsWith(prefix) ||
    !ID_PATTERN.test(input)
  ) {
    return {
      ok: false,
      error: {
        code: 'id-invalid',
        summary: `Expected a ${kind} id with prefix ${prefix}`
      }
    };
  }
  return { ok: true, value: input as LorebitId<K> };
}

export function createLorebitId<K extends LorebitIdKind>(
  kind: K,
  value: string
): LorebitId<K> {
  const decoded = decodeLorebitId(kind, `${kind}_${value}`);
  if (!decoded.ok) {
    throw new TypeError(decoded.error.summary);
  }
  return decoded.value;
}

export function createSystemIdGenerator(): IdGenerator {
  return {
    next<K extends LorebitIdKind>(kind: K): LorebitId<K> {
      return createLorebitId(kind, globalThis.crypto.randomUUID().replaceAll('-', ''));
    }
  };
}
