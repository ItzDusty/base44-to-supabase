import fs from 'node:fs/promises';
import path from 'node:path';

import type { Base44ToSupabaseReport } from './report.js';
import { toPosixPath } from './fs.js';

export const REPORT_FILENAME = 'base44-to-supabase.report.json';

export async function writeReport(
  rootPath: string,
  report: Base44ToSupabaseReport,
): Promise<string> {
  const outPath = path.join(rootPath, REPORT_FILENAME);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return toPosixPath(path.relative(rootPath, outPath));
}

export async function readReport(rootPath: string): Promise<Base44ToSupabaseReport | null> {
  const outPath = path.join(rootPath, REPORT_FILENAME);
  try {
    const raw = await fs.readFile(outPath, 'utf8');
    return JSON.parse(raw) as Base44ToSupabaseReport;
  } catch {
    return null;
  }
}
