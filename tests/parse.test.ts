import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { parseDate } from '../src/dates.ts'
import { parseAmount } from '../src/money.ts'
import { classifyImport, readTabularFile } from '../src/parse-file.ts'
import type { Mapping } from '../src/types.ts'

const signed: Mapping = {
  mode: 'signe',
  dateHeader: 'Date',
  labelHeader: 'Libelle',
  amountHeader: 'Montant',
  dateFormat: 'JJ/MM/AAAA',
  decimalSeparator: ',',
}

const split: Mapping = {
  mode: 'debit-credit',
  dateHeader: 'Date',
  labelHeader: 'Libelle',
  debitHeader: 'Debit',
  creditHeader: 'Credit',
  dateFormat: 'JJ/MM/AAAA',
  decimalSeparator: ',',
}

describe('montants et dates', () => {
  it('lit un montant signé, un débit et un crédit', () => {
    expect(parseAmount('-12,50', ',')).toBe(-1250)
    expect(parseAmount('1.234,56', ',')).toBe(123456)
    expect(parseAmount('1 234,56', ',')).toBe(123456)
    expect(parseAmount('12.50', '.')).toBe(1250)
    expect(parseAmount('0,00', ',')).toBe(0)
    expect(parseAmount('abc', ',')).toBeNull()
    expect(parseDate('15/01/2026', 'JJ/MM/AAAA')).toBe('2026-01-15')
    expect(parseDate('31/02/2026', 'JJ/MM/AAAA')).toBeNull()
  })
})

describe('fichier', () => {
  it('classe un csv signé et un couple débit crédit vers le même montant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comptes-parse-'))
    const csv = join(dir, 'releve.csv')
    writeFileSync(
      csv,
      'Date;Libelle;Montant\n15/01/2026;AUCHAN;-12,50\n15/01/2026;AUCHAN;-12,50\n16/01/2026;SALAIRE;2.000,00\n',
    )
    const table = await readTabularFile(csv)
    const classified = classifyImport({
      headers: table.headers,
      rows: table.rows,
      mapping: signed,
      existing: new Map(),
      openingDate: '2026-01-01',
    })
    expect('lines' in classified).toBe(true)
    if (!('lines' in classified)) return
    expect(classified.lines.map((line) => line.amountCents)).toEqual([-1250, -1250, 200000])
    expect(classified.lines.every((line) => line.status === 'ready')).toBe(true)

    const again = classifyImport({
      headers: table.headers,
      rows: table.rows,
      mapping: signed,
      existing: new Map([['2026-01-15\tAUCHAN\t-1250', 1]]),
      openingDate: '2026-01-01',
    })
    if (!('lines' in again)) throw new Error('missing')
    expect(again.lines.filter((line) => line.date === '2026-01-15').map((line) => line.status)).toEqual([
      'duplicate',
      'ready',
    ])
  })

  it('rejette les lignes illisibles et signale un en-tête manquant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comptes-parse-'))
    const csv = join(dir, 'releve.csv')
    writeFileSync(
      csv,
      'Date;Libelle;Debit;Credit\n15/01/2026;AUCHAN;12,50;\n15/01/2026;SALAIRE;;2000,00\n32/01/2026;X;1,00;\n15/01/2026;Y;1,00;2,00\n15/01/2026;Z;0;\n01/12/2025;AVANT;5,00;\n',
    )
    const table = await readTabularFile(csv)
    const classified = classifyImport({
      headers: table.headers,
      rows: table.rows,
      mapping: split,
      existing: new Map(),
      openingDate: '2026-01-01',
    })
    if (!('lines' in classified)) throw new Error('missing')
    expect(classified.lines.find((line) => line.label === 'AUCHAN')?.amountCents).toBe(-1250)
    expect(classified.lines.find((line) => line.label === 'SALAIRE')?.amountCents).toBe(200000)
    expect(classified.lines.find((line) => line.line === 4)?.reason).toBe('Date illisible')
    expect(classified.lines.find((line) => line.label === 'Y')?.reason).toMatch(/Débit et crédit/)
    expect(classified.lines.find((line) => line.label === 'Z')?.reason).toBe('Montant nul')
    expect(classified.lines.find((line) => line.label === 'AVANT')?.reason).toMatch(/ouverture/)

    const blocked = classifyImport({
      headers: ['Date', 'Libelle'],
      rows: [],
      mapping: signed,
      existing: new Map(),
      openingDate: null,
    })
    expect('missing' in blocked && blocked.missing).toEqual(['Montant'])
  })

  it('lit un classeur Excel et demande la feuille quand il y en a plusieurs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'comptes-xlsx-'))
    const file = join(dir, 'releve.xlsx')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('CCP')
    workbook.addWorksheet('Autre')
    sheet.addRow(['Date', 'Libelle', 'Montant'])
    sheet.addRow([new Date(2026, 0, 15), 'AUCHAN', -12.5])
    await workbook.xlsx.writeFile(file)
    const choice = await readTabularFile(file)
    expect(choice.sheets).toEqual(['CCP', 'Autre'])
    const table = await readTabularFile(file, 'CCP')
    const classified = classifyImport({
      headers: table.headers,
      rows: table.rows,
      mapping: signed,
      existing: new Map(),
      openingDate: null,
    })
    if (!('lines' in classified)) throw new Error('missing')
    expect(classified.lines[0]).toMatchObject({ status: 'ready', date: '2026-01-15', amountCents: -1250 })
    expect(readFileSync(file).length).toBeGreaterThan(0)
  })
})
