import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJsonValue, isJsonValue } from '../../dist/index.js';

test('accepts the lorebit JSON wire subset and normalizes negative zero', () => {
  const decoded = decodeJsonValue({ z: [true, null, -0], a: 'value' });
  assert.equal(decoded.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.value)), {
    a: 'value',
    z: [true, null, 0]
  });
  assert.equal(isJsonValue(decoded.value), true);
});

test('rejects non-wire runtime objects', () => {
  class ProviderObject {}
  for (const input of [
    new Date(),
    new Map(),
    new Set(),
    new ProviderObject(),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    () => {}
  ]) {
    assert.equal(decodeJsonValue(input).ok, false);
  }
});

test('rejects cyclic arrays and objects', () => {
  const object = {};
  object.self = object;
  const array = [];
  array.push(array);
  assert.equal(decodeJsonValue(object).ok, false);
  assert.equal(decodeJsonValue(array).ok, false);
});

test('rejects accessors, symbols, non-enumerable values and sparse arrays', () => {
  const accessor = {
    get value() {
      return 'hidden computation';
    }
  };
  const symbolValue = { visible: true };
  symbolValue[Symbol('hidden')] = 'secret';
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'hidden', { value: true });
  const sparse = new Array(2);
  sparse[1] = 'value';

  for (const input of [accessor, symbolValue, nonEnumerable, sparse]) {
    const decoded = decodeJsonValue(input);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.error.code, 'non-data-property');
  }
});
