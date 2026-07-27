/**
 * What this machine actually is.
 *
 * The compatibility verdict is only as trustworthy as these numbers, so the one
 * rule here is: never invent a figure. RAM and CPU come from `node:os` and are
 * always available. VRAM is tried in order —
 *
 *   1. `node-llama-cpp`'s llama instance: `llama.getVramState()` returns
 *      `{total, used, free, unifiedSize}` and `llama.getGpuDeviceNames()` returns
 *      the device names, with `llama.gpu` reporting the active backend
 *      (`"metal" | "cuda" | "vulkan" | false`). Verified against
 *      `node_modules/node-llama-cpp/dist/bindings/Llama.d.ts` in 3.19.1.
 *   2. Electron's `app.getGPUInfo('complete')`, which names devices but does not
 *      report VRAM on most platforms.
 *   3. Nothing — `vramSource: 'unknown'`, VRAM stays null, and the verdict for
 *      any model becomes GREY rather than a guess.
 *
 * A device whose VRAM is unknown is listed for display but excluded from the
 * memory arithmetic, because "0 bytes of VRAM" and "unknown VRAM" are different
 * facts and only one of them is true.
 */

import os from 'node:os';

import type { CompatibilityHardware } from './compatibility';

export type VramSource = 'node-llama-cpp' | 'electron' | 'unknown';

export interface GpuDevice {
  readonly name: string;
  /** Null when the platform will not report it. Never zero as a stand-in. */
  readonly totalMemoryBytes: number | null;
}

export interface HardwareProfile {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Apple Silicon: the GPU shares system RAM, so RAM must not be counted twice. */
  readonly isAppleSilicon: boolean;
  /** True on any machine whose GPU memory is the system memory. */
  readonly hasUnifiedMemory: boolean;
  readonly cpuModel: string | null;
  readonly cpuCores: number | null;
  readonly totalRamBytes: number | null;
  readonly freeRamBytes: number | null;
  readonly gpus: readonly GpuDevice[];
  /** Sum of VRAM across devices that reported it, or null when none did. */
  readonly totalVramBytes: number | null;
  readonly vramSource: VramSource;
  /** llama.cpp backend in use: `metal`, `cuda`, `vulkan`, or null for CPU-only. */
  readonly gpuBackend: string | null;
  /** Why detection fell back, when it did. Shown in the UI verbatim. */
  readonly detectionError: string | null;
}

/** The slice of `node-llama-cpp`'s `Llama` we use. Structural, so tests can fake it. */
export interface LlamaHardwareProbe {
  readonly gpu: string | false;
  getVramState(): Promise<{ total: number; used: number; free: number; unifiedSize: number }>;
  getGpuDeviceNames(): Promise<string[]>;
}

export interface ElectronGpuInfo {
  gpuDevice?: Array<{
    deviceString?: unknown;
    deviceId?: unknown;
    vendorId?: unknown;
    driverVendor?: unknown;
  }>;
}

export interface HardwareDeps {
  readonly totalmem?: () => number;
  readonly freemem?: () => number;
  readonly cpus?: () => Array<{ model: string }>;
  readonly platform?: () => NodeJS.Platform;
  readonly arch?: () => string;
  /** Resolves the llama probe, or throws/returns null when the backend is unusable. */
  readonly llamaProbe?: () => Promise<LlamaHardwareProbe | null>;
  /** Electron's `app.getGPUInfo('complete')`. */
  readonly electronGpuInfo?: () => Promise<ElectronGpuInfo | null>;
}

const defaultLlamaProbe = async (): Promise<LlamaHardwareProbe | null> => {
  const module = (await import('node-llama-cpp')) as unknown as {
    getLlama?: (options?: Record<string, unknown>) => Promise<LlamaHardwareProbe>;
  };
  if (typeof module.getLlama !== 'function') return null;
  return module.getLlama();
};

const defaultElectronGpuInfo = async (): Promise<ElectronGpuInfo | null> => {
  const electron = (await import('electron')) as unknown as {
    app?: { getGPUInfo?: (type: string) => Promise<unknown> };
  };
  if (typeof electron.app?.getGPUInfo !== 'function') return null;
  return (await electron.app.getGPUInfo('complete')) as ElectronGpuInfo;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Probe the machine. Never throws: a failure downgrades a field to null and is
 * reported in `detectionError`.
 */
export async function detectHardware(deps: HardwareDeps = {}): Promise<HardwareProfile> {
  const platform = (deps.platform ?? os.platform)();
  const arch = (deps.arch ?? os.arch)();
  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';

  let totalRamBytes: number | null = null;
  let freeRamBytes: number | null = null;
  let cpuModel: string | null = null;
  let cpuCores: number | null = null;
  const problems: string[] = [];

  try {
    const total = (deps.totalmem ?? os.totalmem)();
    totalRamBytes = Number.isFinite(total) && total > 0 ? total : null;
  } catch (error) {
    problems.push(`total RAM: ${errorMessage(error)}`);
  }

  try {
    const free = (deps.freemem ?? os.freemem)();
    freeRamBytes = Number.isFinite(free) && free >= 0 ? free : null;
  } catch (error) {
    problems.push(`free RAM: ${errorMessage(error)}`);
  }

  try {
    const cpus = (deps.cpus ?? os.cpus)();
    cpuCores = cpus.length > 0 ? cpus.length : null;
    cpuModel = cpus[0]?.model?.trim() ?? null;
  } catch (error) {
    problems.push(`CPU: ${errorMessage(error)}`);
  }

  let gpus: GpuDevice[] = [];
  let vramSource: VramSource = 'unknown';
  let gpuBackend: string | null = null;
  let hasUnifiedMemory = isAppleSilicon;

  try {
    const probe = await (deps.llamaProbe ?? defaultLlamaProbe)();
    if (probe) {
      gpuBackend = probe.gpu === false ? null : probe.gpu;
      const [vram, names] = await Promise.all([probe.getVramState(), probe.getGpuDeviceNames()]);

      // `unifiedSize > 0` is node-llama-cpp's own documented unified-memory
      // signal — see the note on `setRamCap` in Llama.d.ts.
      if (vram.unifiedSize > 0) hasUnifiedMemory = true;

      if (gpuBackend !== null && vram.total > 0) {
        vramSource = 'node-llama-cpp';
        if (names.length > 0) {
          // The addon reports one pooled VRAM figure, not per-device. Splitting it
          // evenly would be a fabrication, so the whole pool is attributed to the
          // first device and the rest are listed with unknown VRAM.
          gpus = names.map((name, index) => ({
            name,
            totalMemoryBytes: index === 0 ? vram.total : null,
          }));
        } else {
          gpus = [{ name: `${gpuBackend} device`, totalMemoryBytes: vram.total }];
        }
      } else if (gpuBackend === null) {
        // A working addon that reports no GPU is a real answer, not a failure.
        vramSource = 'node-llama-cpp';
        gpus = [];
      }
    }
  } catch (error) {
    problems.push(`GPU via node-llama-cpp: ${errorMessage(error)}`);
  }

  if (vramSource === 'unknown') {
    try {
      const info = await (deps.electronGpuInfo ?? defaultElectronGpuInfo)();
      const devices = info?.gpuDevice ?? [];
      const named = devices
        .map((device) =>
          typeof device.deviceString === 'string' && device.deviceString.trim().length > 0
            ? device.deviceString.trim()
            : null,
        )
        .filter((name): name is string => name !== null);
      if (named.length > 0) {
        // Electron does not report VRAM, so these devices exist for display only.
        vramSource = 'electron';
        gpus = named.map((name) => ({ name, totalMemoryBytes: null }));
        problems.push(
          'GPU VRAM is unknown: Electron reports device names but not memory size.',
        );
      }
    } catch (error) {
      problems.push(`GPU via Electron: ${errorMessage(error)}`);
    }
  }

  const known = gpus.filter((gpu) => gpu.totalMemoryBytes !== null);
  const totalVramBytes =
    known.length > 0 ? known.reduce((sum, gpu) => sum + (gpu.totalMemoryBytes ?? 0), 0) : null;

  return {
    platform,
    arch,
    isAppleSilicon,
    hasUnifiedMemory,
    cpuModel,
    cpuCores,
    totalRamBytes,
    freeRamBytes,
    gpus,
    totalVramBytes,
    vramSource,
    gpuBackend,
    detectionError: problems.length > 0 ? problems.join('; ') : null,
  };
}

/**
 * Fold a detected profile into the shape the verdict formula wants.
 *
 * Two rules, both load-bearing:
 *   - A unified-memory machine reports **no** discrete GPU, so its RAM is
 *     counted once, as VRAM. That is exactly what Atomic-Chat's formula assumes.
 *   - A GPU whose VRAM we could not read is dropped from the arithmetic. It
 *     still shows in the UI; it just cannot contribute a number nobody knows.
 */
export function toCompatibilityHardware(profile: HardwareProfile): CompatibilityHardware {
  if (profile.hasUnifiedMemory) {
    return { totalRamBytes: profile.totalRamBytes, gpus: [] };
  }

  const gpus = profile.gpus
    .filter((gpu) => gpu.totalMemoryBytes !== null && gpu.totalMemoryBytes > 0)
    .map((gpu) => ({ name: gpu.name, totalMemoryBytes: gpu.totalMemoryBytes as number }));

  return { totalRamBytes: profile.totalRamBytes, gpus };
}

/** One-line summary for the system panel. */
export function describeHardware(profile: HardwareProfile): string {
  const parts: string[] = [];
  parts.push(`${profile.platform}/${profile.arch}`);
  if (profile.cpuModel) parts.push(`${profile.cpuModel}${profile.cpuCores ? ` × ${profile.cpuCores}` : ''}`);
  parts.push(profile.totalRamBytes === null ? 'RAM unknown' : `${gib(profile.totalRamBytes)} RAM`);
  if (profile.hasUnifiedMemory) {
    parts.push('unified memory');
  } else if (profile.totalVramBytes !== null) {
    parts.push(`${gib(profile.totalVramBytes)} VRAM`);
  } else if (profile.gpus.length > 0) {
    parts.push('VRAM unknown');
  } else {
    parts.push('no GPU');
  }
  return parts.join(' · ');
}

function gib(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
}
