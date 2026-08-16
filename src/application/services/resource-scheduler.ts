import type { ExecutionOptions } from '../commands.js';
import type { Clock } from '../../ports/clock.js';
import type { ResourceObservation, RuntimeResourceLimits } from '../../domain/resources.js';

export type ScheduledOperationKind = ResourceObservation['operationKind'];
type SchedulerLane = 'repository' | 'query' | 'generate' | 'processing' | 'import' | 'rebuild';

const SCHEDULER_LANES: readonly SchedulerLane[] = ['repository', 'query', 'generate', 'processing', 'import', 'rebuild'];

export type ScheduleResult<T> =
  | { readonly ok: true; readonly value: T; readonly observation: ResourceObservation }
  | {
      readonly ok: false;
      readonly code: 'resource-limit-exceeded' | 'resource-saturated' | 'deadline-exceeded' | 'cancelled' | 'runtime-closing';
      readonly summary: string;
      readonly retryAfterMs: number | null;
      readonly observation: ResourceObservation;
    };

interface QueueItem<T> {
  readonly kind: ScheduledOperationKind;
  readonly estimatedBytes: number;
  readonly options: ExecutionOptions;
  readonly task: (options: ExecutionOptions) => Promise<T>;
  readonly resolve: (result: ScheduleResult<T>) => void;
  readonly enqueuedAt: string;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  removeQueuedAbort: (() => void) | null;
}

export class ResourceScheduler {
  readonly #limits: RuntimeResourceLimits;
  readonly #clock: Clock;
  readonly #queues: Record<SchedulerLane, QueueItem<unknown>[]> = { repository: [], query: [], generate: [], processing: [], import: [], rebuild: [] };
  readonly #active: Record<SchedulerLane, number> = { repository: 0, query: 0, generate: 0, processing: 0, import: 0, rebuild: 0 };
  readonly #activeStops = new Set<() => void>();
  #inFlightBytes = 0;
  #closing = false;

  constructor(limits: RuntimeResourceLimits, clock: Clock) {
    this.#limits = limits;
    this.#clock = clock;
  }

  schedule<T>(
    kind: ScheduledOperationKind,
    estimatedBytes: number,
    task: (options: ExecutionOptions) => Promise<T>,
    options: ExecutionOptions = {}
  ): Promise<ScheduleResult<T>> {
    const lane = kind === 'context' ? 'query' : kind;
    const now = this.#clock.now();
    if (options.deadlineAt === undefined) {
      options = {
        ...options,
        deadlineAt: new Date(Date.parse(now) + this.#defaultDeadlineMilliseconds(kind)).toISOString() as import('../../wire/rfc3339.js').Rfc3339Utc
      };
    }
    const observation = (outcome: ResourceObservation['outcome']): ResourceObservation => ({
      operationKind: kind,
      queued: this.#queuedCount(),
      inFlight: this.#activeCount(),
      inFlightBytes: this.#inFlightBytes,
      attempt: 1,
      deadlineAt: options.deadlineAt ?? null,
      startedAt: null,
      completedAt: now,
      outcome
    });
    if (this.#closing) return Promise.resolve({ ok: false, code: 'runtime-closing', summary: 'Resource scheduler is closing.', retryAfterMs: null, observation: observation('failed') });
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0 || estimatedBytes > this.#limits.maxInFlightBytes) return Promise.resolve({ ok: false, code: 'resource-limit-exceeded', summary: 'Estimated in-flight bytes exceed the deterministic limit.', retryAfterMs: null, observation: observation('limit') });
    if (options.signal?.aborted === true) return Promise.resolve({ ok: false, code: 'cancelled', summary: 'Operation was cancelled before scheduling.', retryAfterMs: null, observation: observation('cancelled') });
    if (options.deadlineAt !== undefined && options.deadlineAt <= now) return Promise.resolve({ ok: false, code: 'deadline-exceeded', summary: 'Operation deadline elapsed before scheduling.', retryAfterMs: null, observation: observation('deadline') });
    const queued = this.#queuedCount();
    if (queued >= this.#limits.maxQueuedOperations) return Promise.resolve({ ok: false, code: 'resource-saturated', summary: 'The bounded operation queue is full.', retryAfterMs: 100, observation: observation('saturated') });
    return new Promise<ScheduleResult<T>>((resolve) => {
      const item: QueueItem<T> = { kind, estimatedBytes, options, task, resolve, enqueuedAt: now, deadlineTimer: null, removeQueuedAbort: null };
      this.#queues[lane].push(item as QueueItem<unknown>);
      const removeQueued = (
        code: 'cancelled' | 'deadline-exceeded',
        summary: string,
        outcome: 'cancelled' | 'deadline'
      ) => {
        const index = this.#queues[lane].indexOf(item as QueueItem<unknown>);
        if (index < 0) return;
        this.#queues[lane].splice(index, 1);
        if (item.deadlineTimer !== null) clearTimeout(item.deadlineTimer);
        item.removeQueuedAbort?.();
        resolve({
          ok: false,
          code,
          summary,
          retryAfterMs: null,
          observation: { ...observation(outcome), queued: this.#queuedCount(), completedAt: this.#clock.now() }
        });
        this.#drain(lane);
      };
      const abort = () => removeQueued('cancelled', 'Queued operation was cancelled.', 'cancelled');
      options.signal?.addEventListener('abort', abort, { once: true });
      item.removeQueuedAbort = () => options.signal?.removeEventListener('abort', abort);
      if (options.deadlineAt !== undefined) {
        const delay = Math.max(0, Date.parse(options.deadlineAt) - Date.parse(now));
        item.deadlineTimer = setTimeout(
          () => removeQueued('deadline-exceeded', 'Operation deadline elapsed in queue.', 'deadline'),
          delay
        );
      }
      this.#drain(lane);
    });
  }

  snapshot() {
    return Object.freeze({
      queued: this.#queuedCount(),
      repositoryInFlight: this.#active.repository,
      queryInFlight: this.#active.query,
      generateInFlight: this.#active.generate,
      processingInFlight: this.#active.processing,
      importInFlight: this.#active.import,
      rebuildInFlight: this.#active.rebuild,
      inFlightBytes: this.#inFlightBytes,
      closing: this.#closing
    });
  }

  close(): void {
    this.#closing = true;
    for (const lane of SCHEDULER_LANES) {
      for (const item of this.#queues[lane].splice(0)) {
        if (item.deadlineTimer !== null) clearTimeout(item.deadlineTimer);
        item.removeQueuedAbort?.();
        item.resolve({
          ok: false,
          code: 'runtime-closing',
          summary: 'Queued operation was rejected during close.',
          retryAfterMs: null,
          observation: {
            operationKind: item.kind,
            queued: this.#queuedCount(),
            inFlight: this.#activeCount(),
            inFlightBytes: this.#inFlightBytes,
            attempt: 1,
            deadlineAt: item.options.deadlineAt ?? null,
            startedAt: null,
            completedAt: this.#clock.now(),
            outcome: 'failed'
          }
        });
      }
    }
    for (const stop of [...this.#activeStops]) stop();
  }

  #drain(lane: SchedulerLane): void {
    const limit = this.#laneLimit(lane);
    while (this.#active[lane] < limit && this.#queues[lane].length > 0) {
      const item = this.#queues[lane].shift()!;
      if (item.deadlineTimer !== null) clearTimeout(item.deadlineTimer);
      item.removeQueuedAbort?.();
      const now = this.#clock.now();
      if (item.options.signal?.aborted === true || (item.options.deadlineAt !== undefined && item.options.deadlineAt <= now)) {
        item.resolve({
          ok: false,
          code: item.options.signal?.aborted === true ? 'cancelled' : 'deadline-exceeded',
          summary: item.options.signal?.aborted === true ? 'Operation was cancelled in queue.' : 'Operation deadline elapsed in queue.',
          retryAfterMs: null,
          observation: { operationKind: item.kind, queued: this.#queuedCount(), inFlight: this.#activeCount(), inFlightBytes: this.#inFlightBytes, attempt: 1, deadlineAt: item.options.deadlineAt ?? null, startedAt: null, completedAt: now, outcome: item.options.signal?.aborted === true ? 'cancelled' : 'deadline' }
        });
        continue;
      }
      if (this.#inFlightBytes + item.estimatedBytes > this.#limits.maxInFlightBytes) {
        item.resolve({
          ok: false,
          code: 'resource-saturated',
          summary: 'In-flight byte budget is saturated.',
          retryAfterMs: 100,
          observation: { operationKind: item.kind, queued: this.#queuedCount(), inFlight: this.#activeCount(), inFlightBytes: this.#inFlightBytes, attempt: 1, deadlineAt: item.options.deadlineAt ?? null, startedAt: null, completedAt: now, outcome: 'saturated' }
        });
        continue;
      }
      this.#active[lane] += 1;
      this.#inFlightBytes += item.estimatedBytes;
      const controller = new AbortController();
      let timedOut = false;
      let controlled = false;
      let controlTimer: ReturnType<typeof setTimeout> | null = null;
      let resolveControl!: (value: { readonly type: 'control'; readonly code: 'cancelled' | 'deadline-exceeded'; readonly summary: string; readonly outcome: 'cancelled' | 'deadline' }) => void;
      const control = new Promise<{ readonly type: 'control'; readonly code: 'cancelled' | 'deadline-exceeded'; readonly summary: string; readonly outcome: 'cancelled' | 'deadline' }>((resolve) => { resolveControl = resolve; });
      const stop = (code: 'cancelled' | 'deadline-exceeded', summary: string, outcome: 'cancelled' | 'deadline') => {
        if (controlled) return;
        controlled = true;
        timedOut = code === 'deadline-exceeded';
        controller.abort(code);
        controlTimer = setTimeout(
          () => resolveControl({ type: 'control', code, summary, outcome }),
          this.#limits.cancellationGraceMilliseconds
        );
      };
      const abortActive = () => stop('cancelled', 'Operation was cancelled in flight.', 'cancelled');
      const closeActive = () => stop('cancelled', 'Operation was cancelled because the runtime is closing.', 'cancelled');
      this.#activeStops.add(closeActive);
      item.options.signal?.addEventListener('abort', abortActive, { once: true });
      const deadlineTimer = item.options.deadlineAt === undefined
        ? null
        : setTimeout(
            () => stop('deadline-exceeded', 'Operation deadline elapsed in flight.', 'deadline'),
            Math.max(0, Date.parse(item.options.deadlineAt) - Date.parse(now))
          );
      const effectiveOptions: ExecutionOptions = { ...item.options, signal: controller.signal };
      const task = Promise.resolve()
        .then(() => item.task(effectiveOptions))
        .then(
          (value) => ({ type: 'value' as const, value }),
          () => ({ type: 'error' as const })
        );
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.#activeStops.delete(closeActive);
        this.#active[lane] -= 1;
        this.#inFlightBytes -= item.estimatedBytes;
        this.#drain(lane);
      };
      void Promise.race([task, control]).then((outcome) => {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        if (controlTimer !== null) clearTimeout(controlTimer);
        item.options.signal?.removeEventListener('abort', abortActive);
        if (outcome.type === 'value') {
          item.resolve({
            ok: true,
            value: outcome.value,
            observation: { operationKind: item.kind, queued: this.#queuedCount(), inFlight: this.#activeCount(), inFlightBytes: this.#inFlightBytes, attempt: 1, deadlineAt: item.options.deadlineAt ?? null, startedAt: now, completedAt: this.#clock.now(), outcome: 'completed' }
          });
          release();
          return;
        }
        if (outcome.type === 'control') {
          item.resolve({
            ok: false,
            code: outcome.code,
            summary: outcome.summary,
            retryAfterMs: null,
            observation: { operationKind: item.kind, queued: this.#queuedCount(), inFlight: this.#activeCount(), inFlightBytes: this.#inFlightBytes, attempt: 1, deadlineAt: item.options.deadlineAt ?? null, startedAt: now, completedAt: this.#clock.now(), outcome: outcome.outcome }
          });
          void task.then(() => release());
          return;
        }
        item.resolve({
          ok: false,
          code: timedOut ? 'deadline-exceeded' : controller.signal.aborted ? 'cancelled' : 'resource-limit-exceeded',
          summary: timedOut ? 'Operation deadline elapsed.' : controller.signal.aborted ? 'Operation was cancelled.' : 'Scheduled operation failed.',
          retryAfterMs: null,
          observation: { operationKind: item.kind, queued: this.#queuedCount(), inFlight: this.#activeCount(), inFlightBytes: this.#inFlightBytes, attempt: 1, deadlineAt: item.options.deadlineAt ?? null, startedAt: now, completedAt: this.#clock.now(), outcome: timedOut ? 'deadline' : controller.signal.aborted ? 'cancelled' : 'failed' }
        });
        release();
      });
    }
  }

  #queuedCount(): number {
    return SCHEDULER_LANES.reduce((total, lane) => total + this.#queues[lane].length, 0);
  }

  #activeCount(): number {
    return SCHEDULER_LANES.reduce((total, lane) => total + this.#active[lane], 0);
  }

  #laneLimit(lane: SchedulerLane): number {
    if (lane === 'repository') return this.#limits.repositoryConcurrency;
    if (lane === 'query') return this.#limits.queryConcurrency;
    if (lane === 'generate') return this.#limits.generateConcurrency;
    if (lane === 'processing') return this.#limits.processingConcurrency;
    if (lane === 'import') return this.#limits.importConcurrency;
    return this.#limits.rebuildConcurrency;
  }

  #defaultDeadlineMilliseconds(kind: ScheduledOperationKind): number {
    if (kind === 'repository') return this.#limits.repositoryDeadlineMilliseconds;
    if (kind === 'context') return this.#limits.contextDeadlineMilliseconds;
    if (kind === 'generate') return this.#limits.generateDeadlineMilliseconds;
    if (kind === 'processing') return this.#limits.processingDeadlineMilliseconds;
    if (kind === 'import') return this.#limits.importDeadlineMilliseconds;
    if (kind === 'rebuild') return this.#limits.rebuildDeadlineMilliseconds;
    return this.#limits.queryDeadlineMilliseconds;
  }
}
