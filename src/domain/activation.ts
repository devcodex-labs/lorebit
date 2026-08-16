import type { DigestRef } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ActivationId,
  GenerationId,
  PolicyId,
  RevisionId,
  SourceId,
  SpaceId
} from './ids.js';

export interface QuerySnapshot {
  readonly schemaVersion: '1.0';
  readonly spaceId: SpaceId;
  readonly activationId: ActivationId;
  readonly policyId: PolicyId;
  readonly generationId: GenerationId;
  readonly revisions: readonly {
    readonly sourceId: SourceId;
    readonly revisionId: RevisionId;
  }[];
  readonly revisionManifestDigest: DigestRef;
  readonly capturedAt: Rfc3339Utc;
}
