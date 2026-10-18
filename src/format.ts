export const MONTH_LABELS = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
]

const THOUSANDS = '\u00a0'

export function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS)
}

export function formatEuros(cents: number): string {
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const euros = Math.floor(absolute / 100)
  const rest = String(absolute % 100).padStart(2, '0')
  return `${negative ? '−' : ''}${groupThousands(String(euros))},${rest}`
}

export function formatInputAmount(cents: number): string {
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const euros = Math.floor(absolute / 100)
  const rest = String(absolute % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${euros},${rest}`
}

export function formatMillis(millis: number): string {
  const negative = millis < 0
  const absolute = Math.abs(millis)
  const euros = Math.floor(absolute / 1000)
  const rest = String(absolute % 1000).padStart(3, '0')
  return `${negative ? '−' : ''}${groupThousands(String(euros))},${rest}`
}

export function formatInputMillis(millis: number): string {
  const negative = millis < 0
  const absolute = Math.abs(millis)
  const euros = Math.floor(absolute / 1000)
  const rest = String(absolute % 1000).padStart(3, '0')
  return `${negative ? '-' : ''}${euros},${rest}`
}

export function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.split('-')
  return `${day}/${month}/${year}`
}

export function sumNumbers(rows: (number | null)[][]): number[] {
  return Array.from({ length: 12 }, (_, index) => {
    let total = 0
    for (const row of rows) {
      const value = row[index]
      if (value !== null) total += value
    }
    return total
  })
}
