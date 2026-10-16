import { MONTH_LABELS, formatEuros, formatInputAmount, formatIsoDate } from '../format.ts'
import type {
  Account,
  AccountSummary,
  BalanceSummary,
  BatchView,
  CategoryRow,
  Family,
  GlobalSummary,
  Mapping,
  Nature,
  OperationView,
  Preview,
  StatementSummary,
  UnpointedView,
} from '../types.ts'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

type Status = { state: 'setup' } | { state: 'error'; message: string } | { state: 'ready'; databasePath: string }

type AccountCard = Account & {
  currentCents: number | null
  unpointedCents: number | null
}

type Workspace = {
  year: number
  databasePath: string | null
  accounts: AccountCard[]
  families: Family[]
  global: GlobalSummary
}

type Detail = {
  account: Account | null
  summary: AccountSummary
  operations: OperationView[]
  batches: BatchView[]
}

type Screen = 'global' | 'accounts' | 'account' | 'pointing' | 'categories'

type ComptesApi = {
  status: () => Promise<Result<Status>>
  createDefault: () => Promise<Result<string>>
  createAt: () => Promise<Result<string | null>>
  openAt: () => Promise<Result<string | null>>
  exportCopy: () => Promise<Result<string | null>>
  workspace: (year: number) => Promise<Result<Workspace>>
  accountDetail: (id: number, year: number) => Promise<Result<Detail>>
  saveAccount: (input: unknown) => Promise<Result<Account>>
  saveFamily: (input: unknown) => Promise<Result<unknown>>
  moveFamily: (id: number, direction: -1 | 1) => Promise<Result<unknown>>
  saveCategory: (input: unknown) => Promise<Result<unknown>>
  moveCategory: (id: number, direction: -1 | 1) => Promise<Result<unknown>>
  setMonthlyBalance: (accountId: number, month: string, raw: string) => Promise<Result<unknown>>
  pickImportFile: () => Promise<Result<string | null>>
  previewImport: (accountId: number, filePath: string, sheetName?: string) => Promise<Result<Preview>>
  confirmImport: (accountId: number, filePath: string, sheetName?: string) => Promise<Result<unknown>>
  cancelBatch: (batchId: number) => Promise<Result<number>>
  unpointed: (accountId: number | null) => Promise<Result<UnpointedView[]>>
  pointOperation: (operationId: number, categoryId: number) => Promise<Result<unknown>>
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
let showArchived = false
let status: Status = { state: 'setup' }
let workspace: Workspace | null = null
let detail: Detail | null = null
let unpointed: UnpointedView[] = []
let pointFilter: number | null = null
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
  if (event.key !== 'Escape' || !drill) return
  drill = null
  render()
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
  app.replaceChildren()
  if (status.state !== 'ready') {
    app.append(setupScreen())
    return
  }
  const shell = el('div', 'app')
  shell.append(sidebar(), main())
  app.append(shell)
  if (screen === 'account' && drill) app.append(drillPanel())
}

function setupScreen(): HTMLElement {
  const page = el('div', 'setup card')
  page.append(el('h1', '', 'Comptes'))
  page.append(
    el(
      'p',
      '',
      'Les comptes de la famille, sur ce Mac. La base reste dans les données de l’application, sauf si tu choisis un autre fichier.',
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
  page.append(el('h1', '', `Tableau global ${year}`))
  page.append(moneyBlock('Dépenses', global, 'expense'))
  page.append(moneyBlock('Encaissements', global, 'income'))
  page.append(moneyBlock('Soldes', global, 'balance'))
  return page
}

function moneyBlock(
  title: string,
  global: GlobalSummary,
  field: 'expense' | 'income' | 'balance',
): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', title))
  if (global.banks.length === 0) {
    card.append(el('p', 'empty', 'Aucun compte.'))
    return card
  }
  const table = el('table', 'grid')
  table.append(monthHead())
  for (const bank of global.banks) {
    table.append(labelRow(bank.bankName, 'group'))
    for (const account of bank.accounts) {
      const row = labelRow('', 'account')
      const name = button(account.accountName, 'link', () => openAccount(account.accountId))
      row.querySelector('td')?.append(name)
      addAmounts(row, account[field])
      table.append(row)
    }
    table.append(amountRow(`Total ${bank.bankName}`, bank[field], 'total'))
  }
  table.append(amountRow('Total', global[field], 'total'))
  card.append(wrap(table))
  return card
}

function renderAccounts(): HTMLElement {
  const page = el('div')
  page.append(el('h1', '', 'Comptes'))
  const tools = el('div', 'toolbar')
  tools.append(
    button('Nouveau compte', 'primary', () => {
      accountId = null
      editing = true
      detail = null
      screen = 'account'
      render()
    }),
    button(showArchived ? 'Masquer les archivés' : 'Afficher les archivés', '', () => {
      showArchived = !showArchived
      render()
    }),
  )
  page.append(tools)
  const accounts = (workspace?.accounts ?? []).filter((account) => showArchived || !account.archived)
  if (accounts.length === 0) page.append(el('p', 'empty', 'Aucun compte pour l’instant.'))
  let bank = ''
  let row: HTMLElement | null = null
  const list = el('div', 'account-list')
  for (const account of accounts) {
    if (account.bankName !== bank) {
      bank = account.bankName
      const group = el('section')
      group.append(el('h2', '', bank))
      row = el('div', 'account-bank')
      group.append(row)
      list.append(group)
    }
    const card = button('', 'account-card', () => openAccount(account.id))
    const head = el('div', 'account-card-top')
    head.append(el('strong', '', account.name), el('span', 'muted', account.kind === 'releve' ? 'Relevé' : 'Solde'))
    const figures = el('div', 'account-figures')
    figures.append(figure('Solde courant', account.currentCents), figure('Solde non pointé', account.unpointedCents))
    card.append(head, figures)
    row?.append(card)
  }
  page.append(list)
  return page
}

function renderAccount(): HTMLElement {
  const page = el('div')
  const account = detail?.account ?? null
  const creating = editing && !account
  page.append(el('h1', '', creating ? 'Nouveau compte' : (account?.name ?? 'Compte')))
  page.append(button('Retour aux comptes', 'link', () => go('accounts')))
  if (creating || editing) page.append(accountForm(account))
  if (!account || !detail) return page
  const tools = el('div', 'toolbar')
  if (!editing) tools.append(button('Modifier', '', () => { editing = true; render() }))
  tools.append(
    button(account.archived ? 'Réactiver' : 'Archiver', 'danger', () => archiveAccount(account)),
  )
  if (account.kind === 'releve') tools.append(button('Importer un relevé', 'primary', () => startImport(account.id)))
  page.append(tools)
  if (preview && importFile) page.append(renderPreview(account.id))
  page.append(renderSummary(detail.summary, account))
  if (account.kind === 'releve') {
    page.append(renderBatches(detail.batches))
    page.append(renderOperations(detail.operations))
  }
  return page
}

function accountForm(account: Account | null): HTMLElement {
  const form = el('form', 'card')
  const mapping = account?.mapping
  form.append(el('h2', '', account ? 'Modifier le compte' : 'Nouveau compte'))
  const name = field('Nom', 'text', account?.name ?? '')
  const bank = field('Banque', 'text', account?.bankName ?? '')
  form.append(el('div', 'form-row', name.label, bank.label))
  const kind = el('select') as HTMLSelectElement
  kind.append(option('releve', 'Relevé'), option('solde', 'Solde mensuel'))
  kind.value = account?.kind ?? 'releve'
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
  const openingAmount = field(
    'Solde d’ouverture',
    'text',
    account?.openingCents === null || account?.openingCents === undefined ? '' : formatInputAmount(account.openingCents),
  )
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
    openingAmount.label,
    openingDate.label,
  )
  form.append(mappingBox)
  const sync = () => {
    const releve = kind.value === 'releve'
    mappingBox.hidden = !releve
  }
  kind.addEventListener('change', sync)
  sync()
  form.append(
    button(account ? 'Enregistrer' : 'Créer', 'primary', async () => {
      const releve = kind.value === 'releve'
      const payload = {
        id: account?.id,
        name: name.input.value,
        bankName: bank.input.value,
        kind: kind.value,
        archived: account?.archived ?? false,
        mapping: releve
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

function renderSummary(summary: AccountSummary, account: Account): HTMLElement {
  if (summary.kind === 'solde') return balanceEditor(account, summary)
  return statementView(summary)
}

function statementView(summary: StatementSummary): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', 'Synthèse'))
  if (summary.balanceMissing) card.append(el('p', 'banner', 'Solde d’ouverture manquant. Les soldes ne sont pas calculés.'))
  else card.append(el('p', '', `Solde d’ouverture : ${formatEuros(summary.openingCents ?? 0)} au ${formatIsoDate(summary.openingDate ?? '')}`))
  card.append(categoryBlock('Dépenses', summary.expenseFamilies, summary.unpointedExpense, summary.expenseTotals, 'depense'))
  card.append(categoryBlock('Encaissements', summary.incomeFamilies, summary.unpointedIncome, summary.incomeTotals, 'encaissement'))
  const table = el('table', 'grid')
  table.append(monthHead())
  table.append(amountRow('Solde', summary.balances, 'total'))
  card.append(wrap(table))
  return card
}

function categoryBlock(
  title: string,
  families: StatementSummary['expenseFamilies'],
  unpointed: number[],
  totals: number[],
  nature: Nature,
): HTMLElement {
  const box = el('div')
  box.append(el('h3', '', title))
  const table = el('table', 'grid')
  table.append(monthHead())
  for (const family of families) {
    table.append(amountRow(family.name, family.months, 'family'))
    for (const category of family.categories) table.append(categoryDrillRow(category, nature))
  }
  table.append(unpointedDrillRow(unpointed, nature))
  table.append(amountRow('Total', totals, 'total'))
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

function balanceEditor(account: Account, summary: BalanceSummary): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', `Soldes ${year}`))
  card.append(el('p', 'muted', 'Saisis le solde de fin de mois. Le mouvement est calculé.'))
  const table = el('table', 'grid')
  table.append(monthHead())
  const balanceRow = labelRow('Solde saisi', '')
  const expenseRow = amountRow('Dépense', summary.expense, '')
  const incomeRow = amountRow('Encaissement', summary.income, '')
  summary.balances.forEach((value, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`
    const input = document.createElement('input')
    input.value = value === null ? '' : formatInputAmount(value)
    input.addEventListener('change', async () => {
      const saved = await ask(window.comptes.setMonthlyBalance(account.id, month, input.value))
      if (saved !== null) {
        await loadDetail()
        render()
      }
    })
    const cell = el('td', 'num')
    cell.append(input)
    balanceRow.append(cell)
  })
  table.append(balanceRow, expenseRow, incomeRow)
  card.append(wrap(table))
  return card
}

function renderBatches(batches: BatchView[]): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', 'Imports'))
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

function renderOperations(operations: OperationView[]): HTMLElement {
  const card = el('section', 'card')
  card.append(el('h2', '', `Opérations ${year}`))
  if (operations.length === 0) card.append(el('p', 'empty', 'Aucune opération sur cette année.'))
  else {
    const table = el('table', 'grid')
    const head = el('tr')
    for (const label of ['Date', 'Libellé', 'Montant', 'Catégorie']) {
      head.append(el('th', label === 'Catégorie' ? 'point' : '', label))
    }
    table.append(head)
    for (const operation of operations) {
      const row = el('tr')
      row.append(el('td', '', formatIsoDate(operation.date)), el('td', '', operation.label))
      row.append(moneyCell(operation.amountCents))
      row.append(
        pointCell(operation.amountCents, operation.categoryId, operation.categoryName, operation.id, loadDetail),
      )
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
  for (const account of (workspace?.accounts ?? []).filter((item) => !item.archived && item.kind === 'releve')) {
    select.append(option(String(account.id), account.name))
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
    line.append(el('td', '', formatIsoDate(row.date)), el('td', '', row.accountName), labelCell, moneyCell(row.amountCents))
    line.append(pointCell(row.amountCents, row.suggestedCategoryId, null, row.id, async () => {
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
  creator.append(el('div', 'form-row', name.label, labeled('Nature', nature)))
  creator.append(
    button('Ajouter la famille', 'primary', async () => {
      const saved = await ask(window.comptes.saveFamily({ name: name.input.value, nature: nature.value, archived: false }))
      if (!saved) {
        render()
        return
      }
      await loadWorkspace()
      render()
    }),
  )
  creator.addEventListener('submit', (event) => event.preventDefault())
  page.append(creator)
  for (const family of workspace?.families ?? []) {
    page.append(familyCard(family))
  }
  return page
}

function familyCard(family: Family): HTMLElement {
  const card = el('section', 'card family-card')
  const name = textInput(family.name)
  const line = el('div', 'family-line')
  line.append(inlineLabel('Famille :', name))
  line.append(el('span', 'muted', family.nature === 'depense' ? 'Dépense' : 'Encaissement'))
  line.append(button('Haut', '', () => move('family', family.id, -1)))
  line.append(button('Bas', '', () => move('family', family.id, 1)))
  line.append(
    button('Enregistrer', '', async () => {
      await ask(window.comptes.saveFamily({ id: family.id, name: name.value, archived: family.archived }))
      await loadWorkspace()
      render()
    }),
  )
  line.append(
    button(family.archived ? 'Réactiver' : 'Archiver', 'danger', async () => {
      if (!family.archived && !window.confirm(`Archiver la famille ${family.name} ?`)) return
      await ask(window.comptes.saveFamily({ id: family.id, name: name.value, archived: !family.archived }))
      await loadWorkspace()
      render()
    }),
  )
  card.append(line)
  const list = el('ul', 'category-list')
  for (const category of family.categories) {
    const categoryName = textInput(category.name)
    categoryName.setAttribute('aria-label', 'Nom de la catégorie')
    const row = el('div', 'category-line')
    row.append(categoryName)
    row.append(button('Haut', '', () => move('category', category.id, -1)))
    row.append(button('Bas', '', () => move('category', category.id, 1)))
    row.append(
      button('Enregistrer', '', async () => {
        await ask(
          window.comptes.saveCategory({
            id: category.id,
            name: categoryName.value,
            familyId: family.id,
            archived: category.archived,
          }),
        )
        await loadWorkspace()
        render()
      }),
    )
    row.append(
      button(category.archived ? 'Réactiver' : 'Archiver', 'danger', async () => {
        if (!category.archived && !window.confirm(`Archiver la catégorie ${category.name} ?`)) return
        await ask(
          window.comptes.saveCategory({
            id: category.id,
            name: categoryName.value,
            familyId: family.id,
            archived: !category.archived,
          }),
        )
        await loadWorkspace()
        render()
      }),
    )
    list.append(el('li', '', row))
  }
  card.append(list)
  const add = textInput('')
  add.placeholder = 'Nouvelle catégorie'
  add.setAttribute('aria-label', 'Nouvelle catégorie')
  const addRow = el('div', 'category-add')
  addRow.append(add)
  addRow.append(
    button('Ajouter', '', async () => {
      const saved = await ask(window.comptes.saveCategory({ name: add.value, familyId: family.id, archived: false }))
      if (!saved) {
        render()
        return
      }
      await loadWorkspace()
      render()
    }),
  )
  card.append(addRow)
  return card
}

function pointCell(
  amountCents: number,
  currentId: number | null,
  currentName: string | null,
  operationId: number,
  after: () => Promise<void>,
): HTMLElement {
  const choice = categorySelect(amountCents, currentId, currentName)
  const cell = el('td', 'point')
  const rowBox = el('div', 'point-row')
  rowBox.append(
    choice,
    iconButton('Pointer', async () => {
      if (!choice.value) {
        notice = 'Choisis une catégorie.'
        render()
        return
      }
      const done = await ask(window.comptes.pointOperation(operationId, Number(choice.value)))
      if (done === null) {
        render()
        return
      }
      await after()
      render()
    }),
  )
  cell.append(rowBox)
  return cell
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
      openingAmount: account.openingCents === null ? '' : formatInputAmount(account.openingCents),
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
  editing = false
  preview = null
  notice = ''
  drill = null
  if (next === 'pointing') await loadUnpointed()
  if (next !== 'account') detail = null
  render()
}

async function openAccount(id: number): Promise<void> {
  accountId = id
  screen = 'account'
  editing = false
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

function monthHead(): HTMLElement {
  const row = el('tr')
  row.append(el('th', '', ''))
  for (const label of SHORT) row.append(el('th', 'num', label))
  return row
}

function labelRow(label: string, className: string): HTMLElement {
  const row = el('tr', className)
  row.append(el('td', '', label))
  return row
}

function amountRow(label: string, values: readonly (number | null)[], className: string): HTMLElement {
  const row = labelRow(label, className)
  addAmounts(row, values)
  return row
}

function addAmounts(row: HTMLElement, values: readonly (number | null)[]): void {
  for (const value of values) row.append(value === null ? el('td', 'num') : moneyCell(value))
}

function figure(label: string, cents: number | null): HTMLElement {
  const box = el('div')
  box.append(el('span', 'muted', label))
  box.append(cents === null ? el('span', 'figure muted', '—') : el('span', `figure${cents < 0 ? ' neg' : ''}`, formatEuros(cents)))
  return box
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

function iconButton(label: string, onClick: () => void): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'icon primary'
  item.title = label
  item.setAttribute('aria-label', label)
  item.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8.5 6.2 12 13 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  item.addEventListener('click', onClick)
  return item
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
