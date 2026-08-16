import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath?.endsWith('.js')) return spawnSync(process.execPath, [npmExecPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (process.platform !== 'win32') return spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' });
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', command, ...args], { cwd: projectRoot, encoding: 'utf8' });
}

function normalizeTarPath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.startsWith('package/') ? normalized.slice('package/'.length) : normalized;
}

function inspectFileList(input) {
  const files = [...new Set(input.map(normalizeTarPath).filter((path) => path.length > 0 && !path.endsWith('/')))].sort();
  const allowedRoots = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
  for (const path of files) {
    const allowed = allowedRoots.has(path) || path.startsWith('dist/');
    assert.equal(allowed, true, `Forbidden tarball path: ${path}`);
    assert.equal(/(^|\/)(src|test|tests|scripts|docs|website|node_modules|\.github|\.devcodex)(\/|$)/.test(path), false, `Internal path leaked: ${path}`);
    assert.equal(path.endsWith('.ts') && !path.endsWith('.d.ts'), false, `TypeScript source leaked: ${path}`);
  }
  for (const required of allowedRoots) assert.equal(files.includes(required), true, `Required package file is absent: ${required}`);
  assert.equal(files.includes('dist/index.js'), true);
  assert.equal(files.includes('dist/index.d.ts'), true);
  assert.equal(files.includes('dist/testing/index.js'), true);
  assert.equal(files.includes('dist/testing/index.d.ts'), true);
  return files;
}

const tarballArgument = argument('--tarball');
const tarball = tarballArgument === null ? null : resolve(tarballArgument);

function readCandidateText(path) {
  if (tarball === null) return readFile(resolve(projectRoot, path), 'utf8');
  const extracted = spawnSync('tar', ['-xOf', tarball, `package/${path}`], { encoding: 'utf8' });
  if (extracted.error) throw extracted.error;
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
  return Promise.resolve(extracted.stdout);
}

const packageJsonText = await readCandidateText('package.json');
const packageJson = JSON.parse(packageJsonText);
const packageJsonSha256 = createHash('sha256').update(packageJsonText).digest('hex');
assert.equal(packageJson.name, '@devcodex/lorebit');
assert.equal(packageJson.private, true);
assert.equal(packageJson.type, 'module');
assert.equal(packageJson.engines.node, '>=22');
assert.deepEqual(packageJson.files, ['dist', 'README.md', 'LICENSE', 'CHANGELOG.md']);
assert.deepEqual(packageJson.exports, {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './testing': { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' }
});
assert.equal(packageJson.dependencies, undefined);

let files;
let tarballSha256 = null;
if (tarballArgument === null) {
  const packed = npmInvocation(['pack', '--json', '--dry-run']);
  if (packed.error) throw packed.error;
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const receipt = JSON.parse(packed.stdout);
  assert.equal(Array.isArray(receipt), true);
  assert.equal(receipt.length, 1);
  files = inspectFileList(receipt[0].files.map((entry) => entry.path));
} else {
  const archive = spawnSync('tar', ['-tf', tarball], { encoding: 'utf8' });
  if (archive.error) throw archive.error;
  assert.equal(archive.status, 0, archive.stderr || archive.stdout);
  files = inspectFileList(archive.stdout.split(/\r?\n/));
  tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
}

const packageFiles = new Set(files);
for (const path of files.filter((candidate) => candidate.startsWith('dist/') && candidate.endsWith('.js'))) {
  const stem = path.slice(0, -3);
  assert.equal(packageFiles.has(`${stem}.d.ts`), true, `Declaration is absent for ${path}`);
  assert.equal(packageFiles.has(`${path}.map`), true, `Source map is absent for ${path}`);
  assert.equal(packageFiles.has(`${stem}.d.ts.map`), true, `Declaration map is absent for ${path}`);
  const source = await readCandidateText(path);
  assert.equal(source.includes('sourceMappingURL='), true, `Compiled module does not reference its source map: ${path}`);
}

for (const path of files.filter((candidate) => candidate.startsWith('dist/') && candidate.endsWith('.map'))) {
  const map = JSON.parse(await readCandidateText(path));
  assert.equal(Array.isArray(map.sources), true, `Invalid source map: ${path}`);
  assert.equal(map.sources.length > 0, true, `Empty source map: ${path}`);
  for (const source of map.sources) {
    assert.equal(isAbsolute(source), false, `Absolute source path leaked from ${path}`);
    assert.equal(source.includes('node_modules'), false, `Dependency source path leaked from ${path}`);
  }
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'LorebitPackageContentReceiptV1',
  status: 'passed',
  candidate: 'unpublished',
  fileCount: files.length,
  exports: Object.keys(packageJson.exports),
  packageJsonSha256,
  tarballSha256
})}\n`);
