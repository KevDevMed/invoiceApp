/**
 * Guard against module paths that only differ by case.
 *
 * This repo ships on macOS, whose filesystem is case-insensitive, but every
 * gate (`ci.yml`, the review and behavioural passes) runs on Linux, which is
 * case-sensitive. That asymmetry hides a whole class of defect until the macOS
 * packaging run — which happens *after* the merge. v0.3.0 was tagged with no
 * artifacts because of exactly this: PR #22 added
 * `src/renderer/ui/invoiceTabs.ts` beside `src/renderer/ui/InvoiceTabs.tsx`.
 * On Linux those are two unrelated modules; on macOS the specifier
 * `./ui/InvoiceTabs` matches both, TypeScript tries `.ts` before `.tsx`, binds
 * the pure module, and fails with TS2305 plus TS1149.
 *
 * So the comparison here is the module path *without its extension* — that is
 * what an import specifier names and what the filesystem matches
 * case-insensitively. Comparing whole filenames does not work:
 * `invoicetabs.ts` and `invoicetabs.tsx` are different strings, and the pair
 * above would slip straight through.
 *
 * The file list comes from `git ls-files`, not a hard-coded list, so files
 * added later are covered without touching this test.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function trackedFiles(): string[] {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter((line) => line.length > 0);
}

/** Groups paths by the key, keeping only the keys with more than one path. */
function collisions(paths: string[], key: (p: string) => string): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const p of paths) {
    const k = key(p);
    const seen = byKey.get(k);
    if (seen) seen.push(p);
    else byKey.set(k, [p]);
  }
  return new Map([...byKey].filter(([, group]) => group.length > 1));
}

function report(found: Map<string, string[]>, explanation: string): string {
  const lines = [...found]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, group]) => `  ${k}\n${group.map((p) => `    ${p}`).join('\n')}`);
  return `${explanation}\n${lines.join('\n')}`;
}

describe('module paths', () => {
  it('has no two TypeScript modules whose paths differ only in casing', () => {
    const sources = trackedFiles().filter(
      (p) =>
        (p.startsWith('src/') || p.startsWith('preview/')) &&
        (p.endsWith('.ts') || p.endsWith('.tsx')),
    );
    // Sanity: if the pathspec or the list ever comes back empty the assertion
    // below would pass vacuously.
    expect(sources.length).toBeGreaterThan(50);

    const found = collisions(sources, (p) => p.replace(/\.tsx?$/, '').toLowerCase());

    expect(
      found.size === 0
        ? ''
        : report(
            found,
            'These modules differ only in the case of their path, so macOS ' +
              '(case-insensitive filesystem) resolves them to the SAME module ' +
              'while Linux resolves them to two. TypeScript also tries `.ts` ' +
              'before `.tsx`, so an import meant for the component silently ' +
              'binds the `.ts` file on macOS and the macOS build fails with ' +
              'TS2305/TS1149 — after every Linux gate has gone green. Rename ' +
              'one of them (camelCase `.ts` for pure logic, PascalCase `.tsx` ' +
              'for components) so no two module paths share a lowercased form:',
          ),
    ).toBe('');
  });

  it('has no two tracked files whose full paths differ only in casing', () => {
    // Same blind spot, wider blast radius: on a case-insensitive checkout two
    // such files collapse onto one another, so the working tree macOS gets is
    // not the tree Linux CI tested. Cheap to assert while we are here.
    const found = collisions(trackedFiles(), (p) => p.toLowerCase());

    expect(
      found.size === 0
        ? ''
        : report(
            found,
            'These tracked paths differ only in case. A macOS ' +
              '(case-insensitive) checkout cannot hold both, so one silently ' +
              'overwrites the other there while Linux CI sees both:',
          ),
    ).toBe('');
  });
});
