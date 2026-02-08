import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/analyze.js';
import { cleanupProject } from '../src/cleanup.js';

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base44-to-supabase-cleanup-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return dir;
}

describe('cleanupProject', () => {
  it('deletes unreferenced Base44-only helper files (when mode=delete)', async () => {
    const rootPath = await makeTempProject({
      'src/api/base44Client.ts': "import { auth } from 'base44';\nexport const x = auth;\n",
      'src/app.ts': 'export const ok = true;\n',
    });

    const report = await analyzeProject({ rootPath });
    const { result } = await cleanupProject({ rootPath, report, mode: 'delete' });

    expect(result.deletedPaths.some((p) => p.includes('src/api/base44Client.ts'))).toBe(true);
    await expect(fs.stat(path.join(rootPath, 'src/api/base44Client.ts'))).rejects.toBeTruthy();
  });

  it('skips Base44-only files that are still imported', async () => {
    const rootPath = await makeTempProject({
      'src/api/base44Client.ts': "import { auth } from 'base44';\nexport const x = auth;\n",
      'src/app.ts': "import { x } from './api/base44Client';\nexport { x };\n",
    });

    const report = await analyzeProject({ rootPath });
    const { result } = await cleanupProject({ rootPath, report, mode: 'delete' });

    expect(result.deletedPaths.some((p) => p.includes('src/api/base44Client.ts'))).toBe(false);
    expect(result.skippedPaths.some((s) => s.path.includes('src/api/base44Client.ts'))).toBe(true);
    await expect(fs.stat(path.join(rootPath, 'src/api/base44Client.ts'))).resolves.toBeTruthy();
  });
});
