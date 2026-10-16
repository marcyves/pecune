import { basename } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isoDate, monthKey } from './dates.ts'
import { LedgerError } from './errors.ts'
import { parseUserAmount } from './money.ts'
import { classifyImport, operationKey, readTabularFile } from './parse-file.ts'
import { balanceFigures, globalFromAccounts, statementSummary } from './summary.ts'
import type {
  Account,
  AccountSummary,
  BatchView,
  Category,
  DateFormat,
  Family,
  GlobalSummary,
  Mapping,
  Nature,
  OperationView,
  Preview,
  UnpointedView,
} from './types.ts'


type Row = Record<string, unknown>

export function createAccount(
  database: DatabaseSync,
  input: {
    name: string
    bankName: string
    kind: 'releve' | 'solde'
    mapping?: Mapping | null
    openingCents?: number | null
    openingDate?: string | null
  },
): Account {
  const name = requiredName(input.name, 'Le nom du compte est requis.')
  const bankId = ensureBank(database, input.bankName)
  const mapping = normalizeMapping(input.mapping ?? null)
  const opening = normalizeOpening(input.openingCents ?? null, input.openingDate ?? null)
  if (input.kind !== 'releve' && input.kind !== 'solde') throw new LedgerError('Type de compte inconnu.')
  const result = insert(database, 'INSERT INTO accounts (name, bank_id, kind, mapping_json, opening_cents, opening_date) VALUES (?, ?, ?, ?, ?, ?)', [
    name,
    bankId,
    input.kind,
    mapping ? JSON.stringify(mapping) : null,
    input.kind === 'releve' ? opening.cents : null,
    input.kind === 'releve' ? opening.date : null,
  ])
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
    openingDate: string | null
  },
): Account {
  const current = getAccount(database, id)
  const name = requiredName(input.name, 'Le nom du compte est requis.')
  const bankId = ensureBank(database, input.bankName)
  const mapping = normalizeMapping(input.mapping)
  const opening = normalizeOpening(input.openingCents, input.openingDate)
  run(
    database,
    `UPDATE accounts
     SET name = ?, bank_id = ?, archived = ?, mapping_json = ?, opening_cents = ?, opening_date = ?
     WHERE id = ?`,
    [
      name,
      bankId,
      input.archived ? 1 : 0,
      current.kind === 'releve' && mapping ? JSON.stringify(mapping) : null,
      current.kind === 'releve' ? opening.cents : null,
      current.kind === 'releve' ? opening.date : null,
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
): { currentCents: number | null; unpointedCents: number | null } {
  if (account.kind === 'solde') {
    const row = one(
      database,
      `SELECT amount_cents FROM monthly_balances
       WHERE account_id = ? AND month <= ?
       ORDER BY month DESC LIMIT 1`,
      [account.id, asOf.slice(0, 7)],
    )
    return { currentCents: row ? numberValue(row.amount_cents) : null, unpointedCents: null }
  }
  const unpointed = one(
    database,
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM operations WHERE account_id = ? AND category_id IS NULL AND date <= ?`,
    [account.id, asOf],
  )
  const unpointedCents = numberValue(unpointed?.total)
  if (account.openingCents === null || account.openingDate === null || asOf < account.openingDate) {
    return { currentCents: null, unpointedCents }
  }
  const moved = one(
    database,
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM operations WHERE account_id = ? AND date >= ? AND date <= ?`,
    [account.id, account.openingDate, asOf],
  )
  return { currentCents: account.openingCents + numberValue(moved?.total), unpointedCents }
}

export function getAccount(database: DatabaseSync, id: number): Account {
  const row = one(database, `${accountSelect()} WHERE a.id = ?`, [id])
  if (!row) throw new LedgerError('Compte introuvable.')
  return mapAccount(row)
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
  moveRow(database, 'families', id, direction, '')
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
  input: { name: string; archived: boolean },
): Category {
  categoryById(database, id)
  const name = requiredName(input.name, 'Le nom de la catégorie est requis.')
  run(database, 'UPDATE categories SET name = ?, archived = ? WHERE id = ?', [name, input.archived ? 1 : 0, id])
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
  if (account.kind !== 'solde') throw new LedgerError('Ce compte se met à jour par relevé.')
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
  if (account.kind !== 'releve') return { status: 'error', message: 'Ce compte n’a pas de relevé.' }
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
    run(database, 'DELETE FROM operations WHERE batch_id = ?', [batchId])
    run(database, 'DELETE FROM import_batches WHERE id = ?', [batchId])
  })
  return count
}

export function listOperations(database: DatabaseSync, accountId: number, year: number): OperationView[] {
  return all(
    database,
    `SELECT o.id, o.date, o.label, o.amount_cents, o.category_id, c.name AS category_name
     FROM operations o
     LEFT JOIN categories c ON c.id = o.category_id
     WHERE o.account_id = ? AND o.date >= ? AND o.date <= ?
     ORDER BY o.date, o.id`,
    [accountId, `${year}-01-01`, `${year}-12-31`],
  ).map(mapOperation)
}

export function listUnpointed(database: DatabaseSync, accountId: number | null): UnpointedView[] {
  const keywords = learnKeywords(database)
  const rows = all(
    database,
    `SELECT o.id, o.account_id, a.name AS account_name, o.date, o.label, o.amount_cents
     FROM operations o
     JOIN accounts a ON a.id = o.account_id
     WHERE o.category_id IS NULL AND a.archived = 0
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
      date: String(row.date),
      label: String(row.label),
      amountCents,
      suggestedCategoryId: suggestCategory(keywords, numberValue(row.account_id), String(row.label), amountCents),
    }
  })
}

export function pointOperation(database: DatabaseSync, operationId: number, categoryId: number): void {
  const operation = one(database, 'SELECT id, amount_cents FROM operations WHERE id = ?', [operationId])
  if (!operation) throw new LedgerError('Opération introuvable.')
  const category = one(
    database,
    `SELECT c.archived AS category_archived, f.archived AS family_archived, f.nature
     FROM categories c JOIN families f ON f.id = c.family_id WHERE c.id = ?`,
    [categoryId],
  )
  if (!category) throw new LedgerError('Catégorie introuvable.')
  if (numberValue(category.category_archived) === 1 || numberValue(category.family_archived) === 1) {
    throw new LedgerError('Cette catégorie est archivée.')
  }
  const nature = numberValue(operation.amount_cents) < 0 ? 'depense' : 'encaissement'
  if (category.nature !== nature) {
    throw new LedgerError(
      nature === 'depense'
        ? 'Une dépense prend une catégorie de dépense.'
        : 'Un encaissement prend une catégorie d’encaissement.',
    )
  }
  run(database, 'UPDATE operations SET category_id = ?, pointed_at = ? WHERE id = ?', [
    categoryId,
    new Date().toISOString(),
    operationId,
  ])
}

export function accountSummary(database: DatabaseSync, accountId: number, year: number): AccountSummary {
  const account = getAccount(database, accountId)
  if (account.kind === 'solde') return { kind: 'solde', year, ...balanceFigures(year, balanceMap(database, accountId, year)) }
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
      return {
        accountId: account.id,
        accountName: account.name,
        bankId: account.bankId,
        bankName: account.bankName,
        kind: account.kind,
        expense: summary.kind === 'releve' ? summary.expenseTotals : summary.expense,
        income: summary.kind === 'releve' ? summary.incomeTotals : summary.income,
        balance: summary.balances,
      }
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
    counts.set(operationKey(String(row.date), String(row.label), numberValue(row.amount_cents)), numberValue(row.count))
  }
  return counts
}

function balanceMap(database: DatabaseSync, accountId: number, year: number): Map<string, number> {
  const rows = all(
    database,
    'SELECT month, amount_cents FROM monthly_balances WHERE account_id = ? AND month >= ? AND month <= ?',
    [accountId, monthKey(year - 1, 12), monthKey(year, 12)],
  )
  const balances = new Map<string, number>()
  for (const row of rows) balances.set(String(row.month), numberValue(row.amount_cents))
  return balances
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

function isDateFormat(value: string): value is DateFormat {
  return ['JJ/MM/AAAA', 'AAAA-MM-JJ', 'JJ-MM-AAAA', 'JJ.MM.AAAA'].includes(value)
}

function accountSelect(): string {
  return `SELECT a.id, a.name, a.bank_id, b.name AS bank_name, a.kind, a.archived,
            a.mapping_json, a.opening_cents, a.opening_date
     FROM accounts a JOIN banks b ON b.id = a.bank_id`
}

function mapAccount(row: Row): Account {
  return {
    id: numberValue(row.id),
    name: String(row.name),
    bankId: numberValue(row.bank_id),
    bankName: String(row.bank_name),
    kind: row.kind === 'solde' ? 'solde' : 'releve',
    archived: numberValue(row.archived) === 1,
    mapping: row.mapping_json ? (JSON.parse(String(row.mapping_json)) as Mapping) : null,
    openingCents: row.opening_cents === null ? null : numberValue(row.opening_cents),
    openingDate: row.opening_date === null ? null : String(row.opening_date),
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
