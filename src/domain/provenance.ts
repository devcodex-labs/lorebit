import type { DigestRef } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ContentUnitVersionId,
  GenerationId,
  PolicyId,
  RecipeId,
  ResultId,
  RevisionId,
  RunId,
  SourceId,
  SpaceId
} from './ids.js';
import type { RetrievalRoute } from './query-plan.js';
import type { DataEgressDecision, SecurityHookRecord } from './security.js';

export interface ProvenanceRevisionRef {
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
}

export interface ResultProvenance {
  readonly schemaVersion: '1.0';
  readonly resultId: ResultId;
  readonly spaceId: SpaceId;
  readonly queryDigest: DigestRef;
  readonly accessContextDigest: DigestRef;
  readonly policyId: PolicyId;
  readonly revisions: readonly ProvenanceRevisionRef[];
  readonly recipeId: RecipeId;
  readonly generationId: GenerationId;
  readonly runIds: readonly RunId[];
  readonly modelRefs: readonly string[];
  readonly queryPlanDigest: DigestRef;
  readonly retrievalRoute: RetrievalRoute;
  readonly filterDigest: DigestRef;
  readonly includedUnitVersionIds: readonly ContentUnitVersionId[];
  readonly excluded: readonly {
    readonly unitVersionId: ContentUnitVersionId | null;
    readonly reason: string;
  }[];
  readonly citationDigests: readonly DigestRef[];
  readonly contextManifestDigest: DigestRef | null;
  readonly securityHooks: readonly SecurityHookRecord[];
  readonly egressDecisions: readonly DataEgressDecision[];
  readonly createdAt: Rfc3339Utc;
}
