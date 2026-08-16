import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLorebitId,
  digestCanonicalJson
} from '../../dist/index.js';
import {
  DeterministicEmbeddingModel,
  InMemoryVectorIndex,
  ScriptedSecurityHook
} from '../../dist/testing/index.js';
import {
  accessContext,
  createQueryFixture,
  envelope,
  queryRequest
} from '../fixtures/query-runtime.mjs';

class PartialFilterVectorIndex extends InMemoryVectorIndex {
  constructor() {
    super(8);
    this.capabilities = Object.freeze({ ...this.capabilities, filter: Object.freeze({ ...this.capabilities.filter, pushdown: 'partial' }) });
  }
}

class SecretFailingVectorIndex extends InMemoryVectorIndex {
  async query() {
    this.queryCalls += 1;
    return { ok: false, code: 'index-failure', summary: 'Authorization: Bearer abc.def token=hunter2&signature=private', retryable: false };
  }
}

test('SEC-01 guessed cross-space scope is invisible across the query boundary', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec01' });
  t.after(() => fixture.runtime.close());
  const before = fixture.vectorIndex.queryCalls;
  const result = await fixture.runtime.retrieve({ ...(await queryRequest(fixture)), spaceId: createLorebitId('space', 'guessed') });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'processing-incomplete');
  assert.equal(fixture.vectorIndex.queryCalls, before);
});

test('SEC-02 partial filter fails before the index is queried', async (t) => {
  const vectorIndex = new PartialFilterVectorIndex();
  const fixture = await createQueryFixture({ seed: 'sec02', vectorIndex, keywordIndex: null });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.retrieve(await queryRequest(fixture, { route: 'semantic' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'filter-not-enforceable');
  assert.equal(vectorIndex.queryCalls, 0);
});

test('SEC-03 tightened visibility claims cannot reuse previously visible evidence', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec03' });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.retrieve(await queryRequest(fixture, {
    access: await accessContext(['public'], ['public'])
  }));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'empty');
  assert.equal(result.value.citations.length, 0);
});

test('SEC-04 source role text remains untrusted evidence, never a directive', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec04' });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.buildContext(await queryRequest(fixture, {
    mode: 'context', trustedDirective: 'Trusted caller directive.'
  }));
  assert.equal(result.ok, true);
  assert.equal(result.value.context.trustedDirective.content, 'Trusted caller directive.');
  const injected = result.value.context.evidence.find((entry) => entry.content.includes('SYSTEM:'));
  assert.equal(injected?.trust, 'untrusted-retrieved-data');
  assert.notEqual(injected?.content, result.value.context.trustedDirective.content);
});

test('SEC-05 missing required hook blocks context and preserves activation', async (t) => {
  const fixture = await createQueryFixture({
    seed: 'sec05',
    policyExtensions: { security: { requiredHooks: ['beforeContext'], dataClassification: 'restricted' } }
  });
  t.after(() => fixture.runtime.close());
  const before = await fixture.repository.getActiveActivation(fixture.idsByKind.spaceId);
  const result = await fixture.runtime.buildContext(await queryRequest(fixture, { mode: 'context' }));
  const after = await fixture.repository.getActiveActivation(fixture.idsByKind.spaceId);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'security-hook-failed');
  assert.equal(after.activationId, before.activationId);
});

test('SEC-06 secret-bearing provider errors are redacted in public outcomes', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec06', vectorIndex: new SecretFailingVectorIndex(), keywordIndex: null });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.retrieve(await queryRequest(fixture, { route: 'semantic' }));
  const serialized = JSON.stringify(result);
  assert.equal(result.ok, false);
  assert.equal(serialized.includes('hunter2'), false);
  assert.equal(serialized.includes('abc.def'), false);
  assert.equal(serialized.includes('private'), false);
  assert.equal(serialized.includes('[REDACTED]'), true);
});

test('SEC-07 access fingerprints produce distinct plans and no implicit cache hit', async (t) => {
  const embeddingModel = new DeterministicEmbeddingModel(8);
  const fixture = await createQueryFixture({ seed: 'sec07', embeddingModel, keywordIndex: null });
  t.after(() => fixture.runtime.close());
  const firstDigest = await digestCanonicalJson({ subject: 'one', labels: ['public'] });
  const secondDigest = await digestCanonicalJson({ subject: 'two', labels: ['public'] });
  const before = embeddingModel.calls;
  const first = await fixture.runtime.retrieve(await queryRequest(fixture, {
    route: 'semantic', access: { fingerprint: firstDigest.value, allowedLabels: ['public'], deniedLabels: [], attributes: { subject: 'one' } }
  }));
  const second = await fixture.runtime.retrieve(await queryRequest(fixture, {
    route: 'semantic', access: { fingerprint: secondDigest.value, allowedLabels: ['public'], deniedLabels: [], attributes: { subject: 'two' } }
  }));
  assert.equal(first.ok && second.ok, true);
  assert.notEqual(first.value.queryPlan.digest.value, second.value.queryPlan.digest.value);
  assert.equal(first.value.provenance.accessContextDigest.value, firstDigest.value.value);
  assert.equal(second.value.provenance.accessContextDigest.value, secondDigest.value.value);
  assert.equal(embeddingModel.calls - before, 2);
});

test('SEC-08 withdrawn locators are absent from default retrieval', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec08' });
  t.after(() => fixture.runtime.close());
  const source = await fixture.repository.getSource(fixture.idsByKind.spaceId, fixture.idsByKind.sourceId);
  const activation = await fixture.repository.getActiveActivation(fixture.idsByKind.spaceId);
  fixture.clock.advanceMilliseconds(1);
  const withdrawn = await fixture.runtime.execute(envelope(fixture.ids, fixture.clock, {
    type: 'revision.withdraw',
    spaceId: fixture.idsByKind.spaceId,
    sourceId: fixture.idsByKind.sourceId,
    revisionId: fixture.idsByKind.revisionId
  }, {
    source: { sourceId: fixture.idsByKind.sourceId, sequence: source.sequence, revisionId: fixture.idsByKind.revisionId },
    activationId: activation.activationId
  }, 'sec08-withdraw'));
  assert.equal(withdrawn.ok, true);
  const result = await fixture.runtime.retrieve(await queryRequest(fixture));
  assert.equal(result.ok, true);
  assert.equal(result.value.citations.length, 0);
});

test('SEC-09 beforeQuery normalization cannot enlarge question scope', async (t) => {
  const hook = new ScriptedSecurityHook(['beforeQuery'], {
    beforeQuery: (input) => ({ ok: true, action: 'normalize', reason: 'malicious-normalizer', output: { ...input.payload, query: 'forbidden topic' }, evidenceRef: null })
  });
  const fixture = await createQueryFixture({
    seed: 'sec09', securityHooks: [hook],
    policyExtensions: { security: { requiredHooks: ['beforeQuery'], dataClassification: 'public' } }
  });
  t.after(() => fixture.runtime.close());
  const before = fixture.vectorIndex.queryCalls;
  const result = await fixture.runtime.retrieve(await queryRequest(fixture));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'query-blocked');
  assert.equal(fixture.vectorIndex.queryCalls, before);
});

test('SEC-10 generation without a LanguageModel is capability-unavailable and exposes no output', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec10' });
  t.after(() => fixture.runtime.close());
  const result = await fixture.runtime.query({ ...(await queryRequest(fixture)), mode: 'generate' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'capability-unavailable');
  assert.equal(JSON.stringify(result).includes('generationOutput'), false);
});

test('SEC-11 restricted query is denied before a remote embedding call', async (t) => {
  const embeddingModel = new DeterministicEmbeddingModel(8, 64, 1_000_000, 'remote:embed', {
    deploymentClass: 'remote', providerProfile: 'unapproved-provider', region: 'us-x', trainingUse: 'unknown', retention: 'unknown', attestationRef: null
  });
  const fixture = await createQueryFixture({
    seed: 'sec11', embeddingModel, keywordIndex: null,
    policyExtensions: { security: { requiredHooks: [], dataClassification: 'restricted', allowedRemoteStages: [], allowedProviderProfiles: [] } }
  });
  t.after(() => fixture.runtime.close());
  const before = embeddingModel.calls;
  const result = await fixture.runtime.retrieve(await queryRequest(fixture, { route: 'semantic' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'data-egress-denied');
  assert.equal(embeddingModel.calls, before);
});

test('SEC-12 stale generation receipt degrades readiness before querying the index', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec12' });
  t.after(() => fixture.runtime.close());
  const before = fixture.vectorIndex.queryCalls;
  fixture.clock.advanceMilliseconds(600_001);
  const result = await fixture.runtime.retrieve(await queryRequest(fixture));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'receipt-stale');
  assert.equal(fixture.vectorIndex.queryCalls, before);
  assert.equal(fixture.runtime.readiness().state, 'degraded');
});

test('SEC-13 raw/script/regex filter syntax is rejected without provider escape', async (t) => {
  const fixture = await createQueryFixture({ seed: 'sec13' });
  t.after(() => fixture.runtime.close());
  for (const op of ['raw', 'script', 'regex']) {
    const before = fixture.vectorIndex.queryCalls;
    const result = await fixture.runtime.retrieve(await queryRequest(fixture, {
      filter: { op, field: 'metadata.classification', value: '.*' }
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-request');
    assert.equal(fixture.vectorIndex.queryCalls, before);
  }
});
