export function findImportedModuleSpecifiers(text: string): string[] {
  const out: string[] = [];

  // import ... from 'x'
  // require('x')
  // import('x')
  const re =
    /(from\s+['"]([^'"]+)['"])|(require\s*\(\s*['"]([^'"]+)['"]\s*\))|(import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[2] ?? m[4] ?? m[6];
    if (spec) out.push(spec);
  }

  return [...new Set(out)];
}
