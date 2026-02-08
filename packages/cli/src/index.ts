#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { Command } from 'commander';

import { runAnalyze, runConvert, runInitSupabase, runVerify } from '@base44-to-supabase/codemods';

function resolveTargetPath(p: string): string {
  return path.resolve(process.cwd(), p);
}

const execFileAsync = promisify(execFile);

function isProbablyGitUrl(source: string): boolean {
  return (
    source.startsWith('http://') ||
    source.startsWith('https://') ||
    source.startsWith('git@') ||
    source.endsWith('.git')
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyProjectDir(srcAbs: string, destAbs: string) {
  await fs.mkdir(destAbs, { recursive: true });
  await fs.cp(srcAbs, destAbs, {
    recursive: true,
    force: false,
    filter: (p) => {
      const base = path.basename(p);
      if (base === 'node_modules') return false;
      if (base === 'dist') return false;
      if (base === '.turbo') return false;
      if (base === '.git') return false;
      if (base === '.env') return false;
      if (base.startsWith('.env.') && base !== '.env.example') return false;
      return true;
    },
  });
}

async function cloneRepo(source: string, destAbs: string) {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await execFileAsync('git', ['clone', '--depth', '1', source, destAbs], { cwd: process.cwd() });
}

async function ensureEmptyDir(destAbs: string) {
  if (await pathExists(destAbs)) {
    const entries = await fs.readdir(destAbs);
    if (entries.length > 0) {
      throw new Error(`Output directory is not empty: ${destAbs}`);
    }
  } else {
    await fs.mkdir(destAbs, { recursive: true });
  }
}

async function promptFlow<T>(
  fn: (rl: ReturnType<typeof createInterface>) => Promise<T>,
): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

async function promptInput(
  rl: ReturnType<typeof createInterface>,
  message: string,
  opts?: { defaultValue?: string },
): Promise<string> {
  const suffix = opts?.defaultValue ? ` (default: ${opts.defaultValue})` : '';
  const ans = (await rl.question(`${message}${suffix}: `)).trim();
  return ans || opts?.defaultValue || '';
}

async function promptConfirm(
  rl: ReturnType<typeof createInterface>,
  message: string,
  opts?: { defaultValue?: boolean },
): Promise<boolean> {
  const def = opts?.defaultValue;
  const hint = def === undefined ? 'y/n' : def ? 'Y/n' : 'y/N';
  while (true) {
    const raw = (await rl.question(`${message} (${hint}): `)).trim().toLowerCase();
    if (!raw && def !== undefined) return def;
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
  }
}

async function promptSelect(
  rl: ReturnType<typeof createInterface>,
  message: string,
  choices: string[],
  opts?: { defaultIndex?: number },
): Promise<string> {
  const rawDefIndex = opts?.defaultIndex ?? 0;
  const defIndex = Math.min(Math.max(rawDefIndex, 0), Math.max(choices.length - 1, 0));
  console.log(message);
  for (let i = 0; i < choices.length; i++) {
    const isDef = i === defIndex;
    console.log(`  ${i + 1}) ${choices[i]}${isDef ? ' (default)' : ''}`);
  }
  while (true) {
    const raw = (await rl.question('Select an option: ')).trim();
    if (!raw) {
      const selected = choices[defIndex];
      if (!selected) throw new Error('No choices available for selection');
      return selected;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= choices.length) {
      const selected = choices[n - 1];
      if (!selected) throw new Error('Invalid selection');
      return selected;
    }
  }
}

function formatEnvValue(value: string): string {
  // Basic dotenv-compatible quoting/escaping.
  // If the value is empty, emit empty (KEY=).
  if (value === '') return '';
  const needsQuotes = /\s|#|"|\n|\r/.test(value);
  if (!needsQuotes) return value;
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
  return `"${escaped}"`;
}

async function promptEnvVars(
  rl: ReturnType<typeof createInterface>,
  vars: string[],
  defaults?: Record<string, string>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  console.log('');
  console.log('Environment variables');
  console.log('Enter values for variables you want written into .env (leave blank to skip).');
  console.log('Note: values will be written to disk in the migrated copy.');

  for (const v of vars) {
    const defaultValue = defaults?.[v];
    const value = await promptInput(rl, v, { defaultValue: defaultValue ?? '' });
    if (value.trim() === '') continue;
    result[v] = value;
  }

  return result;
}

async function writeDotEnvFile(targetDirAbs: string, env: Record<string, string>) {
  const outPath = path.join(targetDirAbs, '.env');
  const keys = Object.keys(env).sort();
  const lines = keys.map((k) => `${k}=${formatEnvValue(env[k] ?? '')}`);
  await fs.writeFile(outPath, lines.join('\n') + '\n', 'utf8');
}

function printSupabaseNextSteps(rootPath: string) {
  const lines: string[] = [];
  lines.push('Next steps');
  lines.push('');
  lines.push('Supabase Local (development)');
  lines.push(`- Install Supabase CLI: https://supabase.com/docs/guides/cli`);
  lines.push(`- In your project: cd ${rootPath}`);
  lines.push('- Start local services: supabase start');
  lines.push('- Apply migrations: supabase db reset');
  lines.push('');
  lines.push('Supabase Cloud (hosted)');
  lines.push(
    '- Create/link a project, then set SUPABASE_URL and SUPABASE_ANON_KEY in your environment',
  );
  lines.push(
    '- Apply migrations via the dashboard SQL editor or your preferred migration workflow',
  );
  console.log(lines.join('\n'));
}

async function main() {
  const program = new Command();

  program
    .name('base44-to-supabase')
    .description(
      'Migration and portability tooling to help Base44-based apps adopt Supabase (cloud or local) via a vendor-neutral adapter layer.',
    )
    .showHelpAfterError();

  program
    .command('analyze')
    .argument('<path>', 'Path to the project to analyze')
    .description('Scan a project for Base44 SDK imports and summarize detected usage.')
    .action(async (targetPath: string) => {
      const abs = resolveTargetPath(targetPath);
      const { reportPath, summary } = await runAnalyze(abs);
      console.log(summary);
      console.log('');
      console.log(`Wrote report: ${reportPath}`);
    });

  program
    .command('convert')
    .argument('<path>', 'Path to the project to convert')
    .option(
      '--backend-mode <mode>',
      'Backend mode: supabase (cloud) or local (Supabase local)',
      'supabase',
    )
    .option('--backend-entry <path>', 'Backend entry file path', 'src/backend/index.ts')
    .option('--env-example <path>', 'Env example file path', '.env.example')
    .description(
      'Remove Base44 SDK imports and generate a backend adapter entrypoint (conservative transform with TODOs).',
    )
    .action(async (targetPath: string, cmd: any) => {
      const abs = resolveTargetPath(targetPath);
      const backendMode = cmd?.backendMode === 'local' ? 'local' : 'supabase';
      const { reportPath, report } = await runConvert(abs, {
        backendMode,
        backendEntryPath: cmd?.backendEntry,
        envExamplePath: cmd?.envExample,
      });
      console.log(`Wrote report: ${reportPath}`);
      if (report.convert?.modifiedFiles?.length) {
        console.log(`Modified files: ${report.convert.modifiedFiles.length}`);
      } else {
        console.log('No files modified.');
      }
      if (report.convert?.backendEntryPath) {
        console.log(`Generated backend entry: ${report.convert.backendEntryPath}`);
      }
      if (report.convert?.envExamplePath) {
        console.log(`Generated env example: ${report.convert.envExamplePath}`);
      }

      const remaining = report.convert?.remainingBase44ModuleReferences?.length ?? 0;
      if (remaining > 0) {
        console.log(`WARNING: Remaining Base44 module references: ${remaining}`);
      }
      if (report.convert?.todos?.length) {
        console.log('');
        console.log('Manual follow-ups (from report):');
        for (const todo of report.convert.todos.slice(0, 20)) {
          console.log(`- ${todo.file}: ${todo.message}`);
        }
        if (report.convert.todos.length > 20) console.log('- ...');
      }
    });

  program
    .command('verify')
    .argument('<path>', 'Path to the project to verify')
    .description(
      'Verify that no Base44 module imports/requires remain (fails with non-zero exit code if any are found).',
    )
    .action(async (targetPath: string) => {
      const abs = resolveTargetPath(targetPath);
      const result = await runVerify(abs);
      if (result.ok) {
        console.log(
          `OK: No Base44 module references found (${result.filesScanned} file(s) scanned).`,
        );
        return;
      }
      console.log(
        `FAIL: Found Base44 module references in ${result.remaining.length} file(s) (scanned ${result.filesScanned}).`,
      );
      for (const item of result.remaining.slice(0, 20)) {
        console.log(`- ${item.file}: ${item.specifiers.join(', ')}`);
      }
      if (result.remaining.length > 20) console.log('- ...');
      process.exitCode = 1;
    });

  program
    .command('start')
    .argument('<source>', 'Path to a repo folder OR a git URL')
    .option('--out <path>', 'Output folder for the migrated copy')
    .description(
      'Interactive migration flow: copy/clone a repo, analyze Base44 usage, prompt for choices, then convert and initialize Supabase assets.',
    )
    .action(async (source: string, cmd: { out?: string }) => {
      const sourceAbs = resolveTargetPath(source);
      const sourceIsPath = await pathExists(sourceAbs);

      const defaultOutName = sourceIsPath
        ? `${path.basename(sourceAbs)}-supabase`
        : `migrated-repo-supabase`;

      const outAbs = await promptFlow(async (rl) => {
        const chosenOut = cmd.out
          ? resolveTargetPath(cmd.out)
          : resolveTargetPath(
              await promptInput(rl, 'Output folder', { defaultValue: defaultOutName }),
            );
        await ensureEmptyDir(chosenOut);

        console.log('');
        console.log('Preparing working copy...');
        if (sourceIsPath) {
          await copyProjectDir(sourceAbs, chosenOut);
        } else if (isProbablyGitUrl(source)) {
          await cloneRepo(source, chosenOut);
        } else {
          throw new Error(
            'Source was not found as a local path and does not look like a git URL. Provide a valid path or URL.',
          );
        }

        console.log('');
        console.log('Analyzing...');
        const { summary, report } = await runAnalyze(chosenOut);
        console.log(summary);

        console.log('');
        const backendChoice = await promptSelect(
          rl,
          'Which backend target should the generated backend entry use?',
          ['supabase (cloud)', 'local (Supabase local)'],
          { defaultIndex: 0 },
        );
        const backendMode = backendChoice.startsWith('local') ? 'local' : 'supabase';

        const backendEntryPath = await promptInput(rl, 'Backend entry path', {
          defaultValue: 'src/backend/index.ts',
        });
        const envExamplePath = await promptInput(rl, 'Env example path', {
          defaultValue: '.env.example',
        });

        const shouldWriteEnv = await promptConfirm(
          rl,
          'Create a .env file in the migrated copy now?',
          {
            defaultValue: false,
          },
        );

        if (shouldWriteEnv) {
          const inferred = report.inferred.envVars ?? [];
          const required = new Set<string>(inferred);
          // Ensure Supabase vars are present since the generated backend entry reads them.
          required.add('SUPABASE_URL');
          required.add('SUPABASE_ANON_KEY');
          if (backendMode === 'local') {
            required.add('SUPABASE_LOCAL_URL');
            required.add('SUPABASE_LOCAL_ANON_KEY');
          }

          const defaults: Record<string, string> = {};
          if (backendMode === 'local') {
            defaults.SUPABASE_LOCAL_URL = 'http://127.0.0.1:54321';
            defaults.SUPABASE_URL = 'http://127.0.0.1:54321';
          }

          const values = await promptEnvVars(rl, [...required].sort(), defaults);
          await writeDotEnvFile(chosenOut, values);
          console.log('Wrote .env');
        }

        console.log('');
        const ownerColumnRaw = await promptInput(
          rl,
          'Optional owner column for RLS templates (leave blank for none)',
          {
            defaultValue: '',
          },
        );
        const ownerColumn = ownerColumnRaw.trim() ? ownerColumnRaw.trim() : null;
        const includeUpdatedAt = await promptConfirm(
          rl,
          'Include updated_at columns in generated tables?',
          {
            defaultValue: false,
          },
        );

        const hasServerFunctions = (report.inferred.serverFunctions?.length ?? 0) > 0;
        const generateEdgeFunctions = hasServerFunctions
          ? await promptConfirm(
              rl,
              `Generate Supabase Edge Function stubs for inferred server functions (${report.inferred.serverFunctions.length})?`,
              { defaultValue: true },
            )
          : false;
        const functionsDir = generateEdgeFunctions
          ? await promptInput(rl, 'Edge functions output dir', {
              defaultValue: 'supabase/functions',
            })
          : undefined;

        const shouldInit = await promptConfirm(
          rl,
          'Generate Supabase SQL (migrations + RLS templates) now?',
          {
            defaultValue: true,
          },
        );

        console.log('');
        console.log('Converting...');
        const { report: convertReport } = await runConvert(chosenOut, {
          backendMode,
          backendEntryPath,
          envExamplePath,
        });

        const remaining = convertReport.convert?.remainingBase44ModuleReferences?.length ?? 0;
        if (remaining > 0) {
          console.log('');
          console.log(
            `Heads up: ${remaining} file(s) still reference Base44 modules (see report TODOs).`,
          );
        }

        if (shouldInit) {
          console.log('');
          console.log('Initializing Supabase assets...');
          await runInitSupabase(chosenOut, {
            ownerColumn,
            includeUpdatedAt,
            generateEdgeFunctions,
            functionsDir,
          });
        }

        console.log('');
        console.log(`Done. Migrated copy at: ${chosenOut}`);
        console.log('');
        printSupabaseNextSteps(chosenOut);

        return chosenOut;
      });

      void outAbs;
    });

  program
    .command('init-supabase')
    .argument('<path>', 'Path to the project to initialize Supabase assets for')
    .option('--owner-column <name>', 'Add an owner column (uuid) and tailor RLS templates to it')
    .option('--include-updated-at', 'Add updated_at columns to generated tables', false)
    .option(
      '--edge-functions',
      'Generate Edge Function stub(s) for inferred server function calls',
      false,
    )
    .option('--functions-dir <path>', 'Where to write Edge Function stubs', 'supabase/functions')
    .description('Generate Supabase SQL migrations and safe-by-default RLS policy templates.')
    .action(async (targetPath: string, cmd: any) => {
      const abs = resolveTargetPath(targetPath);
      const { reportPath, report } = await runInitSupabase(abs, {
        ownerColumn: cmd?.ownerColumn ?? null,
        includeUpdatedAt: Boolean(cmd?.includeUpdatedAt),
        generateEdgeFunctions: Boolean(cmd?.edgeFunctions),
        functionsDir: cmd?.functionsDir,
      });
      console.log(`Wrote report: ${reportPath}`);
      if (report.initSupabase) {
        console.log(`Generated: ${report.initSupabase.migrationsGenerated.length} migration(s)`);
        console.log(
          `Generated: ${report.initSupabase.policiesGenerated.length} policy template file(s)`,
        );
        if (report.initSupabase.seedGenerated)
          console.log(`Generated: ${report.initSupabase.seedGenerated}`);
        if (report.initSupabase.edgeFunctionsGenerated?.length) {
          console.log(
            `Generated: ${report.initSupabase.edgeFunctionsGenerated.length} Edge Function stub(s)`,
          );
        }
      }
      console.log('');
      printSupabaseNextSteps(abs);
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
