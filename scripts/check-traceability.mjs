import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const governanceRoot = resolve('..', '.devcodex', 'lorebit', 'requirements', 'lorebit通用RAG运行时');
const files = {
  cp1: resolve(governanceRoot, '01-需求变更确认.md'),
  cp2: resolve(governanceRoot, '02-技术方案.md'),
  acceptance: resolve(governanceRoot, '03-验收与发布.md'),
  cp3: resolve(governanceRoot, '04-实施计划.md')
};

const [cp1, cp2, acceptance, cp3] = await Promise.all(
  Object.values(files).map((file) => readFile(file, 'utf8'))
);

function uniqueNumbers(text, expression) {
  return [...text.matchAll(expression)]
    .map((match) => Number(match[1]))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right);
}

function assertContinuous(label, actual, maximum) {
  const expected = Array.from({ length: maximum }, (_, index) => index + 1);
  const missing = expected.filter((value) => !actual.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} is missing: ${missing.join(', ')}`);
  }
}

assertContinuous('F traceability', uniqueNumbers(cp1, /\bF(\d{2,3})\b/g), 109);
assertContinuous('E2E traceability', uniqueNumbers(acceptance, /\bE2E-(\d{2})\b/g), 25);
assertContinuous('SEC traceability', uniqueNumbers(acceptance, /\bSEC-(\d{2})\b/g), 13);
assertContinuous('RES traceability', uniqueNumbers(acceptance, /\bRES-(\d{2})\b/g), 10);

for (const marker of ['CandidateReviewBundleV1', 'TDMatrix', 'ClaimEvidenceMatrix']) {
  if (!cp2.includes(marker)) {
    throw new Error(`CP2 is missing ${marker}`);
  }
}

for (const batch of ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']) {
  if (!cp3.includes(batch)) {
    throw new Error(`CP3 is missing ${batch}`);
  }
}

process.stdout.write(
  JSON.stringify({
    schemaVersion: 'LorebitTraceabilityReceiptV1',
    f: 109,
    e2e: 25,
    sec: 13,
    res: 10,
    batches: 8,
    status: 'passed'
  }) + '\n'
);
