export interface ImportExportModuleConfig {
  readonly enabled: true;
  readonly allowIncrementalExport: boolean;
  readonly requireDryRunBeforeMigration: boolean;
}

export function defineImportExportModule(input: Partial<Omit<ImportExportModuleConfig, 'enabled'>> = {}): ImportExportModuleConfig {
  return Object.freeze({ enabled: true as const, allowIncrementalExport: input.allowIncrementalExport ?? false, requireDryRunBeforeMigration: input.requireDryRunBeforeMigration ?? true });
}
