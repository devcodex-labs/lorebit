import type {
  CancelProcessingRunCommand,
  DurableCommandEnvelope,
  ExecutionOptions,
  ResumeProcessingCommand,
  RunProcessingCommand
} from '../application/commands.js';
import {
  ProcessingService,
  type ProcessingRunResult
} from '../application/services/processing-service.js';
import type { DeltaPlan } from '../domain/delta-plan.js';
import { lorebitFailure } from '../domain/diagnostics.js';
import type { RunId, SpaceId } from '../domain/ids.js';
import { failed, successful, type LorebitOutcome } from '../domain/outcomes.js';
import type { ProcessingRun } from '../domain/processing.js';
import type { KnowledgeRepository } from '../ports/knowledge-repository.js';

export type IngestCommand = RunProcessingCommand | ResumeProcessingCommand | CancelProcessingRunCommand;
export type IngestMutation = ProcessingRunResult | ProcessingRun;

export class IngestRuntime {
  readonly #service: ProcessingService;
  readonly #repository: KnowledgeRepository;

  constructor(service: ProcessingService, repository: KnowledgeRepository) {
    this.#service = service;
    this.#repository = repository;
  }

  execute<P extends IngestCommand>(
    envelope: DurableCommandEnvelope<P>,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<IngestMutation>> {
    switch (envelope.payload.type) {
      case 'processing.run':
        return this.#service.run(
          envelope as DurableCommandEnvelope<RunProcessingCommand>,
          options
        );
      case 'processing.resume':
        return this.#service.resume(
          envelope as DurableCommandEnvelope<ResumeProcessingCommand>,
          options
        );
      case 'processing.cancel':
        return this.#service.cancel(
          envelope as DurableCommandEnvelope<CancelProcessingRunCommand>
        );
    }
  }

  estimateBytes(envelope: DurableCommandEnvelope<IngestCommand>): Promise<number> {
    return this.#service.estimateBytes(envelope);
  }

  async getRun(spaceId: SpaceId, runId: RunId): Promise<LorebitOutcome<ProcessingRun>> {
    const value = await this.#repository.getRun(spaceId, runId);
    const operation = { operationId: `operation_query-${runId}` as import('../domain/ids.js').OperationId, kind: 'query' as const };
    return value === null
      ? failed(lorebitFailure('not-found', 'ProcessingRun was not found in this space.'), operation)
      : successful(value, operation);
  }

  async getDeltaPlan(spaceId: SpaceId, deltaPlanId: string): Promise<LorebitOutcome<DeltaPlan>> {
    const value = await this.#repository.getDeltaPlan(spaceId, deltaPlanId);
    const operation = { operationId: `operation_query-${deltaPlanId}` as import('../domain/ids.js').OperationId, kind: 'query' as const };
    return value === null
      ? failed(lorebitFailure('not-found', 'DeltaPlan was not found in this space.'), operation)
      : successful(value, operation);
  }
}
