import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { SpaceId } from '../domain/ids.js';
import type { DerivedArtifact, DerivedArtifactDeleteReceipt, DerivedArtifactKey, DerivedArtifactStore, DerivedArtifactStoreResult } from '../ports/derived-artifact-store.js';

function key(value: DerivedArtifactKey): string {
  return [value.spaceId, value.accessFingerprint.value, value.generationId, value.queryPlanId, value.kind, value.artifactId].join('\u0000');
}

export class InMemoryDerivedArtifactStore implements DerivedArtifactStore {
  readonly descriptor = Object.freeze({ kind: 'derived-artifact-store' as const, adapterId: '@devcodex/lorebit/testing:in-memory-derived-artifact-store', name: 'InMemoryDerivedArtifactStore', version: '0.1', deploymentFingerprint: 'testing:derived-store:default', testingOnly: true });
  readonly capabilities;
  readonly #values = new Map<string, DerivedArtifact>();
  #closed = false;

  constructor(maxEntries = 1_000, maxUtf8Bytes = 16 * 1024 * 1024) {
    this.capabilities = Object.freeze({ maxEntries, maxUtf8Bytes, ttl: true, lineageInvalidation: true, deleteReceipt: true, spaceIsolation: 'logical-verified' as const });
  }

  async put(artifact: DerivedArtifact): Promise<DerivedArtifactStoreResult<{ readonly stored: true }>> {
    if (this.#closed) return { ok: false, code: 'store-failure', summary: 'Derived store is closed.' };
    const current = this.#values.get(key(artifact.key));
    const bytes = Array.from(this.#values.values()).reduce((total, value) => total + value.utf8Bytes, 0) - (current?.utf8Bytes ?? 0) + artifact.utf8Bytes;
    if ((!this.#values.has(key(artifact.key)) && this.#values.size >= this.capabilities.maxEntries) || bytes > this.capabilities.maxUtf8Bytes) return { ok: false, code: 'limit', summary: 'Derived artifact store limit exceeded.' };
    this.#values.set(key(artifact.key), structuredClone(artifact));
    return { ok: true, value: { stored: true } };
  }

  async get(value: DerivedArtifactKey, now: Rfc3339Utc): Promise<DerivedArtifactStoreResult<DerivedArtifact>> {
    const found = this.#values.get(key(value));
    if (found === undefined || found.expiresAt <= now || this.#closed) return { ok: false, code: 'not-found', summary: 'Derived artifact was not found.' };
    return { ok: true, value: structuredClone(found) };
  }

  async invalidateLineage(spaceId: SpaceId, lineageRef: string, at: Rfc3339Utc): Promise<DerivedArtifactStoreResult<readonly DerivedArtifactDeleteReceipt[]>> {
    const receipts: DerivedArtifactDeleteReceipt[] = [];
    for (const [storedKey, artifact] of this.#values) {
      if (artifact.key.spaceId === spaceId && artifact.lineage.includes(lineageRef)) {
        this.#values.delete(storedKey);
        receipts.push({ key: artifact.key, deleted: true, observedAt: at });
      }
    }
    return { ok: true, value: receipts };
  }

  async delete(value: DerivedArtifactKey, at: Rfc3339Utc): Promise<DerivedArtifactStoreResult<DerivedArtifactDeleteReceipt>> {
    return { ok: true, value: { key: value, deleted: this.#values.delete(key(value)), observedAt: at } };
  }

  async size() { return { entries: this.#values.size, utf8Bytes: Array.from(this.#values.values()).reduce((total, value) => total + value.utf8Bytes, 0) }; }
  async close() { this.#closed = true; }
}
