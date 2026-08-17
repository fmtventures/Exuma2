import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|js|sql|css|html|md)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = [...walk('src'), ...walk('tests'), ...walk('docs')];

describe('source hygiene', () => {
  it('contains no stray control characters', () => {
    // A literal NUL once landed in a template-literal map key. The lookup
    // silently returned undefined rather than failing, so a stock level read
    // as "no record" instead of "six in Halifax" — and grep reported the file
    // as binary, hiding it from every text search used to look for the cause.
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'latin1');
      // Tab, newline and carriage return are the only legitimate ones.
      const match = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line} contains U+${match[0].charCodeAt(0).toString(16).padStart(4, '0')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no file that git would treat as binary', () => {
    const binary = FILES.filter((f) => readFileSync(f).includes(0));
    expect(binary).toEqual([]);
  });
});
