import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeJson,
  decodeDigestRef,
  digestCanonicalJson
} from '../../dist/index.js';
import { WIRE_FIXTURES } from '../../dist/testing/index.js';

test('canonicalizes key order recursively', () => {
  const result = canonicalizeJson(WIRE_FIXTURES.canonicalObject.input);
  assert.deepEqual(result, {
    ok: true,
    value: WIRE_FIXTURES.canonicalObject.canonical
  });
});

test('produces the frozen UTF-8 SHA-256 fixture', async () => {
  const result = await digestCanonicalJson(WIRE_FIXTURES.canonicalObject.input);
  assert.equal(result.ok, true);
  assert.equal(result.value.algorithm, 'sha-256');
  assert.equal(result.value.value, WIRE_FIXTURES.canonicalObject.sha256);
});

test('rejects unsupported values instead of relying on JSON.stringify coercion', () => {
  const result = canonicalizeJson({ hidden: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.error.causePath, '$.hidden');
});

test('validates algorithm-tagged digest references at runtime', () => {
  assert.equal(decodeDigestRef({
    algorithm: 'sha-256',
    value: WIRE_FIXTURES.canonicalObject.sha256
  }).ok, true);
  assert.equal(decodeDigestRef({
    algorithm: 'sha-256',
    value: WIRE_FIXTURES.canonicalObject.sha256.toUpperCase()
  }).ok, false);
  assert.equal(decodeDigestRef({
    algorithm: 'sha-512',
    value: WIRE_FIXTURES.canonicalObject.sha256
  }).ok, false);
});
