import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { assertDatabase, createDatabase, openDatabase } from './db.ts'
import { dateToIso } from './dates.ts'
import { LedgerError } from './errors.ts'
import {
  accountFigures,
  accountSummary,
  cancelBatch,
  centsFromInput,
  confirmImport,
  createAccount,
  createCategory,
  createFamily,
  globalSummary,
  listAccounts,
  listBatches,
  listFamilies,
  listOperations,
  listUnpointed,
  moveCategory,
  moveFamily,
  pointOperation,
  previewImport,
  setMonthlyBalance,
  updateAccount,
  updateCategory,
  updateFamily,
} from './ledger.ts'
import type { AccountKind, Mapping } from './types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

let database: DatabaseSync | null = null
let databasePath: string | null = null

type SaveAccount = {
  id?: number
  name: string
  bankName: string
  kind: AccountKind
  archived: boolean
  mapping: Mapping | null
  openingAmount: string
  openingDate: string
}

function configFile(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function readConfig(): { databasePath: string } | null {
  if (!existsSync(configFile())) return null
  const parsed = JSON.parse(readFileSync(configFile(), 'utf8')) as { databasePath?: string }
  if (!parsed.databasePath) return null
  return { databasePath: parsed.databasePath }
}

function remember(filePath: string, opened: DatabaseSync): void {
  database?.close()
  database = opened
  databasePath = filePath
  mkdirSync(path.dirname(configFile()), { recursive: true })
  writeFileSync(configFile(), JSON.stringify({ databasePath: filePath }, null, 2))
}

function restore(): void {
  const config = readConfig()
  if (!config) return
  try {
    assertDatabase(config.databasePath)
    remember(config.databasePath, openDatabase(config.databasePath))
  } catch {
    database?.close()
    database = null
    databasePath = null
  }
}

function ensureOpen(): void {
  if (database && databasePath) return
  const config = readConfig()
  if (!config) return
  assertDatabase(config.databasePath)
  database = openDatabase(config.databasePath)
  databasePath = config.databasePath
}

function requireDatabase(): DatabaseSync {
  try {
    ensureOpen()
  } catch (error) {
    database = null
    databasePath = null
    throw error
  }
  if (!database) throw new LedgerError('Aucune base ouverte.')
  return database
}

function status(): { state: 'setup' } | { state: 'error'; message: string } | { state: 'ready'; databasePath: string } {
  const config = readConfig()
  if (!config) return { state: 'setup' }
  try {
    ensureOpen()
  } catch (error) {
    database = null
    databasePath = null
    return { state: 'error', message: error instanceof Error ? error.message : 'La base ne s’ouvre pas.' }
  }
  if (!database || !databasePath) return { state: 'error', message: 'La base ne s’ouvre pas.' }
  return { state: 'ready', databasePath }
}

function workspace(year: number) {
  const db = requireDatabase()
  const asOf = dateToIso(new Date()) ?? '1970-01-01'
  return {
    year,
    databasePath,
    accounts: listAccounts(db).map((account) => ({ ...account, ...accountFigures(db, account, asOf) })),
    families: listFamilies(db),
    global: globalSummary(db, year),
  }
}

function accountDetail(id: number, year: number) {
  const db = requireDatabase()
  return {
    account: listAccounts(db).find((account) => account.id === id) ?? null,
    summary: accountSummary(db, id, year),
    operations: listOperations(db, id, year),
    batches: listBatches(db, id),
  }
}

function saveAccount(input: SaveAccount) {
  const db = requireDatabase()
  const openingCents = input.kind === 'releve' ? centsFromInput(input.openingAmount) : null
  const openingDate = input.kind === 'releve' && input.openingDate ? input.openingDate : null
  if (input.id) {
    return updateAccount(db, input.id, {
      name: input.name,
      bankName: input.bankName,
      archived: input.archived,
      mapping: input.kind === 'releve' ? input.mapping : null,
      openingCents,
      openingDate,
    })
  }
  return createAccount(db, {
    name: input.name,
    bankName: input.bankName,
    kind: input.kind,
    mapping: input.mapping,
    openingCents,
    openingDate,
  })
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, data: await fn(...args) }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : 'Erreur.' }
    }
  })
}

function register(): void {
  handle('status', () => status())
  handle('createDefault', () => {
    const filePath = path.join(app.getPath('userData'), 'comptes.sqlite')
    if (existsSync(filePath)) throw new LedgerError('Une base existe déjà sur ce Mac. Ouvre-la.')
    remember(filePath, createDatabase(filePath))
    return filePath
  })
  handle('createAt', async () => {
    const choice = await dialog.showSaveDialog({
      title: 'Nouvelle base',
      defaultPath: 'comptes.sqlite',
      filters: [{ name: 'Base Comptes', extensions: ['sqlite'] }],
    })
    if (choice.canceled || !choice.filePath) return null
    remember(choice.filePath, createDatabase(choice.filePath))
    return choice.filePath
  })
  handle('openAt', async () => {
    const choice = await dialog.showOpenDialog({
      title: 'Ouvrir une base',
      filters: [{ name: 'Base Comptes', extensions: ['sqlite'] }],
      properties: ['openFile'],
    })
    if (choice.canceled || !choice.filePaths[0]) return null
    const filePath = choice.filePaths[0]
    assertDatabase(filePath)
    remember(filePath, openDatabase(filePath))
    return filePath
  })
  handle('exportCopy', async () => {
    if (!database || !databasePath) throw new LedgerError('Aucune base ouverte.')
    const choice = await dialog.showSaveDialog({
      title: 'Exporter une copie',
      defaultPath: 'comptes-copie.sqlite',
      filters: [{ name: 'Base Comptes', extensions: ['sqlite'] }],
    })
    if (choice.canceled || !choice.filePath) return null
    copyFileSync(databasePath, choice.filePath)
    return choice.filePath
  })
  handle('workspace', (year) => workspace(Number(year)))
  handle('accountDetail', (id, year) => accountDetail(Number(id), Number(year)))
  handle('saveAccount', (input) => saveAccount(input as SaveAccount))
  handle('saveFamily', (input) => {
    const value = input as { id?: number; name: string; nature: 'depense' | 'encaissement'; archived: boolean }
    const db = requireDatabase()
    if (value.id) return updateFamily(db, value.id, { name: value.name, archived: value.archived })
    return createFamily(db, { name: value.name, nature: value.nature })
  })
  handle('moveFamily', (id, direction) => moveFamily(requireDatabase(), Number(id), direction as -1 | 1))
  handle('saveCategory', (input) => {
    const value = input as { id?: number; name: string; familyId: number; archived: boolean }
    const db = requireDatabase()
    if (value.id) return updateCategory(db, value.id, { name: value.name, archived: value.archived })
    return createCategory(db, { name: value.name, familyId: value.familyId })
  })
  handle('moveCategory', (id, direction) => moveCategory(requireDatabase(), Number(id), direction as -1 | 1))
  handle('setMonthlyBalance', (accountId, month, raw) => {
    setMonthlyBalance(requireDatabase(), Number(accountId), String(month), centsFromInput(String(raw)))
  })
  handle('pickImportFile', async () => {
    const choice = await dialog.showOpenDialog({
      title: 'Importer un relevé',
      filters: [{ name: 'Relevé', extensions: ['csv', 'txt', 'xlsx', 'xlsm'] }],
      properties: ['openFile'],
    })
    if (choice.canceled || !choice.filePaths[0]) return null
    return choice.filePaths[0]
  })
  handle('previewImport', (accountId, filePath, sheetName) =>
    previewImport(requireDatabase(), Number(accountId), String(filePath), sheetName ? String(sheetName) : undefined),
  )
  handle('confirmImport', (accountId, filePath, sheetName) =>
    confirmImport(requireDatabase(), Number(accountId), String(filePath), sheetName ? String(sheetName) : undefined),
  )
  handle('cancelBatch', (batchId) => cancelBatch(requireDatabase(), Number(batchId)))
  handle('unpointed', (accountId) => listUnpointed(requireDatabase(), accountId === null ? null : Number(accountId)))
  handle('pointOperation', (operationId, categoryId) =>
    pointOperation(requireDatabase(), Number(operationId), Number(categoryId)),
  )
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: 'Comptes',
    backgroundColor: '#f3efe6',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void window.loadFile(path.join(here, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  restore()
  register()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  database?.close()
  database = null
})
