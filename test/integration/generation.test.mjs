import assert from 'node:assert/strict';
import test from 'node:test';

import { defineGenerationModule } from '../../dist/index.js';
import { ScriptedLanguageModel } from '../../dist/testing/index.js';

test('generation module activation is explicit and keeps the caller-supplied LanguageModel identity', () => {
  const model = new ScriptedLanguageModel();
  const module = defineGenerationModule(model);
  assert.equal(module.enabled, true);
  assert.strictEqual(module.languageModel, model);
  assert.equal(module.languageModel.descriptor.kind, 'language-model');
  assert.equal(module.languageModel.capabilities.retryOwner, 'runtime');
});
