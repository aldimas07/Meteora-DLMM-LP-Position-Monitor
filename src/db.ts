import Database from 'better-sqlite3';
import path from 'path';
import { UserRow, WalletRow, PositionRow, ConfigRow } from './types';

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
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT    UNIQUE NOT NULL,
      username   TEXT    NOT NULL DEFAULT '',
      first_name TEXT    NOT NULL DEFAULT '',
      joined_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT    NOT NULL,
      address    TEXT    NOT NULL,
      added_at   INTEGER NOT NULL,
      UNIQUE(chat_id, address)
    );

    CREATE TABLE IF NOT EXISTS positions (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id                 TEXT    NOT NULL,
      wallet_address          TEXT    NOT NULL,
      position_address        TEXT    NOT NULL,
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
      active_price            TEXT    NOT NULL DEFAULT '0',
      lower_price             TEXT    NOT NULL DEFAULT '0',
      upper_price             TEXT    NOT NULL DEFAULT '0',
      pnl_pct                 TEXT    NOT NULL DEFAULT '0',
      pnl_sol                 TEXT    NOT NULL DEFAULT '0',
      updated_at              INTEGER NOT NULL,
      UNIQUE(chat_id, position_address)
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

function migrateSchema(): void {
  const legacyChatId = getConfig('telegram_chat_id');

  // Wallets migration
  const walletCols = db.pragma('table_info(wallets)') as Array<{ name: string }>;
  if (!walletCols.some(c => c.name === 'chat_id')) {
    db.exec(`ALTER TABLE wallets ADD COLUMN chat_id TEXT NOT NULL DEFAULT '${legacyChatId || '0'}'`);
    console.log(`[db] Migrated: added chat_id to wallets`);
  }

  // Positions migration
  const posCols = db.pragma('table_info(positions)') as Array<{ name: string }>;
  const posColNames = new Set(posCols.map(c => c.name));

  if (!posColNames.has('chat_id')) {
    db.exec(`ALTER TABLE positions ADD COLUMN chat_id TEXT NOT NULL DEFAULT '${legacyChatId || '0'}'`);
    console.log(`[db] Migrated: added chat_id to positions`);
  }

  const migrations: Array<[string, string]> = [
    ['bin_step', 'INTEGER NOT NULL DEFAULT 0'],
    ['total_x_amount', 'REAL NOT NULL DEFAULT 0'],
    ['total_y_amount', 'REAL NOT NULL DEFAULT 0'],
    ['strategy_type', "TEXT NOT NULL DEFAULT 'Unknown'"],
    ['active_price', "TEXT NOT NULL DEFAULT '0'"],
    ['lower_price', "TEXT NOT NULL DEFAULT '0'"],
    ['upper_price', "TEXT NOT NULL DEFAULT '0'"],
    ['pnl_pct', "TEXT NOT NULL DEFAULT '0'"],
    ['pnl_sol', "TEXT NOT NULL DEFAULT '0'"],
  ];

  for (const [col, def] of migrations) {
    if (!posColNames.has(col)) {
      db.exec(`ALTER TABLE positions ADD COLUMN ${col} ${def}`);
      console.log(`[db] Migrated: added column '${col}' to positions table`);
    }
  }
}

// ─── User Operations ──────────────────────────────────────────────────────────

export function registerUser(chatId: string, username: string, firstName: string): void {
  db.prepare(
    `INSERT INTO users (chat_id, username, first_name, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name`
  ).run(chatId, username || '', firstName || '', Date.now());
}

export function isNewUser(chatId: string): boolean {
  const row = db.prepare(`SELECT id FROM users WHERE chat_id = ?`).get(chatId);
  return row === undefined;
}

export function getTotalUsers(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM users`).get() as { count: number };
  return row.count;
}

export function getAllUsers(): UserRow[] {
  return db.prepare(`SELECT * FROM users`).all() as UserRow[];
}

// ─── Wallet Operations ────────────────────────────────────────────────────────

export function addWallet(chatId: string, address: string): boolean {
  try {
    db.prepare(
      `INSERT INTO wallets (chat_id, address, added_at) VALUES (?, ?, ?)`
    ).run(chatId, address, Date.now());
    return true;
  } catch {
    return false;
  }
}

export function removeWallet(chatId: string, address: string): boolean {
  const info = db.prepare(`DELETE FROM wallets WHERE chat_id = ? AND address = ?`).run(chatId, address);
  if (info.changes > 0) {
    db.prepare(`DELETE FROM positions WHERE chat_id = ? AND wallet_address = ?`).run(chatId, address);
    return true;
  }
  return false;
}

export function listWallets(chatId: string): WalletRow[] {
  return db.prepare(`SELECT * FROM wallets WHERE chat_id = ? ORDER BY added_at ASC`).all(chatId) as WalletRow[];
}

export function getAllTrackedWallets(): WalletRow[] {
  return db.prepare(`SELECT * FROM wallets`).all() as WalletRow[];
}

// ─── Position Operations ──────────────────────────────────────────────────────

export function upsertPosition(pos: Omit<PositionRow, 'id'>): void {
  db.prepare(`
    INSERT INTO positions (
      chat_id, wallet_address, position_address, pool_address, pool_name,
      token_x_symbol, token_y_symbol, token_x_decimals, token_y_decimals,
      lower_bin_id, upper_bin_id, last_known_active_bin, bin_step,
      is_in_range, oor_alert_sent, approaching_alert_sent,
      unclaimed_fee_x, unclaimed_fee_y, total_x_amount, total_y_amount,
      strategy_type, active_price, lower_price, upper_price,
      pnl_pct, pnl_sol, updated_at
    ) VALUES (
      @chat_id, @wallet_address, @position_address, @pool_address, @pool_name,
      @token_x_symbol, @token_y_symbol, @token_x_decimals, @token_y_decimals,
      @lower_bin_id, @upper_bin_id, @last_known_active_bin, @bin_step,
      @is_in_range, @oor_alert_sent, @approaching_alert_sent,
      @unclaimed_fee_x, @unclaimed_fee_y, @total_x_amount, @total_y_amount,
      @strategy_type, @active_price, @lower_price, @upper_price,
      @pnl_pct, @pnl_sol, @updated_at
    )
    ON CONFLICT(chat_id, position_address) DO UPDATE SET
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
      active_price            = excluded.active_price,
      lower_price             = excluded.lower_price,
      upper_price             = excluded.upper_price,
      pnl_pct                 = excluded.pnl_pct,
      pnl_sol                 = excluded.pnl_sol,
      updated_at              = excluded.updated_at
  `).run(pos);
}

export function getPosition(chatId: string, positionAddress: string): PositionRow | undefined {
  return db.prepare(
    `SELECT * FROM positions WHERE chat_id = ? AND position_address = ?`
  ).get(chatId, positionAddress) as PositionRow | undefined;
}

export function getAllPositions(chatId: string): PositionRow[] {
  return db.prepare(
    `SELECT * FROM positions WHERE chat_id = ? ORDER BY wallet_address, pool_name`
  ).all(chatId) as PositionRow[];
}

export function getKnownPositionAddresses(chatId: string, walletAddress: string): Set<string> {
  const rows = db.prepare(
    `SELECT position_address FROM positions WHERE chat_id = ? AND wallet_address = ?`
  ).all(chatId, walletAddress) as { position_address: string }[];
  return new Set(rows.map((r) => r.position_address));
}

export function deletePosition(chatId: string, positionAddress: string): void {
  db.prepare(`DELETE FROM positions WHERE chat_id = ? AND position_address = ?`).run(chatId, positionAddress);
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
