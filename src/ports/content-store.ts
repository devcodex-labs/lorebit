import type { DigestRef } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { ImmutableContentRef } from '../domain/source.js';
import type { OperationId, SpaceId } from '../domain/ids.js';

export interface ContentStoreFailure {
  readonly code:
    | 'not-found'
    | 'digest-mismatch'
    | 'state-conflict'
    | 'adapter-failure';
  readonly summary: string;
  readonly retryable: boolean;
}

export type ContentStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContentStoreFailure };

export interface PutImmutableContentRequest {
  readonly ref: ImmutableContentRef;
  readonly bytes: Uint8Array;
}

export interface ContentDeleteReceipt {
  readonly schemaVersion: '1.0';
  readonly operationId: OperationId;
  readonly spaceId: SpaceId;
  readonly content: ImmutableContentRef;
  readonly digest: DigestRef;
  readonly tombstonedAt: Rfc3339Utc;
  readonly physicalDelete: false;
}

export interface ContentStore {
  readonly descriptor: {
    readonly kind: 'content-store';
    readonly adapterId: string;
    readonly name: string;
    readonly version: string;
    readonly testingOnly: boolean;
  };
  readonly capabilities: {
    readonly contentAddressed: boolean;
    readonly immutableWrite: boolean;
    readonly tombstone: boolean;
    readonly physicalDelete: boolean;
    readonly spaceIsolation: 'physical' | 'logical-verified' | 'none';
  };
  putImmutable(
    request: PutImmutableContentRequest
  ): Promise<ContentStoreResult<ImmutableContentRef>>;
  get(ref: ImmutableContentRef): Promise<ContentStoreResult<Uint8Array>>;
  has(ref: ImmutableContentRef): Promise<boolean>;
  tombstone(
    ref: ImmutableContentRef,
    operationId: OperationId,
    at: Rfc3339Utc
  ): Promise<ContentStoreResult<ContentDeleteReceipt>>;
  close(): Promise<void>;
}
