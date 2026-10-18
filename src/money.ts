import { groupThousands } from './format.ts'
import type { DecimalSeparator } from './types.ts'

export function parseAmount(raw: string, decimal: DecimalSeparator): number | null {
  let text = raw.trim().replace(/[\s\u00a0\u202f']/g, '')
  if (text === '') return null
  if (decimal === ',') text = text.replace(/\./g, '').replace(',', '.')
  else text = text.replace(/,/g, '')
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(text)) return null
  const negative = text.startsWith('-')
  const digits = negative || text.startsWith('+') ? text.slice(1) : text
  const [whole, frac = ''] = digits.split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

function userDecimal(raw: string): { negative: boolean; whole: string; frac: string } | null | 'invalid' {
  let text = raw.trim().replace(/€/g, '').replace(/\bEUR\b/gi, '').trim()
  text = text.replace(/[\s\u00a0\u202f']/g, '').replace(/[’ʼ′´]/g, '').replace(/[，‚]/g, ',')
  if (text === '') return null
  if (text.startsWith(',') || text.startsWith('.')) text = `0${text}`
  if ((text.startsWith('+') || text.startsWith('-')) && (text[1] === ',' || text[1] === '.')) {
    text = `${text[0]}0${text.slice(1)}`
  }
  const lastComma = text.lastIndexOf(',')
  const lastDot = text.lastIndexOf('.')
  if (lastComma >= 0 || lastDot >= 0) {
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(/,/g, '.') : text.replace(/,/g, '')
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return 'invalid'
  const negative = text.startsWith('-')
  const digits = negative || text.startsWith('+') ? text.slice(1) : text
  const [whole, frac = ''] = digits.split('.')
  return { negative, whole, frac }
}

function scaleDecimal(raw: string, places: number): number | null | 'invalid' {
  const parts = userDecimal(raw)
  if (parts === null || parts === 'invalid') return parts
  const padded = `${parts.frac}${'0'.repeat(places + 1)}`
  let value = Number(parts.whole) * 10 ** places + Number(padded.slice(0, places))
  if (padded[places] >= '5') value += 1
  if (!Number.isSafeInteger(value)) return 'invalid'
  return parts.negative ? -value : value
}

export function parseUserAmount(raw: string): number | null | 'invalid' {
  return scaleDecimal(raw, 2)
}

export function parseUserMillis(raw: string): number | null | 'invalid' {
  return scaleDecimal(raw, 3)
}

export function millisToCents(millis: number): number {
  const negative = millis < 0
  const absolute = Math.abs(millis)
  const cents = Math.floor(absolute / 10) + (absolute % 10 >= 5 ? 1 : 0)
  return negative ? -cents : cents
}

export function lineMillis(quantityMicros: number, valueMillis: number): number {
  const product = BigInt(quantityMicros) * BigInt(valueMillis)
  const scale = 1_000_000n
  const negative = product < 0n
  const absolute = negative ? -product : product
  const millis = absolute / scale + (absolute % scale >= 500_000n ? 1n : 0n)
  const result = Number(millis)
  return negative ? -result : result
}

const QUANTITY_SCALE = 1_000_000

export function parseQuantity(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim().replace(/[\s\u00a0\u202f']/g, '')
  if (trimmed === '') return null
  const text = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed.replace(/,/g, '')
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return 'invalid'
  const [whole, frac = ''] = text.split('.')
  const micros = Number(whole) * QUANTITY_SCALE + Number(frac.padEnd(6, '0'))
  if (!Number.isSafeInteger(micros) || micros <= 0) return 'invalid'
  return micros
}

export function formatQuantity(micros: number): string {
  const negative = micros < 0
  const absolute = Math.abs(micros)
  const whole = Math.floor(absolute / QUANTITY_SCALE)
  const frac = String(absolute % QUANTITY_SCALE).padStart(6, '0').replace(/0+$/, '')
  const grouped = groupThousands(String(whole))
  return `${negative ? '-' : ''}${frac ? `${grouped},${frac}` : grouped}`
}
