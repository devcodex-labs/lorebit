import type { LifecycleEvent } from '../domain/events.js';

export interface EventSinkPublishResult {
  readonly ok: boolean;
  readonly retryable: boolean;
  readonly summary: string;
}

export interface EventSink {
  publish(events: readonly LifecycleEvent[]): Promise<EventSinkPublishResult>;
  close(): Promise<void>;
}

export function createNoopEventSink(): EventSink {
  return {
    async publish(): Promise<EventSinkPublishResult> {
      return { ok: true, retryable: false, summary: 'Events accepted by no-op sink.' };
    },
    async close(): Promise<void> {}
  };
}
