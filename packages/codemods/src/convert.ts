import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Project,
  SyntaxKind,
  type CallExpression,
  type ImportDeclaration,
  type PropertyAccessExpression,
  type SourceFile,
} from 'ts-morph';

import { findProjectSourceFiles, toPosixPath } from './fs.js';
import { findImportedModuleSpecifiers } from './importScan.js';
import { isLikelyBase44ImportSource } from './sdkHeuristics.js';
import type { Base44ToSupabaseReport, ConversionTodo, UsageCategory } from './report.js';

export type ConvertOptions = {
  rootPath: string;
  report: Base44ToSupabaseReport;
  backend?: {
    mode: 'supabase' | 'local';
    entryPath?: string;
  };
  envExamplePath?: string;
};

type Base44Bindings = {
  namespaceLike: string[]; // e.g. base44 (default import) or Base44 (namespace import)
  auth: string[];
  collections: string[];
  storage: string[];
};

function rel(rootPath: string, abs: string): string {
  return toPosixPath(path.relative(rootPath, abs));
}

function computeBackendImport(
  fromFileAbs: string,
  rootPath: string,
  backendEntryAbs: string,
): string {
  const fromDir = path.dirname(fromFileAbs);
  const backendAbsNoExt = backendEntryAbs.replace(/\.(ts|tsx|js|jsx)$/, '');
  const relPath = path.relative(fromDir, backendAbsNoExt);
  const posix = toPosixPath(relPath);

  // Use a .js specifier so NodeNext/ESM projects can compile cleanly.
  const withExt = posix.endsWith('.js') ? posix : `${posix}.js`;
  return withExt.startsWith('.') ? withExt : `./${withExt}`;
}

function removeBase44Imports(sf: SourceFile): ImportDeclaration[] {
  const removed: ImportDeclaration[] = [];
  for (const imp of sf.getImportDeclarations()) {
    const src = imp.getModuleSpecifierValue();
    if (isLikelyBase44ImportSource(src)) {
      removed.push(imp);
      imp.remove();
    }
  }
  return removed;
}

function findBase44Imports(sf: SourceFile): ImportDeclaration[] {
  return sf
    .getImportDeclarations()
    .filter((imp) => isLikelyBase44ImportSource(imp.getModuleSpecifierValue()));
}

function extractBindings(removed: ImportDeclaration[]): Base44Bindings {
  const bindings: Base44Bindings = {
    namespaceLike: [],
    auth: [],
    collections: [],
    storage: [],
  };

  for (const imp of removed) {
    const def = imp.getDefaultImport();
    if (def) bindings.namespaceLike.push(def.getText());

    const ns = imp.getNamespaceImport();
    if (ns) bindings.namespaceLike.push(ns.getText());

    for (const n of imp.getNamedImports()) {
      const imported = n.getName();
      const local = n.getAliasNode()?.getText() ?? imported;
      const lower = imported.toLowerCase();

      if (lower === 'auth') bindings.auth.push(local);
      if (lower === 'collections' || lower === 'collection') bindings.collections.push(local);
      if (lower === 'storage') bindings.storage.push(local);
    }
  }

  // De-dupe
  for (const key of Object.keys(bindings) as Array<keyof Base44Bindings>) {
    bindings[key] = [...new Set(bindings[key])];
  }
  return bindings;
}

function isNamespaceMember(
  expr: PropertyAccessExpression,
  namespaceName: string,
  memberName: string,
): boolean {
  return expr.getExpression().getText() === namespaceName && expr.getName() === memberName;
}

function isAuthReceiver(expr: any, bindings: Base44Bindings): boolean {
  if (expr?.isKind?.(SyntaxKind.Identifier) && bindings.auth.includes(expr.getText())) return true;

  if (expr?.isKind?.(SyntaxKind.PropertyAccessExpression)) {
    const pae = expr as PropertyAccessExpression;
    for (const ns of bindings.namespaceLike) {
      if (isNamespaceMember(pae, ns, 'auth')) return true;
    }
  }
  return false;
}

function isCollectionsCallee(call: CallExpression, bindings: Base44Bindings): boolean {
  const expr = call.getExpression();
  if (expr.isKind(SyntaxKind.Identifier) && bindings.collections.includes(expr.getText()))
    return true;
  if (expr.isKind(SyntaxKind.PropertyAccessExpression)) {
    const pae = expr as PropertyAccessExpression;
    for (const ns of bindings.namespaceLike) {
      if (isNamespaceMember(pae, ns, 'collections') || isNamespaceMember(pae, ns, 'collection'))
        return true;
    }
  }
  return false;
}

function isStorageReceiver(expr: any, bindings: Base44Bindings): boolean {
  if (expr?.isKind?.(SyntaxKind.Identifier) && bindings.storage.includes(expr.getText()))
    return true;
  if (expr?.isKind?.(SyntaxKind.PropertyAccessExpression)) {
    const pae = expr as PropertyAccessExpression;
    for (const ns of bindings.namespaceLike) {
      if (isNamespaceMember(pae, ns, 'storage')) return true;
    }
  }
  return false;
}

function addFileTodo(todos: ConversionTodo[], file: string, message: string) {
  todos.push({ file, message });
}

function getCallSnapshotReverse(sf: SourceFile): CallExpression[] {
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  // Rewrite from bottom to top so earlier replacements don't invalidate nodes we haven't visited yet.
  calls.sort((a, b) => b.getStart() - a.getStart());
  return calls;
}

function rewriteAuthCalls(sf: SourceFile, bindings: Base44Bindings): number {
  let rewritten = 0;
  for (const call of getCallSnapshotReverse(sf)) {
    if (call.wasForgotten()) continue;
    const expr = call.getExpression();
    if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) continue;
    const pae = expr as PropertyAccessExpression;
    if (!isAuthReceiver(pae.getExpression(), bindings)) continue;

    const method = pae.getName();
    if (method !== 'signIn' && method !== 'signOut' && method !== 'getUser') continue;

    call.replaceWithText(
      `backend.auth.${method}(${call
        .getArguments()
        .map((a) => a.getText())
        .join(', ')})`,
    );
    rewritten++;
  }
  return rewritten;
}

function rewriteStorageCalls(
  sf: SourceFile,
  bindings: Base44Bindings,
): { rewritten: number; unknown: number } {
  let rewritten = 0;
  let unknown = 0;

  for (const call of getCallSnapshotReverse(sf)) {
    if (call.wasForgotten()) continue;
    const expr = call.getExpression();
    if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) continue;
    const pae = expr as PropertyAccessExpression;
    if (!isStorageReceiver(pae.getExpression(), bindings)) continue;

    const method = pae.getName();
    if (method === 'upload' || method === 'download') {
      call.replaceWithText(
        `backend.storage.${method}(${call
          .getArguments()
          .map((a) => a.getText())
          .join(', ')})`,
      );
      rewritten++;
    } else {
      unknown++;
    }
  }

  return { rewritten, unknown };
}

function rewriteCollectionsCrud(
  sf: SourceFile,
  bindings: Base44Bindings,
): { rewritten: number; unknown: number; unknownEntities: number } {
  let rewritten = 0;
  let unknown = 0;
  let unknownEntities = 0;

  // Look for: collections('entity').method(...)
  for (const call of getCallSnapshotReverse(sf)) {
    if (call.wasForgotten()) continue;
    const expr = call.getExpression();
    if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) continue;

    const outerProp = expr as PropertyAccessExpression;
    const method = outerProp.getName();
    const receiver = outerProp.getExpression();

    if (!receiver.isKind(SyntaxKind.CallExpression)) continue;
    const innerCall = receiver as CallExpression;
    if (innerCall.wasForgotten()) continue;
    if (!isCollectionsCallee(innerCall, bindings)) continue;

    const innerArgs = innerCall.getArguments();
    const entityArg = innerArgs[0];
    if (!entityArg || !entityArg.isKind(SyntaxKind.StringLiteral)) {
      unknownEntities++;
      continue;
    }

    const entityText = entityArg.getText();
    const args = call.getArguments().map((a) => a.getText());

    if (method === 'create') {
      if (args.length < 1) {
        unknown++;
        continue;
      }
      call.replaceWithText(`backend.data.create(${entityText}, ${args[0]})`);
      rewritten++;
      continue;
    }

    if (method === 'update') {
      if (args.length === 2) {
        call.replaceWithText(`backend.data.update(${entityText}, ${args[0]}, ${args[1]})`);
        rewritten++;
        continue;
      }
      unknown++;
      continue;
    }

    if (method === 'delete' || method === 'remove') {
      if (args.length >= 1) {
        call.replaceWithText(`backend.data.delete(${entityText}, ${args[0]})`);
        rewritten++;
        continue;
      }
      unknown++;
      continue;
    }

    if (method === 'get' || method === 'read') {
      if (args.length >= 1) {
        call.replaceWithText(`backend.data.read(${entityText}, { id: ${args[0]} })`);
        rewritten++;
        continue;
      }
      call.replaceWithText(`backend.data.read(${entityText})`);
      rewritten++;
      continue;
    }

    if (method === 'list' || method === 'all') {
      if (args.length === 0) {
        call.replaceWithText(`backend.data.read(${entityText})`);
        rewritten++;
        continue;
      }
      if (args.length >= 1) {
        call.replaceWithText(`backend.data.read(${entityText}, { filter: ${args[0]} })`);
        rewritten++;
        continue;
      }
    }

    if (method === 'find') {
      if (args.length >= 1) {
        call.replaceWithText(`backend.data.read(${entityText}, { filter: ${args[0]} })`);
        rewritten++;
        continue;
      }
      unknown++;
      continue;
    }

    unknown++;
  }

  return { rewritten, unknown, unknownEntities };
}

function ensureBackendImport(sf: SourceFile, moduleSpecifier: string) {
  const existing = sf
    .getImportDeclarations()
    .find((d) => d.getModuleSpecifierValue() === moduleSpecifier);
  if (existing) return;

  const importDecls = sf.getImportDeclarations();
  if (importDecls.length > 0) {
    sf.addImportDeclaration({
      moduleSpecifier,
      namedImports: ['backend'],
    });
    return;
  }

  // Some frameworks (e.g. Next.js) require directive prologues like "use client" to be the
  // first statement in the file. Imports are allowed after such directives.
  const statements = sf.getStatements();
  let insertIndex = 0;
  for (const st of statements) {
    if (!st.isKind(SyntaxKind.ExpressionStatement)) break;
    const expr = st.asKindOrThrow(SyntaxKind.ExpressionStatement).getExpression();
    if (
      expr.isKind(SyntaxKind.StringLiteral) ||
      expr.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
    ) {
      insertIndex++;
      continue;
    }
    break;
  }

  sf.insertStatements(insertIndex, `import { backend } from ${JSON.stringify(moduleSpecifier)};`);
}

export async function convertProject(options: ConvertOptions): Promise<Base44ToSupabaseReport> {
  const rootPath = path.resolve(options.rootPath);
  const report = options.report;

  const backendMode = options.backend?.mode ?? 'supabase';
  const backendEntryRel =
    options.backend?.entryPath ?? toPosixPath(path.join('src', 'backend', 'index.ts'));
  const envExampleRel = options.envExamplePath ?? '.env.example';

  const backendEntryAbs = path.join(rootPath, backendEntryRel);
  const envExampleAbs = path.join(rootPath, envExampleRel);

  const modifiedFiles: string[] = [];
  const todos: ConversionTodo[] = [];
  const remainingBase44ModuleReferences: Array<{ file: string; specifiers: string[] }> = [];

  const sourceFiles = await findProjectSourceFiles({ cwd: rootPath });
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
  });

  for (const abs of sourceFiles) project.addSourceFileAtPath(abs);

  for (const sf of project.getSourceFiles()) {
    const abs = sf.getFilePath();
    const r = rel(rootPath, abs);

    const base44Imports = findBase44Imports(sf);
    if (base44Imports.length === 0) continue;

    const bindings = extractBindings(base44Imports);
    removeBase44Imports(sf);

    const backendImport = computeBackendImport(abs, rootPath, backendEntryAbs);
    ensureBackendImport(sf, backendImport);

    // Attempt best-effort call-site rewrites for common patterns.
    const authRewritten = rewriteAuthCalls(sf, bindings);
    const collectionsResult = rewriteCollectionsCrud(sf, bindings);
    const storageResult = rewriteStorageCalls(sf, bindings);

    const anyRewritten = authRewritten + collectionsResult.rewritten + storageResult.rewritten;
    const anyUnknown =
      collectionsResult.unknown + collectionsResult.unknownEntities + storageResult.unknown;

    if (anyUnknown > 0 || anyRewritten === 0) {
      const firstStmt = sf.getStatements()[0];
      if (firstStmt) {
        sf.insertStatements(
          0,
          `// TODO(base44-to-supabase): Some Base44 usage could not be safely converted. Review this file and route remaining calls through backend.auth/backend.data/backend.storage.`,
        );
      }
    }

    if (collectionsResult.unknownEntities > 0) {
      addFileTodo(
        todos,
        r,
        `Found collections(...) usage where the entity name is not a string literal (${collectionsResult.unknownEntities} occurrence(s)). Manual conversion required.`,
      );
    }
    if (collectionsResult.unknown > 0) {
      addFileTodo(
        todos,
        r,
        `Found collections CRUD calls that do not match supported signatures (${collectionsResult.unknown} occurrence(s)). Manual conversion required.`,
      );
    }
    if (storageResult.unknown > 0) {
      addFileTodo(
        todos,
        r,
        `Found storage.* calls that are not upload/download (${storageResult.unknown} occurrence(s)). Manual conversion required.`,
      );
    }

    modifiedFiles.push(r);
  }

  await project.save();

  // Post-pass verification: flag any remaining Base44 module imports/requires.
  // This catches CommonJS require() / dynamic import() patterns that the main pass won't remove.
  await Promise.all(
    sourceFiles.map(async (abs) => {
      const r = rel(rootPath, abs);
      const text = await fs.readFile(abs, 'utf8');
      const specs = findImportedModuleSpecifiers(text).filter(isLikelyBase44ImportSource);
      if (specs.length === 0) return;

      remainingBase44ModuleReferences.push({ file: r, specifiers: specs });

      addFileTodo(
        todos,
        r,
        `Remaining Base44 module reference(s) detected: ${specs
          .map((s) => JSON.stringify(s))
          .join(', ')}. Manual conversion required.`,
      );
    }),
  );

  // Generate backend entry file and .env.example (best-effort)
  await fs.mkdir(path.dirname(backendEntryAbs), { recursive: true });
  if (backendMode === 'local') {
    await fs.writeFile(
      backendEntryAbs,
      `import type { Backend } from '@base44-to-supabase/adapter';\nimport { createLocalSupabaseBackendFromEnv } from '@base44-to-supabase/adapter-local';\n\n// Generated by base44-to-supabase.\n// Customize this file for your app (e.g. multiple clients, admin client, server-only code).\n\nexport const backend: Backend = createLocalSupabaseBackendFromEnv();\n`,
      'utf8',
    );
  } else {
    await fs.writeFile(
      backendEntryAbs,
      `import type { Backend } from '@base44-to-supabase/adapter';\nimport { createSupabaseBackendFromEnv } from '@base44-to-supabase/adapter-supabase';\n\n// Generated by base44-to-supabase.\n// Customize this file for your app (e.g. multiple clients, admin client, server-only code).\n\nexport const backend: Backend = createSupabaseBackendFromEnv();\n`,
      'utf8',
    );
  }

  await fs.writeFile(
    envExampleAbs,
    `# Supabase\n# Cloud: set SUPABASE_URL and SUPABASE_ANON_KEY\n# Local: SUPABASE_URL defaults to http://127.0.0.1:54321 when using adapter-local\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\n\n# Optional local overrides\nSUPABASE_LOCAL_URL=http://127.0.0.1:54321\nSUPABASE_LOCAL_ANON_KEY=\n`,
    'utf8',
  );

  const featuresConverted: UsageCategory[] = report.base44.categoriesDetected;

  report.convert = {
    modifiedFiles: modifiedFiles.sort(),
    featuresConverted,
    todos,
    remainingBase44ModuleReferences:
      remainingBase44ModuleReferences.length > 0
        ? remainingBase44ModuleReferences.sort((a, b) => a.file.localeCompare(b.file))
        : undefined,
    backendEntryPath: toPosixPath(path.relative(rootPath, backendEntryAbs)),
    envExamplePath: toPosixPath(path.relative(rootPath, envExampleAbs)),
  };

  return report;
}
