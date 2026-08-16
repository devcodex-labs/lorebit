import assert from 'node:assert/strict';
import test from 'node:test';
import { unsupportedSchemaVersion } from '../../dist/index.js';

test('returns a stable unsupported-major failure', () => {
  assert.deepEqual(unsupportedSchemaVersion('$.schemaVersion', '2.0', 1), {
    ok: false,
    error: {
      code: 'schema-version-unsupported',
      path: '$.schemaVersion',
      summary: 'Expected schema major 1; received 2.0.'
    }
  });
});
