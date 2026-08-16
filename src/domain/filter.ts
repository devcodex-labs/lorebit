import { canonicalizeJson } from '../wire/canonical-json.js';
import { digestCanonicalJson, type DigestRef } from '../wire/digest.js';
import type { JsonPrimitive, JsonValue } from '../wire/json-value.js';

export type FilterFieldType = 'string' | 'number' | 'boolean' | 'instant';
export type FilterPredicateOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'exists'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte';

export interface FilterFieldDefinition {
  readonly path: string;
  readonly type: FilterFieldType;
  readonly purpose: 'scope' | 'access' | 'relevance';
  /** `visibility.labels` is the only v0.1 scalar-in-array field. */
  readonly collection?: 'scalar-in-array';
}

export interface FilterSchema {
  readonly schemaVersion: '1.0';
  readonly fields: readonly FilterFieldDefinition[];
}

export type FilterExpression =
  | { readonly op: 'and'; readonly operands: readonly FilterExpression[] }
  | { readonly op: 'or'; readonly operands: readonly FilterExpression[] }
  | { readonly op: 'not'; readonly operand: FilterExpression }
  | { readonly op: 'exists'; readonly field: string; readonly value: boolean }
  | {
      readonly op: Exclude<FilterPredicateOperator, 'exists' | 'in'>;
      readonly field: string;
      readonly value: JsonPrimitive;
    }
  | {
      readonly op: 'in';
      readonly field: string;
      readonly values: readonly JsonPrimitive[];
    };

export interface FilterSupport {
  readonly pushdown: 'full' | 'partial' | 'none';
  readonly predicates: readonly FilterPredicateOperator[];
  readonly booleanOperators: readonly ('and' | 'or' | 'not')[];
  readonly nullSemantics: 'lorebit-v1' | 'provider-specific';
}

export interface FilterPredicateReceipt {
  readonly path: string;
  readonly field: string;
  readonly operator: FilterPredicateOperator;
  readonly purpose: FilterFieldDefinition['purpose'];
  readonly enforced: boolean;
  readonly reason: string | null;
}

export interface CompiledFilter {
  readonly schemaVersion: '1.0';
  readonly expression: FilterExpression;
  readonly digest: DigestRef;
  readonly fullness: 'full' | 'partial' | 'none';
  readonly enforceable: boolean;
  readonly predicates: readonly FilterPredicateReceipt[];
}

export type FilterCompileResult =
  | { readonly ok: true; readonly value: CompiledFilter }
  | {
      readonly ok: false;
      readonly code: 'filter-invalid' | 'filter-not-enforceable';
      readonly summary: string;
      readonly predicates: readonly FilterPredicateReceipt[];
    };

const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isScalar(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function scalarMatchesType(value: JsonPrimitive, field: FilterFieldDefinition): boolean {
  if (value === null) return true;
  if (field.type === 'instant') {
    return typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
  }
  return typeof value === field.type;
}

function canonicalizeExpression(expression: FilterExpression): FilterExpression {
  if (expression.op === 'and' || expression.op === 'or') {
    const operands = expression.operands.map(canonicalizeExpression).sort((left, right) => {
      const leftCanonical = canonicalizeJson(left);
      const rightCanonical = canonicalizeJson(right);
      if (!leftCanonical.ok || !rightCanonical.ok) return 0;
      return leftCanonical.value.localeCompare(rightCanonical.value, 'en');
    });
    return { op: expression.op, operands };
  }
  if (expression.op === 'not') return { op: 'not', operand: canonicalizeExpression(expression.operand) };
  if (expression.op === 'in') {
    return {
      op: 'in',
      field: expression.field,
      values: [...expression.values].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
    };
  }
  return expression;
}

export function decodeFilterExpression(input: unknown):
  | { readonly ok: true; readonly value: FilterExpression }
  | { readonly ok: false; readonly summary: string } {
  const visit = (value: unknown, path: string): FilterExpression | string => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `${path} must be a filter expression object.`;
    }
    const record = value as Record<string, unknown>;
    if (record.op === 'and' || record.op === 'or') {
      if (!hasOnlyKeys(record, ['op', 'operands']) || !Array.isArray(record.operands) || record.operands.length === 0) {
        return `${path}.${String(record.op)} must contain a non-empty operands array.`;
      }
      const operands: FilterExpression[] = [];
      for (let index = 0; index < record.operands.length; index += 1) {
        const decoded = visit(record.operands[index], `${path}.operands[${index}]`);
        if (typeof decoded === 'string') return decoded;
        operands.push(decoded);
      }
      return { op: record.op, operands };
    }
    if (record.op === 'not') {
      if (!hasOnlyKeys(record, ['op', 'operand'])) return `${path}.not contains unknown fields.`;
      const operand = visit(record.operand, `${path}.operand`);
      return typeof operand === 'string' ? operand : { op: 'not', operand };
    }
    if (record.op === 'exists') {
      return hasOnlyKeys(record, ['op', 'field', 'value']) &&
        typeof record.field === 'string' && typeof record.value === 'boolean'
        ? { op: 'exists', field: record.field, value: record.value }
        : `${path}.exists is invalid.`;
    }
    if (record.op === 'in') {
      return hasOnlyKeys(record, ['op', 'field', 'values']) &&
        typeof record.field === 'string' && Array.isArray(record.values) && record.values.every(isScalar)
        ? { op: 'in', field: record.field, values: record.values }
        : `${path}.in is invalid.`;
    }
    if (['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(String(record.op))) {
      return hasOnlyKeys(record, ['op', 'field', 'value']) &&
        typeof record.field === 'string' && isScalar(record.value)
        ? {
            op: record.op as Exclude<FilterPredicateOperator, 'exists' | 'in'>,
            field: record.field,
            value: record.value
          }
        : `${path}.${String(record.op)} is invalid.`;
    }
    return `${path}.op is unsupported; raw/script/regex/provider operators are forbidden.`;
  };
  const decoded = visit(input, '$');
  return typeof decoded === 'string'
    ? { ok: false, summary: decoded }
    : { ok: true, value: canonicalizeExpression(decoded) };
}

export async function compileFilterExpression(
  input: unknown,
  schema: FilterSchema,
  support: FilterSupport
): Promise<FilterCompileResult> {
  const decoded = decodeFilterExpression(input);
  if (!decoded.ok) return { ok: false, code: 'filter-invalid', summary: decoded.summary, predicates: [] };
  const fields = new Map(schema.fields.map((field) => [field.path, field]));
  if (fields.size !== schema.fields.length || schema.fields.some((field) => !FIELD_PATTERN.test(field.path))) {
    return { ok: false, code: 'filter-invalid', summary: 'FilterSchema fields must be unique allowlisted paths.', predicates: [] };
  }
  const receipts: FilterPredicateReceipt[] = [];
  let invalid: string | null = null;
  const visit = (expression: FilterExpression, path: string): void => {
    if (invalid !== null) return;
    if (expression.op === 'and' || expression.op === 'or') {
      if (!support.booleanOperators.includes(expression.op)) invalid = `${expression.op} semantics are not enforceable.`;
      expression.operands.forEach((operand, index) => visit(operand, `${path}.operands[${index}]`));
      return;
    }
    if (expression.op === 'not') {
      if (!support.booleanOperators.includes('not') || support.nullSemantics !== 'lorebit-v1') {
        invalid = 'not/null semantics are not enforceable.';
      }
      visit(expression.operand, `${path}.operand`);
      return;
    }
    const field = fields.get(expression.field);
    const supported = field !== undefined && support.pushdown === 'full' && support.predicates.includes(expression.op);
    let reason: string | null = null;
    if (field === undefined) reason = 'field-not-allowlisted';
    else if (!FIELD_PATTERN.test(expression.field)) reason = 'dynamic-field-forbidden';
    else if (expression.op === 'in' && !expression.values.every((value) => scalarMatchesType(value, field))) reason = 'value-type-mismatch';
    else if (expression.op !== 'exists' && expression.op !== 'in' && !scalarMatchesType(expression.value, field)) reason = 'value-type-mismatch';
    else if (['lt', 'lte', 'gt', 'gte'].includes(expression.op) && !['number', 'instant'].includes(field.type)) reason = 'ordered-operator-type-mismatch';
    else if (!supported) reason = support.pushdown === 'none' ? 'pushdown-unavailable' : 'predicate-unsupported';
    receipts.push({
      path,
      field: expression.field,
      operator: expression.op,
      purpose: field?.purpose ?? 'access',
      enforced: reason === null,
      reason
    });
    if (reason !== null && (field === undefined || reason.includes('type'))) invalid = reason;
  };
  visit(decoded.value, '$');
  if (invalid !== null) {
    return { ok: false, code: 'filter-invalid', summary: invalid, predicates: receipts };
  }
  const enforceable = receipts.every((receipt) => receipt.enforced);
  if (!enforceable) {
    return {
      ok: false,
      code: 'filter-not-enforceable',
      summary: 'The complete filter cannot be enforced before retrieval.',
      predicates: receipts
    };
  }
  const digest = await digestCanonicalJson(decoded.value);
  if (!digest.ok) return { ok: false, code: 'filter-invalid', summary: digest.error.summary, predicates: receipts };
  return {
    ok: true,
    value: {
      schemaVersion: '1.0',
      expression: decoded.value,
      digest: digest.value,
      fullness: receipts.length === 0 ? 'none' : 'full',
      enforceable: true,
      predicates: receipts
    }
  };
}

function valueAt(input: JsonValue, path: string): { readonly exists: boolean; readonly value: JsonValue | undefined } {
  let current: JsonValue | undefined = input;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function compareScalar(left: JsonPrimitive, right: JsonPrimitive): number | null {
  if (left === null || right === null || typeof left !== typeof right) return null;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right, 'en');
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return null;
}

/** Deterministic reference evaluator used by contract suites and post-query integrity checks. */
export function matchesFilterExpression(
  expression: FilterExpression,
  record: JsonValue,
  schema: FilterSchema
): boolean {
  if (expression.op === 'and') return expression.operands.every((operand) => matchesFilterExpression(operand, record, schema));
  if (expression.op === 'or') return expression.operands.some((operand) => matchesFilterExpression(operand, record, schema));
  if (expression.op === 'not') return !matchesFilterExpression(expression.operand, record, schema);
  const field = schema.fields.find((candidate) => candidate.path === expression.field);
  if (field === undefined) return false;
  const actual = valueAt(record, expression.field);
  if (expression.op === 'exists') return actual.exists === expression.value;
  if (!actual.exists) return false;
  const actualValues = field.collection === 'scalar-in-array' && Array.isArray(actual.value)
    ? actual.value.filter(isScalar)
    : isScalar(actual.value) ? [actual.value] : [];
  if (expression.op === 'in') return actualValues.some((value) => expression.values.some((candidate) => Object.is(value, candidate)));
  if (expression.op === 'eq') return actualValues.some((value) => Object.is(value, expression.value));
  if (expression.op === 'neq') return actualValues.length > 0 && actualValues.every((value) => !Object.is(value, expression.value));
  return actualValues.some((value) => {
    const order = compareScalar(value, expression.value);
    if (order === null) return false;
    if (expression.op === 'lt') return order < 0;
    if (expression.op === 'lte') return order <= 0;
    if (expression.op === 'gt') return order > 0;
    return order >= 0;
  });
}

export const DEFAULT_QUERY_FILTER_SCHEMA: FilterSchema = Object.freeze({
  schemaVersion: '1.0',
  fields: Object.freeze([
    { path: 'spaceId', type: 'string', purpose: 'scope' },
    { path: 'sourceId', type: 'string', purpose: 'scope' },
    { path: 'revisionId', type: 'string', purpose: 'scope' },
    { path: 'unitId', type: 'string', purpose: 'scope' },
    { path: 'unitVersionId', type: 'string', purpose: 'scope' },
    { path: 'disposition', type: 'string', purpose: 'access' },
    { path: 'visibility.labels', type: 'string', purpose: 'access', collection: 'scalar-in-array' }
  ] satisfies readonly FilterFieldDefinition[])
});
