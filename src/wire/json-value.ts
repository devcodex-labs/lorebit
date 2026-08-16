export type JsonPrimitive = null | boolean | string | number;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonValueFailureCode =
  | 'not-json-value'
  | 'non-finite-number'
  | 'unsafe-integer'
  | 'non-plain-object'
  | 'non-data-property'
  | 'cyclic-value'
  | 'unsupported-undefined';

export interface JsonValueFailure {
  readonly code: JsonValueFailureCode;
  readonly path: string;
  readonly summary: string;
}

export type JsonValueDecodeResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: JsonValueFailure };

function failure(
  code: JsonValueFailureCode,
  path: string,
  summary: string
): JsonValueDecodeResult {
  return { ok: false, error: { code, path, summary } };
}

function decodeAt(
  input: unknown,
  path: string,
  ancestors: Set<object>
): JsonValueDecodeResult {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') {
    return { ok: true, value: input };
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      return failure('non-finite-number', path, 'JSON numbers must be finite.');
    }
    if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
      return failure('unsafe-integer', path, 'Integer wire values must be safe integers.');
    }
    return { ok: true, value: Object.is(input, -0) ? 0 : input };
  }

  if (input === undefined) {
    return failure('unsupported-undefined', path, 'Undefined is not a JSON value.');
  }

  if (typeof input !== 'object') {
    return failure('not-json-value', path, 'Functions, symbols and bigint are not JSON values.');
  }

  if (ancestors.has(input)) {
    return failure('cyclic-value', path, 'Wire values cannot contain cycles.');
  }

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      const ownKeys = Reflect.ownKeys(input);
      const allowedKeys = new Set([
        'length',
        ...Array.from({ length: input.length }, (_, index) => String(index))
      ]);
      if (
        ownKeys.length !== allowedKeys.size ||
        ownKeys.some(
          (key) => typeof key !== 'string' || !allowedKeys.has(key)
        )
      ) {
        return failure(
          'non-data-property',
          path,
          'Wire arrays cannot contain symbols, holes or extra properties.'
        );
      }

      const result: JsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const decoded = decodeAt(input[index], `${path}[${index}]`, ancestors);
        if (!decoded.ok) {
          return decoded;
        }
        result.push(decoded.value);
      }
      return { ok: true, value: result };
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return failure(
        'non-plain-object',
        path,
        'Wire objects must be plain objects with no provider or class prototype.'
      );
    }

    const result: Record<string, JsonValue> = Object.create(null);
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      return failure(
        'non-data-property',
        path,
        'Wire objects cannot contain symbol properties.'
      );
    }

    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return failure(
          'non-data-property',
          `${path}.${key}`,
          'Wire objects require enumerable own data properties.'
        );
      }
      const decoded = decodeAt(
        descriptor.value,
        `${path}.${key}`,
        ancestors
      );
      if (!decoded.ok) {
        return decoded;
      }
      result[key] = decoded.value;
    }
    return { ok: true, value: result };
  } finally {
    ancestors.delete(input);
  }
}

export function decodeJsonValue(input: unknown): JsonValueDecodeResult {
  return decodeAt(input, '$', new Set<object>());
}

export function isJsonValue(input: unknown): input is JsonValue {
  return decodeJsonValue(input).ok;
}
