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
  name TEXT NOT NULL UNIQUE,
  bank_id INTEGER NOT NULL REFERENCES banks(id),
  kind TEXT NOT NULL CHECK (kind IN ('releve', 'solde')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  mapping_json TEXT,
  opening_cents INTEGER,
  opening_date TEXT
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
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
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
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
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
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
`

export function createDatabase(path: string): DatabaseSync {
  if (existsSync(path)) throw new LedgerError('Ce fichier existe déjà.')
  const database = new DatabaseSync(path)
  try {
    database.exec(SCHEMA)
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
  database.exec('PRAGMA foreign_keys = ON')
  return database
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
    if (!row || row.value !== '1') throw new LedgerError('Ce fichier n’est pas une base Comptes.')
  } catch (error) {
    if (error instanceof LedgerError) throw error
    throw new LedgerError('La base ne s’ouvre pas.')
  } finally {
    database.close()
  }
  const after = readFileSync(path)
  if (!before.equals(after)) throw new LedgerError('La base ne s’ouvre pas.')
}
