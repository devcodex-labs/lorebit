import type { ExecutionOptions } from '../commands.js';
import { diagnostic, lorebitFailure, type Diagnostic } from '../../domain/diagnostics.js';
import { failed, successful, type LorebitOutcome } from '../../domain/outcomes.js';
import type { KnowledgeQueryRequest, KnowledgeResult } from '../../domain/query-plan.js';
import type { ContextEvidence, ContextExclusion, ContextPack } from '../../domain/context-pack.js';
import { validateCitation } from '../../domain/citation.js';
import { securityPolicyFromExtensions } from '../../domain/security.js';
import type { KnowledgeRepository } from '../../ports/knowledge-repository.js';
import type { TokenCounter } from '../../ports/token-counter.js';
import type { SecurityHook } from '../../ports/security-hooks.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator, OperationId } from '../../domain/ids.js';
import { digestBytes, digestCanonicalJson } from '../../wire/digest.js';
import { decodeJsonValue, type JsonValue } from '../../wire/json-value.js';
import { executeSecurityHooks } from './query-service.js';

interface ContextServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly tokenCounter?: TokenCounter;
  readonly securityHooks: readonly SecurityHook[];
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function operation(ids: IdGenerator): { readonly operationId: OperationId; readonly kind: 'query' } {
  return { operationId: ids.next('operation'), kind: 'query' };
}

function asWireValue(input: unknown): JsonValue {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) throw new TypeError(decoded.error.summary);
  return decoded.value;
}

function unitIdsFromOutput(output: JsonValue): Set<string> {
  if (typeof output !== 'object' || output === null || Array.isArray(output) || !Array.isArray(output.unitIds)) return new Set();
  return new Set(output.unitIds.filter((value): value is string => typeof value === 'string'));
}

function redactedContent(output: JsonValue, unitId: string): string | null {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null;
  const values = output.contentByUnitId;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return null;
  return typeof values[unitId] === 'string' ? values[unitId] : null;
}

function executionControlFailure<T>(
  ids: IdGenerator,
  options: ExecutionOptions,
  diagnostics: readonly Diagnostic[]
): LorebitOutcome<T> | null {
  if (options.signal?.aborted !== true) return null;
  const deadline = options.signal.reason === 'deadline-exceeded';
  return failed(
    lorebitFailure(deadline ? 'deadline-exceeded' : 'cancelled', deadline ? 'Context deadline elapsed.' : 'Context building was cancelled.'),
    operation(ids),
    diagnostics
  );
}

export class ContextService {
  readonly #repository: KnowledgeRepository;
  readonly #tokenCounter: TokenCounter | undefined;
  readonly #securityHooks: readonly SecurityHook[];
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(dependencies: ContextServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#tokenCounter = dependencies.tokenCounter;
    this.#securityHooks = dependencies.securityHooks;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async build(
    retrieved: KnowledgeResult<'retrieve'>,
    request: KnowledgeQueryRequest,
    options: ExecutionOptions = {}
  ): Promise<LorebitOutcome<KnowledgeResult<'context'>>> {
    const diagnostics: Diagnostic[] = [...retrieved.diagnostics];
    const initialControl = executionControlFailure<KnowledgeResult<'context'>>(this.#ids, options, diagnostics);
    if (initialControl !== null) return initialControl;
    const plan = retrieved.queryPlan;
    const [policy, generation, receipt, activation] = await Promise.all([
      this.#repository.getPolicy(plan.spaceId, plan.policyId),
      this.#repository.getGeneration(plan.spaceId, plan.generationId),
      this.#repository.getGenerationReceipt(plan.spaceId, plan.generationId),
      this.#repository.getActivation(plan.spaceId, plan.activationId)
    ]);
    const factsControl = executionControlFailure<KnowledgeResult<'context'>>(this.#ids, options, diagnostics);
    if (factsControl !== null) return factsControl;
    if (policy === null || generation === null || receipt === null || activation === null) {
      return failed(lorebitFailure('generation-stale', 'The frozen query plan can no longer be resolved.'), operation(this.#ids), diagnostics);
    }
    if (!['active', 'retired'].includes(generation.status) || receipt.status !== 'passed' || receipt.validUntil <= this.#clock.now()) {
      return failed(lorebitFailure(receipt.validUntil <= this.#clock.now() ? 'receipt-stale' : 'generation-stale', 'The frozen generation is no longer verified.'), operation(this.#ids), diagnostics);
    }
    const securityPolicy = securityPolicyFromExtensions(policy.extensions);
    const hook = await executeSecurityHooks(
      this.#securityHooks,
      'beforeContext',
      asWireValue({
        spaceId: plan.spaceId,
        policyId: plan.policyId,
        generationId: plan.generationId,
        queryPlanDigest: plan.digest,
        evidence: retrieved.retrieval.candidates.map((candidate) => ({
          unitId: candidate.unitId,
          unitVersionId: candidate.unitVersionId,
          content: candidate.content,
          contentDigest: candidate.citation.contentDigest,
          trust: candidate.trust
        }))
      }),
      securityPolicy.requiredHooks.includes('beforeContext'),
      this.#clock,
      options
    );
    const hookControl = executionControlFailure<KnowledgeResult<'context'>>(this.#ids, options, diagnostics);
    if (hookControl !== null) return hookControl;
    if (!hook.ok) {
      return failed(lorebitFailure(hook.code, hook.summary), operation(this.#ids), [...diagnostics, ...hook.diagnostics]);
    }
    diagnostics.push(...hook.diagnostics);
    const quarantineIds = hook.actions.includes('quarantine')
      ? (() => {
          const values = unitIdsFromOutput(hook.payload);
          return values.size === 0
            ? new Set(retrieved.retrieval.candidates.map((candidate) => candidate.unitId))
            : values;
        })()
      : new Set<string>();
    const evidence: ContextEvidence[] = [];
    const excluded: ContextExclusion[] = [];
    let usedBytes = 0;
    let usedTokens = 0;
    let tokensAvailable = this.#tokenCounter !== undefined;
    const snapshot = {
      schemaVersion: '1.0' as const,
      spaceId: plan.spaceId,
      activationId: plan.activationId,
      policyId: plan.policyId,
      generationId: plan.generationId,
      revisions: plan.revisions,
      revisionManifestDigest: activation.revisionManifestDigest,
      capturedAt: plan.createdAt
    };
    for (const candidate of retrieved.retrieval.candidates) {
      const candidateControl = executionControlFailure<KnowledgeResult<'context'>>(this.#ids, options, diagnostics);
      if (candidateControl !== null) return candidateControl;
      if (quarantineIds.has(candidate.unitId)) {
        excluded.push({ unitId: candidate.unitId, unitVersionId: candidate.unitVersionId, reason: 'security-quarantined' });
        continue;
      }
      const unit = await this.#repository.getContentUnitVersion(plan.spaceId, candidate.unitVersionId);
      if (unit === null || !validateCitation(candidate.citation, unit, snapshot).valid) {
        excluded.push({ unitId: candidate.unitId, unitVersionId: candidate.unitVersionId, reason: 'citation-invalid' });
        continue;
      }
      let content = candidate.content;
      if (hook.actions.includes('redact')) content = redactedContent(hook.payload, candidate.unitId) ?? '[REDACTED]';
      const bytes = new TextEncoder().encode(content).byteLength;
      let tokens: number | null = null;
      if (this.#tokenCounter !== undefined && tokensAvailable) {
        const counted = await this.#tokenCounter.count(content, options);
        const tokenControl = executionControlFailure<KnowledgeResult<'context'>>(this.#ids, options, diagnostics);
        if (tokenControl !== null) return tokenControl;
        if (counted.ok) tokens = counted.tokens;
        else if (counted.code === 'cancelled') {
          return failed(lorebitFailure('cancelled', 'Context token counting was cancelled.'), operation(this.#ids), diagnostics);
        } else {
          tokensAvailable = false;
          diagnostics.push(diagnostic('token-estimate-unavailable', 'warning', 'Token counting failed; byte and evidence hard caps remain enforced.'));
        }
      }
      if (evidence.length >= plan.contextBudget.maxEvidence) {
        excluded.push({ unitId: candidate.unitId, unitVersionId: candidate.unitVersionId, reason: 'budget-evidence' });
        continue;
      }
      if (usedBytes + bytes > plan.contextBudget.maxUtf8Bytes) {
        excluded.push({ unitId: candidate.unitId, unitVersionId: candidate.unitVersionId, reason: 'budget-bytes' });
        continue;
      }
      if (tokens !== null && usedTokens + tokens > plan.contextBudget.maxTokens) {
        excluded.push({ unitId: candidate.unitId, unitVersionId: candidate.unitVersionId, reason: 'budget-tokens' });
        continue;
      }
      usedBytes += bytes;
      if (tokens !== null) usedTokens += tokens;
      evidence.push({
        citation: candidate.citation,
        content,
        trust: 'untrusted-retrieved-data',
        priority: candidate.finalRank,
        utf8Bytes: bytes,
        tokens,
        conflictIds: (request.knownConflicts ?? []).filter((conflict) => conflict.unitIds.includes(candidate.unitId)).map((conflict) => conflict.conflictId)
      });
    }
    const directive = request.trustedDirective === undefined
      ? null
      : {
          source: 'caller' as const,
          content: request.trustedDirective,
          digest: await digestBytes(new TextEncoder().encode(request.trustedDirective))
        };
    const conflicts = (request.knownConflicts ?? []).map((conflict) => ({
      conflictId: conflict.conflictId,
      summary: conflict.summary,
      unitIds: conflict.unitIds
    }));
    const manifest = {
      queryPlanId: plan.queryPlanId,
      directiveDigest: directive?.digest ?? null,
      evidence: evidence.map((value) => ({ citationId: value.citation.citationId, contentDigest: value.citation.contentDigest, utf8Bytes: value.utf8Bytes, tokens: value.tokens, conflictIds: value.conflictIds })),
      excluded,
      conflicts,
      budget: plan.contextBudget,
      usage: { evidence: evidence.length, utf8Bytes: usedBytes, tokens: tokensAvailable ? usedTokens : null }
    };
    const manifestDigest = await digestCanonicalJson(manifest);
    if (!manifestDigest.ok) throw new TypeError(manifestDigest.error.summary);
    const contextPack: ContextPack = {
      schemaVersion: '1.0',
      spaceId: plan.spaceId,
      queryPlanId: plan.queryPlanId,
      trustedDirective: directive,
      evidence,
      excluded,
      conflicts,
      budget: plan.contextBudget,
      usage: { evidence: evidence.length, utf8Bytes: usedBytes, tokens: tokensAvailable ? usedTokens : null },
      provenance: {
        schemaVersion: '1.0',
        queryPlanId: plan.queryPlanId,
        admittedUnitVersionIds: evidence.map((value) => value.citation.unitVersionId),
        excluded,
        ordering: 'retrieval-final-rank',
        tokenMethod: tokensAvailable && this.#tokenCounter !== undefined
          ? `${this.#tokenCounter.capabilities.tokenizer}@${this.#tokenCounter.descriptor.version}`
          : null,
        manifestDigest: manifestDigest.value
      },
      createdAt: this.#clock.now()
    };
    const citations = evidence.map((value) => value.citation);
    const status = evidence.length === 0
      ? policy.defaultResult.emptyResult
      : evidence.length < policy.evidence.minimumCitations ? 'insufficient-evidence' as const
      : excluded.length > 0 ? 'partial' as const : 'complete' as const;
    if (status === 'insufficient-evidence' && policy.evidence.onInsufficientEvidence === 'reject') {
      return failed(lorebitFailure('insufficient-evidence', 'Context does not meet the active evidence policy.'), operation(this.#ids), diagnostics);
    }
    const resultId = this.#ids.next('result');
    const result: KnowledgeResult<'context'> = {
      schemaVersion: '1.0',
      resultId,
      mode: 'context',
      status,
      retrieval: retrieved.retrieval,
      context: contextPack,
      generation: null,
      citations,
      guarantees: [...retrieved.guarantees, 'structured-trust-partition', 'deterministic-context-provenance', 'context-budget-enforced'],
      limitations: [
        ...retrieved.limitations,
        ...(tokensAvailable ? [] : ['token estimate unavailable; byte/evidence caps enforced']),
        ...(excluded.length > 0 ? ['some evidence was excluded by security or budget policy'] : [])
      ],
      diagnostics,
      queryPlan: plan,
      provenance: {
        ...retrieved.provenance,
        resultId,
        includedUnitVersionIds: evidence.map((value) => value.citation.unitVersionId),
        excluded: [
          ...retrieved.provenance.excluded,
          ...excluded.map((value) => ({ unitVersionId: value.unitVersionId, reason: value.reason }))
        ],
        citationDigests: await Promise.all(citations.map(async (citation) => {
          const digest = await digestCanonicalJson(citation);
          if (!digest.ok) throw new TypeError(digest.error.summary);
          return digest.value;
        })),
        contextManifestDigest: manifestDigest.value,
        securityHooks: [...retrieved.provenance.securityHooks, ...hook.records],
        createdAt: this.#clock.now()
      }
    };
    return successful(result, operation(this.#ids), diagnostics);
  }
}
