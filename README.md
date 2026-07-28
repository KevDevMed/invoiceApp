# InvoiceApp

Offline-first invoicing desktop app. Electron main process + React 19 renderer
styled with the [Astryx](https://www.npmjs.com/package/@astryxdesign/core) design
system, SQLite persistence via better-sqlite3, and a zod-validated IPC contract.

This repository currently contains **the foundation only**: the app shell, the
database schema, and the frozen IPC contract. Invoicing logic, PDF export and
the local LLM assistant are built on top of it.

## Requirements

- Node 20.19+ (developed on 24.18.0), npm 11
- A C++ toolchain (`python3`, `make`, `g++`) — better-sqlite3 is a native addon

## Getting started

```bash
npm install     # also builds better-sqlite3 for both Node and Electron (see below)
npm run dev     # electron-vite dev server + Electron
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR for the renderer, auto-restart for main |
| `npm run build` | Typecheck, then bundle main, preload and renderer into `out/` |
| `npm run typecheck` | `tsc --noEmit` over the node and web projects |
| `npm run lint` | ESLint (flat config) over the whole repo |
| `npm test` | Vitest in watch mode |
| `npm run test:run` | Vitest once |
| `npm run package:mac` | electron-builder: dmg + zip, arm64 + x64. macOS host only |

### The two-ABI native build

better-sqlite3 has to be compiled against a specific V8 ABI, and Electron's
differs from Node's. `postinstall` therefore builds it twice:

1. `npm rebuild better-sqlite3` → Node ABI, copied to `build/node-abi/`
2. `electron-rebuild` → Electron ABI, left at the default `build/Release/`

`src/db/client.ts` picks the Node build when it is not running inside Electron,
so Vitest and the app share one dependency without fighting over the binary.
`INVOICEAPP_SQLITE_BINDING` overrides the choice.

## Layout

```
src/
  main/         Electron main process
    index.ts      boot order: CSP -> database -> IPC -> window
    window.ts     BrowserWindow + the renderer's security envelope
    paths.ts      every path the app writes to
    ipc/registry.ts  the only place ipcMain.handle is called
  preload/      contextBridge surface (CommonJS, sandboxed)
  db/           connection, migration runner, migrations/*.sql
  shared/       IPC contract, domain types, money arithmetic
  renderer/     React app (hash router, Astryx components)
```

## Architecture rules

These are load-bearing. Breaking one breaks a guarantee somewhere else.

**Money is integers.** Amounts are cents, quantities are milli-units (3
decimals), tax rates are basis points. There is no `REAL` column in the schema
and no float arithmetic in `src/shared/money.ts` — every scaling step goes
through `BigInt`. Use the helpers; do not reinvent them.

**The IPC contract is frozen.** `src/shared/ipc-contract.ts` declares every
channel with a zod schema for its request and its response. `registerHandler`
refuses any channel not in the contract, and preload's allow-list refuses to
forward one, so an undeclared channel is unreachable from the renderer by
construction.

**The renderer is untrusted.** `contextIsolation: true`, `nodeIntegration:
false`, `sandbox: true`. `ipcRenderer` is never exposed; the renderer sees only
`window.api.invoke` and `window.api.on`. A Content-Security-Policy that permits
no remote script is installed as a response header in `src/main/window.ts`.
Navigation away from the app and `window.open` are blocked.

**All SQL uses bound parameters.** No string-concatenated SQL, anywhere.

**The schema is owned by `001_init.sql`.** Feature code writes queries, never
DDL. New migrations are new numbered files; shipped ones are never edited.

## Adding an IPC handler

1. The channel must already exist in `IPC_CONTRACT`.
2. Create `src/main/ipc/<feature>.ts` exporting `register()`:

   ```ts
   import { IPC_CONTRACT } from '../../shared/ipc-contract';
   import { registerHandler } from './registry';

   export function register(): void {
     registerHandler('clients:list', IPC_CONTRACT['clients:list'].request, (payload) => {
       // payload is already parsed and typed
     });
   }
   ```

3. That is all. `registerAll()` discovers `src/main/ipc/*.ts` through a
   build-time glob — there is no list to edit, and a module that is missing or
   throws on import is logged and skipped rather than blocking boot.

## Adding a page

Replace the route element in `src/renderer/routes.tsx`. `AppShell.tsx` and its
`NAV_ITEMS` stay as they are — every screen shares one shell.

## Astryx notes

Astryx is beta, so `@astryxdesign/core` and `@astryxdesign/theme-neutral` are
pinned to exact versions. Discover the real API rather than guessing:

```bash
npx astryx component            # list every component
npx astryx component SideNav    # props for one
npx astryx docs tokens
npx astryx docs icons
```

The semantic icon registry has no invoicing-domain icons, so the sidebar is
deliberately text-only. A feature that wants icons should pass SVG components
directly or call `registerIcons()`.

## macOS builds and releases

electron-builder cannot produce a mac target from Linux, so release builds run
on GitHub Actions: `.github/workflows/build-mac.yml` on a `macos-latest`
runner. It is triggered by pushing a `v*` tag or manually via
`workflow_dispatch` with the `release` input, and publishes two stable-named
assets to the GitHub Release:

```
https://github.com/KevDevMed/invoiceApp/releases/latest/download/InvoiceApp-mac-arm64.dmg
https://github.com/KevDevMed/invoiceApp/releases/latest/download/InvoiceApp-mac-x64.dmg
```

### Cutting a release

One click, no local git: Actions → **Cut release** → Run workflow, and type the
new version — `patch`, `minor`, `major`, or an explicit `0.1.6` (no leading
`v`). The workflow bumps `package.json` on main, tags `v0.1.6`, and starts
`build-mac.yml`, which builds, signs and publishes the release. A bad version —
malformed, not above the current one, or an already-used tag — is refused
before anything is pushed. The last step prints the URL of the build run;
expect the release to appear there (notarisation can take a couple of hours).

The published build is ad-hoc signed but not notarised (no Apple Developer ID),
so Gatekeeper interrupts the first launch — the user approves it via System
Settings > Privacy & Security > Open Anyway. The preview's `/download` page
walks users through it.

## Browser preview

`preview/` serves the **real renderer** over HTTP so the app can be reviewed
without a signed macOS build. It is a preview, not a second product: the same
`src/renderer` entry, the same Astryx CSS, and the same `src/domain`
repositories. Nothing under `src/` changes to support it — the seam is
`window.api`, which `preview/web-shim.ts` reimplements on top of
`POST /api/invoke` instead of Electron IPC.

```bash
npm run preview:build   # build the web bundle into preview/dist
npm run preview:serve   # http://0.0.0.0:4300
npm run preview:dev     # both
npm run preview:test    # the preview's own vitest suite
```

The server exposes three routes:

| Route | What it serves |
| --- | --- |
| `/` | The marketing landing page (`preview/landing/`) |
| `/app` | The live in-browser preview of the real renderer |
| `/download` | Install instructions for the macOS build (`preview/download/`) |

Environment: `PREVIEW_HOST`, `PREVIEW_PORT` (default `0.0.0.0:4300`),
`PREVIEW_DB_PATH` (default `./preview-data/preview.db`), and `PREVIEW_RESET=1`
to wipe and reseed the demo data. The preview database is created and migrated
on boot and is entirely separate from the desktop app's user-data directory.

`POST /api/invoke` takes `{ channel, payload }` and answers `{ ok: true, data }`
or `{ ok: false, error: { code, message } }`. Every payload is validated with
`IPC_CONTRACT[channel].request` — the contract's own zod schema, exactly as
`src/main/ipc/registry.ts` does it — and undeclared channels are refused.

`settings:*`, `app:version`, `clients:*`, `invoices:*` (except `exportPdf`) and
`reports:*` run for real. `invoices:exportPdf` and every `llm:*` channel return
a `DESKTOP_ONLY` error rather than fake data: PDF export needs Electron's
`printToPDF` and local models need the native llama.cpp runtime. `/download`
explains how to get the macOS build.

Docker (the Dokploy target) builds the bundle and runs the server as a non-root
user on port 4300, with `/healthz` for the healthcheck and a named volume for
`preview-data`:

```bash
docker compose up --build
```
