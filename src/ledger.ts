import { basename } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isoDate, lastDay, monthEntirelyBefore, todayIso } from './dates.ts'
import { LedgerError } from './errors.ts'
import { lineMillis, millisToCents, parseQuantity, parseUserAmount, parseUserMillis } from './money.ts'
import { classifyImport, operationKey, readTabularFile } from './parse-file.ts'
import { globalFromAccounts, statementSummary } from './summary.ts'
import type {
  Account,
  AccountKind,
  AccountSummary,
  BatchView,
  Category,
  DateFormat,
  Family,
  GlobalSummary,
  Mapping,
  Nature,
  OperationView,
  Position,
  Preview,
  TransferMatch,
  TransferView,
  UnpointedView,
} from './types.ts'


type Row = Record<string, unknown>

export function createAccount(
  database: DatabaseSync,
  input: {
    name: string
    bankName: string
    kind: AccountKind
    mapping?: Mapping | null
    openingCents?: number | null
    openingMillis?: number | null
    openingDate?: string | null
  },
): Account {
  const name = requiredName(input.name, 'Le nom du compte est requis.')
  const bankId = ensureBank(database, input.bankName)
  const mapping = normalizeMapping(input.mapping ?? null)
  if (input.kind !== 'courant' && input.kind !== 'epargne' && input.kind !== 'titre') throw new LedgerError('Type de compte inconnu.')
  const opening = openingForKind(input.kind, input.openingCents ?? null, input.openingMillis, input.openingDate ?? null)
  assertAccountName(database, name, bankId)
  const result = insert(
    database,
    'INSERT INTO accounts (name, bank_id, kind, mapping_json, opening_cents, opening_millis, opening_date, cash_millis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      name,
      bankId,
      input.kind,
      input.kind === 'courant' && mapping ? JSON.stringify(mapping) : null,
      opening.cents,
      opening.millis,
      opening.date,
      input.kind === 'titre' ? 0 : null,
    ],
  )
  return getAccount(database, result)
}

export function updateAccount(
  database: DatabaseSync,
  id: number,
  input: {
    name: string
    bankName: string
    archived: boolean
    mapping: Mapping | null
    openingCents: number | null
    openingMillis?: number | null
    openingDate: string | null
  },
): Account {
  const current = getAccount(database, id)
  const name = requiredName(input.name, 'Le nom du compte est requis.')
  const bankId = ensureBank(database, input.bankName)
  const mapping = normalizeMapping(input.mapping)
  const opening = openingForKind(current.kind, input.openingCents, input.openingMillis, input.openingDate)
  assertAccountName(database, name, bankId, id)
  run(
    database,
    `UPDATE accounts
     SET name = ?, bank_id = ?, archived = ?, mapping_json = ?, opening_cents = ?, opening_millis = ?, opening_date = ?
     WHERE id = ?`,
    [
      name,
      bankId,
      input.archived ? 1 : 0,
      current.kind === 'courant' && mapping ? JSON.stringify(mapping) : null,
      opening.cents,
      opening.millis,
      opening.date,
      id,
    ],
  )
  deleteEmptyBanks(database)
  return getAccount(database, id)
}

export function listAccounts(database: DatabaseSync): Account[] {
  return all(database, `${accountSelect()} ORDER BY b.name, a.name`).map(mapAccount)
}

export function accountFigures(
  database: DatabaseSync,
  account: Account,
  asOf: string,
): { currentCents: number | null; unpointedCents: number | null; securitiesMillis: number | null } {
  if (account.kind === 'titre') {
    const securitiesMillis = securitiesBalance(database, account.id)
    const totalMillis = securitiesMillis + (account.cashMillis ?? 0)
    return { currentCents: millisToCents(totalMillis), unpointedCents: null, securitiesMillis }
  }
  if (account.kind === 'epargne') {
    const millis = savingsBalanceAsOf(database, account.id, asOf)
    return {
      currentCents: millis === null ? null : millisToCents(millis),
      unpointedCents: null,
      securitiesMillis: null,
    }
  }
  const unpointed = one(
    database,
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM operations WHERE account_id = ? AND category_id IS NULL AND date <= ?`,
    [account.id, asOf],
  )
  const unpointedCents = numberValue(unpointed?.total)
  if (account.openingCents === null || account.openingDate === null || asOf < account.openingDate) {
    return { currentCents: null, unpointedCents, securitiesMillis: null }
  }
  const moved = one(
    database,
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM operations WHERE account_id = ? AND date >= ? AND date <= ?`,
    [account.id, account.openingDate, asOf],
  )
  return { currentCents: account.openingCents + numberValue(moved?.total), unpointedCents, securitiesMillis: null }
}

export function getAccount(database: DatabaseSync, id: number): Account {
  const row = one(database, `${accountSelect()} WHERE a.id = ?`, [id])
  if (!row) throw new LedgerError('Compte introuvable.')
  return mapAccount(row)
}

export function deleteAccount(database: DatabaseSync, id: number): void {
  const account = getAccount(database, id)
  if (!account.archived) throw new LedgerError('Seul un compte archivé peut être effacé.')
  transaction(database, () => {
    detachTransfers(database, id)
    run(database, 'DELETE FROM operations WHERE account_id = ?', [id])
    run(database, 'DELETE FROM import_batches WHERE account_id = ?', [id])
    run(database, 'DELETE FROM monthly_balances WHERE account_id = ?', [id])
    run(database, 'DELETE FROM positions WHERE account_id = ?', [id])
    run(database, 'DELETE FROM accounts WHERE id = ?', [id])
    deleteEmptyBanks(database)
  })
}

export function createFamily(database: DatabaseSync, input: { name: string; nature: Nature }): Family {
  const name = requiredName(input.name, 'Le nom de la famille est requis.')
  if (input.nature !== 'depense' && input.nature !== 'encaissement') throw new LedgerError('Nature inconnue.')
  const order = nextOrder(database, 'SELECT COALESCE(MAX(sort_order), 0) AS value FROM families')
  const id = insert(database, 'INSERT INTO families (name, nature, sort_order) VALUES (?, ?, ?)', [name, input.nature, order])
  return familyById(database, id)
}

export function updateFamily(
  database: DatabaseSync,
  id: number,
  input: { name: string; archived: boolean },
): Family {
  familyById(database, id)
  const name = requiredName(input.name, 'Le nom de la famille est requis.')
  run(database, 'UPDATE families SET name = ?, archived = ? WHERE id = ?', [name, input.archived ? 1 : 0, id])
  return familyById(database, id)
}

export function moveFamily(database: DatabaseSync, id: number, direction: -1 | 1): void {
  const family = familyById(database, id)
  moveRow(database, 'families', id, direction, 'WHERE nature = ?', [family.nature])
}

export function createCategory(database: DatabaseSync, input: { name: string; familyId: number }): Category {
  familyById(database, input.familyId)
  const name = requiredName(input.name, 'Le nom de la catégorie est requis.')
  const order = nextOrder(
    database,
    'SELECT COALESCE(MAX(sort_order), 0) AS value FROM categories WHERE family_id = ?',
    [input.familyId],
  )
  const id = insert(database, 'INSERT INTO categories (family_id, name, sort_order) VALUES (?, ?, ?)', [
    input.familyId,
    name,
    order,
  ])
  return categoryById(database, id)
}

export function updateCategory(
  database: DatabaseSync,
  id: number,
  input: { name: string; archived: boolean; familyId?: number },
): Category {
  const category = categoryById(database, id)
  const name = requiredName(input.name, 'Le nom de la catégorie est requis.')
  const familyId = input.familyId ?? category.familyId
  if (familyId !== category.familyId) {
    const current = familyById(database, category.familyId)
    const next = familyById(database, familyId)
    if (next.nature !== current.nature) throw new LedgerError('La famille choisie n’a pas la même nature.')
    const order = nextOrder(
      database,
      'SELECT COALESCE(MAX(sort_order), 0) AS value FROM categories WHERE family_id = ?',
      [familyId],
    )
    run(database, 'UPDATE categories SET name = ?, archived = ?, family_id = ?, sort_order = ? WHERE id = ?', [
      name,
      input.archived ? 1 : 0,
      familyId,
      order,
      id,
    ])
  } else {
    run(database, 'UPDATE categories SET name = ?, archived = ? WHERE id = ?', [name, input.archived ? 1 : 0, id])
  }
  return categoryById(database, id)
}

export function moveCategory(database: DatabaseSync, id: number, direction: -1 | 1): void {
  const category = categoryById(database, id)
  moveRow(database, 'categories', id, direction, 'WHERE family_id = ?', [category.familyId])
}

export function listFamilies(database: DatabaseSync): Family[] {
  const families = all(database, 'SELECT * FROM families ORDER BY sort_order, id').map(mapFamily)
  const categories = all(database, 'SELECT * FROM categories ORDER BY sort_order, id').map(mapCategory)
  return families.map((family) => ({
    ...family,
    categories: categories.filter((category) => category.familyId === family.id),
  }))
}

export function setMonthlyBalance(
  database: DatabaseSync,
  accountId: number,
  month: string,
  amountCents: number | null,
): void {
  const account = getAccount(database, accountId)
  if (account.kind !== 'epargne') throw new LedgerError('Ce compte n’est pas un compte d’épargne.')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new LedgerError('Mois illisible.')
  if (amountCents === null) {
    run(database, 'DELETE FROM monthly_balances WHERE account_id = ? AND month = ?', [accountId, month])
    return
  }
  if (!Number.isInteger(amountCents)) throw new LedgerError('Montant illisible.')
  run(
    database,
    `INSERT INTO monthly_balances (account_id, month, amount_cents) VALUES (?, ?, ?)
     ON CONFLICT(account_id, month) DO UPDATE SET amount_cents = excluded.amount_cents`,
    [accountId, month, amountCents],
  )
}

export async function previewImport(
  database: DatabaseSync,
  accountId: number,
  filePath: string,
  sheetName?: string,
): Promise<Preview> {
  const account = getAccount(database, accountId)
  if (account.kind !== 'courant') return { status: 'error', message: 'Ce compte n’est pas un compte courant.' }
  if (!account.mapping) return { status: 'error', message: 'La correspondance des colonnes n’est pas définie.' }
  try {
    const table = await readTabularFile(filePath, sheetName)
    if (table.sheets && table.sheets.length > 1 && !sheetName) return { status: 'choose-sheet', sheets: table.sheets }
    const classified = classifyImport({
      headers: table.headers,
      rows: table.rows,
      mapping: account.mapping,
      existing: existingCounts(database, accountId),
      openingDate: account.openingDate,
    })
    if ('missing' in classified) {
      return { status: 'blocked', foundHeaders: table.headers.filter((header) => header !== ''), missing: classified.missing }
    }
    return {
      status: 'ok',
      lines: classified.lines,
      ready: classified.lines.filter((line) => line.status === 'ready').length,
      duplicate: classified.lines.filter((line) => line.status === 'duplicate').length,
      rejected: classified.lines.filter((line) => line.status === 'rejected').length,
    }
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Fichier illisible.' }
  }
}

export async function confirmImport(
  database: DatabaseSync,
  accountId: number,
  filePath: string,
  sheetName?: string,
): Promise<{ batchId: number; inserted: number }> {
  const preview = await previewImport(database, accountId, filePath, sheetName)
  if (preview.status === 'error') throw new LedgerError(preview.message)
  if (preview.status === 'choose-sheet') throw new LedgerError('Choisis une feuille.')
  if (preview.status === 'blocked') throw new LedgerError(`En-tête manquant : ${preview.missing.join(', ')}`)
  const ready = preview.lines.filter((line) => line.status === 'ready')
  if (ready.length === 0) throw new LedgerError('Aucune ligne à importer.')
  const batchId = transaction(database, () => {
    const id = insert(
      database,
      'INSERT INTO import_batches (account_id, imported_at, filename) VALUES (?, ?, ?)',
      [accountId, new Date().toISOString(), basename(filePath)],
    )
    for (const line of ready) {
      if (!line.date || line.amountCents === undefined) throw new LedgerError('Ligne incomplète.')
      insert(
        database,
        'INSERT INTO operations (account_id, batch_id, date, label, amount_cents) VALUES (?, ?, ?, ?, ?)',
        [accountId, id, line.date, line.label ?? '', line.amountCents],
      )
    }
    return id
  })
  return { batchId, inserted: ready.length }
}

export function listBatches(database: DatabaseSync, accountId: number): BatchView[] {
  return all(
    database,
    `SELECT b.id, b.filename, b.imported_at, COUNT(o.id) AS count
     FROM import_batches b
     LEFT JOIN operations o ON o.batch_id = b.id
     WHERE b.account_id = ?
     GROUP BY b.id
     ORDER BY b.id DESC`,
    [accountId],
  ).map((row) => ({
    id: numberValue(row.id),
    filename: String(row.filename),
    importedAt: String(row.imported_at),
    count: numberValue(row.count),
  }))
}

export function cancelBatch(database: DatabaseSync, batchId: number): number {
  const batch = one(database, 'SELECT id FROM import_batches WHERE id = ?', [batchId])
  if (!batch) throw new LedgerError('Import introuvable.')
  const count = numberValue((one(database, 'SELECT COUNT(*) AS count FROM operations WHERE batch_id = ?', [batchId]) as Row).count)
  transaction(database, () => {
    const rows = all(database, 'SELECT id FROM operations WHERE batch_id = ?', [batchId])
    for (const row of rows) detachOperation(database, numberValue(row.id))
    run(database, 'DELETE FROM operations WHERE batch_id = ?', [batchId])
    run(database, 'DELETE FROM import_batches WHERE id = ?', [batchId])
  })
  return count
}

export function listOperations(database: DatabaseSync, accountId: number, year: number): OperationView[] {
  return all(
    database,
    `SELECT o.id, o.date, o.label, o.amount_cents, o.category_id, c.name AS category_name,
            CASE
              WHEN t.id IS NULL THEN NULL
              WHEN t.from_account_id = o.account_id THEN t.to_account_id
              ELSE t.from_account_id
            END AS counterparty_id,
            CASE
              WHEN t.id IS NULL THEN NULL
              WHEN t.from_account_id = o.account_id THEN ta.name
              ELSE fa.name
            END AS counterparty_name,
            o.batch_id
     FROM operations o
     LEFT JOIN categories c ON c.id = o.category_id
     LEFT JOIN transfers t ON t.source_operation_id = o.id OR t.dest_operation_id = o.id
     LEFT JOIN accounts fa ON fa.id = t.from_account_id
     LEFT JOIN accounts ta ON ta.id = t.to_account_id
     WHERE o.account_id = ? AND o.date >= ? AND o.date <= ?
     ORDER BY o.date, o.id`,
    [accountId, `${year}-01-01`, `${year}-12-31`],
  ).map(mapOperation)
}

export function listUnpointed(database: DatabaseSync, accountId: number | null): UnpointedView[] {
  const keywords = learnKeywords(database)
  const rows = all(
    database,
    `SELECT o.id, o.account_id, a.name AS account_name, b.name AS bank_name, o.date, o.label, o.amount_cents
     FROM operations o
     JOIN accounts a ON a.id = o.account_id
     JOIN banks b ON b.id = a.bank_id
     WHERE o.category_id IS NULL AND a.archived = 0 AND a.kind = 'courant'
       AND (? IS NULL OR o.account_id = ?)
     ORDER BY o.date, o.id`,
    [accountId, accountId],
  )
  return rows.map((row) => {
    const amountCents = numberValue(row.amount_cents)
    return {
      id: numberValue(row.id),
      accountId: numberValue(row.account_id),
      accountName: String(row.account_name),
      bankName: String(row.bank_name),
      date: String(row.date),
      label: String(row.label),
      amountCents,
      suggestedCategoryId: suggestCategory(keywords, numberValue(row.account_id), String(row.label), amountCents),
    }
  })
}

export function previewOperationTransfer(
  database: DatabaseSync,
  operationId: number,
  counterpartyAccountId: number,
): TransferMatch[] {
  const operation = one(database, 'SELECT id, date, amount_cents FROM operations WHERE id = ?', [operationId])
  if (!operation) throw new LedgerError('Opération introuvable.')
  return matchingLines(
    database,
    counterpartyAccountId,
    String(operation.date),
    -numberValue(operation.amount_cents),
    numberValue(operation.id),
  )
}

export function previewSavingsTransfer(
  database: DatabaseSync,
  toAccountId: number,
  date: string,
  rawAmount: string,
): TransferMatch[] {
  const amount = centsFromInput(rawAmount)
  if (amount === null || amount <= 0) throw new LedgerError('Le montant du virement doit être positif.')
  return matchingLines(database, toAccountId, transferDate(date), amount, null)
}

export function pointOperation(
  database: DatabaseSync,
  operationId: number,
  categoryId: number,
  counterpartyAccountId: number | null = null,
  matchedOperationId: number | null = null,
): void {
  transaction(database, () => {
    const operation = one(
      database,
      'SELECT id, account_id, date, amount_cents FROM operations WHERE id = ?',
      [operationId],
    )
    if (!operation) throw new LedgerError('Opération introuvable.')
    if (one(database, 'SELECT id FROM transfers WHERE dest_operation_id = ?', [operationId])) {
      throw new LedgerError('Cette ligne vient d’un virement interne.')
    }
    const category = one(
      database,
      `SELECT c.archived AS category_archived, c.role, f.archived AS family_archived, f.nature
       FROM categories c JOIN families f ON f.id = c.family_id WHERE c.id = ?`,
      [categoryId],
    )
    if (!category) throw new LedgerError('Catégorie introuvable.')
    if (numberValue(category.category_archived) === 1 || numberValue(category.family_archived) === 1) {
      throw new LedgerError('Cette catégorie est archivée.')
    }
    const amount = numberValue(operation.amount_cents)
    const nature = amount < 0 ? 'depense' : 'encaissement'
    if (category.nature !== nature) {
      throw new LedgerError(
        nature === 'depense'
          ? 'Une dépense prend une catégorie de dépense.'
          : 'Un encaissement prend une catégorie d’encaissement.',
      )
    }
    detachOperation(database, operationId, matchedOperationId)
    if (category.role === 'virement') {
      if (counterpartyAccountId === null) throw new LedgerError('Choisis le compte du virement.')
      const sourceAccountId = numberValue(operation.account_id)
      const fromAccountId = amount < 0 ? sourceAccountId : counterpartyAccountId
      const toAccountId = amount < 0 ? counterpartyAccountId : sourceAccountId
      linkTransfer(database, {
        fromAccountId,
        toAccountId,
        date: String(operation.date),
        amountCents: Math.abs(amount),
        sourceOperationId: operationId,
        matchedOperationId,
      })
    }
    run(database, 'UPDATE operations SET category_id = ?, pointed_at = ? WHERE id = ?', [
      categoryId,
      new Date().toISOString(),
      operationId,
    ])
  })
}

export function createSavingsMovement(
  database: DatabaseSync,
  accountId: number,
  date: string,
  label: string,
  rawAmount: string,
  direction: 'entree' | 'sortie',
): void {
  const account = getAccount(database, accountId)
  if (account.kind !== 'epargne') throw new LedgerError('Ce compte n’est pas un compte d’épargne.')
  if (direction !== 'entree' && direction !== 'sortie') throw new LedgerError('Choisis une entrée ou une sortie.')
  const amount = millisFromOptional(rawAmount)
  if (amount === null || amount <= 0) throw new LedgerError('Le montant doit être positif.')
  const name = label.trim() || 'Mouvement'
  insert(
    database,
    'INSERT INTO operations (account_id, batch_id, date, label, amount_cents) VALUES (?, NULL, ?, ?, ?)',
    [accountId, transferDate(date), name, direction === 'sortie' ? -amount : amount],
  )
}

export function createSavingsTransfer(
  database: DatabaseSync,
  fromAccountId: number,
  toAccountId: number,
  date: string,
  rawAmount: string,
  matchedOperationId: number | null = null,
): void {
  const from = getAccount(database, fromAccountId)
  if (from.kind !== 'epargne') throw new LedgerError('Pour un compte courant, le virement se pointe sur l’opération.')
  const amount = centsFromInput(rawAmount)
  if (amount === null || amount <= 0) throw new LedgerError('Le montant du virement doit être positif.')
  transaction(database, () => {
    linkTransfer(database, {
      fromAccountId,
      toAccountId,
      date: transferDate(date),
      amountCents: amount,
      sourceOperationId: null,
      matchedOperationId,
    })
  })
}

export function unpointOperation(database: DatabaseSync, operationId: number): void {
  const operation = one(database, 'SELECT id FROM operations WHERE id = ?', [operationId])
  if (!operation) throw new LedgerError('Opération introuvable.')
  const transfer = one(
    database,
    'SELECT id FROM transfers WHERE source_operation_id = ? OR dest_operation_id = ?',
    [operationId, operationId],
  )
  if (transfer) {
    detachTransfer(database, numberValue(transfer.id), null)
    return
  }
  run(database, 'UPDATE operations SET category_id = NULL, pointed_at = NULL WHERE id = ?', [operationId])
}

export function updateManualOperation(
  database: DatabaseSync,
  operationId: number,
  date: string,
  label: string,
  rawAmount: string,
): void {
  const operation = manualOperation(database, operationId)
  const savings = operation.kind === 'epargne'
  const amount = savings ? millisFromOptional(rawAmount) : centsFromInput(rawAmount)
  if (amount === null || amount === 0) throw new LedgerError('Le montant est requis.')
  const nextDate = transferDate(date)
  const name = requiredName(label, 'Le libellé est requis.')
  const linked = one(
    database,
    'SELECT id FROM transfers WHERE source_operation_id = ? OR dest_operation_id = ?',
    [operationId, operationId],
  )
  if (linked && (nextDate !== String(operation.date) || amount !== numberValue(operation.amount_cents))) {
    throw new LedgerError('Pour changer le montant ou la date, ôte d’abord le pointage.')
  }
  run(database, 'UPDATE operations SET date = ?, label = ?, amount_cents = ? WHERE id = ?', [
    nextDate,
    name,
    amount,
    operationId,
  ])
}

export function deleteManualOperation(database: DatabaseSync, operationId: number): void {
  const operation = one(database, 'SELECT id, batch_id FROM operations WHERE id = ?', [operationId])
  if (!operation) throw new LedgerError('Opération introuvable.')
  if (operation.batch_id !== null) throw new LedgerError('Une ligne importée ne s’efface pas.')
  const transfer = one(
    database,
    'SELECT id FROM transfers WHERE source_operation_id = ? OR dest_operation_id = ?',
    [operationId, operationId],
  )
  if (transfer) {
    detachTransfer(database, numberValue(transfer.id), null)
    return
  }
  run(database, 'DELETE FROM operations WHERE id = ?', [operationId])
}

export function deleteTransfer(database: DatabaseSync, transferId: number): void {
  const transfer = one(database, 'SELECT id FROM transfers WHERE id = ?', [transferId])
  if (!transfer) throw new LedgerError('Virement introuvable.')
  detachTransfer(database, transferId, null)
}

export function listTransfers(database: DatabaseSync, accountId: number, year: number): TransferView[] {
  return all(
    database,
    `SELECT t.id, t.date, t.amount_cents,
            t.from_account_id, fa.name AS from_name, fb.name AS from_bank,
            t.to_account_id, ta.name AS to_name, tb.name AS to_bank
     FROM transfers t
     JOIN accounts fa ON fa.id = t.from_account_id
     JOIN banks fb ON fb.id = fa.bank_id
     JOIN accounts ta ON ta.id = t.to_account_id
     JOIN banks tb ON tb.id = ta.bank_id
     WHERE (t.from_account_id = ? OR t.to_account_id = ?)
       AND t.date >= ? AND t.date <= ?
     ORDER BY t.date, t.id`,
    [accountId, accountId, `${year}-01-01`, `${year}-12-31`],
  ).map((row) => ({
    id: numberValue(row.id),
    date: String(row.date),
    amountCents: numberValue(row.amount_cents),
    fromAccountId: numberValue(row.from_account_id),
    fromAccountName: String(row.from_name),
    fromBankName: String(row.from_bank),
    toAccountId: numberValue(row.to_account_id),
    toAccountName: String(row.to_name),
    toBankName: String(row.to_bank),
  }))
}

export function listPositions(database: DatabaseSync, accountId: number): Position[] {
  return all(database, 'SELECT * FROM positions WHERE account_id = ? ORDER BY sort_order, id', [accountId]).map(mapPosition)
}

export function savePosition(
  database: DatabaseSync,
  input: { accountId: number; id?: number; name: string; quantity: string; value: string; valuedOn: string },
): Position {
  const account = getAccount(database, input.accountId)
  if (account.kind !== 'titre') throw new LedgerError('Ce compte n’est pas un compte titre.')
  const name = requiredName(input.name, 'Le nom du titre est requis.')
  const quantity = parseQuantity(input.quantity)
  if (quantity === null) throw new LedgerError('Le nombre de titres est requis.')
  if (quantity === 'invalid') throw new LedgerError('Nombre illisible.')
  const value = millisFromInput(input.value)
  if (value < 0) throw new LedgerError('La valeur ne peut pas être négative.')
  const valuedOn = requiredValueDate(input.valuedOn)
  if (input.id) {
    const existing = one(database, 'SELECT id FROM positions WHERE id = ? AND account_id = ?', [input.id, input.accountId])
    if (!existing) throw new LedgerError('Titre introuvable.')
    run(database, 'UPDATE positions SET name = ?, quantity_micros = ?, value_millis = ?, valued_on = ? WHERE id = ?', [
      name,
      quantity,
      value,
      valuedOn,
      input.id,
    ])
    return positionById(database, input.id)
  }
  const order = nextOrder(
    database,
    'SELECT COALESCE(MAX(sort_order), 0) AS value FROM positions WHERE account_id = ?',
    [input.accountId],
  )
  const id = insert(
    database,
    'INSERT INTO positions (account_id, name, quantity_micros, value_millis, valued_on, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [input.accountId, name, quantity, value, valuedOn, order],
  )
  return positionById(database, id)
}

export function setCash(database: DatabaseSync, accountId: number, raw: string, valuedOn: string): void {
  const account = getAccount(database, accountId)
  if (account.kind !== 'titre') throw new LedgerError('Ce compte n’est pas un compte titre.')
  const value = raw.trim() === '' ? 0 : millisFromInput(raw)
  run(database, 'UPDATE accounts SET cash_millis = ?, cash_valued_on = ? WHERE id = ?', [
    value,
    requiredValueDate(valuedOn),
    accountId,
  ])
}

export function deletePosition(database: DatabaseSync, id: number): void {
  const existing = one(database, 'SELECT id FROM positions WHERE id = ?', [id])
  if (!existing) throw new LedgerError('Titre introuvable.')
  run(database, 'DELETE FROM positions WHERE id = ?', [id])
}

export function accountSummary(database: DatabaseSync, accountId: number, year: number): AccountSummary {
  const account = getAccount(database, accountId)
  if (account.kind === 'titre') {
    const positions = listPositions(database, accountId)
    const securitiesMillis = positions.reduce(
      (sum, position) => sum + lineMillis(position.quantityMicros, position.valueMillis),
      0,
    )
    const cashMillis = account.cashMillis ?? 0
    return {
      kind: 'titre',
      year,
      positions,
      securitiesMillis,
      cashMillis,
      cashValuedOn: account.cashValuedOn,
      totalMillis: securitiesMillis + cashMillis,
    }
  }
  if (account.kind === 'epargne') {
    return { kind: 'epargne', year, ...savingsFigures(database, accountId, year) }
  }
  const operations = all(
    database,
    'SELECT date, amount_cents, category_id FROM operations WHERE account_id = ?',
    [accountId],
  ).map((row) => ({
    date: String(row.date),
    amountCents: numberValue(row.amount_cents),
    categoryId: row.category_id === null ? null : numberValue(row.category_id),
  }))
  return statementSummary({
    year,
    openingCents: account.openingCents,
    openingDate: account.openingDate,
    families: listFamilies(database),
    operations,
  })
}

export function globalSummary(database: DatabaseSync, year: number): GlobalSummary {
  const accounts = listAccounts(database).filter((account) => !account.archived)
  return globalFromAccounts(
    year,
    accounts.map((account) => {
      const summary = accountSummary(database, account.id, year)
      const empty = (): (number | null)[] => Array.from({ length: 12 }, () => null)
      const row = {
        accountId: account.id,
        accountName: account.name,
        bankId: account.bankId,
        bankName: account.bankName,
        kind: account.kind,
      }
      if (summary.kind === 'titre') {
        const balance = empty()
        const now = new Date()
        if (year === now.getFullYear()) balance[now.getMonth()] = millisToCents(summary.totalMillis)
        return { ...row, expense: empty(), income: empty(), balance }
      }
      if (summary.kind === 'epargne') {
        return {
          ...row,
          expense: summary.expense.map(displayedSavingsTotal),
          income: summary.income.map(displayedSavingsTotal),
          balance: summary.balances.map((value) => (value === null ? null : millisToCents(value))),
        }
      }
      return { ...row, expense: summary.expenseTotals, income: summary.incomeTotals, balance: summary.balances }
    }),
  )
}

export function operationCount(database: DatabaseSync, accountId?: number): number {
  const row = accountId
    ? one(database, 'SELECT COUNT(*) AS count FROM operations WHERE account_id = ?', [accountId])
    : one(database, 'SELECT COUNT(*) AS count FROM operations')
  return numberValue((row as Row).count)
}

const LABEL_STOPWORDS = new Set([
  'ACHAT', 'ACHATS', 'AGIOS', 'APRES', 'AU', 'AUX', 'AUTRE', 'AUTRES', 'AVANT', 'AVEC', 'BANQUE', 'BIC',
  'CARTE', 'CB', 'CE', 'CES', 'CHEQUE', 'CHEQUES', 'CHEZ', 'CLIENT', 'COM', 'COMPTE', 'COTISATION',
  'COTISATIONS', 'COURANT', 'CPT', 'CREDIT', 'DAB', 'DANS', 'DATE', 'DE', 'DEBIT', 'DES', 'DONT', 'DU',
  'EN', 'ENTRE', 'EST', 'ET', 'EUR', 'EURO', 'EUROS', 'EURL', 'FACTURE', 'FACTURES', 'FRAIS', 'FRANCE',
  'HT', 'HTTP', 'HTTPS', 'IBAN', 'INFO', 'INFOS', 'INST', 'INSTANT', 'INTERET', 'INTERETS', 'LA', 'LE',
  'LES', 'LIB', 'LIBELLE', 'MLLE', 'MM', 'MME', 'MOINS', 'MONTANT', 'MOTIF', 'MR', 'MVT', 'MVTS', 'NET',
  'NON', 'NOS', 'NOTRE', 'NUM', 'NUMERO', 'OPE', 'OPERATION', 'OUI', 'PAR', 'PARIS', 'PAS', 'PAIEMENT',
  'PAIEMENTS', 'PLUS', 'POUR', 'PRELEVEMENT', 'PRELEVEMENTS', 'PRLV', 'QUE', 'QUI', 'REF', 'REFERENCE',
  'REFERENCES', 'REMB', 'REMBOURSEMENT', 'REMBOURSEMENTS', 'RETRAIT', 'RETRAITS', 'RIB', 'SA', 'SANS',
  'SARL', 'SAS', 'SCI', 'SEPA', 'SES', 'SOLDE', 'SON', 'SONT', 'SOUS', 'SUR', 'TIP', 'TOUT', 'TOUS',
  'TOUTE', 'TTC', 'TVA', 'UNE', 'VERS', 'VIR', 'VIREMENT', 'VIREMENTS', 'VOTRE', 'WWW',
])

type Keyword = { categoryId: number; count: number; nature: Nature }

function labelTokens(label: string): string[] {
  const normalized = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const token of normalized.split(' ')) {
    if (token.length < 3 || LABEL_STOPWORDS.has(token) || seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
  }
  return tokens
}

function learnKeywords(database: DatabaseSync): Map<number, Map<string, Keyword>> {
  const rows = all(
    database,
    `SELECT o.account_id, o.label, o.category_id, o.pointed_at, o.id,
            c.archived AS category_archived, f.archived AS family_archived, f.nature
     FROM operations o
     JOIN categories c ON c.id = o.category_id
     JOIN families f ON f.id = c.family_id
     WHERE o.category_id IS NOT NULL`,
  )
  const stats = new Map<number, Map<string, Map<number, { categoryId: number; count: number; last: string; nature: Nature; archived: boolean }>>>()
  for (const row of rows) {
    const accountId = numberValue(row.account_id)
    const categoryId = numberValue(row.category_id)
    const archived = numberValue(row.category_archived) === 1 || numberValue(row.family_archived) === 1
    const last = `${row.pointed_at ?? ''}|${String(row.id).padStart(8, '0')}`
    let byToken = stats.get(accountId)
    if (!byToken) {
      byToken = new Map()
      stats.set(accountId, byToken)
    }
    for (const token of labelTokens(String(row.label))) {
      let byCategory = byToken.get(token)
      if (!byCategory) {
        byCategory = new Map()
        byToken.set(token, byCategory)
      }
      const current = byCategory.get(categoryId)
      if (!current) {
        byCategory.set(categoryId, { categoryId, count: 1, last, nature: row.nature as Nature, archived })
      } else {
        current.count += 1
        if (last > current.last) current.last = last
      }
    }
  }

  const learned = new Map<number, Map<string, Keyword>>()
  for (const [accountId, byToken] of stats) {
    const keywords = new Map<string, Keyword>()
    for (const [token, byCategory] of byToken) {
      const active = [...byCategory.values()].filter((stat) => !stat.archived)
      if (active.length === 0) continue
      const best = active.reduce((lead, stat) => (stat.count > lead.count || (stat.count === lead.count && stat.last > lead.last) ? stat : lead))
      const rest = active.reduce((sum, stat) => sum + stat.count, 0) - best.count
      if (rest > 0 && best.count < rest * 2) continue
      keywords.set(token, { categoryId: best.categoryId, count: best.count, nature: best.nature })
    }
    learned.set(accountId, keywords)
  }
  return learned
}

function suggestCategory(
  learned: Map<number, Map<string, Keyword>>,
  accountId: number,
  label: string,
  amountCents: number,
): number | null {
  const keywords = learned.get(accountId)
  if (!keywords) return null
  const nature: Nature = amountCents < 0 ? 'depense' : 'encaissement'
  const scores = new Map<number, { keywords: number; weight: number }>()
  for (const token of labelTokens(label)) {
    const keyword = keywords.get(token)
    if (!keyword || keyword.nature !== nature) continue
    const score = scores.get(keyword.categoryId) ?? { keywords: 0, weight: 0 }
    score.keywords += 1
    score.weight += keyword.count
    scores.set(keyword.categoryId, score)
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].keywords - a[1].keywords || b[1].weight - a[1].weight)
  if (ranked.length === 0) return null
  if (ranked.length > 1 && ranked[0][1].keywords === ranked[1][1].keywords) return null
  return ranked[0][0]
}

function existingCounts(database: DatabaseSync, accountId: number): Map<string, number> {
  const rows = all(
    database,
    `SELECT date, label, amount_cents, COUNT(*) AS count
     FROM operations WHERE account_id = ?
     GROUP BY date, label, amount_cents`,
    [accountId],
  )
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = operationKey(String(row.date), String(row.label), numberValue(row.amount_cents))
    counts.set(key, (counts.get(key) ?? 0) + numberValue(row.count))
  }
  return counts
}

function linkTransfer(
  database: DatabaseSync,
  input: {
    fromAccountId: number
    toAccountId: number
    date: string
    amountCents: number
    sourceOperationId: number | null
    matchedOperationId: number | null
  },
): void {
  const ends = transferEnds(database, input.fromAccountId, input.toAccountId)
  const transferId = insert(
    database,
    `INSERT INTO transfers (from_account_id, to_account_id, date, amount_cents, source_operation_id)
     VALUES (?, ?, ?, ?, ?)`,
    [input.fromAccountId, input.toAccountId, input.date, input.amountCents, input.sourceOperationId],
  )
  const originId = operationAccount(database, input.sourceOperationId)
  const counterpart = [ends.from, ends.to].find((account) => account.kind === 'courant' && account.id !== originId)
  if (!counterpart) {
    if (input.matchedOperationId !== null) throw new LedgerError('Ce compte n’a pas de relevé.')
    return
  }
  const arriving = counterpart.id === input.toAccountId
  const other = arriving ? ends.from : ends.to
  const amount = arriving ? input.amountCents : -input.amountCents
  const operationId = input.matchedOperationId === null
    ? insertCounterpart(
        database,
        counterpart.id,
        input.date,
        arriving ? `Virement de ${other.name}` : `Virement vers ${other.name}`,
        amount,
      )
    : adoptMatch(database, input.matchedOperationId, counterpart.id, input.date, amount)
  run(database, 'UPDATE transfers SET dest_operation_id = ? WHERE id = ?', [operationId, transferId])
}

function adoptMatch(database: DatabaseSync, operationId: number, accountId: number, date: string, amountCents: number): number {
  const match = one(
    database,
    'SELECT id, account_id, date, amount_cents FROM operations WHERE id = ?',
    [operationId],
  )
  if (
    !match ||
    numberValue(match.account_id) !== accountId ||
    String(match.date) !== date ||
    numberValue(match.amount_cents) !== amountCents
  ) {
    throw new LedgerError('Cette ligne ne correspond pas au virement.')
  }
  const used = one(
    database,
    'SELECT id FROM transfers WHERE source_operation_id = ? OR dest_operation_id = ?',
    [operationId, operationId],
  )
  if (used) throw new LedgerError('Cette ligne est déjà liée à un virement.')
  const categoryId = virementCategoryId(database, amountCents < 0 ? 'depense' : 'encaissement')
  run(database, 'UPDATE operations SET category_id = ?, pointed_at = ? WHERE id = ?', [
    categoryId,
    new Date().toISOString(),
    operationId,
  ])
  return operationId
}

function matchingLines(
  database: DatabaseSync,
  accountId: number,
  date: string,
  amountCents: number,
  sourceOperationId: number | null,
): TransferMatch[] {
  const account = getAccount(database, accountId)
  if (account.kind !== 'courant') return []
  const keep = sourceOperationId ?? 0
  return all(
    database,
    `SELECT id, date, label, amount_cents FROM operations
     WHERE account_id = ? AND date = ? AND amount_cents = ?
       AND id NOT IN (
         SELECT source_operation_id FROM transfers
         WHERE source_operation_id IS NOT NULL AND source_operation_id != ?
         UNION
         SELECT dest_operation_id FROM transfers
         WHERE dest_operation_id IS NOT NULL AND (source_operation_id IS NULL OR source_operation_id != ?)
       )
     ORDER BY id`,
    [accountId, date, amountCents, keep, keep],
  ).map((row) => ({
    id: numberValue(row.id),
    date: String(row.date),
    label: String(row.label),
    amountCents: numberValue(row.amount_cents),
  }))
}

function manualOperation(database: DatabaseSync, operationId: number): Row {
  const operation = one(
    database,
    `SELECT o.id, o.date, o.amount_cents, o.batch_id, a.kind
     FROM operations o JOIN accounts a ON a.id = o.account_id WHERE o.id = ?`,
    [operationId],
  )
  if (!operation) throw new LedgerError('Opération introuvable.')
  if (operation.batch_id !== null) throw new LedgerError('Une ligne importée ne se modifie pas.')
  return operation
}

function transferDate(value: string): string {
  const text = value.trim()
  if (!text) return todayIso()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match || !isoDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new LedgerError('Date illisible.')
  }
  return text
}

function operationAccount(database: DatabaseSync, operationId: number | null): number | null {
  if (operationId === null) return null
  const row = one(database, 'SELECT account_id FROM operations WHERE id = ?', [operationId])
  return row ? numberValue(row.account_id) : null
}

function insertCounterpart(database: DatabaseSync, accountId: number, date: string, label: string, amountCents: number): number {
  const nature = amountCents < 0 ? 'depense' : 'encaissement'
  const categoryId = virementCategoryId(database, nature)
  return insert(
    database,
    `INSERT INTO operations (account_id, batch_id, date, label, amount_cents, category_id, pointed_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    [accountId, date, label, amountCents, categoryId, new Date().toISOString()],
  )
}

function virementCategoryId(database: DatabaseSync, nature: Nature): number {
  const row = one(
    database,
    `SELECT c.id FROM categories c
     JOIN families f ON f.id = c.family_id
     WHERE c.role = 'virement' AND f.nature = ? AND c.archived = 0 AND f.archived = 0`,
    [nature],
  )
  if (!row) throw new LedgerError('La catégorie Virement est introuvable.')
  return numberValue(row.id)
}

function transferEnds(database: DatabaseSync, fromAccountId: number, toAccountId: number): { from: Account; to: Account } {
  if (fromAccountId === toAccountId) throw new LedgerError('Choisis un autre compte.')
  const from = getAccount(database, fromAccountId)
  const to = getAccount(database, toAccountId)
  for (const account of [from, to]) {
    if (account.archived) throw new LedgerError('Ce compte est archivé.')
    if (account.kind === 'titre') throw new LedgerError('Un virement interne va vers un compte courant ou une épargne.')
  }
  return { from, to }
}

function savingsFigures(database: DatabaseSync, accountId: number, year: number) {
  const account = getAccount(database, accountId)
  const rows = savingsFlows(database, accountId, `${year}-12-31`)
  const balances: (number | null)[] = []
  const expense: (number | null)[] = []
  const income: (number | null)[] = []
  const openingMillis = account.openingMillis
  const openingDate = account.openingDate
  const hasOpening = openingMillis !== null && openingDate !== null
  for (let month = 1; month <= 12; month += 1) {
    const end = lastDay(year, month)
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
    const closed = hasOpening && monthEntirelyBefore(year, month, openingDate)
    let incoming = 0
    let outgoing = 0
    let net = 0
    if (!closed) {
      for (const row of rows) {
        if (hasOpening && row.date >= openingDate && row.date <= end) net += row.signed
        if (row.date >= monthStart && row.date <= end && (!hasOpening || row.date >= openingDate)) {
          if (row.signed > 0) incoming += row.signed
          if (row.signed < 0) outgoing += -row.signed
        }
      }
    }
    balances.push(!hasOpening || closed ? null : openingMillis + net)
    expense.push(outgoing > 0 ? outgoing : null)
    income.push(incoming > 0 ? incoming : null)
  }
  return {
    balances,
    entered: Array.from({ length: 12 }, () => null),
    expense,
    income,
  }
}

function savingsBalanceAsOf(database: DatabaseSync, accountId: number, asOf: string): number | null {
  const account = getAccount(database, accountId)
  if (account.openingMillis === null || account.openingDate === null || asOf < account.openingDate) return null
  let net = 0
  for (const row of savingsFlows(database, accountId, asOf)) {
    if (row.date < account.openingDate || row.date > asOf) continue
    net += row.signed
  }
  return account.openingMillis + net
}

function savingsFlows(database: DatabaseSync, accountId: number, until: string): { date: string; signed: number }[] {
  const flows = savingsTransfers(database, accountId, until).map((row) => {
    const amount = numberValue(row.amount_cents) * 10
    let signed = 0
    if (numberValue(row.to_account_id) === accountId) signed += amount
    if (numberValue(row.from_account_id) === accountId) signed -= amount
    return { date: String(row.date), signed }
  })
  for (const row of all(
    database,
    'SELECT date, amount_cents FROM operations WHERE account_id = ? AND date <= ?',
    [accountId, until],
  )) {
    flows.push({ date: String(row.date), signed: numberValue(row.amount_cents) })
  }
  return flows
}

function savingsTransfers(database: DatabaseSync, accountId: number, until: string): Row[] {
  return all(
    database,
    `SELECT date, amount_cents, from_account_id, to_account_id FROM transfers
     WHERE (from_account_id = ? OR to_account_id = ?) AND date <= ?`,
    [accountId, accountId, until],
  )
}

function detachTransfers(database: DatabaseSync, accountId: number): void {
  const rows = all(
    database,
    'SELECT id FROM transfers WHERE from_account_id = ? OR to_account_id = ?',
    [accountId, accountId],
  )
  for (const row of rows) detachTransfer(database, numberValue(row.id), accountId)
}

function detachOperation(database: DatabaseSync, operationId: number, keepOperationId: number | null = null): void {
  const transfer = one(
    database,
    'SELECT id FROM transfers WHERE source_operation_id = ? OR dest_operation_id = ?',
    [operationId, operationId],
  )
  if (transfer) detachTransfer(database, numberValue(transfer.id), null, keepOperationId)
}

function detachTransfer(
  database: DatabaseSync,
  transferId: number,
  keepAccountId: number | null,
  keepOperationId: number | null = null,
): void {
  const transfer = one(
    database,
    'SELECT source_operation_id, dest_operation_id FROM transfers WHERE id = ?',
    [transferId],
  )
  if (!transfer) return
  const sourceId = transfer.source_operation_id === null ? null : numberValue(transfer.source_operation_id)
  const destId = transfer.dest_operation_id === null ? null : numberValue(transfer.dest_operation_id)
  run(database, 'DELETE FROM transfers WHERE id = ?', [transferId])
  if (destId !== null && destId !== keepOperationId) {
    const operation = one(database, 'SELECT account_id, batch_id FROM operations WHERE id = ?', [destId])
    if (operation && (keepAccountId === null || numberValue(operation.account_id) !== keepAccountId)) {
      if (operation.batch_id === null) run(database, 'DELETE FROM operations WHERE id = ?', [destId])
      else run(database, 'UPDATE operations SET category_id = NULL, pointed_at = NULL WHERE id = ?', [destId])
    }
  }
  if (sourceId !== null) {
    const operation = one(database, 'SELECT account_id FROM operations WHERE id = ?', [sourceId])
    if (operation && numberValue(operation.account_id) !== keepAccountId) {
      run(database, 'UPDATE operations SET category_id = NULL, pointed_at = NULL WHERE id = ?', [sourceId])
    }
  }
}

function assertAccountName(database: DatabaseSync, name: string, bankId: number, exceptId?: number): void {
  const existing = one(database, 'SELECT id FROM accounts WHERE name = ? AND bank_id = ? AND id != ?', [
    name,
    bankId,
    exceptId ?? 0,
  ])
  if (existing) throw new LedgerError('Ce compte existe déjà dans cette banque.')
}

function ensureBank(database: DatabaseSync, bankName: string): number {
  const name = requiredName(bankName, 'La banque est requise.')
  const existing = one(database, 'SELECT id FROM banks WHERE name = ?', [name])
  if (existing) return numberValue(existing.id)
  return insert(database, 'INSERT INTO banks (name) VALUES (?)', [name])
}

function deleteEmptyBanks(database: DatabaseSync): void {
  run(database, 'DELETE FROM banks WHERE id NOT IN (SELECT bank_id FROM accounts)')
}

function normalizeMapping(mapping: Mapping | null): Mapping | null {
  if (!mapping) return null
  const dateHeader = mapping.dateHeader?.trim() ?? ''
  const labelHeader = mapping.labelHeader?.trim() ?? ''
  const dateFormat = mapping.dateFormat
  const decimalSeparator = mapping.decimalSeparator
  if (!dateHeader || !labelHeader) throw new LedgerError('Les colonnes date et libellé sont requises.')
  if (!isDateFormat(dateFormat) || (decimalSeparator !== ',' && decimalSeparator !== '.')) {
    throw new LedgerError('Format de date ou séparateur illisible.')
  }
  if (mapping.mode === 'signe') {
    const amountHeader = mapping.amountHeader?.trim() ?? ''
    if (!amountHeader) throw new LedgerError('La colonne montant est requise.')
    return { mode: 'signe', dateHeader, labelHeader, dateFormat, decimalSeparator, amountHeader }
  }
  if (mapping.mode === 'debit-credit') {
    const debitHeader = mapping.debitHeader?.trim() ?? ''
    const creditHeader = mapping.creditHeader?.trim() ?? ''
    if (!debitHeader || !creditHeader) throw new LedgerError('Les colonnes débit et crédit sont requises.')
    return { mode: 'debit-credit', dateHeader, labelHeader, dateFormat, decimalSeparator, debitHeader, creditHeader }
  }
  throw new LedgerError('Mode de montant inconnu.')
}

function openingForKind(
  kind: AccountKind,
  cents: number | null,
  millis: number | null | undefined,
  date: string | null,
): { cents: number | null; millis: number | null; date: string | null } {
  if (kind === 'titre') return { cents: null, millis: null, date: null }
  const amount = kind === 'epargne' ? (millis !== undefined ? millis : cents === null ? null : cents * 10) : cents
  const opening = normalizeOpening(amount, date)
  if (kind === 'epargne') return { cents: null, millis: opening.cents, date: opening.date }
  return { cents: opening.cents, millis: null, date: opening.date }
}

function displayedSavingsTotal(millis: number | null): number | null {
  if (millis === null) return null
  const cents = millisToCents(millis)
  return cents === 0 ? null : cents
}

function millisFromOptional(raw: string): number | null {
  const parsed = parseUserMillis(raw)
  if (parsed === 'invalid') throw new LedgerError('Montant illisible.')
  return parsed
}

function normalizeOpening(cents: number | null, date: string | null): { cents: number | null; date: string | null } {
  if ((cents === null) !== (date === null || date === '')) {
    throw new LedgerError('Le solde d’ouverture demande un montant et une date.')
  }
  if (cents === null || date === null || date === '') return { cents: null, date: null }
  if (!Number.isInteger(cents)) throw new LedgerError('Solde d’ouverture illisible.')
  if (!isoDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))) || date.length !== 10) {
    throw new LedgerError('Date d’ouverture illisible.')
  }
  return { cents, date }
}

function requiredName(value: string, message: string): string {
  const name = value.trim()
  if (!name) throw new LedgerError(message)
  return name
}

function requiredValueDate(value: string): string {
  const text = value.trim()
  if (!text) return todayIso()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match || !isoDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new LedgerError('Date de valeur illisible.')
  }
  return text
}

function isDateFormat(value: string): value is DateFormat {
  return ['JJ/MM/AAAA', 'AAAA-MM-JJ', 'JJ-MM-AAAA', 'JJ.MM.AAAA'].includes(value)
}

function accountSelect(): string {
  return `SELECT a.id, a.name, a.bank_id, b.name AS bank_name, a.kind, a.archived,
            a.mapping_json, a.opening_cents, a.opening_millis, a.opening_date, a.cash_millis, a.cash_valued_on
     FROM accounts a JOIN banks b ON b.id = a.bank_id`
}

function accountKind(value: unknown): AccountKind {
  if (value === 'epargne' || value === 'titre') return value
  return 'courant'
}

function mapPosition(row: Row): Position {
  return {
    id: numberValue(row.id),
    accountId: numberValue(row.account_id),
    name: String(row.name),
    quantityMicros: numberValue(row.quantity_micros),
    valueMillis: numberValue(row.value_millis),
    valuedOn: row.valued_on === null ? null : String(row.valued_on),
  }
}

function positionById(database: DatabaseSync, id: number): Position {
  const row = one(database, 'SELECT * FROM positions WHERE id = ?', [id])
  if (!row) throw new LedgerError('Titre introuvable.')
  return mapPosition(row)
}

function mapAccount(row: Row): Account {
  return {
    id: numberValue(row.id),
    name: String(row.name),
    bankId: numberValue(row.bank_id),
    bankName: String(row.bank_name),
    kind: accountKind(row.kind),
    archived: numberValue(row.archived) === 1,
    mapping: row.mapping_json ? (JSON.parse(String(row.mapping_json)) as Mapping) : null,
    openingCents: row.opening_cents === null ? null : numberValue(row.opening_cents),
    openingMillis: row.opening_millis === null || row.opening_millis === undefined ? null : numberValue(row.opening_millis),
    openingDate: row.opening_date === null ? null : String(row.opening_date),
    cashMillis: row.cash_millis === null ? null : numberValue(row.cash_millis),
    cashValuedOn: row.cash_valued_on === null ? null : String(row.cash_valued_on),
  }
}

function mapFamily(row: Row): Family {
  return {
    id: numberValue(row.id),
    name: String(row.name),
    nature: row.nature === 'encaissement' ? 'encaissement' : 'depense',
    sortOrder: numberValue(row.sort_order),
    archived: numberValue(row.archived) === 1,
    categories: [],
  }
}

function mapCategory(row: Row): Category {
  return {
    id: numberValue(row.id),
    familyId: numberValue(row.family_id),
    name: String(row.name),
    sortOrder: numberValue(row.sort_order),
    archived: numberValue(row.archived) === 1,
    role: row.role === 'virement' ? 'virement' : null,
  }
}

function mapOperation(row: Row): OperationView {
  return {
    id: numberValue(row.id),
    date: String(row.date),
    label: String(row.label),
    amountCents: numberValue(row.amount_cents),
    categoryId: row.category_id === null ? null : numberValue(row.category_id),
    categoryName: row.category_name === null ? null : String(row.category_name),
    counterpartyAccountId: row.counterparty_id === null || row.counterparty_id === undefined ? null : numberValue(row.counterparty_id),
    counterpartyAccountName: row.counterparty_name === null || row.counterparty_name === undefined ? null : String(row.counterparty_name),
    imported: row.batch_id !== null && row.batch_id !== undefined,
  }
}

function familyById(database: DatabaseSync, id: number): Family {
  const families = listFamilies(database)
  const family = families.find((item) => item.id === id)
  if (!family) throw new LedgerError('Famille introuvable.')
  return family
}

function categoryById(database: DatabaseSync, id: number): Category {
  for (const family of listFamilies(database)) {
    const category = family.categories.find((item) => item.id === id)
    if (category) return category
  }
  throw new LedgerError('Catégorie introuvable.')
}

function nextOrder(database: DatabaseSync, sql: string, params: SQLInputValue[] = []): number {
  return numberValue((one(database, sql, params) as Row).value) + 1
}

function moveRow(
  database: DatabaseSync,
  table: 'families' | 'categories',
  id: number,
  direction: -1 | 1,
  filter: string,
  params: SQLInputValue[] = [],
): void {
  const rows = all(database, `SELECT id FROM ${table} ${filter} ORDER BY sort_order, id`, params)
  const index = rows.findIndex((row) => numberValue(row.id) === id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= rows.length) return
  const ordered = rows.map((row) => numberValue(row.id))
  const [moved] = ordered.splice(index, 1)
  ordered.splice(target, 0, moved)
  transaction(database, () => {
    ordered.forEach((rowId, position) => {
      run(database, `UPDATE ${table} SET sort_order = ? WHERE id = ?`, [position + 1, rowId])
    })
  })
}

function insert(database: DatabaseSync, sql: string, params: SQLInputValue[] = []): number {
  try {
    const result = database.prepare(sql).run(...params)
    return Number(result.lastInsertRowid)
  } catch (error) {
    throw translate(error)
  }
}

function run(database: DatabaseSync, sql: string, params: SQLInputValue[] = []): void {
  try {
    database.prepare(sql).run(...params)
  } catch (error) {
    throw translate(error)
  }
}

function one(database: DatabaseSync, sql: string, params: SQLInputValue[] = []): Row | undefined {
  return database.prepare(sql).get(...params) as Row | undefined
}

function all(database: DatabaseSync, sql: string, params: SQLInputValue[] = []): Row[] {
  return database.prepare(sql).all(...params) as Row[]
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN')
  try {
    const value = action()
    database.exec('COMMIT')
    return value
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function numberValue(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value !== '') return Number(value)
  throw new LedgerError('Valeur illisible.')
}

function translate(error: unknown): Error {
  if (error instanceof Error && error.message.includes('UNIQUE')) return new LedgerError('Ce nom est déjà utilisé.')
  return error instanceof Error ? error : new LedgerError('Opération impossible.')
}

export function centsFromInput(raw: string): number | null {
  const parsed = parseUserAmount(raw)
  if (parsed === 'invalid') throw new LedgerError('Montant illisible.')
  return parsed
}

function millisFromInput(raw: string): number {
  const parsed = parseUserMillis(raw)
  if (parsed === 'invalid') throw new LedgerError('Montant illisible.')
  if (parsed === null) throw new LedgerError('La valeur est requise.')
  return parsed
}

function securitiesBalance(database: DatabaseSync, accountId: number): number {
  return listPositions(database, accountId).reduce(
    (sum, position) => sum + lineMillis(position.quantityMicros, position.valueMillis),
    0,
  )
}

