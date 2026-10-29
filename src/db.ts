import { existsSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { LedgerError } from './errors.ts'

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE banks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  bank_id INTEGER NOT NULL REFERENCES banks(id),
  kind TEXT NOT NULL CHECK (kind IN ('courant', 'epargne', 'titre')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  mapping_json TEXT,
  opening_cents INTEGER,
  opening_millis INTEGER,
  opening_date TEXT,
  cash_cents INTEGER,
  cash_millis INTEGER,
  cash_valued_on TEXT,
  reconciled_on TEXT,
  reconciled_cents INTEGER,
  sort_order INTEGER NOT NULL,
  UNIQUE (name, bank_id)
);
CREATE TABLE families (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  nature TEXT NOT NULL CHECK (nature IN ('depense', 'encaissement')),
  sort_order INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  family_id INTEGER NOT NULL REFERENCES families(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  role TEXT CHECK (role IS NULL OR role = 'virement'),
  UNIQUE (family_id, name)
);
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  imported_at TEXT NOT NULL,
  filename TEXT NOT NULL
);
CREATE TABLE operations (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  batch_id INTEGER REFERENCES import_batches(id),
  date TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
  category_id INTEGER REFERENCES categories(id),
  pointed_at TEXT
);
CREATE INDEX idx_operations_account_date ON operations(account_id, date);
CREATE INDEX idx_operations_key ON operations(account_id, date, label, amount_cents);
CREATE TABLE monthly_balances (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (account_id, month)
);
CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  quantity_micros INTEGER NOT NULL CHECK (quantity_micros > 0),
  value_millis INTEGER NOT NULL CHECK (value_millis >= 0),
  valued_on TEXT,
  sort_order INTEGER NOT NULL
);
CREATE INDEX idx_positions_account ON positions(account_id);
CREATE TABLE transfers (
  id INTEGER PRIMARY KEY,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  source_operation_id INTEGER UNIQUE REFERENCES operations(id),
  dest_operation_id INTEGER UNIQUE REFERENCES operations(id),
  CHECK (from_account_id != to_account_id)
);
CREATE INDEX idx_transfers_from ON transfers(from_account_id);
CREATE INDEX idx_transfers_to ON transfers(to_account_id);
INSERT INTO meta (key, value) VALUES ('schema_version', '12');
`

export function createDatabase(path: string): DatabaseSync {
  if (existsSync(path)) throw new LedgerError('Ce fichier existe déjà.')
  const database = new DatabaseSync(path)
  try {
    database.exec(SCHEMA)
    ensureTransferCategories(database)
    database.exec('PRAGMA foreign_keys = ON')
    return database
  } catch (error) {
    database.close()
    rmSync(path, { force: true })
    throw error
  }
}

export function openDatabase(path: string): DatabaseSync {
  assertDatabase(path)
  const database = new DatabaseSync(path)
  migrate(database)
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

function migrate(database: DatabaseSync): void {
  if (schemaVersion(database) === '1') replaceAccounts(database, '2')
  if (schemaVersion(database) === '2') replaceAccounts(database, '3')
  if (schemaVersion(database) === '3') migrateAccountKinds(database)
  if (schemaVersion(database) === '4') addValueDates(database)
  if (schemaVersion(database) === '5') migrateMillis(database)
  if (schemaVersion(database) === '6') migrateTransfers(database)
  if (schemaVersion(database) === '7') migrateSavingsOpening(database)
  if (schemaVersion(database) === '8') migrateSavingsScale(database)
  if (schemaVersion(database) === '9') migrateCategoryNames(database)
  if (schemaVersion(database) === '10') migrateAccountOrder(database)
  if (schemaVersion(database) === '11') migrateStatement(database)
  if (schemaVersion(database) !== '12') throw new LedgerError('Ce fichier n’est pas une base Comptes.')
}

function schemaVersion(database: DatabaseSync): string | undefined {
  const row = database.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  return row?.value
}

function replaceAccounts(database: DatabaseSync, version: '2' | '3'): void {
  const kinds = version === '3' ? `'releve', 'solde', 'titres'` : `'releve', 'solde'`
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN')
  try {
    database.exec(`
      CREATE TABLE accounts_next (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        bank_id INTEGER NOT NULL REFERENCES banks(id),
        kind TEXT NOT NULL CHECK (kind IN (${kinds})),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        mapping_json TEXT,
        opening_cents INTEGER,
        opening_date TEXT,
        UNIQUE (name, bank_id)
      );
      INSERT INTO accounts_next (id, name, bank_id, kind, archived, mapping_json, opening_cents, opening_date)
        SELECT id, name, bank_id, kind, archived, mapping_json, opening_cents, opening_date FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_next RENAME TO accounts;
      UPDATE meta SET value = '${version}' WHERE key = 'schema_version';
    `)
    if (version === '3') {
      database.exec(`
        CREATE TABLE positions (
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id),
          name TEXT NOT NULL,
          quantity_micros INTEGER NOT NULL CHECK (quantity_micros > 0),
          value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
          sort_order INTEGER NOT NULL
        );
        CREATE INDEX idx_positions_account ON positions(account_id);
      `)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  database.exec('PRAGMA foreign_keys = ON')
}

function migrateAccountKinds(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN')
  try {
    database.exec(`
      CREATE TABLE accounts_next (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        bank_id INTEGER NOT NULL REFERENCES banks(id),
        kind TEXT NOT NULL CHECK (kind IN ('courant', 'epargne', 'titre')),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        mapping_json TEXT,
        opening_cents INTEGER,
        opening_date TEXT,
        cash_cents INTEGER,
        UNIQUE (name, bank_id)
      );
      INSERT INTO accounts_next (id, name, bank_id, kind, archived, mapping_json, opening_cents, opening_date, cash_cents)
        SELECT id, name, bank_id,
          CASE kind
            WHEN 'releve' THEN 'courant'
            WHEN 'solde' THEN 'epargne'
            WHEN 'titres' THEN 'titre'
          END,
          archived, mapping_json, opening_cents, opening_date,
          CASE WHEN kind = 'titres' THEN 0 ELSE NULL END
        FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_next RENAME TO accounts;
      UPDATE meta SET value = '4' WHERE key = 'schema_version';
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  database.exec('PRAGMA foreign_keys = ON')
}

function addValueDates(database: DatabaseSync): void {
  database.exec('BEGIN')
  try {
    database.exec(`
      ALTER TABLE positions ADD COLUMN valued_on TEXT;
      ALTER TABLE accounts ADD COLUMN cash_valued_on TEXT;
      UPDATE meta SET value = '5' WHERE key = 'schema_version';
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function migrateMillis(database: DatabaseSync): void {
  // value_cents était le montant de la ligne, en centimes. Le cours retrouvé est
  // arrondi(centimes × 10 × 1 000 000 / quantity_micros), en millièmes d’euro.
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN')
  try {
    database.exec(`
      CREATE TABLE positions_next (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        name TEXT NOT NULL,
        quantity_micros INTEGER NOT NULL CHECK (quantity_micros > 0),
        value_millis INTEGER NOT NULL CHECK (value_millis >= 0),
        valued_on TEXT,
        sort_order INTEGER NOT NULL
      );
      INSERT INTO positions_next (id, account_id, name, quantity_micros, value_millis, valued_on, sort_order)
        SELECT id, account_id, name, quantity_micros,
          (value_cents * 10000000 + quantity_micros / 2) / quantity_micros,
          valued_on, sort_order FROM positions;
      DROP TABLE positions;
      ALTER TABLE positions_next RENAME TO positions;
      CREATE INDEX idx_positions_account ON positions(account_id);
      ALTER TABLE accounts ADD COLUMN cash_millis INTEGER;
      UPDATE accounts SET cash_millis = cash_cents * 10 WHERE kind = 'titre' AND cash_cents IS NOT NULL;
      UPDATE meta SET value = '6' WHERE key = 'schema_version';
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  database.exec('PRAGMA foreign_keys = ON')
}

function migrateTransfers(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN')
  try {
    if (tableExists(database, 'categories') && !columnExists(database, 'categories', 'role')) {
      database.exec(`ALTER TABLE categories ADD COLUMN role TEXT CHECK (role IS NULL OR role = 'virement')`)
    }
    if (tableExists(database, 'operations') && columnExists(database, 'operations', 'batch_id')) {
      const batch = tableColumns(database, 'operations').find((column) => column.name === 'batch_id')
      if (batch?.notnull === 1) {
        database.exec(`
          CREATE TABLE operations_next (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts(id),
            batch_id INTEGER REFERENCES import_batches(id),
            date TEXT NOT NULL,
            label TEXT NOT NULL,
            amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
            category_id INTEGER REFERENCES categories(id),
            pointed_at TEXT
          );
          INSERT INTO operations_next (id, account_id, batch_id, date, label, amount_cents, category_id, pointed_at)
            SELECT id, account_id, batch_id, date, label, amount_cents, category_id, pointed_at FROM operations;
          DROP TABLE operations;
          ALTER TABLE operations_next RENAME TO operations;
          CREATE INDEX idx_operations_account_date ON operations(account_id, date);
          CREATE INDEX idx_operations_key ON operations(account_id, date, label, amount_cents);
        `)
      }
    }
    if (!tableExists(database, 'transfers')) {
      database.exec(`
        CREATE TABLE transfers (
          id INTEGER PRIMARY KEY,
          from_account_id INTEGER NOT NULL REFERENCES accounts(id),
          to_account_id INTEGER NOT NULL REFERENCES accounts(id),
          date TEXT NOT NULL,
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          source_operation_id INTEGER UNIQUE REFERENCES operations(id),
          dest_operation_id INTEGER UNIQUE REFERENCES operations(id),
          CHECK (from_account_id != to_account_id)
        );
        CREATE INDEX idx_transfers_from ON transfers(from_account_id);
        CREATE INDEX idx_transfers_to ON transfers(to_account_id);
      `)
    }
    database.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  database.exec('PRAGMA foreign_keys = ON')
  ensureTransferCategories(database)
}

function migrateSavingsOpening(database: DatabaseSync): void {
  if (tableExists(database, 'accounts') && tableExists(database, 'monthly_balances')) {
    const accounts = database
      .prepare(`SELECT id FROM accounts WHERE kind = 'epargne' AND opening_cents IS NULL`)
      .all() as { id: number }[]
    const firstBalance = database.prepare(
      `SELECT month, amount_cents FROM monthly_balances WHERE account_id = ? ORDER BY month LIMIT 1`,
    )
    const update = database.prepare(`UPDATE accounts SET opening_cents = ?, opening_date = ? WHERE id = ?`)
    for (const account of accounts) {
      const row = firstBalance.get(account.id) as { month: string; amount_cents: number } | undefined
      if (!row) continue
      const [yearText, monthText] = String(row.month).split('-')
      const year = Number(yearText)
      const month = Number(monthText)
      const nextYear = month === 12 ? year + 1 : year
      const nextMonth = month === 12 ? 1 : month + 1
      const date = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
      update.run(row.amount_cents, date, account.id)
    }
  }
  database.exec(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`)
}

function migrateSavingsScale(database: DatabaseSync): void {
  database.exec('BEGIN')
  try {
    if (tableExists(database, 'accounts') && !columnExists(database, 'accounts', 'opening_millis')) {
      database.exec('ALTER TABLE accounts ADD COLUMN opening_millis INTEGER')
    }
    if (tableExists(database, 'accounts')) {
      database.exec(
        `UPDATE accounts SET opening_millis = opening_cents * 10
         WHERE kind = 'epargne' AND opening_cents IS NOT NULL AND opening_millis IS NULL`,
      )
      database.exec(`UPDATE accounts SET opening_cents = NULL WHERE kind = 'epargne'`)
    }
    if (tableExists(database, 'operations') && tableExists(database, 'accounts')) {
      database.exec(
        `UPDATE operations SET amount_cents = amount_cents * 10
         WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'epargne')`,
      )
    }
    database.exec(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function migrateCategoryNames(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN')
  try {
    if (tableExists(database, 'categories')) {
      database.exec(`
        CREATE TABLE categories_next (
          id INTEGER PRIMARY KEY,
          family_id INTEGER NOT NULL REFERENCES families(id),
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
          role TEXT CHECK (role IS NULL OR role = 'virement'),
          UNIQUE (family_id, name)
        );
        INSERT INTO categories_next (id, family_id, name, sort_order, archived, role)
          SELECT id, family_id, name, sort_order, archived, role FROM categories;
        DROP TABLE categories;
        ALTER TABLE categories_next RENAME TO categories;
      `)
    }
    database.exec(`UPDATE meta SET value = '10' WHERE key = 'schema_version'`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  database.exec('PRAGMA foreign_keys = ON')
}

function migrateAccountOrder(database: DatabaseSync): void {
  database.exec('BEGIN')
  try {
    if (tableExists(database, 'accounts') && !columnExists(database, 'accounts', 'sort_order')) {
      database.exec('ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
      const banks = database.prepare('SELECT id FROM banks').all() as { id: number }[]
      for (const bank of banks) {
        const accounts = database
          .prepare('SELECT id FROM accounts WHERE bank_id = ? ORDER BY name, id')
          .all(bank.id) as { id: number }[]
        accounts.forEach((account, index) => {
          database.prepare('UPDATE accounts SET sort_order = ? WHERE id = ?').run(index + 1, account.id)
        })
      }
    }
    database.exec(`UPDATE meta SET value = '11' WHERE key = 'schema_version'`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function migrateStatement(database: DatabaseSync): void {
  database.exec('BEGIN')
  try {
    if (tableExists(database, 'accounts') && !columnExists(database, 'accounts', 'reconciled_on')) {
      database.exec('ALTER TABLE accounts ADD COLUMN reconciled_on TEXT')
      database.exec('ALTER TABLE accounts ADD COLUMN reconciled_cents INTEGER')
    }
    database.exec(`UPDATE meta SET value = '12' WHERE key = 'schema_version'`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))
}

function columnExists(database: DatabaseSync, table: string, name: string): boolean {
  return tableColumns(database, table).some((column) => column.name === name)
}

function tableColumns(database: DatabaseSync, table: string): { name: string; notnull: number }[] {
  return database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]
}

function ensureTransferCategories(database: DatabaseSync): void {
  if (!tableExists(database, 'families') || !tableExists(database, 'categories')) return
  ensureTransferCategory(database, 'depense', 'Virements', 'Virement')
  ensureTransferCategory(database, 'encaissement', 'Virements reçus', 'Virement reçu')
}

function ensureTransferCategory(
  database: DatabaseSync,
  nature: 'depense' | 'encaissement',
  familyName: string,
  categoryName: string,
): void {
  const existing = database
    .prepare(
      `SELECT c.id FROM categories c
       JOIN families f ON f.id = c.family_id
       WHERE c.role = 'virement' AND f.nature = ?`,
    )
    .get(nature) as { id: number } | undefined
  if (existing) return
  const named = database.prepare(`SELECT id, nature FROM families WHERE name = ?`).get(familyName) as
    | { id: number; nature: string }
    | undefined
  let familyId = named && named.nature === nature ? named.id : undefined
  if (familyId === undefined) {
    const order = database.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS value FROM families`).get() as { value: number }
    const usableName = named ? `${familyName} interne` : familyName
    familyId = Number(
      database.prepare(`INSERT INTO families (name, nature, sort_order) VALUES (?, ?, ?)`).run(usableName, nature, Number(order.value) + 1)
        .lastInsertRowid,
    )
  }
  const taken = database.prepare(`SELECT id FROM categories WHERE family_id = ? AND name = ?`).get(familyId, categoryName)
  const usableCategory = taken ? `${categoryName} interne` : categoryName
  database
    .prepare(`INSERT INTO categories (family_id, name, sort_order, role) VALUES (?, ?, 1, 'virement')`)
    .run(familyId, usableCategory)
}

export function assertDatabase(path: string): void {
  if (!existsSync(path)) throw new LedgerError('Fichier introuvable.')
  const before = readFileSync(path)
  let database: DatabaseSync
  try {
    database = new DatabaseSync(path, { readOnly: true })
  } catch {
    throw new LedgerError('La base ne s’ouvre pas.')
  }
  try {
    const row = database.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined
    if (!row || !['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].includes(row.value)) throw new LedgerError('Ce fichier n’est pas une base Comptes.')
  } catch (error) {
    if (error instanceof LedgerError) throw error
    throw new LedgerError('La base ne s’ouvre pas.')
  } finally {
    database.close()
  }
  const after = readFileSync(path)
  if (!before.equals(after)) throw new LedgerError('La base ne s’ouvre pas.')
}
