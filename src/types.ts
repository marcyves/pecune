export type Nature = 'depense' | 'encaissement'
export type AccountKind = 'courant' | 'epargne' | 'titre'
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
  openingMillis: number | null
  openingDate: string | null
  cashMillis: number | null
  cashValuedOn: string | null
  reconciledOn: string | null
  reconciledCents: number | null
}

export type StatementMovement = {
  date: string
  label: string
  amount: number
}

export type StatementCheck = {
  date: string
  cents: number | null
  unpointedCount: number
  unit: 'cents' | 'millis'
  movements: StatementMovement[]
}

export type Category = {
  id: number
  name: string
  familyId: number
  sortOrder: number
  archived: boolean
  role: 'virement' | null
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
  kind: 'courant'
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
  kind: 'epargne'
  year: number
  balances: (number | null)[]
  entered: (number | null)[]
  expense: (number | null)[]
  income: (number | null)[]
}

export type Position = {
  id: number
  accountId: number
  name: string
  quantityMicros: number
  valueMillis: number
  valuedOn: string | null
}

export type HoldingsSummary = {
  kind: 'titre'
  year: number
  positions: Position[]
  securitiesMillis: number
  cashMillis: number
  cashValuedOn: string | null
  totalMillis: number
  balances: (number | null)[]
  expense: (number | null)[]
  income: (number | null)[]
}

export type AccountSummary = StatementSummary | BalanceSummary | HoldingsSummary

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
  counterpartyAccountId: number | null
  counterpartyAccountName: string | null
  imported: boolean
}

export type TransferMatch = {
  id: number
  date: string
  label: string
  amountCents: number
}

export type TransferView = {
  id: number
  date: string
  amountCents: number
  fromAccountId: number
  fromAccountName: string
  fromBankName: string
  toAccountId: number
  toAccountName: string
  toBankName: string
}

export type UnpointedView = {
  id: number
  accountId: number
  accountName: string
  bankName: string
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
