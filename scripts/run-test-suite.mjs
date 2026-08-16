import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const suites = {
  wire: ['test/wire'],
  unit: ['test/domain'],
  contracts: ['test/contracts'],
  integration: ['test/integration'],
  scenarios: ['test/scenarios'],
  security: ['test/security'],
  resources: ['test/resources'],
  concurrency: ['test/concurrency'],
  package: ['test/package']
};

const selected = process.argv.slice(2);
if (selected.length === 0 || selected.some((name) => !(name in suites))) {
  process.stderr.write(
    'Usage: node scripts/run-test-suite.mjs wire|unit|contracts|integration|scenarios|security|resources|concurrency|package [...]\n'
  );
  process.exitCode = 2;
} else {
  const files = [];
  for (const suite of selected) {
    for (const directory of suites[suite]) {
      const absoluteDirectory = resolve(directory);
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
          files.push(join(absoluteDirectory, entry.name));
        }
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right, 'en'));
  if (files.length === 0) {
    process.stderr.write('No test files matched the selected suites.\n');
    process.exitCode = 2;
  } else {
    const completed = spawnSync(process.execPath, ['--test', ...files], {
      stdio: 'inherit'
    });

    if (completed.error) {
      throw completed.error;
    }
    process.exitCode = completed.status ?? 1;
  }
}
