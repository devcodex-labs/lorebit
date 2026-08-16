import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { ExportId, ImportPlanId, MigrationId, SpaceId } from './ids.js';
import type { SecurityHookRecord } from './security.js';

export interface ExportPlan {
  readonly schemaVersion: '1.0';
  readonly exportId: ExportId;
  readonly spaceId: SpaceId;
  readonly mode: 'full' | 'incremental';
  readonly activationId: string | null;
  readonly includeContent: boolean;
  readonly includeDerived: boolean;
  readonly includeEvents: boolean;
  readonly includeProvenance: boolean;
  readonly baseManifestDigest: DigestRef | null;
  readonly watermark: string | null;
  readonly dataClassification: 'public' | 'internal' | 'restricted';
  readonly estimatedUtf8Bytes: number;
  readonly selection: JsonValue;
  readonly planDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
}

export interface ExportManifest {
  readonly schemaVersion: '1.0';
  readonly contractVersion: '0.1';
  readonly runtimePackage: '@devcodex/lorebit';
  readonly exportId: ExportId;
  readonly sourceSpaceId: SpaceId;
  readonly mode: 'full' | 'incremental';
  readonly baseManifestDigest: DigestRef | null;
  readonly objectCounts: Readonly<Record<string, number>>;
  readonly objectDigests: readonly { readonly kind: string; readonly id: string; readonly digest: DigestRef }[];
  readonly tombstones: readonly string[];
  readonly omissions: readonly { readonly kind: 'content' | 'derived' | 'events' | 'provenance' | 'credentials' | 'provider-raw'; readonly reason: string }[];
  readonly referenceClosureComplete: boolean;
  readonly dataClassification: 'public' | 'internal' | 'restricted';
  readonly securityHooks: readonly SecurityHookRecord[];
  readonly diagnosticCodes: readonly string[];
  readonly contentDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
}

export interface ExportPackage {
  readonly schemaVersion: '1.0';
  readonly manifest: ExportManifest;
  readonly payload: JsonValue;
  readonly packageDigest: DigestRef;
}

export interface ImportPlan {
  readonly schemaVersion: '1.0';
  readonly importPlanId: ImportPlanId;
  readonly sourceSpaceId: SpaceId;
  readonly targetSpaceId: SpaceId;
  readonly packageDigest: DigestRef;
  readonly conflictPolicy: 'reject' | 'remap' | 'quarantine';
  readonly idMappings: Readonly<Record<string, string>>;
  readonly allowNonEmptyTarget: false;
  readonly dryRun: boolean;
  readonly planDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
}

export interface ImportReceipt {
  readonly schemaVersion: '1.0';
  readonly importPlanId: ImportPlanId;
  readonly targetSpaceId: SpaceId;
  readonly imported: readonly string[];
  readonly remapped: Readonly<Record<string, string>>;
  readonly quarantined: readonly { readonly id: string; readonly reason: string }[];
  readonly conflicts: readonly string[];
  readonly activated: false;
  readonly integrityDigest: DigestRef;
  readonly status: 'validated' | 'imported' | 'partial' | 'failed';
  readonly completedAt: Rfc3339Utc;
}

export interface MigrationPlan {
  readonly schemaVersion: '1.0';
  readonly migrationId: MigrationId;
  readonly sourceSchema: string;
  readonly targetSchema: string;
  readonly dryRun: boolean;
  readonly requiresSnapshot: boolean;
  readonly affectedObjects: number;
  readonly estimatedBytes: number;
  readonly forwardSteps: readonly string[];
  readonly rollbackSteps: readonly string[];
  readonly rollForwardBoundary: number;
  readonly requiresMaintenance: boolean;
  readonly inputDigest: DigestRef;
  readonly planDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
}

export interface MigrationReceipt {
  readonly schemaVersion: '1.0';
  readonly migrationId: MigrationId;
  readonly completedSteps: readonly number[];
  readonly checksum: DigestRef;
  readonly result: 'dry-run' | 'migrated' | 'rolled-back' | 'roll-forward-required' | 'failed';
  readonly completedAt: Rfc3339Utc;
}
