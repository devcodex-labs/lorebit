import type {
  ClaimEvaluation,
  EvaluationCase,
  EvaluationComparison,
  EvaluationFeedback,
  EvaluationRun,
  EvaluationVersionRefs,
  QualityGate,
  QualityGateResult
} from '../domain/evaluation.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../domain/ids.js';
import { digestCanonicalJson } from '../wire/digest.js';

export type EvaluationCaseDefinition = Omit<EvaluationCase, 'fixtureDigest'>;

export async function digestEvaluationCase(input: EvaluationCaseDefinition) {
  const digest = await digestCanonicalJson(input);
  if (!digest.ok) throw new TypeError(digest.error.summary);
  return digest.value;
}

export interface ClaimEvaluatorInput {
  readonly claimId: string;
  readonly claim: string;
  readonly citationIds: readonly string[];
  readonly evidence: readonly { readonly citationId: string; readonly content: string }[];
}

export interface ClaimEvaluator {
  readonly method: string;
  readonly evaluator: string;
  readonly model: string | null;
  readonly version: string;
  readonly deterministic: boolean;
  evaluate(input: ClaimEvaluatorInput): Promise<Omit<ClaimEvaluation, 'claimId' | 'claim' | 'citationIds' | 'method' | 'evaluator' | 'model' | 'version'>>;
}

export interface EvaluationRunInput {
  readonly suiteId: string;
  readonly targetRef: string;
  readonly cases: readonly EvaluationCase[];
  readonly observations: readonly {
    readonly caseId: string;
    readonly retrievedSourceIds: readonly string[];
    readonly citationIds: readonly string[];
    readonly contextCompliant: boolean;
    readonly generationConstraintPass: boolean | null;
    readonly versionRefs: EvaluationVersionRefs;
    readonly claims: readonly Omit<ClaimEvaluatorInput, 'evidence'>[];
    readonly evidence: ClaimEvaluatorInput['evidence'];
  }[];
}

export interface EvaluationModule {
  evaluate(input: EvaluationRunInput): Promise<EvaluationRun>;
  compare(baseline: EvaluationRun, candidate: EvaluationRun): EvaluationComparison;
  applyGate(run: EvaluationRun, gate: QualityGate, comparison?: EvaluationComparison): Promise<QualityGateResult>;
  recordFeedback(feedback: EvaluationFeedback): void;
  listFeedback(caseId?: string): readonly EvaluationFeedback[];
  close(): void;
}

function ratio(expected: readonly string[], actual: readonly string[]): number | null {
  if (expected.length === 0) return null;
  const found = expected.filter((value) => actual.includes(value)).length;
  return found / expected.length;
}

function average(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0) / present.length;
}

export function createEvaluationModule(dependencies: { readonly evaluator?: ClaimEvaluator; readonly clock: Clock; readonly ids: IdGenerator }): EvaluationModule {
  let closed = false;
  const feedback: EvaluationFeedback[] = [];
  return {
    async evaluate(input) {
      if (closed) throw new Error('Evaluation module is closed.');
      if (!input.suiteId.trim() || !input.targetRef.trim() || new Set(input.cases.map((value) => value.caseId)).size !== input.cases.length) {
        throw new TypeError('Evaluation suite, target and case identities must be non-empty and unique.');
      }
      if (new Set(input.observations.map((value) => value.caseId)).size !== input.observations.length || input.observations.some((value) => !input.cases.some((fixture) => fixture.caseId === value.caseId))) {
        throw new TypeError('Evaluation observations must have unique identities and belong to the declared suite.');
      }
      for (const fixture of input.cases) {
        if (
          !fixture.caseId.trim() ||
          !fixture.question.trim() ||
          !fixture.expectedScope.trim() ||
          new Set(fixture.expectedSourceIds).size !== fixture.expectedSourceIds.length ||
          new Set(fixture.expectedCitationIds).size !== fixture.expectedCitationIds.length ||
          new Set(fixture.versionRefs.revisionIds).size !== fixture.versionRefs.revisionIds.length
        ) throw new TypeError('Evaluation case identities, expectations or version references are invalid.');
        const actualDigest = await digestEvaluationCase({
          caseId: fixture.caseId,
          spaceId: fixture.spaceId,
          question: fixture.question,
          expectedScope: fixture.expectedScope,
          expectedSourceIds: fixture.expectedSourceIds,
          expectedCitationIds: fixture.expectedCitationIds,
          constraints: fixture.constraints,
          versionRefs: fixture.versionRefs
        });
        if (actualDigest.value !== fixture.fixtureDigest.value || actualDigest.algorithm !== fixture.fixtureDigest.algorithm) throw new TypeError('Evaluation case fixture digest mismatch.');
      }
      const startedAt = dependencies.clock.now();
      const cases = [];
      for (const fixture of input.cases) {
        const observation = input.observations.find((value) => value.caseId === fixture.caseId);
        if (observation === undefined) {
          cases.push({ caseId: fixture.caseId, fixtureDigest: fixture.fixtureDigest, versionRefs: fixture.versionRefs, versionMatch: false, retrievalRecall: null, citationCompleteness: null, contextCompliance: null, generationConstraintPass: null, claims: [], uncovered: ['case-not-observed'] });
          continue;
        }
        const versionMatch = JSON.stringify(observation.versionRefs) === JSON.stringify(fixture.versionRefs);
        if (new Set(observation.claims.map((value) => value.claimId)).size !== observation.claims.length || new Set(observation.evidence.map((value) => value.citationId)).size !== observation.evidence.length) {
          throw new TypeError('Evaluation claim and evidence identities must be unique within a case.');
        }
        const claims: ClaimEvaluation[] = [];
        for (const claim of observation.claims) {
          const evidenceIds = new Set(observation.evidence.map((value) => value.citationId));
          if (claim.citationIds.some((citationId) => !evidenceIds.has(citationId))) {
            claims.push({ claimId: claim.claimId, claim: claim.claim, citationIds: claim.citationIds, support: 'uncovered', faithfulness: null, conflictScore: null, uncertainty: 1, method: dependencies.evaluator?.method ?? 'deterministic-core-only', evaluator: dependencies.evaluator?.evaluator ?? 'none', model: dependencies.evaluator?.model ?? null, version: dependencies.evaluator?.version ?? '1.0', limitations: ['claim references evidence absent from the pinned evaluation observation'] });
          } else if (!versionMatch) {
            claims.push({ claimId: claim.claimId, claim: claim.claim, citationIds: claim.citationIds, support: 'uncovered', faithfulness: null, conflictScore: null, uncertainty: 1, method: dependencies.evaluator?.method ?? 'deterministic-core-only', evaluator: dependencies.evaluator?.evaluator ?? 'none', model: dependencies.evaluator?.model ?? null, version: dependencies.evaluator?.version ?? '1.0', limitations: ['observation version references do not match the pinned evaluation case'] });
          } else if (dependencies.evaluator === undefined) {
            claims.push({ claimId: claim.claimId, claim: claim.claim, citationIds: claim.citationIds, support: 'uncovered', faithfulness: null, conflictScore: null, uncertainty: 1, method: 'disabled', evaluator: 'none', model: null, version: '0', limitations: ['optional claim evaluator disabled; provenance does not prove the claim'] });
          } else {
            try {
              const result = await dependencies.evaluator.evaluate({ ...claim, evidence: observation.evidence });
              claims.push({ ...claim, ...result, method: dependencies.evaluator.method, evaluator: dependencies.evaluator.evaluator, model: dependencies.evaluator.model, version: dependencies.evaluator.version, limitations: [...result.limitations, 'probabilistic evaluation does not turn provenance into factual proof'] });
            } catch {
              claims.push({ ...claim, support: 'uncovered', faithfulness: null, conflictScore: null, uncertainty: 1, method: dependencies.evaluator.method, evaluator: dependencies.evaluator.evaluator, model: dependencies.evaluator.model, version: dependencies.evaluator.version, limitations: ['claim evaluator failed with provider details redacted', 'provenance does not prove the claim'] });
            }
          }
        }
        cases.push({
          caseId: fixture.caseId,
          fixtureDigest: fixture.fixtureDigest,
          versionRefs: fixture.versionRefs,
          versionMatch,
          retrievalRecall: versionMatch ? ratio(fixture.expectedSourceIds, observation.retrievedSourceIds) : null,
          citationCompleteness: versionMatch ? ratio(fixture.expectedCitationIds, observation.citationIds) : null,
          contextCompliance: versionMatch ? (observation.contextCompliant ? 1 : 0) : null,
          generationConstraintPass: versionMatch ? observation.generationConstraintPass : null,
          claims,
          uncovered: [
            ...(!versionMatch ? ['version-mismatch'] : []),
            ...claims.filter((claim) => claim.support === 'uncovered' || claim.support === 'unsupported').map((claim) => claim.claimId)
          ]
        });
      }
      const uncertainty = average(cases.flatMap((value) => value.claims.map((claim) => claim.uncertainty))) ?? 1;
      return {
        schemaVersion: '1.0', evaluationId: dependencies.ids.next('evaluation'), suiteId: input.suiteId, targetRef: input.targetRef,
        method: dependencies.evaluator?.method ?? 'deterministic-core-only', evaluator: dependencies.evaluator?.evaluator ?? 'none', model: dependencies.evaluator?.model ?? null, version: dependencies.evaluator?.version ?? '1.0', deterministic: dependencies.evaluator?.deterministic ?? true,
        cases,
        aggregate: {
          retrievalRecall: average(cases.map((value) => value.retrievalRecall)),
          citationCompleteness: average(cases.map((value) => value.citationCompleteness)),
          contextCompliance: average(cases.map((value) => value.contextCompliance)),
          versionCompliance: cases.length === 0 ? null : cases.filter((value) => value.versionMatch).length / cases.length,
          claimFaithfulness: average(cases.flatMap((value) => value.claims.map((claim) => claim.faithfulness)))
        },
        uncertainty,
        startedAt,
        completedAt: dependencies.clock.now()
      };
    },
    compare(baseline, candidate) {
      if (baseline.suiteId !== candidate.suiteId) throw new TypeError('Evaluation comparisons require the same suite identity.');
      const baselineFixtures = baseline.cases.map((value) => `${value.caseId}:${value.fixtureDigest.value}`).sort();
      const candidateFixtures = candidate.cases.map((value) => `${value.caseId}:${value.fixtureDigest.value}`).sort();
      if (JSON.stringify(baselineFixtures) !== JSON.stringify(candidateFixtures)) throw new TypeError('Evaluation comparisons require identical pinned case fixtures.');
      const deltas: Record<string, number | null> = {};
      const regressions: string[] = [];
      const improvements: string[] = [];
      for (const key of new Set([...Object.keys(baseline.aggregate), ...Object.keys(candidate.aggregate)])) {
        const left = baseline.aggregate[key] ?? null;
        const right = candidate.aggregate[key] ?? null;
        const delta = left === null || right === null ? null : right - left;
        deltas[key] = delta;
        if (delta !== null && delta < 0) regressions.push(key);
        if (delta !== null && delta > 0) improvements.push(key);
      }
      return { baselineId: baseline.evaluationId, candidateId: candidate.evaluationId, deltas, regressions, improvements };
    },
    async applyGate(run, gate, comparison) {
      if (!gate.gateId.trim() || !Number.isFinite(gate.maximumRegression) || gate.maximumRegression < 0 || gate.maximumRegression > 1 || Object.values(gate.minimums).some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new TypeError('Quality gate thresholds must be finite ratios from zero to one.');
      }
      const failures: string[] = [];
      if (comparison !== undefined && comparison.candidateId !== run.evaluationId) throw new TypeError('Quality gate comparison does not target this evaluation run.');
      for (const [metric, minimum] of Object.entries(gate.minimums)) {
        const actual = run.aggregate[metric] ?? null;
        if (actual === null || actual < minimum) failures.push(`${metric}<${minimum}`);
      }
      if (gate.requireNoUncoveredClaims && run.cases.some((value) => value.uncovered.length > 0)) failures.push('uncovered-claims');
      if (comparison !== undefined) {
        for (const [metric, delta] of Object.entries(comparison.deltas)) {
          if (delta !== null && delta < -gate.maximumRegression) failures.push(`${metric}:regression>${gate.maximumRegression}`);
        }
      }
      const digest = await digestCanonicalJson({ gateId: gate.gateId, evaluationId: run.evaluationId, comparisonId: comparison?.baselineId ?? null, failures });
      if (!digest.ok) throw new TypeError(digest.error.summary);
      return { gateId: gate.gateId, evaluationId: run.evaluationId, status: failures.length === 0 ? 'passed' : 'failed', failures, evidenceDigest: digest.value };
    },
    recordFeedback(value) {
      if (closed) throw new Error('Evaluation module is closed.');
      if (!value.feedbackId.trim() || !value.caseId.trim() || (value.rating !== null && (!Number.isFinite(value.rating) || value.rating < 0 || value.rating > 5))) throw new TypeError('Evaluation feedback identity or rating is invalid.');
      if (feedback.some((entry) => entry.feedbackId === value.feedbackId)) throw new TypeError('Evaluation feedback identity is already recorded.');
      feedback.push(structuredClone(value));
    },
    listFeedback(caseId) { return feedback.filter((value) => caseId === undefined || value.caseId === caseId).map((value) => structuredClone(value)); },
    close() { closed = true; }
  };
}
