import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/analyze.js';

describe('analyzeProject', () => {
  it('returns empty report for empty folder', async () => {
    const report = await analyzeProject({ rootPath: process.cwd() });
    expect(report.version).toBe(1);
    expect(Array.isArray(report.base44.findings)).toBe(true);
    expect(Array.isArray(report.inferred.envVars)).toBe(true);
  });
});
