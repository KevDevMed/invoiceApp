/**
 * The renderer is untrusted, so its `targetPath` must never be written to
 * directly: the save dialog picks the real path, and even that path has to
 * land inside an allowed user directory and end in `.pdf`.
 */

import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn<
    (options: { defaultPath: string }) => Promise<{ canceled: boolean; filePath?: string }>
  >(),
  getPath: vi.fn<(name: string) => string>(),
  writeFile: vi.fn<(target: string, data: Buffer) => Promise<void>>(),
  realpath: vi.fn<(target: string) => Promise<string>>(),
  printToPDF: vi.fn<() => Promise<Buffer>>(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mocks.writeFile,
  realpath: mocks.realpath,
}));

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.showSaveDialog },
  app: { getPath: mocks.getPath },
  BrowserWindow: class {
    webContents = { printToPDF: mocks.printToPDF };
    loadURL = vi.fn(async () => undefined);
    isDestroyed = (): boolean => false;
    destroy = vi.fn();
  },
}));

import {
  assertAllowedPdfPath,
  PdfExportPathError,
  sanitizeSuggestedFileName,
} from '../export-path';
import { renderHtmlToPdf } from '../render';

const HOME = '/home/user';
const DOCUMENTS = `${HOME}/Documents`;

/** Paths that "exist"; the value is what realpath resolves them to. */
const REAL_PATHS = new Map<string, string>([
  ['/', '/'],
  ['/etc', '/etc'],
  ['/home', '/home'],
  [HOME, HOME],
  [`${HOME}/.ssh`, `${HOME}/.ssh`],
  [DOCUMENTS, DOCUMENTS],
  [`${HOME}/Downloads`, `${HOME}/Downloads`],
  [`${HOME}/Desktop`, `${HOME}/Desktop`],
  // A symlinked directory inside Documents that escapes to /etc.
  [`${DOCUMENTS}/link`, '/etc'],
]);

const PDF_BYTES = Buffer.from('%PDF-fake');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPath.mockImplementation((name: string) => {
    const known: Record<string, string> = {
      home: HOME,
      documents: DOCUMENTS,
      downloads: `${HOME}/Downloads`,
      desktop: `${HOME}/Desktop`,
    };
    const dir = known[name];
    if (!dir) throw new Error(`unknown path: ${name}`);
    return dir;
  });
  mocks.realpath.mockImplementation((p: string) => {
    const real = REAL_PATHS.get(p);
    if (real === undefined) return Promise.reject(new Error(`ENOENT: ${p}`));
    return Promise.resolve(real);
  });
  mocks.printToPDF.mockResolvedValue(PDF_BYTES);
  mocks.writeFile.mockResolvedValue(undefined);
});

const OPTIONS = { defaultFileName: 'INV-0001.pdf' };

function dialogReturns(filePath: string | undefined, canceled = false): void {
  mocks.showSaveDialog.mockResolvedValue({ canceled, filePath });
}

describe('assertAllowedPdfPath', () => {
  it.each([
    '/etc/passwd',
    '/etc/passwd.pdf',
    `${HOME}/.ssh/authorized_keys`,
    `${DOCUMENTS}/../../../etc/cron.pdf`,
  ])('rejects %s with the typed error', async (target) => {
    await expect(assertAllowedPdfPath(target)).rejects.toBeInstanceOf(PdfExportPathError);
    await expect(assertAllowedPdfPath(target)).rejects.toMatchObject({
      code: 'PDF_EXPORT_PATH_REJECTED',
    });
  });

  it('rejects a path escaping through a symlinked directory', async () => {
    await expect(assertAllowedPdfPath(`${DOCUMENTS}/link/out.pdf`)).rejects.toBeInstanceOf(
      PdfExportPathError,
    );
  });

  it('rejects a non-.pdf extension inside an allowed directory', async () => {
    await expect(assertAllowedPdfPath(`${DOCUMENTS}/report.txt`)).rejects.toMatchObject({
      code: 'PDF_EXPORT_PATH_REJECTED',
    });
  });

  it('accepts a .pdf inside the documents directory', async () => {
    await expect(assertAllowedPdfPath(`${DOCUMENTS}/INV-0001.pdf`)).resolves.toBe(
      `${DOCUMENTS}/INV-0001.pdf`,
    );
  });
});

describe('sanitizeSuggestedFileName', () => {
  it.each([
    '../../../etc/evil',
    'a/b\\c.pdf',
    'inv\u0000oice\u0007.pdf',
    '..',
  ])('removes separators, dot-dot runs, and control bytes from %j', (raw) => {
    const safe = sanitizeSuggestedFileName(raw);
    expect(safe).not.toMatch(/[/\\]/);
    expect(safe).not.toContain('..');
    expect(safe).not.toContain('\u0000');
    expect(safe.endsWith('.pdf')).toBe(true);
  });
});

describe('renderHtmlToPdf', () => {
  it('uses the renderer path only as a sanitised dialog suggestion', async () => {
    dialogReturns(`${DOCUMENTS}/chosen.pdf`);
    await renderHtmlToPdf('<p>x</p>', {
      ...OPTIONS,
      targetPath: '/home/hermes/.ssh/../../../etc/authorized_keys',
    });
    const [dialogOptions] = mocks.showSaveDialog.mock.calls[0]!;
    expect(path.dirname(dialogOptions.defaultPath)).toBe(DOCUMENTS);
    expect(path.basename(dialogOptions.defaultPath)).not.toMatch(/[/\\]/);
    expect(dialogOptions.defaultPath).not.toContain('..');
    expect(dialogOptions.defaultPath.endsWith('.pdf')).toBe(true);
  });

  it('writes to the dialog result, never to the renderer suggestion', async () => {
    dialogReturns(`${HOME}/Downloads/chosen.pdf`);
    const result = await renderHtmlToPdf('<p>x</p>', {
      ...OPTIONS,
      targetPath: `${DOCUMENTS}/suggested.pdf`,
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(`${HOME}/Downloads/chosen.pdf`, PDF_BYTES);
    expect(result).toEqual({ path: `${HOME}/Downloads/chosen.pdf`, bytes: PDF_BYTES.byteLength });
  });

  it('rejects a dialog result outside the allowed directories and writes nothing', async () => {
    dialogReturns('/etc/passwd.pdf');
    await expect(renderHtmlToPdf('<p>x</p>', OPTIONS)).rejects.toBeInstanceOf(PdfExportPathError);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('returns the cancelled outcome and writes nothing when the dialog is dismissed', async () => {
    dialogReturns(undefined, true);
    const result = await renderHtmlToPdf('<p>x</p>', { ...OPTIONS, targetPath: '/etc/passwd' });
    expect(result).toEqual({ path: '', bytes: 0 });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.printToPDF).not.toHaveBeenCalled();
  });

  it('exports into the documents directory when the dialog confirms it', async () => {
    dialogReturns(`${DOCUMENTS}/INV-0001.pdf`);
    const result = await renderHtmlToPdf('<p>x</p>', OPTIONS);
    expect(mocks.writeFile).toHaveBeenCalledWith(`${DOCUMENTS}/INV-0001.pdf`, PDF_BYTES);
    expect(result).toEqual({ path: `${DOCUMENTS}/INV-0001.pdf`, bytes: PDF_BYTES.byteLength });
  });
});
