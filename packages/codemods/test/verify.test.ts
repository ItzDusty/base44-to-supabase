import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyProject } from '../src/verify.js';

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base44-to-supabase-verify-'));
  await fs.writeFile(
    path.join(dir, 'a.ts'),
    [
      "import x from 'not-base44';",
      "const y = require('@base44/sdk');",
      "async function z() { return await import('base44'); }",
    ].join('\n'),
    'utf8',
  );
  return dir;
}

describe('verifyProject', () => {
  it('detects remaining Base44 module references', async () => {
    const rootPath = await makeTempProject();
    const result = await verifyProject({ rootPath });
    expect(result.remainingBase44ModuleReferences.length).toBe(1);
    expect(result.remainingBase44ModuleReferences[0].specifiers).toEqual(
      expect.arrayContaining(['@base44/sdk', 'base44']),
    );
  });
});
