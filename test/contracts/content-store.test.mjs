import assert from 'node:assert/strict';
import test from 'node:test';

import { createLorebitId, digestBytes } from '../../dist/index.js';
import { InMemoryContentStore } from '../../dist/testing/index.js';

test('ContentStore keeps immutable bytes scoped by space and digest', async () => {
  const store = new InMemoryContentStore();
  assert.equal(store.descriptor.testingOnly, true);
  assert.deepEqual(store.capabilities, {
    contentAddressed: true,
    immutableWrite: true,
    tombstone: true,
    physicalDelete: false,
    spaceIsolation: 'logical-verified'
  });
  const bytes = new TextEncoder().encode('immutable lorebit content');
  const digest = await digestBytes(bytes);
  const ref = {
    schemaVersion: '1.0',
    spaceId: createLorebitId('space', 'content-a'),
    contentId: createLorebitId('content', 'blob-1'),
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    digest
  };

  assert.equal((await store.putImmutable({ ref, bytes })).ok, true);
  bytes.fill(0);
  const read = await store.get(ref);
  assert.equal(read.ok, true);
  assert.equal(new TextDecoder().decode(read.value), 'immutable lorebit content');

  const otherSpace = { ...ref, spaceId: createLorebitId('space', 'content-b') };
  assert.equal((await store.get(otherSpace)).error.code, 'not-found');

  const differentBytes = new TextEncoder().encode('different lorebit content');
  const conflictRef = {
    ...ref,
    byteLength: differentBytes.byteLength,
    digest: await digestBytes(differentBytes)
  };
  const conflict = await store.putImmutable({ ref: conflictRef, bytes: differentBytes });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'state-conflict');
});

test('ContentStore tombstones without claiming physical deletion', async () => {
  const store = new InMemoryContentStore();
  const bytes = new TextEncoder().encode('retained audit content');
  const ref = {
    schemaVersion: '1.0',
    spaceId: createLorebitId('space', 'retention'),
    contentId: createLorebitId('content', 'blob-1'),
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    digest: await digestBytes(bytes)
  };
  await store.putImmutable({ ref, bytes });
  const receipt = await store.tombstone(
    ref,
    createLorebitId('operation', 'delete-1'),
    '2026-08-13T06:00:00.000Z'
  );
  assert.equal(receipt.ok, true);
  assert.equal(receipt.value.physicalDelete, false);
  assert.equal(await store.has(ref), false);
  assert.equal((await store.get(ref)).error.code, 'not-found');
});
