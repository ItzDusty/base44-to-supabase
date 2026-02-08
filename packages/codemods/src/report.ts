export type UsageCategory =
  | 'auth'
  | 'data'
  | 'storage'
  | 'realtime'
  | 'server-functions'
  | 'unknown';

export type InferredEntity = {
  name: string;
  fields: string[];
  evidence?: Array<{ file: string; snippet?: string }>;
};

export type InferredServerFunction = {
  name: string;
  evidence?: Array<{ file: string; snippet?: string }>;
};

export type ConversionTodo = {
  file: string;
  message: string;
};

export type AnalyzeFinding = {
  file: string;
  importSource: string;
  importedNames: string[];
  categories: UsageCategory[];
};

export type Base44ToSupabaseReport = {
  version: 1;
  createdAt: string;
  rootPath: string;
  base44: {
    importSources: string[];
    filesWithImports: string[];
    findings: AnalyzeFinding[];
    categoriesDetected: UsageCategory[];
  };
  inferred: {
    entities: InferredEntity[];
    serverFunctions: InferredServerFunction[];
    envVars: string[];
  };
  convert?: {
    modifiedFiles: string[];
    featuresConverted: UsageCategory[];
    todos: ConversionTodo[];
    remainingBase44ModuleReferences?: Array<{ file: string; specifiers: string[] }>;
    backendEntryPath?: string;
    envExamplePath?: string;
  };
  initSupabase?: {
    supabaseDir: string;
    migrationsGenerated: string[];
    policiesGenerated: string[];
    seedGenerated?: string;
    edgeFunctionsGenerated?: string[];
  };
};

export function createEmptyReport(rootPath: string): Base44ToSupabaseReport {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    rootPath,
    base44: {
      importSources: [],
      filesWithImports: [],
      findings: [],
      categoriesDetected: [],
    },
    inferred: {
      entities: [],
      serverFunctions: [],
      envVars: [],
    },
  };
}
