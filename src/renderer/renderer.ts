import { MONTH_LABELS, formatEuros, formatInputAmount, formatInputMillis, formatIsoDate, formatMillis } from '../format.ts'
import { todayIso } from '../dates.ts'
import { formatQuantity, lineMillis, millisToCents } from '../money.ts'
import type {
  Account,
  AccountSummary,
  BatchView,
  Category,
  CategoryRow,
  Family,
  GlobalSummary,
  HoldingsSummary,
  Mapping,
  Nature,
  OperationView,
  Position,
  Preview,
  StatementSummary,
  TransferMatch,
  TransferView,
  UnpointedView,
} from '../types.ts'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

type Status = { state: 'setup' } | { state: 'error'; message: string } | { state: 'ready'; databasePath: string }

type AccountCard = Account & {
  currentCents: number | null
  unpointedCents: number | null
  securitiesMillis: number | null
}

type Workspace = {
  year: number
  databasePath: string | null
  accounts: AccountCard[]
  families: Family[]
  categoryTotals: { categoryId: number; totalCents: number }[]
  global: GlobalSummary
}

type Detail = {
  account: Account | null
  summary: AccountSummary
  operations: OperationView[]
  batches: BatchView[]
  transfers: TransferView[]
}

type Screen = 'global' | 'accounts' | 'account' | 'pointing' | 'categories'

type ComptesApi = {
  status: () => Promise<Result<Status>>
  createDefault: () => Promise<Result<string>>
  createAt: () => Promise<Result<string | null>>
  openAt: () => Promise<Result<string | null>>
  exportCopy: () => Promise<Result<string | null>>
  printPage: () => Promise<Result<boolean>>
  exportPdf: (defaultName: string) => Promise<Result<string | null>>
  workspace: (year: number) => Promise<Result<Workspace>>
  accountDetail: (id: number, year: number) => Promise<Result<Detail>>
  saveAccount: (input: unknown) => Promise<Result<Account>>
  deleteAccount: (id: number) => Promise<Result<unknown>>
  saveFamily: (input: unknown) => Promise<Result<unknown>>
  moveFamily: (id: number, direction: -1 | 1) => Promise<Result<unknown>>
  saveCategory: (input: unknown) => Promise<Result<unknown>>
  moveCategory: (id: number, direction: -1 | 1) => Promise<Result<unknown>>
  moveAccount: (id: number, direction: -1 | 1) => Promise<Result<unknown>>
  setMonthlyBalance: (accountId: number, month: string, raw: string) => Promise<Result<unknown>>
  savePosition: (input: {
    accountId: number
    id?: number
    name: string
    quantity: string
    value: string
    valuedOn: string
  }) => Promise<Result<Position>>
  deletePosition: (id: number) => Promise<Result<unknown>>
  setCash: (accountId: number, raw: string, valuedOn: string) => Promise<Result<unknown>>
  pickImportFile: () => Promise<Result<string | null>>
  previewImport: (accountId: number, filePath: string, sheetName?: string) => Promise<Result<Preview>>
  confirmImport: (accountId: number, filePath: string, sheetName?: string) => Promise<Result<unknown>>
  cancelBatch: (batchId: number) => Promise<Result<number>>
  unpointed: (accountId: number | null) => Promise<Result<UnpointedView[]>>
  previewOperationTransfer: (operationId: number, counterpartyAccountId: number) => Promise<Result<TransferMatch[]>>
  previewSavingsTransfer: (toAccountId: number, date: string, amount: string) => Promise<Result<TransferMatch[]>>
  pointOperation: (
    operationId: number,
    categoryId: number,
    counterpartyAccountId: number | null,
    matchedOperationId: number | null,
  ) => Promise<Result<unknown>>
  createSavingsMovement: (
    accountId: number,
    date: string,
    label: string,
    amount: string,
    direction: 'entree' | 'sortie',
  ) => Promise<Result<unknown>>
  createTransfer: (
    fromAccountId: number,
    toAccountId: number,
    date: string,
    amount: string,
    matchedOperationId: number | null,
  ) => Promise<Result<unknown>>
  deleteTransfer: (transferId: number) => Promise<Result<unknown>>
  unpointOperation: (operationId: number) => Promise<Result<unknown>>
  updateManualOperation: (operationId: number, date: string, label: string, amount: string) => Promise<Result<unknown>>
  deleteManualOperation: (operationId: number) => Promise<Result<unknown>>
}

declare global {
  interface Window {
    comptes: ComptesApi
  }
}

const SHORT = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.']

let year = new Date().getFullYear()
let screen: Screen = 'global'
let accountId: number | null = null
let editing = false
let draftBank: string | null = null
let showArchived = false
let status: Status = { state: 'setup' }
let workspace: Workspace | null = null
let detail: Detail | null = null
let unpointed: UnpointedView[] = []
let pointFilter: number | null = null
let editingOperationId: number | null = null
let operationsEdit = false
let globalView: 'balance' | 'expense' | 'income' = 'balance'
let globalOrder = false
let accountTab: 'depense' | 'encaissement' | 'operations' = 'depense'
let movingCategoryId: number | null = null
let notice = ''
let importFile: string | null = null
let importSheet = ''
let preview: Preview | null = null

type Drill = {
  categoryId: number | null
  nature: Nature
  name: string
  month: number | null
}

let drill: Drill | null = null
let writes: Promise<void> = Promise.resolve()

function follow(work: () => Promise<void>): Promise<void> {
  const run = writes.then(work, work)
  writes = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const app = document.querySelector('#app') as HTMLElement

if (!window.comptes) {
  app.textContent = 'Le pont de l’application n’est pas chargé.'
} else {
  void boot()
}

async function boot(): Promise<void> {
  const current = await ask(window.comptes.status())
  if (!current) {
    render()
    return
  }
  status = current
  if (status.state === 'ready') await loadWorkspace()
  render()
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!drill && movingCategoryId === null) return
  drill = null
  movingCategoryId = null
  render()
})

window.addEventListener('beforeprint', () => {
  if (screen === 'global' && workspace) fillPrintRoot(workspace.global)
  else clearPrintRoot()
})

async function loadWorkspace(): Promise<void> {
  const data = await ask(window.comptes.workspace(year))
  if (data) workspace = data
  if (screen === 'account' && accountId) await loadDetail()
  if (screen === 'pointing') await loadUnpointed()
}

async function loadDetail(): Promise<void> {
  if (!accountId) return
  const data = await ask(window.comptes.accountDetail(accountId, year))
  if (data) detail = data
}

async function loadUnpointed(): Promise<void> {
  const data = await ask(window.comptes.unpointed(pointFilter))
  if (data) unpointed = data
}

async function ask<T>(run: Promise<Result<T>>): Promise<T | null> {
  const result = await run
  if (!result.ok) {
    notice = result.error
    return null
  }
  return result.data
}

function render(): void {
  const kept = app.querySelector('.pointing') ? scrollPosition() : null
  app.replaceChildren()
  if (status.state !== 'ready') {
    app.append(setupScreen())
    return
  }
  const shell = el('div', 'app')
  shell.append(sidebar(), main())
  app.append(shell)
  if (screen === 'account' && drill) app.append(drillPanel())
  if (kept && screen === 'pointing') restoreScroll(kept)
}

function scrollPosition(): { main: number; table: number; tableLeft: number } {
  const region = app.querySelector('.main')
  const table = app.querySelector('.pointing .table-wrap')
  return {
    main: region instanceof HTMLElement ? region.scrollTop : 0,
    table: table instanceof HTMLElement ? table.scrollTop : 0,
    tableLeft: table instanceof HTMLElement ? table.scrollLeft : 0,
  }
}

function restoreScroll(kept: { main: number; table: number; tableLeft: number }): void {
  const region = app.querySelector('.main')
  const table = app.querySelector('.pointing .table-wrap')
  if (region instanceof HTMLElement) region.scrollTop = kept.main
  if (table instanceof HTMLElement) {
    table.scrollTop = kept.table
    table.scrollLeft = kept.tableLeft
  }
}

function setupScreen(): HTMLElement {
  const page = el('div', 'setup card')
  page.append(el('h1', '', 'Comptes'))
  page.append(
    el(
      'p',
      '',
      'Les comptes, sur ce Mac. La base reste dans les données de l’application, sauf si tu choisis un autre fichier.',
    ),
  )
  if (notice || status.state === 'error') {
    page.append(el('div', 'banner', notice || (status.state === 'error' ? status.message : '')))
  }
  const row = el('div', 'toolbar')
  row.append(
    button('Créer une base sur ce Mac', 'primary', async () => {
      if (await ask(window.comptes.createDefault())) await boot()
      else render()
    }),
    button('Choisir un emplacement', '', async () => {
      if (await ask(window.comptes.createAt())) await boot()
      else render()
    }),
    button('Ouvrir une base', '', async () => {
      if (await ask(window.comptes.openAt())) await boot()
      else render()
    }),
  )
  page.append(row)
  return page
}

function sidebar(): HTMLElement {
  const aside = el('aside', 'sidebar')
  aside.append(el('p', 'brand', 'Comptes'))
  const items: [Screen, string][] = [
    ['global', 'Tableau global'],
    ['accounts', 'Comptes'],
    ['pointing', 'Pointage'],
    ['categories', 'Catégories'],
  ]
  for (const [name, label] of items) {
    const item = button(label, `nav${screen === name ? ' active' : ''}`, () => go(name))
    aside.append(item)
  }
  const yearBox = el('div', 'year')
  yearBox.append(
    button('‹', '', () => changeYear(year - 1)),
    el('strong', '', String(year)),
    button('›', '', () => changeYear(year + 1)),
  )
  aside.append(yearBox)
  aside.append(el('div', 'spacer'))
  aside.append(el('p', 'path', workspace?.databasePath ?? ''))
  aside.append(
    button('Exporter une copie', '', async () => {
      const path = await ask(window.comptes.exportCopy())
      notice = path ? 'Copie enregistrée.' : notice
      render()
    }),
  )
  return aside
}

function main(): HTMLElement {
  const region = el('main', 'main')
  if (notice) region.append(el('div', 'banner', notice))
  if (screen === 'global' && workspace) region.append(renderGlobal(workspace.global))
  if (screen === 'accounts' && workspace) region.append(renderAccounts())
  if (screen === 'account') region.append(renderAccount())
  if (screen === 'pointing') region.append(renderPointing())
  if (screen === 'categories' && workspace) region.append(renderCategories())
  return region
}

function renderGlobal(global: GlobalSummary): HTMLElement {
  const page = el('div')
  const head = el('div', 'global-head')
  const edit = glyphButton('Changer l’ordre', 'edit', () => {
    globalOrder = !globalOrder
    render()
  })
  if (globalOrder) edit.classList.add('active')
  edit.setAttribute('aria-pressed', String(globalOrder))
  const tools = el('div', 'global-tools')
  tools.append(
    edit,
    glyphButton('Imprimer', 'print', () => { void outputGlobal('print') }),
    glyphButton('Exporter en PDF', 'pdf', () => { void outputGlobal('pdf') }),
  )
  head.append(el('h1', '', `Tableau global ${year}`), tools)
  page.append(head)
  const tabs = el('div', 'tabs')
  for (const [field, label] of [
    ['balance', 'Soldes'],
    ['expense', 'Dépenses'],
    ['income', 'Encaissements'],
  ] as const) {
    tabs.append(
      button(label, globalView === field ? 'active' : '', () => {
        globalView = field
        render()
      }),
    )
  }
  page.append(tabs, moneyBlock(global, globalView))
  return page
}

function moneyBlock(global: GlobalSummary, field: 'expense' | 'income' | 'balance', interactive = true): HTMLElement {
  const card = el('section', 'card')
  if (global.banks.length === 0) {
    card.append(el('p', 'empty', 'Aucun compte.'))
    return card
  }
  const table = el('table', 'grid')
  const head = document.createElement('thead')
  head.append(monthHead())
  table.append(head)
  if (interactive) {
    const body = document.createElement('tbody')
    table.append(body)
    global.banks.forEach((bank, index) => {
      body.append(bankHeading(bank.bankName))
      for (const account of bank.accounts) body.append(accountRow(account, field, true))
      body.append(amountRow(`Total ${bank.bankName}`, bank[field], 'total'))
      if (index < global.banks.length - 1) body.append(bankGap())
    })
    body.append(amountRow('Total', global[field], 'total'))
  } else {
    const grand = amountRow('Total', global[field], 'total')
    global.banks.forEach((bank, index) => {
      const last = index === global.banks.length - 1
      for (const group of printBankGroups(bank, field, last, last ? grand : null)) table.append(group)
    })
  }
  card.append(wrap(table))
  return card
}

function accountRow(
  account: GlobalSummary['banks'][number]['accounts'][number],
  field: 'expense' | 'income' | 'balance',
  interactive: boolean,
): HTMLElement {
  const row = labelRow('', 'account')
  const cell = row.querySelector('td')
  cell?.classList.add('account-name')
  if (interactive && globalOrder) {
    const arrows = el('span', 'order-arrows')
    arrows.append(
      glyphButton('Haut', 'up', () => { void reorderAccount(account.accountId, -1) }),
      glyphButton('Bas', 'down', () => { void reorderAccount(account.accountId, 1) }),
    )
    cell?.append(arrows)
  }
  cell?.append(
    interactive
      ? button(account.accountName, 'link', () => openAccount(account.accountId))
      : el('span', '', account.accountName),
  )
  addAmounts(row, account[field])
  return row
}

function keepRows(rows: HTMLElement[]): HTMLTableSectionElement {
  const body = document.createElement('tbody')
  body.className = 'keep'
  body.append(...rows)
  return body
}

function printBankGroups(
  bank: GlobalSummary['banks'][number],
  field: 'expense' | 'income' | 'balance',
  last: boolean,
  grandTotal: HTMLElement | null,
): HTMLTableSectionElement[] {
  const opening = bank.accounts.slice(0, Math.min(2, bank.accounts.length))
  const rest = bank.accounts.slice(opening.length)
  const middle = rest.slice(0, -1)
  const closingAccount = rest.at(-1) ?? null
  const groups: HTMLTableSectionElement[] = []
  const start = [bankHeading(bank.bankName), ...opening.map((account) => accountRow(account, field, false))]
  if (!closingAccount) {
    start.push(amountRow(`Total ${bank.bankName}`, bank[field], 'total'))
    if (!last) start.push(bankGap())
    if (grandTotal) start.push(grandTotal)
    groups.push(keepRows(start))
    return groups
  }
  groups.push(keepRows(start))
  if (middle.length > 0) {
    const body = document.createElement('tbody')
    body.append(...middle.map((account) => accountRow(account, field, false)))
    groups.push(body)
  }
  const end = [
    accountRow(closingAccount, field, false),
    amountRow(`Total ${bank.bankName}`, bank[field], 'total'),
  ]
  if (!last) end.push(bankGap())
  if (grandTotal) end.push(grandTotal)
  groups.push(keepRows(end))
  return groups
}

const GLOBAL_PAGES = [
  ['balance', 'Soldes'],
  ['expense', 'Dépenses'],
  ['income', 'Encaissements'],
] as const

function fillPrintRoot(global: GlobalSummary): void {
  clearPrintRoot()
  const style = document.createElement('style')
  style.id = 'print-page-style'
  style.textContent = '@page { size: A4 landscape; margin: 10mm 8mm; }'
  document.head.append(style)
  const root = document.createElement('div')
  root.id = 'print-root'
  root.className = 'print-root'
  for (const [field, label] of GLOBAL_PAGES) {
    const sheet = el('section', 'print-page')
    sheet.append(el('h1', '', `Tableau global ${year}`), el('p', 'print-view', label), moneyBlock(global, field, false))
    root.append(sheet)
  }
  document.body.append(root)
  fitPrintWidth(root)
}

function fitPrintWidth(root: HTMLElement): void {
  root.classList.add('print-measure')
  const available = root.clientWidth
  if (available > 0) {
    for (const table of root.querySelectorAll('table')) {
      table.style.setProperty('width', 'max-content', 'important')
      table.style.setProperty('max-width', 'none', 'important')
      table.style.setProperty('table-layout', 'auto', 'important')
      const needed = table.scrollWidth
      table.style.removeProperty('width')
      table.style.removeProperty('max-width')
      table.style.removeProperty('table-layout')
      table.style.zoom = needed > available ? String((available / needed) * 0.99) : ''
    }
  }
  root.classList.remove('print-measure')
}

function clearPrintRoot(): void {
  document.getElementById('print-root')?.remove()
  document.getElementById('print-page-style')?.remove()
}

async function outputGlobal(kind: 'print' | 'pdf'): Promise<void> {
  if (!workspace) return
  fillPrintRoot(workspace.global)
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  const previous = notice
  try {
    if (kind === 'print') await ask(window.comptes.printPage())
    else {
      const filePath = await ask(window.comptes.exportPdf(`Tableau global ${year}.pdf`))
      if (filePath) notice = 'PDF enregistré.'
    }
  } finally {
    clearPrintRoot()
  }
  if (notice !== previous) render()
}

function renderAccounts(): HTMLElement {
  const page = el('div')
  page.append(el('h1', '', 'Comptes'))
  const tools = el('div', 'toolbar')
  tools.append(
    button('Nouveau compte', 'primary', () => startNewAccount(null)),
    button(showArchived ? 'Masquer les archivés' : 'Afficher les archivés', '', () => {
      showArchived = !showArchived
      render()
    }),
  )
  page.append(tools)
  const accounts = (workspace?.accounts ?? []).filter((account) => showArchived || !account.archived)
  if (accounts.length === 0) page.append(el('p', 'empty', 'Aucun compte pour l’instant.'))
  const groups = new Map<string, AccountCard[]>()
  for (const account of accounts) {
    const items = groups.get(account.bankName) ?? []
    items.push(account)
    groups.set(account.bankName, items)
  }
  if (groups.size > 1) page.append(totalLine('Tous les comptes', accounts))
  const list = el('div', 'account-list')
  for (const [bankName, items] of groups) {
    const group = el('section')
    const head = el('div', 'bank-head')
    const name = el('div', 'bank-name')
    name.append(el('h2', '', bankName), plusButton('Nouveau compte', () => startNewAccount(bankName)))
    head.append(el('div', 'bank-title', name, totalLine('Solde', items)))
    const row = el('div', 'account-bank')
    group.append(head, row)
    list.append(group)
    for (const account of items) {
      const card = button('', 'account-card', () => openAccount(account.id))
      const top = el('div', 'account-card-top')
      top.append(el('strong', '', account.name), el('span', 'muted', kindLabel(account.kind)))
      const figures = el('div', 'account-figures')
      if (account.kind === 'titre') {
        figures.append(figureMillis('Solde des titres', account.securitiesMillis), figure('Solde', account.currentCents))
      } else {
        figures.append(figure('Solde courant', account.currentCents), figure('Solde non pointé', account.unpointedCents))
      }
      card.append(top, figures)
      row.append(card)
    }
  }
  page.append(list)
  return page
}

function totalLine(label: string, accounts: AccountCard[]): HTMLElement {
  const known = accounts.some((account) => account.currentCents !== null)
  const cents = accounts.reduce((sum, account) => sum + (account.currentCents ?? 0), 0)
  const text = known ? `${label} ${formatEuros(cents)}` : `${label} —`
  const className = label === 'Tous les comptes' ? 'accounts-total' : 'bank-total'
  return el('span', `${className}${known && cents < 0 ? ' neg' : ''}`, text)
}

function renderAccount(): HTMLElement {
  const page = el('div')
  const account = detail?.account ?? null
  const creating = editing && !account
  page.append(accountHeading(account, creating))
  if (creating || editing) page.append(accountForm(account))
  if (!account || !detail) return page
  const tools = el('div', 'toolbar')
  if (!editing) tools.append(button('Modifier', '', () => { editing = true; render() }))
  tools.append(
    button(account.archived ? 'Réactiver' : 'Archiver', 'danger', () => archiveAccount(account)),
  )
  if (account.archived) {
    tools.append(button('Effacer', 'danger', () => eraseAccount(account)))
  }
  page.append(tools)
  page.append(accountHeadingFigures(account, detail.summary))
  if (account.kind === 'courant') {
    page.append(renderBatches(detail.batches, account))
    if (preview && importFile) page.append(renderPreview(account.id))
  }
  page.append(accountTabs(account, detail.summary))
  return page
}

function accountHeading(account: Account | null, creating: boolean): HTMLElement {
  const title = el('div', 'account-title')
  const heading = el('h1')
  if (creating) heading.append('Nouveau compte')
  else {
    heading.append(account?.name ?? 'Compte')
    if (account) heading.append(el('span', 'bank', account.bankName))
  }
  title.append(glyphButton('Retour aux comptes', 'back', () => { void go('accounts') }), heading)
  return title
}

function accountHeadingFigures(account: Account, summary: AccountSummary): HTMLElement {
  const box = el('div')
  if (summary.kind === 'titre') box.append(holdingsEditor(account, summary))
  const card = el('section', 'card account-balances')
  if (summary.kind !== 'titre') {
    card.append(el('h2', '', 'Solde d’ouverture'))
    card.append(openingBlock(account, summary))
  }
  card.append(el('h2', summary.kind === 'titre' ? '' : 'balance-next', 'Solde à date'))
  if (summary.kind === 'epargne') {
    card.append(el('p', 'muted', 'Le solde de fin de mois part du solde initial, des mouvements et des virements. Les totaux sont arrondis au centime.'))
  }
  if (summary.kind === 'titre') {
    card.append(el('p', 'muted', 'Le solde part de la valorisation à sa date, puis des mouvements. Il est reporté les mois suivants, et affiché au centime.'))
  }
  const values = summary.kind === 'courant' ? summary.balances : displayCents(summary.balances, false)
  card.append(monthTable('Solde', values, 'total'))
  box.append(card)
  return box
}

function openingBlock(account: Account, summary: AccountSummary): HTMLElement {
  if (summary.kind === 'courant') {
    if (summary.balanceMissing) return el('p', 'banner', 'Solde d’ouverture manquant. Les soldes ne sont pas calculés.')
    return el('p', '', `${formatEuros(summary.openingCents ?? 0)} au ${formatIsoDate(summary.openingDate ?? '')}`)
  }
  if (summary.kind !== 'epargne') return el('div')
  if (account.openingMillis === null || !account.openingDate) {
    const box = el('div')
    box.append(el('p', 'banner', 'Solde initial manquant. Les soldes ne sont pas calculés.'))
    box.append(openingForm(account))
    return box
  }
  return openingForm(account)
}

function openingForm(account: Account): HTMLElement {
  const box = el('div')
  const amount = amountInput(account.openingMillis === null ? '' : formatInputMillis(account.openingMillis))
  amount.placeholder = '0,000'
  const date = dateInput(account.openingDate ?? '')
  const form = el('div', 'form-row')
  form.append(labeled('Solde initial', amount), labeled('Date', date))
  box.append(form)
  box.append(
    button('Enregistrer', 'primary', () => {
      void saveOpening(account, amount.value, date.value)
    }),
  )
  return box
}

function accountTabs(account: Account, summary: AccountSummary): HTMLElement {
  const page = el('div')
  const tabs = el('div', 'tabs')
  for (const [id, label] of [
    ['depense', 'Dépenses'],
    ['encaissement', 'Encaissements'],
    ['operations', 'Opérations'],
  ] as const) {
    tabs.append(
      button(label, accountTab === id ? 'active' : '', () => selectAccountTab(id)),
    )
  }
  page.append(tabs)
  if (accountTab === 'depense') page.append(naturePane(summary, 'depense'))
  if (accountTab === 'encaissement') page.append(naturePane(summary, 'encaissement'))
  if (accountTab === 'operations') page.append(operationsPane(account))
  return page
}

function selectAccountTab(next: 'depense' | 'encaissement' | 'operations'): void {
  accountTab = next
  if (next === 'operations' || (drill && drill.nature !== next)) drill = null
  render()
}

function naturePane(summary: AccountSummary, nature: Nature): HTMLElement {
  const card = el('section', 'card')
  if (summary.kind === 'courant') {
    if (nature === 'depense') {
      card.append(categoryBlock('', summary.expenseFamilies, summary.unpointedExpense, summary.expenseTotals, 'depense'))
    } else {
      card.append(categoryBlock('', summary.incomeFamilies, summary.unpointedIncome, summary.incomeTotals, 'encaissement'))
    }
    return card
  }
  const values = nature === 'depense' ? summary.expense : summary.income
  const label = nature === 'depense' ? 'Dépense' : 'Encaissement'
  card.append(monthTable(label, displayCents(values, true), '', true))
  return card
}

function operationsPane(account: Account): HTMLElement {
  if (account.kind === 'courant') return renderOperations(detail?.operations ?? [], account.id)
  const page = el('div')
  page.append(movementEditor(account))
  if (account.kind === 'epargne') page.append(transferEditor(account))
  return page
}

function monthTable(label: string, values: readonly (number | null)[], className: string, withTotal = false): HTMLElement {
  const table = el('table', 'grid')
  table.append(monthHead(withTotal))
  table.append(amountRow(label, values, className, withTotal))
  return wrap(table)
}

function accountForm(account: Account | null): HTMLElement {
  const form = el('form', 'card')
  const mapping = account?.mapping
  form.append(el('h2', '', account ? 'Modifier le compte' : 'Nouveau compte'))
  const name = field('Nom', 'text', account?.name ?? '')
  const lockedBank = !account && draftBank ? draftBank : null
  let readBank: () => string
  if (lockedBank) {
    const fixed = el('div', 'fixed-bank')
    fixed.append(el('span', 'muted', 'Banque'), el('strong', '', lockedBank))
    form.append(el('div', 'form-row', name.label, fixed))
    readBank = () => lockedBank
  } else {
    const banks = knownBanks()
    const currentBank = account?.bankName ?? (banks[0] ?? '')
    const bankSelect = el('select') as HTMLSelectElement
    for (const bankName of banks) bankSelect.append(option(bankName, bankName))
    bankSelect.append(option('', 'Nouvelle banque'))
    bankSelect.value = banks.includes(currentBank) ? currentBank : ''
    const bankInput = textInput(banks.includes(currentBank) ? '' : currentBank)
    const newBank = el('label', '', 'Nouvelle banque')
    newBank.append(bankInput)
    const syncBank = () => {
      newBank.hidden = bankSelect.value !== ''
    }
    bankSelect.addEventListener('change', syncBank)
    syncBank()
    form.append(el('div', 'form-row', name.label, labeled('Banque', bankSelect), newBank))
    readBank = () => bankSelect.value || bankInput.value
  }
  const kind = el('select') as HTMLSelectElement
  kind.append(option('courant', 'Courant'), option('epargne', 'Épargne'), option('titre', 'Titre'))
  kind.value = account?.kind ?? 'courant'
  kind.disabled = Boolean(account)
  const kindLabel = el('label', '', 'Type')
  kindLabel.append(kind)
  form.append(kindLabel)
  const mappingBox = el('div', 'form-row')
  const dateHeader = field('Colonne date', 'text', mapping?.dateHeader ?? 'Date')
  const labelHeader = field('Colonne libellé', 'text', mapping?.labelHeader ?? 'Libelle')
  const dateFormat = el('select') as HTMLSelectElement
  for (const value of ['JJ/MM/AAAA', 'AAAA-MM-JJ', 'JJ-MM-AAAA', 'JJ.MM.AAAA']) dateFormat.append(option(value, value))
  dateFormat.value = mapping?.dateFormat ?? 'JJ/MM/AAAA'
  const decimal = el('select') as HTMLSelectElement
  decimal.append(option(',', 'Virgule'), option('.', 'Point'))
  decimal.value = mapping?.decimalSeparator ?? ','
  const mode = el('select') as HTMLSelectElement
  mode.append(option('signe', 'Montant signé'), option('debit-credit', 'Débit et crédit'))
  mode.value = mapping?.mode ?? 'signe'
  const amountHeader = field('Colonne montant', 'text', mapping?.mode === 'signe' ? mapping.amountHeader : 'Montant')
  const debitHeader = field('Colonne débit', 'text', mapping?.mode === 'debit-credit' ? mapping.debitHeader : 'Debit')
  const creditHeader = field('Colonne crédit', 'text', mapping?.mode === 'debit-credit' ? mapping.creditHeader : 'Credit')
  const openingAmount = field('Solde initial', 'text', openingInputValue(account ?? null))
  openingAmount.input.placeholder = account?.kind === 'epargne' ? '0,000' : '0,00'
  openingAmount.input.className = 'amount'
  const openingDate = field('Date d’ouverture', 'date', account?.openingDate ?? '')
  mappingBox.append(
    dateHeader.label,
    labelHeader.label,
    labeled('Format de date', dateFormat),
    labeled('Décimales', decimal),
    labeled('Montant', mode),
    amountHeader.label,
    debitHeader.label,
    creditHeader.label,
  )
  const openingBox = el('div', 'form-row')
  openingBox.append(openingAmount.label, openingDate.label)
  form.append(mappingBox, openingBox)
  const sync = () => {
    const courant = kind.value === 'courant'
    mappingBox.hidden = !courant
    openingBox.hidden = kind.value === 'titre'
    openingAmount.input.placeholder = kind.value === 'epargne' ? '0,000' : '0,00'
  }
  kind.addEventListener('change', sync)
  sync()
  form.append(
    button(account ? 'Enregistrer' : 'Créer', 'primary', async () => {
      const courant = kind.value === 'courant'
      const payload = {
        id: account?.id,
        name: name.input.value,
        bankName: readBank(),
        kind: kind.value,
        archived: account?.archived ?? false,
        mapping: courant
          ? ({
              dateHeader: dateHeader.input.value,
              labelHeader: labelHeader.input.value,
              dateFormat: dateFormat.value,
              decimalSeparator: decimal.value,
              mode: mode.value,
              amountHeader: amountHeader.input.value,
              debitHeader: debitHeader.input.value,
              creditHeader: creditHeader.input.value,
            } as Mapping)
          : null,
        openingAmount: openingAmount.input.value,
        openingDate: openingDate.input.value,
      }
      const saved = await ask(window.comptes.saveAccount(payload))
      if (!saved) {
        render()
        return
      }
      editing = false
      draftBank = null
      accountId = saved.id
      screen = 'account'
      notice = 'Compte enregistré.'
      await loadWorkspace()
      render()
    }),
  )
  form.addEventListener('submit', (event) => event.preventDefault())
  return form
}

function holdingsEditor(account: Account, summary: HoldingsSummary): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', 'Titres'))
  if (summary.positions.length === 0) card.append(el('p', 'empty', 'Aucun titre pour l’instant.'))
  const table = el('table', 'grid holdings')
  const head = el('tr')
  head.append(
    el('th', '', 'Nom'),
    el('th', 'num', 'Nombre'),
    el('th', 'num', 'Valeur'),
    el('th', 'num', 'Montant'),
    el('th', '', 'Date de valeur'),
    el('th'),
  )
  table.append(head)
  for (const position of summary.positions) {
    const name = textInput(position.name)
    const quantity = textInput(formatQuantity(position.quantityMicros))
    const value = amountInput(formatInputMillis(position.valueMillis))
    const valuedOn = dateInput(position.valuedOn || todayIso())
    const actions = el('div', 'toolbar')
    actions.append(
      button('Enregistrer', '', () => {
        void persistPosition(account.id, position.id, name.value, quantity.value, value.value, valuedOn.value)
      }),
      button('Retirer', 'danger', () => {
        void removePosition(position)
      }),
    )
    const row = el('tr')
    row.append(
      cell(name),
      cell(quantity),
      cell(value),
      millisCell(lineMillis(position.quantityMicros, position.valueMillis)),
      cell(valuedOn),
      cell(actions),
    )
    table.append(row)
  }
  const cash = amountInput(formatInputMillis(summary.cashMillis))
  const cashDate = dateInput(summary.cashValuedOn || todayIso())
  const cashActions = el('div', 'toolbar')
  cashActions.append(
    button('Enregistrer', '', () => {
      void persistCash(account.id, cash.value, cashDate.value)
    }),
  )
  const cashRow = el('tr')
  cashRow.append(el('td', '', 'Disponible au comptant'), el('td'), el('td'), cell(cash), cell(cashDate), cell(cashActions))
  table.append(cashRow)
  table.append(holdingTotal('Solde des titres', summary.securitiesMillis))
  table.append(holdingTotal('Solde global', summary.totalMillis))
  card.append(wrap(table))
  const name = field('Nom', 'text', '')
  name.input.placeholder = 'Nom du titre'
  const quantity = field('Nombre', 'text', '')
  const value = field('Valeur', 'text', '')
  value.input.className = 'amount'
  value.input.placeholder = '0,000'
  value.input.inputMode = 'decimal'
  value.input.addEventListener('focus', () => value.input.select())
  const valuedOn = field('Date de valeur', 'date', todayIso())
  const add = el('div', 'form-row')
  add.append(
    name.label,
    quantity.label,
    value.label,
    valuedOn.label,
    button('Ajouter', 'primary', () => {
      void persistPosition(
        account.id,
        undefined,
        name.input.value,
        quantity.input.value,
        value.input.value,
        valuedOn.input.value,
      )
    }),
  )
  card.append(add)
  return card
}

function holdingTotal(label: string, millis: number): HTMLElement {
  const row = el('tr', 'total')
  row.append(el('td', '', label), el('td'), el('td'), millisCell(millis), el('td'), el('td'))
  return row
}

async function persistCash(accountId: number, raw: string, valuedOn: string): Promise<void> {
  await follow(async () => {
    const saved = await ask(window.comptes.setCash(accountId, raw, valuedOn))
    if (saved === null) {
      render()
      return
    }
    notice = 'Disponible enregistré.'
    await loadWorkspace()
    render()
  })
}

async function persistPosition(
  accountId: number,
  id: number | undefined,
  name: string,
  quantity: string,
  value: string,
  valuedOn: string,
): Promise<void> {
  await follow(async () => {
    const saved = await ask(window.comptes.savePosition({ accountId, id, name, quantity, value, valuedOn }))
    if (!saved) {
      render()
      return
    }
    notice = 'Titre enregistré.'
    await loadWorkspace()
    render()
  })
}

async function removePosition(position: Position): Promise<void> {
  if (!confirm(`Retirer ${position.name} ?`)) return
  await follow(async () => {
    const removed = await ask(window.comptes.deletePosition(position.id))
    if (removed === null) {
      render()
      return
    }
    notice = 'Titre retiré.'
    await loadWorkspace()
    render()
  })
}

function categoryBlock(
  title: string,
  families: StatementSummary['expenseFamilies'],
  unpointed: number[],
  totals: number[],
  nature: Nature,
): HTMLElement {
  const box = el('div')
  if (title) box.append(el('h3', '', title))
  const table = el('table', 'grid')
  table.append(monthHead(true))
  for (const family of families) {
    table.append(amountRow(family.name, family.months, 'family', true))
    for (const category of family.categories) table.append(categoryDrillRow(category, nature))
  }
  table.append(unpointedDrillRow(unpointed, nature))
  table.append(amountRow('Total', totals, 'total', true))
  box.append(wrap(table))
  return box
}

function categoryDrillRow(category: CategoryRow, nature: Nature): HTMLElement {
  const row = el('tr', 'category')
  const name = el('td', 'indent')
  name.append(
    button(category.name, `link${drillMatches(category.categoryId, nature, null) ? ' active' : ''}`, () =>
      openDrill({ categoryId: category.categoryId, nature, name: category.name, month: null }),
    ),
  )
  row.append(name)
  row.append(yearDrillCell(category.months, drillMatches(category.categoryId, nature, null), () =>
    openDrill({ categoryId: category.categoryId, nature, name: category.name, month: null }),
  ))
  category.months.forEach((value, index) => {
    row.append(drillAmount(value, drillMatches(category.categoryId, nature, index + 1), () =>
      openDrill({ categoryId: category.categoryId, nature, name: category.name, month: index + 1 }),
    ))
  })
  return row
}

function unpointedDrillRow(values: number[], nature: Nature): HTMLElement {
  const row = el('tr', 'unpointed')
  const name = el('td')
  name.append(
    button('Non pointé', `link${drillMatches(null, nature, null) ? ' active' : ''}`, () =>
      openDrill({ categoryId: null, nature, name: 'Non pointé', month: null }),
    ),
  )
  row.append(name)
  row.append(yearDrillCell(values, drillMatches(null, nature, null), () =>
    openDrill({ categoryId: null, nature, name: 'Non pointé', month: null }),
  ))
  values.forEach((value, index) => {
    row.append(drillAmount(value, drillMatches(null, nature, index + 1), () =>
      openDrill({ categoryId: null, nature, name: 'Non pointé', month: index + 1 }),
    ))
  })
  return row
}

function drillAmount(cents: number, active: boolean, onClick: () => void): HTMLElement {
  const cell = el('td', `num${cents < 0 ? ' neg' : ''}`)
  if (cents === 0) {
    cell.textContent = formatEuros(cents)
    return cell
  }
  cell.append(button(formatEuros(cents), `amount link${active ? ' active' : ''}`, onClick))
  return cell
}

function drillMatches(categoryId: number | null, nature: Nature, month: number | null): boolean {
  return drill !== null && drill.categoryId === categoryId && drill.nature === nature && drill.month === month
}

function openDrill(next: Drill): void {
  drill = drillMatches(next.categoryId, next.nature, next.month) ? null : next
  render()
}

function drillPanel(): HTMLElement {
  const panel = el('section', 'drill')
  const current = drill
  const head = el('div', 'drill-head')
  const title = !current
    ? ''
    : current.month === null
      ? `${current.name} · ${year}`
      : `${current.name} · ${MONTH_LABELS[current.month - 1]} ${year}`
  head.append(el('h2', '', title), button('Fermer', '', () => { drill = null; render() }))
  panel.append(head)
  const operations = operationsForDrill()
  if (operations.length === 0) {
    panel.append(el('p', 'empty', 'Aucune opération.'))
    return panel
  }
  const total = operations.reduce((sum, operation) => {
    if (current?.categoryId === null && current.nature === 'depense') return sum + Math.abs(operation.amountCents)
    return sum + operation.amountCents
  }, 0)
  panel.append(el('p', 'muted', `${operations.length} ${operations.length > 1 ? 'opérations' : 'opération'} · ${formatEuros(total)}`))
  const table = el('table', 'grid')
  const columns = el('tr')
  for (const label of ['Date', 'Libellé', 'Montant']) columns.append(el('th', label === 'Montant' ? 'num' : '', label))
  table.append(columns)
  for (const operation of operations) {
    const row = el('tr')
    const labelCell = el('td', 'label')
    labelCell.append(el('div', 'label-text', operation.label))
    row.append(el('td', '', formatIsoDate(operation.date)), labelCell, moneyCell(operation.amountCents))
    table.append(row)
  }
  panel.append(wrap(table))
  return panel
}

function operationsForDrill(): OperationView[] {
  const current = drill
  if (!current || !detail) return []
  const prefix = current.month === null ? null : `${year}-${String(current.month).padStart(2, '0')}`
  return detail.operations.filter((operation) => {
    if (prefix && !operation.date.startsWith(prefix)) return false
    if (current.categoryId === null) {
      if (operation.categoryId !== null) return false
      return current.nature === 'depense' ? operation.amountCents < 0 : operation.amountCents > 0
    }
    return operation.categoryId === current.categoryId
  })
}

async function saveOpening(account: Account, amount: string, date: string): Promise<void> {
  const saved = await ask(
    window.comptes.saveAccount({
      id: account.id,
      name: account.name,
      bankName: account.bankName,
      kind: account.kind,
      archived: account.archived,
      mapping: account.mapping,
      openingAmount: amount,
      openingDate: date,
    }),
  )
  if (!saved) {
    render()
    return
  }
  notice = 'Solde initial enregistré.'
  await loadWorkspace()
  if (screen !== 'account') return
  await loadDetail()
  render()
}

function movementEditor(account: Account): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', 'Mouvements'))
  card.append(
    el(
      'p',
      'muted',
      account.kind === 'titre'
        ? 'Dividende, versement ou retrait. Le solde reporté en tient compte.'
        : 'Intérêts, versement ou retrait. Le solde est recalculé.',
    ),
  )
  const date = dateInput(todayIso())
  const label = textInput('')
  label.placeholder = 'Libellé'
  const amount = amountInput('')
  amount.placeholder = '0,000'
  const direction = el('select') as HTMLSelectElement
  direction.append(option('entree', 'Entrée'), option('sortie', 'Sortie'))
  const form = el('div', 'form-row')
  form.append(labeled('Date', date), labeled('Libellé', label), labeled('Montant', amount), labeled('Sens', direction))
  card.append(form)
  card.append(
    button('Ajouter', 'primary', () => {
      void addMovement(account.id, date.value, label.value, amount.value, direction.value === 'sortie' ? 'sortie' : 'entree')
    }),
  )
  const operations = detail?.operations ?? []
  if (operations.length === 0) card.append(el('p', 'empty', 'Aucun mouvement cette année.'))
  else card.append(movementTable(operations))
  return card
}

async function addMovement(
  accountId: number,
  date: string,
  label: string,
  amount: string,
  direction: 'entree' | 'sortie',
): Promise<void> {
  const saved = await ask(window.comptes.createSavingsMovement(accountId, date, label, amount, direction))
  if (saved === null) {
    render()
    return
  }
  notice = 'Mouvement enregistré.'
  await loadWorkspace()
  if (screen !== 'account') return
  await loadDetail()
  render()
}

function movementTable(operations: OperationView[]): HTMLElement {
  const table = el('table', 'grid')
  const head = el('tr')
  for (const label of ['Date', 'Libellé', 'Montant', '']) head.append(el('th', label === 'Montant' ? 'num' : '', label))
  table.append(head)
  for (const operation of operations) {
    const row = el('tr')
    if (editingOperationId === operation.id) {
      const date = dateInput(operation.date)
      const label = textInput(operation.label)
      const amount = amountInput(formatInputMillis(operation.amountCents))
      row.append(cell(date), cell(label), cell(amount), operationActions(operation, { date, label, amount }))
    } else {
      row.append(el('td', '', formatIsoDate(operation.date)), el('td', '', operation.label), millisCell(operation.amountCents))
      row.append(operationActions(operation))
    }
    table.append(row)
  }
  return wrap(table)
}

function transferEditor(account: Account): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', 'Virements'))
  card.append(el('p', 'muted', 'Sortie vers un autre compte. Le destinataire reçoit le mouvement, et le solde affiché est recalculé.'))
  const targets = transferTargets(account.id)
  const date = dateInput(todayIso())
  const amount = amountInput('')
  amount.placeholder = '0,00'
  const target = el('select') as HTMLSelectElement
  target.append(option('', 'Choisir'))
  for (const item of targets) target.append(option(String(item.id), `${item.name} · ${item.bankName}`))
  const form = el('div', 'form-row')
  form.append(labeled('Date', date), labeled('Montant', amount), labeled('Vers le compte', target))
  card.append(form)
  card.append(
    button('Virer', 'primary', async () => {
      if (!target.value) {
        notice = 'Choisis le compte du virement.'
        render()
        return
      }
      const matches = await ask(window.comptes.previewSavingsTransfer(Number(target.value), date.value, amount.value))
      if (matches === null) {
        render()
        return
      }
      const matched = await chooseTransferMatch(target.selectedOptions[0]?.textContent ?? 'Ce compte', matches)
      const saved = await ask(
        window.comptes.createTransfer(account.id, Number(target.value), date.value, amount.value, matched),
      )
      if (saved === null) {
        render()
        return
      }
      notice = 'Virement enregistré.'
      await loadWorkspace()
      render()
    }),
  )
  const transfers = detail?.transfers ?? []
  if (transfers.length === 0) card.append(el('p', 'empty', 'Aucun virement cette année.'))
  else {
    const table = el('table', 'grid')
    const head = el('tr')
    for (const label of ['Date', 'Sens', 'Compte', 'Montant', '']) head.append(el('th', label === 'Montant' ? 'num' : '', label))
    table.append(head)
    for (const transfer of transfers) {
      const outgoing = transfer.fromAccountId === account.id
      const other = outgoing
        ? `${transfer.toAccountName} · ${transfer.toBankName}`
        : `${transfer.fromAccountName} · ${transfer.fromBankName}`
      const row = el('tr')
      row.append(el('td', '', formatIsoDate(transfer.date)), el('td', '', outgoing ? 'Vers' : 'De'), el('td', '', other))
      row.append(moneyCell(outgoing ? -transfer.amountCents : transfer.amountCents))
      const action = el('td')
      action.append(
        button('Retirer', 'danger', async () => {
          const removed = await ask(window.comptes.deleteTransfer(transfer.id))
          if (removed === null) {
            render()
            return
          }
          notice = 'Virement retiré.'
          await loadWorkspace()
          render()
        }),
      )
      row.append(action)
      table.append(row)
    }
    card.append(wrap(table))
  }
  return card
}

function transferTargets(exceptId: number): AccountCard[] {
  return (workspace?.accounts ?? []).filter(
    (item) => !item.archived && item.id !== exceptId && (item.kind === 'courant' || item.kind === 'epargne'),
  )
}

function renderBatches(batches: BatchView[], account: Account): HTMLElement {
  const card = el('section', 'card')
  const head = el('div', 'section-head')
  head.append(
    el('h2', '', 'Imports'),
    button('Importer un relevé', 'primary', () => { void startImport(account.id) }),
  )
  card.append(head)
  if (batches.length === 0) card.append(el('p', 'empty', 'Aucun import.'))
  for (const batch of batches) {
    const row = el('div', 'toolbar')
    row.append(el('span', '', `${batch.filename} · ${batch.count} lignes · ${batch.importedAt.slice(0, 16).replace('T', ' ')}`))
    row.append(
      button('Annuler cet import', 'danger', async () => {
        if (!window.confirm(`Retirer les ${batch.count} lignes de cet import ?`)) return
        const removed = await ask(window.comptes.cancelBatch(batch.id))
        if (removed === null) {
          render()
          return
        }
        notice = `${removed} lignes retirées.`
        await loadWorkspace()
        render()
      }),
    )
    card.append(row)
  }
  return card
}

function renderOperations(operations: OperationView[], accountId: number): HTMLElement {
  const card = el('section', 'card')
  const head = el('div', 'section-head')
  const edit = glyphButton('Modifier les opérations', 'edit', () => {
    operationsEdit = !operationsEdit
    if (!operationsEdit) editingOperationId = null
    render()
  })
  if (operationsEdit) edit.classList.add('active')
  edit.setAttribute('aria-pressed', String(operationsEdit))
  head.append(el('h2', '', `Opérations ${year}`), edit)
  card.append(head)
  if (operations.length === 0) card.append(el('p', 'empty', 'Aucune opération sur cette année.'))
  else {
    const table = el('table', 'grid')
    const headRow = el('tr')
    for (const label of ['Date', 'Libellé', 'Montant', 'Catégorie', '']) {
      headRow.append(el('th', label === 'Catégorie' ? 'point' : '', label))
    }
    table.append(headRow)
    for (const operation of operations) {
      const row = el('tr')
      if (operationsEdit && editingOperationId === operation.id) {
        const date = dateInput(operation.date)
        const label = textInput(operation.label)
        const amount = amountInput(formatInputAmount(operation.amountCents))
        row.append(cell(date), cell(label), cell(amount))
        row.append(el('td'), operationActions(operation, { date, label, amount }))
      } else {
        row.append(el('td', '', formatIsoDate(operation.date)), el('td', '', operation.label))
        row.append(moneyCell(operation.amountCents))
        row.append(
          pointCell(
            operation.amountCents,
            operation.categoryId,
            operation.categoryName,
            operation.id,
            accountId,
            operation.counterpartyAccountId,
            loadDetail,
          ),
          operationActions(operation),
        )
      }
      table.append(row)
    }
    card.append(wrap(table))
  }
  return card
}

function renderPreview(id: number): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', 'Aperçu de l’import'))
  if (preview?.status === 'choose-sheet') {
    const select = el('select') as HTMLSelectElement
    for (const sheet of preview.sheets) select.append(option(sheet, sheet))
    card.append(labeled('Feuille', select))
    card.append(
      button('Lire cette feuille', 'primary', async () => {
        importSheet = select.value
        preview = await ask(window.comptes.previewImport(id, importFile as string, importSheet))
        render()
      }),
    )
    return card
  }
  if (preview?.status === 'blocked') {
    card.append(el('p', '', `En-tête manquant : ${preview.missing.join(', ')}`))
    card.append(el('p', 'muted', `En-têtes trouvés : ${preview.foundHeaders.join(', ') || 'aucun'}`))
    return card
  }
  if (preview?.status === 'error') {
    card.append(el('p', '', preview.message))
    return card
  }
  if (preview?.status === 'ok') {
    card.append(el('p', '', `${preview.ready} prêtes, ${preview.duplicate} déjà présentes, ${preview.rejected} rejetées.`))
    const table = el('table', 'grid')
    const head = el('tr')
    for (const label of ['Ligne', 'État', 'Date', 'Libellé', 'Montant', 'Motif']) head.append(el('th', '', label))
    table.append(head)
    for (const line of preview.lines) {
      const row = el('tr')
      row.append(
        el('td', '', String(line.line)),
        el('td', `status-${line.status}`, line.status === 'ready' ? 'prête' : line.status === 'duplicate' ? 'déjà présente' : 'rejetée'),
        el('td', '', line.date ? formatIsoDate(line.date) : ''),
        el('td', '', line.label ?? ''),
        line.amountCents === undefined ? el('td', '') : moneyCell(line.amountCents),
        el('td', '', line.reason ?? ''),
      )
      table.append(row)
    }
    card.append(wrap(table))
    if (preview.ready > 0) {
      card.append(
        button(`Importer ${preview.ready} lignes`, 'primary', async () => {
          const done = await ask(window.comptes.confirmImport(id, importFile as string, importSheet || undefined))
          if (!done) {
            render()
            return
          }
          preview = null
          importFile = null
          notice = 'Import enregistré.'
          await loadWorkspace()
          render()
        }),
      )
    }
  }
  return card
}

function renderPointing(): HTMLElement {
  const page = el('div', 'pointing')
  page.append(el('h1', '', 'Pointage'))
  const select = el('select') as HTMLSelectElement
  select.append(option('', 'Tous les comptes'))
  for (const account of (workspace?.accounts ?? []).filter((item) => !item.archived && item.kind === 'courant')) {
    select.append(option(String(account.id), `${account.name} · ${account.bankName}`))
  }
  select.value = pointFilter === null ? '' : String(pointFilter)
  select.addEventListener('change', async () => {
    pointFilter = select.value ? Number(select.value) : null
    await loadUnpointed()
    render()
  })
  page.append(labeled('Compte', select))
  if (unpointed.length === 0) page.append(el('p', 'empty', 'Tout est pointé.'))
  const table = el('table', 'grid')
  const head = el('tr')
  for (const label of ['Date', 'Compte', 'Libellé', 'Montant', 'Catégorie']) {
    head.append(el('th', label === 'Libellé' ? 'label' : label === 'Catégorie' ? 'point' : '', label))
  }
  table.append(head)
  for (const row of unpointed) {
    const line = el('tr')
    const labelCell = el('td', 'label')
    labelCell.append(el('div', 'label-text', row.label))
    line.append(el('td', '', formatIsoDate(row.date)), el('td', '', `${row.accountName} · ${row.bankName}`), labelCell, moneyCell(row.amountCents))
    line.append(pointCell(row.amountCents, row.suggestedCategoryId, null, row.id, row.accountId, null, async () => {
      await loadUnpointed()
      if (screen === 'account') await loadDetail()
    }))
    table.append(line)
  }
  if (unpointed.length > 0) page.append(el('div', 'card', wrap(table)))
  return page
}

function renderCategories(): HTMLElement {
  const page = el('div')
  page.append(el('h1', '', 'Catégories'))
  const creator = el('form', 'card')
  const name = field('Nouvelle famille', 'text', '')
  const nature = el('select') as HTMLSelectElement
  nature.append(option('depense', 'Dépense'), option('encaissement', 'Encaissement'))
  const creatorRow = el('div', 'form-row', name.label, labeled('Nature', nature))
  creatorRow.append(
    glyphButton('Ajouter la famille', 'plus', async () => {
      const saved = await ask(window.comptes.saveFamily({ name: name.input.value, nature: nature.value, archived: false }))
      if (!saved) {
        render()
        return
      }
      await loadWorkspace()
      render()
    }, 'primary'),
  )
  creator.append(creatorRow)
  creator.addEventListener('submit', (event) => event.preventDefault())
  page.append(creator)
  const columns = el('div', 'category-columns')
  columns.append(familyColumn('Dépenses', 'depense'), familyColumn('Encaissements', 'encaissement'))
  page.append(columns)
  return page
}

function familyColumn(title: string, nature: Nature): HTMLElement {
  const column = el('section')
  column.append(el('h2', '', title))
  const families = (workspace?.families ?? []).filter((family) => family.nature === nature)
  if (families.length === 0) column.append(el('p', 'empty', 'Aucune famille.'))
  for (const family of families) column.append(familyCard(family))
  return column
}

function familyCard(family: Family): HTMLElement {
  const card = el('section', 'card family-card')
  const name = textInput(family.name)
  const line = el('div', 'family-line')
  line.append(inlineLabel('Famille :', name), totalAmount(familyTotal(family)))
  line.append(glyphButton('Haut', 'up', () => move('family', family.id, -1)))
  line.append(glyphButton('Bas', 'down', () => move('family', family.id, 1)))
  line.append(
    glyphButton('Enregistrer', 'check', async () => {
      await ask(window.comptes.saveFamily({ id: family.id, name: name.value, archived: family.archived }))
      await loadWorkspace()
      render()
    }, 'primary'),
  )
  line.append(
    glyphButton(family.archived ? 'Réactiver' : 'Archiver', family.archived ? 'restore' : 'archive', async () => {
      if (!family.archived && !window.confirm(`Archiver la famille ${family.name} ?`)) return
      await ask(window.comptes.saveFamily({ id: family.id, name: name.value, archived: !family.archived }))
      await loadWorkspace()
      render()
    }, family.archived ? '' : 'danger'),
  )
  card.append(line)
  const list = el('ul', 'category-list')
  for (const category of family.categories) {
    const categoryName = textInput(category.name)
    categoryName.setAttribute('aria-label', 'Nom de la catégorie')
    const targets = (workspace?.families ?? []).filter((item) => item.nature === family.nature && item.id !== family.id)
    const moving = movingCategoryId === category.id
    const moveButton = glyphButton('Déplacer', 'move', () => {
      if (targets.length === 0) {
        notice = 'Aucune autre famille de cette nature.'
        render()
        return
      }
      movingCategoryId = moving ? null : category.id
      render()
    })
    if (moving) moveButton.classList.add('active')
    moveButton.setAttribute('aria-expanded', String(moving))
    const amount = totalAmount(categoryTotal(category.id))
    const row = el('div', 'category-line')
    row.append(categoryName, amount, moveButton)
    row.append(glyphButton('Haut', 'up', () => move('category', category.id, -1)))
    row.append(glyphButton('Bas', 'down', () => move('category', category.id, 1)))
    row.append(
      glyphButton('Enregistrer', 'check', async () => {
        await saveCategoryLine(category, categoryName.value, family.id)
      }, 'primary'),
    )
    row.append(
      glyphButton(category.archived ? 'Réactiver' : 'Archiver', category.archived ? 'restore' : 'archive', async () => {
        if (!category.archived && !window.confirm(`Archiver la catégorie ${category.name} ?`)) return
        await saveCategoryLine(category, categoryName.value, family.id, !category.archived)
      }, category.archived ? '' : 'danger'),
    )
    const item = el('li', '', row)
    if (moving) {
      const choices = el('div', 'move-choices')
      for (const target of targets) {
        const label = target.archived ? `${target.name} (archivée)` : target.name
        choices.append(button(label, 'small', () => { void saveCategoryLine(category, categoryName.value, target.id) }))
      }
      item.append(choices)
    }
    list.append(item)
  }
  card.append(list)
  const add = textInput('')
  add.placeholder = 'Nouvelle catégorie'
  add.setAttribute('aria-label', 'Nouvelle catégorie')
  const addRow = el('div', 'category-add')
  addRow.append(add)
  addRow.append(
    glyphButton('Ajouter', 'plus', async () => {
      const saved = await ask(window.comptes.saveCategory({ name: add.value, familyId: family.id, archived: false }))
      if (!saved) {
        render()
        return
      }
      await loadWorkspace()
      render()
    }, 'primary'),
  )
  card.append(addRow)
  return card
}

function categoryTotal(categoryId: number): number {
  return workspace?.categoryTotals.find((item) => item.categoryId === categoryId)?.totalCents ?? 0
}

function familyTotal(family: Family): number {
  return family.categories.reduce((sum, category) => sum + categoryTotal(category.id), 0)
}

function totalAmount(cents: number): HTMLElement {
  const amount = el('span', `category-total${cents < 0 ? ' neg' : cents === 0 ? ' muted' : ''}`, formatEuros(cents))
  amount.title = `Total ${year}`
  return amount
}

async function saveCategoryLine(category: Category, name: string, familyId: number, archived = category.archived): Promise<void> {
  const saved = await ask(window.comptes.saveCategory({ id: category.id, name, familyId, archived }))
  if (!saved) {
    render()
    return
  }
  movingCategoryId = null
  await loadWorkspace()
  render()
}

function operationActions(
  operation: OperationView,
  editing?: { date: HTMLInputElement; label: HTMLInputElement; amount: HTMLInputElement },
): HTMLElement {
  const actions = el('td', 'actions')
  if (editing) {
    actions.append(
      button('Enregistrer', 'small', () => {
        void saveManual(operation.id, editing.date.value, editing.label.value, editing.amount.value)
      }),
      button('Annuler', 'small', () => {
        editingOperationId = null
        void loadDetail()
      }),
    )
    return actions
  }
  if (operation.categoryId !== null) {
    actions.append(unpointButton(() => {
      void clearPoint(operation.id)
    }))
  }
  if (operationsEdit) {
    actions.append(
      button('Modifier', 'small', () => {
        editingOperationId = operation.id
        render()
      }),
      button('Effacer', 'small danger', () => {
        void eraseManual(operation)
      }),
    )
  }
  return actions
}

async function chooseTransferMatch(accountLabel: string, matches: TransferMatch[]): Promise<number | null> {
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const line = `${formatIsoDate(match.date)} · ${match.label} · ${formatEuros(match.amountCents)}`
    const suffix = index === matches.length - 1 ? '\n\nSinon, une nouvelle ligne sera créée.' : ''
    if (window.confirm(`${accountLabel} a déjà cette ligne :\n${line}\n\nC’est ce virement ?${suffix}`)) return match.id
  }
  return null
}

async function clearPoint(operationId: number): Promise<void> {
  const saved = await ask(window.comptes.unpointOperation(operationId))
  if (saved === null) {
    render()
    return
  }
  await loadDetail()
  await loadWorkspace()
  render()
}

async function saveManual(operationId: number, date: string, label: string, amount: string): Promise<void> {
  const saved = await ask(window.comptes.updateManualOperation(operationId, date, label, amount))
  if (saved === null) {
    render()
    return
  }
  editingOperationId = null
  await loadDetail()
  await loadWorkspace()
  render()
}

async function eraseManual(operation: OperationView): Promise<void> {
  if (!window.confirm(`Effacer « ${operation.label} » ?`)) return
  const saved = await ask(window.comptes.deleteManualOperation(operation.id))
  if (saved === null) {
    render()
    return
  }
  editingOperationId = null
  await loadDetail()
  await loadWorkspace()
  render()
}

function pointCell(
  amountCents: number,
  currentId: number | null,
  currentName: string | null,
  operationId: number,
  accountId: number,
  counterpartyAccountId: number | null,
  after: () => Promise<void>,
): HTMLElement {
  const choice = categorySelect(amountCents, currentId, currentName)
  const target = el('select') as HTMLSelectElement
  target.className = 'transfer-target'
  target.append(option('', amountCents < 0 ? 'Vers le compte' : 'Depuis le compte'))
  for (const item of transferTargets(accountId)) target.append(option(String(item.id), `${item.name} · ${item.bankName}`))
  if (counterpartyAccountId) target.value = String(counterpartyAccountId)
  const sync = () => {
    target.hidden = categoryRole(choice.value) !== 'virement'
  }
  choice.addEventListener('change', sync)
  sync()
  const cell = el('td', 'point')
  const rowBox = el('div', 'point-row')
  rowBox.append(
    choice,
    target,
    iconButton('Pointer', async () => {
      if (!choice.value) {
        notice = 'Choisis une catégorie.'
        render()
        return
      }
      const virement = categoryRole(choice.value) === 'virement'
      if (virement && !target.value) {
        notice = amountCents < 0 ? 'Choisis le compte destinataire.' : 'Choisis le compte d’origine.'
        render()
        return
      }
      let matched: number | null = null
      if (virement) {
        const matches = await ask(window.comptes.previewOperationTransfer(operationId, Number(target.value)))
        if (matches === null) {
          render()
          return
        }
        matched = await chooseTransferMatch(target.selectedOptions[0]?.textContent ?? 'Ce compte', matches)
      }
      const done = await ask(
        window.comptes.pointOperation(operationId, Number(choice.value), virement ? Number(target.value) : null, matched),
      )
      if (done === null) {
        render()
        return
      }
      await after()
      await loadWorkspace()
      render()
    }),
  )
  cell.append(rowBox)
  return cell
}

function categoryRole(categoryId: string): 'virement' | null {
  if (!categoryId) return null
  for (const family of workspace?.families ?? []) {
    const category = family.categories.find((item) => String(item.id) === categoryId)
    if (category) return category.role
  }
  return null
}

function categorySelect(amountCents: number, currentId: number | null, currentName: string | null): HTMLSelectElement {
  const nature = amountCents < 0 ? 'depense' : 'encaissement'
  const select = el('select') as HTMLSelectElement
  select.append(option('', 'Choisir'))
  let found = false
  for (const family of workspace?.families ?? []) {
    if (family.nature !== nature) continue
    const group = document.createElement('optgroup')
    group.label = family.archived ? `${family.name} (archivée)` : family.name
    for (const category of family.categories) {
      const visible = (!family.archived && !category.archived) || category.id === currentId
      if (!visible) continue
      const item = option(String(category.id), category.name)
      if (category.archived || family.archived) item.disabled = true
      group.append(item)
      if (category.id === currentId) found = true
    }
    if (group.childElementCount > 0) select.append(group)
  }
  if (currentId && !found) select.append(option(String(currentId), currentName ?? 'Catégorie archivée'))
  select.value = currentId ? String(currentId) : ''
  return select
}

async function startImport(id: number): Promise<void> {
  const file = await ask(window.comptes.pickImportFile())
  if (!file) {
    render()
    return
  }
  importFile = file
  importSheet = ''
  preview = await ask(window.comptes.previewImport(id, file))
  render()
}

async function archiveAccount(account: Account): Promise<void> {
  if (!account.archived && !window.confirm(`Archiver ${account.name} ?`)) return
  const saved = await ask(
    window.comptes.saveAccount({
      id: account.id,
      name: account.name,
      bankName: account.bankName,
      kind: account.kind,
      archived: !account.archived,
      mapping: account.mapping,
      openingAmount: openingInputValue(account),
      openingDate: account.openingDate ?? '',
    }),
  )
  if (!saved) {
    render()
    return
  }
  notice = account.archived ? 'Compte réactivé.' : 'Compte archivé.'
  await loadWorkspace()
  render()
}

async function eraseAccount(account: Account): Promise<void> {
  const label = `${account.name} · ${account.bankName}`
  if (!window.confirm(`Effacer ${label} ? Le compte et tout ce qu’il contient seront supprimés.`)) return
  const removed = await ask(window.comptes.deleteAccount(account.id))
  if (removed === null) {
    render()
    return
  }
  accountId = null
  detail = null
  editing = false
  screen = 'accounts'
  notice = 'Compte effacé.'
  await loadWorkspace()
  render()
}

async function reorderAccount(id: number, direction: -1 | 1): Promise<void> {
  const done = await ask(window.comptes.moveAccount(id, direction))
  if (done === null) {
    render()
    return
  }
  await loadWorkspace()
  render()
}

async function move(kind: 'family' | 'category', id: number, direction: -1 | 1): Promise<void> {
  const done =
    kind === 'family'
      ? await ask(window.comptes.moveFamily(id, direction))
      : await ask(window.comptes.moveCategory(id, direction))
  if (done === null) {
    render()
    return
  }
  await loadWorkspace()
  render()
}

async function go(next: Screen): Promise<void> {
  screen = next
  accountTab = 'depense'
  movingCategoryId = null
  operationsEdit = false
  editing = false
  draftBank = null
  preview = null
  notice = ''
  drill = null
  editingOperationId = null
  if (next !== 'account') detail = null
  await writes
  if (status.state === 'ready') await loadWorkspace()
  render()
}

async function openAccount(id: number): Promise<void> {
  accountId = id
  screen = 'account'
  accountTab = 'depense'
  operationsEdit = false
  editing = false
  editingOperationId = null
  draftBank = null
  preview = null
  notice = ''
  drill = null
  await loadDetail()
  render()
}

async function changeYear(next: number): Promise<void> {
  year = next
  drill = null
  await loadWorkspace()
  render()
}

function startNewAccount(bankName: string | null): void {
  accountId = null
  accountTab = 'depense'
  editing = true
  draftBank = bankName
  detail = null
  preview = null
  notice = ''
  screen = 'account'
  render()
}

function knownBanks(): string[] {
  const names = new Set((workspace?.accounts ?? []).map((account) => account.bankName))
  return [...names].sort((a, b) => a.localeCompare(b, 'fr'))
}

function monthHead(withTotal = false): HTMLElement {
  const row = el('tr')
  row.append(el('th', '', ''))
  if (withTotal) row.append(el('th', 'num year-total', 'Total'))
  for (const label of SHORT) row.append(el('th', 'num', label))
  return row
}

function bankHeading(name: string): HTMLElement {
  const row = el('tr', 'group')
  row.append(el('td', '', name))
  for (let index = 0; index < SHORT.length; index += 1) row.append(el('td'))
  return row
}

function bankGap(): HTMLElement {
  const row = el('tr', 'bank-gap')
  row.append(el('td'))
  for (let index = 0; index < SHORT.length; index += 1) row.append(el('td'))
  return row
}

function labelRow(label: string, className: string): HTMLElement {
  const row = el('tr', className)
  row.append(el('td', '', label))
  return row
}

function amountRow(label: string, values: readonly (number | null)[], className: string, withTotal = false): HTMLElement {
  const row = labelRow(label, className)
  if (withTotal) row.append(yearTotalCell(values))
  addAmounts(row, values)
  return row
}

function yearDrillCell(values: readonly number[], active: boolean, onClick: () => void): HTMLElement {
  const cell = drillAmount(yearTotal(values) ?? 0, active, onClick)
  cell.classList.add('year-total')
  return cell
}

function yearTotalCell(values: readonly (number | null)[]): HTMLElement {
  const total = yearTotal(values)
  const cell = total === null ? el('td', 'num') : moneyCell(total)
  cell.classList.add('year-total')
  return cell
}

function yearTotal(values: readonly (number | null)[]): number | null {
  if (values.every((value) => value === null)) return null
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function addAmounts(row: HTMLElement, values: readonly (number | null)[]): void {
  for (const value of values) row.append(value === null ? el('td', 'num') : moneyCell(value))
}

function kindLabel(kind: Account['kind']): string {
  if (kind === 'epargne') return 'Épargne'
  if (kind === 'titre') return 'Titre'
  return 'Courant'
}

function cell(content: Node): HTMLElement {
  const item = el('td')
  item.append(content)
  return item
}

function figure(label: string, cents: number | null): HTMLElement {
  return amountFigure(label, cents, formatEuros)
}

function figureMillis(label: string, millis: number | null): HTMLElement {
  return amountFigure(label, millis, formatMillis)
}

function amountFigure(label: string, amount: number | null, format: (value: number) => string): HTMLElement {
  const box = el('div')
  box.append(el('span', 'muted', label))
  box.append(amount === null ? el('span', 'figure muted', '—') : el('span', `figure${amount < 0 ? ' neg' : ''}`, format(amount)))
  return box
}

function millisCell(millis: number): HTMLElement {
  return el('td', `num${millis < 0 ? ' neg' : ''}`, formatMillis(millis))
}

function openingInputValue(account: Account | null): string {
  if (!account) return ''
  if (account.kind === 'epargne') return account.openingMillis === null ? '' : formatInputMillis(account.openingMillis)
  return account.openingCents === null ? '' : formatInputAmount(account.openingCents)
}

function displayCents(values: readonly (number | null)[], blankZero: boolean): (number | null)[] {
  return values.map((value) => {
    if (value === null) return null
    const cents = millisToCents(value)
    return blankZero && cents === 0 ? null : cents
  })
}

function moneyCell(cents: number): HTMLElement {
  return el('td', `num${cents < 0 ? ' neg' : ''}`, formatEuros(cents))
}

function wrap(table: HTMLElement): HTMLElement {
  const box = el('div', 'table-wrap')
  box.append(table)
  return box
}

function textInput(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  return input
}

function amountInput(value: string): HTMLInputElement {
  const input = textInput(value)
  input.className = 'amount'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.size = 12
  input.addEventListener('focus', () => input.select())
  return input
}

function dateInput(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'date'
  input.className = 'valued-on'
  input.value = value
  return input
}

function inlineLabel(text: string, control: HTMLElement): HTMLElement {
  const box = el('label', 'inline-label', text)
  box.append(control)
  return box
}

function field(label: string, type: string, value: string): { label: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input')
  input.type = type
  input.value = value
  const box = el('label', '', label)
  box.append(input)
  return { label: box, input }
}

function labeled(text: string, control: HTMLElement): HTMLElement {
  const box = el('label', '', text)
  box.append(control)
  return box
}

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement('option')
  item.value = value
  item.textContent = label
  return item
}

function plusButton(label: string, onClick: () => void): HTMLButtonElement {
  return glyphButton(label, 'plus', onClick)
}

function glyphButton(
  label: string,
  glyph: 'up' | 'down' | 'check' | 'plus' | 'archive' | 'restore' | 'back' | 'move' | 'edit' | 'print' | 'pdf',
  onClick: () => void,
  tone = '',
): HTMLButtonElement {
  const marks: Record<typeof glyph, string> = {
    up: '<path d="M3.5 10.5 8 6 12.5 10.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    down: '<path d="M3.5 5.5 8 10 12.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="M3 8.5 6.2 12 13 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    archive:
      '<path d="M2.5 6.2h11M3.6 6.2V13h8.8V6.2M6.2 9.2h3.6M2.5 6.2 4.2 3.2h7.6l1.7 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    restore:
      '<path d="M3.2 8a4.4 4.4 0 1 0 1.2-3.1M3 3.2v3.3h3.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    back: '<path d="M10 3.5 5.5 8 10 12.5M5.5 8H13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    move: '<path d="M2 8h6.2M6 5.2 8.8 8 6 10.8M10.2 3.2H13v9.6h-2.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    edit: '<path d="M9.2 2.6 13.4 6.8 6.2 14H2.2v-4.1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    print:
      '<path d="M4.2 6.2V2.6h7.6v3.6M2.8 6.2h10.4v5H2.8zM5 9.4h6v4H5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    pdf: '<path d="M4 2.2h5.2L12.8 6V14H4zM9 2.6V6h3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  }
  const item = document.createElement('button')
  item.type = 'button'
  item.className = tone ? `icon ${tone}` : 'icon'
  item.title = label
  item.setAttribute('aria-label', label)
  item.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${marks[glyph]}</svg>`
  item.addEventListener('click', onClick)
  return item
}

function unpointButton(onClick: () => void): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'icon alert'
  item.title = 'Ôter le pointage'
  item.setAttribute('aria-label', 'Ôter le pointage')
  item.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  item.addEventListener('click', onClick)
  return item
}

function iconButton(label: string, onClick: () => void): HTMLButtonElement {
  return glyphButton(label, 'check', onClick, 'primary')
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = className
  item.textContent = label
  item.addEventListener('click', onClick)
  return item
}

function el(tag: string, className = '', ...content: Array<string | Node>): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  for (const item of content) node.append(item)
  return node
}
