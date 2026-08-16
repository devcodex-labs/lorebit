import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCitation } from '../../dist/index.js';

function fixture() {
  const digest = { algorithm: 'sha-256', value: 'a'.repeat(64) };
  const visibilityDigest = { algorithm: 'sha-256', value: 'b'.repeat(64) };
  const locator = { source: { kind: 'url', value: 'https://example.test', fragment: null }, unitPath: 'section/1', start: 0, end: 4 };
  const unit = {
    spaceId: 'space_docs', revisionId: 'revision_r1', unitVersionId: 'unit-version_u1',
    identity: { spaceId: 'space_docs', sourceId: 'source_s1', unitId: 'unit_u1', stableKey: 'one' },
    textDigest: digest, visibilityDigest, locator
  };
  const snapshot = {
    spaceId: 'space_docs', policyId: 'policy_p1', generationId: 'generation_g1',
    revisions: [{ sourceId: 'source_s1', revisionId: 'revision_r1' }]
  };
  const citation = {
    spaceId: 'space_docs', sourceId: 'source_s1', revisionId: 'revision_r1',
    unitId: 'unit_u1', unitVersionId: 'unit-version_u1', policyId: 'policy_p1', generationId: 'generation_g1',
    contentDigest: digest, visibilityDigest, locator
  };
  return { unit, snapshot, citation };
}

test('Citation validation binds scope, revision, unit, generation, digest and locator', () => {
  const { unit, snapshot, citation } = fixture();
  assert.deepEqual(validateCitation(citation, unit, snapshot), { valid: true });
  assert.deepEqual(validateCitation({ ...citation, contentDigest: { ...citation.contentDigest, value: 'c'.repeat(64) } }, unit, snapshot), { valid: false, reason: 'digest' });
  assert.deepEqual(validateCitation({ ...citation, generationId: 'generation_g2' }, unit, snapshot), { valid: false, reason: 'generation' });
});
