export interface SchemaFailure {
  readonly code: 'schema-invalid' | 'schema-version-unsupported';
  readonly path: string;
  readonly summary: string;
}

export type SchemaDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SchemaFailure };

export interface SchemaCodec<T> {
  readonly schemaId: string;
  readonly schemaVersion: string;
  decode(input: unknown): SchemaDecodeResult<T>;
  encode(value: T): unknown;
}

export function unsupportedSchemaVersion(
  path: string,
  actual: unknown,
  supportedMajor: number
): SchemaDecodeResult<never> {
  return {
    ok: false,
    error: {
      code: 'schema-version-unsupported',
      path,
      summary: `Expected schema major ${supportedMajor}; received ${String(actual)}.`
    }
  };
}
