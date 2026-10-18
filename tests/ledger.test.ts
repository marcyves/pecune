import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { assertDatabase, createDatabase, openDatabase } from '../src/db.ts'
import { todayIso } from '../src/dates.ts'
import { lineMillis } from '../src/money.ts'
import { LedgerError } from '../src/errors.ts'
import {
  accountFigures,
  accountSummary,
  cancelBatch,
  confirmImport,
  createAccount,
  createCategory,
  createFamily,
  createSavingsMovement,
  createSavingsTransfer,
  deleteManualOperation,
  deleteTransfer,
  deleteAccount,
  deletePosition,
  globalSummary,
  listAccounts,
  listFamilies,
  listOperations,
  listUnpointed,
  operationCount,
  pointOperation,
  previewImport,
  previewOperationTransfer,
  previewSavingsTransfer,
  savePosition,
  setCash,
  setMonthlyBalance,
  unpointOperation,
  updateAccount,
  updateCategory,
  updateManualOperation,
} from '../src/ledger.ts'
import type { Mapping } from '../src/types.ts'

const signed: Mapping = {
  mode: 'signe',
  dateHeader: 'Date',
  labelHeader: 'Libelle',
  amountHeader: 'Montant',
  dateFormat: 'JJ/MM/AAAA',
  decimalSeparator: ',',
}

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases) database.close()
  databases.length = 0
})

function tempDatabase(): { database: DatabaseSync; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'comptes-db-'))
  const path = join(dir, 'comptes.sqlite')
  const database = createDatabase(path)
  databases.push(database)
  return { database, path, dir }
}

function csv(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

describe('base', () => {
  it('ne crée pas une base vide quand le fichier ne s’ouvre pas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comptes-bad-'))
    const missing = join(dir, 'absent.sqlite')
    expect(() => openDatabase(missing)).toThrow(/introuvable/)
    const bad = join(dir, 'mauvais.sqlite')
    writeFileSync(bad, 'pas une base')
    expect(() => assertDatabase(bad)).toThrow(/ne s’ouvre pas/)
    expect(readFileSync(bad).toString()).toBe('pas une base')
    expect(() => createDatabase(bad)).toThrow(/existe déjà/)
    expect(readFileSync(bad).toString()).toBe('pas une base')
  })

  it('migre une base ancienne et garde les comptes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comptes-v1-'))
    const path = join(dir, 'comptes.sqlite')
    const created = new DatabaseSync(path)
    created.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE banks (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        bank_id INTEGER NOT NULL REFERENCES banks(id),
        kind TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        mapping_json TEXT,
        opening_cents INTEGER,
        opening_date TEXT
      );
      CREATE TABLE import_batches (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        imported_at TEXT NOT NULL,
        filename TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO banks (name) VALUES ('Banque Postale');
      INSERT INTO accounts (name, bank_id, kind) VALUES ('CCP', 1, 'solde');
    `)
    created.close()
    const database = openDatabase(path)
    databases.push(database)
    const version = database.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }
    expect(version.value).toBe('8')
    const legacy = listAccounts(database).find((account) => account.bankName === 'Banque Postale')
    expect(legacy?.kind).toBe('epargne')
    expect(legacy?.cashMillis).toBeNull()
    const moved = createAccount(database, { name: 'CCP', bankName: 'BPER', kind: 'epargne' })
    expect(moved.bankName).toBe('BPER')
    const pea = createAccount(database, { name: 'PEA', bankName: 'Banque Postale', kind: 'titre' })
    expect(pea.kind).toBe('titre')
    expect(() => createAccount(database, { name: 'CCP', bankName: 'Banque Postale', kind: 'epargne' })).toThrow(
      /cette banque/,
    )
  })

  it('reprend le solde caché de décembre comme solde initial', () => {
    const { database, path } = tempDatabase()
    const livret = createAccount(database, { name: 'Livret A', bankName: 'Banque Postale', kind: 'epargne' })
    setMonthlyBalance(database, livret.id, '2025-12', 2342902)
    setMonthlyBalance(database, livret.id, '2026-01', 1238136)
    database.exec(`UPDATE meta SET value = '7'`)
    database.close()
    databases.pop()
    const opened = openDatabase(path)
    databases.push(opened)
    const account = listAccounts(opened).find((item) => item.id === livret.id)
    expect(account?.openingCents).toBe(2342902)
    expect(account?.openingDate).toBe('2026-01-01')
    const summary = accountSummary(opened, livret.id, 2026)
    if (summary.kind !== 'epargne') throw new Error('kind')
    expect(summary.balances[0]).toBe(2342902)
  })
})

describe('règles du classeur', () => {
  it('autorise le même nom dans deux banques', () => {
    const { database } = tempDatabase()
    createAccount(database, { name: 'CCP', bankName: 'Banque Postale', kind: 'epargne' })
    const other = createAccount(database, { name: 'CCP', bankName: 'BPER', kind: 'epargne' })
    expect(other.name).toBe('CCP')
    expect(other.bankName).toBe('BPER')
    expect(() => createAccount(database, { name: 'CCP', bankName: 'BPER', kind: 'courant' })).toThrow(/cette banque/)
  })

  it('enregistre les titres et leur valeur', () => {
    const { database } = tempDatabase()
    const account = createAccount(database, { name: 'PEA', bankName: 'Boursorama', kind: 'titre' })
    const first = savePosition(database, {
      accountId: account.id,
      name: 'Air Liquide',
      quantity: '12,5',
      value: '10,125',
      valuedOn: '2026-10-15',
    })
    expect(first.quantityMicros).toBe(12_500_000)
    expect(first.valueMillis).toBe(10_125)
    expect(lineMillis(first.quantityMicros, first.valueMillis)).toBe(126_563)
    expect(first.valuedOn).toBe('2026-10-15')
    savePosition(database, {
      accountId: account.id,
      id: first.id,
      name: 'Air Liquide',
      quantity: '10',
      value: '18',
      valuedOn: '2026-10-16',
    })
    savePosition(database, {
      accountId: account.id,
      name: 'Total',
      quantity: '3',
      value: '20,500',
      valuedOn: '2026-10-16',
    })
    const summary = accountSummary(database, account.id, 2026)
    expect(summary.kind).toBe('titre')
    if (summary.kind !== 'titre') return
    expect(summary.positions.map((position) => position.name)).toEqual(['Air Liquide', 'Total'])
    expect(summary.securitiesMillis).toBe(241_500)
    expect(summary.cashMillis).toBe(0)
    expect(summary.totalMillis).toBe(241_500)
    const figures = accountFigures(database, account, '2026-10-17')
    expect(figures.securitiesMillis).toBe(241_500)
    expect(figures.currentCents).toBe(24_150)
    expect(figures.unpointedCents).toBeNull()
    setCash(database, account.id, '50,00', '2026-10-16')
    const withCash = accountSummary(database, account.id, 2026)
    if (withCash.kind !== 'titre') return
    expect(withCash.cashMillis).toBe(50_000)
    expect(withCash.securitiesMillis).toBe(241_500)
    expect(withCash.cashValuedOn).toBe('2026-10-16')
    expect(withCash.totalMillis).toBe(291_500)
    const empty = createAccount(database, { name: 'Vide', bankName: 'Boursorama', kind: 'titre' })
    expect(accountFigures(database, empty, '2026-10-17').currentCents).toBe(0)
    expect(() => savePosition(database, { accountId: account.id, name: ' ', quantity: '1', value: '1', valuedOn: '2026-10-16' })).toThrow(/nom/)
    expect(() => savePosition(database, { accountId: account.id, name: 'X', quantity: '0', value: '1', valuedOn: '2026-10-16' })).toThrow(/Nombre/)
    expect(() => savePosition(database, { accountId: account.id, name: 'X', quantity: '1', value: '-1', valuedOn: '2026-10-16' })).toThrow(/négative/)
    const decimal = savePosition(database, {
      accountId: account.id,
      name: 'Décimal',
      quantity: '1',
      value: '12,50',
      valuedOn: '',
    })
    expect(decimal.valueMillis).toBe(12_500)
    expect(decimal.valuedOn).toBe(todayIso())
    const rounded = savePosition(database, {
      accountId: account.id,
      name: 'Cours',
      quantity: '1',
      value: '12,345',
      valuedOn: '2026-10-16',
    })
    expect(rounded.valueMillis).toBe(12_345)
    deletePosition(database, decimal.id)
    deletePosition(database, rounded.id)
    const releve = createAccount(database, {
      name: 'CCP',
      bankName: 'Boursorama',
      kind: 'courant',
      mapping: signed,
      openingCents: 0,
      openingDate: '2026-01-01',
    })
    expect(() => savePosition(database, { accountId: releve.id, name: 'X', quantity: '1', value: '1', valuedOn: '2026-10-16' })).toThrow(
      /compte titre/,
    )
    deletePosition(database, first.id)
    const after = accountSummary(database, account.id, 2026)
    if (after.kind === 'titre') {
      expect(after.positions.map((position) => position.name)).toEqual(['Total'])
      expect(after.securitiesMillis).toBe(61_500)
      expect(after.totalMillis).toBe(111_500)
    }
    const year = new Date().getFullYear()
    const global = globalSummary(database, year)
    const row = global.banks[0]?.accounts.find((item) => item.accountName === 'PEA')
    expect(row?.expense.every((value) => value === null)).toBe(true)
    expect(row?.income.every((value) => value === null)).toBe(true)
    expect(row?.balance[new Date().getMonth()]).toBe(11_150)
    expect(row?.balance.filter((_, index) => index !== new Date().getMonth()).every((value) => value === null)).toBe(true)
    const past = globalSummary(database, year - 1)
    const old = past.banks[0]?.accounts.find((item) => item.accountName === 'PEA')
    expect(old?.balance.every((value) => value === null)).toBe(true)
  })

  it('archive un compte sans perdre ses opérations', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    const file = csv(dir, 'a.csv', 'Date;Libelle;Montant\n10/01/2026;AUCHAN;-12,50\n')
    await confirmImport(database, account.id, file)
    updateAccount(database, account.id, {
      name: 'CCP joint',
      bankName: 'Banque Postale',
      archived: true,
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    expect(globalSummary(database, 2026).banks).toHaveLength(0)
    expect(operationCount(database, account.id)).toBe(1)
    updateAccount(database, account.id, {
      name: 'CCP joint',
      bankName: 'Banque Postale',
      archived: false,
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    expect(globalSummary(database, 2026).banks[0].accounts).toHaveLength(1)
  })

  it('efface un compte archivé et ce qu’il contient', async () => {
    const { database, dir } = tempDatabase()
    const kept = createAccount(database, { name: 'Livret', bankName: 'BPER', kind: 'epargne' })
    setMonthlyBalance(database, kept.id, '2026-03', 50000)
    const releve = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    const file = csv(dir, 'a.csv', 'Date;Libelle;Montant\n10/01/2026;AUCHAN;-12,50\n')
    await confirmImport(database, releve.id, file)
    const titres = createAccount(database, { name: 'PEA', bankName: 'Banque Postale', kind: 'titre' })
    savePosition(database, { accountId: titres.id, name: 'Total', quantity: '2', value: '100', valuedOn: '2026-10-16' })
    expect(() => deleteAccount(database, releve.id)).toThrow(/archivé/)
    updateAccount(database, releve.id, {
      name: 'CCP',
      bankName: 'Banque Postale',
      archived: true,
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    deleteAccount(database, releve.id)
    expect(operationCount(database)).toBe(0)
    expect(listAccounts(database).map((account) => account.name).sort()).toEqual(['Livret', 'PEA'])
    updateAccount(database, titres.id, {
      name: 'PEA',
      bankName: 'Banque Postale',
      archived: true,
      mapping: null,
      openingCents: null,
      openingDate: null,
    })
    deleteAccount(database, titres.id)
    const left = listAccounts(database)
    expect(left.map((account) => account.id)).toEqual([kept.id])
    const banks = database.prepare('SELECT name FROM banks').all() as { name: string }[]
    expect(banks.map((bank) => bank.name)).toEqual(['BPER'])
    const positions = database.prepare('SELECT COUNT(*) AS count FROM positions').get() as { count: number }
    const batches = database.prepare('SELECT COUNT(*) AS count FROM import_batches').get() as { count: number }
    expect(Number(positions.count)).toBe(0)
    expect(Number(batches.count)).toBe(0)
    expect(accountFigures(database, kept, '2026-10-17').currentCents).toBe(50000)
  })

  it('importe, ignore le second fichier, et annule le lot', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
    })
    const split = createAccount(database, {
      name: 'BPER',
      bankName: 'BPER',
      kind: 'courant',
      mapping: {
        mode: 'debit-credit',
        dateHeader: 'Date',
        labelHeader: 'Libelle',
        debitHeader: 'Debit',
        creditHeader: 'Credit',
        dateFormat: 'JJ/MM/AAAA',
        decimalSeparator: ',',
      },
    })
    const file = csv(dir, 'a.csv', 'Date;Libelle;Montant\n10/01/2026;AUCHAN;-12,50\n10/01/2026;AUCHAN;-12,50\n')
    const preview = await previewImport(database, account.id, file)
    expect(preview.status).toBe('ok')
    expect(operationCount(database)).toBe(0)
    if (preview.status !== 'ok') return
    expect(preview.ready).toBe(2)
    const imported = await confirmImport(database, account.id, file)
    expect(imported.inserted).toBe(2)
    await expect(confirmImport(database, account.id, file)).rejects.toThrow(/Aucune ligne/)
    expect(operationCount(database, account.id)).toBe(2)

    const other = csv(dir, 'b.csv', 'Date;Libelle;Debit;Credit\n10/01/2026;AUCHAN;12,50;\n')
    const second = await confirmImport(database, split.id, other)
    expect(listOperations(database, split.id, 2026)[0].amountCents).toBe(-1250)

    const spaced = csv(dir, 'espaces.csv', 'Date;Libelle;Montant\n10/01/2026;AUCHAN\u00a0;-12,50\n')
    await expect(confirmImport(database, account.id, spaced)).rejects.toThrow(/Aucune ligne/)

    const removed = cancelBatch(database, imported.batchId)
    expect(removed).toBe(2)
    expect(operationCount(database, account.id)).toBe(0)
    expect(second.inserted).toBe(1)
  })

  it('pointe, suggère le libellé, et refuse la mauvaise nature', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
    })
    const frais = createFamily(database, { name: 'Frais généraux', nature: 'depense' })
    const gains = createFamily(database, { name: 'Salaires', nature: 'encaissement' })
    const auchan = createCategory(database, { name: 'Courses', familyId: frais.id })
    const cafe = createCategory(database, { name: 'Café', familyId: frais.id })
    const salaire = createCategory(database, { name: 'Salaire', familyId: gains.id })
    const file = csv(dir, 'a.csv', 'Date;Libelle;Montant\n10/01/2026;AUCHAN;-10,00\n11/01/2026;AUCHAN;-4,00\n12/01/2026;PAIE;100,00\n')
    await confirmImport(database, account.id, file)
    const rows = listUnpointed(database, account.id)
    expect(rows[0].suggestedCategoryId).toBeNull()
    pointOperation(database, rows[0].id, auchan.id)
    const next = listUnpointed(database, null)
    expect(next.find((row) => row.label === 'AUCHAN')?.suggestedCategoryId).toBe(auchan.id)
    const paie = next.find((row) => row.label === 'PAIE')
    expect(() => pointOperation(database, paie!.id, auchan.id)).toThrow(LedgerError)
    pointOperation(database, paie!.id, salaire.id)
    const second = next.find((row) => row.label === 'AUCHAN')!
    pointOperation(database, second.id, cafe.id)
    expect(listOperations(database, account.id, 2026).find((row) => row.date === '2026-01-11')?.categoryName).toBe('Café')
    pointOperation(database, second.id, auchan.id)

    updateCategory(database, auchan.id, { name: 'Supermarché', archived: false })
    expect(listOperations(database, account.id, 2026).find((row) => row.date === '2026-01-10')?.categoryName).toBe(
      'Supermarché',
    )
    updateCategory(database, auchan.id, { name: 'Supermarché', archived: true })
    const fresh = csv(dir, 'c.csv', 'Date;Libelle;Montant\n13/01/2026;AUCHAN;-3,00\n')
    await confirmImport(database, account.id, fresh)
    expect(listUnpointed(database, account.id)[0].suggestedCategoryId).toBeNull()
    expect(listOperations(database, account.id, 2026).some((row) => row.categoryName === 'Supermarché')).toBe(true)
  })

  it('déplace une catégorie vers une autre famille de la même nature', () => {
    const { database } = tempDatabase()
    const courses = createFamily(database, { name: 'Courses', nature: 'depense' })
    const maison = createFamily(database, { name: 'Maison', nature: 'depense' })
    const salaires = createFamily(database, { name: 'Salaires', nature: 'encaissement' })
    const auchan = createCategory(database, { name: 'Auchan', familyId: courses.id })
    createCategory(database, { name: 'Loyer', familyId: maison.id })

    const moved = updateCategory(database, auchan.id, { name: 'Auchan', archived: false, familyId: maison.id })
    expect(moved.familyId).toBe(maison.id)
    expect(moved.sortOrder).toBe(2)
    const families = listFamilies(database)
    expect(families.find((family) => family.id === courses.id)?.categories).toEqual([])
    expect(families.find((family) => family.id === maison.id)?.categories.map((category) => category.name)).toEqual([
      'Loyer',
      'Auchan',
    ])
    expect(() => updateCategory(database, auchan.id, { name: 'Auchan', archived: false, familyId: salaires.id })).toThrow(
      LedgerError,
    )
  })

  it('suggère par mot-clé quand le libellé change autour du commerçant', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
    })
    const frais = createFamily(database, { name: 'Frais généraux', nature: 'depense' })
    const gains = createFamily(database, { name: 'Salaires', nature: 'encaissement' })
    const courses = createCategory(database, { name: 'Courses', familyId: frais.id })
    const cafe = createCategory(database, { name: 'Café', familyId: frais.id })
    const energie = createCategory(database, { name: 'Énergie', familyId: frais.id })
    const salaire = createCategory(database, { name: 'Salaire', familyId: gains.id })
    const file = csv(
      dir,
      'mots.csv',
      [
        'Date;Libelle;Montant',
        '10/01/2026;CARTE 12/01 AUCHAN MANDELIEU 12345;-20,00',
        '11/01/2026;CB AUCHAN NICE 998877;-8,00',
        '12/01/2026;PRLV SEPA EDF REF 111;-40,00',
        '13/01/2026;PRLV SEPA EDF CLIENT 222;-42,00',
        '14/01/2026;CARTE BOULANGERIE 444;-3,00',
        '15/01/2026;PAIEMENT AUCHAN MARKET 777;-6,00',
        '16/01/2026;VIR SALAIRE ENTREPRISE 555;1500,00',
        '17/01/2026;VIR SALAIRE ENTREPRISE 556;1500,00',
        '18/01/2026;AUCHAN REMBOURSEMENT 321;4,00',
      ].join('\n'),
    )
    await confirmImport(database, account.id, file)
    const rows = listUnpointed(database, account.id)
    const idOf = (label: string) => rows.find((row) => row.label === label)!.id
    pointOperation(database, idOf('CARTE 12/01 AUCHAN MANDELIEU 12345'), courses.id)
    pointOperation(database, idOf('PRLV SEPA EDF REF 111'), energie.id)
    pointOperation(database, idOf('VIR SALAIRE ENTREPRISE 555'), salaire.id)

    const suggested = () => {
      const next = listUnpointed(database, account.id)
      return (label: string) => next.find((row) => row.label === label)?.suggestedCategoryId
    }
    expect(suggested()('CB AUCHAN NICE 998877')).toBe(courses.id)
    expect(suggested()('PRLV SEPA EDF CLIENT 222')).toBe(energie.id)
    expect(suggested()('CARTE BOULANGERIE 444')).toBeNull()
    expect(suggested()('VIR SALAIRE ENTREPRISE 556')).toBe(salaire.id)
    expect(suggested()('AUCHAN REMBOURSEMENT 321')).toBeNull()

    pointOperation(database, idOf('PAIEMENT AUCHAN MARKET 777'), cafe.id)
    expect(suggested()('CB AUCHAN NICE 998877')).toBeNull()
  })

  it('calcule la synthèse d’un relevé et le report de solde', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
    })
    const frais = createFamily(database, { name: 'Frais généraux', nature: 'depense' })
    const courses = createCategory(database, { name: 'Courses', familyId: frais.id })
    const file = csv(
      dir,
      'a.csv',
      'Date;Libelle;Montant\n15/12/2025;ANCIEN;-50,00\n10/01/2026;AUCHAN;-12,50\n20/01/2026;INCONNU;-5,00\n05/02/2026;PAIE;100,00\n',
    )
    await confirmImport(database, account.id, file)
    const before = accountSummary(database, account.id, 2026)
    expect(before.kind).toBe('courant')
    if (before.kind !== 'courant') return
    expect(before.balanceMissing).toBe(true)
    expect(before.balances.every((value) => value === null)).toBe(true)
    expect(before.expenseTotals[0]).toBe(1750)
    expect(before.unpointedExpense[0]).toBe(1750)

    updateAccount(database, account.id, {
      name: 'CCP',
      bankName: 'Banque Postale',
      archived: false,
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-03-01',
    })
    const open = accountSummary(database, account.id, 2026)
    if (open.kind !== 'courant') return
    expect(open.expenseTotals[0]).toBe(0)
    expect(open.incomeTotals[1]).toBe(0)
    expect(open.balances[0]).toBeNull()
    expect(open.balances[1]).toBeNull()
    expect(open.balances[2]).toBe(100000)

    updateAccount(database, account.id, {
      name: 'CCP',
      bankName: 'Banque Postale',
      archived: false,
      mapping: signed,
      openingCents: 100000,
      openingDate: '2025-12-01',
    })
    const ops = listOperations(database, account.id, 2026)
    pointOperation(database, ops.find((row) => row.label === 'AUCHAN')!.id, courses.id)
    const summary = accountSummary(database, account.id, 2026)
    if (summary.kind !== 'courant') return
    expect(summary.expenseFamilies[0].categories[0].months[0]).toBe(-1250)
    expect(summary.expenseFamilies[0].months[0]).toBe(1250)
    expect(summary.unpointedExpense[0]).toBe(500)
    expect(summary.expenseTotals[0]).toBe(1750)
    expect(summary.incomeTotals[1]).toBe(10000)
    expect(summary.balances[0]).toBe(100000 - 5000 - 1750)
    expect(summary.balances[1]).toBe(100000 - 5000 - 1750 + 10000)
    expect(summary.expenseTotals[2]).toBe(0)
    expect(summary.balances[2]).toBe(summary.balances[1])
    expect(summary.expenseFamilies[0].categories[0].months[11]).toBe(0)
  })

  it('calcule les mouvements d’un compte solde', () => {
    const { database } = tempDatabase()
    const livret = createAccount(database, {
      name: 'Livret A',
      bankName: 'Banque Postale',
      kind: 'epargne',
      openingCents: 50000,
      openingDate: '2026-01-01',
    })
    const autre = createAccount(database, {
      name: 'Autre',
      bankName: 'BPER',
      kind: 'epargne',
      openingCents: 20000,
      openingDate: '2026-01-01',
    })
    createSavingsTransfer(database, livret.id, autre.id, '2026-01-15', '100,00')
    createSavingsTransfer(database, autre.id, livret.id, '2026-03-02', '50,00')
    const summary = accountSummary(database, livret.id, 2026)
    if (summary.kind !== 'epargne') throw new Error('kind')
    expect(summary.expense[0]).toBe(10000)
    expect(summary.income[0]).toBeNull()
    expect(summary.balances[0]).toBe(40000)
    expect(summary.balances[1]).toBe(40000)
    expect(summary.expense[1]).toBeNull()
    expect(summary.income[1]).toBeNull()
    expect(summary.expense[2]).toBeNull()
    expect(summary.income[2]).toBe(5000)
    expect(summary.balances[2]).toBe(45000)
    expect(summary.balances[11]).toBe(45000)
    createSavingsMovement(database, livret.id, '2026-06-15', 'Intérêts', '12,50', 'entree')
    createSavingsMovement(database, livret.id, '2026-06-20', 'Retrait', '100,00', 'sortie')
    const moved = accountSummary(database, livret.id, 2026)
    if (moved.kind !== 'epargne') throw new Error('kind')
    expect(moved.income[5]).toBe(1250)
    expect(moved.expense[5]).toBe(10000)
    expect(moved.balances[4]).toBe(45000)
    expect(moved.balances[5]).toBe(36250)
    expect(listUnpointed(database, null).some((row) => row.label === 'Intérêts')).toBe(false)
    expect(accountFigures(database, livret, '2026-06-16').currentCents).toBe(46250)
  })

  it('ajoute les banques dans le tableau global et compte un virement des deux côtés', async () => {
    const { database, dir } = tempDatabase()
    const ccp = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
      openingCents: 200000,
      openingDate: '2026-01-01',
    })
    const livret = createAccount(database, {
      name: 'Livret A',
      bankName: 'Banque Postale',
      kind: 'epargne',
      openingCents: 50000,
      openingDate: '2026-01-01',
    })
    const file = csv(dir, 'a.csv', 'Date;Libelle;Montant\n10/01/2026;VIREMENT;-100,00\n')
    await confirmImport(database, ccp.id, file)
    const virement = listOperations(database, ccp.id, 2026).find((row) => row.label === 'VIREMENT')
    pointOperation(database, virement!.id, outgoingCategory(database), livret.id)
    const global = globalSummary(database, 2026)
    expect(global.banks).toHaveLength(1)
    expect(global.banks[0].accounts.map((account) => account.accountName)).toEqual(['CCP', 'Livret A'])
    expect(global.banks[0].expense[0]).toBe(10000)
    expect(global.banks[0].income[0]).toBe(10000)
    expect(global.expense[0]).toBe(10000)
    expect(global.banks[0].accounts[0].balance[0]).toBe(190000)
    expect(global.banks[0].accounts[1].balance[0]).toBe(60000)
    expect(global.banks[0].accounts[1].balance[1]).toBe(60000)
    expect(global.balance[0]).toBe(250000)
    createAccount(database, {
      name: 'Courant',
      bankName: 'BPER',
      kind: 'epargne',
      openingCents: 1000,
      openingDate: '2026-02-01',
    })
    const withGap = globalSummary(database, 2026)
    const bper = withGap.banks.find((bank) => bank.bankName === 'BPER')
    expect(bper?.expense[0]).toBe(0)
    expect(bper?.balance[0]).toBe(0)
    expect(bper?.balance[1]).toBe(1000)
    expect(withGap.banks.find((bank) => bank.bankName === 'Banque Postale')?.expense[0]).toBe(10000)
  })

  it('montre les soldes épargne et titre sur le tableau global', () => {
    const { database } = tempDatabase()
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    createAccount(database, {
      name: 'Livret A',
      bankName: 'Banque Postale',
      kind: 'epargne',
      openingCents: 45000,
      openingDate: `${year}-01-01`,
    })
    const typedMonth = now.getMonth() === 2 ? 4 : 2
    const pea = createAccount(database, { name: 'PEA', bankName: 'Banque Postale', kind: 'titre' })
    savePosition(database, {
      accountId: pea.id,
      name: 'Air Liquide',
      quantity: '2',
      value: '10,125',
      valuedOn: `${year}-${month}-01`,
    })
    setCash(database, pea.id, '0,005', `${year}-${month}-01`)
    const global = globalSummary(database, year)
    const accounts = global.banks[0].accounts
    const savings = accounts.find((account) => account.accountName === 'Livret A')
    const securities = accounts.find((account) => account.accountName === 'PEA')
    expect(savings?.balance[typedMonth]).toBe(45000)
    expect(savings?.balance[now.getMonth()]).toBe(45000)
    expect(savings?.expense[typedMonth]).toBeNull()
    expect(securities?.expense.every((value) => value === null)).toBe(true)
    expect(securities?.income.every((value) => value === null)).toBe(true)
    expect(securities?.balance[now.getMonth()]).toBe(2026)
    expect(securities?.balance.filter((_, index) => index !== now.getMonth()).every((value) => value === null)).toBe(true)
    expect(globalSummary(database, year - 1).banks[0].accounts.find((account) => account.accountName === 'PEA')?.balance.every((value) => value === null)).toBe(true)
    if (typedMonth !== now.getMonth()) expect(global.balance[typedMonth]).toBe(45000)
  })

  it('calcule le solde courant et le solde non pointé', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    const frais = createFamily(database, { name: 'Frais généraux', nature: 'depense' })
    const courses = createCategory(database, { name: 'Courses', familyId: frais.id })
    const file = csv(
      dir,
      'soldes.csv',
      'Date;Libelle;Montant\n10/01/2026;AUCHAN;-12,50\n20/01/2026;INCONNU;-5,00\n05/02/2026;PAIE;100,00\n01/04/2026;FUTUR;-10,00\n',
    )
    await confirmImport(database, account.id, file)
    const pointed = listOperations(database, account.id, 2026).find((row) => row.label === 'AUCHAN')
    pointOperation(database, pointed!.id, courses.id)

    expect(accountFigures(database, account, '2026-02-15')).toEqual({
      currentCents: 108250,
      unpointedCents: 9500,
      securitiesMillis: null,
    })
    expect(accountFigures(database, account, '2025-12-15')).toEqual({
      currentCents: null,
      unpointedCents: 0,
      securitiesMillis: null,
    })

    const withoutOpening = updateAccount(database, account.id, {
      name: 'CCP',
      bankName: 'Banque Postale',
      archived: false,
      mapping: signed,
      openingCents: null,
      openingDate: null,
    })
    expect(accountFigures(database, withoutOpening, '2026-02-15').currentCents).toBeNull()
    expect(accountFigures(database, withoutOpening, '2026-02-15').unpointedCents).toBe(9500)

    const livret = createAccount(database, {
      name: 'Livret A',
      bankName: 'Banque Postale',
      kind: 'epargne',
      openingCents: 50000,
      openingDate: '2026-01-01',
    })
    expect(accountFigures(database, livret, '2026-02-10')).toEqual({
      currentCents: 50000,
      unpointedCents: null,
      securitiesMillis: null,
    })
    expect(accountFigures(database, livret, '2026-03-02').currentCents).toBe(50000)
    createSavingsTransfer(database, livret.id, account.id, '2026-03-10', '50,00')
    expect(accountFigures(database, livret, '2026-03-02').currentCents).toBe(50000)
    expect(accountFigures(database, livret, '2026-03-10').currentCents).toBe(45000)
    expect(accountFigures(database, livret, '2025-11-01').currentCents).toBeNull()
  })

  it('répercute un virement interne vers le compte destinataire', async () => {
    const { database, dir } = tempDatabase()
    const ccp = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    const livret = createAccount(database, { name: 'Livret A', bankName: 'Banque Postale', kind: 'epargne' })
    const autre = createAccount(database, {
      name: 'Joint',
      bankName: 'CCF',
      kind: 'courant',
      mapping: signed,
      openingCents: 0,
      openingDate: '2026-01-01',
    })
    const file = csv(dir, 'vir.csv', 'Date;Libelle;Montant\n10/03/2026;VIR LIVRET;-40,00\n15/03/2026;VIR RECU;25,00\n')
    await confirmImport(database, ccp.id, file)
    const outgoing = listOperations(database, ccp.id, 2026).find((row) => row.amountCents === -4000)
    const incoming = listOperations(database, ccp.id, 2026).find((row) => row.amountCents === 2500)
    const virement = outgoingCategory(database)
    const recu = incomingCategory(database)
    expect(() => pointOperation(database, outgoing!.id, virement)).toThrow(/compte du virement/)
    pointOperation(database, outgoing!.id, virement, livret.id)
    const savings = accountSummary(database, livret.id, 2026)
    if (savings.kind !== 'epargne') throw new Error('kind')
    expect(savings.income[2]).toBe(4000)
    expect(savings.expense[2]).toBeNull()
    pointOperation(database, incoming!.id, recu, autre.id)
    const mirrored = listOperations(database, autre.id, 2026)
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0].amountCents).toBe(-2500)
    expect(mirrored[0].label).toBe('Virement vers CCP')
    expect(mirrored[0].categoryId).toBe(virement)

    createSavingsTransfer(database, livret.id, ccp.id, '2026-04-02', '15,50')
    const back = listOperations(database, ccp.id, 2026).find((row) => row.label === 'Virement de Livret A')
    expect(back?.amountCents).toBe(1550)
    expect(back?.categoryName).toBe('Virement reçu')
    const after = accountSummary(database, livret.id, 2026)
    if (after.kind !== 'epargne') throw new Error('kind')
    expect(after.expense[3]).toBe(1550)
    const transfer = database
      .prepare('SELECT id FROM transfers WHERE from_account_id = ? AND amount_cents = ?')
      .get(livret.id, 1550) as { id: number }
    deleteTransfer(database, Number(transfer.id))
    expect(listOperations(database, ccp.id, 2026).some((row) => row.label === 'Virement de Livret A')).toBe(false)

    updateAccount(database, livret.id, {
      name: 'Livret A',
      bankName: 'Banque Postale',
      archived: false,
      mapping: null,
      openingCents: 100000,
      openingDate: '2026-09-01',
    })
    createSavingsTransfer(database, livret.id, ccp.id, '2026-10-02', '10,00')
    const moved = accountSummary(database, livret.id, 2026)
    if (moved.kind !== 'epargne') throw new Error('kind')
    expect(moved.balances[8]).toBe(100000)
    expect(moved.balances[9]).toBe(99000)
    expect(moved.expense[9]).toBe(1000)
    expect(moved.balances[10]).toBe(99000)
    expect(moved.balances[11]).toBe(99000)
    expect(accountFigures(database, livret, '2026-10-17').currentCents).toBe(99000)
  })

  it('relie un virement déjà présent au lieu d’en créer un second', async () => {
    const { database, dir } = tempDatabase()
    const ccp = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'courant',
      mapping: signed,
      openingCents: 100000,
      openingDate: '2026-01-01',
    })
    const joint = createAccount(database, {
      name: 'Joint',
      bankName: 'CCF',
      kind: 'courant',
      mapping: signed,
      openingCents: 0,
      openingDate: '2026-01-01',
    })
    const livret = createAccount(database, { name: 'Livret A', bankName: 'Banque Postale', kind: 'epargne' })
    await confirmImport(database, ccp.id, csv(dir, 'ccp.csv', 'Date;Libelle;Montant\n10/03/2026;VIR JOINT;-40,00\n'))
    await confirmImport(database, joint.id, csv(dir, 'joint.csv', 'Date;Libelle;Montant\n10/03/2026;VIR CCP;40,00\n12/03/2026;AUTRE;40,00\n'))
    const outgoing = listOperations(database, ccp.id, 2026)[0]
    const received = listOperations(database, joint.id, 2026).find((row) => row.date === '2026-03-10')
    const matches = previewOperationTransfer(database, outgoing.id, joint.id)
    expect(matches.map((row) => row.id)).toEqual([received!.id])
    pointOperation(database, outgoing.id, outgoingCategory(database), joint.id, received!.id)
    const linked = listOperations(database, joint.id, 2026)
    expect(linked).toHaveLength(2)
    expect(linked.find((row) => row.id === received!.id)?.categoryName).toBe('Virement reçu')
    expect(linked.every((row) => row.imported)).toBe(true)

    unpointOperation(database, outgoing.id)
    expect(listOperations(database, joint.id, 2026)).toHaveLength(2)
    expect(listOperations(database, joint.id, 2026).find((row) => row.id === received!.id)?.categoryId).toBeNull()
    expect(() => deleteManualOperation(database, received!.id)).toThrow(/importée/)

    pointOperation(database, outgoing.id, outgoingCategory(database), joint.id, null)
    const doubled = listOperations(database, joint.id, 2026)
    expect(doubled).toHaveLength(3)
    const created = doubled.find((row) => !row.imported)
    expect(created?.amountCents).toBe(4000)
    expect(created?.label).toBe('Virement de CCP')
    expect(() => updateManualOperation(database, created!.id, '2026-03-11', 'Virement corrigé', '40,00')).toThrow(/pointage/)
    updateManualOperation(database, created!.id, '2026-03-10', 'Virement corrigé', '40,00')
    expect(listOperations(database, joint.id, 2026).find((row) => row.id === created!.id)?.label).toBe('Virement corrigé')
    deleteManualOperation(database, created!.id)
    expect(listOperations(database, joint.id, 2026)).toHaveLength(2)
    expect(listOperations(database, ccp.id, 2026)[0].categoryId).toBeNull()

    const savingsMatch = previewSavingsTransfer(database, joint.id, '2026-03-10', '40,00')
    expect(savingsMatch.map((row) => row.id)).toEqual([received!.id])
    createSavingsTransfer(database, livret.id, joint.id, '2026-03-10', '40,00', received!.id)
    expect(listOperations(database, joint.id, 2026)).toHaveLength(2)
    expect(listOperations(database, joint.id, 2026).find((row) => row.id === received!.id)?.categoryName).toBe('Virement reçu')
  })
})

function outgoingCategory(database: DatabaseSync): number {
  const row = database
    .prepare(
      `SELECT c.id FROM categories c JOIN families f ON f.id = c.family_id
       WHERE c.role = 'virement' AND f.nature = 'depense'`,
    )
    .get() as { id: number }
  return Number(row.id)
}

function incomingCategory(database: DatabaseSync): number {
  const row = database
    .prepare(
      `SELECT c.id FROM categories c JOIN families f ON f.id = c.family_id
       WHERE c.role = 'virement' AND f.nature = 'encaissement'`,
    )
    .get() as { id: number }
  return Number(row.id)
}
