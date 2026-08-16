import type { ExecutionOptions } from '../commands.js';
import { diagnostic, lorebitFailure, type Diagnostic, type LorebitFailureCode } from '../../domain/diagnostics.js';
import { failed, successful, type LorebitOutcome } from '../../domain/outcomes.js';
import {
  compileFilterExpression,
  DEFAULT_QUERY_FILTER_SCHEMA,
  matchesFilterExpression,
  type FilterExpression,
  type FilterFieldDefinition,
  type FilterSchema
} from '../../domain/filter.js';
import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudget,
  type KnowledgeQueryRequest,
  type KnowledgeResult,
  type QueryPlanSnapshot,
  type RetrievalCandidate,
  type RetrievalResult,
  type RetrievalRoute
} from '../../domain/query-plan.js';
import { validateCitation, type Citation } from '../../domain/citation.js';
import {
  decideDataEgress,
  redactDiagnosticText,
  securityPolicyFromExtensions,
  type DataEgressDecision,
  type SecurityHookPoint,
  type SecurityHookRecord,
  type SecurityPolicy
} from '../../domain/security.js';
import type { Clock } from '../../ports/clock.js';
import type { ContentStore } from '../../ports/content-store.js';
import type { EmbeddingModel } from '../../ports/embedding-model.js';
import type { KeywordCandidate, KeywordIndex } from '../../ports/keyword-index.js';
import type { KnowledgeRepository } from '../../ports/knowledge-repository.js';
import type { Reranker } from '../../ports/reranker.js';
import type { SecurityHook } from '../../ports/security-hooks.js';
import type { VectorCandidate, VectorIndex } from '../../ports/vector-index.js';
import type { IdGenerator, OperationId } from '../../domain/ids.js';
import type { ContentUnitVersion } from '../../domain/content-unit.js';
import type { PolicySnapshot } from '../../domain/knowledge-space.js';
import type { QuerySnapshot } from '../../domain/activation.js';
import type { JsonValue } from '../../wire/json-value.js';
import { decodeJsonValue } from '../../wire/json-value.js';
import { decodeDigestRef, digestBytes, digestCanonicalJson } from '../../wire/digest.js';

interface QueryServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly contentStore: ContentStore;
  readonly embeddingModel: EmbeddingModel;
  readonly vectorIndex: VectorIndex;
  readonly keywordIndex?: KeywordIndex;
  readonly reranker?: Reranker;
  readonly securityHooks: readonly SecurityHook[];
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface SecurityExecutionSuccess {
  readonly ok: true;
  readonly payload: JsonValue;
  readonly records: readonly SecurityHookRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly actions: readonly SecurityHookRecord['action'][];
}

export type SecurityExecutionResult = SecurityExecutionSuccess | {
  readonly ok: false;
  readonly code: 'query-blocked' | 'security-hook-failed' | 'cancelled';
  readonly summary: string;
  readonly records: readonly SecurityHookRecord[];
  readonly diagnostics: readonly Diagnostic[];
};

function asWireValue(input: unknown): JsonValue {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) throw new TypeError(decoded.error.summary);
  return decoded.value;
}

export async function executeSecurityHooks(
  hooks: readonly SecurityHook[],
  point: SecurityHookPoint,
  payload: JsonValue,
  required: boolean,
  clock: Clock,
  options: ExecutionOptions = {}
): Promise<SecurityExecutionResult> {
  const applicable = hooks.filter((hook) => hook.capabilities.points.includes(point));
  if (required && applicable.length === 0) {
    return {
      ok: false,
      code: 'security-hook-failed',
      summary: `Required ${point} hook is not configured.`,
      records: [],
      diagnostics: []
    };
  }
  let current = payload;
  const records: SecurityHookRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const actions: SecurityHookRecord['action'][] = [];
  for (const hook of applicable) {
    const inputDigest = await digestCanonicalJson(current);
    if (!inputDigest.ok) throw new TypeError(inputDigest.error.summary);
    let result;
    try {
      result = await hook.execute({ point, inputDigest: inputDigest.value, payload: current }, options);
    } catch {
      result = { ok: false as const, code: 'hook-failure' as const, summary: 'Security hook threw an exception.', retryable: false };
    }
    if (!result.ok) {
      if (required || result.code === 'cancelled') {
        return {
          ok: false,
          code: result.code === 'cancelled' ? 'cancelled' : 'security-hook-failed',
          summary: result.code === 'cancelled' ? 'Security hook was cancelled.' : `Required ${point} hook failed.`,
          records,
          diagnostics
        };
      }
      diagnostics.push(diagnostic(
        'optional-security-hook-failed',
        'warning',
        `An optional ${point} hook failed; its provider cause was redacted.`,
        { details: { cause: redactDiagnosticText(result.summary), hookId: hook.descriptor.hookId } }
      ));
      continue;
    }
    if (!hook.capabilities.actions.includes(result.action)) {
      return { ok: false, code: 'security-hook-failed', summary: `${point} hook returned an undeclared action.`, records, diagnostics };
    }
    const outputDigest = await digestCanonicalJson(result.output);
    if (!outputDigest.ok) {
      return { ok: false, code: 'security-hook-failed', summary: `${point} hook returned invalid wire output.`, records, diagnostics };
    }
    const record: SecurityHookRecord = {
      hookId: hook.descriptor.hookId,
      version: hook.descriptor.version,
      method: hook.descriptor.method,
      point,
      action: result.action,
      reason: result.reason.slice(0, 256),
      evidenceRef: result.evidenceRef,
      inputDigest: inputDigest.value,
      outputDigest: outputDigest.value,
      observedAt: clock.now()
    };
    records.push(record);
    actions.push(result.action);
    current = result.output;
    if (result.action === 'block') {
      return { ok: false, code: 'query-blocked', summary: `${point} security policy blocked the operation.`, records, diagnostics };
    }
  }
  return { ok: true, payload: current, records, diagnostics, actions };
}

function operation(ids: IdGenerator): { readonly operationId: OperationId; readonly kind: 'query' } {
  return { operationId: ids.next('operation'), kind: 'query' };
}

function normalizeQuery(query: string): string {
  return query.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function queryFailure<T>(
  ids: IdGenerator,
  code: LorebitFailureCode,
  summary: string,
  diagnostics: readonly Diagnostic[] = []
): LorebitOutcome<T> {
  return failed(lorebitFailure(code, summary), operation(ids), diagnostics);
}

function executionControlFailure<T>(
  ids: IdGenerator,
  options: ExecutionOptions,
  diagnostics: readonly Diagnostic[] = []
): LorebitOutcome<T> | null {
  if (options.signal?.aborted !== true) return null;
  const deadline = options.signal.reason === 'deadline-exceeded';
  return queryFailure(
    ids,
    deadline ? 'deadline-exceeded' : 'cancelled',
    deadline ? 'Query deadline elapsed.' : 'Query was cancelled.',
    diagnostics
  );
}

function contextBudget(input: Partial<ContextBudget> | undefined): ContextBudget | null {
  const value = {
    maxEvidence: input?.maxEvidence ?? DEFAULT_CONTEXT_BUDGET.maxEvidence,
    maxUtf8Bytes: input?.maxUtf8Bytes ?? DEFAULT_CONTEXT_BUDGET.maxUtf8Bytes,
    maxTokens: input?.maxTokens ?? DEFAULT_CONTEXT_BUDGET.maxTokens
  };
  return Number.isSafeInteger(value.maxEvidence) && value.maxEvidence > 0 && value.maxEvidence <= DEFAULT_CONTEXT_BUDGET.maxEvidence &&
    Number.isSafeInteger(value.maxUtf8Bytes) && value.maxUtf8Bytes > 0 && value.maxUtf8Bytes <= DEFAULT_CONTEXT_BUDGET.maxUtf8Bytes &&
    Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0 && value.maxTokens <= DEFAULT_CONTEXT_BUDGET.maxTokens
    ? value
    : null;
}

function filterSchema(policy: PolicySnapshot): FilterSchema {
  const fields: FilterFieldDefinition[] = [...DEFAULT_QUERY_FILTER_SCHEMA.fields];
  const extensions = policy.extensions;
  if (typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions) && Array.isArray(extensions.filterFields)) {
    for (const value of extensions.filterFields) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      if (typeof value.path !== 'string' || !['string', 'number', 'boolean', 'instant'].includes(String(value.type))) continue;
      if (!['scope', 'access', 'relevance'].includes(String(value.purpose))) continue;
      fields.push({
        path: value.path,
        type: value.type as FilterFieldDefinition['type'],
        purpose: value.purpose as FilterFieldDefinition['purpose'],
        ...(value.collection === 'scalar-in-array' ? { collection: 'scalar-in-array' as const } : {})
      });
    }
  }
  return { schemaVersion: '1.0', fields };
}

function accessFilter(
  request: KnowledgeQueryRequest,
  snapshot: QuerySnapshot,
  policy: PolicySnapshot
): FilterExpression {
  const predicates: FilterExpression[] = [
    { op: 'eq', field: 'spaceId', value: request.spaceId },
    { op: 'in', field: 'revisionId', values: snapshot.revisions.map((value) => value.revisionId) },
    { op: 'eq', field: 'disposition', value: 'available' }
  ];
  for (const label of policy.access.requiredLabels) predicates.push({ op: 'eq', field: 'visibility.labels', value: label });
  for (const label of [...policy.access.excludedLabels, ...request.access.deniedLabels]) predicates.push({ op: 'neq', field: 'visibility.labels', value: label });
  if (request.access.allowedLabels.length > 0) {
    predicates.push({ op: 'in', field: 'visibility.labels', values: request.access.allowedLabels });
  }
  if (request.filter !== undefined) predicates.push(request.filter);
  return { op: 'and', operands: predicates };
}

function metadataForUnit(unit: ContentUnitVersion): JsonValue {
  return asWireValue({
    spaceId: unit.spaceId,
    sourceId: unit.identity.sourceId,
    revisionId: unit.revisionId,
    unitId: unit.identity.unitId,
    unitVersionId: unit.unitVersionId,
    visibility: unit.visibility,
    visibilityDigest: unit.visibilityDigest,
    metadata: unit.metadata,
    metadataDigest: unit.metadataDigest,
    locator: unit.locator,
    disposition: unit.disposition
  });
}

function sourcePriority(unit: ContentUnitVersion): number {
  return typeof unit.metadata === 'object' && unit.metadata !== null && !Array.isArray(unit.metadata) &&
    typeof unit.metadata.priority === 'number' && Number.isFinite(unit.metadata.priority)
    ? unit.metadata.priority
    : 0;
}

interface MergedCandidate {
  readonly unitId: VectorCandidate['unitId'];
  readonly unitVersionId: VectorCandidate['unitVersionId'];
  readonly score: number;
  readonly semanticRank: number | null;
  readonly keywordRank: number | null;
}

function mergeCandidates(
  route: RetrievalRoute,
  vector: readonly VectorCandidate[],
  keyword: readonly KeywordCandidate[]
): MergedCandidate[] {
  const values = new Map<string, MergedCandidate>();
  for (const candidate of vector) {
    values.set(candidate.unitId, {
      unitId: candidate.unitId,
      unitVersionId: candidate.unitVersionId,
      score: route === 'hybrid' ? 1 / (60 + candidate.rank) : candidate.score,
      semanticRank: candidate.rank,
      keywordRank: null
    });
  }
  for (const candidate of keyword) {
    const current = values.get(candidate.unitId);
    values.set(candidate.unitId, {
      unitId: candidate.unitId,
      unitVersionId: candidate.unitVersionId,
      score: (current?.score ?? 0) + (route === 'hybrid' ? 1 / (60 + candidate.rank) : candidate.score),
      semanticRank: current?.semanticRank ?? null,
      keywordRank: candidate.rank
    });
  }
  return Array.from(values.values()).sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId, 'en'));
}

export class QueryService {
  readonly #repository: KnowledgeRepository;
  readonly #contentStore: ContentStore;
  readonly #embeddingModel: EmbeddingModel;
  readonly #vectorIndex: VectorIndex;
  readonly #keywordIndex: KeywordIndex | undefined;
  readonly #reranker: Reranker | undefined;
  readonly #securityHooks: readonly SecurityHook[];
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(dependencies: QueryServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#contentStore = dependencies.contentStore;
    this.#embeddingModel = dependencies.embeddingModel;
    this.#vectorIndex = dependencies.vectorIndex;
    this.#keywordIndex = dependencies.keywordIndex;
    this.#reranker = dependencies.reranker;
    this.#securityHooks = dependencies.securityHooks;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async retrieve(
    request: KnowledgeQueryRequest,
    options: ExecutionOptions = {}
  ): Promise<LorebitOutcome<KnowledgeResult<'retrieve'>>> {
    const diagnostics: Diagnostic[] = [];
    const initialControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options);
    if (initialControl !== null) return initialControl;
    if (request.mode !== 'retrieve' && request.mode !== 'context') return queryFailure(this.#ids, 'invalid-request', 'Query mode is invalid.');
    if (!decodeDigestRef(request.access?.fingerprint).ok || !Array.isArray(request.access.allowedLabels) || !Array.isArray(request.access.deniedLabels)) {
      return queryFailure(this.#ids, 'invalid-request', 'AccessContext is invalid.');
    }
    let normalizedQuery = normalizeQuery(request.query);
    const queryBytes = new TextEncoder().encode(normalizedQuery).byteLength;
    if (normalizedQuery.length === 0 || queryBytes > 64 * 1024 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(normalizedQuery)) {
      return queryFailure(this.#ids, 'invalid-request', 'Query text is empty, malformed or exceeds 64 KiB.');
    }
    const snapshot = await this.#repository.getQuerySnapshot(request.spaceId);
    const snapshotControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
    if (snapshotControl !== null) return snapshotControl;
    if (snapshot === null) return queryFailure(this.#ids, 'processing-incomplete', 'No active query snapshot is available.');
    const [policy, generation, receipt] = await Promise.all([
      this.#repository.getPolicy(request.spaceId, snapshot.policyId),
      this.#repository.getGeneration(request.spaceId, snapshot.generationId),
      this.#repository.getGenerationReceipt(request.spaceId, snapshot.generationId)
    ]);
    const factsControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
    if (factsControl !== null) return factsControl;
    if (policy === null || generation === null || receipt === null) return queryFailure(this.#ids, 'generation-stale', 'The active query snapshot cannot be resolved.');
    if (generation.status !== 'active' || receipt.status !== 'passed' || receipt.validUntil <= this.#clock.now()) {
      return queryFailure(this.#ids, receipt.validUntil <= this.#clock.now() ? 'receipt-stale' : 'generation-stale', 'The active generation is not currently verified.');
    }
    if (generation.vectorIndex.adapterId !== this.#vectorIndex.descriptor.adapterId ||
      generation.vectorIndex.deploymentFingerprint !== this.#vectorIndex.descriptor.deploymentFingerprint ||
      generation.embedding.adapterId !== this.#embeddingModel.descriptor.adapterId ||
      generation.embedding.deploymentFingerprint !== this.#embeddingModel.descriptor.deploymentFingerprint) {
      return queryFailure(this.#ids, 'receipt-stale', 'Active generation adapter deployment does not match the runtime.');
    }
    const lowered = normalizedQuery.toLocaleLowerCase('en');
    if (policy.questionScope.denied.some((term) => lowered.includes(term.toLocaleLowerCase('en'))) ||
      (policy.questionScope.allowed.length > 0 && !policy.questionScope.allowed.some((term) => lowered.includes(term.toLocaleLowerCase('en'))))) {
      return queryFailure(this.#ids, 'out-of-scope', 'Query is outside the active policy question scope.');
    }
    const securityPolicy = securityPolicyFromExtensions(policy.extensions);
    const beforeQuery = await executeSecurityHooks(
      this.#securityHooks,
      'beforeQuery',
      asWireValue({ query: normalizedQuery, spaceId: request.spaceId, policyId: policy.policyId, accessFingerprint: request.access.fingerprint, mode: request.mode }),
      securityPolicy.requiredHooks.includes('beforeQuery'),
      this.#clock,
      options
    );
    const hookControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
    if (hookControl !== null) return hookControl;
    if (!beforeQuery.ok) return queryFailure(this.#ids, beforeQuery.code, beforeQuery.summary, beforeQuery.diagnostics);
    diagnostics.push(...beforeQuery.diagnostics);
    if (beforeQuery.actions.includes('normalize')) {
      if (typeof beforeQuery.payload !== 'object' || beforeQuery.payload === null || Array.isArray(beforeQuery.payload) || typeof beforeQuery.payload.query !== 'string') {
        return queryFailure(this.#ids, 'security-hook-failed', 'beforeQuery normalize did not return a query string.');
      }
      normalizedQuery = normalizeQuery(beforeQuery.payload.query);
      if (normalizedQuery.length === 0 || new TextEncoder().encode(normalizedQuery).byteLength > 64 * 1024) {
        return queryFailure(this.#ids, 'query-blocked', 'Normalized query is invalid.');
      }
      const normalizedLowered = normalizedQuery.toLocaleLowerCase('en');
      if (policy.questionScope.denied.some((term) => normalizedLowered.includes(term.toLocaleLowerCase('en'))) ||
        (policy.questionScope.allowed.length > 0 && !policy.questionScope.allowed.some((term) => normalizedLowered.includes(term.toLocaleLowerCase('en'))))) {
        return queryFailure(this.#ids, 'query-blocked', 'Query normalization attempted to leave the active question scope.');
      }
    }
    const topK = request.topK ?? 20;
    const candidateLimit = request.candidateLimit ?? Math.min(200, Math.max(topK, topK * 4));
    const budget = contextBudget(request.contextBudget);
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100 || !Number.isSafeInteger(candidateLimit) || candidateLimit < topK || candidateLimit > 200 || budget === null) {
      return queryFailure(this.#ids, 'resource-limit-exceeded', 'Query or context budget exceeds deterministic hard limits.');
    }
    const requestedRoute = request.route ?? (this.#keywordIndex === undefined ? 'semantic' : 'hybrid');
    let route = requestedRoute;
    if ((route === 'keyword' || route === 'hybrid') && this.#keywordIndex === undefined) {
      if (route === 'hybrid' && request.allowEnhancementDowngrade === true) {
        route = 'semantic';
        diagnostics.push(diagnostic('keyword-route-unavailable', 'warning', 'Hybrid retrieval explicitly downgraded to semantic retrieval.'));
      } else {
        return queryFailure(this.#ids, 'capability-unavailable', 'Requested keyword retrieval capability is unavailable.');
      }
    }
    const schema = filterSchema(policy);
    const expression = accessFilter(request, snapshot, policy);
    const vectorFilter = await compileFilterExpression(expression, schema, this.#vectorIndex.capabilities.filter);
    if (!vectorFilter.ok) return queryFailure(this.#ids, vectorFilter.code === 'filter-invalid' ? 'invalid-request' : 'filter-not-enforceable', vectorFilter.summary);
    if (route !== 'semantic') {
      const keywordFilter = await compileFilterExpression(expression, schema, this.#keywordIndex!.capabilities.filter);
      if (!keywordFilter.ok) return queryFailure(this.#ids, keywordFilter.code === 'filter-invalid' ? 'invalid-request' : 'filter-not-enforceable', keywordFilter.summary);
    }
    const egressDecisions: DataEgressDecision[] = [];
    const hookRecords: SecurityHookRecord[] = [...beforeQuery.records];
    const prepareEgress = async (
      stage: DataEgressDecision['stage'],
      boundary: Parameters<typeof decideDataEgress>[1],
      manifest: JsonValue
    ): Promise<{ readonly code: LorebitFailureCode; readonly summary: string; readonly diagnostics: readonly Diagnostic[] } | null> => {
      const decision = decideDataEgress(stage, boundary, securityPolicy);
      egressDecisions.push(decision);
      if (!decision.allowed) return { code: 'data-egress-denied', summary: `Data egress denied for ${stage}: ${decision.reason}.`, diagnostics: [] };
      const hook = await executeSecurityHooks(
        this.#securityHooks,
        'beforeModelEgress',
        manifest,
        securityPolicy.requiredHooks.includes('beforeModelEgress'),
        this.#clock,
        options
      );
      if (!hook.ok) return { code: hook.code, summary: hook.summary, diagnostics: hook.diagnostics };
      hookRecords.push(...hook.records);
      diagnostics.push(...hook.diagnostics);
      return null;
    };
    if (route !== 'keyword') {
      const denied = await prepareEgress('embedding', this.#embeddingModel.descriptor.dataBoundary, asWireValue({ stage: 'embedding', queryDigest: await digestBytes(new TextEncoder().encode(normalizedQuery)), classification: securityPolicy.dataClassification }));
      if (denied !== null) return queryFailure(this.#ids, denied.code, denied.summary, denied.diagnostics);
    }
    const useReranker = request.rerank === true;
    if (useReranker && this.#reranker === undefined) {
      if (request.allowEnhancementDowngrade === true) diagnostics.push(diagnostic('reranker-unavailable', 'warning', 'Reranking was explicitly skipped.'));
      else return queryFailure(this.#ids, 'capability-unavailable', 'Requested reranker capability is unavailable.');
    }
    if (useReranker && this.#reranker !== undefined) {
      const denied = await prepareEgress('reranking', this.#reranker.descriptor.dataBoundary, asWireValue({ stage: 'reranking', queryDigest: await digestBytes(new TextEncoder().encode(normalizedQuery)), candidateLimit, classification: securityPolicy.dataClassification }));
      if (denied !== null) return queryFailure(this.#ids, denied.code, denied.summary, denied.diagnostics);
    }
    const queryDigest = await digestBytes(new TextEncoder().encode(normalizedQuery));
    const queryPlanId = this.#ids.next('query-plan');
    const planBase = {
      schemaVersion: '1.0' as const,
      queryPlanId,
      spaceId: request.spaceId,
      activationId: snapshot.activationId,
      policyId: snapshot.policyId,
      generationId: snapshot.generationId,
      revisions: snapshot.revisions,
      normalizedQuery,
      queryDigest,
      accessContextDigest: request.access.fingerprint,
      route,
      requestedRoute,
      filter: vectorFilter.value,
      topK,
      candidateBudget: { semantic: route === 'keyword' ? 0 : candidateLimit, keyword: route === 'semantic' ? 0 : candidateLimit },
      merge: {
        method: route === 'hybrid' ? 'reciprocal-rank-fusion' as const : 'single-route-rank' as const,
        rrfK: 60 as const,
        semanticWeight: 1,
        keywordWeight: 1,
        tieBreak: 'source-priority-then-stable-id' as const
      },
      reranker: useReranker && this.#reranker !== undefined ? {
        adapterId: this.#reranker.descriptor.adapterId,
        version: this.#reranker.descriptor.version,
        deploymentFingerprint: this.#reranker.descriptor.deploymentFingerprint
      } : null,
      contextBudget: budget,
      adapterRefs: [
        ...(route === 'keyword' ? [] : [{ kind: 'embedding-model', adapterId: this.#embeddingModel.descriptor.adapterId, version: this.#embeddingModel.descriptor.version, deploymentFingerprint: this.#embeddingModel.descriptor.deploymentFingerprint }]),
        ...(route === 'keyword' ? [] : [{ kind: 'vector-index', adapterId: this.#vectorIndex.descriptor.adapterId, version: this.#vectorIndex.descriptor.version, deploymentFingerprint: this.#vectorIndex.descriptor.deploymentFingerprint }]),
        ...(route === 'semantic' || this.#keywordIndex === undefined ? [] : [{ kind: 'keyword-index', adapterId: this.#keywordIndex.descriptor.adapterId, version: this.#keywordIndex.descriptor.version, deploymentFingerprint: this.#keywordIndex.descriptor.deploymentFingerprint }]),
        ...(useReranker && this.#reranker !== undefined ? [{ kind: 'reranker', adapterId: this.#reranker.descriptor.adapterId, version: this.#reranker.descriptor.version, deploymentFingerprint: this.#reranker.descriptor.deploymentFingerprint }] : [])
      ],
      securityHooks: hookRecords,
      egressDecisions,
      createdAt: this.#clock.now()
    };
    const planDigest = await digestCanonicalJson(planBase);
    if (!planDigest.ok) throw new TypeError(planDigest.error.summary);
    const queryPlan: QueryPlanSnapshot = Object.freeze({ ...planBase, digest: planDigest.value });
    const indexOptions = { ...options, filter: { compiled: vectorFilter.value, schema } };
    let vectorCandidates: readonly VectorCandidate[] = [];
    if (route !== 'keyword') {
      const embedded = await this.#embeddingModel.embed([normalizedQuery], options);
      const embeddingControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
      if (embeddingControl !== null) return embeddingControl;
      if (!embedded.ok) return queryFailure(this.#ids, embedded.code === 'cancelled' ? 'cancelled' : embedded.code === 'input-too-large' ? 'resource-limit-exceeded' : 'adapter-failure', redactDiagnosticText(embedded.summary));
      const queried = await this.#vectorIndex.query(request.spaceId, snapshot.generationId, embedded.vectors[0]!, candidateLimit, indexOptions);
      const vectorControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
      if (vectorControl !== null) return vectorControl;
      if (!queried.ok) return queryFailure(this.#ids, queried.code === 'cancelled' ? 'cancelled' : queried.code === 'generation-not-found' ? 'generation-stale' : 'adapter-failure', redactDiagnosticText(queried.summary));
      vectorCandidates = queried.value;
    }
    let keywordCandidates: readonly KeywordCandidate[] = [];
    if (route !== 'semantic') {
      const queried = await this.#keywordIndex!.query(request.spaceId, snapshot.generationId, normalizedQuery, candidateLimit, { ...options, filter: { compiled: vectorFilter.value, schema } });
      const keywordControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
      if (keywordControl !== null) return keywordControl;
      if (!queried.ok) return queryFailure(this.#ids, queried.code === 'cancelled' ? 'cancelled' : queried.code === 'generation-not-found' ? 'generation-stale' : 'adapter-failure', redactDiagnosticText(queried.summary));
      keywordCandidates = queried.value;
    }
    const merged = mergeCandidates(route, vectorCandidates, keywordCandidates);
    const hydrated: Array<{ readonly merged: MergedCandidate; readonly unit: ContentUnitVersion; readonly content: string; readonly priority: number }> = [];
    const excluded: RetrievalResult['excluded'][number][] = [];
    for (const candidate of merged) {
      const candidateControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
      if (candidateControl !== null) return candidateControl;
      const unit = await this.#repository.getContentUnitVersion(request.spaceId, candidate.unitVersionId);
      if (unit === null || unit.identity.unitId !== candidate.unitId || !generation.unitVersionIds.includes(candidate.unitVersionId)) {
        return queryFailure(this.#ids, 'integrity-check-failed', 'Index returned a candidate outside the verified generation manifest.');
      }
      if (!matchesFilterExpression(vectorFilter.value.expression, metadataForUnit(unit), schema)) {
        return queryFailure(this.#ids, 'filter-not-enforceable', 'Index returned a candidate that violates the compiled pre-retrieval filter.');
      }
      const revision = await this.#repository.getRevision(request.spaceId, unit.revisionId);
      if (revision === null || revision.state.status !== 'active' || unit.disposition !== 'available') {
        excluded.push({ unitVersionId: unit.unitVersionId, reason: 'revision-or-unit-not-active' });
        continue;
      }
      const loaded = await this.#contentStore.get(unit.text);
      const contentControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
      if (contentControl !== null) return contentControl;
      if (!loaded.ok) return queryFailure(this.#ids, loaded.error.code === 'not-found' ? 'citation-invalid' : 'adapter-failure', redactDiagnosticText(loaded.error.summary));
      const digest = await digestBytes(Uint8Array.from(loaded.value).buffer);
      if (digest.value !== unit.textDigest.value) return queryFailure(this.#ids, 'digest-mismatch', 'Retrieved content does not match its immutable digest.');
      hydrated.push({ merged: candidate, unit, content: new TextDecoder().decode(loaded.value), priority: sourcePriority(unit) });
    }
    hydrated.sort((left, right) => right.merged.score - left.merged.score || right.priority - left.priority || left.unit.identity.sourceId.localeCompare(right.unit.identity.sourceId, 'en') || left.unit.revisionId.localeCompare(right.unit.revisionId, 'en') || left.unit.identity.unitId.localeCompare(right.unit.identity.unitId, 'en'));
    let rerankRanks = new Map<string, { readonly rank: number; readonly score: number }>();
    if (useReranker && this.#reranker !== undefined) {
      const reranked = await this.#reranker.rerank(normalizedQuery, hydrated.map((value, index) => ({ unitId: value.unit.identity.unitId, unitVersionId: value.unit.unitVersionId, content: value.content, originalRank: index + 1 })), options);
      const rerankControl = executionControlFailure<KnowledgeResult<'retrieve'>>(this.#ids, options, diagnostics);
      if (rerankControl !== null) return rerankControl;
      if (!reranked.ok) return queryFailure(this.#ids, reranked.code === 'cancelled' ? 'cancelled' : reranked.code === 'input-too-large' ? 'resource-limit-exceeded' : 'adapter-failure', redactDiagnosticText(reranked.summary));
      if (new Set(reranked.candidates.map((candidate) => candidate.unitVersionId)).size !== reranked.candidates.length || reranked.candidates.some((candidate) => !hydrated.some((value) => value.unit.unitVersionId === candidate.unitVersionId))) {
        return queryFailure(this.#ids, 'integrity-check-failed', 'Reranker returned unknown or duplicate candidates.');
      }
      rerankRanks = new Map(reranked.candidates.map((candidate) => [candidate.unitVersionId, { rank: candidate.rank, score: candidate.score }]));
      hydrated.sort((left, right) => (rerankRanks.get(left.unit.unitVersionId)?.rank ?? Number.MAX_SAFE_INTEGER) - (rerankRanks.get(right.unit.unitVersionId)?.rank ?? Number.MAX_SAFE_INTEGER) || right.merged.score - left.merged.score || left.unit.identity.unitId.localeCompare(right.unit.identity.unitId, 'en'));
    }
    const candidates: RetrievalCandidate[] = [];
    for (const [index, value] of hydrated.slice(0, topK).entries()) {
      const citation: Citation = {
        schemaVersion: '1.0',
        citationId: this.#ids.next('citation'),
        spaceId: request.spaceId,
        sourceId: value.unit.identity.sourceId,
        revisionId: value.unit.revisionId,
        unitId: value.unit.identity.unitId,
        unitVersionId: value.unit.unitVersionId,
        generationId: snapshot.generationId,
        policyId: snapshot.policyId,
        locator: value.unit.locator,
        contentDigest: value.unit.textDigest,
        visibilityDigest: value.unit.visibilityDigest,
        attestationRef: null,
        applicableScope: policy.questionScope.allowed.join(','),
        createdAt: this.#clock.now()
      };
      if (!validateCitation(citation, value.unit, snapshot).valid) {
        excluded.push({ unitVersionId: value.unit.unitVersionId, reason: 'citation-invalid' });
        continue;
      }
      const reranked = rerankRanks.get(value.unit.unitVersionId);
      candidates.push({
        sourceId: value.unit.identity.sourceId,
        revisionId: value.unit.revisionId,
        unitId: value.unit.identity.unitId,
        unitVersionId: value.unit.unitVersionId,
        content: value.content,
        trust: 'untrusted-retrieved-data',
        finalRank: index + 1,
        score: reranked?.score ?? value.merged.score,
        routeRanks: { semantic: value.merged.semanticRank, keyword: value.merged.keywordRank, rerank: reranked?.rank ?? null },
        rankingExplanation: [route, ...(reranked === undefined ? [] : ['reranked']), 'stable-id-tie-break'],
        citation
      });
    }
    const citations = candidates.map((candidate) => candidate.citation);
    const citationDigests = await Promise.all(citations.map(async (citation) => {
      const digest = await digestCanonicalJson(citation);
      if (!digest.ok) throw new TypeError(digest.error.summary);
      return digest.value;
    }));
    const status = candidates.length === 0
      ? policy.defaultResult.emptyResult
      : candidates.length < policy.evidence.minimumCitations ? 'insufficient-evidence' as const : 'complete' as const;
    if (status === 'insufficient-evidence' && policy.evidence.onInsufficientEvidence === 'reject') {
      return queryFailure(this.#ids, 'insufficient-evidence', 'The active evidence policy requires more citations.', diagnostics);
    }
    const resultId = this.#ids.next('result');
    const result: KnowledgeResult<'retrieve'> = {
      schemaVersion: '1.0',
      resultId,
      mode: 'retrieve',
      status,
      retrieval: { candidates, excluded },
      context: null,
      generation: null,
      citations,
      guarantees: ['active-query-snapshot', 'space-isolation', 'pre-retrieval-filter', 'citation-double-validation', 'stable-order'],
      limitations: [
        ...(status === 'insufficient-evidence' ? ['minimum citation policy not met'] : []),
        ...(diagnostics.some((value) => value.code.endsWith('unavailable')) ? ['optional retrieval enhancement unavailable'] : [])
      ],
      diagnostics,
      queryPlan,
      provenance: {
        schemaVersion: '1.0',
        resultId,
        spaceId: request.spaceId,
        queryDigest,
        accessContextDigest: request.access.fingerprint,
        policyId: snapshot.policyId,
        revisions: snapshot.revisions,
        recipeId: generation.recipeId,
        generationId: snapshot.generationId,
        runIds: [generation.runId],
        modelRefs: [
          ...(route === 'keyword' ? [] : [this.#embeddingModel.capabilities.model]),
          ...(queryPlan.reranker === null ? [] : [this.#reranker!.capabilities.model])
        ],
        queryPlanDigest: queryPlan.digest,
        retrievalRoute: route,
        filterDigest: queryPlan.filter.digest,
        includedUnitVersionIds: candidates.map((candidate) => candidate.unitVersionId),
        excluded,
        citationDigests,
        contextManifestDigest: null,
        securityHooks: hookRecords,
        egressDecisions,
        createdAt: this.#clock.now()
      }
    };
    return successful(result, operation(this.#ids), diagnostics);
  }

  securityHooks(): readonly SecurityHook[] {
    return this.#securityHooks;
  }

  repository(): KnowledgeRepository {
    return this.#repository;
  }

  clock(): Clock {
    return this.#clock;
  }

  ids(): IdGenerator {
    return this.#ids;
  }
}
