import type { ExecutionOptions } from '../commands.js';
import { diagnostic, lorebitFailure, type Diagnostic } from '../../domain/diagnostics.js';
import { failed, successful, type LorebitOutcome } from '../../domain/outcomes.js';
import type { GenerationOutput, KnowledgeQueryRequest, KnowledgeResult } from '../../domain/query-plan.js';
import { decideDataEgress, securityPolicyFromExtensions, type SecurityHookRecord } from '../../domain/security.js';
import { createTraceContextSnapshot, type TelemetrySpan } from '../../domain/trace.js';
import type { RuntimeResourceLimits } from '../../domain/resources.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator, OperationId } from '../../domain/ids.js';
import type { KnowledgeRepository } from '../../ports/knowledge-repository.js';
import type { LanguageModel, LanguageModelUsage } from '../../ports/language-model.js';
import type { SecurityHook } from '../../ports/security-hooks.js';
import type { TelemetrySink } from '../../ports/telemetry.js';
import { decodeJsonValue, type JsonValue } from '../../wire/json-value.js';
import { executeSecurityHooks } from './query-service.js';

interface RandomSource {
  next(): number;
  hex(bytes: number): string;
}

interface GenerationRuntimeDependencies {
  readonly repository: KnowledgeRepository;
  readonly model: LanguageModel;
  readonly securityHooks: readonly SecurityHook[];
  readonly telemetry: TelemetrySink;
  readonly limits: RuntimeResourceLimits;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: RandomSource;
}

function operation(ids: IdGenerator): { readonly operationId: OperationId; readonly kind: 'query' } {
  return { operationId: ids.next('operation'), kind: 'query' };
}

function asWireValue(input: unknown): JsonValue {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) throw new TypeError(decoded.error.summary);
  return decoded.value;
}

function emptyUsage(): LanguageModelUsage {
  return { inputTokens: null, outputTokens: null, calls: 0, estimatedCost: null };
}

function addUsage(left: LanguageModelUsage, right: LanguageModelUsage): LanguageModelUsage {
  if (left.calls === 0) return { ...right };
  if (right.calls === 0) return { ...left };
  return {
    inputTokens: left.inputTokens === null || right.inputTokens === null ? null : left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens === null || right.outputTokens === null ? null : left.outputTokens + right.outputTokens,
    calls: left.calls + right.calls,
    estimatedCost: left.estimatedCost === null || right.estimatedCost === null || left.estimatedCost.currency !== right.estimatedCost.currency
      ? null
      : { amount: left.estimatedCost.amount + right.estimatedCost.amount, currency: left.estimatedCost.currency, precision: left.estimatedCost.precision === 'exact' && right.estimatedCost.precision === 'exact' ? 'exact' : 'estimated' }
  };
}

function finishReason(code: string): GenerationOutput['finishReason'] {
  if (code === 'refused') return 'refused';
  if (code === 'invalid-output') return 'invalid';
  return 'error';
}

function isExecutionAborted(options: ExecutionOptions): boolean {
  return options.signal?.aborted === true;
}

export class GenerationRuntimeService {
  readonly #repository: KnowledgeRepository;
  readonly #model: LanguageModel;
  readonly #securityHooks: readonly SecurityHook[];
  readonly #telemetry: TelemetrySink;
  readonly #limits: RuntimeResourceLimits;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #random: RandomSource;

  constructor(dependencies: GenerationRuntimeDependencies) {
    this.#repository = dependencies.repository;
    this.#model = dependencies.model;
    this.#securityHooks = dependencies.securityHooks;
    this.#telemetry = dependencies.telemetry;
    this.#limits = dependencies.limits;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#random = dependencies.random;
  }

  async generate(
    contextResult: KnowledgeResult<'context'>,
    request: KnowledgeQueryRequest,
    options: ExecutionOptions = {}
  ): Promise<LorebitOutcome<KnowledgeResult<'generate'>>> {
    const diagnostics: Diagnostic[] = [...contextResult.diagnostics];
    const policy = await this.#repository.getPolicy(contextResult.queryPlan.spaceId, contextResult.queryPlan.policyId);
    if (policy === null) return failed(lorebitFailure('generation-stale', 'Generation policy is no longer available.'), operation(this.#ids), diagnostics);
    const securityPolicy = securityPolicyFromExtensions(policy.extensions);
    const hookRecords: SecurityHookRecord[] = [...contextResult.provenance.securityHooks];
    const beforeGenerate = await executeSecurityHooks(
      this.#securityHooks,
      'beforeGenerate',
      asWireValue({
        queryPlanDigest: contextResult.queryPlan.digest,
        contextManifestDigest: contextResult.context.provenance.manifestDigest,
        directiveDigest: contextResult.context.trustedDirective?.digest ?? null,
        evidenceCount: contextResult.context.evidence.length
      }),
      securityPolicy.requiredHooks.includes('beforeGenerate'),
      this.#clock,
      options
    );
    if (!beforeGenerate.ok) return this.#fallback(
      contextResult,
      beforeGenerate.code === 'cancelled' ? 'cancelled' : 'output-blocked',
      beforeGenerate.code === 'cancelled' ? 'Generation was cancelled by a security hook.' : 'Generation was blocked by the configured security policy.',
      [],
      [...hookRecords, ...beforeGenerate.records],
      [...diagnostics, ...beforeGenerate.diagnostics]
    );
    hookRecords.push(...beforeGenerate.records);
    diagnostics.push(...beforeGenerate.diagnostics);
    const egress = decideDataEgress('generation', this.#model.descriptor.dataBoundary, securityPolicy);
    if (!egress.allowed) return this.#fallback(contextResult, 'data-egress-denied', `Generation data egress denied: ${egress.reason}.`, [], hookRecords, diagnostics, [egress]);
    const beforeEgress = await executeSecurityHooks(
      this.#securityHooks,
      'beforeModelEgress',
      asWireValue({ stage: 'generation', classification: securityPolicy.dataClassification, queryPlanDigest: contextResult.queryPlan.digest, contextManifestDigest: contextResult.context.provenance.manifestDigest, providerProfile: egress.providerProfile }),
      securityPolicy.requiredHooks.includes('beforeModelEgress'),
      this.#clock,
      options
    );
    if (!beforeEgress.ok) return this.#fallback(
      contextResult,
      beforeEgress.code === 'cancelled' ? 'cancelled' : 'data-egress-denied',
      beforeEgress.code === 'cancelled' ? 'Generation was cancelled before model egress.' : 'Generation model egress was denied by the configured security policy.',
      [],
      [...hookRecords, ...beforeEgress.records],
      [...diagnostics, ...beforeEgress.diagnostics],
      [egress]
    );
    hookRecords.push(...beforeEgress.records);
    diagnostics.push(...beforeEgress.diagnostics);
    const inputBytes = new TextEncoder().encode(JSON.stringify(contextResult.context)).byteLength;
    if (inputBytes > this.#model.capabilities.maxInputUtf8Bytes) return this.#fallback(contextResult, 'resource-limit-exceeded', 'Context exceeds the LanguageModel input limit.', [], hookRecords, diagnostics, [egress]);
    if (contextResult.context.usage.tokens !== null && contextResult.context.usage.tokens > this.#model.capabilities.maxContextTokens) {
      return this.#fallback(contextResult, 'resource-limit-exceeded', 'Context exceeds the LanguageModel token limit.', [], hookRecords, diagnostics, [egress]);
    }
    const trace = createTraceContextSnapshot(options.trace, this.#clock.now(), { traceId: this.#random.hex(16), spanId: this.#random.hex(8) });
    const attempts: GenerationOutput['attempts'][number][] = [];
    let usage = emptyUsage();
    let modelResult: Awaited<ReturnType<LanguageModel['generate']>> | null = null;
    for (let attempt = 1; attempt <= this.#limits.retryMaxAttempts; attempt += 1) {
      if (options.signal?.aborted === true) {
        const deadlineAbort = options.signal.reason === 'deadline-exceeded';
        modelResult = { ok: false, code: deadlineAbort ? 'deadline' : 'cancelled', summary: deadlineAbort ? 'Generation deadline elapsed.' : 'Generation was cancelled.', retryable: false, retryAfterMs: null, usage: emptyUsage() };
      } else if (options.deadlineAt !== undefined && options.deadlineAt <= this.#clock.now()) {
        modelResult = { ok: false, code: 'deadline', summary: 'Generation deadline elapsed.', retryable: false, retryAfterMs: null, usage: emptyUsage() };
      } else {
        try {
          modelResult = await this.#model.generate({ trustedDirective: contextResult.context.trustedDirective, context: contextResult.context, maxOutputUtf8Bytes: Math.min(this.#limits.maxResultBytes, this.#model.capabilities.maxOutputUtf8Bytes) }, options);
          if (modelResult.ok && isExecutionAborted(options)) {
            const deadlineAbort = options.signal?.reason === 'deadline-exceeded';
            modelResult = { ok: false, code: deadlineAbort ? 'deadline' : 'cancelled', summary: deadlineAbort ? 'Generation deadline elapsed.' : 'Generation was cancelled.', retryable: false, retryAfterMs: null, usage: modelResult.usage };
          }
          if (!modelResult.ok && modelResult.code === 'cancelled' && options.signal?.reason === 'deadline-exceeded') {
            modelResult = { ...modelResult, code: 'deadline', summary: 'Generation deadline elapsed.', retryable: false };
          }
        } catch {
          modelResult = { ok: false, code: 'model-failure', summary: 'LanguageModel threw an exception.', retryable: true, retryAfterMs: null, usage: emptyUsage() };
        }
      }
      usage = addUsage(usage, modelResult.usage);
      const retryable = !modelResult.ok && modelResult.retryable && attempt < this.#limits.retryMaxAttempts;
      const exponential = Math.min(this.#limits.retryMaxMilliseconds, this.#limits.retryBaseMilliseconds * 2 ** (attempt - 1));
      const jitter = Math.floor(this.#random.next() * exponential);
      const retryAfterMs = modelResult.ok ? 0 : modelResult.retryAfterMs ?? 0;
      const retryDelayMs = retryable ? Math.max(retryAfterMs, jitter) : 0;
      attempts.push({ attempt, outcome: modelResult.ok ? 'completed' : modelResult.code, retryDelayMs, inputTokens: modelResult.usage.inputTokens, outputTokens: modelResult.usage.outputTokens });
      if (!retryable || (options.deadlineAt !== undefined && Date.parse(this.#clock.now()) + retryDelayMs >= Date.parse(options.deadlineAt))) break;
      if (retryDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }
    if (modelResult === null || !modelResult.ok) {
      const code = modelResult?.code === 'deadline' ? 'deadline-exceeded'
        : modelResult?.code === 'rate-limited' ? 'adapter-rate-limited'
        : modelResult?.code === 'cancelled' ? 'cancelled'
        : modelResult?.code === 'invalid-output' ? 'generation-invalid'
        : 'generation-failure';
      const safeSummary = code === 'adapter-rate-limited'
        ? 'The LanguageModel rate limit prevented generation.'
        : code === 'deadline-exceeded'
          ? 'The generation deadline elapsed.'
          : code === 'cancelled'
            ? 'Generation was cancelled.'
            : code === 'generation-invalid'
              ? 'The LanguageModel returned an invalid output.'
              : 'The LanguageModel could not complete generation.';
      return this.#fallback(contextResult, code, safeSummary, attempts, hookRecords, diagnostics, [egress], usage, modelResult === null ? 'error' : finishReason(modelResult.code), trace.traceId);
    }
    const outputBytes = new TextEncoder().encode(modelResult.text).byteLength;
    if (modelResult.text.length === 0) {
      return this.#fallback(contextResult, 'generation-invalid', 'LanguageModel output is empty.', attempts, hookRecords, diagnostics, [egress], usage, 'invalid', trace.traceId);
    }
    if (outputBytes > this.#limits.maxResultBytes || outputBytes > this.#model.capabilities.maxOutputUtf8Bytes) {
      return this.#fallback(contextResult, 'resource-limit-exceeded', 'LanguageModel output exceeds the bounded result limit.', attempts, hookRecords, diagnostics, [egress], usage, 'invalid', trace.traceId);
    }
    const afterGenerate = await executeSecurityHooks(
      this.#securityHooks,
      'afterGenerate',
      asWireValue({ text: modelResult.text, citations: contextResult.citations.map((citation) => citation.citationId), policyId: policy.policyId, accessFingerprint: contextResult.queryPlan.accessContextDigest, model: this.#model.capabilities.model }),
      securityPolicy.requiredHooks.includes('afterGenerate'),
      this.#clock,
      options
    );
    if (!afterGenerate.ok) return this.#fallback(
      contextResult,
      'output-blocked',
      'Generated output was blocked by the configured security policy.',
      attempts,
      [...hookRecords, ...afterGenerate.records],
      [...diagnostics, ...afterGenerate.diagnostics],
      [egress],
      usage,
      'error',
      trace.traceId
    );
    hookRecords.push(...afterGenerate.records);
    diagnostics.push(...afterGenerate.diagnostics);
    let text = modelResult.text;
    let status: GenerationOutput['status'] = 'completed';
    if (afterGenerate.actions.includes('redact')) {
      text = typeof afterGenerate.payload === 'object' && afterGenerate.payload !== null && !Array.isArray(afterGenerate.payload) && typeof afterGenerate.payload.text === 'string' ? afterGenerate.payload.text : '[REDACTED]';
    }
    if (afterGenerate.actions.includes('block')) {
      text = '';
      status = 'blocked';
    }
    const output: GenerationOutput = {
      status,
      text: status === 'blocked' ? null : text,
      model: this.#model.capabilities.model,
      modelVersion: this.#model.descriptor.version,
      finishReason: modelResult.finishReason,
      attempts,
      usage,
      providerRequestId: modelResult.providerRequestId,
      traceId: trace.traceId
    };
    const resultId = this.#ids.next('result');
    const result: KnowledgeResult<'generate'> = {
      ...contextResult,
      resultId,
      mode: 'generate',
      status: status === 'completed' ? contextResult.status : 'partial',
      generation: output,
      guarantees: [...contextResult.guarantees, 'generation-input-provenance'],
      limitations: [...contextResult.limitations, 'generation provenance does not prove claim correctness'],
      diagnostics,
      provenance: {
        ...contextResult.provenance,
        resultId,
        modelRefs: [...contextResult.provenance.modelRefs, `${this.#model.capabilities.model}@${this.#model.descriptor.version}`],
        securityHooks: hookRecords,
        egressDecisions: [...contextResult.provenance.egressDecisions, egress],
        createdAt: this.#clock.now()
      }
    };
    await this.#safeSpan({
      schemaVersion: '1.0', traceId: trace.traceId, spanId: this.#random.hex(8), parentSpanId: trace.parentSpanId,
      name: 'lorebit.generate',
      scope: { spaceId: result.queryPlan.spaceId, operationId: null, queryPlanId: result.queryPlan.queryPlanId, generationId: result.queryPlan.generationId },
      attributes: asWireValue({ status: output.status, attempts: attempts.length, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: this.#model.capabilities.model }),
      startedAt: trace.observedAt, completedAt: this.#clock.now(), status: 'ok'
    });
    await this.#recordUsage(result.queryPlan.spaceId, output.status, usage, attempts.length);
    return successful(result, operation(this.#ids), diagnostics);
  }

  async #fallback(
    contextResult: KnowledgeResult<'context'>,
    code: string,
    summary: string,
    attempts: GenerationOutput['attempts'],
    hookRecords: readonly SecurityHookRecord[],
    diagnostics: readonly Diagnostic[],
    egressDecisions: KnowledgeResult<'context'>['provenance']['egressDecisions'] = [],
    usage: LanguageModelUsage = emptyUsage(),
    reason: GenerationOutput['finishReason'] = 'error',
    traceId = this.#random.hex(16)
  ): Promise<LorebitOutcome<KnowledgeResult<'generate'>>> {
    const generationDiagnostic = diagnostic(code, 'error', summary || 'Generation failed.', {
      affected: ['generation'],
      guarantees: contextResult.guarantees,
      recovery: [{ code: 'use-context', summary: 'Use the retained retrieve/context result or retry generation after resolving the diagnostic.' }],
      retryable: ['generation-failure', 'adapter-rate-limited', 'deadline-exceeded'].includes(code),
      details: { attempts: attempts.length }
    });
    const resultId = this.#ids.next('result');
    const result: LorebitOutcome<KnowledgeResult<'generate'>> = successful<KnowledgeResult<'generate'>>({
      ...contextResult,
      resultId,
      mode: 'generate',
      status: 'partial',
      generation: {
        status: code === 'output-blocked' ? 'blocked' : 'failed',
        text: null,
        model: this.#model.capabilities.model,
        modelVersion: this.#model.descriptor.version,
        finishReason: reason,
        attempts,
        usage,
        providerRequestId: null,
        traceId
      },
      limitations: [...contextResult.limitations, 'generation unavailable; retrieve/context retained', 'generation provenance does not prove claim correctness'],
      diagnostics: [...diagnostics, generationDiagnostic],
      provenance: {
        ...contextResult.provenance,
        resultId,
        modelRefs: [...contextResult.provenance.modelRefs, `${this.#model.capabilities.model}@${this.#model.descriptor.version}`],
        securityHooks: hookRecords,
        egressDecisions: [...contextResult.provenance.egressDecisions, ...egressDecisions],
        createdAt: this.#clock.now()
      }
    }, operation(this.#ids), [...diagnostics, generationDiagnostic]);
    const observedAt = this.#clock.now();
    await this.#safeSpan({
      schemaVersion: '1.0',
      traceId,
      spanId: this.#random.hex(8),
      parentSpanId: null,
      name: 'lorebit.generate',
      scope: { spaceId: contextResult.queryPlan.spaceId, operationId: result.operation.operationId, queryPlanId: contextResult.queryPlan.queryPlanId, generationId: contextResult.queryPlan.generationId },
      attributes: { status: 'failed', code, attempts: attempts.length, model: this.#model.capabilities.model },
      startedAt: observedAt,
      completedAt: observedAt,
      status: 'error'
    });
    await this.#recordUsage(contextResult.queryPlan.spaceId, code, usage, attempts.length);
    return result;
  }

  async #recordUsage(spaceId: string, status: string, usage: LanguageModelUsage, attempts: number): Promise<void> {
    const attributes = { spaceId, status, model: this.#model.capabilities.model };
    await this.#safeMetric('lorebit.generation.calls', usage.calls, attributes);
    await this.#safeMetric('lorebit.generation.attempts', attempts, attributes);
    if (usage.inputTokens !== null) await this.#safeMetric('lorebit.generation.input_tokens', usage.inputTokens, attributes);
    if (usage.outputTokens !== null) await this.#safeMetric('lorebit.generation.output_tokens', usage.outputTokens, attributes);
    if (usage.estimatedCost !== null) {
      await this.#safeMetric('lorebit.generation.estimated_cost', usage.estimatedCost.amount, {
        ...attributes,
        currency: usage.estimatedCost.currency,
        precision: usage.estimatedCost.precision
      });
    }
  }

  async #safeMetric(name: string, value: number, attributes: JsonValue): Promise<void> {
    try { await this.#telemetry.recordMetric(name, value, attributes); } catch { /* Telemetry cannot change generation outcomes. */ }
  }

  async #safeSpan(span: TelemetrySpan): Promise<void> {
    try { await this.#telemetry.recordSpan(span); } catch { /* Telemetry cannot change generation outcomes. */ }
  }
}
