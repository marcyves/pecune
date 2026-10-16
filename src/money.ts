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

export function parseUserAmount(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const decimal = trimmed.includes(',') ? ',' : '.'
  const cents = parseAmount(trimmed, decimal)
  if (cents === null) return 'invalid'
  return cents
}
