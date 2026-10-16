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

export function formatEuros(cents: number): string {
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const euros = Math.floor(absolute / 100)
  const rest = String(absolute % 100).padStart(2, '0')
  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')
  return `${negative ? '−' : ''}${grouped},${rest}`
}

export function formatInputAmount(cents: number): string {
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const euros = Math.floor(absolute / 100)
  const rest = String(absolute % 100).padStart(2, '0')
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
