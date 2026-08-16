import type { ExecutionOptions } from '../application/commands.js';
import type { SecurityHookPoint } from '../domain/security.js';
import type { SecurityHook, SecurityHookInput, SecurityHookResult } from '../ports/security-hooks.js';

export type ScriptedSecurityDecision =
  | SecurityHookResult
  | ((input: SecurityHookInput, options: ExecutionOptions) => SecurityHookResult | Promise<SecurityHookResult>);

export class ScriptedSecurityHook implements SecurityHook {
  readonly descriptor;
  readonly capabilities;
  readonly calls: SecurityHookInput[] = [];
  readonly #script: Partial<Record<SecurityHookPoint, ScriptedSecurityDecision>>;
  #closed = false;

  constructor(
    points: readonly SecurityHookPoint[],
    script: Partial<Record<SecurityHookPoint, ScriptedSecurityDecision>> = {},
    hookId = 'lorebit-testing-security-hook'
  ) {
    this.descriptor = Object.freeze({
      kind: 'security-hook' as const,
      hookId,
      name: 'ScriptedSecurityHook',
      version: '0.1',
      method: 'scripted-deterministic',
      deploymentFingerprint: `testing:${hookId}:default`,
      testingOnly: true
    });
    this.capabilities = Object.freeze({
      points: Object.freeze([...points]),
      actions: Object.freeze(['pass', 'normalize', 'quarantine', 'redact', 'block'] as const)
    });
    this.#script = script;
  }

  async execute(input: SecurityHookInput, options: ExecutionOptions = {}): Promise<SecurityHookResult> {
    this.calls.push(structuredClone(input));
    if (this.#closed) return { ok: false, code: 'hook-failure', summary: 'Security hook is closed.', retryable: false };
    if (options.signal?.aborted === true) return { ok: false, code: 'cancelled', summary: 'Security hook was cancelled.', retryable: false };
    const decision = this.#script[input.point];
    if (typeof decision === 'function') return decision(input, options);
    return decision ?? { ok: true, action: 'pass', reason: 'script-default-pass', output: input.payload, evidenceRef: null };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
