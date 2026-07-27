/**
 * Browser window creation and the renderer's security envelope.
 *
 * The renderer is treated as untrusted: context-isolated, sandboxed, no Node,
 * no remote script, no navigation away from the app, no window.open.
 */

import path from 'node:path';

import { BrowserWindow, session, shell, app } from 'electron';

const isDev = !app.isPackaged;

/** The dev server electron-vite starts. Empty in production. */
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? '';

/**
 * Content-Security-Policy applied to every response the renderer loads.
 *
 * Both variants forbid remote script: `script-src` lists no remote origin in
 * either case. The dev variant additionally allows Vite's inline HMR preamble
 * and its websocket, which only exist when `electron-vite dev` is running.
 */
function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    isDev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
  ];
  return directives.join('; ');
}

/** Install the CSP as a response header so it covers file:// and the dev server alike. */
export function installContentSecurityPolicy(): void {
  const policy = contentSecurityPolicy();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });

  // Deny every permission request outright — the app is fully offline and needs
  // no camera, microphone, geolocation or notifications.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

/**
 * Refuse in-app navigation and window.open for anything that is not our own
 * renderer; open genuine external links in the user's browser instead.
 */
export function hardenWebContents(contents: Electron.WebContents): void {
  contents.on('will-navigate', (event, url) => {
    const isDevServer = DEV_SERVER_URL !== '' && url.startsWith(DEV_SERVER_URL);
    if (!isDevServer && !url.startsWith('file://')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'InvoiceApp',
    backgroundColor: '#111112',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // The preload is emitted as CommonJS precisely so it can run sandboxed.
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return window;
}
