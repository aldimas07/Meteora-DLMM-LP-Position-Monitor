// TypeScript interfaces for Meteora DLMM LP Monitor

// ─── API Response Types ──────────────────────────────────────────────────────

/** A single token info inside a pool from the portfolio API */
export interface PoolToken {
  address: string;
  symbol: string;
  decimals: number;
}

/** Pool info nested inside a portfolio position */
export interface PortfolioPool {
  address: string;
  name: string;
  activeId: number;
  tokenX: PoolToken;
  tokenY: PoolToken;
}

/** Raw position as returned by GET /portfolio/open */
export interface PortfolioPosition {
  positionAddress: string;
  lowerBinId: number;
  upperBinId: number;
  totalUnclaimedFeeX: number; // already in token units (float)
  totalUnclaimedFeeY: number; // already in token units (float)
  pool: PortfolioPool;
}

/** Full portfolio API response */
export interface PortfolioResponse {
  data: PortfolioPosition[];
}

// ─── Database Row Types ───────────────────────────────────────────────────────

export interface WalletRow {
  id: number;
  address: string;
  added_at: number;
}

export interface PositionRow {
  id: number;
  wallet_address: string;
  position_address: string;
  pool_address: string;
  pool_name: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  lower_bin_id: number;
  upper_bin_id: number;
  last_known_active_bin: number;
  is_in_range: number; // SQLite stores booleans as 0/1
  oor_alert_sent: number;
  approaching_alert_sent: number;
  unclaimed_fee_x: number;
  unclaimed_fee_y: number;
  updated_at: number;
}

export interface ConfigRow {
  key: string;
  value: string;
}

// ─── Alert Types ──────────────────────────────────────────────────────────────

export enum AlertType {
  OOR = 'OOR',
  APPROACHING = 'APPROACHING',
  BACK_IN_RANGE = 'BACK_IN_RANGE',
  NEW_POSITION = 'NEW_POSITION',
}

/** Enriched position used for alert formatting */
export interface PositionAlert {
  walletAddress: string;
  positionAddress: string;
  poolAddress: string;
  poolName: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  lowerBinId: number;
  upperBinId: number;
  activeId: number;
  isInRange: boolean;
  proximityDistance: number;
  proximitySide: 'upper' | 'lower' | null;
  unclaimedFeeX: number;
  unclaimedFeeY: number;
  alertType: AlertType;
}
