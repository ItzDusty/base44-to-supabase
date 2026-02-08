import fs from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';

import { findProjectSourceFiles, toPosixPath } from './fs.js';
import { findImportedModuleSpecifiers } from './importScan.js';
import { isLikelyBase44ImportSource } from './sdkHeuristics.js';
import type { Base44ToSupabaseReport } from './report.js';
import { verifyProject } from './verify.js';

export type CleanupOptions = {
  rootPath: string;
  report: Base44ToSupabaseReport;
  mode?: 'dry-run' | 'delete';
  removeDependencies?: boolean;
  removeBase44FunctionsDir?: boolean;
  aggressive?: boolean;
  quarantineDir?: string;
};

export type CleanupResult = {
  deletedPaths: string[];
  quarantinedPaths: string[];
  skippedPaths: Array<{ path: string; reason: string }>;
  removedDependencies: string[];
};

function rel(rootPath: string, abs: string): string {
  return toPosixPath(path.relative(rootPath, abs));
}

function key(absPath: string): string {
  const resolved = path.resolve(absPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listBase44ModuleReferencesInDir(dirAbs: string): Promise<boolean> {
  const abs = await fg(['**/*.{ts,tsx,js,jsx}', '!**/node_modules/**', '!**/dist/**'], {
    cwd: dirAbs,
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  });
  for (const f of abs) {
    const text = await fs.readFile(f, 'utf8');
    const specifiers = findImportedModuleSpecifiers(text);
    if (specifiers.some((s) => isLikelyBase44ImportSource(s))) return true;
  }
  return false;
}

function removeMatchingDeps(
  pkg: any,
  predicate: (name: string) => boolean,
): { removed: string[]; updated: any } {
  const removed: string[] = [];
  const updated = { ...pkg };
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const field of fields) {
    const obj = updated[field];
    if (!obj || typeof obj !== 'object') continue;
    for (const name of Object.keys(obj)) {
      if (predicate(name)) {
        removed.push(name);
        delete obj[name];
      }
    }
  }
  return { removed: [...new Set(removed)].sort(), updated };
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
      const k = key(resolved);
      const set = importedBy.get(k) ?? new Set<string>();
      set.add(fromAbs);
      importedBy.set(k, set);
    }
  }

  return importedBy;
}

function isBase44OnlyFile(text: string): boolean {
  const specifiers = findImportedModuleSpecifiers(text);
  return specifiers.some((s) => isLikelyBase44ImportSource(s));
}

async function moveToQuarantine(
  rootPath: string,
  fileAbs: string,
  quarantineDirRel: string,
): Promise<void> {
  const relPath = rel(rootPath, fileAbs);
  const targetAbs = path.join(rootPath, quarantineDirRel, relPath);
  await fs.mkdir(path.dirname(targetAbs), { recursive: true });

  try {
    await fs.rename(fileAbs, targetAbs);
  } catch {
    await fs.copyFile(fileAbs, targetAbs);
    await fs.rm(fileAbs, { force: true });
  }
}

export async function cleanupProject(options: CleanupOptions): Promise<{
  report: Base44ToSupabaseReport;
  result: CleanupResult;
}> {
  const mode = options.mode ?? 'dry-run';
  const removeDependencies = options.removeDependencies ?? false;
  const removeBase44FunctionsDir = options.removeBase44FunctionsDir ?? true;
  const aggressive = options.aggressive ?? false;
  const quarantineDirRel = options.quarantineDir ?? '.base44-to-supabase/removed';

  const deletedPaths: string[] = [];
  const quarantinedPaths: string[] = [];
  const skippedPaths: Array<{ path: string; reason: string }> = [];
  const removedDependencies: string[] = [];

  const importedBy = await buildImportReverseIndex(options.rootPath);

  // Special-case: many Base44 projects have a top-level "functions/" directory.
  // If it contains Base44 module imports, we can remove it to leave a cleaner migrated copy.
  // This is opt-in via cleanup itself; it is conservative in that it requires Base44 imports.
  const functionsDirAbs = path.join(options.rootPath, 'functions');
  if (removeBase44FunctionsDir) {
    try {
      const st = await fs.stat(functionsDirAbs);
      if (st.isDirectory()) {
        const hasBase44Refs = await listBase44ModuleReferencesInDir(functionsDirAbs);
        if (hasBase44Refs) {
          if (mode === 'delete') {
            await fs.rm(functionsDirAbs, { recursive: true, force: true });
          }
          deletedPaths.push(rel(options.rootPath, functionsDirAbs));
        }
      }
    } catch {
      // ignore
    }
  }

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

    const importers = importedBy.get(key(abs));
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

  // Aggressive mode: quarantine any remaining source files that still import/require Base44.
  // This intentionally prioritizes a Base44-free working tree over preserving builds.
  if (aggressive) {
    const sourceFilesAbs = await findProjectSourceFiles({ cwd: options.rootPath });
    for (const abs of sourceFilesAbs) {
      const text = await fs.readFile(abs, 'utf8');
      const specs = findImportedModuleSpecifiers(text).filter(isLikelyBase44ImportSource);
      if (specs.length === 0) continue;

      const r = rel(options.rootPath, abs);
      if (mode === 'delete') {
        await moveToQuarantine(options.rootPath, abs, quarantineDirRel);
        quarantinedPaths.push(r);
        deletedPaths.push(r);
      } else {
        skippedPaths.push({
          path: r,
          reason: `Would quarantine (aggressive) because it references Base44 modules: ${specs
            .map((s) => JSON.stringify(s))
            .join(', ')}`,
        });
      }
    }
  }

  const updated: Base44ToSupabaseReport = {
    ...options.report,
    cleanup: {
      mode,
      deletedPaths,
      quarantinedPaths: quarantinedPaths.length ? quarantinedPaths.sort() : undefined,
      skippedPaths,
      removedDependencies,
    },
  };

  // Optionally remove Base44-related deps from package.json, but only if the project
  // has no remaining Base44 module references (to avoid breaking builds).
  if (removeDependencies) {
    const verify = await verifyProject({ rootPath: options.rootPath });
    if (verify.remainingBase44ModuleReferences.length > 0) {
      updated.cleanup = {
        ...(updated.cleanup ?? { mode, deletedPaths, skippedPaths }),
        removedDependencies,
      };
      updated.cleanup.skippedPaths = [
        ...(updated.cleanup.skippedPaths ?? []),
        {
          path: 'package.json',
          reason: `Not removing Base44 dependencies because ${verify.remainingBase44ModuleReferences.length} file(s) still reference Base44 modules. Run verify/convert first.`,
        },
      ];
      return {
        report: updated,
        result: {
          deletedPaths,
          quarantinedPaths,
          skippedPaths: updated.cleanup.skippedPaths,
          removedDependencies,
        },
      };
    }

    const pkgPath = path.join(options.rootPath, 'package.json');
    try {
      const text = await fs.readFile(pkgPath, 'utf8');
      const parsed = JSON.parse(text);
      const { removed, updated: nextPkg } = removeMatchingDeps(parsed, (name) =>
        name.toLowerCase().includes('base44'),
      );
      if (removed.length > 0) {
        removedDependencies.push(...removed);
        if (mode === 'delete') {
          await fs.writeFile(pkgPath, JSON.stringify(nextPkg, null, 2) + '\n', 'utf8');
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    report: updated,
    result: {
      deletedPaths,
      quarantinedPaths,
      skippedPaths,
      removedDependencies: [...new Set(removedDependencies)].sort(),
    },
  };
}
