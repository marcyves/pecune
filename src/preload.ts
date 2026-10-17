import { contextBridge, ipcRenderer } from 'electron'
import type { Result } from './types.ts'

function call<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>
}

const comptes = {
  status: () => call<unknown>('status'),
  createDefault: () => call<string>('createDefault'),
  createAt: () => call<string | null>('createAt'),
  openAt: () => call<string | null>('openAt'),
  exportCopy: () => call<string | null>('exportCopy'),
  workspace: (year: number) => call<unknown>('workspace', year),
  accountDetail: (id: number, year: number) => call<unknown>('accountDetail', id, year),
  saveAccount: (input: unknown) => call<unknown>('saveAccount', input),
  deleteAccount: (id: number) => call<unknown>('deleteAccount', id),
  saveFamily: (input: unknown) => call<unknown>('saveFamily', input),
  moveFamily: (id: number, direction: -1 | 1) => call<unknown>('moveFamily', id, direction),
  saveCategory: (input: unknown) => call<unknown>('saveCategory', input),
  moveCategory: (id: number, direction: -1 | 1) => call<unknown>('moveCategory', id, direction),
  setMonthlyBalance: (accountId: number, month: string, raw: string) =>
    call<unknown>('setMonthlyBalance', accountId, month, raw),
  savePosition: (input: unknown) => call<unknown>('savePosition', input),
  deletePosition: (id: number) => call<unknown>('deletePosition', id),
  setCash: (accountId: number, raw: string, valuedOn: string) => call<unknown>('setCash', accountId, raw, valuedOn),
  pickImportFile: () => call<string | null>('pickImportFile'),
  previewImport: (accountId: number, filePath: string, sheetName?: string) =>
    call<unknown>('previewImport', accountId, filePath, sheetName),
  confirmImport: (accountId: number, filePath: string, sheetName?: string) =>
    call<unknown>('confirmImport', accountId, filePath, sheetName),
  cancelBatch: (batchId: number) => call<number>('cancelBatch', batchId),
  unpointed: (accountId: number | null) => call<unknown>('unpointed', accountId),
  previewOperationTransfer: (operationId: number, counterpartyAccountId: number) =>
    call<unknown>('previewOperationTransfer', operationId, counterpartyAccountId),
  previewSavingsTransfer: (toAccountId: number, date: string, amount: string) =>
    call<unknown>('previewSavingsTransfer', toAccountId, date, amount),
  pointOperation: (operationId: number, categoryId: number, counterpartyAccountId: number | null, matchedOperationId: number | null) =>
    call<unknown>('pointOperation', operationId, categoryId, counterpartyAccountId, matchedOperationId),
  createSavingsMovement: (accountId: number, date: string, label: string, amount: string, direction: 'entree' | 'sortie') =>
    call<unknown>('createSavingsMovement', accountId, date, label, amount, direction),
  createTransfer: (fromAccountId: number, toAccountId: number, date: string, amount: string, matchedOperationId: number | null) =>
    call<unknown>('createTransfer', fromAccountId, toAccountId, date, amount, matchedOperationId),
  deleteTransfer: (transferId: number) => call<unknown>('deleteTransfer', transferId),
  unpointOperation: (operationId: number) => call<unknown>('unpointOperation', operationId),
  updateManualOperation: (operationId: number, date: string, label: string, amount: string) =>
    call<unknown>('updateManualOperation', operationId, date, label, amount),
  deleteManualOperation: (operationId: number) => call<unknown>('deleteManualOperation', operationId),
}

contextBridge.exposeInMainWorld('comptes', comptes)

export type ComptesApi = typeof comptes
