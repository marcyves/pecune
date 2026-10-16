import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { assertDatabase, createDatabase, openDatabase } from '../src/db.ts'
import { LedgerError } from '../src/errors.ts'
import {
  accountFigures,
  accountSummary,
  cancelBatch,
  confirmImport,
  createAccount,
  createCategory,
  createFamily,
  globalSummary,
  listOperations,
  listUnpointed,
  operationCount,
  pointOperation,
  previewImport,
  setMonthlyBalance,
  updateAccount,
  updateCategory,
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
})

describe('règles du classeur', () => {
  it('archive un compte sans perdre ses opérations', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'releve',
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

  it('importe, ignore le second fichier, et annule le lot', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'releve',
      mapping: signed,
    })
    const split = createAccount(database, {
      name: 'BPER',
      bankName: 'BPER',
      kind: 'releve',
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
      kind: 'releve',
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

  it('suggère par mot-clé quand le libellé change autour du commerçant', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'releve',
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
      kind: 'releve',
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
    expect(before.kind).toBe('releve')
    if (before.kind !== 'releve') return
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
    if (open.kind !== 'releve') return
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
    if (summary.kind !== 'releve') return
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
    const livret = createAccount(database, { name: 'Livret A', bankName: 'Banque Postale', kind: 'solde' })
    setMonthlyBalance(database, livret.id, '2025-12', 50000)
    setMonthlyBalance(database, livret.id, '2026-01', 40000)
    setMonthlyBalance(database, livret.id, '2026-03', 45000)
    const summary = accountSummary(database, livret.id, 2026)
    if (summary.kind !== 'solde') throw new Error('kind')
    expect(summary.expense[0]).toBe(10000)
    expect(summary.income[0]).toBe(0)
    expect(summary.expense[1]).toBeNull()
    expect(summary.balances[1]).toBeNull()
    expect(summary.expense[2]).toBeNull()
    expect(summary.balances[2]).toBe(45000)
    setMonthlyBalance(database, livret.id, '2026-02', 40000)
    const filled = accountSummary(database, livret.id, 2026)
    if (filled.kind !== 'solde') throw new Error('kind')
    expect(filled.expense[2]).toBe(0)
    expect(filled.income[2]).toBe(5000)
    setMonthlyBalance(database, livret.id, '2026-02', 40000)
    const flat = accountSummary(database, livret.id, 2026)
    if (flat.kind !== 'solde') throw new Error('kind')
    expect(flat.expense[1]).toBe(0)
    expect(flat.income[1]).toBe(0)
  })

  it('ajoute les banques dans le tableau global et compte un virement des deux côtés', async () => {
    const { database, dir } = tempDatabase()
    const ccp = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'releve',
      mapping: signed,
      openingCents: 200000,
      openingDate: '2026-01-01',
    })
    const livret = createAccount(database, { name: 'Livret A', bankName: 'Banque Postale', kind: 'solde' })
    const file = csv(dir, 'a.csv', 'Date;Libelle;Montant\n10/01/2026;VIREMENT;-100,00\n')
    await confirmImport(database, ccp.id, file)
    setMonthlyBalance(database, livret.id, '2025-12', 50000)
    setMonthlyBalance(database, livret.id, '2026-01', 60000)
    const global = globalSummary(database, 2026)
    expect(global.banks).toHaveLength(1)
    expect(global.banks[0].accounts.map((account) => account.accountName)).toEqual(['CCP', 'Livret A'])
    expect(global.banks[0].expense[0]).toBe(10000)
    expect(global.banks[0].income[0]).toBe(10000)
    expect(global.expense[0]).toBe(10000)
    expect(global.banks[0].accounts[0].balance[0]).toBe(190000)
    expect(global.banks[0].accounts[1].balance[0]).toBe(60000)
    expect(global.balance[0]).toBe(250000)
    const lonely = createAccount(database, { name: 'Courant', bankName: 'BPER', kind: 'solde' })
    setMonthlyBalance(database, lonely.id, '2026-02', 1000)
    const withGap = globalSummary(database, 2026)
    const bper = withGap.banks.find((bank) => bank.bankName === 'BPER')
    expect(bper?.expense[0]).toBe(0)
    expect(bper?.balance[0]).toBe(0)
    expect(bper?.balance[1]).toBe(1000)
    expect(withGap.banks.find((bank) => bank.bankName === 'Banque Postale')?.expense[0]).toBe(10000)
  })

  it('calcule le solde courant et le solde non pointé', async () => {
    const { database, dir } = tempDatabase()
    const account = createAccount(database, {
      name: 'CCP',
      bankName: 'Banque Postale',
      kind: 'releve',
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

    expect(accountFigures(database, account, '2026-02-15')).toEqual({ currentCents: 108250, unpointedCents: 9500 })
    expect(accountFigures(database, account, '2025-12-15')).toEqual({ currentCents: null, unpointedCents: 0 })

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

    const livret = createAccount(database, { name: 'Livret A', bankName: 'Banque Postale', kind: 'solde' })
    setMonthlyBalance(database, livret.id, '2025-12', 50000)
    setMonthlyBalance(database, livret.id, '2026-03', 45000)
    expect(accountFigures(database, livret, '2026-02-10')).toEqual({ currentCents: 50000, unpointedCents: null })
    expect(accountFigures(database, livret, '2026-03-02').currentCents).toBe(45000)
    expect(accountFigures(database, livret, '2025-11-01').currentCents).toBeNull()
  })
})
