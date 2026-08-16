import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCitation } from '../../dist/index.js';
import { DeterministicTokenCounter } from '../../dist/testing/index.js';
import { createQueryFixture, queryRequest } from '../fixtures/query-runtime.mjs';

test('E2E-11 citations reject tampering and ContextProvenance records admission/exclusion', async (t) => {
  const fixture = await createQueryFixture({ tokenCounter: new DeterministicTokenCounter() });
  t.after(() => fixture.runtime.close());
  const request = await queryRequest(fixture, {
    mode: 'context',
    contextBudget: { maxEvidence: 2, maxUtf8Bytes: 1024, maxTokens: 100 }
  });
  const result = await fixture.runtime.buildContext(request);
  assert.equal(result.ok, true);
  assert.equal(result.value.context.evidence.length, 2);
  assert.equal(result.value.context.excluded.length > 0, true);
  assert.deepEqual(
    result.value.context.provenance.admittedUnitVersionIds,
    result.value.context.evidence.map((entry) => entry.citation.unitVersionId)
  );
  const citation = result.value.citations[0];
  const unit = await fixture.repository.getContentUnitVersion(fixture.idsByKind.spaceId, citation.unitVersionId);
  const snapshot = await fixture.repository.getQuerySnapshot(fixture.idsByKind.spaceId);
  assert.deepEqual(validateCitation(citation, unit, snapshot), { valid: true });
  const tampered = { ...citation, contentDigest: { ...citation.contentDigest, value: 'f'.repeat(64) } };
  assert.deepEqual(validateCitation(tampered, unit, snapshot), { valid: false, reason: 'digest' });
  const wrongLocator = { ...citation, locator: { ...citation.locator, unitPath: 'forged' } };
  assert.deepEqual(validateCitation(wrongLocator, unit, snapshot), { valid: false, reason: 'locator' });
});
