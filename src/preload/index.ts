/**
 * The only bridge between renderer and main.
 *
 * `ipcRenderer` itself is never exposed. The renderer gets exactly two
 * functions, both of which check the requested channel against the frozen
 * contract's allow-list before touching IPC. A channel that is not in the
 * contract cannot be invoked or subscribed to from the renderer at all.
 *
 * This file is bundled as CommonJS so it can run with `sandbox: true`.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  isEventChannel,
  isInvokeChannel,
  type IpcChannel,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcRequest,
  type IpcResponse,
} from '../shared/ipc-contract';

export type Unsubscribe = () => void;

export interface RendererApi {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
  ): Unsubscribe;
}

const api: RendererApi = {
  invoke(channel, payload) {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(new Error(`Blocked IPC invoke on undeclared channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<typeof channel>>;
  },

  on(channel, listener) {
    if (!isEventChannel(channel)) {
      throw new Error(`Blocked IPC subscription to undeclared channel: ${String(channel)}`);
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload as IpcEventPayload<typeof channel>);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
