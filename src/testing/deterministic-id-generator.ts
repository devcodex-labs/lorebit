import {
  createLorebitId,
  type IdGenerator,
  type LorebitId,
  type LorebitIdKind
} from '../domain/ids.js';

export class DeterministicIdGenerator implements IdGenerator {
  readonly #counters = new Map<LorebitIdKind, number>();
  readonly #namespace: string;

  constructor(namespace = 'fixture') {
    if (!/^[A-Za-z0-9][A-Za-z0-9.~-]{0,24}$/.test(namespace)) {
      throw new TypeError('Deterministic id namespace contains unsupported characters.');
    }
    this.#namespace = namespace;
  }

  next<K extends LorebitIdKind>(kind: K): LorebitId<K> {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return createLorebitId(kind, `${this.#namespace}.${String(next).padStart(6, '0')}`);
  }
}
