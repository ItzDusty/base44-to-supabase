import fg from 'fast-glob';
import path from 'node:path';

export type ScanOptions = {
  cwd: string;
};

const DEFAULT_PATTERNS = [
  '**/*.{ts,tsx,js,jsx}',
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/.next/**',
  '!**/.turbo/**',
  '!**/.git/**',
];

export async function findProjectSourceFiles(options: ScanOptions): Promise<string[]> {
  const abs = await fg(DEFAULT_PATTERNS, {
    cwd: options.cwd,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  abs.sort();
  return abs;
}

export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}
