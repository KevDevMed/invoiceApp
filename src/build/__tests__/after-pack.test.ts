import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The hook is CommonJS because electron-builder `require()`s it from the YAML
// config at runtime, so it is loaded the same way here rather than imported.
const require = createRequire(import.meta.url);

// `vi.mock('node:child_process')` is deliberately NOT used: Vitest's mock
// registry only intercepts ESM specifiers it rewrites, and the hook reaches
// child_process through a CommonJS `require()` that resolves natively — the
// real `codesign` was still spawned when that was tried. Stubbing the method on
// the builtin's exports object works because Node caches builtins, so this is
// the exact object the hook destructures. It has to be installed BEFORE the
// hook is loaded, since the hook destructures `execFileSync` at module scope.
const childProcess = require('node:child_process') as { execFileSync: unknown };
const realExecFileSync = childProcess.execFileSync;
const execFileSync = vi.fn();
childProcess.execFileSync = execFileSync;

const hook = require('../../../build/after-pack.cjs') as {
  (context: {
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }): Promise<void>;
  resolveAdhocSign: (options: {
    platform: string;
    env: Record<string, string | undefined>;
    appOutDir: string;
    productFilename: string;
  }) => string[] | null;
};
const { resolveAdhocSign } = hook;

childProcess.execFileSync = realExecFileSync;

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
    // because under an ad-hoc signature hardened runtime earns no Gatekeeper
    // benefit while its library-validation and JIT restrictions can break
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

// The decision helper above is pure, so on its own it would stay green even if
// the exported hook were replaced with a no-op. These cover the part that
// actually does the work.
describe('afterPack hook', () => {
  const CONTEXT = {
    appOutDir: ARM64_OUT_DIR,
    packager: { appInfo: { productFilename: PRODUCT } },
  };
  const realPlatform = process.platform;
  const realEnv = process.env;

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  beforeEach(() => {
    // The hook destructured `execFileSync` at load time, so it holds this exact
    // vi.fn() for the rest of the run; only its recorded state needs resetting.
    execFileSync.mockReset();
    process.env = { ...realEnv, ...UNSIGNED_ENV };
    setPlatform('darwin');
  });

  afterEach(() => {
    process.env = realEnv;
    setPlatform(realPlatform);
  });

  it('runs codesign with exactly the resolved argv', async () => {
    await hook(CONTEXT);

    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      'codesign',
      ['--force', '--deep', '--sign', '-', path.join(ARM64_OUT_DIR, 'InvoiceApp.app')],
      { stdio: 'inherit' },
    );
  });

  it('does not shell out at all when the resolver declines', async () => {
    // Same three declining conditions the resolver tests cover, driven through
    // the real hook so a broken null check cannot slip past.
    setPlatform('linux');
    await hook(CONTEXT);

    setPlatform('darwin');
    process.env = { ...realEnv, MAC_ADHOC_SIGN: 'true', MAC_HAS_SIGNING_CERT: 'true' };
    await hook(CONTEXT);

    const unarmed = { ...realEnv, MAC_HAS_SIGNING_CERT: 'false' };
    delete unarmed.MAC_ADHOC_SIGN;
    process.env = unarmed;
    await hook(CONTEXT);

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('propagates a codesign failure instead of falling back to an unsigned bundle', async () => {
    // Load-bearing. Silently continuing past a failed signature is the exact
    // v0.1.0 bug: the build would go green and ship a bundle macOS reports as
    // damaged. The hook must let the throw reach electron-builder.
    execFileSync.mockImplementation(() => {
      throw new Error('codesign: bundle format unrecognized');
    });

    await expect(hook(CONTEXT)).rejects.toThrow('codesign: bundle format unrecognized');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
