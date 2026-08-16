import assert from 'node:assert/strict';
import test from 'node:test';

import { compileFilterExpression, DEFAULT_QUERY_FILTER_SCHEMA } from '../../dist/index.js';

const full = { pushdown: 'full', predicates: ['eq', 'neq', 'in', 'exists', 'lt', 'lte', 'gt', 'gte'], booleanOperators: ['and', 'or', 'not'], nullSemantics: 'lorebit-v1' };

test('Filter compiler rejects dynamic fields and type mismatches', async () => {
  const dynamic = await compileFilterExpression({ op: 'eq', field: 'metadata.user_supplied', value: 'x' }, DEFAULT_QUERY_FILTER_SCHEMA, full);
  assert.equal(dynamic.ok, false);
  assert.equal(dynamic.code, 'filter-invalid');
  const mismatch = await compileFilterExpression({ op: 'lt', field: 'spaceId', value: 3 }, DEFAULT_QUERY_FILTER_SCHEMA, full);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'filter-invalid');
});

test('Filter compiler fails closed for partial pushdown and provider-specific not/null semantics', async () => {
  const partial = await compileFilterExpression({ op: 'eq', field: 'spaceId', value: 'space_docs' }, DEFAULT_QUERY_FILTER_SCHEMA, { ...full, pushdown: 'partial' });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'filter-not-enforceable');
  const not = await compileFilterExpression({ op: 'not', operand: { op: 'eq', field: 'spaceId', value: 'space_docs' } }, DEFAULT_QUERY_FILTER_SCHEMA, { ...full, nullSemantics: 'provider-specific' });
  assert.equal(not.ok, false);
  assert.equal(not.code, 'filter-invalid');
});

test('Filter compiler gives empty in a deterministic full receipt', async () => {
  const result = await compileFilterExpression({ op: 'in', field: 'sourceId', values: [] }, DEFAULT_QUERY_FILTER_SCHEMA, full);
  assert.equal(result.ok, true);
  assert.equal(result.value.enforceable, true);
});
