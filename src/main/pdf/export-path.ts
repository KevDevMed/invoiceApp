/**
 * Confinement for PDF export paths.
 *
 * The renderer is untrusted: anything it sends is at most a *suggestion*. The
 * real write target always comes from the native save dialog, and even that
 * path is re-validated here (defence in depth) — it must resolve, after
 * symlink-aware normalisation, inside one of the user's own directories and
 * end in `.pdf`.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

export class PdfExportPathError extends Error {
  readonly code = 'PDF_EXPORT_PATH_REJECTED';
  constructor(reason: string) {
    super(`PDF export path rejected: ${reason}`);
    this.name = 'PdfExportPathError';
  }
}

const ALLOWED_BASES = ['documents', 'downloads', 'desktop', 'home'] as const;

/**
 * Reduce a renderer-suggested name to a bare, safe file name for the save
 * dialog's `defaultPath`. Never a path: separators, `..` runs, control
 * characters, and null bytes are stripped, and the result always ends in
 * `.pdf`.
 */
export function sanitizeSuggestedFileName(suggestion: string): string {
  const cleaned = suggestion
    // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '_')
    .trim();
  const name = cleaned === '' || cleaned === '.' ? 'invoice' : cleaned;
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

/**
 * Resolve a path with symlinks expanded, even when the file itself does not
 * exist yet: the deepest existing ancestor is `realpath`ed and the remaining
 * segments are re-appended.
 */
async function normalizeWithSymlinks(target: string): Promise<string> {
  let current = path.resolve(target);
  const pending: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...pending.reverse());
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

async function allowedRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const base of ALLOWED_BASES) {
    try {
      const dir = app.getPath(base);
      roots.push(await normalizeWithSymlinks(dir));
    } catch {
      // A platform without this well-known directory: skip it.
    }
  }
  return roots;
}

/**
 * Validate the final write target. Returns the fully resolved path to write
 * to, or throws `PdfExportPathError`.
 */
export async function assertAllowedPdfPath(target: string): Promise<string> {
  if (target.includes('\0')) {
    throw new PdfExportPathError('the path contains a null byte');
  }
  const resolved = await normalizeWithSymlinks(target);
  if (!resolved.toLowerCase().endsWith('.pdf')) {
    throw new PdfExportPathError('the file name must end in .pdf');
  }
  const roots = await allowedRoots();
  const inside = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) {
    throw new PdfExportPathError(
      'the destination must be inside your Documents, Downloads, Desktop, or home directory',
    );
  }
  return resolved;
}
