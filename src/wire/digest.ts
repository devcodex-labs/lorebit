import { canonicalizeJson } from './canonical-json.js';

export interface DigestRef {
  readonly algorithm: 'sha-256';
  readonly value: string;
}

export type DigestDecodeResult =
  | { readonly ok: true; readonly value: DigestRef }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'digest-ref-invalid';
        readonly summary: string;
      };
    };

export function decodeDigestRef(input: unknown): DigestDecodeResult {
  if (
    typeof input !== 'object' ||
    input === null ||
    Reflect.get(input, 'algorithm') !== 'sha-256' ||
    typeof Reflect.get(input, 'value') !== 'string' ||
    !/^[0-9a-f]{64}$/.test(Reflect.get(input, 'value')) ||
    Object.keys(input).some((key) => key !== 'algorithm' && key !== 'value')
  ) {
    return {
      ok: false,
      error: {
        code: 'digest-ref-invalid',
        summary: 'DigestRef must be a lowercase sha-256 digest with exactly 64 hex digits.'
      }
    };
  }
  return { ok: true, value: input as DigestRef };
}

export type DigestResult =
  | { readonly ok: true; readonly value: DigestRef }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'digest-input-invalid';
        readonly summary: string;
        readonly causePath: string;
      };
    };

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

export async function digestBytes(input: BufferSource): Promise<DigestRef> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return { algorithm: 'sha-256', value: toHex(digest) };
}

export async function digestCanonicalJson(input: unknown): Promise<DigestResult> {
  const canonical = canonicalizeJson(input);
  if (!canonical.ok) {
    return {
      ok: false,
      error: {
        code: 'digest-input-invalid',
        summary: canonical.error.summary,
        causePath: canonical.error.causePath
      }
    };
  }

  const value = await digestBytes(new TextEncoder().encode(canonical.value));
  return { ok: true, value };
}
