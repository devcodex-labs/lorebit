import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import test from 'node:test';

const userSiteRoot = resolve(import.meta.dirname, '..');
const websiteRoot = resolve(userSiteRoot, '..');
const repoRoot = resolve(websiteRoot, '..');
const distRoot = resolve(userSiteRoot, 'dist');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'pages.yml');

const publicOutputs = [
  'index.html',
  'start/choose-a-problem.html',
  'start/define-knowledge-space.html',
  'start/first-plan.html',
  'start/source-and-evidence.html',
  'guide/ingest-and-review.html',
  'guide/answer-with-evidence.html',
  'concepts/rag-pipeline.html',
  'concepts/knowledge-model.html',
  'guide/handle-change.html',
  'concepts/knowledge-lifecycle.html',
  'adapters/database-adapters.html',
  'guide/quality-and-recovery.html',
  'guide/review-a-workflow.html',
  'reference/behavior-contract.html',
  'reference/acceptance-scenarios.html',
  'reference/glossary.html',
  'reference/preview-status.html',
  'roadmap.html'
];

const forbiddenMarkers = [
  '.devcodex',
  'sourceRefs',
  'site-contract.json',
  'LorebitMaintainerSiteContractV1',
  '/product-boundary/',
  '/flows/durable-recovery/',
  '/delivery/',
  '/drift/'
];

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt', '.xml']);

function collectTextFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTextFiles(target);
    return textExtensions.has(extname(entry.name)) ? [target] : [];
  });
}

function findLeaks(text) {
  return forbiddenMarkers.filter(marker => text.includes(marker));
}

test('product Git and ignore rules keep the Maintainer surface out', () => {
  const tracked = execFileSync('git', ['ls-files', 'website/maintainer-site'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim();
  assert.equal(tracked, '');
  const ignored = execFileSync('git', ['check-ignore', '-v', '--no-index', 'website/maintainer-site/probe.txt'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.match(ignored, /\/website\/maintainer-site\//);
});

test('Pages runs only the Public test and uploads only the Public artifact', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /node-version: '22\.12\.0'/);
  assert.match(workflow, /run: npm run test:user/);
  assert.match(workflow, /path: website\/user-site\/dist/);
  assert.match(workflow, /- 'docs\/zh\/\*\*'/);
  assert.match(workflow, /- 'website\/user-site\/\*\*'/);
  assert.doesNotMatch(workflow, /build:maintainer|test:maintainer|\.devcodex/);
  assert.doesNotMatch(workflow, /- 'docs\/\*\*'|- 'website\/\*\*'/);
});

test('Public config and contract test do not consume Maintainer truth', () => {
  const sources = [
    resolve(userSiteRoot, 'rspress.config.ts'),
    resolve(import.meta.dirname, 'docs-contract.test.mjs')
  ].map(file => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(sources, /\.devcodex|maintainer-site|site-contract\.json|sourceRefs/);
});

test('leak detector rejects an internal fixture', () => {
  const fixture = 'fixture LorebitMaintainerSiteContractV1 sourceRefs /drift/';
  assert.deepEqual(findLeaks(fixture), [
    'sourceRefs',
    'LorebitMaintainerSiteContractV1',
    '/drift/'
  ]);
});

test('Public artifact contains 19 Chinese routes and no internal markers', () => {
  assert.equal(existsSync(resolve(distRoot, 'en')), false);
  for (const output of publicOutputs) {
    assert.ok(existsSync(resolve(distRoot, output)), `missing Public output: ${output}`);
  }
  const leaks = collectTextFiles(distRoot).flatMap(file => {
    const markers = findLeaks(readFileSync(file, 'utf8'));
    return markers.map(marker => `${file}: ${marker}`);
  });
  assert.deepEqual(leaks, []);
});
