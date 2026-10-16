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
  saveFamily: (input: unknown) => call<unknown>('saveFamily', input),
  moveFamily: (id: number, direction: -1 | 1) => call<unknown>('moveFamily', id, direction),
  saveCategory: (input: unknown) => call<unknown>('saveCategory', input),
  moveCategory: (id: number, direction: -1 | 1) => call<unknown>('moveCategory', id, direction),
  setMonthlyBalance: (accountId: number, month: string, raw: string) =>
    call<unknown>('setMonthlyBalance', accountId, month, raw),
  pickImportFile: () => call<string | null>('pickImportFile'),
  previewImport: (accountId: number, filePath: string, sheetName?: string) =>
    call<unknown>('previewImport', accountId, filePath, sheetName),
  confirmImport: (accountId: number, filePath: string, sheetName?: string) =>
    call<unknown>('confirmImport', accountId, filePath, sheetName),
  cancelBatch: (batchId: number) => call<number>('cancelBatch', batchId),
  unpointed: (accountId: number | null) => call<unknown>('unpointed', accountId),
  pointOperation: (operationId: number, categoryId: number) => call<unknown>('pointOperation', operationId, categoryId),
}

contextBridge.exposeInMainWorld('comptes', comptes)

export type ComptesApi = typeof comptes
