import type { PageRequest } from '../queries.js';
import type { Clock } from '../../ports/clock.js';
import type { ContentStore } from '../../ports/content-store.js';
import type { KnowledgeRepository, RepositoryCommitRequest } from '../../ports/knowledge-repository.js';
import { decodeLorebitId, type IdGenerator, type LorebitIdKind, type SpaceId } from '../../domain/ids.js';
import type { ExportPackage, ExportPlan, ImportPlan, ImportReceipt, MigrationPlan, MigrationReceipt } from '../../domain/transfer.js';
import type { KnowledgeSpace, PolicySnapshot } from '../../domain/knowledge-space.js';
import type { Source } from '../../domain/source.js';
import type { ContentUnitVersion } from '../../domain/content-unit.js';
import type { KnowledgeActivation, ProcessingRecipeVersion, RevisionState, RevisionView, SourceRevision } from '../../domain/versions.js';
import type { DeleteReceipt, GenerationValidationReceipt } from '../../domain/index-generation.js';
import type { ProcessingRun } from '../../domain/processing.js';
import { decodeDigestRef, digestBytes, digestCanonicalJson, type DigestRef } from '../../wire/digest.js';
import { decodeJsonValue, type JsonValue } from '../../wire/json-value.js';
import type { ExecutionOptions } from '../commands.js';
import type { SecurityHook } from '../../ports/security-hooks.js';
import { securityPolicyFromExtensions } from '../../domain/security.js';
import { lorebitFailure } from '../../domain/diagnostics.js';
import { executeSecurityHooks } from './query-service.js';

interface TransferServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly contentStore: ContentStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly limits: { readonly importMaxSources: number; readonly importMaxUtf8Bytes: number };
  readonly allowIncrementalExport: boolean;
  readonly requireDryRunBeforeMigration: boolean;
  readonly securityHooks: readonly SecurityHook[];
}

function asWireValue(input: unknown): JsonValue {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) throw new TypeError(decoded.error.summary);
  return decoded.value;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})*$/u.test(value)) return null;
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

async function allPages<T>(read: (page: PageRequest) => Promise<{ readonly items: readonly T[]; readonly nextCursor: string | null }>): Promise<T[]> {
  const values: T[] = [];
  let after: string | undefined;
  do {
    const page = await read(after === undefined ? { limit: 1_000 } : { limit: 1_000, after });
    values.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined);
  return values;
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectedIds(selection: JsonValue, key: string): string[] {
  if (!isRecord(selection) || !isRecord(selection.ids)) throw new TypeError('ExportPlan selection is invalid.');
  const value = selection.ids[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`ExportPlan ${key} selection is invalid.`);
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new TypeError(`ExportPlan ${key} selection contains duplicate identities.`);
  return ids;
}

function selectedString(selection: JsonValue, key: string): string | null {
  if (!isRecord(selection)) throw new TypeError('ExportPlan selection is invalid.');
  const value = selection[key];
  if (value !== null && typeof value !== 'string') throw new TypeError(`ExportPlan ${key} selection is invalid.`);
  return value;
}

function selectedObjectDigests(selection: JsonValue): string[] {
  if (!isRecord(selection) || !Array.isArray(selection.objectDigests)) throw new TypeError('ExportPlan object digest selection is invalid.');
  const values = selection.objectDigests.map((item) => {
    if (!isRecord(item) || typeof item.kind !== 'string' || typeof item.id !== 'string' || typeof item.digest !== 'string') throw new TypeError('ExportPlan object digest selection is invalid.');
    return `${item.kind}\u0000${item.id}\u0000${item.digest}`;
  });
  if (new Set(values).size !== values.length) throw new TypeError('ExportPlan object digest selection contains duplicates.');
  return values.sort();
}

async function loadSelected<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T | null>,
  label: string
): Promise<T[]> {
  const values = await Promise.all(ids.map((id) => read(id)));
  if (values.some((value) => value === null)) throw new TypeError(`Frozen export ${label} selection is no longer resolvable.`);
  return values as T[];
}

function deleteReceiptId(value: DeleteReceipt): string {
  return `${value.generationId}:${value.unitVersionId}`;
}

function remapWireValue<T>(input: T, mappings: ReadonlyMap<string, string>): T {
  if (typeof input === 'string') return (mappings.get(input) ?? input) as T;
  if (Array.isArray(input)) return input.map((item) => remapWireValue(item, mappings)) as T;
  if (typeof input === 'object' && input !== null) {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, remapWireValue(value, mappings)])
    ) as T;
  }
  return input;
}

function assertExecutionActive(options: ExecutionOptions, clock: Clock): void {
  if (options.signal?.aborted === true) throw lorebitFailure('cancelled', 'Transfer operation was cancelled.');
  if (options.deadlineAt !== undefined && options.deadlineAt <= clock.now()) throw lorebitFailure('deadline-exceeded', 'Transfer operation deadline elapsed.');
}

export class TransferService {
  readonly #repository: KnowledgeRepository;
  readonly #contentStore: ContentStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #limits: TransferServiceDependencies['limits'];
  readonly #allowIncrementalExport: boolean;
  readonly #requireDryRunBeforeMigration: boolean;
  readonly #securityHooks: readonly SecurityHook[];
  readonly #validatedMigrationInputs = new Set<string>();

  constructor(dependencies: TransferServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#contentStore = dependencies.contentStore;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#limits = dependencies.limits;
    this.#allowIncrementalExport = dependencies.allowIncrementalExport;
    this.#requireDryRunBeforeMigration = dependencies.requireDryRunBeforeMigration;
    this.#securityHooks = dependencies.securityHooks;
  }

  async planExport(spaceId: SpaceId, options: {
    readonly mode?: 'full' | 'incremental';
    readonly includeContent?: boolean;
    readonly includeDerived?: boolean;
    readonly includeEvents?: boolean;
    readonly includeProvenance?: boolean;
    readonly baseManifestDigest?: DigestRef | null;
    readonly watermark?: string | null;
    readonly dataClassification?: 'public' | 'internal' | 'restricted';
  } = {}): Promise<ExportPlan> {
    const mode = options.mode ?? 'full';
    if (mode === 'incremental' && (!this.#allowIncrementalExport || options.baseManifestDigest == null || options.watermark == null)) throw new TypeError('Incremental export requires a verified base manifest and ordered change cursor capability.');
    if (options.includeDerived === true) throw lorebitFailure('capability-unavailable', 'Derived-artifact export requires an enumerable derived-artifact adapter capability.');
    const [space, activation] = await Promise.all([
      this.#repository.getSpace(spaceId),
      this.#repository.getActiveActivation(spaceId)
    ]);
    if (space === null) throw new TypeError('Export space was not found.');
    const [sources, policies, recipes, generations, runs, activations, importBatches] = await Promise.all([
      allPages((page) => this.#repository.listSources(spaceId, page)),
      allPages((page) => this.#repository.listPolicies(spaceId, page)),
      allPages((page) => this.#repository.listRecipes(spaceId, page)),
      allPages((page) => this.#repository.listGenerations(spaceId, page)),
      allPages((page) => this.#repository.listRuns(spaceId, page)),
      allPages((page) => this.#repository.listActivations(spaceId, page)),
      allPages((page) => this.#repository.listImportBatches(spaceId, page))
    ]);
    const revisions = (await Promise.all(sources.map((source) => allPages((page) => this.#repository.listRevisions(spaceId, source.sourceId, page))))).flat();
    const units = (await Promise.all(revisions.map((revision) => allPages((page) => this.#repository.listContentUnitsForRevision(spaceId, revision.revision.revisionId, page))))).flat();
    const deltaPlanIds = [...new Set(runs.flatMap((run) => run.deltaPlanId === null ? [] : [run.deltaPlanId]))].sort();
    const deltaPlans = await loadSelected(deltaPlanIds, (id) => this.#repository.getDeltaPlan(spaceId, id), 'delta-plan');
    const generationReceipts = (await Promise.all(generations.map((generation) => this.#repository.getGenerationReceipt(spaceId, generation.generationId)))).filter((value): value is GenerationValidationReceipt => value !== null);
    const deleteReceipts = (await Promise.all(generations.map((generation) => this.#repository.listDeleteReceipts(spaceId, generation.generationId)))).flat();
    const events = options.includeEvents === false ? [] : await allPages((page) => this.#repository.listEvents(spaceId, page));
    const currentRecipe = activation === null
      ? await this.#repository.getCurrentRecipe(spaceId)
      : await this.#repository.getRecipe(spaceId, activation.generation.recipeId);
    const frozenObjects: Array<{ readonly kind: string; readonly id: string; readonly value: unknown }> = [
      { kind: 'space', id: space.spaceId, value: space },
      ...policies.map((value) => ({ kind: 'policy', id: value.policyId, value })),
      ...sources.map((value) => ({ kind: 'source', id: value.sourceId, value })),
      ...importBatches.map((value) => ({ kind: 'import-batch', id: value.importBatchId, value })),
      ...revisions.map((value) => ({ kind: 'revision', id: value.revision.revisionId, value })),
      ...units.map((value) => ({ kind: 'content-unit', id: value.unitVersionId, value })),
      ...recipes.map((value) => ({ kind: 'recipe', id: value.recipeId, value })),
      ...runs.map((value) => ({ kind: 'processing-run', id: value.runId, value })),
      ...deltaPlans.map((value) => ({ kind: 'delta-plan', id: value.deltaPlanId, value })),
      ...generations.map((value) => ({ kind: 'generation', id: value.generationId, value })),
      ...generationReceipts.map((value) => ({ kind: 'generation-receipt', id: value.receiptId, value })),
      ...deleteReceipts.map((value) => ({ kind: 'delete-receipt', id: deleteReceiptId(value), value })),
      ...activations.map((value) => ({ kind: 'activation', id: value.activationId, value })),
      ...events.map((value) => ({ kind: 'event', id: value.eventId, value }))
    ];
    const frozenObjectDigests = await Promise.all(frozenObjects.map(async (object) => {
      const digest = await digestCanonicalJson(object.value);
      if (!digest.ok) throw new TypeError(digest.error.summary);
      return { kind: object.kind, id: object.id, digest: digest.value.value };
    }));
    const contentRefs = new Map<string, RevisionView['revision']['snapshot']['content']>();
    for (const revision of revisions) contentRefs.set(revision.revision.snapshot.content.contentId, revision.revision.snapshot.content);
    for (const unit of units) contentRefs.set(unit.text.contentId, unit.text);
    const contentBytes = options.includeContent === false
      ? 0
      : [...contentRefs.values()].reduce((total, ref) => total + ref.byteLength, 0);
    const metadataBytes = new TextEncoder().encode(JSON.stringify(frozenObjects)).byteLength;
    const estimatedUtf8Bytes = Math.min(Number.MAX_SAFE_INTEGER, metadataBytes + (contentBytes * 2));
    const base = {
      schemaVersion: '1.0' as const,
      exportId: this.#ids.next('export'),
      spaceId,
      mode,
      activationId: activation?.activationId ?? null,
      includeContent: options.includeContent ?? true,
      includeDerived: options.includeDerived ?? false,
      includeEvents: options.includeEvents ?? true,
      includeProvenance: options.includeProvenance ?? true,
      baseManifestDigest: options.baseManifestDigest ?? null,
      watermark: options.watermark ?? null,
      dataClassification: options.dataClassification ?? 'internal',
      estimatedUtf8Bytes,
      selection: asWireValue({
        activeSnapshot: true,
        historicalRevisionsForSelectedSources: true,
        activePolicyId: activation?.policyId ?? space.currentPolicyId,
        activeRecipeId: currentRecipe?.recipeId ?? null,
        ids: {
          policies: policies.map((value) => value.policyId).sort(),
          sources: sources.map((value) => value.sourceId).sort(),
          importBatches: importBatches.map((value) => value.importBatchId).sort(),
          revisions: revisions.map((value) => value.revision.revisionId).sort(),
          contentUnits: units.map((value) => value.unitVersionId).sort(),
          recipes: recipes.map((value) => value.recipeId).sort(),
          processingRuns: runs.map((value) => value.runId).sort(),
          deltaPlans: deltaPlanIds,
          generations: generations.map((value) => value.generationId).sort(),
          generationReceipts: generationReceipts.map((value) => value.receiptId).sort(),
          deleteReceipts: deleteReceipts.map(deleteReceiptId).sort(),
          activations: activations.map((value) => value.activationId).sort(),
          events: events.map((value) => value.eventId).sort()
        },
        objectDigests: frozenObjectDigests
      }),
      createdAt: this.#clock.now()
    };
    const digest = await digestCanonicalJson(base);
    if (!digest.ok) throw new TypeError(digest.error.summary);
    return { ...base, planDigest: digest.value };
  }

  async executeExport(plan: ExportPlan, options: ExecutionOptions = {}): Promise<ExportPackage> {
    assertExecutionActive(options, this.#clock);
    const currentPlanDigest = await digestCanonicalJson({
      schemaVersion: plan.schemaVersion, exportId: plan.exportId, spaceId: plan.spaceId, mode: plan.mode, activationId: plan.activationId,
      includeContent: plan.includeContent, includeDerived: plan.includeDerived, includeEvents: plan.includeEvents, includeProvenance: plan.includeProvenance,
      baseManifestDigest: plan.baseManifestDigest, watermark: plan.watermark, dataClassification: plan.dataClassification, estimatedUtf8Bytes: plan.estimatedUtf8Bytes, selection: plan.selection, createdAt: plan.createdAt
    });
    if (!currentPlanDigest.ok || currentPlanDigest.value.value !== plan.planDigest.value) throw new TypeError('ExportPlan digest mismatch.');
    if (plan.mode === 'incremental' && !this.#allowIncrementalExport) throw new TypeError('Incremental export capability is unavailable.');
    if (plan.includeDerived) throw lorebitFailure('capability-unavailable', 'Derived-artifact export requires an enumerable derived-artifact adapter capability.');
    const space = await this.#repository.getSpace(plan.spaceId);
    if (space === null) throw new TypeError('Export space was not found.');
    const policies = await loadSelected(selectedIds(plan.selection, 'policies'), (id) => this.#repository.getPolicy(plan.spaceId, id), 'policy');
    const sources = await loadSelected(selectedIds(plan.selection, 'sources'), (id) => this.#repository.getSource(plan.spaceId, id as Source['sourceId']), 'source');
    const importBatches = await loadSelected(selectedIds(plan.selection, 'importBatches'), (id) => this.#repository.getImportBatch(plan.spaceId, id), 'import-batch');
    const revisions = await loadSelected(selectedIds(plan.selection, 'revisions'), (id) => this.#repository.getRevision(plan.spaceId, id as SourceRevision['revisionId']), 'revision');
    const units = await loadSelected(selectedIds(plan.selection, 'contentUnits'), (id) => this.#repository.getContentUnitVersion(plan.spaceId, id), 'content-unit');
    const recipes = await loadSelected(selectedIds(plan.selection, 'recipes'), (id) => this.#repository.getRecipe(plan.spaceId, id), 'recipe');
    const processingRuns = await loadSelected(selectedIds(plan.selection, 'processingRuns'), (id) => this.#repository.getRun(plan.spaceId, id as ProcessingRun['runId']), 'processing-run');
    const deltaPlans = await loadSelected(selectedIds(plan.selection, 'deltaPlans'), (id) => this.#repository.getDeltaPlan(plan.spaceId, id), 'delta-plan');
    const generations = await loadSelected(selectedIds(plan.selection, 'generations'), (id) => this.#repository.getGeneration(plan.spaceId, id), 'generation');
    const activations = await loadSelected(selectedIds(plan.selection, 'activations'), (id) => this.#repository.getActivation(plan.spaceId, id as KnowledgeActivation['activationId']), 'activation');
    const activePolicyId = selectedString(plan.selection, 'activePolicyId') ?? space.currentPolicyId;
    const activeRecipeId = selectedString(plan.selection, 'activeRecipeId');
    const policy = policies.find((value) => value.policyId === activePolicyId) ?? null;
    const recipe = activeRecipeId === null ? null : recipes.find((value) => value.recipeId === activeRecipeId) ?? null;
    const activation = plan.activationId === null ? null : activations.find((value) => value.activationId === plan.activationId) ?? null;
    if (policy === null) throw new TypeError('Frozen export policy is no longer resolvable.');
    if (activeRecipeId !== null && recipe === null) throw new TypeError('Frozen export recipe is no longer resolvable.');
    if (plan.activationId !== null && activation === null) throw new TypeError('Frozen export activation is no longer resolvable.');
    const expectedGenerationReceiptIds = selectedIds(plan.selection, 'generationReceipts');
    const generationReceipts = (await Promise.all(generations.map((generation) => this.#repository.getGenerationReceipt(plan.spaceId, generation.generationId)))).filter((value): value is GenerationValidationReceipt => value !== null);
    if (JSON.stringify(generationReceipts.map((value) => value.receiptId).sort()) !== JSON.stringify([...expectedGenerationReceiptIds].sort())) throw new TypeError('Frozen export generation-receipt selection changed.');
    const deleteReceipts = (await Promise.all(generations.map((generation) => this.#repository.listDeleteReceipts(plan.spaceId, generation.generationId)))).flat();
    if (JSON.stringify(deleteReceipts.map(deleteReceiptId).sort()) !== JSON.stringify(selectedIds(plan.selection, 'deleteReceipts').sort())) throw new TypeError('Frozen export delete-receipt selection changed.');
    const selectedEventIds = selectedIds(plan.selection, 'events');
    const eventIdSet = new Set(selectedEventIds);
    const events = plan.includeEvents ? (await allPages((page) => this.#repository.listEvents(plan.spaceId, page))).filter((event) => eventIdSet.has(event.eventId)) : [];
    if (events.length !== selectedEventIds.length) throw new TypeError('Frozen export event selection is no longer resolvable.');
    if (activation !== null) {
      const generation = generations.find((value) => value.generationId === activation.generation.generationId);
      const receipt = generationReceipts.find((value) => value.generationId === activation.generation.generationId);
      const run = generation === undefined ? undefined : processingRuns.find((value) => value.runId === generation.runId);
      const deltaPlan = generation === undefined ? undefined : deltaPlans.find((value) => value.deltaPlanId === generation.deltaPlanId);
      if (generation === undefined || receipt === undefined || run === undefined || deltaPlan === undefined || !recipes.some((value) => value.recipeId === generation.recipeId)) {
        throw new TypeError('Frozen active generation dependency closure is incomplete.');
      }
      const revisionIds = new Set(revisions.map((value) => value.revision.revisionId));
      const unitVersionIds = new Set(units.map((value) => value.unitVersionId));
      if (generation.revisionIds.some((id) => !revisionIds.has(id)) || generation.unitVersionIds.some((id) => !unitVersionIds.has(id))) {
        throw new TypeError('Frozen active generation content closure is incomplete.');
      }
    }
    const securityPolicy = securityPolicyFromExtensions(policy.extensions);
    const classificationRank = { public: 0, internal: 1, restricted: 2 } as const;
    if (classificationRank[plan.dataClassification] < classificationRank[securityPolicy.dataClassification]) {
      throw lorebitFailure('access-denied', 'Export classification is lower than the active policy classification.');
    }
    const exportHook = await executeSecurityHooks(
      this.#securityHooks,
      'beforeExport',
      asWireValue({
        exportId: plan.exportId,
        spaceId: plan.spaceId,
        planDigest: plan.planDigest.value,
        dataClassification: plan.dataClassification,
        includeContent: plan.includeContent,
        includeDerived: plan.includeDerived,
        includeEvents: plan.includeEvents,
        includeProvenance: plan.includeProvenance
      }),
      securityPolicy.requiredHooks.includes('beforeExport'),
      this.#clock,
      options
    );
    if (!exportHook.ok) {
      throw lorebitFailure(
        exportHook.code === 'cancelled' ? 'cancelled' : exportHook.code,
        exportHook.code === 'query-blocked' ? 'Export was blocked by the configured security policy.' : 'The required export security hook failed.'
      );
    }
    assertExecutionActive(options, this.#clock);
    const refs = new Map<string, RevisionView['revision']['snapshot']['content']>();
    for (const revision of revisions) refs.set(revision.revision.snapshot.content.contentId, revision.revision.snapshot.content);
    for (const unit of units) refs.set(unit.text.contentId, unit.text);
    const blobs: Array<{ readonly ref: RevisionView['revision']['snapshot']['content']; readonly hex: string }> = [];
    let contentBytes = 0;
    if (plan.includeContent) {
      for (const ref of refs.values()) {
        assertExecutionActive(options, this.#clock);
        const loaded = await this.#contentStore.get(ref);
        if (!loaded.ok) throw new TypeError('Export content reference could not be resolved.');
        contentBytes += loaded.value.byteLength;
        blobs.push({ ref, hex: toHex(loaded.value) });
      }
    }
    const payload = asWireValue({
      space,
      policy,
      policies,
      sources,
      importBatches,
      revisions,
      recipe,
      recipes,
      units,
      processingRuns,
      deltaPlans,
      generations,
      generationReceipts,
      deleteReceipts,
      activation,
      activations,
      events,
      blobs,
      omittedDerived: true,
      provenanceIncluded: plan.includeProvenance
    });
    const contentDigest = await digestCanonicalJson(payload);
    if (!contentDigest.ok) throw new TypeError(contentDigest.error.summary);
    const objects: Array<{ readonly kind: string; readonly id: string; readonly value: unknown }> = [
      { kind: 'space', id: space.spaceId, value: space },
      ...policies.map((value) => ({ kind: 'policy', id: value.policyId, value })),
      ...sources.map((value) => ({ kind: 'source', id: value.sourceId, value })),
      ...importBatches.map((value) => ({ kind: 'import-batch', id: value.importBatchId, value })),
      ...revisions.map((value) => ({ kind: 'revision', id: value.revision.revisionId, value })),
      ...units.map((value) => ({ kind: 'content-unit', id: value.unitVersionId, value })),
      ...recipes.map((value) => ({ kind: 'recipe', id: value.recipeId, value })),
      ...processingRuns.map((value) => ({ kind: 'processing-run', id: value.runId, value })),
      ...deltaPlans.map((value) => ({ kind: 'delta-plan', id: value.deltaPlanId, value })),
      ...generations.map((value) => ({ kind: 'generation', id: value.generationId, value })),
      ...generationReceipts.map((value) => ({ kind: 'generation-receipt', id: value.receiptId, value })),
      ...deleteReceipts.map((value) => ({ kind: 'delete-receipt', id: deleteReceiptId(value), value })),
      ...activations.map((value) => ({ kind: 'activation', id: value.activationId, value })),
      ...events.map((value) => ({ kind: 'event', id: value.eventId, value }))
    ];
    const objectDigests = await Promise.all(objects.map(async (object) => {
      const digest = await digestCanonicalJson(object.value);
      if (!digest.ok) throw new TypeError(digest.error.summary);
      return { kind: object.kind, id: object.id, digest: digest.value };
    }));
    const actualFrozenDigests = objectDigests.map((object) => `${object.kind}\u0000${object.id}\u0000${object.digest.value}`).sort();
    if (JSON.stringify(actualFrozenDigests) !== JSON.stringify(selectedObjectDigests(plan.selection))) throw new TypeError('Frozen export object selection changed after planning.');
    const counts = {
      spaces: 1,
      policies: policies.length,
      sources: sources.length,
      importBatches: importBatches.length,
      revisions: revisions.length,
      contentUnits: units.length,
      recipes: recipes.length,
      processingRuns: processingRuns.length,
      deltaPlans: deltaPlans.length,
      generations: generations.length,
      generationReceipts: generationReceipts.length,
      deleteReceipts: deleteReceipts.length,
      activations: activations.length,
      events: events.length,
      blobs: blobs.length,
      contentBytes
    };
    const manifest = {
      schemaVersion: '1.0' as const, contractVersion: '0.1' as const, runtimePackage: '@devcodex/lorebit' as const,
      exportId: plan.exportId, sourceSpaceId: plan.spaceId, mode: plan.mode, baseManifestDigest: plan.baseManifestDigest,
      objectCounts: counts, objectDigests, tombstones: [],
      omissions: [
        ...(!plan.includeContent ? [{ kind: 'content' as const, reason: 'excluded-by-export-plan' }] : []),
        ...(!plan.includeDerived ? [{ kind: 'derived' as const, reason: 'excluded-by-export-plan' }] : []),
        ...(!plan.includeEvents ? [{ kind: 'events' as const, reason: 'excluded-by-export-plan' }] : []),
        ...(!plan.includeProvenance ? [{ kind: 'provenance' as const, reason: 'excluded-by-export-plan' }] : []),
        { kind: 'credentials' as const, reason: 'never-exported' },
        { kind: 'provider-raw' as const, reason: 'never-exported' }
      ],
      referenceClosureComplete: true, dataClassification: plan.dataClassification,
      securityHooks: exportHook.records,
      diagnosticCodes: exportHook.diagnostics.map((value) => value.code),
      contentDigest: contentDigest.value, createdAt: this.#clock.now()
    };
    const packageDigest = await digestCanonicalJson({ manifest, payload });
    if (!packageDigest.ok) throw new TypeError(packageDigest.error.summary);
    const result: ExportPackage = { schemaVersion: '1.0', manifest, payload, packageDigest: packageDigest.value };
    await this.#verifyPackage(result);
    return result;
  }

  async planImport(value: ExportPackage, targetSpaceId: SpaceId, options: { readonly conflictPolicy?: 'reject' | 'remap' | 'quarantine'; readonly dryRun?: boolean; readonly idMappings?: Readonly<Record<string, string>> } = {}): Promise<ImportPlan> {
    await this.#verifyPackage(value);
    const conflictPolicy = options.conflictPolicy ?? 'reject';
    const idMappings = options.idMappings ?? {};
    if (conflictPolicy !== 'remap' && Object.keys(idMappings).length > 0) throw new TypeError('Explicit ID mappings require the remap conflict policy.');
    const knownIds = new Set(value.manifest.objectDigests.map((item) => item.id));
    const mappedValues = new Set<string>([targetSpaceId]);
    for (const [sourceId, targetId] of Object.entries(idMappings)) {
      const sourceSeparator = sourceId.indexOf('_');
      const targetSeparator = targetId.indexOf('_');
      const sourceKind = sourceId.slice(0, sourceSeparator) as LorebitIdKind;
      const targetKind = targetId.slice(0, targetSeparator) as LorebitIdKind;
      const source = decodeLorebitId(sourceKind, sourceId);
      const target = decodeLorebitId(targetKind, targetId);
      if (sourceId === value.manifest.sourceSpaceId || !knownIds.has(sourceId) || !source.ok || !target.ok || sourceKind !== targetKind || mappedValues.has(targetId)) throw new TypeError('Import ID mapping is unknown, kind-incompatible or colliding.');
      mappedValues.add(targetId);
    }
    const finalIds = value.manifest.objectDigests.map((item) => item.id === value.manifest.sourceSpaceId
      ? targetSpaceId
      : idMappings[item.id] ?? item.id);
    if (new Set(finalIds).size !== finalIds.length) throw new TypeError('Import ID mapping collides with an unchanged package identity.');
    const base = {
      schemaVersion: '1.0' as const, importPlanId: this.#ids.next('import-plan'), sourceSpaceId: value.manifest.sourceSpaceId, targetSpaceId,
      packageDigest: value.packageDigest, conflictPolicy, idMappings, allowNonEmptyTarget: false as const,
      dryRun: options.dryRun ?? true, createdAt: this.#clock.now()
    };
    const digest = await digestCanonicalJson(base);
    if (!digest.ok) throw new TypeError(digest.error.summary);
    return { ...base, planDigest: digest.value };
  }

  async executeImport(plan: ImportPlan, value: ExportPackage, options: ExecutionOptions = {}): Promise<ImportReceipt> {
    await this.#verifyPackage(value);
    assertExecutionActive(options, this.#clock);
    const currentPlanDigest = await digestCanonicalJson({
      schemaVersion: plan.schemaVersion,
      importPlanId: plan.importPlanId,
      sourceSpaceId: plan.sourceSpaceId,
      targetSpaceId: plan.targetSpaceId,
      packageDigest: plan.packageDigest,
      conflictPolicy: plan.conflictPolicy,
      idMappings: plan.idMappings,
      allowNonEmptyTarget: plan.allowNonEmptyTarget,
      dryRun: plan.dryRun,
      createdAt: plan.createdAt
    });
    if (!currentPlanDigest.ok || currentPlanDigest.value.value !== plan.planDigest.value) throw new TypeError('ImportPlan digest mismatch.');
    if (plan.sourceSpaceId !== value.manifest.sourceSpaceId || plan.packageDigest.value !== value.packageDigest.value) throw new TypeError('ImportPlan package identity mismatch.');
    if (await this.#repository.getSpace(plan.targetSpaceId) !== null) return this.#importReceipt(plan, [], [], ['target-not-empty'], 'failed');
    const sourceCount = value.manifest.objectCounts.sources ?? Number.POSITIVE_INFINITY;
    const contentBytes = value.manifest.objectCounts.contentBytes ?? Number.POSITIVE_INFINITY;
    const resourceConflicts = [
      ...(sourceCount > this.#limits.importMaxSources ? [`sources:${sourceCount}>${this.#limits.importMaxSources}`] : []),
      ...(contentBytes > this.#limits.importMaxUtf8Bytes ? [`contentBytes:${contentBytes}>${this.#limits.importMaxUtf8Bytes}`] : [])
    ];
    if (resourceConflicts.length > 0) return this.#importReceipt(plan, [], [], resourceConflicts, 'failed');
    if (!isRecord(value.payload) || !isRecord(value.payload.space) || !isRecord(value.payload.policy) || !Array.isArray(value.payload.sources) || !Array.isArray(value.payload.revisions) || !Array.isArray(value.payload.units) || !Array.isArray(value.payload.blobs)) return this.#importReceipt(plan, [], [], ['payload-shape-invalid'], 'failed');
    const mappings = new Map<string, string>([
      [plan.sourceSpaceId, plan.targetSpaceId],
      ...Object.entries(plan.idMappings)
    ]);
    const remap = <T>(input: T): T => remapWireValue(input, mappings);
    const preparedBlobs: Array<{ readonly ref: Parameters<ContentStore['putImmutable']>[0]['ref']; readonly bytes: Uint8Array }> = [];
    const packagedContentIds = new Set<string>();
    for (const blob of value.payload.blobs) {
      assertExecutionActive(options, this.#clock);
      if (!isRecord(blob) || !isRecord(blob.ref) || typeof blob.hex !== 'string') return this.#importReceipt(plan, [], [], ['blob-invalid'], 'failed');
      const bytes = fromHex(blob.hex);
      const digest = decodeDigestRef(blob.ref.digest);
      if (bytes === null || typeof blob.ref.contentId !== 'string' || typeof blob.ref.byteLength !== 'number' || !digest.ok) return this.#importReceipt(plan, [], [], ['blob-encoding-invalid'], 'failed');
      const actualDigest = await digestBytes(Uint8Array.from(bytes).buffer);
      if (bytes.byteLength !== blob.ref.byteLength || actualDigest.value !== digest.value.value) return this.#importReceipt(plan, [], [], ['blob-digest-mismatch'], 'failed');
      const ref = remap(blob.ref) as unknown as Parameters<ContentStore['putImmutable']>[0]['ref'];
      if (packagedContentIds.has(ref.contentId)) return this.#importReceipt(plan, [], [], ['blob-identity-duplicate'], 'failed');
      packagedContentIds.add(ref.contentId);
      preparedBlobs.push({ ref, bytes });
    }
    const requiredContentRefs = [
      ...value.payload.revisions.flatMap((item) => isRecord(item) && isRecord(item.revision) && isRecord(item.revision.snapshot) && isRecord(item.revision.snapshot.content) ? [item.revision.snapshot.content] : []),
      ...value.payload.units.flatMap((item) => isRecord(item) && isRecord(item.text) ? [item.text] : [])
    ].map((ref) => remap(ref) as unknown as Parameters<ContentStore['putImmutable']>[0]['ref']);
    const missingContent: string[] = [];
    for (const ref of requiredContentRefs) {
      assertExecutionActive(options, this.#clock);
      if (!packagedContentIds.has(ref.contentId) && !(await this.#contentStore.has(ref))) missingContent.push(ref.contentId);
    }
    if (missingContent.length > 0) return this.#importReceipt(plan, [], [], [...new Set(missingContent)].sort().map((contentId) => `content-missing:${contentId}`), 'failed');
    if (plan.dryRun) return this.#importReceipt(plan, [], [{ id: String(value.manifest.exportId), reason: 'dry-run-no-mutation' }], [], 'validated');
    const imported: string[] = [];
    const quarantined: Array<{ readonly id: string; readonly reason: string }> = [];
    const space = remap(value.payload.space) as unknown as KnowledgeSpace;
    const policy = remap(value.payload.policy) as unknown as PolicySnapshot;
    const importedSpace: KnowledgeSpace = { ...space, spaceId: plan.targetSpaceId, sequence: 1, status: 'frozen', currentPolicyId: policy.policyId };
    const importedPolicy: PolicySnapshot = { ...policy, spaceId: plan.targetSpaceId, predecessorPolicyId: null, sequence: 1 };
    if (!(await this.#commit(plan.targetSpaceId, value.packageDigest, 'space-policy', { space: importedSpace, policy: importedPolicy, events: [] }))) return this.#importReceipt(plan, imported, quarantined, ['space-policy-write-failed'], 'partial');
    imported.push(importedSpace.spaceId, importedPolicy.policyId);
    for (const blob of preparedBlobs) {
      assertExecutionActive(options, this.#clock);
      const stored = await this.#contentStore.putImmutable(blob);
      if (!stored.ok) return this.#importReceipt(plan, imported, quarantined, ['blob-write-failed'], 'partial');
    }
    const sources = value.payload.sources.map((item) => remap(item) as unknown as Source);
    for (const source of sources) {
      assertExecutionActive(options, this.#clock);
      const next: Source = { ...source, spaceId: plan.targetSpaceId, sequence: 1, importBatchId: null, currentRevisionId: null };
      if (!(await this.#commit(plan.targetSpaceId, value.packageDigest, `source:${next.sourceId}`, { source: next, events: [] }))) return this.#importReceipt(plan, imported, quarantined, ['source-write-failed'], 'partial');
      imported.push(next.sourceId);
    }
    if (isRecord(value.payload.recipe)) {
      const recipe = remap(value.payload.recipe) as unknown as ProcessingRecipeVersion;
      const next: ProcessingRecipeVersion = { ...recipe, spaceId: plan.targetSpaceId, predecessorRecipeId: null, sequence: 1 };
      if (!(await this.#commit(plan.targetSpaceId, value.packageDigest, `recipe:${next.recipeId}`, { recipe: next, events: [] }))) return this.#importReceipt(plan, imported, quarantined, ['recipe-write-failed'], 'partial');
      imported.push(next.recipeId);
    }
    const revisions = value.payload.revisions.map((item) => remap(item) as unknown as RevisionView).sort((left, right) => left.revision.sequence - right.revision.sequence);
    const bySource = new Map<string, number>();
    const latestRevisionBySource = new Map<string, SourceRevision>();
    for (const view of revisions) {
      assertExecutionActive(options, this.#clock);
      const sequence = (bySource.get(view.revision.sourceId) ?? 0) + 1;
      bySource.set(view.revision.sourceId, sequence);
      const revision: SourceRevision = { ...view.revision, spaceId: plan.targetSpaceId, sequence, predecessorRevisionId: sequence === 1 ? null : view.revision.predecessorRevisionId };
      const state: RevisionState = { ...view.state, spaceId: plan.targetSpaceId, sequence: 1, status: 'draft', reason: 'Imported without activation.' };
      if (!(await this.#commit(plan.targetSpaceId, value.packageDigest, `revision:${revision.revisionId}`, { revision, revisionState: state, events: [] }))) return this.#importReceipt(plan, imported, quarantined, ['revision-write-failed'], 'partial');
      imported.push(revision.revisionId);
      latestRevisionBySource.set(revision.sourceId, revision);
    }
    for (const source of sources) {
      assertExecutionActive(options, this.#clock);
      const latest = latestRevisionBySource.get(source.sourceId);
      if (latest === undefined) continue;
      const current = await this.#repository.getSource(plan.targetSpaceId, source.sourceId);
      if (current === null) return this.#importReceipt(plan, imported, quarantined, ['source-projection-missing'], 'partial');
      const projected: Source = { ...current, currentRevisionId: latest.revisionId, sequence: current.sequence + 1, updatedAt: this.#clock.now() };
      if (!(await this.#commit(plan.targetSpaceId, value.packageDigest, `source-projection:${projected.sourceId}`, { source: projected, events: [] }))) return this.#importReceipt(plan, imported, quarantined, ['source-projection-write-failed'], 'partial');
    }
    const units = value.payload.units.map((item) => remap(item) as unknown as ContentUnitVersion);
    assertExecutionActive(options, this.#clock);
    if (units.length > 0 && !(await this.#commit(plan.targetSpaceId, value.packageDigest, 'content-units', { contentUnits: units, events: [] }))) return this.#importReceipt(plan, imported, quarantined, ['content-unit-write-failed'], 'partial');
    imported.push(...units.map((unit) => unit.unitVersionId));
    const importedPayload = value.payload;
    const quarantineArray = (key: string, idKey: string, reason: string) => {
      const values = importedPayload[key];
      if (!Array.isArray(values)) return;
      for (const item of values) {
        if (!isRecord(item)) continue;
        const id = item[idKey];
        if (typeof id === 'string') quarantined.push({ id, reason });
      }
    };
    if (Array.isArray(value.payload.policies)) {
      for (const item of value.payload.policies) if (isRecord(item) && typeof item.policyId === 'string' && item.policyId !== policy.policyId) quarantined.push({ id: item.policyId, reason: 'historical-policy-preserved-in-package-not-applied' });
    }
    if (Array.isArray(value.payload.recipes)) {
      const activeRecipeId = isRecord(value.payload.recipe) ? value.payload.recipe.recipeId : null;
      for (const item of value.payload.recipes) if (isRecord(item) && typeof item.recipeId === 'string' && item.recipeId !== activeRecipeId) quarantined.push({ id: item.recipeId, reason: 'historical-recipe-preserved-in-package-not-applied' });
    }
    quarantineArray('importBatches', 'importBatchId', 'import-batch-preserved-in-package-not-replayed');
    quarantineArray('processingRuns', 'runId', 'processing-run-preserved-in-package-not-resumed');
    quarantineArray('deltaPlans', 'deltaPlanId', 'delta-plan-preserved-in-package-not-executed');
    quarantineArray('generations', 'generationId', 'generation-preserved-in-package-not-activated');
    quarantineArray('generationReceipts', 'receiptId', 'generation-receipt-preserved-in-package-for-validation');
    quarantineArray('activations', 'activationId', 'activation-never-imported-implicitly');
    if (Array.isArray(value.payload.deleteReceipts) && value.payload.deleteReceipts.length > 0) quarantined.push({ id: 'delete-receipts', reason: 'delete-receipts-preserved-in-package-not-replayed' });
    if (Array.isArray(value.payload.events) && value.payload.events.length > 0) quarantined.push({ id: 'events', reason: 'audit-events-preserved-in-package-not-replayed' });
    const openedSpace: KnowledgeSpace = { ...importedSpace, status: 'open', sequence: importedSpace.sequence + 1, updatedAt: this.#clock.now() };
    assertExecutionActive(options, this.#clock);
    if (!(await this.#commit(plan.targetSpaceId, value.packageDigest, 'open-imported-space', { space: openedSpace, events: [] }))) return this.#importReceipt(plan, imported, quarantined, ['target-open-write-failed'], 'partial');
    return this.#importReceipt(plan, imported, quarantined, [], 'imported');
  }

  async planMigration(sourceSchema: string, targetSchema: string, input: JsonValue, options: { readonly dryRun?: boolean; readonly requiresMaintenance?: boolean } = {}): Promise<MigrationPlan> {
    if (!/^1\.\d+$/u.test(sourceSchema) || !/^1\.\d+$/u.test(targetSchema)) throw new TypeError('Unknown schema major is not migratable by v0.1.');
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    const inputDigest = await digestCanonicalJson(input);
    if (!inputDigest.ok) throw new TypeError(inputDigest.error.summary);
    const base = {
      schemaVersion: '1.0', migrationId: this.#ids.next('migration'), sourceSchema, targetSchema, dryRun: options.dryRun ?? true,
      requiresSnapshot: true, affectedObjects: Array.isArray(input) ? input.length : 1, estimatedBytes: bytes,
      forwardSteps: ['verify-input-digest', 'apply-versioned-codec', 'verify-output-checksum'],
      rollbackSteps: ['restore-snapshot'], rollForwardBoundary: 2, requiresMaintenance: options.requiresMaintenance ?? false,
      inputDigest: inputDigest.value, createdAt: this.#clock.now()
    };
    const planDigest = await digestCanonicalJson(base);
    if (!planDigest.ok) throw new TypeError(planDigest.error.summary);
    return { ...base, schemaVersion: '1.0', planDigest: planDigest.value };
  }

  async executeMigration(plan: MigrationPlan, input: JsonValue, failAtStep: number | null = null, options: ExecutionOptions = {}): Promise<MigrationReceipt> {
    assertExecutionActive(options, this.#clock);
    const currentPlanDigest = await digestCanonicalJson({
      schemaVersion: plan.schemaVersion,
      migrationId: plan.migrationId,
      sourceSchema: plan.sourceSchema,
      targetSchema: plan.targetSchema,
      dryRun: plan.dryRun,
      requiresSnapshot: plan.requiresSnapshot,
      affectedObjects: plan.affectedObjects,
      estimatedBytes: plan.estimatedBytes,
      forwardSteps: plan.forwardSteps,
      rollbackSteps: plan.rollbackSteps,
      rollForwardBoundary: plan.rollForwardBoundary,
      requiresMaintenance: plan.requiresMaintenance,
      inputDigest: plan.inputDigest,
      createdAt: plan.createdAt
    });
    if (!currentPlanDigest.ok || currentPlanDigest.value.value !== plan.planDigest.value) throw new TypeError('MigrationPlan digest mismatch.');
    const digest = await digestCanonicalJson(input);
    if (!digest.ok || digest.value.value !== plan.inputDigest.value) throw new TypeError('Migration input digest mismatch.');
    const validationKey = `${plan.sourceSchema}\u0000${plan.targetSchema}\u0000${digest.value.value}`;
    if (!plan.dryRun && this.#requireDryRunBeforeMigration && !this.#validatedMigrationInputs.has(validationKey)) {
      return { schemaVersion: '1.0', migrationId: plan.migrationId, completedSteps: [], checksum: digest.value, result: 'failed', completedAt: this.#clock.now() };
    }
    const completed: number[] = [];
    for (let step = 1; step <= plan.forwardSteps.length; step += 1) {
      assertExecutionActive(options, this.#clock);
      if (failAtStep === step) {
        const result = step <= plan.rollForwardBoundary ? 'rolled-back' : 'roll-forward-required';
        return { schemaVersion: '1.0', migrationId: plan.migrationId, completedSteps: completed, checksum: digest.value, result, completedAt: this.#clock.now() };
      }
      completed.push(step);
    }
    if (plan.dryRun) this.#validatedMigrationInputs.add(validationKey);
    else this.#validatedMigrationInputs.delete(validationKey);
    return { schemaVersion: '1.0', migrationId: plan.migrationId, completedSteps: completed, checksum: digest.value, result: plan.dryRun ? 'dry-run' : 'migrated', completedAt: this.#clock.now() };
  }

  async #verifyPackage(value: ExportPackage): Promise<void> {
    if (value.schemaVersion !== '1.0' || value.manifest.schemaVersion !== '1.0' || value.manifest.contractVersion !== '0.1' || value.manifest.runtimePackage !== '@devcodex/lorebit') throw new TypeError('Unsupported export package or contract major.');
    const content = await digestCanonicalJson(value.payload);
    if (!content.ok || content.value.value !== value.manifest.contentDigest.value) throw new TypeError('Export payload digest mismatch.');
    const digest = await digestCanonicalJson({ manifest: value.manifest, payload: value.payload });
    if (!digest.ok || digest.value.value !== value.packageDigest.value) throw new TypeError('Export package digest mismatch.');
    if (!value.manifest.referenceClosureComplete) throw new TypeError('Export reference closure is incomplete.');
    if (
      !isRecord(value.payload) ||
      !isRecord(value.payload.space) ||
      !isRecord(value.payload.policy) ||
      !Array.isArray(value.payload.policies) ||
      !Array.isArray(value.payload.sources) ||
      !Array.isArray(value.payload.importBatches) ||
      !Array.isArray(value.payload.revisions) ||
      !Array.isArray(value.payload.units) ||
      !Array.isArray(value.payload.recipes) ||
      !Array.isArray(value.payload.processingRuns) ||
      !Array.isArray(value.payload.deltaPlans) ||
      !Array.isArray(value.payload.generations) ||
      !Array.isArray(value.payload.generationReceipts) ||
      !Array.isArray(value.payload.deleteReceipts) ||
      !Array.isArray(value.payload.activations) ||
      !Array.isArray(value.payload.events) ||
      !Array.isArray(value.payload.blobs)
    ) throw new TypeError('Export payload shape is invalid.');
    let contentBytes = 0;
    const packagedContentIds = new Set<string>();
    for (const blob of value.payload.blobs) {
      if (!isRecord(blob) || !isRecord(blob.ref) || typeof blob.hex !== 'string' || typeof blob.ref.contentId !== 'string' || typeof blob.ref.byteLength !== 'number') throw new TypeError('Export blob shape is invalid.');
      const bytes = fromHex(blob.hex);
      const expectedDigest = decodeDigestRef(blob.ref.digest);
      if (bytes === null || !expectedDigest.ok) throw new TypeError('Export blob encoding or digest is invalid.');
      const actualDigest = await digestBytes(Uint8Array.from(bytes).buffer);
      if (bytes.byteLength !== blob.ref.byteLength || actualDigest.value !== expectedDigest.value.value) throw new TypeError('Export blob digest or byte length mismatch.');
      if (packagedContentIds.has(blob.ref.contentId)) throw new TypeError('Export blob identity is duplicated.');
      packagedContentIds.add(blob.ref.contentId);
      contentBytes += bytes.byteLength;
    }
    const requiredContentIds = [
      ...value.payload.revisions.flatMap((item) => isRecord(item) && isRecord(item.revision) && isRecord(item.revision.snapshot) && isRecord(item.revision.snapshot.content) && typeof item.revision.snapshot.content.contentId === 'string' ? [item.revision.snapshot.content.contentId] : []),
      ...value.payload.units.flatMap((item) => isRecord(item) && isRecord(item.text) && typeof item.text.contentId === 'string' ? [item.text.contentId] : [])
    ];
    const contentOmitted = value.manifest.omissions.some((entry) => entry.kind === 'content');
    if (!contentOmitted && requiredContentIds.some((contentId) => !packagedContentIds.has(contentId))) throw new TypeError('Export content reference closure is incomplete.');
    if (contentOmitted && value.payload.blobs.length > 0) throw new TypeError('Export content omission conflicts with packaged blobs.');
    if (value.payload.omittedDerived !== true || !value.manifest.omissions.some((entry) => entry.kind === 'derived')) throw new TypeError('Export derived-artifact omission is not explicit.');
    const expectedCounts: Readonly<Record<string, number>> = {
      spaces: 1,
      policies: value.payload.policies.length,
      sources: value.payload.sources.length,
      importBatches: value.payload.importBatches.length,
      revisions: value.payload.revisions.length,
      contentUnits: value.payload.units.length,
      recipes: value.payload.recipes.length,
      processingRuns: value.payload.processingRuns.length,
      deltaPlans: value.payload.deltaPlans.length,
      generations: value.payload.generations.length,
      generationReceipts: value.payload.generationReceipts.length,
      deleteReceipts: value.payload.deleteReceipts.length,
      activations: value.payload.activations.length,
      events: value.payload.events.length,
      blobs: value.payload.blobs.length,
      contentBytes
    };
    for (const [name, expected] of Object.entries(expectedCounts)) {
      if (value.manifest.objectCounts[name] !== expected) throw new TypeError(`Export manifest ${name} count mismatch.`);
    }
    const objectValues: Array<{ readonly kind: string; readonly id: string; readonly value: JsonValue }> = [];
    const add = (kind: string, id: JsonValue | undefined, object: JsonValue) => {
      if (typeof id !== 'string') throw new TypeError(`Export ${kind} identity is invalid.`);
      objectValues.push({ kind, id, value: object });
    };
    add('space', value.payload.space.spaceId, value.payload.space);
    for (const policy of value.payload.policies) {
      if (!isRecord(policy)) throw new TypeError('Export policy shape is invalid.');
      add('policy', policy.policyId, policy);
    }
    for (const source of value.payload.sources) {
      if (!isRecord(source)) throw new TypeError('Export source shape is invalid.');
      add('source', source.sourceId, source);
    }
    for (const importBatch of value.payload.importBatches) {
      if (!isRecord(importBatch)) throw new TypeError('Export import batch shape is invalid.');
      add('import-batch', importBatch.importBatchId, importBatch);
    }
    for (const revision of value.payload.revisions) {
      if (!isRecord(revision) || !isRecord(revision.revision) || !isRecord(revision.revision.snapshot) || !isRecord(revision.revision.snapshot.content) || typeof revision.revision.snapshot.content.contentId !== 'string') throw new TypeError('Export revision shape is invalid.');
      add('revision', revision.revision.revisionId, revision);
    }
    for (const unit of value.payload.units) {
      if (!isRecord(unit) || !isRecord(unit.text) || typeof unit.text.contentId !== 'string') throw new TypeError('Export content unit shape is invalid.');
      add('content-unit', unit.unitVersionId, unit);
    }
    for (const recipe of value.payload.recipes) {
      if (!isRecord(recipe)) throw new TypeError('Export recipe shape is invalid.');
      add('recipe', recipe.recipeId, recipe);
    }
    for (const run of value.payload.processingRuns) {
      if (!isRecord(run)) throw new TypeError('Export processing run shape is invalid.');
      add('processing-run', run.runId, run);
    }
    for (const deltaPlan of value.payload.deltaPlans) {
      if (!isRecord(deltaPlan)) throw new TypeError('Export delta plan shape is invalid.');
      add('delta-plan', deltaPlan.deltaPlanId, deltaPlan);
    }
    for (const generation of value.payload.generations) {
      if (!isRecord(generation)) throw new TypeError('Export generation shape is invalid.');
      add('generation', generation.generationId, generation);
    }
    for (const receipt of value.payload.generationReceipts) {
      if (!isRecord(receipt)) throw new TypeError('Export generation receipt shape is invalid.');
      add('generation-receipt', receipt.receiptId, receipt);
    }
    for (const receipt of value.payload.deleteReceipts) {
      if (!isRecord(receipt) || typeof receipt.generationId !== 'string' || typeof receipt.unitVersionId !== 'string') throw new TypeError('Export delete receipt shape is invalid.');
      add('delete-receipt', `${receipt.generationId}:${receipt.unitVersionId}`, receipt);
    }
    for (const activation of value.payload.activations) {
      if (!isRecord(activation)) throw new TypeError('Export activation shape is invalid.');
      add('activation', activation.activationId, activation);
    }
    for (const event of value.payload.events) {
      if (!isRecord(event)) throw new TypeError('Export event shape is invalid.');
      add('event', event.eventId, event);
    }
    const objectKeys = objectValues.map((object) => `${object.kind}\u0000${object.id}`);
    if (new Set(objectKeys).size !== objectKeys.length) throw new TypeError('Export object inventory contains duplicate identities.');
    const idsFor = (kind: string) => new Set(objectValues.filter((object) => object.kind === kind).map((object) => object.id));
    const policyIds = idsFor('policy');
    const sourceIds = idsFor('source');
    const importBatchIds = idsFor('import-batch');
    const revisionIds = idsFor('revision');
    const unitVersionIds = idsFor('content-unit');
    const recipeIds = idsFor('recipe');
    const runIds = idsFor('processing-run');
    const deltaPlanIds = idsFor('delta-plan');
    const generationIds = idsFor('generation');
    const receiptIds = idsFor('generation-receipt');
    const activationIds = idsFor('activation');
    const requireRef = (record: { [key: string]: JsonValue }, key: string, allowed: ReadonlySet<string>, label: string, nullable = true) => {
      const reference = record[key];
      if (reference === null && nullable) return;
      if (typeof reference !== 'string' || !allowed.has(reference)) throw new TypeError(`Export ${label} reference closure is incomplete.`);
    };
    const requireRefs = (record: { [key: string]: JsonValue }, key: string, allowed: ReadonlySet<string>, label: string) => {
      const references = record[key];
      if (!Array.isArray(references) || references.some((reference) => typeof reference !== 'string' || !allowed.has(reference))) throw new TypeError(`Export ${label} reference closure is incomplete.`);
    };
    requireRef(value.payload.space, 'currentPolicyId', policyIds, 'space policy', false);
    for (const item of value.payload.policies) {
      const policy = item as { [key: string]: JsonValue };
      requireRef(policy, 'predecessorPolicyId', policyIds, 'policy predecessor');
    }
    for (const item of value.payload.sources) {
      const source = item as { [key: string]: JsonValue };
      requireRef(source, 'parentSourceId', sourceIds, 'source parent');
      requireRef(source, 'importBatchId', importBatchIds, 'source import batch');
      requireRef(source, 'currentRevisionId', revisionIds, 'source current revision');
    }
    for (const item of value.payload.importBatches) requireRefs(item as { [key: string]: JsonValue }, 'sourceIds', sourceIds, 'import batch sources');
    for (const item of value.payload.revisions) {
      const view = item as { [key: string]: JsonValue };
      const revision = view.revision;
      if (!isRecord(revision)) throw new TypeError('Export revision shape is invalid.');
      requireRef(revision, 'sourceId', sourceIds, 'revision source', false);
      requireRef(revision, 'predecessorRevisionId', revisionIds, 'revision predecessor');
      requireRef(revision, 'replacesRevisionId', revisionIds, 'revision replacement');
      requireRefs(revision, 'derivedFromRevisionIds', revisionIds, 'revision derivation');
    }
    for (const item of value.payload.recipes) requireRef(item as { [key: string]: JsonValue }, 'predecessorRecipeId', recipeIds, 'recipe predecessor');
    for (const item of value.payload.processingRuns) {
      const run = item as { [key: string]: JsonValue };
      requireRef(run, 'sourceId', sourceIds, 'processing run source', false);
      requireRef(run, 'revisionId', revisionIds, 'processing run revision', false);
      requireRef(run, 'recipeId', recipeIds, 'processing run recipe', false);
      requireRef(run, 'generationId', generationIds, 'processing run generation', false);
      requireRef(run, 'baseGenerationId', generationIds, 'processing run base generation');
      requireRef(run, 'deltaPlanId', deltaPlanIds, 'processing run delta plan');
    }
    for (const item of value.payload.deltaPlans) {
      const deltaPlan = item as { [key: string]: JsonValue };
      requireRef(deltaPlan, 'runId', runIds, 'delta plan run', false);
      requireRef(deltaPlan, 'revisionId', revisionIds, 'delta plan revision', false);
      requireRef(deltaPlan, 'baseGenerationId', generationIds, 'delta plan base generation');
    }
    for (const item of value.payload.generations) {
      const generation = item as { [key: string]: JsonValue };
      requireRef(generation, 'parentGenerationId', generationIds, 'generation parent');
      requireRef(generation, 'runId', runIds, 'generation run', false);
      requireRef(generation, 'recipeId', recipeIds, 'generation recipe', false);
      requireRef(generation, 'deltaPlanId', deltaPlanIds, 'generation delta plan', false);
      requireRefs(generation, 'revisionIds', revisionIds, 'generation revisions');
      requireRefs(generation, 'unitVersionIds', unitVersionIds, 'generation units');
    }
    for (const item of value.payload.generationReceipts) {
      const receipt = item as { [key: string]: JsonValue };
      requireRef(receipt, 'generationId', generationIds, 'generation receipt', false);
      if (typeof receipt.receiptId !== 'string' || !receiptIds.has(receipt.receiptId)) throw new TypeError('Export generation receipt identity is incomplete.');
    }
    for (const item of value.payload.deleteReceipts) {
      const receipt = item as { [key: string]: JsonValue };
      requireRef(receipt, 'generationId', generationIds, 'delete receipt generation', false);
      requireRef(receipt, 'unitVersionId', unitVersionIds, 'delete receipt unit', false);
    }
    for (const item of value.payload.activations) {
      const activation = item as { [key: string]: JsonValue };
      requireRef(activation, 'predecessorActivationId', activationIds, 'activation predecessor');
      requireRef(activation, 'policyId', policyIds, 'activation policy', false);
      const generation = activation.generation;
      if (!isRecord(generation)) throw new TypeError('Export activation generation reference is invalid.');
      requireRef(generation, 'generationId', generationIds, 'activation generation', false);
      requireRef(generation, 'recipeId', recipeIds, 'activation recipe', false);
      const revisions = activation.revisions;
      if (!Array.isArray(revisions)) throw new TypeError('Export activation revision closure is incomplete.');
      for (const reference of revisions) {
        if (!isRecord(reference)) throw new TypeError('Export activation revision closure is incomplete.');
        requireRef(reference, 'sourceId', sourceIds, 'activation source', false);
        requireRef(reference, 'revisionId', revisionIds, 'activation revision', false);
      }
    }
    const assertAlias = async (alias: { [key: string]: JsonValue }, values: JsonValue[], idKey: string, label: string) => {
      const id = alias[idKey];
      const selected = typeof id === 'string' ? values.find((item) => isRecord(item) && item[idKey] === id) : undefined;
      if (!isRecord(selected)) throw new TypeError(`Export active ${label} is absent from the version inventory.`);
      const [left, right] = await Promise.all([digestCanonicalJson(alias), digestCanonicalJson(selected)]);
      if (!left.ok || !right.ok || left.value.value !== right.value.value) throw new TypeError(`Export active ${label} alias does not match its versioned object.`);
    };
    await assertAlias(value.payload.policy, value.payload.policies, 'policyId', 'policy');
    if (value.payload.recipe !== null) {
      if (!isRecord(value.payload.recipe)) throw new TypeError('Export active recipe shape is invalid.');
      await assertAlias(value.payload.recipe, value.payload.recipes, 'recipeId', 'recipe');
    }
    if (value.payload.activation !== null) {
      if (!isRecord(value.payload.activation)) throw new TypeError('Export active activation shape is invalid.');
      await assertAlias(value.payload.activation, value.payload.activations, 'activationId', 'activation');
      const generationRef = value.payload.activation.generation;
      if (!isRecord(generationRef) || typeof generationRef.generationId !== 'string') throw new TypeError('Export active generation reference is invalid.');
      const activeGeneration = value.payload.generations.find((item) => isRecord(item) && item.generationId === generationRef.generationId);
      const activeReceipt = value.payload.generationReceipts.find((item) => isRecord(item) && item.generationId === generationRef.generationId);
      if (!isRecord(activeGeneration) || !isRecord(activeReceipt) || activeGeneration.recipeId !== generationRef.recipeId) throw new TypeError('Export active generation validation closure is incomplete.');
    }
    const expectedDigests = await Promise.all(objectValues.map(async (object) => {
      const objectDigest = await digestCanonicalJson(object.value);
      if (!objectDigest.ok) throw new TypeError(objectDigest.error.summary);
      return `${object.kind}\u0000${object.id}\u0000${objectDigest.value.value}`;
    }));
    const actualDigests = value.manifest.objectDigests.map((object) => `${object.kind}\u0000${object.id}\u0000${object.digest.value}`);
    if (JSON.stringify(expectedDigests.sort()) !== JSON.stringify(actualDigests.sort())) throw new TypeError('Export object digest inventory mismatch.');
  }

  async #commit(spaceId: SpaceId, digest: DigestRef, key: string, writes: RepositoryCommitRequest['writes']): Promise<boolean> {
    const operationId = this.#ids.next('operation');
    const committed = await this.#repository.commit({
      spaceId,
      intent: 'import-staging',
      expected: {},
      operation: { spaceId, operationId, idempotencyKey: `transfer:${key}`, commandDigest: digest, outcome: asWireValue({ kind: 'transfer-import', key }), committedAt: this.#clock.now() },
      writes
    });
    return committed.ok;
  }

  async #importReceipt(plan: ImportPlan, imported: readonly string[], quarantined: readonly { readonly id: string; readonly reason: string }[], conflicts: readonly string[], status: ImportReceipt['status']): Promise<ImportReceipt> {
    const remapped = { [plan.sourceSpaceId]: plan.targetSpaceId, ...plan.idMappings };
    const digest = await digestCanonicalJson({ planId: plan.importPlanId, imported, remapped, quarantined, conflicts, status });
    if (!digest.ok) throw new TypeError(digest.error.summary);
    return { schemaVersion: '1.0', importPlanId: plan.importPlanId, targetSpaceId: plan.targetSpaceId, imported, remapped, quarantined, conflicts, activated: false, integrityDigest: digest.value, status, completedAt: this.#clock.now() };
  }
}
