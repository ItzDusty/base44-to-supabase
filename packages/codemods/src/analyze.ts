import path from 'node:path';
import { Project, SyntaxKind, type CallExpression } from 'ts-morph';

import { findProjectSourceFiles, toPosixPath } from './fs.js';
import {
  classifyUsageFromText,
  isLikelyBase44ImportSource,
  DEFAULT_BASE44_IMPORT_SOURCES,
} from './sdkHeuristics.js';
import {
  createEmptyReport,
  type Base44ToSupabaseReport,
  type InferredEntity,
  type InferredServerFunction,
  type UsageCategory,
} from './report.js';

export type AnalyzeOptions = {
  rootPath: string;
  base44ImportSources?: string[];
};

function getRelative(rootPath: string, filePath: string): string {
  return toPosixPath(path.relative(rootPath, filePath));
}

function mergeUnique<T>(a: T[], b: T[]): T[] {
  const set = new Set<T>(a);
  for (const x of b) set.add(x);
  return [...set];
}

function inferEntityFromCall(call: CallExpression): { entity?: string; fields: string[] } {
  const fields: string[] = [];

  const args = call.getArguments();
  const firstArg = args[0];
  const secondArg = args[1];

  if (firstArg?.isKind(SyntaxKind.StringLiteral)) {
    // e.g. create('todos', { title: ... })
    const entity = firstArg.getLiteralText();
    if (secondArg && secondArg.isKind(SyntaxKind.ObjectLiteralExpression)) {
      for (const prop of secondArg.getProperties()) {
        if (prop.isKind(SyntaxKind.PropertyAssignment)) {
          fields.push(prop.getName());
        }
      }
    }
    return { entity, fields };
  }

  // e.g. db.collection('todos').create({ ... })
  const expr = call.getExpression();
  if (expr.isKind(SyntaxKind.PropertyAccessExpression)) {
    const chainText = expr.getExpression().getText();
    const m = chainText.match(/collection\((['"])(?<name>[^'"]+)\1\)/);
    const entity = m?.groups?.name;
    const payload = args[0];
    if (payload && payload.isKind(SyntaxKind.ObjectLiteralExpression)) {
      for (const prop of payload.getProperties()) {
        if (prop.isKind(SyntaxKind.PropertyAssignment)) {
          fields.push(prop.getName());
        }
      }
    }
    return { entity, fields };
  }

  return { fields };
}

function addEntity(
  entities: Map<string, InferredEntity>,
  entityName: string,
  newFields: string[],
  file: string,
) {
  const existing = entities.get(entityName);
  const mergedFields = mergeUnique(existing?.fields ?? [], newFields).sort();
  entities.set(entityName, {
    name: entityName,
    fields: mergedFields,
    evidence: mergeUnique(existing?.evidence ?? [], [{ file }]),
  });
}

function addServerFunction(
  functions: Map<string, InferredServerFunction>,
  name: string,
  file: string,
  snippet?: string,
) {
  const existing = functions.get(name);
  const evidence = mergeUnique(existing?.evidence ?? [], [{ file, snippet }]);
  functions.set(name, {
    name,
    evidence,
  });
}

function inferEnvVarsFromText(text: string): string[] {
  const vars = new Set<string>();

  // process.env.NAME
  for (const m of text.matchAll(/\bprocess\.env\.(?<name>[A-Z0-9_]+)\b/g)) {
    const name = m.groups?.name;
    if (name) vars.add(name);
  }

  // process.env['NAME'] / process.env["NAME"]
  for (const m of text.matchAll(/\bprocess\.env\[(?:'|")(?<name>[A-Z0-9_]+)(?:'|")\]/g)) {
    const name = m.groups?.name;
    if (name) vars.add(name);
  }

  // import.meta.env.NAME
  for (const m of text.matchAll(/\bimport\.meta\.env\.(?<name>[A-Z0-9_]+)\b/g)) {
    const name = m.groups?.name;
    if (name) vars.add(name);
  }

  // import.meta.env['NAME'] / import.meta.env["NAME"]
  for (const m of text.matchAll(/\bimport\.meta\.env\[(?:'|")(?<name>[A-Z0-9_]+)(?:'|")\]/g)) {
    const name = m.groups?.name;
    if (name) vars.add(name);
  }

  return [...vars].sort();
}

export async function analyzeProject(options: AnalyzeOptions): Promise<Base44ToSupabaseReport> {
  const rootPath = path.resolve(options.rootPath);
  const report = createEmptyReport(rootPath);

  const sourceFiles = await findProjectSourceFiles({ cwd: rootPath });

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
  });

  for (const abs of sourceFiles) {
    project.addSourceFileAtPath(abs);
  }

  const entities = new Map<string, InferredEntity>();
  const serverFunctions = new Map<string, InferredServerFunction>();
  const envVars = new Set<string>();

  const importSources = options.base44ImportSources ?? DEFAULT_BASE44_IMPORT_SOURCES;

  for (const sf of project.getSourceFiles()) {
    const rel = getRelative(rootPath, sf.getFilePath());

    for (const v of inferEnvVarsFromText(sf.getFullText())) envVars.add(v);

    const imports = sf.getImportDeclarations();
    for (const imp of imports) {
      const source = imp.getModuleSpecifierValue();
      const looksLike = isLikelyBase44ImportSource(source) || importSources.includes(source);
      if (!looksLike) continue;

      const importedNames: string[] = [];
      const named = imp.getNamedImports();
      for (const n of named) importedNames.push(n.getName());
      const def = imp.getDefaultImport();
      if (def) importedNames.push(def.getText());
      const ns = imp.getNamespaceImport();
      if (ns) importedNames.push(ns.getText());

      report.base44.importSources = mergeUnique(report.base44.importSources, [source]);
      report.base44.filesWithImports = mergeUnique(report.base44.filesWithImports, [rel]);

      const categories = classifyUsageFromText(sf.getFullText()) as UsageCategory[];
      report.base44.categoriesDetected = mergeUnique(
        report.base44.categoriesDetected,
        categories,
      ).sort();

      report.base44.findings.push({
        file: rel,
        importSource: source,
        importedNames,
        categories,
      });

      // Best-effort entity inference: look for create/update calls in the file
      const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const exprText = call.getExpression().getText();
        if (!/(create|update|insert|set)\b/i.test(exprText)) continue;
        const inferred = inferEntityFromCall(call);
        if (!inferred.entity) continue;
        if (inferred.fields.length === 0) continue;
        addEntity(entities, inferred.entity, inferred.fields, rel);
      }

      // Best-effort server function inference: look for invoke/rpc with string literal names.
      for (const call of calls) {
        const expr = call.getExpression();
        if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) continue;
        const method = expr.getName();
        if (method !== 'invoke' && method !== 'rpc') continue;

        const first = call.getArguments()[0];
        if (!first || !first.isKind(SyntaxKind.StringLiteral)) continue;
        const name = first.getLiteralText();
        if (!name) continue;
        addServerFunction(serverFunctions, name, rel, call.getText().slice(0, 200));
      }

      break; // one Base44 import is enough to analyze the file
    }
  }

  report.inferred.entities = [...entities.values()].sort((a, b) => a.name.localeCompare(b.name));
  report.inferred.serverFunctions = [...serverFunctions.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  report.inferred.envVars = [...envVars].sort();
  return report;
}
