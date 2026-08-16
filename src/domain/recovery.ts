import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';
import type { ImpactId, RecoveryId, SpaceId } from './ids.js';
import type { LorebitFailureCode } from './diagnostics.js';

export type RecoveryActionKind = 'retry' | 'reprocess' | 'rebuild' | 'replace-adapter' | 'refresh-receipt' | 'maintenance' | 'manual-review' | 'abandon-candidate' | 'rollback' | 'roll-forward';

export interface RecoveryStep {
  readonly order: number;
  readonly action: RecoveryActionKind;
  readonly summary: string;
  readonly automatic: boolean;
  readonly preconditions: JsonValue;
  readonly preservesActive: boolean;
}

export interface RecoveryPlan {
  readonly schemaVersion: '1.0';
  readonly recoveryId: RecoveryId;
  readonly spaceId: SpaceId;
  readonly failureCode: LorebitFailureCode;
  readonly impactId: ImpactId | null;
  readonly currentGuarantees: readonly string[];
  readonly unavailableGuarantees: readonly string[];
  readonly steps: readonly RecoveryStep[];
  readonly status: 'planned' | 'running' | 'succeeded' | 'failed' | 'abandoned';
  readonly createdAt: Rfc3339Utc;
}

export interface RecoveryExecutionReceipt {
  readonly schemaVersion: '1.0';
  readonly recoveryId: RecoveryId;
  readonly executedSteps: readonly number[];
  readonly failedStep: number | null;
  readonly result: 'succeeded' | 'partial' | 'failed';
  readonly activeStatePreserved: boolean;
  readonly details: JsonValue;
  readonly completedAt: Rfc3339Utc;
}
