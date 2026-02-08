import fs from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';

import { findProjectSourceFiles, toPosixPath } from './fs.js';
import { findImportedModuleSpecifiers } from './importScan.js';
import { isLikelyBase44ImportSource } from './sdkHeuristics.js';
import type { Base44ToSupabaseReport } from './report.js';

export type CleanupOptions = {
  rootPath: string;
  report: Base44ToSupabaseReport;
  mode?: 'dry-run' | 'delete';
};

export type CleanupResult = {
  deletedPaths: string[];
  skippedPaths: Array<{ path: string; reason: string }>;
};

function rel(rootPath: string, abs: string): string {
  return toPosixPath(path.relative(rootPath, abs));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveRelativeImport(fromFileAbs: string, spec: string): Promise<string | null> {
  const base = path.resolve(path.dirname(fromFileAbs), spec);

  // If spec includes extension
  if (path.extname(base)) {
    if (await exists(base)) return base;
    return null;
  }

  const tryFiles = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ];

  for (const p of tryFiles) {
    if (await exists(p)) return p;
  }
  return null;
}

async function buildImportReverseIndex(rootPath: string): Promise<Map<string, Set<string>>> {
  const sourceFilesAbs = await findProjectSourceFiles({ cwd: rootPath });
  const importedBy = new Map<string, Set<string>>();

  for (const fromAbs of sourceFilesAbs) {
    const text = await fs.readFile(fromAbs, 'utf8');
    const specifiers = findImportedModuleSpecifiers(text);
    const relatives = specifiers.filter((s) => s.startsWith('.'));

    for (const spec of relatives) {
      const resolved = await resolveRelativeImport(fromAbs, spec);
      if (!resolved) continue;
      const set = importedBy.get(resolved) ?? new Set<string>();
      set.add(fromAbs);
      importedBy.set(resolved, set);
    }
  }

  return importedBy;
}

function isBase44OnlyFile(text: string): boolean {
  const specifiers = findImportedModuleSpecifiers(text);
  return specifiers.some((s) => isLikelyBase44ImportSource(s));
}

export async function cleanupProject(options: CleanupOptions): Promise<{
  report: Base44ToSupabaseReport;
  result: CleanupResult;
}> {
  const mode = options.mode ?? 'dry-run';

  const deletedPaths: string[] = [];
  const skippedPaths: Array<{ path: string; reason: string }> = [];

  const importedBy = await buildImportReverseIndex(options.rootPath);

  const patterns = [
    // top-level Base44 config/state (conservative)
    'base44.*',
    '.base44/**',

    // common helper wrappers people create
    'src/**/base44*.{ts,tsx,js,jsx}',
    'src/**/Base44*.{ts,tsx,js,jsx}',
    'src/**/*base44*client*.{ts,tsx,js,jsx}',
  ];

  const candidatesAbs = await fg(patterns, {
    cwd: options.rootPath,
    absolute: true,
    onlyFiles: false,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/.git/**',
    ],
  });

  candidatesAbs.sort((a, b) => a.localeCompare(b));

  for (const abs of candidatesAbs) {
    let stat:
      | {
          isFile(): boolean;
          isDirectory(): boolean;
        }
      | undefined;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }

    // Directory cleanup: only remove the well-known .base44 directory.
    if (stat.isDirectory()) {
      const base = path.basename(abs);
      if (base !== '.base44') continue;

      if (mode === 'delete') {
        await fs.rm(abs, { recursive: true, force: true });
      }
      deletedPaths.push(rel(options.rootPath, abs));
      continue;
    }

    if (!stat.isFile()) continue;

    const text = await fs.readFile(abs, 'utf8');
    if (!isBase44OnlyFile(text)) continue;

    const importers = importedBy.get(abs);
    if (importers && importers.size > 0) {
      const sample = [...importers].slice(0, 3).map((p) => rel(options.rootPath, p));
      skippedPaths.push({
        path: rel(options.rootPath, abs),
        reason: `Still imported by: ${sample.join(', ')}${importers.size > 3 ? ', ...' : ''}`,
      });
      continue;
    }

    if (mode === 'delete') {
      await fs.rm(abs, { force: true });
    }
    deletedPaths.push(rel(options.rootPath, abs));
  }

  const updated: Base44ToSupabaseReport = {
    ...options.report,
    cleanup: {
      mode,
      deletedPaths,
      skippedPaths,
    },
  };

  return {
    report: updated,
    result: { deletedPaths, skippedPaths },
  };
}
