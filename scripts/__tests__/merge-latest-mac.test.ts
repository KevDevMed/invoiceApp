import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { mergeLatestMac } from '../merge-latest-mac';

// Fixtures are the real electron-builder 25.1.8 output from the v0.1.4
// release run (run 30386521034), not hand-shaped approximations. Each
// per-arch file lists TWO entries — the .zip and the .dmg — and the
// top-level path/sha512 point at the zip. The previous fixtures encoded a
// one-entry-per-file assumption that the real files broke, so the tests
// passed while the actual release failed.
const ARM64_ZIP_SHA =
  'EibyCyRFuxDfyO92Ro7MoAAwSdLJWK6te37EcSCv6oo0zeumthqmE0Wr4Hf8tL8RZtHi4AoTQJbHJizCmHqhYw==';
const ARM64_DMG_SHA =
  'U8hp2ImbqPINzSW0gUNIolR3paGEjw/gQm3zWVPuiBIBXGpB7Mlse2OLkSNuj9iCezDACKSJb2yPQekyTRwN4g==';
const X64_ZIP_SHA =
  'tynMxd4nOz7fD32kjy4sYQ6YebUHq5PR3/dC9A7sHy6VkO5oDLwIgn+WkOZ0fSDsSNlSBDnO0gBUPKMJwzCwWw==';
const X64_DMG_SHA =
  'i+A2jPZDxcu05kPjV9oyn/CRl3qYH3CMZOGt/kfmPvPZ2voEWez98KAbJGCutWAq+GB9DtQv9tRKE2OuDj85cg==';

const arm64Yml = `version: 0.1.4
files:
  - url: InvoiceApp-mac-arm64.zip
    sha512: ${ARM64_ZIP_SHA}
    size: 155731318
  - url: InvoiceApp-mac-arm64.dmg
    sha512: ${ARM64_DMG_SHA}
    size: 160657309
path: InvoiceApp-mac-arm64.zip
sha512: ${ARM64_ZIP_SHA}
releaseDate: '2026-07-28T18:22:16.287Z'
`;

const x64Yml = `version: 0.1.4
files:
  - url: InvoiceApp-mac-x64.zip
    sha512: ${X64_ZIP_SHA}
    size: 172827836
  - url: InvoiceApp-mac-x64.dmg
    sha512: ${X64_DMG_SHA}
    size: 178165196
path: InvoiceApp-mac-x64.zip
sha512: ${X64_ZIP_SHA}
releaseDate: '2026-07-28T18:24:43.353Z'
`;

interface Parsed {
  version: string;
  files: Array<{ url: string; sha512: string; size: number }>;
  path: string;
  sha512: string;
  releaseDate: string;
  [key: string]: unknown;
}

function parse(yml: string): Parsed {
  return load(yml) as Parsed;
}

describe('mergeLatestMac', () => {
  it('merges the real two-entry inputs: all four entries survive, arm64 first', () => {
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    expect(merged.files.map((f) => f.url)).toEqual([
      'InvoiceApp-mac-arm64.zip',
      'InvoiceApp-mac-arm64.dmg',
      'InvoiceApp-mac-x64.zip',
      'InvoiceApp-mac-x64.dmg',
    ]);
    expect(merged.version).toBe('0.1.4');
  });

  it('throws on version mismatch, naming both versions', () => {
    const bumped = x64Yml.replace('version: 0.1.4', 'version: 0.1.5');
    expect(() => mergeLatestMac(arm64Yml, bumped)).toThrow(/0\.1\.4/);
    expect(() => mergeLatestMac(arm64Yml, bumped)).toThrow(/0\.1\.5/);
  });

  it('keeps every sha512 and size byte-for-byte, dmg entries included', () => {
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    expect(merged.files).toEqual([
      { url: 'InvoiceApp-mac-arm64.zip', sha512: ARM64_ZIP_SHA, size: 155731318 },
      { url: 'InvoiceApp-mac-arm64.dmg', sha512: ARM64_DMG_SHA, size: 160657309 },
      { url: 'InvoiceApp-mac-x64.zip', sha512: X64_ZIP_SHA, size: 172827836 },
      { url: 'InvoiceApp-mac-x64.dmg', sha512: X64_DMG_SHA, size: 178165196 },
    ]);
  });

  it('points the legacy top-level path/sha512 at the x64 zip, byte-for-byte', () => {
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    expect(merged.path).toBe('InvoiceApp-mac-x64.zip');
    expect(merged.sha512).toBe(X64_ZIP_SHA);
  });

  it('selects the x64 zip for the legacy path even when the dmg is listed first', () => {
    // Reverse the entry order inside the x64 input: dmg before zip. Which
    // entry becomes the legacy path must not depend on array position.
    const x64Reversed = `version: 0.1.4
files:
  - url: InvoiceApp-mac-x64.dmg
    sha512: ${X64_DMG_SHA}
    size: 178165196
  - url: InvoiceApp-mac-x64.zip
    sha512: ${X64_ZIP_SHA}
    size: 172827836
path: InvoiceApp-mac-x64.zip
sha512: ${X64_ZIP_SHA}
releaseDate: '2026-07-28T18:24:43.353Z'
`;
    const merged = parse(mergeLatestMac(arm64Yml, x64Reversed));
    expect(merged.path).toBe('InvoiceApp-mac-x64.zip');
    expect(merged.sha512).toBe(X64_ZIP_SHA);
  });

  it('throws when an input carries only a dmg and no zip', () => {
    const x64DmgOnly = `version: 0.1.4
files:
  - url: InvoiceApp-mac-x64.dmg
    sha512: ${X64_DMG_SHA}
    size: 178165196
path: InvoiceApp-mac-x64.dmg
sha512: ${X64_DMG_SHA}
releaseDate: '2026-07-28T18:24:43.353Z'
`;
    expect(() => mergeLatestMac(arm64Yml, x64DmgOnly)).toThrow(/exactly one installable zip/);
  });

  it('throws when an arch ends up with two zips', () => {
    const x64TwoZips = x64Yml.replace(
      'url: InvoiceApp-mac-x64.dmg',
      'url: InvoiceApp-mac-x64-full.zip',
    );
    expect(() => mergeLatestMac(arm64Yml, x64TwoZips)).toThrow(/exactly one installable zip/);
  });

  it('throws when an input is missing its expected arch entirely', () => {
    // Both inputs carry only x64 artifacts: zero arm64 zips in the union.
    expect(() => mergeLatestMac(x64Yml, x64Yml)).toThrow(/exactly one installable zip/);
    // Both carry only arm64: zero x64 zips.
    expect(() => mergeLatestMac(arm64Yml, arm64Yml)).toThrow(/exactly one installable zip/);
  });

  it('uses the later releaseDate, whichever side it comes from', () => {
    expect(parse(mergeLatestMac(arm64Yml, x64Yml)).releaseDate).toBe('2026-07-28T18:24:43.353Z');
    const laterArm = arm64Yml.replace('2026-07-28T18:22:16.287Z', '2026-07-29T00:00:00.000Z');
    expect(parse(mergeLatestMac(laterArm, x64Yml)).releaseDate).toBe('2026-07-29T00:00:00.000Z');
  });

  it('deduplicates a url that appears in both inputs', () => {
    // Simulate a leg whose feed already lists the other arch's zip too
    // (e.g. a rebuilt leg).
    const x64WithArm = x64Yml.replace(
      'files:',
      `files:
  - url: InvoiceApp-mac-arm64.zip
    sha512: ${ARM64_ZIP_SHA}
    size: 155731318`,
    );
    const merged = parse(mergeLatestMac(arm64Yml, x64WithArm));
    expect(merged.files).toHaveLength(4);
    expect(merged.files.map((f) => f.url)).toEqual([
      'InvoiceApp-mac-arm64.zip',
      'InvoiceApp-mac-arm64.dmg',
      'InvoiceApp-mac-x64.zip',
      'InvoiceApp-mac-x64.dmg',
    ]);
  });

  it('preserves extra top-level keys that both inputs agree on', () => {
    const extras = 'stagingPercentage: 10\nminimumSystemVersion: 23.1.0\n';
    const merged = parse(mergeLatestMac(arm64Yml + extras, x64Yml + extras));
    expect(merged.stagingPercentage).toBe(10);
    expect(merged.minimumSystemVersion).toBe('23.1.0');
  });

  it('preserves an extra key present on only one side', () => {
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml + "releaseNotes: 'Fixes PDF export'\n"));
    expect(merged.releaseNotes).toBe('Fixes PDF export');
  });

  it('preserves an extra key with a structured value', () => {
    const extras = 'releaseNotes:\n  - version: 0.1.4\n    note: Fixes PDF export\n';
    const merged = parse(mergeLatestMac(arm64Yml + extras, x64Yml + extras));
    expect(merged.releaseNotes).toEqual([{ version: '0.1.4', note: 'Fixes PDF export' }]);
  });

  it('throws when the two inputs disagree on an extra key, naming it', () => {
    const arm = arm64Yml + 'stagingPercentage: 10\n';
    const x = x64Yml + 'stagingPercentage: 50\n';
    expect(() => mergeLatestMac(arm, x)).toThrow(/stagingPercentage/);
    expect(() => mergeLatestMac(arm, x)).toThrow(/10/);
    expect(() => mergeLatestMac(arm, x)).toThrow(/50/);
  });

  it('never lets an extra key override the computed fields', () => {
    // The five computed keys keep their merge semantics even though both
    // inputs carry them: path/sha512 still come from the x64 zip entry, not
    // from either input's own top-level values.
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    expect(merged.path).toBe('InvoiceApp-mac-x64.zip');
    expect(merged.sha512).toBe(X64_ZIP_SHA);
    expect(merged.releaseDate).toBe('2026-07-28T18:24:43.353Z');
  });

  it('round-trips: the merged string re-parses to the same object', () => {
    const merged = mergeLatestMac(arm64Yml, x64Yml);
    const once = parse(merged);
    expect(parse(mergeLatestMac(arm64Yml, x64Yml))).toEqual(once);
    // And parsing the emitted YAML yields exactly the object that was dumped.
    expect(once).toEqual({
      version: '0.1.4',
      files: [
        { url: 'InvoiceApp-mac-arm64.zip', sha512: ARM64_ZIP_SHA, size: 155731318 },
        { url: 'InvoiceApp-mac-arm64.dmg', sha512: ARM64_DMG_SHA, size: 160657309 },
        { url: 'InvoiceApp-mac-x64.zip', sha512: X64_ZIP_SHA, size: 172827836 },
        { url: 'InvoiceApp-mac-x64.dmg', sha512: X64_DMG_SHA, size: 178165196 },
      ],
      path: 'InvoiceApp-mac-x64.zip',
      sha512: X64_ZIP_SHA,
      releaseDate: '2026-07-28T18:24:43.353Z',
    });
  });
});
