export const DEFAULT_BASE44_IMPORT_SOURCES = [
  'base44',
  '@base44/sdk',
  '@base44/client',
  'base44-sdk',
];

export function isLikelyBase44ImportSource(moduleSpecifier: string): boolean {
  if (DEFAULT_BASE44_IMPORT_SOURCES.includes(moduleSpecifier)) return true;
  const lower = moduleSpecifier.toLowerCase();
  if (lower.includes('base44')) return true;
  return false;
}

export function classifyUsageFromText(
  text: string,
): Array<'auth' | 'data' | 'storage' | 'realtime' | 'server-functions' | 'unknown'> {
  const t = text.toLowerCase();
  const categories = new Set<
    'auth' | 'data' | 'storage' | 'realtime' | 'server-functions' | 'unknown'
  >();

  if (/(\bauth\b|signin|signout|getuser|session)/i.test(t)) categories.add('auth');
  if (
    /(collection|collections|database|db\b|create\(|update\(|delete\(|insert\(|select\()/i.test(t)
  )
    categories.add('data');
  if (/(storage|bucket|upload\(|download\(|file)/i.test(t)) categories.add('storage');
  if (/(realtime|subscribe|channel|presence)/i.test(t)) categories.add('realtime');
  if (/(function|functions|rpc|invoke)/i.test(t)) categories.add('server-functions');

  if (categories.size === 0) categories.add('unknown');
  return [...categories];
}
