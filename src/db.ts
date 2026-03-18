import Database from 'better-sqlite3';
import path from 'path';
import { WalletRow, PositionRow, ConfigRow } from './types';

// ─── Database Initialization ──────────────────────────────────────────────────

let db: Database.Database;

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join(process.cwd(), 'data.db');
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
  migrateSchema();
  return db;
}

function createTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      address    TEXT    UNIQUE NOT NULL,
      added_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address          TEXT    NOT NULL,
      position_address        TEXT    UNIQUE NOT NULL,
      pool_address            TEXT    NOT NULL,
      pool_name               TEXT    NOT NULL,
      token_x_symbol          TEXT    NOT NULL DEFAULT '',
      token_y_symbol          TEXT    NOT NULL DEFAULT '',
      token_x_decimals        INTEGER NOT NULL DEFAULT 9,
      token_y_decimals        INTEGER NOT NULL DEFAULT 6,
      lower_bin_id            INTEGER NOT NULL,
      upper_bin_id            INTEGER NOT NULL,
      last_known_active_bin   INTEGER NOT NULL,
      bin_step                INTEGER NOT NULL DEFAULT 0,
      is_in_range             INTEGER NOT NULL DEFAULT 1,
      oor_alert_sent          INTEGER NOT NULL DEFAULT 0,
      approaching_alert_sent  INTEGER NOT NULL DEFAULT 0,
      unclaimed_fee_x         REAL    NOT NULL DEFAULT 0,
      unclaimed_fee_y         REAL    NOT NULL DEFAULT 0,
      total_x_amount          REAL    NOT NULL DEFAULT 0,
      total_y_amount          REAL    NOT NULL DEFAULT 0,
      strategy_type           TEXT    NOT NULL DEFAULT 'Unknown',
      updated_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`
  );
  insert.run('proximity_threshold', '5');
}

/** Add new columns to existing DB: safe migration via ALTER TABLE IF NOT EXISTS */
function migrateSchema(): void {
  const cols = db.pragma('table_info(positions)') as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  const migrations: Array<[string, string]> = [
    ['bin_step', 'INTEGER NOT NULL DEFAULT 0'],
    ['total_x_amount', 'REAL NOT NULL DEFAULT 0'],
    ['total_y_amount', 'REAL NOT NULL DEFAULT 0'],
    ['strategy_type', "TEXT NOT NULL DEFAULT 'Unknown'"],
  ];

  for (const [col, def] of migrations) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE positions ADD COLUMN ${col} ${def}`);
      console.log(`[db] Migrated: added column '${col}' to positions table`);
    }
  }
}

// ─── Wallet Operations ────────────────────────────────────────────────────────

export function addWallet(address: string): boolean {
  try {
    db.prepare(
      `INSERT INTO wallets (address, added_at) VALUES (?, ?)`
    ).run(address, Date.now());
    return true;
  } catch {
    return false;
  }
}

export function removeWallet(address: string): boolean {
  const info = db.prepare(`DELETE FROM wallets WHERE address = ?`).run(address);
  if (info.changes > 0) {
    db.prepare(`DELETE FROM positions WHERE wallet_address = ?`).run(address);
    return true;
  }
  return false;
}

export function listWallets(): WalletRow[] {
  return db.prepare(`SELECT * FROM wallets ORDER BY added_at ASC`).all() as WalletRow[];
}

export function walletExists(address: string): boolean {
  const row = db.prepare(`SELECT id FROM wallets WHERE address = ?`).get(address);
  return row !== undefined;
}

// ─── Position Operations ──────────────────────────────────────────────────────

export function upsertPosition(pos: Omit<PositionRow, 'id'>): void {
  db.prepare(`
    INSERT INTO positions (
      wallet_address, position_address, pool_address, pool_name,
      token_x_symbol, token_y_symbol, token_x_decimals, token_y_decimals,
      lower_bin_id, upper_bin_id, last_known_active_bin, bin_step,
      is_in_range, oor_alert_sent, approaching_alert_sent,
      unclaimed_fee_x, unclaimed_fee_y, total_x_amount, total_y_amount,
      strategy_type, updated_at
    ) VALUES (
      @wallet_address, @position_address, @pool_address, @pool_name,
      @token_x_symbol, @token_y_symbol, @token_x_decimals, @token_y_decimals,
      @lower_bin_id, @upper_bin_id, @last_known_active_bin, @bin_step,
      @is_in_range, @oor_alert_sent, @approaching_alert_sent,
      @unclaimed_fee_x, @unclaimed_fee_y, @total_x_amount, @total_y_amount,
      @strategy_type, @updated_at
    )
    ON CONFLICT(position_address) DO UPDATE SET
      pool_address            = excluded.pool_address,
      pool_name               = excluded.pool_name,
      token_x_symbol          = excluded.token_x_symbol,
      token_y_symbol          = excluded.token_y_symbol,
      token_x_decimals        = excluded.token_x_decimals,
      token_y_decimals        = excluded.token_y_decimals,
      lower_bin_id            = excluded.lower_bin_id,
      upper_bin_id            = excluded.upper_bin_id,
      last_known_active_bin   = excluded.last_known_active_bin,
      bin_step                = excluded.bin_step,
      is_in_range             = excluded.is_in_range,
      oor_alert_sent          = excluded.oor_alert_sent,
      approaching_alert_sent  = excluded.approaching_alert_sent,
      unclaimed_fee_x         = excluded.unclaimed_fee_x,
      unclaimed_fee_y         = excluded.unclaimed_fee_y,
      total_x_amount          = excluded.total_x_amount,
      total_y_amount          = excluded.total_y_amount,
      strategy_type           = excluded.strategy_type,
      updated_at              = excluded.updated_at
  `).run(pos);
}

export function getPosition(positionAddress: string): PositionRow | undefined {
  return db.prepare(
    `SELECT * FROM positions WHERE position_address = ?`
  ).get(positionAddress) as PositionRow | undefined;
}

export function getAllPositions(): PositionRow[] {
  return db.prepare(
    `SELECT * FROM positions ORDER BY wallet_address, pool_name`
  ).all() as PositionRow[];
}

export function getPositionsForWallet(walletAddress: string): PositionRow[] {
  return db.prepare(
    `SELECT * FROM positions WHERE wallet_address = ? ORDER BY pool_name`
  ).all(walletAddress) as PositionRow[];
}

export function deletePositionsByWallet(walletAddress: string): void {
  db.prepare(`DELETE FROM positions WHERE wallet_address = ?`).run(walletAddress);
}

export function deletePosition(positionAddress: string): void {
  db.prepare(`DELETE FROM positions WHERE position_address = ?`).run(positionAddress);
}

export function getKnownPositionAddresses(walletAddress: string): Set<string> {
  const rows = db.prepare(
    `SELECT position_address FROM positions WHERE wallet_address = ?`
  ).all(walletAddress) as { position_address: string }[];
  return new Set(rows.map((r) => r.position_address));
}

// ─── Config Operations ────────────────────────────────────────────────────────

export function getConfig(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as
    | ConfigRow
    | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function getProximityThreshold(): number {
  const val = getConfig('proximity_threshold');
  return val ? parseInt(val, 10) : 5;
}

export function getChatId(): string | undefined {
  return getConfig('telegram_chat_id');
}

export function setChatId(chatId: string): void {
  setConfig('telegram_chat_id', chatId);
}
