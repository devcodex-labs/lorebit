const UTC_MILLIS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

declare const rfc3339UtcBrand: unique symbol;
export type Rfc3339Utc = string & { readonly [rfc3339UtcBrand]: true };

export interface Rfc3339Failure {
  readonly code: 'rfc3339-invalid';
  readonly summary: string;
}

export type Rfc3339Result =
  | { readonly ok: true; readonly value: Rfc3339Utc }
  | { readonly ok: false; readonly error: Rfc3339Failure };

export function formatRfc3339Utc(date: Date): Rfc3339Result {
  if (!Number.isFinite(date.getTime())) {
    return {
      ok: false,
      error: { code: 'rfc3339-invalid', summary: 'Date must contain a valid instant.' }
    };
  }
  return decodeRfc3339Utc(date.toISOString());
}

export function decodeRfc3339Utc(input: unknown): Rfc3339Result {
  if (typeof input !== 'string' || !UTC_MILLIS_PATTERN.test(input)) {
    return {
      ok: false,
      error: {
        code: 'rfc3339-invalid',
        summary: 'Time must be a UTC RFC 3339 string with exactly millisecond precision.'
      }
    };
  }

  const date = new Date(input);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== input) {
    return {
      ok: false,
      error: { code: 'rfc3339-invalid', summary: 'Time is not a real calendar instant.' }
    };
  }

  return { ok: true, value: input as Rfc3339Utc };
}
