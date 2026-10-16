export type Nature = 'depense' | 'encaissement'
export type AccountKind = 'releve' | 'solde'
export type DateFormat = 'JJ/MM/AAAA' | 'AAAA-MM-JJ' | 'JJ-MM-AAAA' | 'JJ.MM.AAAA'
export type DecimalSeparator = ',' | '.'

export type Mapping = {
  dateHeader: string
  labelHeader: string
  dateFormat: DateFormat
  decimalSeparator: DecimalSeparator
} & (
  | { mode: 'signe'; amountHeader: string }
  | { mode: 'debit-credit'; debitHeader: string; creditHeader: string }
)

export type Account = {
  id: number
  name: string
  bankId: number
  bankName: string
  kind: AccountKind
  archived: boolean
  mapping: Mapping | null
  openingCents: number | null
  openingDate: string | null
}

export type Category = {
  id: number
  name: string
  familyId: number
  sortOrder: number
  archived: boolean
}

export type Family = {
  id: number
  name: string
  nature: Nature
  sortOrder: number
  archived: boolean
  categories: Category[]
}

export type PreviewLine = {
  line: number
  status: 'ready' | 'duplicate' | 'rejected'
  date?: string
  label?: string
  amountCents?: number
  reason?: string
}

export type Preview =
  | { status: 'error'; message: string }
  | { status: 'choose-sheet'; sheets: string[] }
  | { status: 'blocked'; foundHeaders: string[]; missing: string[] }
  | { status: 'ok'; lines: PreviewLine[]; ready: number; duplicate: number; rejected: number }

export type CategoryRow = {
  categoryId: number
  name: string
  archived: boolean
  months: number[]
}

export type FamilyRow = {
  familyId: number
  name: string
  archived: boolean
  months: number[]
  categories: CategoryRow[]
}

export type StatementSummary = {
  kind: 'releve'
  year: number
  balanceMissing: boolean
  openingCents: number | null
  openingDate: string | null
  expenseFamilies: FamilyRow[]
  incomeFamilies: FamilyRow[]
  unpointedExpense: number[]
  unpointedIncome: number[]
  expenseTotals: number[]
  incomeTotals: number[]
  balances: (number | null)[]
}

export type BalanceSummary = {
  kind: 'solde'
  year: number
  balances: (number | null)[]
  expense: (number | null)[]
  income: (number | null)[]
}

export type AccountSummary = StatementSummary | BalanceSummary

export type GlobalAccountRow = {
  accountId: number
  accountName: string
  kind: AccountKind
  expense: (number | null)[]
  income: (number | null)[]
  balance: (number | null)[]
}

export type GlobalBankBlock = {
  bankId: number
  bankName: string
  accounts: GlobalAccountRow[]
  expense: number[]
  income: number[]
  balance: number[]
}

export type GlobalSummary = {
  year: number
  banks: GlobalBankBlock[]
  expense: number[]
  income: number[]
  balance: number[]
}

export type OperationView = {
  id: number
  date: string
  label: string
  amountCents: number
  categoryId: number | null
  categoryName: string | null
}

export type UnpointedView = {
  id: number
  accountId: number
  accountName: string
  date: string
  label: string
  amountCents: number
  suggestedCategoryId: number | null
}

export type BatchView = {
  id: number
  filename: string
  importedAt: string
  count: number
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }
