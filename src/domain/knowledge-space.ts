import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { PolicyId, SpaceId } from './ids.js';

export type KnowledgeSpaceStatus = 'open' | 'frozen' | 'archived';

export interface QuestionScope {
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
}

export interface AdmissionPolicy {
  readonly allowedSourceKinds: readonly string[];
  readonly requiredMetadata: readonly string[];
}

export interface EvidencePolicy {
  readonly minimumCitations: number;
  readonly allowedEvidenceKinds: readonly string[];
  readonly onInsufficientEvidence: 'empty' | 'partial' | 'reject';
}

export interface DefaultResultPolicy {
  readonly allowPartial: boolean;
  readonly allowHistorical: boolean;
  readonly emptyResult: 'empty' | 'insufficient-evidence';
}

export interface AccessPolicy {
  readonly requiredLabels: readonly string[];
  readonly excludedLabels: readonly string[];
  readonly failClosed: true;
}

export interface ExposurePolicy {
  readonly hiddenFields: readonly string[];
  readonly hiddenContentLabels: readonly string[];
}

export interface RetentionPolicy {
  readonly auditDays: number;
  readonly contentDays: number | null;
  readonly tombstoneOnExpiry: boolean;
}

export interface PolicySnapshot {
  readonly schemaVersion: '1.0';
  readonly policyId: PolicyId;
  readonly spaceId: SpaceId;
  readonly predecessorPolicyId: PolicyId | null;
  readonly sequence: number;
  readonly changeKind: 'query-only' | 'access-projection' | 'index-affecting';
  readonly questionScope: QuestionScope;
  readonly admission: AdmissionPolicy;
  readonly evidence: EvidencePolicy;
  readonly defaultResult: DefaultResultPolicy;
  readonly access: AccessPolicy;
  readonly exposure: ExposurePolicy;
  readonly retention: RetentionPolicy;
  readonly extensions: JsonValue;
  readonly fingerprint: DigestRef;
  readonly createdAt: Rfc3339Utc;
  readonly actorRef: string;
  readonly reason: string;
  readonly validFrom: Rfc3339Utc;
  readonly validUntil: Rfc3339Utc | null;
}

export interface KnowledgeSpace {
  readonly schemaVersion: '1.0';
  readonly spaceId: SpaceId;
  readonly name: string;
  readonly description: string;
  readonly status: KnowledgeSpaceStatus;
  readonly sequence: number;
  readonly currentPolicyId: PolicyId;
  readonly metadata: JsonValue;
  readonly createdAt: Rfc3339Utc;
  readonly updatedAt: Rfc3339Utc;
}

export interface SpaceReadiness {
  readonly state: 'not-ready' | 'ready' | 'limited';
  readonly guarantees: readonly string[];
  readonly limitations: readonly string[];
  readonly missing: readonly string[];
}

const SPACE_TRANSITIONS: Readonly<
  Record<KnowledgeSpaceStatus, readonly KnowledgeSpaceStatus[]>
> = {
  open: ['frozen', 'archived'],
  frozen: ['open', 'archived'],
  archived: []
};

export function canTransitionKnowledgeSpace(
  from: KnowledgeSpaceStatus,
  to: KnowledgeSpaceStatus
): boolean {
  return from === to || SPACE_TRANSITIONS[from].includes(to);
}
