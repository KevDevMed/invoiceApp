/**
 * IPC handlers for reports. Auto-discovered by the registry glob.
 */

import { getDatabase } from '../../db/client';
import { byClient, outstanding, revenueByPeriod, summary } from '../../domain/reports/queries';
import { IPC_CONTRACT } from '../../shared/ipc-contract';
import { registerHandler } from './registry';

export function register(): void {
  registerHandler('reports:summary', IPC_CONTRACT['reports:summary'].request, (payload) =>
    summary(getDatabase(), payload ?? {}),
  );

  registerHandler(
    'reports:revenueByPeriod',
    IPC_CONTRACT['reports:revenueByPeriod'].request,
    ({ period, from, to }) => revenueByPeriod(getDatabase(), period, { from, to }),
  );

  registerHandler('reports:byClient', IPC_CONTRACT['reports:byClient'].request, (payload) =>
    byClient(getDatabase(), { from: payload?.from, to: payload?.to }, payload?.limit ?? 50),
  );

  registerHandler('reports:outstanding', IPC_CONTRACT['reports:outstanding'].request, (payload) =>
    outstanding(getDatabase(), payload?.asOf),
  );
}
