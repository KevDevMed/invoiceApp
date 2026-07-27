/**
 * Offscreen HTML -> PDF rendering.
 *
 * The window is created hidden, fed a data: URL (nothing remote can load —
 * the template is self-contained), printed with backgrounds, and ALWAYS
 * destroyed in `finally` so a failed export never leaks an offscreen window.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, dialog } from 'electron';

import { assertAllowedPdfPath, sanitizeSuggestedFileName } from './export-path';

export interface RenderPdfOptions {
  /**
   * Renderer-supplied *suggestion* only. Never written to directly: at most
   * its base name seeds the save dialog's `defaultPath`. The dialog's answer
   * is the sole write target, and it is still validated by
   * `assertAllowedPdfPath` before anything touches disk.
   */
  readonly targetPath?: string;
  /** Suggested file name for the save dialog. */
  readonly defaultFileName: string;
}

/** `path: ''` / `bytes: 0` means the user cancelled the save dialog. */
export interface RenderPdfResult {
  readonly path: string;
  readonly bytes: number;
}

async function resolveTargetPath(options: RenderPdfOptions): Promise<string | null> {
  const suggested = sanitizeSuggestedFileName(
    options.targetPath ? path.basename(options.targetPath) : options.defaultFileName,
  );
  const result = await dialog.showSaveDialog({
    title: 'Export invoice as PDF',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return null;
  return assertAllowedPdfPath(result.filePath);
}

export async function renderHtmlToPdf(
  html: string,
  options: RenderPdfOptions,
): Promise<RenderPdfResult> {
  const targetPath = await resolveTargetPath(options);
  if (targetPath === null) return { path: '', bytes: 0 };

  const window = new BrowserWindow({
    show: false,
    width: 794, // A4 at 96dpi; layout only, print sizing comes from printToPDF
    height: 1123,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
    await window.loadURL(dataUrl);
    const buffer = await window.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
    });
    await writeFile(targetPath, buffer);
    return { path: targetPath, bytes: buffer.byteLength };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}
