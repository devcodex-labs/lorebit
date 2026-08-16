import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRfc3339Utc,
  formatRfc3339Utc
} from '../../dist/index.js';
import { WIRE_FIXTURES } from '../../dist/testing/index.js';

test('round-trips a UTC instant with exact millisecond precision', () => {
  const decoded = decodeRfc3339Utc(WIRE_FIXTURES.instant);
  assert.deepEqual(decoded, { ok: true, value: WIRE_FIXTURES.instant });
  assert.deepEqual(formatRfc3339Utc(new Date(WIRE_FIXTURES.instant)), decoded);
});

test('rejects ambiguous offsets, missing milliseconds and invalid dates', () => {
  for (const input of [
    '2026-08-13T05:00:00Z',
    '2026-08-13T13:00:00.000+08:00',
    '2026-02-30T05:00:00.000Z',
    'not-a-time'
  ]) {
    assert.equal(decodeRfc3339Utc(input).ok, false);
  }
});

test('rejects dates outside the four-digit RFC 3339 year range', () => {
  assert.equal(formatRfc3339Utc(new Date('+010000-01-01T00:00:00.000Z')).ok, false);
});
