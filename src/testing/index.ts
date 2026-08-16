import type { JsonValue } from '../wire/json-value.js';

export const WIRE_FIXTURES = Object.freeze({
  canonicalObject: {
    input: { nested: { z: false, y: null }, b: 1, a: 'é' } satisfies JsonValue,
    canonical: '{"a":"é","b":1,"nested":{"y":null,"z":false}}',
    sha256: '192a6e56f9400d77f5f6f3c35e5bae2569b2b25dc812ba55de5975e73830faf4'
  },
  instant: '2026-08-13T05:00:00.000Z'
});

export { FakeClock } from './fake-clock.js';
export { DeterministicIdGenerator } from './deterministic-id-generator.js';
export { InMemoryContentStore } from './in-memory-content-store.js';
export { InMemoryKnowledgeRepository } from './in-memory-knowledge-repository.js';
export { RecordingEventSink } from './recording-event-sink.js';
export { PassThroughTransformer } from './pass-through-transformer.js';
export { DeterministicEmbeddingModel } from './deterministic-embedding-model.js';
export { InMemoryVectorIndex } from './in-memory-vector-index.js';
export { InMemoryKeywordIndex } from './in-memory-keyword-index.js';
export { DeterministicTokenCounter } from './deterministic-token-counter.js';
export { DeterministicReranker } from './deterministic-reranker.js';
export {
  ScriptedSecurityHook,
  type ScriptedSecurityDecision
} from './scripted-security-hook.js';
export { ScriptedLanguageModel } from './scripted-language-model.js';
export { InMemoryDerivedArtifactStore } from './in-memory-derived-artifact-store.js';
export { RecordingTelemetry } from './recording-telemetry.js';
export { SeededRandom } from './seeded-random.js';
