import { readFileSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { dateToIso, excelSerialToIso, parseDate } from './dates.ts'
import { parseAmount } from './money.ts'
import type { Mapping, PreviewLine } from './types.ts'

export type RawCell = { text: string; date?: string; number?: number }
export type RawRow = { line: number; cells: RawCell[] }

export type TableData = {
  sheets?: string[]
  headers: string[]
  rows: RawRow[]
}

export async function readTabularFile(filePath: string, sheetName?: string): Promise<TableData> {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return readCsvFile(filePath)
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readExcelFile(filePath, sheetName)
  throw new Error('Ce format de fichier n’est pas lu. Utilise un CSV ou un Excel xlsx.')
}

export function classifyImport(input: {
  headers: string[]
  rows: RawRow[]
  mapping: Mapping
  existing: Map<string, number>
  openingDate: string | null
}): { missing: string[] } | { lines: PreviewLine[] } {
  const headers = input.headers.map((header) => header.trim())
  const missing = requiredHeaders(input.mapping).filter((header) => !headers.includes(header))
  if (missing.length > 0) return { missing }

  const index = new Map(headers.map((header, position) => [header, position]))
  const accepted: { line: number; date: string; label: string; amountCents: number }[] = []
  const lines: PreviewLine[] = []

  for (const row of input.rows) {
    if (isBlank(row, index, input.mapping)) continue
    const outcome = readRow(row, index, input.mapping, input.openingDate)
    if (!outcome.ok) {
      lines.push({ line: row.line, status: 'rejected', reason: outcome.reason, ...outcome.partial })
      continue
    }
    accepted.push({ line: row.line, date: outcome.date, label: outcome.label, amountCents: outcome.amountCents })
  }

  const ranks = new Map<string, number>()
  for (const row of accepted) {
    const key = operationKey(row.date, row.label, row.amountCents)
    const rank = (ranks.get(key) ?? 0) + 1
    ranks.set(key, rank)
    const already = input.existing.get(key) ?? 0
    lines.push({
      line: row.line,
      status: already >= rank ? 'duplicate' : 'ready',
      date: row.date,
      label: row.label,
      amountCents: row.amountCents,
    })
  }
  lines.sort((a, b) => a.line - b.line)
  return { lines }
}

export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

export function operationKey(date: string, label: string, amountCents: number): string {
  return `${date}\t${normalizeLabel(label)}\t${amountCents}`
}

export function requiredHeaders(mapping: Mapping): string[] {
  if (mapping.mode === 'signe') return [mapping.dateHeader, mapping.labelHeader, mapping.amountHeader]
  return [mapping.dateHeader, mapping.labelHeader, mapping.debitHeader, mapping.creditHeader]
}

function readCsvFile(filePath: string): TableData {
  let buffer: Buffer
  try {
    buffer = readFileSync(filePath)
  } catch {
    throw new Error('Fichier illisible.')
  }
  const text = decodeCsv(buffer)
  const separator = chooseSeparator(text)
  const records = parseCsv(text, separator)
  if (records.length === 0) return { headers: [], rows: [] }
  return {
    headers: records[0].map((cell) => cell.trim()),
    rows: records.slice(1).map((cells, offset) => ({
      line: offset + 2,
      cells: cells.map((text) => ({ text })),
    })),
  }
}

function decodeCsv(buffer: Buffer): string {
  const bytes = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function chooseSeparator(text: string): string {
  let best = ';'
  let bestScore = -1
  for (const separator of [';', ',', '\t']) {
    const header = parseCsv(text, separator)[0] ?? []
    const filled = header.filter((cell) => cell.trim() !== '').length
    if (filled > bestScore) {
      best = separator
      bestScore = filled
    }
  }
  return best
}

export function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += char
    } else if (char === '"') quoted = true
    else if (char === separator) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function readExcelFile(filePath: string, sheetName?: string): Promise<TableData> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.readFile(filePath)
  } catch {
    throw new Error('Fichier illisible.')
  }
  const sheets = workbook.worksheets.map((sheet) => sheet.name)
  if (!sheetName && sheets.length > 1) return { sheets, headers: [], rows: [] }
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]
  if (!sheet) throw new Error('Cette feuille est introuvable.')
  let headers: string[] = []
  const rows: RawRow[] = []
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = readRowCells(row)
    if (rowNumber === 1) {
      headers = cells.map((cell) => cell.text.trim())
      return
    }
    rows.push({ line: rowNumber, cells })
  })
  return { sheets, headers, rows }
}

function readRowCells(row: ExcelJS.Row): RawCell[] {
  const count = Math.max(row.cellCount, row.actualCellCount)
  const cells: RawCell[] = []
  for (let column = 1; column <= count; column += 1) cells.push(readCell(row.getCell(column).value))
  return cells
}

function readCell(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) return { text: '' }
  if (value instanceof Date) {
    const date = dateToIso(value) ?? undefined
    return { text: date ?? '', date }
  }
  if (typeof value === 'number') return { text: String(value), number: value }
  if (typeof value === 'string') return { text: value }
  if (typeof value === 'boolean') return { text: '' }
  if (typeof value === 'object') {
    if ('result' in value) return readCell(value.result as ExcelJS.CellValue)
    if ('richText' in value && Array.isArray(value.richText)) {
      return { text: value.richText.map((part) => part.text).join('') }
    }
    if ('text' in value && typeof value.text === 'string') return { text: value.text }
  }
  return { text: '' }
}

function isBlank(row: RawRow, index: Map<string, number>, mapping: Mapping): boolean {
  return rawFields(row, index, mapping).every((cell) => cell.text.trim() === '' && cell.number === undefined && !cell.date)
}

function readRow(
  row: RawRow,
  index: Map<string, number>,
  mapping: Mapping,
  openingDate: string | null,
):
  | { ok: false; reason: string; partial: Partial<PreviewLine> }
  | { ok: true; date: string; label: string; amountCents: number } {
  const dateCell = field(row, index, mapping.dateHeader)
  const label = normalizeLabel(field(row, index, mapping.labelHeader).text)
  const date = resolveDate(dateCell, mapping)
  if (!date) return { ok: false, reason: 'Date illisible', partial: { label } }

  const amount = readAmount(row, index, mapping)
  if (amount.reason) return { ok: false, reason: amount.reason, partial: { date, label } }
  if (openingDate && date < openingDate) {
    return {
      ok: false,
      reason: 'Date antérieure au solde d’ouverture',
      partial: { date, label, amountCents: amount.cents },
    }
  }
  return { ok: true, date, label, amountCents: amount.cents as number }
}

function readAmount(
  row: RawRow,
  index: Map<string, number>,
  mapping: Mapping,
): { cents?: number; reason?: string } {
  if (mapping.mode === 'debit-credit') {
    const debit = field(row, index, mapping.debitHeader)
    const credit = field(row, index, mapping.creditHeader)
    if (filled(debit) && filled(credit)) return { reason: 'Débit et crédit sont tous les deux remplis' }
    if (!filled(debit) && !filled(credit)) return { reason: 'Montant vide' }
    const side = filled(debit) ? 'debit' : 'credit'
    return applySide(centsOf(filled(debit) ? debit : credit, mapping.decimalSeparator), side)
  }
  const amount = field(row, index, mapping.amountHeader)
  if (!filled(amount)) return { reason: 'Montant vide' }
  return applySide(centsOf(amount, mapping.decimalSeparator), 'signe')
}

function applySide(
  parsed: { cents?: number; reason?: string },
  side: 'signe' | 'debit' | 'credit',
): { cents?: number; reason?: string } {
  if (parsed.reason || parsed.cents === undefined) return parsed
  if (parsed.cents === 0) return { reason: 'Montant nul' }
  if (side === 'debit') return { cents: -Math.abs(parsed.cents) }
  if (side === 'credit') return { cents: Math.abs(parsed.cents) }
  return { cents: parsed.cents }
}

function centsOf(cell: RawCell, decimal: Mapping['decimalSeparator']): { cents?: number; reason?: string } {
  if (cell.number !== undefined) {
    const text = Math.abs(cell.number).toFixed(2)
    const [whole, frac] = text.split('.')
    const cents = Number(whole) * 100 + Number(frac)
    return { cents: cell.number < 0 ? -cents : cents }
  }
  const parsed = parseAmount(cell.text, decimal)
  if (parsed === null) return { reason: 'Montant illisible' }
  return { cents: parsed }
}

function resolveDate(cell: RawCell, mapping: Mapping): string | null {
  if (cell.date) return cell.date
  const raw = cell.text.trim()
  if (cell.number !== undefined && !raw.includes('/') && !raw.includes('-') && !raw.includes('.')) {
    const serial = excelSerialToIso(cell.number)
    if (serial) return serial
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  return parseDate(raw, mapping.dateFormat)
}

function filled(cell: RawCell): boolean {
  return cell.text.trim() !== '' || cell.number !== undefined
}

function field(row: RawRow, index: Map<string, number>, header: string): RawCell {
  const position = index.get(header)
  if (position === undefined) return { text: '' }
  return row.cells[position] ?? { text: '' }
}

function rawFields(row: RawRow, index: Map<string, number>, mapping: Mapping): RawCell[] {
  const headers =
    mapping.mode === 'signe'
      ? [mapping.dateHeader, mapping.labelHeader, mapping.amountHeader]
      : [mapping.dateHeader, mapping.labelHeader, mapping.debitHeader, mapping.creditHeader]
  return headers.map((header) => field(row, index, header))
}
