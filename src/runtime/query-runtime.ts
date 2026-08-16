import type { ExecutionOptions } from '../application/commands.js';
import { ContextService } from '../application/services/context-service.js';
import { QueryService } from '../application/services/query-service.js';
import type { KnowledgeQueryRequest, KnowledgeResult } from '../domain/query-plan.js';
import type { LorebitOutcome } from '../domain/outcomes.js';
import { failed } from '../domain/outcomes.js';
import { diagnostic, lorebitFailure } from '../domain/diagnostics.js';
import { GenerationRuntimeService } from '../application/services/generation-runtime-service.js';
import { ResourceScheduler } from '../application/services/resource-scheduler.js';
import type { TelemetrySink } from '../ports/telemetry.js';
import type { Clock } from '../ports/clock.js';
import { createTraceContextSnapshot } from '../domain/trace.js';
import type { IdGenerator } from '../domain/ids.js';
import type { RuntimeResourceLimits } from '../domain/resources.js';
import { formatRfc3339Utc } from '../wire/rfc3339.js';
import type { JsonValue } from '../wire/json-value.js';
import type { TelemetrySpan } from '../domain/trace.js';

interface QueryRuntimeDependencies {
  readonly query: QueryService;
  readonly context: ContextService;
  readonly generation?: GenerationRuntimeService;
  readonly scheduler: ResourceScheduler;
  readonly telemetry: TelemetrySink;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: { next(): number; hex(bytes: number): string };
  readonly limits: RuntimeResourceLimits;
}

export class QueryRuntime {
  readonly #query: QueryService;
  readonly #context: ContextService;
  readonly #generation: GenerationRuntimeService | undefined;
  readonly #scheduler: ResourceScheduler;
  readonly #telemetry: TelemetrySink;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #random: QueryRuntimeDependencies['random'];
  readonly #limits: RuntimeResourceLimits;

  constructor(dependencies: QueryRuntimeDependencies) {
    this.#query = dependencies.query;
    this.#context = dependencies.context;
    this.#generation = dependencies.generation;
    this.#scheduler = dependencies.scheduler;
    this.#telemetry = dependencies.telemetry;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#random = dependencies.random;
    this.#limits = dependencies.limits;
  }

  canGenerate(): boolean { return this.#generation !== undefined; }

  retrieve(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'retrieve'>>> {
    return this.#scheduled('query', request, options, (effectiveOptions) => this.#query.retrieve({ ...request, mode: 'retrieve' }, effectiveOptions));
  }

  async buildContext(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'context'>>> {
    return this.#scheduled('context', request, options, async (effectiveOptions) => {
      const retrieved = await this.#query.retrieve({ ...request, mode: 'context' }, effectiveOptions);
      return retrieved.ok
        ? this.#context.build(retrieved.value, { ...request, mode: 'context' }, effectiveOptions)
        : retrieved;
    });
  }

  generate(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'generate'>>> {
    if (this.#generation === undefined) {
      return Promise.resolve(failed(
        lorebitFailure('capability-unavailable', 'LanguageModel generation module is not configured.'),
        { operationId: this.#ids.next('operation'), kind: 'query' }
      ));
    }
    return this.#scheduled('generate', request, options, async (effectiveOptions) => {
      const retrieved = await this.#query.retrieve({ ...request, mode: 'context' }, effectiveOptions);
      if (!retrieved.ok) return retrieved;
      const contextual = await this.#context.build(retrieved.value, { ...request, mode: 'context' }, effectiveOptions);
      return contextual.ok
        ? this.#generation!.generate(contextual.value, { ...request, mode: 'generate' }, effectiveOptions)
        : contextual;
    });
  }

  query(
    request: KnowledgeQueryRequest,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<KnowledgeResult<'retrieve'> | KnowledgeResult<'context'> | KnowledgeResult<'generate'>>> {
    if (request.mode === 'context') return this.buildContext(request, options);
    if (request.mode === 'retrieve') return this.retrieve(request, options);
    if (request.mode === 'generate') return this.generate(request, options);
    return Promise.resolve(failed(
      lorebitFailure('invalid-request', 'Query mode is invalid.'),
      { operationId: this.#ids.next('operation'), kind: 'query' }
    ));
  }

  resourceSnapshot() { return this.#scheduler.snapshot(); }
  closeScheduler() { this.#scheduler.close(); }

  async #scheduled<T>(
    kind: 'query' | 'context' | 'generate',
    request: KnowledgeQueryRequest,
    options: ExecutionOptions | undefined,
    task: (effectiveOptions: ExecutionOptions) => Promise<LorebitOutcome<T>>
  ): Promise<LorebitOutcome<T>> {
    const now = this.#clock.now();
    const defaultDeadlineMilliseconds = kind === 'generate'
      ? this.#limits.generateDeadlineMilliseconds
      : kind === 'context'
        ? this.#limits.contextDeadlineMilliseconds
        : this.#limits.queryDeadlineMilliseconds;
    const defaultDeadline = formatRfc3339Utc(new Date(Date.parse(now) + defaultDeadlineMilliseconds));
    if (!defaultDeadline.ok) throw new TypeError(defaultDeadline.error.summary);
    const trace = createTraceContextSnapshot(options?.trace, now, { traceId: this.#random.hex(16), spanId: this.#random.hex(8) });
    const spanId = this.#random.hex(8);
    const effectiveOptions: ExecutionOptions = {
      ...options,
      deadlineAt: options?.deadlineAt ?? defaultDeadline.value,
      trace: {
        traceparent: `00-${trace.traceId}-${spanId}-${trace.traceFlags}`,
        ...(trace.tracestate === null ? {} : { tracestate: trace.tracestate })
      }
    };
    const startedAt = this.#clock.now();
    const estimatedBytes = new TextEncoder().encode(request.query + (request.trustedDirective ?? '')).byteLength;
    const scheduled = await this.#scheduler.schedule(kind, estimatedBytes, (scheduledOptions) => task(scheduledOptions), effectiveOptions);
    if (!scheduled.ok) {
      const operation = { operationId: this.#ids.next('operation'), kind: 'query' as const };
      await this.#safeMetric('lorebit.runtime.resource_rejections', 1, {
        spaceId: request.spaceId,
        mode: kind,
        code: scheduled.code,
        queued: scheduled.observation.queued,
        inFlight: scheduled.observation.inFlight,
        inFlightBytes: scheduled.observation.inFlightBytes
      });
      await this.#safeSpan({
        schemaVersion: '1.0', traceId: trace.traceId, spanId, parentSpanId: trace.parentSpanId,
        name: `lorebit.${kind}`,
        scope: { spaceId: request.spaceId, operationId: operation.operationId, queryPlanId: null, generationId: null },
        attributes: { ok: false, mode: kind, code: scheduled.code, queued: scheduled.observation.queued, inFlightBytes: scheduled.observation.inFlightBytes, validIncomingTrace: trace.validIncoming },
        startedAt, completedAt: this.#clock.now(), status: 'error'
      });
      return failed(lorebitFailure(scheduled.code, scheduled.summary, scheduled.code === 'resource-saturated', scheduled.retryAfterMs === null ? undefined : { retryAfterMs: scheduled.retryAfterMs }), operation);
    }
    const result = scheduled.value;
    const invalidTraceDiagnostic = options?.trace !== undefined && !trace.validIncoming
      ? diagnostic(
          'trace-carrier-invalid',
          'warning',
          'The incoming trace carrier was invalid and a local trace was created.',
          { affected: ['trace'], guarantees: ['invalid-carrier-not-propagated'] }
        )
      : null;
    const tracedResult: LorebitOutcome<T> = invalidTraceDiagnostic === null
      ? result
      : { ...result, diagnostics: [...result.diagnostics, invalidTraceDiagnostic] };
    await this.#safeSpan({
      schemaVersion: '1.0', traceId: trace.traceId, spanId, parentSpanId: trace.parentSpanId,
      name: `lorebit.${kind}`,
      scope: { spaceId: request.spaceId, operationId: tracedResult.operation.operationId, queryPlanId: tracedResult.ok ? (tracedResult.value as { queryPlan?: { queryPlanId: string } }).queryPlan?.queryPlanId ?? null : null, generationId: tracedResult.ok ? (tracedResult.value as { queryPlan?: { generationId: string } }).queryPlan?.generationId ?? null : null },
      attributes: { ok: tracedResult.ok, mode: kind, queued: scheduled.observation.queued, inFlightBytes: scheduled.observation.inFlightBytes, validIncomingTrace: trace.validIncoming },
      startedAt, completedAt: this.#clock.now(), status: tracedResult.ok ? 'ok' : 'error'
    });
    return tracedResult;
  }

  async #safeMetric(name: string, value: number, attributes: JsonValue): Promise<void> {
    try { await this.#telemetry.recordMetric(name, value, attributes); } catch { /* Telemetry cannot change query outcomes. */ }
  }

  async #safeSpan(span: TelemetrySpan): Promise<void> {
    try { await this.#telemetry.recordSpan(span); } catch { /* Telemetry cannot change query outcomes. */ }
  }
}
