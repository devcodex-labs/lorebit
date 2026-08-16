import type { DigestRef } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ContentUnitVersionId,
  DeltaPlanId,
  GenerationId,
  ReceiptId,
  RecipeId,
  RevisionId,
  RunId,
  SpaceId
} from './ids.js';
import type { Diagnostic } from './diagnostics.js';

export type IndexGenerationStatus =
  | 'planned'
  | 'building'
  | 'validating'
  | 'ready'
  | 'active'
  | 'retired'
  | 'failed'
  | 'cancelled';

export interface IndexGeneration {
  readonly schemaVersion: '1.0';
  readonly generationId: GenerationId;
  readonly spaceId: SpaceId;
  readonly parentGenerationId: GenerationId | null;
  readonly runId: RunId;
  readonly recipeId: RecipeId;
  readonly revisionIds: readonly RevisionId[];
  readonly unitVersionIds: readonly ContentUnitVersionId[];
  readonly deltaPlanId: DeltaPlanId;
  readonly embedding: {
    readonly adapterId: string;
    readonly model: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
    readonly dimension: number;
  };
  readonly vectorIndex: {
    readonly adapterId: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
  };
  readonly keywordIndex: {
    readonly adapterId: string;
    readonly version: string;
    readonly deploymentFingerprint: string;
  } | null;
  readonly inputManifestDigest: DigestRef;
  readonly artifactManifestDigest: DigestRef | null;
  readonly status: IndexGenerationStatus;
  readonly sequence: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly createdAt: Rfc3339Utc;
  readonly updatedAt: Rfc3339Utc;
}

export interface DeleteReceipt {
  readonly spaceId: SpaceId;
  readonly generationId: GenerationId;
  readonly unitId: import('./ids.js').ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly vectorDeleted: boolean;
  readonly keywordDeleted: boolean;
  readonly observedAt: Rfc3339Utc;
}

export interface GenerationValidationReceipt {
  readonly schemaVersion: '1.0';
  readonly receiptId: ReceiptId;
  readonly generationId: GenerationId;
  readonly spaceId: SpaceId;
  readonly runtimeContractVersion: '0.1';
  readonly inputManifestDigest: DigestRef;
  readonly artifactManifestDigest: DigestRef;
  readonly adapterManifestDigest: DigestRef;
  readonly expectedUnitCount: number;
  readonly vectorUnitCount: number;
  readonly keywordUnitCount: number | null;
  readonly deleteReceipts: readonly DeleteReceipt[];
  readonly probes: readonly string[];
  readonly locatorSampleCount: number;
  readonly namespaceIsolated: boolean;
  readonly deletePropagationComplete: boolean;
  readonly validatorVersion: string;
  readonly status: 'passed' | 'failed';
  readonly validatedAt: Rfc3339Utc;
  readonly validUntil: Rfc3339Utc;
}

const GENERATION_TRANSITIONS: Readonly<
  Record<IndexGenerationStatus, readonly IndexGenerationStatus[]>
> = {
  planned: ['building', 'cancelled'],
  building: ['validating', 'failed', 'cancelled'],
  validating: ['ready', 'failed', 'cancelled'],
  ready: ['active', 'retired'],
  active: ['retired'],
  retired: [],
  failed: [],
  cancelled: []
};

export function canTransitionIndexGeneration(
  from: IndexGenerationStatus,
  to: IndexGenerationStatus
): boolean {
  return from === to || GENERATION_TRANSITIONS[from].includes(to);
}
