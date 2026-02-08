import fs from 'node:fs/promises';
import path from 'node:path';

import { findProjectSourceFiles, toPosixPath } from './fs.js';
import { DEFAULT_BASE44_IMPORT_SOURCES, isLikelyBase44ImportSource } from './sdkHeuristics.js';

export type VerifyOptions = {
  rootPath: string;
  base44ImportSources?: string[];
};

export type Base44ModuleReference = {
  file: string;
  specifiers: string[];
};

export type VerifyResult = {
  rootPath: string;
  filesScanned: number;
  remainingBase44ModuleReferences: Base44ModuleReference[];
};

function rel(rootPath: string, abs: string): string {
  return toPosixPath(path.relative(rootPath, abs));
}

function findImportedModuleSpecifiers(text: string): string[] {
  const out: string[] = [];

  // import ... from 'x'
  // require('x')
  // import('x')
  const re =
    /(from\s+['"]([^'"]+)['"])|(require\s*\(\s*['"]([^'"]+)['"]\s*\))|(import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[2] ?? m[4] ?? m[6];
    if (spec) out.push(spec);
  }

  return [...new Set(out)];
}

export async function verifyProject(options: VerifyOptions): Promise<VerifyResult> {
  const rootPath = path.resolve(options.rootPath);
  const sourceFiles = await findProjectSourceFiles({ cwd: rootPath });

  const importSources = options.base44ImportSources ?? DEFAULT_BASE44_IMPORT_SOURCES;

  const remaining: Base44ModuleReference[] = [];

  await Promise.all(
    sourceFiles.map(async (abs) => {
      const text = await fs.readFile(abs, 'utf8');
      const allSpecifiers = findImportedModuleSpecifiers(text);
      const base44Specifiers = allSpecifiers.filter(
        (s) => isLikelyBase44ImportSource(s) || importSources.includes(s),
      );
      if (base44Specifiers.length === 0) return;
      remaining.push({ file: rel(rootPath, abs), specifiers: base44Specifiers });
    }),
  );

  remaining.sort((a, b) => a.file.localeCompare(b.file));

  return {
    rootPath,
    filesScanned: sourceFiles.length,
    remainingBase44ModuleReferences: remaining,
  };
}
