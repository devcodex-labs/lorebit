import assert from 'node:assert/strict';
import test from 'node:test';

import { createLorebitId } from '../../dist/index.js';

test('five version identities remain separate clocks', () => {
  const clocks = {
    revision: createLorebitId('revision', 'v1'),
    policy: createLorebitId('policy', 'v1'),
    recipe: createLorebitId('recipe', 'v1'),
    generation: createLorebitId('generation', 'v1'),
    result: createLorebitId('result', 'v1')
  };
  assert.deepEqual(Object.values(clocks), [
    'revision_v1',
    'policy_v1',
    'recipe_v1',
    'generation_v1',
    'result_v1'
  ]);
  assert.equal(new Set(Object.values(clocks)).size, 5);
  assert.equal('version' in clocks, false);
});
