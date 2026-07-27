/**
 * IPC handlers for the clients domain. Auto-discovered by the registry glob.
 */

import { getDatabase } from '../../db/client';
import {
  createClient,
  deleteClient,
  getClient,
  listClients,
  updateClient,
} from '../../domain/clients/repository';
import { IPC_CONTRACT } from '../../shared/ipc-contract';
import { registerHandler } from './registry';

export function register(): void {
  registerHandler('clients:list', IPC_CONTRACT['clients:list'].request, (payload) =>
    listClients(getDatabase(), payload),
  );

  registerHandler('clients:get', IPC_CONTRACT['clients:get'].request, ({ id }) =>
    getClient(getDatabase(), id),
  );

  registerHandler('clients:create', IPC_CONTRACT['clients:create'].request, (payload) =>
    createClient(getDatabase(), payload),
  );

  registerHandler('clients:update', IPC_CONTRACT['clients:update'].request, ({ id, patch }) =>
    updateClient(getDatabase(), id, patch),
  );

  registerHandler('clients:delete', IPC_CONTRACT['clients:delete'].request, ({ id }) =>
    deleteClient(getDatabase(), id),
  );
}
