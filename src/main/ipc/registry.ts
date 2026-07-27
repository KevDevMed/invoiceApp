/**
 * The single place `ipcMain.handle` is called.
 *
 * `registerHandler` is the only way a channel becomes reachable. It refuses any
 * channel that is not declared in the frozen contract, validates every incoming
 * payload with that channel's zod schema before the handler sees it, and turns
 * handler rejections into plain Error messages so no stack trace or object
 * graph leaks into the renderer.
 *
 * DOWNSTREAM BUILDERS: drop a module into `src/main/ipc/` (for example
 * `invoices.ts`) that exports `register(): void | Promise<void>`. It is picked
 * up automatically — there is no list to edit. If your module is missing or
 * throws on import, the app still boots with the remaining handlers.
 */

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';

import { getDatabase } from '../../db/client';
import {
  IPC_CONTRACT,
  isInvokeChannel,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from '../../shared/ipc-contract';

export type Handler<C extends IpcChannel> = (
  payload: IpcRequest<C>,
  event: IpcMainInvokeEvent,
) => IpcResponse<C> | Promise<IpcResponse<C>>;

const registered = new Set<IpcChannel>();

/** Channels that currently have a live handler. Useful for diagnostics and tests. */
export function registeredChannels(): IpcChannel[] {
  return [...registered];
}

/**
 * Bind a handler to a contract channel.
 *
 * @param channel A channel declared in `IPC_CONTRACT`. Anything else throws.
 * @param requestSchema The request schema for that channel. Pass
 *   `IPC_CONTRACT[channel].request` — it is the schema the contract froze.
 */
export function registerHandler<C extends IpcChannel>(
  channel: C,
  requestSchema: z.ZodType<IpcRequest<C>, z.ZodTypeDef, unknown>,
  handler: Handler<C>,
): void {
  if (!isInvokeChannel(channel)) {
    throw new Error(`Refusing to register unknown IPC channel: ${String(channel)}`);
  }
  if (registered.has(channel)) {
    throw new Error(`IPC channel already registered: ${channel}`);
  }
  registered.add(channel);

  ipcMain.handle(channel, async (event, rawPayload: unknown) => {
    const parsed = requestSchema.safeParse(rawPayload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid payload for ${channel} — ${detail}`);
    }

    try {
      return await handler(parsed.data, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ipc] ${channel} failed:`, error);
      throw new Error(`${channel} failed: ${message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Shell-owned handlers
// ---------------------------------------------------------------------------

function registerSettingsHandlers(): void {
  registerHandler('settings:get', IPC_CONTRACT['settings:get'].request, ({ key }) => {
    const row = getDatabase()
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get(key);
    return { key, value: row?.value ?? null };
  });

  registerHandler('settings:set', IPC_CONTRACT['settings:set'].request, ({ key, value }) => {
    getDatabase()
      .prepare<[string, string]>(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
    return { key, value };
  });
}

function registerAppHandlers(): void {
  registerHandler('app:version', IPC_CONTRACT['app:version'].request, () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }));
}

// ---------------------------------------------------------------------------
// Downstream handler discovery
// ---------------------------------------------------------------------------

interface HandlerModule {
  register?: () => void | Promise<void>;
  default?: () => void | Promise<void>;
}

/**
 * Vite resolves this glob at build time, so downstream modules are bundled the
 * moment they exist and the glob is simply empty until then. Nothing is read
 * from disk at runtime, which keeps it working inside a packaged asar.
 */
const downstreamModules = import.meta.glob<HandlerModule>('./*.ts', { eager: false });

export async function registerAll(): Promise<void> {
  registerSettingsHandlers();
  registerAppHandlers();

  for (const [modulePath, load] of Object.entries(downstreamModules)) {
    if (modulePath.endsWith('/registry.ts')) continue;
    try {
      const module = await load();
      const register = module.register ?? module.default;
      if (typeof register === 'function') {
        await register();
      } else {
        console.warn(
          `[ipc] ${modulePath} exports no register() function — assuming it self-registered on import.`,
        );
      }
    } catch (error) {
      console.warn(`[ipc] skipping handler module ${modulePath}:`, error);
    }
  }

  console.log(`[ipc] registered ${registered.size} channels: ${[...registered].join(', ')}`);
}
