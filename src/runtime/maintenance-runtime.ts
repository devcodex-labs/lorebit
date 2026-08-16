import type {
  ActivateGenerationCommand,
  BuildGenerationCommand,
  DurableCommandEnvelope,
  ExecutionOptions,
  RetireGenerationCommand,
  ValidateGenerationCommand
} from '../application/commands.js';
import {
  GenerationService,
  type GenerationActivationResult,
  type GenerationBuildResult,
  type GenerationValidationResult
} from '../application/services/generation-service.js';
import type { QuerySnapshot } from '../domain/activation.js';
import { lorebitFailure } from '../domain/diagnostics.js';
import type { GenerationValidationReceipt, IndexGeneration } from '../domain/index-generation.js';
import type { GenerationId, SpaceId } from '../domain/ids.js';
import { failed, successful, type LorebitOutcome } from '../domain/outcomes.js';
import type { KnowledgeRepository } from '../ports/knowledge-repository.js';

export type MaintenanceCommand =
  | BuildGenerationCommand
  | ValidateGenerationCommand
  | ActivateGenerationCommand
  | RetireGenerationCommand;

export type MaintenanceMutation =
  | GenerationBuildResult
  | GenerationValidationResult
  | GenerationActivationResult
  | IndexGeneration;

export class MaintenanceRuntime {
  readonly #service: GenerationService;
  readonly #repository: KnowledgeRepository;

  constructor(service: GenerationService, repository: KnowledgeRepository) {
    this.#service = service;
    this.#repository = repository;
  }

  execute<P extends MaintenanceCommand>(
    envelope: DurableCommandEnvelope<P>,
    options?: ExecutionOptions
  ): Promise<LorebitOutcome<MaintenanceMutation>> {
    switch (envelope.payload.type) {
      case 'generation.build':
        return this.#service.build(
          envelope as DurableCommandEnvelope<BuildGenerationCommand>,
          options
        );
      case 'generation.validate':
        return this.#service.validate(
          envelope as DurableCommandEnvelope<ValidateGenerationCommand>
        );
      case 'generation.activate':
        return this.#service.activate(
          envelope as DurableCommandEnvelope<ActivateGenerationCommand>
        );
      case 'generation.retire':
        return this.#service.retire(
          envelope as DurableCommandEnvelope<RetireGenerationCommand>
        );
    }
  }

  estimateBytes(envelope: DurableCommandEnvelope<MaintenanceCommand>): Promise<number> {
    return this.#service.estimateBytes(envelope);
  }

  async getGeneration(spaceId: SpaceId, generationId: GenerationId): Promise<LorebitOutcome<IndexGeneration>> {
    const value = await this.#repository.getGeneration(spaceId, generationId);
    const operation = { operationId: `operation_query-${generationId}` as import('../domain/ids.js').OperationId, kind: 'query' as const };
    return value === null
      ? failed(lorebitFailure('not-found', 'IndexGeneration was not found in this space.'), operation)
      : successful(value, operation);
  }

  async getGenerationReceipt(
    spaceId: SpaceId,
    generationId: GenerationId
  ): Promise<LorebitOutcome<GenerationValidationReceipt>> {
    const value = await this.#repository.getGenerationReceipt(spaceId, generationId);
    const operation = { operationId: `operation_receipt-${generationId}` as import('../domain/ids.js').OperationId, kind: 'query' as const };
    return value === null
      ? failed(lorebitFailure('not-found', 'GenerationValidationReceipt was not found.'), operation)
      : successful(value, operation);
  }

  async getQuerySnapshot(spaceId: SpaceId): Promise<LorebitOutcome<QuerySnapshot>> {
    const value = await this.#repository.getQuerySnapshot(spaceId);
    const operation = { operationId: `operation_query-${spaceId}` as import('../domain/ids.js').OperationId, kind: 'query' as const };
    return value === null
      ? failed(lorebitFailure('processing-incomplete', 'No active KnowledgeActivation exists.'), operation)
      : successful(value, operation);
  }
}
