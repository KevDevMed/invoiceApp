/**
 * The curated model catalog.
 *
 * Every entry here was verified with an HTTP HEAD against the constructed
 * Hugging Face `resolve/main` URL: each returned 200 with a `content-length`
 * matching `sizeBytes`, and `sha256` is the blob digest reported by the Hub API.
 * Nothing is invented — an entry that cannot be verified does not ship.
 *
 * The list is deliberately small and biased towards permissively-licensed
 * models that actually emit tool calls, since the assistant is useless without
 * that. Sizes are the on-disk GGUF size; assume roughly the same again in RAM
 * plus the KV cache for the context window.
 *
 * This module is pure data plus path arithmetic. It imports nothing from
 * Electron so it can be unit-tested directly.
 */

import path from 'node:path';

export interface CatalogEntry {
  /** Stable local identifier. Also the on-disk directory name — see `MODEL_ID_PATTERN`. */
  readonly id: string;
  readonly displayName: string;
  /** Hugging Face repo, `owner/name`. */
  readonly repo: string;
  readonly filename: string;
  readonly quant: string;
  /** Exact `content-length` of the GGUF, in bytes. */
  readonly sizeBytes: number;
  /** Blob SHA-256 as reported by the Hub. Verified after download. */
  readonly sha256: string;
  /** Native context length of the model, in tokens. */
  readonly contextLength: number;
  /** Context we actually default to — the full window rarely fits in RAM. */
  readonly defaultContextSize: number;
  readonly license: string;
  /** Approximate parameter count in billions, for the "will this run" hint. */
  readonly paramsBillions: number;
  /** Short, human "good for" note shown on the model card. */
  readonly goodFor: string;
  /** Whether the chat template emits structured tool calls. */
  readonly supportsTools: boolean;
}

/**
 * Model ids are directory names. No dots at all, so `..` is unrepresentable
 * rather than merely filtered.
 */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Weight filenames. Dots are allowed but `..` and separators are not. */
export const MODEL_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.gguf$/;

export class UnsafeModelPathError extends Error {
  readonly code = 'UNSAFE_MODEL_PATH';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeModelPathError';
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isSafeModelId(value: string): boolean {
  return !hasControlCharacters(value) && MODEL_ID_PATTERN.test(value);
}

export function isSafeModelFilename(value: string): boolean {
  if (hasControlCharacters(value)) return false;
  if (value.includes('..')) return false;
  return MODEL_FILENAME_PATTERN.test(value);
}

export function assertSafeModelId(value: string): string {
  if (!isSafeModelId(value)) {
    throw new UnsafeModelPathError(`Refusing unsafe model id: ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertSafeModelFilename(value: string): string {
  if (!isSafeModelFilename(value)) {
    throw new UnsafeModelPathError(`Refusing unsafe model filename: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Resolve where a model's weights live, refusing anything that would escape
 * `modelsRoot`. Both the pattern check and the containment check must pass: the
 * pattern is the intent, the containment check is the proof.
 */
export function resolveModelPath(modelsRoot: string, id: string, filename: string): string {
  assertSafeModelId(id);
  assertSafeModelFilename(filename);

  const root = path.resolve(modelsRoot);
  const resolved = path.resolve(root, id, filename);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new UnsafeModelPathError(`Resolved model path escapes the models directory: ${resolved}`);
  }
  return resolved;
}

/** Directory holding one model's files. Same safety guarantees as `resolveModelPath`. */
export function resolveModelDir(modelsRoot: string, id: string): string {
  assertSafeModelId(id);
  const root = path.resolve(modelsRoot);
  const resolved = path.resolve(root, id);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new UnsafeModelPathError(`Resolved model directory escapes the models directory: ${resolved}`);
  }
  return resolved;
}

const HUGGINGFACE_ORIGIN = 'https://huggingface.co';

/**
 * Build the Hugging Face download URL for a repo/file pair.
 *
 * Each path segment is encoded separately so a `/` inside a filename can never
 * turn into an extra path segment, and the result is re-parsed to guarantee the
 * scheme and host are the ones we intended.
 */
export function downloadUrl(repo: string, filename: string): string {
  const segments = repo.split('/');
  if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) {
    throw new UnsafeModelPathError(`Expected a Hugging Face "owner/name" repo, got: ${JSON.stringify(repo)}`);
  }
  assertSafeModelFilename(filename);

  const encoded = [...segments, 'resolve', 'main', filename].map(encodeURIComponent).join('/');
  const url = new URL(`${HUGGINGFACE_ORIGIN}/${encoded}`);
  if (url.protocol !== 'https:' || url.host !== 'huggingface.co') {
    throw new UnsafeModelPathError(`Refusing non-Hugging Face download URL: ${url.toString()}`);
  }
  return url.toString();
}

export function catalogEntryUrl(entry: CatalogEntry): string {
  return downloadUrl(entry.repo, entry.filename);
}

/**
 * Downloads only ever go over TLS. The downloader calls this on the final URL
 * as well as on every redirect target it is handed.
 */
export function assertHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeModelPathError(`Not a URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeModelPathError(`Refusing non-https download URL: ${url.protocol}//${url.host}`);
  }
  return url.toString();
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'qwen3-0-6b-q8-0',
    displayName: 'Qwen3 0.6B (Q8_0)',
    repo: 'Qwen/Qwen3-0.6B-GGUF',
    filename: 'Qwen3-0.6B-Q8_0.gguf',
    quant: 'Q8_0',
    sizeBytes: 639_446_688,
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
    contextLength: 32_768,
    defaultContextSize: 4_096,
    license: 'Apache-2.0',
    paramsBillions: 0.6,
    goodFor: 'Weak machines and laptops with 4 GB free RAM. Fast, follows simple tool calls, weak at long reasoning.',
    supportsTools: true,
  },
  {
    id: 'qwen3-1-7b-q4-k-m',
    displayName: 'Qwen3 1.7B (Q4_K_M)',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    filename: 'Qwen3-1.7B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 1_107_409_472,
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    contextLength: 32_768,
    defaultContextSize: 8_192,
    license: 'Apache-2.0',
    paramsBillions: 1.7,
    goodFor: 'The recommended default. ~1 GB on disk, reliable tool calling, comfortable in 4 GB of RAM.',
    supportsTools: true,
  },
  {
    id: 'qwen2-5-1-5b-instruct-q4-k-m',
    displayName: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 1_117_320_736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    contextLength: 32_768,
    defaultContextSize: 8_192,
    license: 'Apache-2.0',
    paramsBillions: 1.5,
    goodFor: 'No "thinking" preamble, so replies are short and literal. Good when Qwen3 is too chatty.',
    supportsTools: true,
  },
  {
    id: 'qwen3-4b-q4-k-m',
    displayName: 'Qwen3 4B (Q4_K_M)',
    repo: 'Qwen/Qwen3-4B-GGUF',
    filename: 'Qwen3-4B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 2_497_280_256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    contextLength: 32_768,
    defaultContextSize: 8_192,
    license: 'Apache-2.0',
    paramsBillions: 4,
    goodFor: 'The sweet spot on a 8 GB machine. Handles multi-step tool sequences without losing the thread.',
    supportsTools: true,
  },
  {
    id: 'mistral-7b-instruct-v03-q4-k-m',
    displayName: 'Mistral 7B Instruct v0.3 (Q4_K_M)',
    repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    filename: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 4_372_812_000,
    sha256: '1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6',
    contextLength: 32_768,
    defaultContextSize: 8_192,
    license: 'Apache-2.0',
    paramsBillions: 7,
    goodFor: 'Native function-calling template. Strong on structured output; needs about 6 GB of free RAM.',
    supportsTools: true,
  },
  {
    id: 'qwen3-8b-q4-k-m',
    displayName: 'Qwen3 8B (Q4_K_M)',
    repo: 'Qwen/Qwen3-8B-GGUF',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 5_027_783_488,
    sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
    contextLength: 32_768,
    defaultContextSize: 8_192,
    license: 'Apache-2.0',
    paramsBillions: 8,
    goodFor: 'The most capable option here. Wants 8 GB of free RAM; noticeably slower without a GPU.',
    supportsTools: true,
  },
];

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

export function findCatalogEntryByFile(repo: string, filename: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.repo === repo && entry.filename === filename);
}

/**
 * Derive a safe local id for a repo/file pair that is not in the catalog.
 *
 * `llm:download` takes a repo and a filename rather than a catalog id, so the
 * renderer can in principle ask for something we never curated. The id it gets
 * is squeezed through the same allow-list every other id is.
 */
export function deriveModelId(repo: string, filename: string): string {
  const known = findCatalogEntryByFile(repo, filename);
  if (known) return known.id;

  const slug = `${repo}-${filename.replace(/\.gguf$/i, '')}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return assertSafeModelId(slug);
}

/** One-line summary used wherever the contract only gives us a `description` field. */
export function describeEntry(entry: CatalogEntry): string {
  const gigabytes = (entry.sizeBytes / 1_000_000_000).toFixed(2);
  const context = `${Math.round(entry.contextLength / 1024)}K context`;
  return `${entry.license} · ${context} · ${gigabytes} GB · ${entry.goodFor}`;
}
