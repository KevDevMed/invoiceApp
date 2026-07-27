/**
 * Offscreen HTML -> PDF rendering.
 *
 * The window is created hidden, fed a data: URL (nothing remote can load —
 * the template is self-contained), printed with backgrounds, and ALWAYS
 * destroyed in `finally` so a failed export never leaks an offscreen window.
 */

import { writeFile } from 'node:fs/promises';

import { BrowserWindow, dialog } from 'electron';

export class PdfExportCancelledError extends Error {
  readonly code = 'PDF_EXPORT_CANCELLED';
  constructor() {
    super('PDF export cancelled by the user.');
    this.name = 'PdfExportCancelledError';
  }
}

export interface RenderPdfOptions {
  /** When omitted, a save dialog picks the path (and may cancel the export). */
  readonly targetPath?: string;
  /** Suggested file name for the save dialog. */
  readonly defaultFileName: string;
}

export interface RenderPdfResult {
  readonly path: string;
  readonly bytes: number;
}

async function resolveTargetPath(options: RenderPdfOptions): Promise<string> {
  if (options.targetPath) return options.targetPath;
  const result = await dialog.showSaveDialog({
    title: 'Export invoice as PDF',
    defaultPath: options.defaultFileName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) throw new PdfExportCancelledError();
  return result.filePath;
}

export async function renderHtmlToPdf(
  html: string,
  options: RenderPdfOptions,
): Promise<RenderPdfResult> {
  const targetPath = await resolveTargetPath(options);

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
