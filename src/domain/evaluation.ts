import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { ActivationId, EvaluationId, GenerationId, PolicyId, RecipeId, RevisionId, SpaceId } from './ids.js';

export interface EvaluationVersionRefs {
  readonly policyId: PolicyId;
  readonly activationId: ActivationId | null;
  readonly recipeId: RecipeId | null;
  readonly generationId: GenerationId | null;
  readonly revisionIds: readonly RevisionId[];
}

export interface EvaluationCase {
  readonly caseId: string;
  readonly spaceId: SpaceId;
  readonly question: string;
  readonly expectedScope: string;
  readonly expectedSourceIds: readonly string[];
  readonly expectedCitationIds: readonly string[];
  readonly constraints: JsonValue;
  readonly versionRefs: EvaluationVersionRefs;
  readonly fixtureDigest: DigestRef;
}

export interface ClaimEvaluation {
  readonly claimId: string;
  readonly claim: string;
  readonly citationIds: readonly string[];
  readonly support: 'supported' | 'conflicted' | 'unsupported' | 'uncovered';
  readonly faithfulness: number | null;
  readonly conflictScore: number | null;
  readonly uncertainty: number;
  readonly method: string;
  readonly evaluator: string;
  readonly model: string | null;
  readonly version: string;
  readonly limitations: readonly string[];
}

export interface EvaluationRun {
  readonly schemaVersion: '1.0';
  readonly evaluationId: EvaluationId;
  readonly suiteId: string;
  readonly targetRef: string;
  readonly method: string;
  readonly evaluator: string;
  readonly model: string | null;
  readonly version: string;
  readonly deterministic: boolean;
  readonly cases: readonly {
    readonly caseId: string;
    readonly fixtureDigest: DigestRef;
    readonly versionRefs: EvaluationVersionRefs;
    readonly versionMatch: boolean;
    readonly retrievalRecall: number | null;
    readonly citationCompleteness: number | null;
    readonly contextCompliance: number | null;
    readonly generationConstraintPass: boolean | null;
    readonly claims: readonly ClaimEvaluation[];
    readonly uncovered: readonly string[];
  }[];
  readonly aggregate: Readonly<Record<string, number | null>>;
  readonly uncertainty: number;
  readonly startedAt: Rfc3339Utc;
  readonly completedAt: Rfc3339Utc;
}

export interface EvaluationFeedback {
  readonly feedbackId: string;
  readonly caseId: string;
  readonly kind: 'human' | 'business' | 'automated';
  readonly rating: number | null;
  readonly labels: readonly string[];
  readonly comment: string;
  readonly actorRef: string;
  readonly createdAt: Rfc3339Utc;
}

export interface EvaluationComparison {
  readonly baselineId: EvaluationId;
  readonly candidateId: EvaluationId;
  readonly deltas: Readonly<Record<string, number | null>>;
  readonly regressions: readonly string[];
  readonly improvements: readonly string[];
}

export interface QualityGate {
  readonly gateId: string;
  readonly minimums: Readonly<Record<string, number>>;
  readonly maximumRegression: number;
  readonly requireNoUncoveredClaims: boolean;
}

export interface QualityGateResult {
  readonly gateId: string;
  readonly evaluationId: EvaluationId;
  readonly status: 'passed' | 'failed';
  readonly failures: readonly string[];
  readonly evidenceDigest: DigestRef;
}
