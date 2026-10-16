import type { DateFormat } from './types.ts'

const patterns: Record<DateFormat, RegExp> = {
  'JJ/MM/AAAA': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'AAAA-MM-JJ': /^(\d{4})-(\d{2})-(\d{2})$/,
  'JJ-MM-AAAA': /^(\d{2})-(\d{2})-(\d{4})$/,
  'JJ.MM.AAAA': /^(\d{2})\.(\d{2})\.(\d{4})$/,
}

export const DATE_FORMATS: DateFormat[] = [
  'JJ/MM/AAAA',
  'AAAA-MM-JJ',
  'JJ-MM-AAAA',
  'JJ.MM.AAAA',
]

export function parseDate(raw: string, format: DateFormat): string | null {
  const match = patterns[format].exec(raw.trim())
  if (!match) return null
  const year = Number(format === 'AAAA-MM-JJ' ? match[1] : match[3])
  const month = Number(format === 'AAAA-MM-JJ' ? match[2] : match[2])
  const day = Number(format === 'AAAA-MM-JJ' ? match[3] : match[1])
  return isoDate(year, month, day)
}

export function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return `${year}-${pad(month)}-${pad(day)}`
}

export function dateToIso(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null
  return isoDate(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial)) return null
  const whole = Math.floor(serial)
  if (whole < 20000 || whole > 80000) return null
  const utc = Date.UTC(1899, 11, 30) + whole * 86_400_000
  const date = new Date(utc)
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

export function monthKey(year: number, month: number): string {
  return `${year}-${pad(month)}`
}

export function lastDay(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 0))
  return isoDate(year, month, date.getUTCDate()) as string
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) return { year: year - 1, month: 12 }
  return { year, month: month - 1 }
}

export function monthEntirelyBefore(year: number, month: number, openingDate: string): boolean {
  return lastDay(year, month) < openingDate
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
