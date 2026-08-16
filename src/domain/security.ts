import type { DigestRef } from '../wire/digest.js';
import type { JsonValue } from '../wire/json-value.js';
import type { Rfc3339Utc } from '../wire/rfc3339.js';

export type SecurityHookPoint =
  | 'beforeQuery'
  | 'beforeIngest'
  | 'afterTransform'
  | 'beforeModelEgress'
  | 'beforeContext'
  | 'beforeGenerate'
  | 'afterGenerate'
  | 'beforeExport';

export type SecurityHookAction = 'pass' | 'normalize' | 'quarantine' | 'redact' | 'block';

export interface SecurityHookRecord {
  readonly hookId: string;
  readonly version: string;
  readonly method: string;
  readonly point: SecurityHookPoint;
  readonly action: SecurityHookAction;
  readonly reason: string;
  readonly evidenceRef: string | null;
  readonly inputDigest: DigestRef;
  readonly outputDigest: DigestRef;
  readonly observedAt: Rfc3339Utc;
}

export interface SecurityPolicy {
  readonly requiredHooks: readonly SecurityHookPoint[];
  readonly dataClassification: 'public' | 'internal' | 'restricted';
  readonly allowedRemoteStages: readonly ('embedding' | 'reranking' | 'generation' | 'transform')[];
  readonly allowedProviderProfiles: readonly string[];
  readonly allowedRegions: readonly string[];
  readonly requireNoTraining: boolean;
  readonly requireNoRetention: boolean;
}

export interface ModelDataBoundary {
  readonly deploymentClass: 'local' | 'remote';
  readonly providerProfile: string;
  readonly region: string | null;
  readonly trainingUse: 'none' | 'declared' | 'unknown';
  readonly retention: 'none' | 'declared' | 'unknown';
  readonly attestationRef: string | null;
}

export interface DataEgressDecision {
  readonly stage: 'embedding' | 'reranking' | 'generation' | 'transform';
  readonly allowed: boolean;
  readonly reason: string;
  readonly providerProfile: string;
  readonly attestationRef: string | null;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = Object.freeze({
  requiredHooks: Object.freeze([]),
  dataClassification: 'public',
  allowedRemoteStages: Object.freeze([]),
  allowedProviderProfiles: Object.freeze([]),
  allowedRegions: Object.freeze([]),
  requireNoTraining: true,
  requireNoRetention: true
});

export function decideDataEgress(
  stage: DataEgressDecision['stage'],
  boundary: ModelDataBoundary,
  policy: SecurityPolicy
): DataEgressDecision {
  if (boundary.deploymentClass === 'local') {
    return { stage, allowed: true, reason: 'local-deployment', providerProfile: boundary.providerProfile, attestationRef: boundary.attestationRef };
  }
  const reasons: string[] = [];
  if (!policy.allowedRemoteStages.includes(stage)) reasons.push('stage-not-allowed');
  if (!policy.allowedProviderProfiles.includes(boundary.providerProfile)) reasons.push('provider-profile-not-allowed');
  if (boundary.region !== null && policy.allowedRegions.length > 0 && !policy.allowedRegions.includes(boundary.region)) reasons.push('region-not-allowed');
  if (policy.requireNoTraining && boundary.trainingUse !== 'none') reasons.push('training-boundary-unverified');
  if (policy.requireNoRetention && boundary.retention !== 'none') reasons.push('retention-boundary-unverified');
  return {
    stage,
    allowed: reasons.length === 0,
    reason: reasons.length === 0 ? 'policy-allowed' : reasons.join(','),
    providerProfile: boundary.providerProfile,
    attestationRef: boundary.attestationRef
  };
}

/** Redacts common secret-bearing provider text before it reaches public diagnostics. */
export function redactDiagnosticText(input: unknown): string {
  const text = typeof input === 'string' ? input : 'Adapter operation failed.';
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;&]+/giu, '$1=[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&#\s]+/giu, '$1[REDACTED]')
    .slice(0, 512);
}

export function securityPolicyFromExtensions(extensions: JsonValue): SecurityPolicy {
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) return DEFAULT_SECURITY_POLICY;
  const candidate = extensions.security;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return DEFAULT_SECURITY_POLICY;
  const hooks = Array.isArray(candidate.requiredHooks)
    ? candidate.requiredHooks.filter((value): value is SecurityHookPoint => typeof value === 'string' && [
        'beforeQuery', 'beforeIngest', 'afterTransform', 'beforeModelEgress', 'beforeContext', 'beforeGenerate', 'afterGenerate', 'beforeExport'
      ].includes(value))
    : [];
  const strings = (value: JsonValue | undefined): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    requiredHooks: hooks,
    dataClassification: ['public', 'internal', 'restricted'].includes(String(candidate.dataClassification))
      ? candidate.dataClassification as SecurityPolicy['dataClassification']
      : 'public',
    allowedRemoteStages: strings(candidate.allowedRemoteStages).filter((value): value is SecurityPolicy['allowedRemoteStages'][number] =>
      ['embedding', 'reranking', 'generation', 'transform'].includes(value)),
    allowedProviderProfiles: strings(candidate.allowedProviderProfiles),
    allowedRegions: strings(candidate.allowedRegions),
    requireNoTraining: candidate.requireNoTraining !== false,
    requireNoRetention: candidate.requireNoRetention !== false
  };
}
