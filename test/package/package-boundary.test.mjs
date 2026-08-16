import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('F99 package metadata exposes only root and testing without runtime dependencies', async () => {
  const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.name, '@devcodex/lorebit');
  assert.equal(metadata.private, true);
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.engines.node, '>=22');
  assert.deepEqual(Object.keys(metadata.exports), ['.', './testing']);
  assert.equal(metadata.dependencies, undefined);
  assert.deepEqual(metadata.files, ['dist', 'README.md', 'LICENSE', 'CHANGELOG.md']);
});

test('F99 public imports are side-effect free and internal subpaths stay encapsulated', async () => {
  assert.equal(Number(process.versions.node.split('.')[0]) >= 22, true);
  const globals = new Set(Reflect.ownKeys(globalThis));
  const root = await import('@devcodex/lorebit');
  const testing = await import('@devcodex/lorebit/testing');
  assert.equal(root.LOREBIT_CONTRACT_VERSION, '0.1');
  assert.equal(typeof root.createLorebit, 'function');
  assert.equal(typeof root.createEvaluationModule, 'function');
  assert.equal(typeof root.defineGenerationModule, 'function');
  assert.equal(typeof root.defineImportExportModule, 'function');
  assert.equal(typeof testing.InMemoryKnowledgeRepository, 'function');
  assert.equal(typeof testing.RecordingTelemetry, 'function');
  assert.equal('LifecycleRuntime' in root, false);
  assert.equal('LifecycleService' in root, false);
  assert.equal('QueryRuntime' in root, false);
  assert.deepEqual([...Reflect.ownKeys(globalThis)].filter((key) => !globals.has(key)), []);
  for (const specifier of [
    '@devcodex/lorebit/dist/index.js',
    '@devcodex/lorebit/domain/ids.js',
    '@devcodex/lorebit/ports/knowledge-repository.js',
    '@devcodex/lorebit/runtime/create-lorebit.js',
    '@devcodex/lorebit/testing/in-memory-knowledge-repository.js'
  ]) {
    await assert.rejects(import(specifier), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  }
});
