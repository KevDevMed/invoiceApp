import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The hook is CommonJS because electron-builder `require()`s it from the YAML
// config at runtime, so it is loaded the same way here rather than imported.
const require = createRequire(import.meta.url);
const { resolveAdhocSign } = require('../../../build/after-pack.cjs') as {
  resolveAdhocSign: (options: {
    platform: string;
    env: Record<string, string | undefined>;
    appOutDir: string;
    productFilename: string;
  }) => string[] | null;
};

const ARM64_OUT_DIR = 'release/mac-arm64';
const PRODUCT = 'InvoiceApp';

// Set by the workflow whenever no MAC_CERT_P12 secret exists.
const UNSIGNED_ENV = { MAC_ADHOC_SIGN: 'true', MAC_HAS_SIGNING_CERT: 'false' };

describe('resolveAdhocSign', () => {
  it('skips on non-darwin hosts so it never shells out to a missing codesign', () => {
    expect(
      resolveAdhocSign({
        platform: 'linux',
        env: UNSIGNED_ENV,
        appOutDir: ARM64_OUT_DIR,
        productFilename: PRODUCT,
      }),
    ).toBeNull();
  });

  it('skips when a real Developer ID certificate is in play', () => {
    expect(
      resolveAdhocSign({
        platform: 'darwin',
        env: { MAC_ADHOC_SIGN: 'true', MAC_HAS_SIGNING_CERT: 'true' },
        appOutDir: ARM64_OUT_DIR,
        productFilename: PRODUCT,
      }),
    ).toBeNull();
  });

  it('skips when the hook was not explicitly armed', () => {
    expect(
      resolveAdhocSign({
        platform: 'darwin',
        env: {},
        appOutDir: ARM64_OUT_DIR,
        productFilename: PRODUCT,
      }),
    ).toBeNull();
  });

  it('returns the ad-hoc codesign argv on darwin in unsigned mode', () => {
    // This is the regression guard: v0.1.0 shipped a bundle with zero
    // _CodeSignature directories, which macOS reports as "damaged". `--sign -`
    // is the ad-hoc identity; `--options=runtime` is deliberately absent
    // because hardened runtime without notarisation only risks breaking
    // better-sqlite3 and node-llama-cpp.
    expect(
      resolveAdhocSign({
        platform: 'darwin',
        env: UNSIGNED_ENV,
        appOutDir: ARM64_OUT_DIR,
        productFilename: PRODUCT,
      }),
    ).toEqual([
      'codesign',
      '--force',
      '--deep',
      '--sign',
      '-',
      path.join(ARM64_OUT_DIR, 'InvoiceApp.app'),
    ]);
  });

  it('targets the .app inside the arch-specific output dir electron-builder uses', () => {
    // getArchSuffix() drops the suffix for the default arch (x64) and appends
    // it otherwise, so x64 packs into release/mac and arm64 into
    // release/mac-arm64.
    for (const appOutDir of ['release/mac', 'release/mac-arm64']) {
      const argv = resolveAdhocSign({
        platform: 'darwin',
        env: UNSIGNED_ENV,
        appOutDir,
        productFilename: PRODUCT,
      });
      expect(argv?.at(-1)).toBe(path.join(appOutDir, 'InvoiceApp.app'));
    }
  });
});
