import { digestBytes } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { ImmutableContentRef } from '../domain/source.js';
import type { OperationId } from '../domain/ids.js';
import type {
  ContentDeleteReceipt,
  ContentStore,
  ContentStoreResult,
  PutImmutableContentRequest
} from '../ports/content-store.js';

interface StoredContent {
  readonly ref: ImmutableContentRef;
  readonly bytes: Uint8Array;
  readonly tombstone: ContentDeleteReceipt | null;
}

function contentKey(ref: ImmutableContentRef): string {
  return `${ref.spaceId}\u0000${ref.contentId}`;
}

export class InMemoryContentStore implements ContentStore {
  readonly descriptor = Object.freeze({
    kind: 'content-store' as const,
    adapterId: '@devcodex/lorebit/testing:in-memory-content-store',
    name: 'InMemoryContentStore',
    version: '0.1',
    testingOnly: true
  });
  readonly capabilities = Object.freeze({
    contentAddressed: true,
    immutableWrite: true,
    tombstone: true,
    physicalDelete: false,
    spaceIsolation: 'logical-verified' as const
  });
  readonly #content = new Map<string, StoredContent>();
  #closed = false;

  async putImmutable(
    request: PutImmutableContentRequest
  ): Promise<ContentStoreResult<ImmutableContentRef>> {
    if (this.#closed) {
      return {
        ok: false,
        error: { code: 'adapter-failure', summary: 'Content store is closed.', retryable: false }
      };
    }
    if (request.bytes.byteLength !== request.ref.byteLength) {
      return {
        ok: false,
        error: {
          code: 'digest-mismatch',
          summary: 'Content byte length does not match its immutable reference.',
          retryable: false
        }
      };
    }
    const immutableBytes = new Uint8Array(request.bytes);
    const digest = await digestBytes(immutableBytes);
    if (
      digest.algorithm !== request.ref.digest.algorithm ||
      digest.value !== request.ref.digest.value
    ) {
      return {
        ok: false,
        error: { code: 'digest-mismatch', summary: 'Content digest mismatch.', retryable: false }
      };
    }
    const key = contentKey(request.ref);
    const existing = this.#content.get(key);
    if (existing !== undefined) {
      if (existing.ref.digest.value === request.ref.digest.value) {
        return { ok: true, value: structuredClone(existing.ref) };
      }
      return {
        ok: false,
        error: {
          code: 'state-conflict',
          summary: 'An immutable content id already refers to different bytes.',
          retryable: false
        }
      };
    }
    this.#content.set(key, {
      ref: structuredClone(request.ref),
      bytes: immutableBytes,
      tombstone: null
    });
    return { ok: true, value: structuredClone(request.ref) };
  }

  async get(ref: ImmutableContentRef): Promise<ContentStoreResult<Uint8Array>> {
    const stored = this.#content.get(contentKey(ref));
    if (stored === undefined || stored.tombstone !== null || this.#closed) {
      return {
        ok: false,
        error: { code: 'not-found', summary: 'Content is unavailable in this space.', retryable: false }
      };
    }
    if (stored.ref.digest.value !== ref.digest.value) {
      return {
        ok: false,
        error: { code: 'digest-mismatch', summary: 'Requested content digest mismatch.', retryable: false }
      };
    }
    return { ok: true, value: stored.bytes.slice() };
  }

  async has(ref: ImmutableContentRef): Promise<boolean> {
    const stored = this.#content.get(contentKey(ref));
    return !this.#closed && stored !== undefined && stored.tombstone === null;
  }

  async tombstone(
    ref: ImmutableContentRef,
    operationId: OperationId,
    at: Rfc3339Utc
  ): Promise<ContentStoreResult<ContentDeleteReceipt>> {
    const key = contentKey(ref);
    const stored = this.#content.get(key);
    if (stored === undefined || this.#closed) {
      return {
        ok: false,
        error: { code: 'not-found', summary: 'Content is unavailable in this space.', retryable: false }
      };
    }
    if (stored.tombstone !== null) {
      return { ok: true, value: structuredClone(stored.tombstone) };
    }
    const receipt: ContentDeleteReceipt = {
      schemaVersion: '1.0',
      operationId,
      spaceId: ref.spaceId,
      content: structuredClone(ref),
      digest: structuredClone(ref.digest),
      tombstonedAt: at,
      physicalDelete: false
    };
    this.#content.set(key, { ...stored, tombstone: receipt });
    return { ok: true, value: structuredClone(receipt) };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
