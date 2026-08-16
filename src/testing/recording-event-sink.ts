import type { LifecycleEvent } from '../domain/events.js';
import type { EventSink, EventSinkPublishResult } from '../ports/event-sink.js';

export class RecordingEventSink implements EventSink {
  readonly #events: LifecycleEvent[] = [];
  #closed = false;
  #failure: EventSinkPublishResult | null = null;

  get events(): readonly LifecycleEvent[] {
    return structuredClone(this.#events);
  }

  failNext(summary = 'Scripted event sink failure.'): void {
    this.#failure = { ok: false, retryable: true, summary };
  }

  async publish(events: readonly LifecycleEvent[]): Promise<EventSinkPublishResult> {
    if (this.#closed) {
      return { ok: false, retryable: false, summary: 'Event sink is closed.' };
    }
    if (this.#failure !== null) {
      const failure = this.#failure;
      this.#failure = null;
      return failure;
    }
    this.#events.push(...structuredClone(events));
    return { ok: true, retryable: false, summary: 'Events recorded.' };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
