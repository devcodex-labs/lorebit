import type { JsonValue } from '../../wire/json-value.js';
import { digestCanonicalJson } from '../../wire/digest.js';
import type { Clock } from '../../ports/clock.js';
import type { DerivedArtifactStore } from '../../ports/derived-artifact-store.js';
import type { KeywordIndex } from '../../ports/keyword-index.js';
import type { KnowledgeRepository } from '../../ports/knowledge-repository.js';
import type { TelemetrySink } from '../../ports/telemetry.js';
import type { VectorIndex } from '../../ports/vector-index.js';
import type { GenerationId, IdGenerator, SpaceId } from '../../domain/ids.js';
import type { ImpactChangeKind, ImpactItem, ImpactReport, RebuildPlan } from '../../domain/impact.js';
import { lorebitFailure, type LorebitFailureCode } from '../../domain/diagnostics.js';
import type { RecoveryExecutionReceipt, RecoveryPlan, RecoveryStep } from '../../domain/recovery.js';
import type { ExecutionOptions } from '../commands.js';

function assertExecutionActive(options: ExecutionOptions, clock: Clock): void {
  if (options.signal?.aborted === true) throw lorebitFailure('cancelled', 'Recovery operation was cancelled.');
  if (options.deadlineAt !== undefined && options.deadlineAt <= clock.now()) throw lorebitFailure('deadline-exceeded', 'Recovery operation deadline elapsed.');
}

interface RecoveryServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly vectorIndex: VectorIndex;
  readonly keywordIndex?: KeywordIndex;
  readonly derivedArtifacts?: DerivedArtifactStore;
  readonly telemetry: TelemetrySink;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface GenerationAuditResult {
  readonly status: 'passed' | 'failed';
  readonly probes: readonly { readonly name: string; readonly expected: JsonValue; readonly actual: JsonValue; readonly passed: boolean }[];
  readonly impact: ImpactReport | null;
  readonly recovery: RecoveryPlan | null;
}

export class RecoveryService {
  readonly #repository: KnowledgeRepository;
  readonly #vectorIndex: VectorIndex;
  readonly #keywordIndex: KeywordIndex | undefined;
  readonly #derivedArtifacts: DerivedArtifactStore | undefined;
  readonly #telemetry: TelemetrySink;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #impacts = new Map<string, ImpactReport>();

  constructor(dependencies: RecoveryServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#vectorIndex = dependencies.vectorIndex;
    this.#keywordIndex = dependencies.keywordIndex;
    this.#derivedArtifacts = dependencies.derivedArtifacts;
    this.#telemetry = dependencies.telemetry;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async auditGeneration(spaceId: SpaceId, generationId: GenerationId, options: ExecutionOptions = {}): Promise<GenerationAuditResult> {
    assertExecutionActive(options, this.#clock);
    const [generation, receipt, vectorCount, vectorManifest, keywordCount, keywordManifest] = await Promise.all([
      this.#repository.getGeneration(spaceId, generationId),
      this.#repository.getGenerationReceipt(spaceId, generationId),
      this.#vectorIndex.count(spaceId, generationId),
      this.#vectorIndex.manifest(spaceId, generationId),
      this.#keywordIndex?.count(spaceId, generationId) ?? Promise.resolve(null),
      this.#keywordIndex?.manifest(spaceId, generationId) ?? Promise.resolve(null)
    ]);
    assertExecutionActive(options, this.#clock);
    const expectedUnits = generation?.unitVersionIds ?? [];
    const probes = [
      { name: 'generation-present', expected: true, actual: generation !== null, passed: generation !== null },
      { name: 'receipt-fresh', expected: true, actual: receipt !== null && receipt.status === 'passed' && receipt.validUntil > this.#clock.now(), passed: receipt !== null && receipt.status === 'passed' && receipt.validUntil > this.#clock.now() },
      { name: 'vector-count', expected: expectedUnits.length, actual: vectorCount?.ok === true ? vectorCount.value : -1, passed: vectorCount?.ok === true && vectorCount.value === expectedUnits.length },
      { name: 'vector-manifest', expected: expectedUnits.slice().sort(), actual: vectorManifest?.ok === true ? vectorManifest.value.slice().sort() : [], passed: vectorManifest?.ok === true && JSON.stringify(vectorManifest.value.slice().sort()) === JSON.stringify(expectedUnits.slice().sort()) },
      { name: 'keyword-count', expected: this.#keywordIndex === undefined ? null : expectedUnits.length, actual: keywordCount === null ? null : keywordCount.ok ? keywordCount.value : -1, passed: this.#keywordIndex === undefined || (keywordCount !== null && keywordCount.ok && keywordCount.value === expectedUnits.length) },
      { name: 'keyword-manifest', expected: this.#keywordIndex === undefined ? null : expectedUnits.slice().sort(), actual: keywordManifest === null ? null : keywordManifest.ok ? keywordManifest.value.slice().sort() : [], passed: this.#keywordIndex === undefined || (keywordManifest !== null && keywordManifest.ok && JSON.stringify(keywordManifest.value.slice().sort()) === JSON.stringify(expectedUnits.slice().sort())) }
    ] as const;
    const failed = probes.filter((probe) => !probe.passed);
    try {
      await this.#telemetry.recordMetric('lorebit.generation.integrity_failures', failed.length, { spaceId, generationId, probeCount: probes.length });
    } catch {
      // Integrity evidence remains authoritative when the observational sink is unavailable.
    }
    if (failed.length === 0) return { status: 'passed', probes, impact: null, recovery: null };
    const impact = await this.planImpact(spaceId, 'integrity', generationId, failed.map((probe) => probe.name));
    return { status: 'failed', probes, impact, recovery: this.planRecovery(spaceId, 'generation-invalid', impact) };
  }

  async planImpact(
    spaceId: SpaceId,
    changeKind: ImpactChangeKind,
    changeRef: string,
    failedProbes: readonly string[] = []
  ): Promise<ImpactReport> {
    const snapshot = await this.#repository.getQuerySnapshot(spaceId);
    const generation = snapshot === null ? null : await this.#repository.getGeneration(spaceId, snapshot.generationId);
    const items: ImpactItem[] = [];
    for (const revision of snapshot?.revisions ?? []) items.push({ artifactKind: 'revision', artifactId: revision.revisionId, disposition: changeKind === 'integrity' ? 'reusable' : 'affected', reason: `${changeKind}-change`, lineage: [revision.sourceId, revision.revisionId] });
    for (const unit of generation?.unitVersionIds ?? []) {
      items.push({ artifactKind: 'content-unit', artifactId: unit, disposition: changeKind === 'source' || changeKind === 'withdraw' ? 'affected' : 'reusable', reason: `${changeKind}-change`, lineage: [generation!.generationId, unit] });
      items.push({ artifactKind: 'embedding', artifactId: `${generation!.generationId}:${unit}`, disposition: ['model', 'recipe', 'integrity'].includes(changeKind) ? 'invalidated' : 'reusable', reason: `${changeKind}-change`, lineage: [unit, generation!.generationId] });
      items.push({ artifactKind: 'citation', artifactId: `${generation!.generationId}:${unit}`, disposition: ['source', 'access', 'withdraw', 'integrity'].includes(changeKind) ? 'invalidated' : 'reusable', reason: `${changeKind}-change`, lineage: [unit, generation!.generationId] });
    }
    items.push({ artifactKind: 'index', artifactId: generation?.generationId ?? 'none', disposition: ['model', 'recipe', 'index', 'integrity'].includes(changeKind) ? 'invalidated' : 'affected', reason: failedProbes.length === 0 ? `${changeKind}-change` : failedProbes.join(','), lineage: generation === null ? [] : [generation.generationId] });
    items.push({ artifactKind: 'context', artifactId: `${spaceId}:materialized-contexts`, disposition: ['source', 'policy', 'access', 'withdraw', 'integrity'].includes(changeKind) ? 'invalidated' : 'affected', reason: `${changeKind}-change`, lineage: snapshot === null ? [] : [snapshot.activationId, snapshot.generationId] });
    items.push({ artifactKind: 'cache', artifactId: `${spaceId}:derived-cache`, disposition: ['source', 'policy', 'recipe', 'model', 'index', 'access', 'withdraw', 'integrity'].includes(changeKind) ? 'invalidated' : 'affected', reason: `${changeKind}-change`, lineage: snapshot === null ? [] : [snapshot.activationId, snapshot.generationId] });
    items.push({ artifactKind: 'access-guarantee', artifactId: `${spaceId}:access`, disposition: ['policy', 'access', 'withdraw', 'integrity'].includes(changeKind) ? 'invalidated' : 'reusable', reason: `${changeKind}-change`, lineage: snapshot === null ? [] : [snapshot.policyId] });
    items.push({ artifactKind: 'result-guarantee', artifactId: `${spaceId}:result`, disposition: changeKind === 'integrity' ? 'invalidated' : 'affected', reason: `${changeKind}-change`, lineage: snapshot === null ? [] : [snapshot.activationId, snapshot.generationId, snapshot.policyId] });
    items.push({ artifactKind: 'default-query', artifactId: spaceId, disposition: changeKind === 'integrity' ? 'invalidated' : 'affected', reason: `${changeKind}-change`, lineage: snapshot === null ? [] : [snapshot.activationId, snapshot.generationId] });
    const input = { spaceId, changeKind, changeRef, activeGenerationId: snapshot?.generationId ?? null, items };
    const inputDigest = await digestCanonicalJson(input);
    if (!inputDigest.ok) throw new TypeError(inputDigest.error.summary);
    const report: ImpactReport = {
      schemaVersion: '1.0',
      impactId: this.#ids.next('impact'),
      spaceId,
      changeKind,
      changeRef,
      activeGenerationId: snapshot?.generationId ?? null,
      items,
      currentGuarantees: changeKind === 'integrity' ? ['canonical-history', 'old-activation-identity'] : ['canonical-history', 'active-snapshot-until-rebuild'],
      lostGuarantees: changeKind === 'integrity' ? ['index-integrity', 'default-query-safety'] : ['fresh-derived-artifacts'],
      requiresRebuild: items.some((item) => item.disposition === 'invalidated' || item.disposition === 'affected'),
      requiresMaintenance: changeKind === 'integrity' && snapshot !== null,
      inputDigest: inputDigest.value,
      createdAt: this.#clock.now()
    };
    this.#impacts.set(report.impactId, report);
    return report;
  }

  planRebuild(impact: ImpactReport): RebuildPlan {
    const actionable = impact.items.filter((item) => item.disposition !== 'reusable');
    return {
      schemaVersion: '1.0',
      planId: `rebuild:${impact.impactId}`,
      impactId: impact.impactId,
      spaceId: impact.spaceId,
      priority: impact.lostGuarantees.includes('default-query-safety') ? 'critical' : 'normal',
      batches: [
        { batchId: 'invalidate', action: 'invalidate', artifactIds: actionable.filter((item) => ['citation', 'context', 'cache', 'default-query'].includes(item.artifactKind)).map((item) => item.artifactId), preconditions: { activeGenerationId: impact.activeGenerationId } },
        { batchId: 'rebuild', action: 'reindex', artifactIds: actionable.filter((item) => ['content-unit', 'embedding', 'index'].includes(item.artifactKind)).map((item) => item.artifactId), preconditions: { impactDigest: impact.inputDigest.value } },
        { batchId: 'verify', action: 'verify', artifactIds: impact.activeGenerationId === null ? [] : [impact.activeGenerationId], preconditions: { required: ['count', 'manifest', 'visibility', 'locator'] } }
      ],
      status: 'planned',
      completionCriteria: ['new shadow generation validated', 'all invalidation receipts complete', 'active pointer switched atomically'],
      rollbackPoint: impact.activeGenerationId ?? 'no-active-generation',
      createdAt: this.#clock.now()
    };
  }

  planRecovery(spaceId: SpaceId, failureCode: LorebitFailureCode, impact: ImpactReport | null): RecoveryPlan {
    const steps: RecoveryStep[] = [];
    const add = (action: RecoveryStep['action'], summary: string, automatic: boolean, preservesActive: boolean) => steps.push({ order: steps.length + 1, action, summary, automatic, preconditions: {}, preservesActive });
    if (failureCode === 'receipt-stale') add('refresh-receipt', 'Refresh capability or generation validation evidence.', false, true);
    else if (failureCode === 'model-incompatible') add('replace-adapter', 'Configure a model/index combination with compatible fingerprints.', false, true);
    else if (failureCode === 'citation-invalid') add('reprocess', 'Reprocess the affected revision and locator mapping.', false, true);
    else if (failureCode === 'state-conflict') add('retry', 'Reload expected state and re-plan the operation.', false, true);
    else if (failureCode === 'generation-invalid' || failureCode === 'integrity-check-failed') {
      add('maintenance', 'Reject or fall back default queries while integrity is unproven.', true, true);
      add('rebuild', 'Build and validate a new shadow generation.', false, true);
      add('abandon-candidate', 'Abandon the unverifiable candidate if rebuilding cannot complete.', false, true);
    } else add('manual-review', 'Inspect the redacted diagnostics and choose an explicit recovery action.', false, true);
    return {
      schemaVersion: '1.0', recoveryId: this.#ids.next('recovery'), spaceId, failureCode,
      impactId: impact?.impactId ?? null,
      currentGuarantees: impact?.currentGuarantees ?? ['canonical-history'],
      unavailableGuarantees: impact?.lostGuarantees ?? [],
      steps, status: 'planned', createdAt: this.#clock.now()
    };
  }

  async executeRecovery(plan: RecoveryPlan, options: ExecutionOptions = {}): Promise<RecoveryExecutionReceipt> {
    const executedSteps: number[] = [];
    let deletedDerivedArtifacts = 0;
    let failedStep: number | null = null;
    for (const step of plan.steps) {
      assertExecutionActive(options, this.#clock);
      if (!step.automatic) continue;
      if (step.action === 'maintenance' && this.#derivedArtifacts !== undefined && plan.impactId !== null) {
        const impact = this.#impacts.get(plan.impactId);
        const lineageRefs = new Set<string>([
          plan.impactId,
          ...(impact === undefined ? [] : [
            impact.changeRef,
            ...(impact.activeGenerationId === null ? [] : [impact.activeGenerationId]),
            ...impact.items.flatMap((item) => [item.artifactId, ...item.lineage])
          ])
        ]);
        for (const lineageRef of lineageRefs) {
          assertExecutionActive(options, this.#clock);
          const invalidated = await this.#derivedArtifacts.invalidateLineage(plan.spaceId, lineageRef, this.#clock.now());
          assertExecutionActive(options, this.#clock);
          if (!invalidated.ok) {
            failedStep = step.order;
            break;
          }
          deletedDerivedArtifacts += invalidated.value.filter((receipt) => receipt.deleted).length;
        }
      }
      if (failedStep !== null) break;
      executedSteps.push(step.order);
    }
    return {
      schemaVersion: '1.0', recoveryId: plan.recoveryId, executedSteps, failedStep,
      result: failedStep !== null ? 'partial' : plan.steps.some((step) => !step.automatic) ? 'partial' : executedSteps.length > 0 ? 'succeeded' : 'partial', activeStatePreserved: true,
      details: { manualStepsRemaining: plan.steps.filter((step) => !step.automatic).map((step) => step.order), deletedDerivedArtifacts },
      completedAt: this.#clock.now()
    };
  }
}
