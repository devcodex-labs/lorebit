import { decodeJsonValue, type JsonValue } from './json-value.js';

export interface CanonicalJsonFailure {
  readonly code: 'canonical-json-invalid';
  readonly summary: string;
  readonly causePath: string;
}

export type CanonicalJsonResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: CanonicalJsonFailure };

function serialize(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }

  return `{${
    Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`)
      .join(',')
  }}`;
}

/**
 * Produces RFC 8785-compatible JSON for the wire subset accepted by lorebit.
 * Values outside the interoperable JSON domain are rejected before serialization.
 */
export function canonicalizeJson(input: unknown): CanonicalJsonResult {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) {
    return {
      ok: false,
      error: {
        code: 'canonical-json-invalid',
        summary: decoded.error.summary,
        causePath: decoded.error.path
      }
    };
  }

  return { ok: true, value: serialize(decoded.value) };
}
