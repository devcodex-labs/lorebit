import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const userSiteRoot = resolve(import.meta.dirname, '..');
const websiteRoot = resolve(userSiteRoot, '..');
const repoRoot = resolve(websiteRoot, '..');
const docsRoot = resolve(repoRoot, 'docs', 'zh');
const distRoot = resolve(userSiteRoot, 'dist');

const docs = [
  'index.md',
  'start/choose-a-problem.md',
  'start/define-knowledge-space.md',
  'start/first-plan.md',
  'start/source-and-evidence.md',
  'guide/ingest-and-review.md',
  'guide/answer-with-evidence.md',
  'concepts/rag-pipeline.md',
  'concepts/knowledge-model.md',
  'guide/handle-change.md',
  'concepts/knowledge-lifecycle.md',
  'adapters/database-adapters.md',
  'guide/quality-and-recovery.md',
  'guide/review-a-workflow.md',
  'reference/behavior-contract.md',
  'reference/acceptance-scenarios.md',
  'reference/glossary.md',
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

test('keeps the complete Chinese docs-first user journey available', () => {
  for (const document of docs) {
    assert.ok(existsSync(resolve(docsRoot, document)), `missing zh/${document}`);
  }
  assert.equal(docs.length, 19);
  assert.ok(existsSync(resolve(repoRoot, 'docs', 'en', 'index.md')), 'keeps archived English source');
});

test('uses target behavior contracts without presenting preview content as a released SDK', () => {
  const zhStart = readFileSync(resolve(docsRoot, 'start', 'first-plan.md'), 'utf8');
  const home = readFileSync(resolve(docsRoot, 'index.md'), 'utf8');
  const contract = readFileSync(resolve(docsRoot, 'reference', 'behavior-contract.md'), 'utf8');
  const scenarios = readFileSync(resolve(docsRoot, 'reference', 'acceptance-scenarios.md'), 'utf8');
  assert.match(zhStart, /尚未发布 npm 包或稳定 API/);
  assert.match(home, /0\.x 目标行为合同/);
  assert.match(contract, /U1/);
  assert.match(contract, /U7/);
  assert.match(scenarios, /场景一：建立第一条知识工作流/);
  assert.match(scenarios, /场景三：资料更新后的恢复/);
});

test('keeps the Chinese-only Rspress and GitHub Pages contract explicit', () => {
  const config = readFileSync(resolve(userSiteRoot, 'rspress.config.ts'), 'utf8');
  const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.match(config, /root: path\.join\(currentDir, '..', '..', 'docs', 'zh'\)/);
  assert.match(config, /outDir: path\.join\(currentDir, 'dist'\)/);
  assert.match(config, /base: '\/lorebit\/'/);
  assert.doesNotMatch(config, /languageParity/);
  assert.doesNotMatch(config, /'\/en\//);
  assert.match(config, /text: '认识 lorebit'/);
  assert.match(config, /text: '建立第一条知识工作流'/);
  assert.match(config, /text: '让知识持续可靠'/);
  assert.match(config, /text: '0\.x 目标行为合同'/);
  assert.match(workflow, /actions\/upload-pages-artifact@/);
  assert.match(workflow, /actions\/deploy-pages@/);
});

test('emits a static Chinese site and preserves the social asset', () => {
  assert.ok(existsSync(resolve(distRoot, 'index.html')));
  assert.ok(!existsSync(resolve(distRoot, 'en')));
  assert.ok(existsSync(resolve(distRoot, 'og.png')));
  for (const document of docs) {
    const output = document === 'index.md' ? 'index.html' : document.replace(/\.md$/, '.html');
    assert.ok(existsSync(resolve(distRoot, output)), `missing rendered ${output}`);
  }
  const output = findHtml(distRoot).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.match(output, /lorebit/);
  assert.doesNotMatch(output, /codex-preview/);
});
