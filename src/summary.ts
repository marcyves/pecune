import { lastDay, monthEntirelyBefore, monthKey } from './dates.ts'
import { sumNumbers } from './format.ts'
import type {
  AccountKind,
  BalanceSummary,
  Category,
  CategoryRow,
  Family,
  FamilyRow,
  GlobalAccountRow,
  GlobalSummary,
  Nature,
  StatementSummary,
} from './types.ts'

export type OperationFact = {
  date: string
  balanceDate?: string
  amountCents: number
  categoryId: number | null
}

const zeros = (): number[] => Array.from({ length: 12 }, () => 0)

export function statementSummary(input: {
  year: number
  openingCents: number | null
  openingDate: string | null
  families: Family[]
  operations: OperationFact[]
}): StatementSummary {
  const { year, openingCents, openingDate, families, operations } = input
  const missing = openingCents === null || openingDate === null
  const expenseFamilies = familyRows(families, 'depense', year, operations, openingDate, missing)
  const incomeFamilies = familyRows(families, 'encaissement', year, operations, openingDate, missing)
  const unpointedExpense = zeros()
  const unpointedIncome = zeros()

  for (let month = 1; month <= 12; month += 1) {
    const index = month - 1
    if (!missing && monthEntirelyBefore(year, month, openingDate as string)) continue
    for (const operation of operationsInMonth(operations, year, month)) {
      if (operation.categoryId !== null) continue
      if (operation.amountCents < 0) unpointedExpense[index] += -operation.amountCents
      else unpointedIncome[index] += operation.amountCents
    }
  }

  const expenseTotals = zeros()
  const incomeTotals = zeros()
  for (let index = 0; index < 12; index += 1) {
    expenseTotals[index] =
      expenseFamilies.reduce((sum, family) => sum + family.months[index], 0) + unpointedExpense[index]
    incomeTotals[index] =
      incomeFamilies.reduce((sum, family) => sum + family.months[index], 0) + unpointedIncome[index]
  }

  return {
    kind: 'courant',
    year,
    balanceMissing: missing,
    openingCents,
    openingDate,
    expenseFamilies,
    incomeFamilies,
    unpointedExpense,
    unpointedIncome,
    expenseTotals,
    incomeTotals,
    balances: statementBalances(year, openingCents, openingDate, operations),
  }
}

export function balanceSummary(year: number, balances: Map<string, number>): BalanceSummary {
  const figures = balanceFigures(year, balances)
  return { kind: 'epargne', year, ...figures }
}

export function balanceFigures(
  year: number,
  balances: Map<string, number>,
  flows: { incoming: number[]; outgoing: number[] } = {
    incoming: Array.from({ length: 12 }, () => 0),
    outgoing: Array.from({ length: 12 }, () => 0),
  },
): { balances: (number | null)[]; entered: (number | null)[]; expense: (number | null)[]; income: (number | null)[] } {
  const shown: (number | null)[] = []
  const entered: (number | null)[] = []
  const expense: (number | null)[] = []
  const income: (number | null)[] = []
  const openingKey = monthKey(year - 1, 12)
  let carried: number | null = balances.has(openingKey) ? (balances.get(openingKey) as number) : null
  for (let month = 1; month <= 12; month += 1) {
    const index = month - 1
    const key = monthKey(year, month)
    const typed = balances.has(key) ? (balances.get(key) as number) : null
    const incoming = flows.incoming[index] ?? 0
    const outgoing = flows.outgoing[index] ?? 0
    entered.push(typed)
    const current = typed !== null ? typed : carried === null ? null : carried + incoming - outgoing
    shown.push(current)
    if (typed !== null && carried !== null) {
      const delta = typed - carried
      if (delta < 0) {
        expense.push(-delta)
        income.push(0)
      } else if (delta > 0) {
        expense.push(0)
        income.push(delta)
      } else {
        expense.push(0)
        income.push(0)
      }
    } else if (typed === null && (incoming > 0 || outgoing > 0)) {
      expense.push(outgoing > 0 ? outgoing : null)
      income.push(incoming > 0 ? incoming : null)
    } else {
      expense.push(null)
      income.push(null)
    }
    if (current !== null) carried = current
  }
  return { balances: shown, entered, expense, income }
}

export function statementBalances(
  year: number,
  openingCents: number | null,
  openingDate: string | null,
  operations: OperationFact[],
): (number | null)[] {
  if (openingCents === null || openingDate === null) return Array.from({ length: 12 }, () => null)
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1
    if (monthEntirelyBefore(year, month, openingDate)) return null
    const end = lastDay(year, month)
    const moved = operations
      .filter((operation) => {
        const balanceDate = operation.balanceDate ?? operation.date
        return balanceDate >= openingDate && balanceDate <= end
      })
      .reduce((sum, operation) => sum + operation.amountCents, 0)
    return openingCents + moved
  })
}

export function globalFromAccounts(
  year: number,
  rows: {
    accountId: number
    accountName: string
    bankId: number
    bankName: string
    kind: AccountKind
    expense: (number | null)[]
    income: (number | null)[]
    balance: (number | null)[]
  }[],
): GlobalSummary {
  const banks = new Map<number, { bankId: number; bankName: string; accounts: GlobalAccountRow[] }>()
  const ordered = [...rows].sort((a, b) => a.bankName.localeCompare(b.bankName, 'fr') || a.bankId - b.bankId)
  for (const row of ordered) {
    let bank = banks.get(row.bankId)
    if (!bank) {
      bank = { bankId: row.bankId, bankName: row.bankName, accounts: [] }
      banks.set(row.bankId, bank)
    }
    bank.accounts.push({
      accountId: row.accountId,
      accountName: row.accountName,
      kind: row.kind,
      expense: row.expense,
      income: row.income,
      balance: row.balance,
    })
  }
  const blocks = [...banks.values()].map((bank) => ({
    bankId: bank.bankId,
    bankName: bank.bankName,
    accounts: bank.accounts,
    expense: sumNumbers(bank.accounts.map((account) => account.expense)),
    income: sumNumbers(bank.accounts.map((account) => account.income)),
    balance: sumNumbers(bank.accounts.map((account) => account.balance)),
  }))
  return {
    year,
    banks: blocks,
    expense: sumNumbers(blocks.map((bank) => bank.expense)),
    income: sumNumbers(blocks.map((bank) => bank.income)),
    balance: sumNumbers(blocks.map((bank) => bank.balance)),
  }
}

function familyRows(
  families: Family[],
  nature: Nature,
  year: number,
  operations: OperationFact[],
  openingDate: string | null,
  missingOpening: boolean,
): FamilyRow[] {
  const rows: FamilyRow[] = []
  for (const family of families.filter((item) => item.nature === nature)) {
    const categories: CategoryRow[] = []
    for (const category of family.categories) {
      const months = categoryMonths(category, year, operations, openingDate, missingOpening)
      const active = months.some((amount) => amount !== 0)
      if (category.archived && !active) continue
      if (family.archived && !active) continue
      categories.push({
        categoryId: category.id,
        name: category.name,
        archived: category.archived,
        months,
      })
    }
    if (family.archived && categories.length === 0) continue
    if (!family.archived || categories.length > 0) {
      rows.push({
        familyId: family.id,
        name: family.name,
        archived: family.archived,
        months: Array.from({ length: 12 }, (_, index) =>
          categories.reduce((sum, category) => sum + Math.abs(category.months[index]), 0),
        ),
        categories,
      })
    }
  }
  return rows
}

function categoryMonths(
  category: Category,
  year: number,
  operations: OperationFact[],
  openingDate: string | null,
  missingOpening: boolean,
): number[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1
    if (!missingOpening && openingDate && monthEntirelyBefore(year, month, openingDate)) return 0
    return operationsInMonth(operations, year, month)
      .filter((operation) => operation.categoryId === category.id)
      .reduce((sum, operation) => sum + operation.amountCents, 0)
  })
}

function operationsInMonth(operations: OperationFact[], year: number, month: number): OperationFact[] {
  const start = `${monthKey(year, month)}-01`
  const end = lastDay(year, month)
  return operations.filter((operation) => operation.date >= start && operation.date <= end)
}
