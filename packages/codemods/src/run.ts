import path from 'node:path';

import { analyzeProject } from './analyze.js';
import { cleanupProject } from './cleanup.js';
import { convertProject } from './convert.js';
import { initSupabaseProject } from './initSupabase.js';
import { verifyProject } from './verify.js';
import { formatAnalyzeSummary } from './consoleSummary.js';
import { readReport, writeReport } from './io.js';
import type { Base44ToSupabaseReport } from './report.js';

export type RunConvertOptions = {
  backendMode?: 'supabase' | 'local';
  backendEntryPath?: string;
  envExamplePath?: string;
};

export type RunInitSupabaseOptions = {
  ownerColumn?: string | null;
  includeUpdatedAt?: boolean;
  generateEdgeFunctions?: boolean;
  functionsDir?: string;
};

export type RunCleanupOptions = {
  mode?: 'dry-run' | 'delete';
  removeDependencies?: boolean;
  removeBase44FunctionsDir?: boolean;
  aggressive?: boolean;
  quarantineDir?: string;
};

export async function runAnalyze(
  rootPath: string,
): Promise<{ report: Base44ToSupabaseReport; reportPath: string; summary: string }> {
  const abs = path.resolve(rootPath);
  const report = await analyzeProject({ rootPath: abs });
  const reportPath = await writeReport(abs, report);
  const summary = formatAnalyzeSummary(report);
  return { report, reportPath, summary };
}

export async function runConvert(
  rootPath: string,
  options?: RunConvertOptions,
): Promise<{ report: Base44ToSupabaseReport; reportPath: string }> {
  const abs = path.resolve(rootPath);
  const existing = (await readReport(abs)) ?? (await analyzeProject({ rootPath: abs }));
  const updated = await convertProject({
    rootPath: abs,
    report: existing,
    backend: {
      mode: options?.backendMode ?? 'supabase',
      entryPath: options?.backendEntryPath,
    },
    envExamplePath: options?.envExamplePath,
  });
  const reportPath = await writeReport(abs, updated);
  return { report: updated, reportPath };
}

export async function runInitSupabase(
  rootPath: string,
  options?: RunInitSupabaseOptions,
): Promise<{ report: Base44ToSupabaseReport; reportPath: string }> {
  const abs = path.resolve(rootPath);
  const existing = (await readReport(abs)) ?? (await analyzeProject({ rootPath: abs }));
  const updated = await initSupabaseProject({
    rootPath: abs,
    report: existing,
    schema: {
      ownerColumn: options?.ownerColumn ?? null,
      includeUpdatedAt: options?.includeUpdatedAt ?? false,
    },
    edgeFunctions: {
      generate: options?.generateEdgeFunctions ?? false,
      functionsDir: options?.functionsDir,
    },
  });
  const reportPath = await writeReport(abs, updated);
  return { report: updated, reportPath };
}

export async function runCleanup(
  rootPath: string,
  options?: RunCleanupOptions,
): Promise<{
  report: Base44ToSupabaseReport;
  reportPath: string;
  result: {
    deletedPaths: string[];
    quarantinedPaths: string[];
    skippedPaths: Array<{ path: string; reason: string }>;
    removedDependencies: string[];
  };
}> {
  const abs = path.resolve(rootPath);
  const existing = (await readReport(abs)) ?? (await analyzeProject({ rootPath: abs }));
  const { report: updated, result } = await cleanupProject({
    rootPath: abs,
    report: existing,
    mode: options?.mode ?? 'dry-run',
    removeDependencies: options?.removeDependencies ?? false,
    removeBase44FunctionsDir: options?.removeBase44FunctionsDir ?? true,
    aggressive: options?.aggressive ?? false,
    quarantineDir: options?.quarantineDir,
  });
  const reportPath = await writeReport(abs, updated);
  return { report: updated, reportPath, result };
}

export async function runVerify(rootPath: string): Promise<{
  ok: boolean;
  filesScanned: number;
  remaining: Array<{ file: string; specifiers: string[] }>;
}> {
  const abs = path.resolve(rootPath);
  const result = await verifyProject({ rootPath: abs });
  return {
    ok: result.remainingBase44ModuleReferences.length === 0,
    filesScanned: result.filesScanned,
    remaining: result.remainingBase44ModuleReferences,
  };
}
