// electron-builder `afterPack` hook: ad-hoc sign the packed .app when no real
// Developer ID certificate is available.
//
// Why this exists. Releases up to v0.1.0 shipped a bundle with zero
// `_CodeSignature` directories anywhere inside InvoiceApp.app — completely
// unsigned, not even ad-hoc. On Apple Silicon the kernel refuses to execute an
// arm64 Mach-O carrying no signature at all, so macOS reports
// `"InvoiceApp" is damaged and can't be opened` and `xattr -dr
// com.apple.quarantine` cannot rescue it. An ad-hoc signature does not remove
// the Gatekeeper prompt (it is not a trusted identity), but it makes the binary
// executable, which turns a dead-end "damaged" dialog into the ordinary
// unidentified-developer dialog that right-click > Open / quarantine removal can
// get past.
//
// CommonJS on purpose: electron-builder `require()`s this file at runtime from
// the YAML config, so it cannot be TypeScript or ESM.
//
// Ordering: platformPackager.doPack() calls afterPack (line 245) BEFORE
// doSignAfterPack (line 252) and before packageInDistributableFormat builds the
// dmg/zip targets. So signing here lands in both the .dmg and the .zip, and the
// real-certificate path still gets the last word when a cert is present.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Pure decision function: returns the argv to exec, or null to skip.
 *
 * Deliberately NOT passing `--options=runtime` (hardened runtime). Hardened
 * runtime is only meaningful in combination with notarisation, which needs an
 * Apple Developer ID we do not have. Under an ad-hoc signature it buys nothing
 * and actively risks breaking the two native components — better-sqlite3's
 * .node addon and node-llama-cpp's dlopen'd backend — because hardened runtime
 * refuses to load unsigned/foreign-signed libraries unless the matching
 * entitlements are granted. `hardenedRuntime: true` stays in
 * electron-builder.yml, where it governs the real-certificate path only.
 *
 * `--deep` is required here: the bundle contains nested helper apps and the
 * Electron Framework, and they must each carry a signature. Apple deprecates
 * `--deep` for distribution signing, which is fine — the real-cert path never
 * reaches this function.
 *
 * @param {{platform: string, env: Record<string, string | undefined>, appOutDir: string, productFilename: string}} options
 * @returns {string[] | null}
 */
function resolveAdhocSign({ platform, env, appOutDir, productFilename }) {
  // `codesign` does not exist off macOS; never shell out to it there.
  if (platform !== 'darwin') {
    return null;
  }
  // A real Developer ID cert is in play: electron-builder signs it properly a
  // few lines later. Stay out of the way entirely.
  if (env.MAC_HAS_SIGNING_CERT === 'true') {
    return null;
  }
  // Explicitly armed by the workflow. Not inferred — a local `package:mac` run
  // that forgot to set it gets the old behaviour rather than a surprise
  // signature.
  if (env.MAC_ADHOC_SIGN !== 'true') {
    return null;
  }

  return [
    'codesign',
    '--force',
    '--deep',
    '--sign',
    '-',
    path.join(appOutDir, `${productFilename}.app`),
  ];
}

/**
 * @param {{appOutDir: string, electronPlatformName: string, packager: {appInfo: {productFilename: string}}}} context
 */
async function afterPack(context) {
  const argv = resolveAdhocSign({
    platform: process.platform,
    env: process.env,
    appOutDir: context.appOutDir,
    productFilename: context.packager.appInfo.productFilename,
  });

  if (argv === null) {
    return;
  }

  const [command, ...args] = argv;
  console.log(`[after-pack] ad-hoc signing: ${argv.join(' ')}`);
  // No try/catch on purpose. A silent fallback to an unsigned bundle is the
  // exact bug this hook exists to fix, so a codesign failure must fail the
  // build. execFileSync throws on a non-zero exit; stderr goes to the log.
  execFileSync(command, args, { stdio: 'inherit' });
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.resolveAdhocSign = resolveAdhocSign;
