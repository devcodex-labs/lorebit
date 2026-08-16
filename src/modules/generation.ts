import type { LanguageModel } from '../ports/language-model.js';

export interface GenerationModuleConfig {
  readonly languageModel: LanguageModel;
  readonly enabled: true;
}

export function defineGenerationModule(languageModel: LanguageModel): GenerationModuleConfig {
  return Object.freeze({ languageModel, enabled: true as const });
}
