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

// The five keys this script computes itself; everything else is passed
// through from the inputs.
const COMPUTED_KEYS = new Set(['version', 'files', 'path', 'sha512', 'releaseDate']);

// Structural equality for YAML-parsed values. JSON.stringify is not enough:
// two mappings with the same entries can serialise differently when their
// keys arrive in a different order.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    return (
      aKeys.length === Object.keys(bRecord).length &&
      aKeys.every((key) => key in bRecord && deepEqual(aRecord[key], bRecord[key]))
    );
  }
  return false;
}

// Every top-level key beyond the five computed ones is preserved, not
// allow-listed away: electron-builder also emits keys like stagingPercentage,
// minimumSystemVersion, releaseName and releaseNotes, and dropping them is
// not cosmetic — a lost stagingPercentage turns a staged 10% rollout into an
// instant 100%, and a lost minimumSystemVersion offers the update to macOS
// versions the build does not support.
//
// A key present on one side only is kept: an omission is not a disagreement
// between values. A key present on both sides with different values IS a
// real inconsistency — the two legs were configured differently — and there
// is no side that is safely "right" (stagingPercentage 10 vs 50 has no sane
// winner), so it throws, the same way a version mismatch does.
function mergeExtraKeys(
  arm64: Record<string, unknown>,
  x64: Record<string, unknown>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const keys = [...Object.keys(arm64), ...Object.keys(x64)].filter(
    (key, index, all) => !COMPUTED_KEYS.has(key) && all.indexOf(key) === index,
  );
  for (const key of keys) {
    const inArm64 = key in arm64;
    const inX64 = key in x64;
    if (inArm64 && inX64 && !deepEqual(arm64[key], x64[key])) {
      throw new Error(
        `"${key}" differs between the two inputs (arm64: ${JSON.stringify(arm64[key])}, ` +
          `x64: ${JSON.stringify(x64[key])}) — the two build legs were configured ` +
          'differently and neither side can be assumed correct, refusing to merge',
      );
    }
    extras[key] = inArm64 ? arm64[key] : x64[key];
  }
  return extras;
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

  // What must be true of the merged feed is not "one entry per arch" — each
  // per-arch file legitimately lists both a .zip and a .dmg. It is "exactly
  // one installable update per arch": electron-updater's MacUpdater calls
  // findFile(files, "zip", ["pkg", "dmg"]), so the .zip is the only entry a
  // client will ever install. The .dmg entries are valid metadata and ride
  // along untouched. Zero zips for an arch strands that architecture; two
  // zips for an arch makes the update the client picks ambiguous.
  const isZip = (f: UpdateFileEntry) => f.url.endsWith('.zip');
  const arm64Zips = files.filter((f) => isZip(f) && f.url.includes('arm64'));
  const x64Zips = files.filter((f) => isZip(f) && !f.url.includes('arm64') && f.url.includes('x64'));
  if (arm64Zips.length !== 1 || x64Zips.length !== 1) {
    throw new Error(
      `merged feed must contain exactly one installable zip per architecture, got ` +
        `${arm64Zips.length} arm64 zip(s) / ${x64Zips.length} x64 zip(s) ` +
        `(urls: ${files.map((f) => f.url).join(', ')}) — MacUpdater installs only the zip ` +
        '(findFile(files, "zip", ["pkg", "dmg"])), so a feed without exactly one per arch ' +
        'would silently strand or confuse one architecture, refusing to merge',
    );
  }

  // Older clients ignore `files` and read only the top-level path/sha512.
  // Point those at the x64 zip — matching what electron-builder itself writes
  // (its top-level path is the zip, never the dmg). x64 because an Intel
  // binary still runs on Apple Silicon under Rosetta; an arm64 binary does
  // not run on Intel at all. Selected by arch + extension, never by array
  // position: input ordering must not decide what legacy clients download.
  const [legacy] = x64Zips;
  if (!legacy) throw new Error('unreachable: x64 zip vanished after the count check');

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
    ...mergeExtraKeys(arm64, x64),
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
