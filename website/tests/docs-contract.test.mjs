import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const websiteRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(websiteRoot, '..');
const docsRoot = resolve(repoRoot, 'docs');
const distRoot = resolve(websiteRoot, 'dist');

const docs = [
  'index.md',
  'start/first-plan.md',
  'concepts/rag-pipeline.md',
  'concepts/knowledge-lifecycle.md',
  'adapters/database-adapters.md',
  'reference/preview-status.md',
  'roadmap.md'
];

function findHtml(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findHtml(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

test('keeps Chinese and English user-doc routes in parity', () => {
  for (const document of docs) {
    assert.ok(existsSync(resolve(docsRoot, 'zh', document)), `missing zh/${document}`);
    assert.ok(existsSync(resolve(docsRoot, 'en', document)), `missing en/${document}`);
  }
});

test('does not present preview content as a released SDK', () => {
  const zhStart = readFileSync(resolve(docsRoot, 'zh', 'start', 'first-plan.md'), 'utf8');
  const enStart = readFileSync(resolve(docsRoot, 'en', 'start', 'first-plan.md'), 'utf8');
  assert.match(zhStart, /尚未发布 npm 包或稳定 API/);
  assert.match(enStart, /not published an npm package or stable API/);
});

test('keeps the Rspress and GitHub Pages contract explicit', () => {
  const config = readFileSync(resolve(websiteRoot, 'rspress.config.ts'), 'utf8');
  const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.match(config, /root: path\.join\(currentDir, '..', 'docs'\)/);
  assert.match(config, /base: '\/lorebit\/'/);
  assert.match(workflow, /actions\/upload-pages-artifact@/);
  assert.match(workflow, /actions\/deploy-pages@/);
});

test('emits a static bilingual site and preserves the social asset', () => {
  assert.ok(existsSync(resolve(distRoot, 'index.html')));
  assert.ok(existsSync(resolve(distRoot, 'en', 'index.html')));
  assert.ok(existsSync(resolve(distRoot, 'og.png')));
  const output = findHtml(distRoot).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.match(output, /lorebit/);
  assert.doesNotMatch(output, /codex-preview/);
});
