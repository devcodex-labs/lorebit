import type { DigestRef } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type {
  CitationId,
  ContentUnitId,
  ContentUnitVersionId,
  GenerationId,
  PolicyId,
  RevisionId,
  SourceId,
  SpaceId
} from './ids.js';
import type { ContentLocator, ContentUnitVersion } from './content-unit.js';
import type { QuerySnapshot } from './activation.js';

export interface Citation {
  readonly schemaVersion: '1.0';
  readonly citationId: CitationId;
  readonly spaceId: SpaceId;
  readonly sourceId: SourceId;
  readonly revisionId: RevisionId;
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly generationId: GenerationId;
  readonly policyId: PolicyId;
  readonly locator: ContentLocator;
  readonly contentDigest: DigestRef;
  readonly visibilityDigest: DigestRef;
  readonly attestationRef: string | null;
  readonly applicableScope: string;
  readonly createdAt: Rfc3339Utc;
}

export type CitationValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'scope' | 'revision' | 'generation' | 'unit' | 'digest' | 'visibility' | 'locator' };

export function validateCitation(
  citation: Citation,
  unit: ContentUnitVersion,
  snapshot: QuerySnapshot
): CitationValidation {
  if (citation.spaceId !== snapshot.spaceId || citation.spaceId !== unit.spaceId) return { valid: false, reason: 'scope' };
  if (citation.generationId !== snapshot.generationId) return { valid: false, reason: 'generation' };
  if (citation.policyId !== snapshot.policyId) return { valid: false, reason: 'scope' };
  if (citation.revisionId !== unit.revisionId || !snapshot.revisions.some((entry) => entry.sourceId === citation.sourceId && entry.revisionId === citation.revisionId)) return { valid: false, reason: 'revision' };
  if (citation.unitId !== unit.identity.unitId || citation.unitVersionId !== unit.unitVersionId) return { valid: false, reason: 'unit' };
  if (citation.contentDigest.value !== unit.textDigest.value) return { valid: false, reason: 'digest' };
  if (citation.visibilityDigest.value !== unit.visibilityDigest.value) return { valid: false, reason: 'visibility' };
  if (JSON.stringify(citation.locator) !== JSON.stringify(unit.locator)) return { valid: false, reason: 'locator' };
  return { valid: true };
}
