/**
 * The words and numbers the Models page says out loud.
 *
 * Design 1a puts the decision first and the jargon underneath it: a heading or a
 * primary sentence never contains `GGUF`, a quant string or a context number,
 * and everything technical lives in a badge, a tooltip or the diagnostics
 * footnote. Keeping that promise means the sentences are data, not JSX, so they
 * live here where `environment: 'node'` can test them.
 *
 * Two unit conventions, deliberately different:
 *   - **download sizes are decimal GB** — it is what the Hub reports and what a
 *     progress bar counts, so `4.37 GB` matches the bytes that move;
 *   - **memory figures are binary GiB, rounded to a whole number and prefixed
 *     with "about"** — the verdict arithmetic is in GiB, macOS calls 18 GiB
 *     "18 GB", and a second decimal place on an estimate is a false promise.
 */

import type {
  SupportBreakdownView,
  SupportVerdict,
  SystemInfoView,
  VariantSupportView,
} from './llmExtra';
import { formatBytes, formatGiB } from './useModels';

/** Which runtime a build targets. Decides the badge and breaks recommendation ties. */
export type ModelFormat = 'MLX' | 'GGUF';

const BYTES_PER_GIB = 1_073_741_824;

/**
 * MLX is Apple's array framework: those builds run on the Mac's GPU directly and
 * are meaningfully faster than the same weights as GGUF. Nothing in the curated
 * catalog is MLX today, so this is detected from the names a Hub result carries.
 */
export function modelFormat(repo: string, filename: string): ModelFormat {
  return /(^|[^a-z])mlx([^a-z]|$)/i.test(`${repo} ${filename}`) ? 'MLX' : 'GGUF';
}

/**
 * A human name for a build, from the repo rather than the filename.
 *
 * `Qwen/Qwen2.5-1.5B-Instruct-GGUF` reads as `Qwen2.5 1.5B Instruct`; the
 * filename would give `qwen2.5 1.5b instruct q4 k m`, which is both lowercase
 * and full of the quant string the design keeps out of names.
 */
export function modelDisplayName(repo: string, filename: string): string {
  const tail = repo.includes('/') ? repo.slice(repo.lastIndexOf('/') + 1) : repo;
  const named = tail.length > 0 ? tail : filename.replace(/\.gguf$/i, '');
  return named
    .replace(/[-_](gguf|mlx)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The mono format badge: `MLX`, or `GGUF · Q4_K_M` when the quant is known. */
export function formatBadgeLabel(format: ModelFormat, quant: string | null): string {
  if (format === 'MLX') return quant ? `MLX · ${quant}` : 'MLX';
  return quant ? `GGUF · ${quant}` : 'GGUF';
}

/** The letter in the 26px family tile. */
export function familyInitial(displayName: string): string {
  const first = displayName.trim().charAt(0);
  return first.length === 0 ? '?' : first.toUpperCase();
}

/**
 * Pull the human half out of a catalog `description`.
 *
 * Main packs licence, context and size in front of the "good for" note because
 * the frozen contract has one string field for all four — see `describeEntry`.
 * 1a shows the note and demotes the rest to badges and the footnote.
 */
export function catalogGoodFor(description: string | null): string | null {
  if (description === null) return null;
  const parts = description.split('·').map((part) => part.trim());
  const note = (parts.length > 1 ? parts[parts.length - 1] : parts[0]) ?? '';
  return note.length > 0 ? note : null;
}

/**
 * The other half of `catalogGoodFor`: the licence, context and size main packed
 * in front of the note.
 *
 * 1a demotes this below the decision — it does not throw it away. `Apache-2.0 ·
 * 32K context · 5.03 GB` is the only place the licence of a curated build is
 * stated anywhere in the app, and a page that silently dropped it would be
 * telling someone to download weights without saying what they may do with them.
 */
export function catalogMetadata(description: string | null): string | null {
  if (description === null) return null;
  const parts = description
    .split('·')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join(' · ');
}

/** A memory figure as a whole number of GiB, or null when nothing was measured. */
export function approxGigabytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  return `about ${Math.max(1, Math.round(bytes / BYTES_PER_GIB))} GB`;
}

/** `Mac` reads better than `machine` when we know it is one. */
export function machineWord(platform: string | null | undefined): string {
  return platform === 'darwin' ? 'Mac' : 'machine';
}

/**
 * The machine chip's summary: `M3 Pro · 18 GB`.
 *
 * `Apple ` is dropped because the chip sits next to a page that has already said
 * everything runs locally; the model number is the identifying part.
 */
export function machineChipSummary(system: SystemInfoView | null): string {
  if (system === null) return 'Machine not detected';
  const chip = system.cpuModel?.replace(/^Apple\s+/i, '').trim();
  const ram =
    system.totalRamBytes === null
      ? null
      : `${Math.round(system.totalRamBytes / BYTES_PER_GIB)} GB`;
  const parts = [chip, ram].filter((part): part is string => Boolean(part && part.length > 0));
  return parts.length > 0 ? parts.join(' · ') : 'Machine not detected';
}

/** The fit line under a browse row, in the register the design asks for. */
export function fitSentence(
  verdict: SupportVerdict,
  platform: string | null,
  note?: string | null,
): string {
  const machine = machineWord(platform);
  const head =
    verdict === 'GREEN'
      ? 'Runs comfortably'
      : verdict === 'YELLOW'
        ? 'Tight — other apps may slow down'
        : verdict === 'RED'
          ? `Needs more memory than this ${machine} has`
          : verdict === 'LOADING'
            ? 'Working out what this needs…'
            : 'Not checked yet';
  const trimmed = note?.trim();
  return trimmed ? `${head} · ${trimmed}` : head;
}

export interface FitTooltip {
  /** The bold lead-in, e.g. `Why this one:`. */
  readonly title: string;
  readonly body: string;
}

/**
 * The tooltip behind the `help` glyph — the real payload of design 1a.
 *
 * It says *why* in plain language, with the numbers the verdict was actually
 * computed from. Without a breakdown (nothing has read the header yet) it says
 * so rather than inventing figures.
 */
export function fitTooltip(
  verdict: SupportVerdict,
  breakdown: SupportBreakdownView | null,
  format: ModelFormat,
  platform: string | null,
): FitTooltip {
  const machine = machineWord(platform);
  const needs = approxGigabytes(breakdown?.totalRequiredBytes ?? null);
  const usable = approxGigabytes(breakdown?.usableTotalMemoryBytes ?? null);
  const spare =
    breakdown === null
      ? null
      : approxGigabytes(breakdown.usableTotalMemoryBytes - breakdown.totalRequiredBytes);
  const gpuNote =
    format === 'MLX'
      ? `It is an MLX build, so it uses this ${machine}'s GPU directly — noticeably faster than the same weights as GGUF. `
      : '';

  switch (verdict) {
    case 'GREEN':
      return {
        title: 'Why this one:',
        body:
          needs === null
            ? `${gpuNote}It fits in this ${machine}'s memory with room left for everything else.`
            : `${gpuNote}It needs ${needs} while running${spare === null ? '' : `, leaving ${spare.replace('about ', '')} for everything else`}.`,
      };
    case 'YELLOW':
      return {
        title: 'Why the warning:',
        body:
          needs === null || usable === null
            ? `It fits, but only just. Another memory-hungry app running alongside it will start swapping.`
            : `This build needs ${needs} of the ${usable.replace('about ', '')} this ${machine} has usable. It runs, but a big browser session alongside it will start swapping.`,
      };
    case 'RED':
      return {
        title: 'Why it will not fit:',
        body:
          needs === null || usable === null
            ? `It needs more memory than this ${machine} has usable. Expect it to fail to load, or to run too slowly to use.`
            : `It needs ${needs}, more than the ${usable.replace('about ', '')} this ${machine} has usable. Expect it to fail to load, or to run too slowly to use.`,
      };
    case 'LOADING':
      return {
        title: 'Checking:',
        body: 'Reading the first few megabytes of the model to work out how much memory it wants.',
      };
    case 'GREY':
      return {
        title: 'Not checked yet:',
        body: `Nothing has read this model's header, so how much memory it needs on this ${machine} is unknown.`,
      };
  }
}

export interface SupportFact {
  readonly label: string;
  readonly value: string;
}

/**
 * The real arithmetic behind one verdict, restored.
 *
 * The plain-English sentence and the tooltip stay the default surface; this is
 * what a reader who does not believe them can open. Every figure is main's own —
 * nothing here is rounded to "about", because the point of the disclosure is the
 * numbers the estimate was actually made from.
 */
export function supportFacts(support: VariantSupportView | null): SupportFact[] {
  if (support === null) return [];
  const { breakdown } = support;
  const architecture = support.architecture ?? breakdown.kvCache?.architecture ?? null;
  const maxContext = support.maxContextLength ?? breakdown.kvCache?.maxContextLength ?? null;

  return [
    { label: 'Weights', value: formatGiB(breakdown.modelSizeBytes) },
    {
      label: 'KV cache',
      value: `${formatGiB(breakdown.kvCacheBytes)} at ${breakdown.contextSize.toLocaleString('en-US')} tokens`,
    },
    { label: 'Total needed', value: formatGiB(breakdown.totalRequiredBytes) },
    {
      label: 'Usable memory',
      value: `${formatGiB(breakdown.usableTotalMemoryBytes)} of ${formatGiB(breakdown.totalSystemMemoryBytes)}, ${formatGiB(breakdown.reserveBytes)} held back`,
    },
    {
      label: 'VRAM',
      value:
        breakdown.totalVramBytes > 0
          ? `${formatGiB(breakdown.usableVramBytes)} usable of ${formatGiB(breakdown.totalVramBytes)}`
          : 'none detected',
    },
    { label: 'Architecture', value: architecture ?? 'unknown' },
    {
      label: 'Max context',
      value: maxContext === null ? 'unknown' : `${maxContext.toLocaleString('en-US')} tokens`,
    },
    { label: 'Download size', value: formatBytes(support.sizeBytes) },
  ];
}

/** Main's own one-line justification for the verdict, or null when it gave none. */
export function supportReason(support: VariantSupportView | null): string | null {
  const reason = support?.breakdown.reason.trim();
  return reason && reason.length > 0 ? reason : null;
}

/**
 * Why the hero has nothing to offer. Five causes, five different remedies.
 *
 * `recommendModel` returns null for all of them, so the distinction has to be
 * made here. Collapsing them was the bug: "not checked" rendered as "too big",
 * which told someone with a perfectly capable machine that nothing fits it.
 */
export type HeroEmptyReason =
  | 'catalog-unreadable'
  | 'machine-unknown'
  | 'unchecked'
  | 'checks-failed'
  | 'none-fit';

export interface HeroEmptyInput {
  readonly catalogCount: number;
  readonly isMachineDetected: boolean;
  /** Curated builds whose check came back RED. */
  readonly tooBig: number;
  /** Curated builds whose check came back with an error. */
  readonly checkFailed: number;
  /** Curated builds nothing has read a header for. */
  readonly unchecked: number;
}

/**
 * Precedence, worst-founded first: no catalog beats no machine reading, which
 * beats a missing check, which beats a failed one. `none-fit` is last because it
 * is the only claim that needs *every* other possibility ruled out — saying
 * "nothing fits" while a single check is outstanding would be a guess.
 */
export function heroEmptyReason(input: HeroEmptyInput): HeroEmptyReason {
  if (input.catalogCount === 0) return 'catalog-unreadable';
  if (!input.isMachineDetected) return 'machine-unknown';
  if (input.unchecked > 0) return 'unchecked';
  if (input.checkFailed > 0) return 'checks-failed';
  if (input.tooBig > 0) return 'none-fit';
  return 'unchecked';
}

export interface HeroEmptyCopy {
  readonly reason: HeroEmptyReason;
  readonly title: string;
  readonly description: string;
}

export function heroEmptyCopy(input: HeroEmptyInput, platform: string | null): HeroEmptyCopy {
  const machine = machineWord(platform);
  const reason = heroEmptyReason(input);

  switch (reason) {
    case 'catalog-unreadable':
      return {
        reason,
        title: 'The curated list could not be read',
        description:
          'Restart the app and try again. You can still search below and download by name.',
      };
    case 'machine-unknown':
      return {
        reason,
        title: `We could not measure this ${machine}`,
        description: `Press Re-check above. Until memory can be measured, nothing can be recommended — but you can still browse and download below.`,
      };
    case 'unchecked':
      return {
        reason,
        title: 'Nothing has been checked yet',
        description: `Nothing has read these models' headers, so how much memory each needs on this ${machine} is still unknown. Press Re-check above, or check one row at a time below.`,
      };
    case 'checks-failed':
      return {
        reason,
        title: `We could not check these against this ${machine}`,
        description:
          'Every compatibility check failed, so nothing can be recommended yet — this is not a verdict that they are too big. Press Re-check above; each row below says what went wrong.',
      };
    case 'none-fit':
      return {
        reason,
        title: `Nothing in the curated list fits this ${machine}`,
        description:
          `Every curated build needs more memory than this ${machine} has usable. Search below for something smaller — "1.5b" or "3b" is a good place to start.`,
      };
  }
}

/**
 * The hero's one sentence: what the model is good at, then what it costs.
 *
 * The memory clause is dropped rather than guessed when no verdict has been
 * computed — an invented number here is the one thing the whole page is for.
 */
export function heroSentence(
  goodFor: string | null,
  sizeBytes: number | null,
  requiredBytes: number | null,
): string {
  const lead = goodFor ? (goodFor.endsWith('.') ? goodFor : `${goodFor}.`) : '';
  const memory = approxGigabytes(requiredBytes);
  const cost =
    sizeBytes === null
      ? memory === null
        ? ''
        : `Uses ${memory} of memory while running.`
      : memory === null
        ? `${formatBytes(sizeBytes)} download.`
        : `${formatBytes(sizeBytes)} download, uses ${memory} of memory while running.`;
  return [lead, cost].filter((part) => part.length > 0).join(' ');
}

/** `about 4 min`, rounded the way someone waiting would round it. */
export function approxDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds / 10) * 10)} sec`;
  if (seconds < 5400) return `about ${Math.max(2, Math.round(seconds / 60))} min`;
  return `about ${Math.round(seconds / 3600)} hr`;
}

/**
 * `about 4 min on this connection`, or null.
 *
 * Null is the common case and the correct one: a rate only exists while a
 * download is actually moving, and the design would rather say nothing than
 * quote a speed nobody measured.
 */
export function downloadEtaSentence(
  sizeBytes: number | null,
  bytesPerSecond: number | null,
): string | null {
  if (sizeBytes === null || bytesPerSecond === null || bytesPerSecond <= 0) return null;
  const duration = approxDuration(sizeBytes / bytesPerSecond);
  return duration === null ? null : `${duration} on this connection`;
}

/** `2 models · 6.4 GB on disk`, the summary line on the installed disclosure. */
export function installedSummary(count: number, diskBytes: number): string {
  const models = `${count} ${count === 1 ? 'model' : 'models'}`;
  return count === 0 ? 'Nothing downloaded yet' : `${models} · ${formatBytes(diskBytes)} on disk`;
}

/** `6 curated builds, plus search across Hugging Face`. */
export function browseSummary(curatedCount: number): string {
  return `${curatedCount} curated ${curatedCount === 1 ? 'build' : 'builds'}, plus search across Hugging Face`;
}

/** `2.0 GB on disk · faster, less accurate` — the second line of an installed row. */
export function installedRowSubtitle(sizeBytes: number | null, note: string | null): string {
  const disk = `${formatBytes(sizeBytes)} on disk`;
  const trimmed = note?.trim();
  return trimmed ? `${disk} · ${trimmed}` : disk;
}

/** The footnote: the two constants every verdict on the page was judged against. */
export function fitFootnote(contextSize: number, reserveBytes: number): string {
  const context =
    contextSize % 1024 === 0 ? `${contextSize / 1024}k` : `${contextSize.toLocaleString('en-US')}-token`;
  const reserve = approxGigabytes(reserveBytes)?.replace('about ', '') ?? 'some memory';
  return `Fit is judged at a ${context} context with ${reserve} held back for the system.`;
}
