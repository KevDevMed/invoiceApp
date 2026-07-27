/**
 * Opt-in end-to-end checks against the real network and a real model file.
 *
 * Skipped unless `INVOICEAPP_LIVE=1`, so `npm run test:run` never downloads
 * anything or loads a native backend. Run it by hand when you want proof that
 * the range reader, the Hub lookup, hardware detection and the smoke test work
 * against the real thing:
 *
 *   INVOICEAPP_LIVE=1 npx vitest run src/main/llm/__tests__/live.smoke.test.ts
 *   INVOICEAPP_LIVE=1 INVOICEAPP_SMOKE_GGUF=/path/to/model.gguf \
 *     npx vitest run src/main/llm/__tests__/live.smoke.test.ts
 */

import { describe, expect, it } from 'vitest';

import { downloadUrl } from '../catalog';
import { checkModelSupport } from '../compatibility';
import { headFileSize, readRemoteGgufHeader } from '../gguf';
import { describeHardware, detectHardware, toCompatibilityHardware } from '../hardware';
import { lookupRepo } from '../hf';
import { NodeLlamaCppRuntime } from '../runtime';
import { runSmokeTest } from '../smoke-test';

const LIVE = process.env.INVOICEAPP_LIVE === '1';
const LOCAL_GGUF = process.env.INVOICEAPP_SMOKE_GGUF;

const REPO = 'Qwen/Qwen3-0.6B-GGUF';
const FILENAME = 'Qwen3-0.6B-Q8_0.gguf';

describe.skipIf(!LIVE)('live network and hardware', () => {
  it('lists the real repo from the Hub', async () => {
    const info = await lookupRepo(REPO);
    console.log(
      `[live] ${info.repo} — ${info.variants.length} variants: ${info.variants
        .map((variant) => `${variant.quant ?? '?'} ${variant.sizeBytes ?? '?'}B`)
        .join(', ')}`,
    );
    expect(info.variants.length).toBeGreaterThan(0);
  }, 60_000);

  it('reads the real GGUF header over Range requests and computes a verdict', async () => {
    const url = downloadUrl(REPO, FILENAME);
    const [size, header] = await Promise.all([headFileSize(url), readRemoteGgufHeader(url)]);

    console.log(`[live] content-length=${size ?? 'null'} architecture=${header.architecture}`);
    expect(header.architecture).not.toBeNull();

    const profile = await detectHardware();
    console.log(`[live] hardware: ${describeHardware(profile)}`);

    const report = checkModelSupport({
      meta: header.metadata,
      modelSizeBytes: size ?? 0,
      hardware: toCompatibilityHardware(profile),
    });
    console.log(
      `[live] verdict=${report.verdict} weights=${report.modelSizeBytes} kv=${report.kvCacheBytes} required=${report.totalRequiredBytes} usableVram=${report.usableVramBytes} usableTotal=${report.usableTotalMemoryBytes}`,
    );
    console.log(`[live] reason: ${report.reason}`);
    expect(['RED', 'YELLOW', 'GREEN', 'GREY']).toContain(report.verdict);
  }, 180_000);

  it.skipIf(!LOCAL_GGUF)('runs the real smoke test against a downloaded model', async () => {
    const result = await runSmokeTest({
      runtime: new NodeLlamaCppRuntime(),
      modelId: 'live-model',
      modelPath: LOCAL_GGUF ?? '',
    });

    console.log(`[live] smoke test: ${JSON.stringify(result, null, 2)}`);
    expect(result.verdict).not.toBe('fail');
  }, 600_000);
});
