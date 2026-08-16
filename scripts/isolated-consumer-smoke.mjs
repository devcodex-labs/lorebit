import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runNpm(args, cwd) {
  const explicitCli = argument('--npm-cli');
  const npmExecPath = explicitCli ?? process.env.npm_execpath ?? null;
  if (npmExecPath?.endsWith('.js')) return run(process.execPath, [npmExecPath, ...args], { cwd });
  const command = argument('--npm-command') ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (process.platform !== 'win32') return run(command, args, { cwd });
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', command, ...args], { cwd });
}

async function visibleTree(root) {
  const entries = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      entries.push(relative);
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), relative);
    }
  }
  await visit(root, '');
  return entries.sort();
}

const tarballValue = argument('--tarball');
const consumerValue = argument('--consumer');
assert.notEqual(tarballValue, null, '--tarball is required.');
assert.notEqual(consumerValue, null, '--consumer is required.');
assert.equal(Number(process.versions.node.split('.')[0]) >= 22, true, `Node ${process.versions.node} is below the package engine.`);

const tarball = resolve(tarballValue);
const consumer = resolve(consumerValue);
const existing = await readdir(consumer).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
assert.equal(existing.length, 0, `Consumer directory must be new or empty: ${consumer}`);
await mkdir(consumer, { recursive: true });
await writeFile(resolve(consumer, 'package.json'), `${JSON.stringify({ name: 'lorebit-isolated-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`);
runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], consumer);

await writeFile(resolve(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
const before = new Set(Reflect.ownKeys(globalThis));
const root = await import('@devcodex/lorebit');
const testing = await import('@devcodex/lorebit/testing');
assert.equal(root.LOREBIT_CONTRACT_VERSION, '0.1');
assert.equal(typeof root.createLorebit, 'function');
assert.equal(typeof root.defineGenerationModule, 'function');
assert.equal(typeof testing.InMemoryKnowledgeRepository, 'function');
assert.equal(typeof testing.ScriptedLanguageModel, 'function');
assert.equal(root.createLorebitId('space', 'consumer'), 'space_consumer');
await assert.rejects(import('@devcodex/lorebit/dist/index.js'), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
await assert.rejects(import('@devcodex/lorebit/runtime/create-lorebit.js'), (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
assert.deepEqual([...Reflect.ownKeys(globalThis)].filter((key) => !before.has(key)), []);
`);
await writeFile(resolve(consumer, 'consumer.ts'), `
import { createLorebitId, decodeRfc3339Utc, type SpaceId, type TelemetrySink } from '@devcodex/lorebit';
import { FakeClock, InMemoryKnowledgeRepository } from '@devcodex/lorebit/testing';
const spaceId: SpaceId = createLorebitId('space', 'typed-consumer');
const instant = decodeRfc3339Utc('2026-08-13T00:00:00.000Z');
if (!instant.ok) throw new Error(instant.error.summary);
const clock = new FakeClock(instant.value);
const repository = new InMemoryKnowledgeRepository();
const telemetry: TelemetrySink | null = null;
void [spaceId, clock, repository, telemetry];
`);
await writeFile(resolve(consumer, 'tsconfig.json'), `${JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false },
  include: ['consumer.ts']
}, null, 2)}\n`);

const beforeSmoke = await visibleTree(consumer);
const nodeExecutable = argument('--node') ?? process.execPath;
run(nodeExecutable, ['smoke.mjs'], { cwd: consumer });
const afterSmoke = await visibleTree(consumer);
assert.deepEqual(afterSmoke, beforeSmoke, 'Importing the package created consumer-visible side effects.');

const tscExecutable = argument('--tsc') ?? (process.platform === 'win32'
  ? resolve(projectRoot, 'node_modules/@typescript/typescript-win32-x64/lib/tsc.exe')
  : resolve(projectRoot, 'node_modules/.bin/tsc'));
run(tscExecutable, ['-p', 'tsconfig.json'], { cwd: consumer, shell: process.platform === 'win32' && tscExecutable.endsWith('.cmd') });

const installedPackage = JSON.parse(await readFile(resolve(consumer, 'node_modules/@devcodex/lorebit/package.json'), 'utf8'));
const tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'LorebitIsolatedConsumerReceiptV1',
  status: 'passed',
  candidate: 'unpublished',
  package: `${installedPackage.name}@${installedPackage.version}`,
  node: process.versions.node,
  tarballSha256,
  rootImport: true,
  testingImport: true,
  deepImportBlocked: true,
  types: true,
  importSideEffects: false
})}\n`);
