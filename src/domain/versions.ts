import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  ActivationId,
  DecisionId,
  GenerationId,
  PolicyId,
  RecipeId,
  RevisionId,
  SourceId,
  SpaceId
} from './ids.js';
import type { SourceLocator, SourceSnapshotRef } from './source.js';

export type RevisionStatus =
  | 'draft'
  | 'processing'
  | 'partial'
  | 'active'
  | 'failed'
  | 'superseded'
  | 'withdrawn'
  | 'archived';

export type DecisionStatus = 'pending' | 'approved' | 'rejected';

export interface ChangeSet {
  readonly kind:
    | 'content'
    | 'source-metadata'
    | 'locator'
    | 'policy'
    | 'access-projection'
    | 'recipe';
  readonly summary: string;
  readonly changes: JsonValue;
  readonly digest: DigestRef;
}

export type ChangeSetInput = Omit<ChangeSet, 'digest'>;

export interface SourceRevision {
  readonly schemaVersion: '1.0';
  readonly revisionId: RevisionId;
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly sequence: number;
  readonly predecessorRevisionId: RevisionId | null;
  readonly derivedFromRevisionIds: readonly RevisionId[];
  readonly replacesRevisionId: RevisionId | null;
  readonly snapshot: SourceSnapshotRef;
  readonly locator: SourceLocator;
  readonly changeSet: ChangeSet;
  readonly metadata: JsonValue;
  readonly metadataDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
  readonly actorRef: string;
  readonly reason: string;
  readonly effectiveFrom: Rfc3339Utc;
  readonly effectiveUntil: Rfc3339Utc | null;
}

export interface RevisionState {
  readonly revisionId: RevisionId;
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly status: RevisionStatus;
  readonly sequence: number;
  readonly changedAt: Rfc3339Utc;
  readonly actorRef: string;
  readonly reason: string;
}

export interface RevisionView {
  readonly revision: SourceRevision;
  readonly state: RevisionState;
}

export interface RevisionLabel {
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly label: string;
  readonly revisionId: RevisionId;
  readonly sequence: number;
  readonly changedAt: Rfc3339Utc;
  readonly actorRef: string;
  readonly reason: string;
}

export interface RevisionDecision {
  readonly decisionId: DecisionId;
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly status: DecisionStatus;
  readonly reason: string;
  readonly actorRef: string;
  readonly decidedAt: Rfc3339Utc;
}

export interface ProcessingRecipeVersion {
  readonly schemaVersion: '1.0';
  readonly recipeId: RecipeId;
  readonly spaceId: SpaceId;
  readonly predecessorRecipeId: RecipeId | null;
  readonly sequence: number;
  readonly fingerprint: DigestRef;
  readonly configuration: JsonValue;
  readonly compatibility: readonly string[];
  readonly createdAt: Rfc3339Utc;
  readonly actorRef: string;
  readonly reason: string;
  readonly deprecatedAt: Rfc3339Utc | null;
}

export interface IndexGenerationReference {
  readonly generationId: GenerationId;
  readonly inputManifestDigest: DigestRef;
  readonly recipeId: RecipeId;
}

export interface KnowledgeActivation {
  readonly schemaVersion: '1.0';
  readonly activationId: ActivationId;
  readonly spaceId: SpaceId;
  readonly predecessorActivationId: ActivationId | null;
  readonly policyId: PolicyId;
  readonly generation: IndexGenerationReference;
  readonly revisions: readonly {
    readonly sourceId: SourceId;
    readonly revisionId: RevisionId;
  }[];
  readonly revisionManifestDigest: DigestRef;
  readonly createdAt: Rfc3339Utc;
  readonly actorRef: string;
  readonly reason: string;
}

export type RevisionSelector =
  | { readonly kind: 'active' }
  | { readonly kind: 'revision'; readonly revisionId: RevisionId }
  | { readonly kind: 'label'; readonly label: string }
  | { readonly kind: 'as-of'; readonly at: Rfc3339Utc };

const REVISION_TRANSITIONS: Readonly<
  Record<RevisionStatus, readonly RevisionStatus[]>
> = {
  draft: ['processing', 'withdrawn', 'archived'],
  processing: ['partial', 'active', 'failed', 'withdrawn'],
  partial: ['processing', 'active', 'superseded', 'withdrawn', 'archived'],
  active: ['superseded', 'withdrawn', 'archived'],
  failed: ['processing', 'withdrawn', 'archived'],
  superseded: ['withdrawn', 'archived'],
  withdrawn: ['archived'],
  archived: []
};

export function canTransitionRevision(
  from: RevisionStatus,
  to: RevisionStatus
): boolean {
  return from === to || REVISION_TRANSITIONS[from].includes(to);
}
