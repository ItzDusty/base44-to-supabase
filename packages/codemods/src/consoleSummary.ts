import type { Base44ToSupabaseReport } from './report.js';

export function formatAnalyzeSummary(report: Base44ToSupabaseReport): string {
  const lines: string[] = [];
  lines.push('Base44 → Supabase analysis');
  lines.push('');
  lines.push(`Files with Base44 imports: ${report.base44.filesWithImports.length}`);
  lines.push(`Import sources: ${report.base44.importSources.join(', ') || '(none found)'}`);
  lines.push(`Categories detected: ${report.base44.categoriesDetected.join(', ') || '(none)'}`);
  lines.push(`Inferred entities: ${report.inferred.entities.length}`);
  if (report.inferred.entities.length) {
    for (const e of report.inferred.entities.slice(0, 10)) {
      lines.push(`  - ${e.name}: ${e.fields.join(', ')}`);
    }
    if (report.inferred.entities.length > 10) lines.push('  ...');
  }

  lines.push(`Inferred server functions: ${report.inferred.serverFunctions.length}`);
  if (report.inferred.serverFunctions.length) {
    for (const fn of report.inferred.serverFunctions.slice(0, 10)) {
      lines.push(`  - ${fn.name}`);
    }
    if (report.inferred.serverFunctions.length > 10) lines.push('  ...');
  }

  lines.push(`Inferred env vars: ${report.inferred.envVars.length}`);
  if (report.inferred.envVars.length) {
    for (const v of report.inferred.envVars.slice(0, 10)) {
      lines.push(`  - ${v}`);
    }
    if (report.inferred.envVars.length > 10) lines.push('  ...');
  }
  return lines.join('\n');
}
