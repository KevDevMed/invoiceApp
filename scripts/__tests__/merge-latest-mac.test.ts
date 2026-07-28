import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { mergeLatestMac } from '../merge-latest-mac';

const ARM64_SHA =
  'q9Zc9RkT1n0m3H1v8yWl4bqfE2p7cKxOaVYtDdUu6Rr5sQwLhGgFfEeDdCcBbAa998877665544332211ZzYyXxWw==';
const X64_SHA =
  'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6a7B8c9D0e1F2g3H4i5J6k7L8m9N0o1P2q3R==';

const arm64Yml = `version: 0.1.4
files:
  - url: InvoiceApp-mac-arm64.zip
    sha512: ${ARM64_SHA}
    size: 123456789
path: InvoiceApp-mac-arm64.zip
sha512: ${ARM64_SHA}
releaseDate: '2026-07-28T04:40:50.123Z'
`;

const x64Yml = `version: 0.1.4
files:
  - url: InvoiceApp-mac-x64.zip
    sha512: ${X64_SHA}
    size: 987654321
path: InvoiceApp-mac-x64.zip
sha512: ${X64_SHA}
releaseDate: '2026-07-28T05:02:11.456Z'
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
  it('merges both zips into one files list, arm64 first', () => {
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    expect(merged.files.map((f) => f.url)).toEqual([
      'InvoiceApp-mac-arm64.zip',
      'InvoiceApp-mac-x64.zip',
    ]);
    expect(merged.version).toBe('0.1.4');
  });

  it('throws on version mismatch, naming both versions', () => {
    const bumped = x64Yml.replace('version: 0.1.4', 'version: 0.1.5');
    expect(() => mergeLatestMac(arm64Yml, bumped)).toThrow(/0\.1\.4/);
    expect(() => mergeLatestMac(arm64Yml, bumped)).toThrow(/0\.1\.5/);
  });

  it('keeps sha512 and size byte-for-byte', () => {
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    const arm = merged.files.find((f) => f.url.includes('arm64'));
    const x = merged.files.find((f) => f.url.includes('x64'));
    expect(arm).toEqual({ url: 'InvoiceApp-mac-arm64.zip', sha512: ARM64_SHA, size: 123456789 });
    expect(x).toEqual({ url: 'InvoiceApp-mac-x64.zip', sha512: X64_SHA, size: 987654321 });
  });

  it('points the legacy top-level path/sha512 at the x64 zip', () => {
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    expect(merged.path).toBe('InvoiceApp-mac-x64.zip');
    expect(merged.sha512).toBe(X64_SHA);
  });

  it('uses the later releaseDate, whichever side it comes from', () => {
    expect(parse(mergeLatestMac(arm64Yml, x64Yml)).releaseDate).toBe('2026-07-28T05:02:11.456Z');
    const laterArm = arm64Yml.replace('2026-07-28T04:40:50.123Z', '2026-07-29T00:00:00.000Z');
    expect(parse(mergeLatestMac(laterArm, x64Yml)).releaseDate).toBe('2026-07-29T00:00:00.000Z');
  });

  it('deduplicates a url that appears in both inputs', () => {
    // Simulate a leg whose feed already lists both zips (e.g. a rebuilt leg).
    const x64WithBoth = `version: 0.1.4
files:
  - url: InvoiceApp-mac-arm64.zip
    sha512: ${ARM64_SHA}
    size: 123456789
  - url: InvoiceApp-mac-x64.zip
    sha512: ${X64_SHA}
    size: 987654321
path: InvoiceApp-mac-x64.zip
sha512: ${X64_SHA}
releaseDate: '2026-07-28T05:02:11.456Z'
`;
    const merged = parse(mergeLatestMac(arm64Yml, x64WithBoth));
    expect(merged.files).toHaveLength(2);
    expect(merged.files.map((f) => f.url)).toEqual([
      'InvoiceApp-mac-arm64.zip',
      'InvoiceApp-mac-x64.zip',
    ]);
  });

  it('throws when an input is missing its expected arch', () => {
    // Both inputs carry only the x64 zip: zero arm64 entries in the union.
    expect(() => mergeLatestMac(x64Yml, x64Yml)).toThrow(/exactly one arm64/);
    // Both carry only arm64: zero x64 entries.
    expect(() => mergeLatestMac(arm64Yml, arm64Yml)).toThrow(/exactly one/);
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
    // inputs carry them: path/sha512 still come from the x64 entry, not from
    // either input's own top-level values.
    const merged = parse(mergeLatestMac(arm64Yml, x64Yml));
    expect(merged.path).toBe('InvoiceApp-mac-x64.zip');
    expect(merged.sha512).toBe(X64_SHA);
    expect(merged.releaseDate).toBe('2026-07-28T05:02:11.456Z');
  });

  it('round-trips: the merged string re-parses to the same object', () => {
    const merged = mergeLatestMac(arm64Yml, x64Yml);
    const once = parse(merged);
    expect(parse(mergeLatestMac(arm64Yml, x64Yml))).toEqual(once);
    // And parsing the emitted YAML yields exactly the object that was dumped.
    expect(once).toEqual({
      version: '0.1.4',
      files: [
        { url: 'InvoiceApp-mac-arm64.zip', sha512: ARM64_SHA, size: 123456789 },
        { url: 'InvoiceApp-mac-x64.zip', sha512: X64_SHA, size: 987654321 },
      ],
      path: 'InvoiceApp-mac-x64.zip',
      sha512: X64_SHA,
      releaseDate: '2026-07-28T05:02:11.456Z',
    });
  });
});
