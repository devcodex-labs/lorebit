import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileFilterExpression,
  decodeFilterExpression,
  matchesFilterExpression,
  DEFAULT_QUERY_FILTER_SCHEMA
} from '../../dist/index.js';

const support = {
  pushdown: 'full',
  predicates: ['eq', 'neq', 'in', 'exists', 'lt', 'lte', 'gt', 'gte'],
  booleanOperators: ['and', 'or', 'not'],
  nullSemantics: 'lorebit-v1'
};

test('Filter AST canonicalizes commutative operands and evaluates allowlisted fields', async () => {
  const left = await compileFilterExpression({ op: 'and', operands: [
    { op: 'eq', field: 'disposition', value: 'available' },
    { op: 'eq', field: 'spaceId', value: 'space_docs' }
  ] }, DEFAULT_QUERY_FILTER_SCHEMA, support);
  const right = await compileFilterExpression({ op: 'and', operands: [
    { op: 'eq', field: 'spaceId', value: 'space_docs' },
    { op: 'eq', field: 'disposition', value: 'available' }
  ] }, DEFAULT_QUERY_FILTER_SCHEMA, support);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(left.value.digest.value, right.value.digest.value);
  assert.equal(matchesFilterExpression(left.value.expression, {
    spaceId: 'space_docs', disposition: 'available', visibility: { labels: ['public'] }
  }, DEFAULT_QUERY_FILTER_SCHEMA), true);
});

test('Filter decoder has no raw/script/regex escape hatch', () => {
  for (const op of ['raw', 'script', 'regex']) {
    const result = decodeFilterExpression({ op, field: 'spaceId', value: '*' });
    assert.equal(result.ok, false);
    assert.match(result.summary, /unsupported|forbidden/u);
  }
});
