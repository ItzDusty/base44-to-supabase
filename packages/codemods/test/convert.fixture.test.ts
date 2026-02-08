import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/analyze.js';
import { convertProject } from '../src/convert.js';

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base44-to-supabase-'));
  await fs.writeFile(
    path.join(dir, 'app.ts'),
    [
      "'use client';",
      '',
      "import { auth, collections, storage } from 'base44';",
      '',
      'export async function run() {',
      '  await auth.signIn({ email: "a@b.com", password: "pw" });',
      "  const todo = await collections('todos').create({ title: 'hello', done: false });",
      "  const one = await collections('todos').get('123');",
      "  const list = await collections('todos').list({ done: false });",
      "  const upd = await collections('todos').update('123', { done: true });",
      "  await collections('todos').delete('123');",
      "  await storage.upload('files', 'a.txt', new Uint8Array([1,2,3]));",
      "  await storage.download('files', 'a.txt');",
      '  return { todo, one, list, upd };',
      '}',
      '',
      'export function env() {',
      '  return process.env.SUPABASE_URL;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

describe('convertProject (fixture)', () => {
  it('removes Base44 imports and rewrites common calls', async () => {
    const rootPath = await makeTempProject();
    const report = await analyzeProject({ rootPath });

    const updated = await convertProject({
      rootPath,
      report,
      backend: { mode: 'supabase', entryPath: 'src/backend/index.ts' },
      envExamplePath: '.env.example',
    });

    expect(updated.convert?.backendEntryPath).toBeTruthy();
    expect(updated.convert?.envExamplePath).toBeTruthy();

    const out = await fs.readFile(path.join(rootPath, 'app.ts'), 'utf8');
    expect(out.split(/\r?\n/)[0]).toMatch(/^("use client"|'use client');$/);
    expect(out).not.toMatch(/from 'base44'/);
    expect(out).toMatch(/import\s+\{\s*backend\s*\}\s+from\s+['"]\.\/src\/backend\/index\.js['"]/);

    expect(out).toMatch(/backend\.auth\.signIn\(/);
    expect(out).toMatch(/backend\.data\.create\('todos',/);
    expect(out).toMatch(/backend\.data\.read\('todos', \{ id: '123' \}\)/);
    expect(out).toMatch(/backend\.data\.read\('todos', \{ filter: \{ done: false \} \}\)/);
    expect(out).toMatch(/backend\.data\.update\('todos', '123',/);
    expect(out).toMatch(/backend\.data\.delete\('todos', '123'\)/);

    expect(out).toMatch(/backend\.storage\.upload\(/);
    expect(out).toMatch(/backend\.storage\.download\(/);

    // Ensure env-var inference found SUPABASE_URL.
    expect(updated.inferred.envVars).toContain('SUPABASE_URL');
  });
});
