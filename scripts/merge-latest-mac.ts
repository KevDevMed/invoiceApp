// Merge the two per-arch `latest-mac.yml` files that the build matrix produces
// into the single update feed electron-updater reads.
//
// Each macOS matrix leg packages one architecture, so each leg's
// `latest-mac.yml` lists only its own zip — and both legs write the same
// filename. Publishing either one as-is would leave half the install base
// unable to update. This script unions the two `files` lists into one feed;
// electron-updater's MacUpdater picks the right entry by looking for `arm64`
// in the filename (MacUpdater.js, filterFilesForArch), so a single merged
// file serves both architectures.
//
// CLI: node --import tsx scripts/merge-latest-mac.ts <arm64.yml> <x64.yml> <out.yml>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, dump } from 'js-yaml';

interface UpdateFileEntry {
  url: string;
  sha512: string;
  size?: number;
  [key: string]: unknown;
}

interface LatestMac {
  version: string;
  files: UpdateFileEntry[];
  path: string;
  sha512: string;
  releaseDate: string;
  [key: string]: unknown;
}

function parseLatestMac(yml: string, label: string): LatestMac {
  const doc = load(yml);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`${label}: not a YAML mapping`);
  }
  const record = doc as Record<string, unknown>;
  if (typeof record.version !== 'string' || record.version.length === 0) {
    throw new Error(`${label}: missing "version"`);
  }
  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw new Error(`${label}: missing or empty "files"`);
  }
  for (const entry of record.files as unknown[]) {
    const file = entry as Partial<UpdateFileEntry> | null;
    if (typeof file?.url !== 'string' || typeof file?.sha512 !== 'string') {
      throw new Error(`${label}: a "files" entry is missing "url" or "sha512"`);
    }
  }
  if (typeof record.releaseDate !== 'string') {
    throw new Error(`${label}: missing "releaseDate"`);
  }
  return record as unknown as LatestMac;
}

export function mergeLatestMac(arm64Yml: string, x64Yml: string): string {
  const arm64 = parseLatestMac(arm64Yml, 'arm64 input');
  const x64 = parseLatestMac(x64Yml, 'x64 input');

  // A version mismatch means the two matrix legs packaged different commits;
  // that release must not go out at all.
  if (arm64.version !== x64.version) {
    throw new Error(
      `version mismatch: arm64 input says ${arm64.version}, x64 input says ${x64.version} — ` +
        'the two build legs packaged different versions, refusing to merge',
    );
  }

  // Union by url, arm64 entries first. sha512/size are carried through
  // untouched — recomputing or rounding either would break signature checks
  // on the client.
  const files: UpdateFileEntry[] = [];
  const seenUrls = new Set<string>();
  for (const entry of [...arm64.files, ...x64.files]) {
    if (seenUrls.has(entry.url)) continue;
    seenUrls.add(entry.url);
    files.push(entry);
  }

  const arm64Entries = files.filter((f) => f.url.includes('arm64'));
  const x64Entries = files.filter((f) => f.url.includes('x64'));
  if (arm64Entries.length !== 1 || x64Entries.length !== 1) {
    throw new Error(
      `merged feed must contain exactly one arm64 entry and one x64 entry, got ` +
        `${arm64Entries.length} arm64 / ${x64Entries.length} x64 ` +
        `(urls: ${files.map((f) => f.url).join(', ')}) — a half-populated feed would ` +
        'silently strand one architecture, refusing to merge',
    );
  }

  // Older clients ignore `files` and read only the top-level path/sha512.
  // Point those at the x64 zip: an Intel binary still runs on Apple Silicon
  // under Rosetta; an arm64 binary does not run on Intel at all.
  const [legacy] = x64Entries;
  if (!legacy) throw new Error('unreachable: x64 entry vanished after the count check');

  const later =
    Date.parse(arm64.releaseDate) >= Date.parse(x64.releaseDate)
      ? arm64.releaseDate
      : x64.releaseDate;

  const merged: LatestMac = {
    version: arm64.version,
    files,
    path: legacy.url,
    sha512: legacy.sha512,
    releaseDate: later,
  };

  // lineWidth: -1 keeps the ~88-char base64 sha512 values on one line instead
  // of YAML-folding them.
  return dump(merged, { lineWidth: -1 });
}

function main(argv: string[]): void {
  if (argv.length !== 3) {
    console.error(
      'usage: node --import tsx scripts/merge-latest-mac.ts <arm64.yml> <x64.yml> <out.yml>',
    );
    process.exit(2);
  }
  const [arm64Path, x64Path, outPath] = argv as [string, string, string];
  let merged: string;
  try {
    merged = mergeLatestMac(readFileSync(arm64Path, 'utf8'), readFileSync(x64Path, 'utf8'));
  } catch (error) {
    console.error(`merge-latest-mac: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  writeFileSync(outPath, merged);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
