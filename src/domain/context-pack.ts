import type { DigestRef } from '../wire/digest.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { ContentUnitId, ContentUnitVersionId, QueryPlanId, SpaceId } from './ids.js';
import type { Citation } from './citation.js';
import type { ContextBudget } from './query-plan.js';

export interface ContextEvidence {
  readonly citation: Citation;
  readonly content: string;
  readonly trust: 'untrusted-retrieved-data';
  readonly priority: number;
  readonly utf8Bytes: number;
  readonly tokens: number | null;
  readonly conflictIds: readonly string[];
}

export interface ContextExclusion {
  readonly unitId: ContentUnitId;
  readonly unitVersionId: ContentUnitVersionId;
  readonly reason: 'budget-evidence' | 'budget-bytes' | 'budget-tokens' | 'citation-invalid' | 'security-quarantined' | 'security-blocked';
}

export interface ContextProvenance {
  readonly schemaVersion: '1.0';
  readonly queryPlanId: QueryPlanId;
  readonly admittedUnitVersionIds: readonly ContentUnitVersionId[];
  readonly excluded: readonly ContextExclusion[];
  readonly ordering: 'retrieval-final-rank';
  readonly tokenMethod: string | null;
  readonly manifestDigest: DigestRef;
}

export interface ContextPack {
  readonly schemaVersion: '1.0';
  readonly spaceId: SpaceId;
  readonly queryPlanId: QueryPlanId;
  readonly trustedDirective: {
    readonly source: 'caller';
    readonly content: string;
    readonly digest: DigestRef;
  } | null;
  readonly evidence: readonly ContextEvidence[];
  readonly excluded: readonly ContextExclusion[];
  readonly conflicts: readonly { readonly conflictId: string; readonly summary: string; readonly unitIds: readonly ContentUnitId[] }[];
  readonly budget: ContextBudget;
  readonly usage: { readonly evidence: number; readonly utf8Bytes: number; readonly tokens: number | null };
  readonly provenance: ContextProvenance;
  readonly createdAt: Rfc3339Utc;
}
