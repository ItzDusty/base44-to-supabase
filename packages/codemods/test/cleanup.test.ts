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

  it('removes a top-level functions/ dir if it contains Base44 imports', async () => {
    const rootPath = await makeTempProject({
      'functions/hello.ts': "import { auth } from 'base44';\nexport default auth;\n",
      'supabase/functions/hello/index.ts': "export default () => new Response('ok');\n",
    });

    const report = await analyzeProject({ rootPath });
    const { result } = await cleanupProject({ rootPath, report, mode: 'delete' });

    expect(result.deletedPaths.some((p) => p === 'functions')).toBe(true);
    await expect(fs.stat(path.join(rootPath, 'functions'))).rejects.toBeTruthy();
    await expect(
      fs.stat(path.join(rootPath, 'supabase/functions/hello/index.ts')),
    ).resolves.toBeTruthy();
  });

  it('can remove Base44 deps from package.json when no Base44 module refs remain', async () => {
    const rootPath = await makeTempProject({
      'src/app.ts': 'export const ok = true;\n',
      'package.json': JSON.stringify(
        {
          name: 'x',
          version: '0.0.0',
          dependencies: { base44: '^1.0.0', react: '^18.0.0' },
          devDependencies: { '@base44/sdk': '^1.0.0' },
        },
        null,
        2,
      ),
    });

    const report = await analyzeProject({ rootPath });
    const { result } = await cleanupProject({
      rootPath,
      report,
      mode: 'delete',
      removeDependencies: true,
    });

    expect(result.removedDependencies).toContain('base44');
    expect(result.removedDependencies).toContain('@base44/sdk');
    const pkg = JSON.parse(await fs.readFile(path.join(rootPath, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.base44).toBeUndefined();
    expect(pkg.devDependencies?.['@base44/sdk']).toBeUndefined();
    expect(pkg.dependencies?.react).toBeTruthy();
  });

  it('aggressive mode quarantines any remaining Base44-referencing source files', async () => {
    const rootPath = await makeTempProject({
      'src/legacy.ts': "import { auth } from 'base44';\nexport const x = auth;\n",
      'src/app.ts': 'export const ok = true;\n',
    });

    const report = await analyzeProject({ rootPath });
    const { result } = await cleanupProject({
      rootPath,
      report,
      mode: 'delete',
      aggressive: true,
      quarantineDir: '.base44-to-supabase/removed',
    });

    expect(result.quarantinedPaths.some((p) => p.includes('src/legacy.ts'))).toBe(true);
    await expect(fs.stat(path.join(rootPath, 'src/legacy.ts'))).rejects.toBeTruthy();
    await expect(
      fs.stat(path.join(rootPath, '.base44-to-supabase/removed/src/legacy.ts')),
    ).resolves.toBeTruthy();
  });
});
