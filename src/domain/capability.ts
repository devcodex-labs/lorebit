import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { ReceiptId } from './ids.js';

export interface AdapterDescriptor {
  readonly kind: string;
  readonly adapterId: string;
  readonly name: string;
  readonly version: string;
  readonly deploymentFingerprint: string;
  readonly buildDigest: DigestRef | null;
  readonly testingOnly: boolean;
}

export interface CapabilityManifest {
  readonly schemaVersion: '1.0';
  readonly adapterId: string;
  readonly capabilities: JsonValue;
  readonly manifestDigest: DigestRef;
}

export interface CapabilityVerificationReceipt {
  readonly schemaVersion: '1.0';
  readonly receiptId: ReceiptId;
  readonly adapterId: string;
  readonly contractMajor: 1;
  readonly runtimeVersion: string;
  readonly manifestDigest: DigestRef;
  readonly environmentClass: string;
  readonly probes: readonly string[];
  readonly status: 'passed' | 'failed';
  readonly issuedAt: Rfc3339Utc;
  readonly validUntil: Rfc3339Utc;
  readonly issuer: string;
}
