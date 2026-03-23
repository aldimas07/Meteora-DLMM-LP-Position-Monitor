import axios, { AxiosInstance } from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { PortfolioPosition } from './types';

// ─── Rate Limit Error ─────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor() {
    super('Meteora API rate limit hit (429). Skipping this poll cycle.');
    this.name = 'RateLimitError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Infrastructure ───────────────────────────────────────────────────────────

const DATAPI_URL = 'https://dlmm.datapi.meteora.ag';

let client: AxiosInstance;
let connection: Connection;

export function getMeteoraClient(): AxiosInstance {
  if (!client) {
    client = axios.create({
      timeout: 15_000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'meteora-lp-monitor/1.0',
      },
    });
  }
  return client;
}

export function getConnection(): Connection {
  if (!connection) {
    const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    connection = new Connection(rpc, 'confirmed');
  }
  return connection;
}

// ─── Datapi Interfaces ────────────────────────────────────────────────────────

interface DatapiPool {
  poolAddress: string;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
  binStep: number;
  pnlPctChange?: string | number;
  pnlSol?: string | number;
}

interface DatapiPortfolioResponse {
  pools?: DatapiPool[];
}

// ─── Strategy Detection ───────────────────────────────────────────────────────

/**
 * Infer strategy type from the liquidity distribution shape.
 *
 * Meteora DLMM strategies place liquidity differently:
 *   Spot    → uniform distribution across all bins (flat shape)
 *   Curve   → bell-curve / gaussian, peaked at center, tapering at edges
 *   BidAsk  → inverse-bell / bathtub shape, heavy at edges, light in the middle
 *
 * We analyze the normalized liquidity array to classify.
 */
function inferStrategyType(
  positionBinData: Array<{ positionLiquidity: string; binId: number }>
): string {
  if (!positionBinData || positionBinData.length <= 2) return 'Spot';

  const liquidities = positionBinData.map(b => parseFloat(b.positionLiquidity || '0'));
  const total = liquidities.reduce((a, b) => a + b, 0);
  if (total === 0) return 'Unknown';

  const n = liquidities.length;
  
  // Divide bins into 3 areas: Left (25%), Center (50%), Right (25%)
  const edgeCount = Math.max(1, Math.floor(n * 0.25));
  const centerStart = edgeCount;
  const centerEnd = n - edgeCount;

  const leftSum = liquidities.slice(0, centerStart).reduce((a, b) => a + b, 0);
  const centerSum = liquidities.slice(centerStart, centerEnd).reduce((a, b) => a + b, 0);
  const rightSum = liquidities.slice(centerEnd).reduce((a, b) => a + b, 0);

  const leftAvg = leftSum / centerStart;
  const centerAvg = centerSum / (centerEnd - centerStart);
  const rightAvg = rightSum / edgeCount;

  // Curve: Bell shape -> Center is significantly taller than BOTH edges
  if (centerAvg > leftAvg * 1.15 && centerAvg > rightAvg * 1.15) {
    return 'Curve';
  }

  // BidAsk: U-shape -> BOTH edges are significantly taller than Center
  if (leftAvg > centerAvg * 1.15 && rightAvg > centerAvg * 1.15) {
    return 'BidAsk';
  }

  // Spot: Flat or Monotonic Slopes (\ or /)
  return 'Spot';
}

// ─── Price Utilities ──────────────────────────────────────────────────────────

/**
 * Convert a bin ID to a human-readable price using the DLMM formula.
 * Formula: price = (1 + binStep/10000)^binId * 10^(decimalsX - decimalsY)
 * This gives price in tokenY per tokenX.
 */
export function binIdToPrice(
  binId: number,
  binStep: number,
  decimalsX: number,
  decimalsY: number
): number {
  const pricePerLamport = Math.pow(1 + binStep / 10000, binId);
  return pricePerLamport * Math.pow(10, decimalsX - decimalsY);
}

/**
 * Format a price string to be human-readable.
 * Handles very small, normal, and very large prices.
 */
export function formatPriceStr(priceStr: string): string {
  const p = parseFloat(priceStr);
  if (isNaN(p) || p === 0) return '0';
  if (p < 0.000001) return p.toExponential(2);
  if (p < 0.01) return p.toPrecision(4);
  if (p < 1) return p.toFixed(4);
  if (p < 10) return p.toFixed(3);
  if (p < 1000) return p.toFixed(2);
  if (p < 100000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ─── API Client ───────────────────────────────────────────────────────────────

/**
 * Fetch all open DLMM positions for a given wallet address.
 * Uses REST API to discover pools, then the DLMM SDK for accurate position data.
 */
export async function fetchPortfolio(walletAddress: string): Promise<PortfolioPosition[]> {
  const http = getMeteoraClient();
  const conn = getConnection();
  const userPubkey = new PublicKey(walletAddress);

  let pools: DatapiPool[] = [];

  try {
    const response = await http.get<DatapiPortfolioResponse>(
      `${DATAPI_URL}/portfolio/open`,
      { params: { user: walletAddress } }
    );
    if (response.data && Array.isArray(response.data.pools)) {
      pools = response.data.pools;
    }
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      throw new RateLimitError();
    }
    throw err;
  }

  const results: PortfolioPosition[] = [];

  for (const p of pools) {
    try {
      await delay(100);

      const poolPubkey = new PublicKey(p.poolAddress);
      const dlmm = await DLMM.create(conn, poolPubkey, { cluster: 'mainnet-beta' });
      const activeBin = await dlmm.getActiveBin();
      const activeId = activeBin.binId;

      // Get accurate decimals from the token mints
      const decimalsX = dlmm.tokenX.mint.decimals;
      const decimalsY = dlmm.tokenY.mint.decimals;
      const binStep = dlmm.lbPair.binStep;

      // Human-readable active price directly from SDK
      const activePricePerToken = activeBin.pricePerToken;

      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(userPubkey);

      for (const pos of userPositions) {
        const lowerBinId = pos.positionData.lowerBinId;
        const upperBinId = pos.positionData.upperBinId;

        // Unclaimed fees (BN → human-readable)
        const feeXRaw = parseFloat(pos.positionData.feeX.toString());
        const feeYRaw = parseFloat(pos.positionData.feeY.toString());
        const totalFeeX = feeXRaw / Math.pow(10, decimalsX);
        const totalFeeY = feeYRaw / Math.pow(10, decimalsY);

        // Current position value
        const totalXAmount = parseFloat(pos.positionData.totalXAmount) / Math.pow(10, decimalsX);
        const totalYAmount = parseFloat(pos.positionData.totalYAmount) / Math.pow(10, decimalsY);

        // Get price at lower and upper bound from positionBinData
        const bins = pos.positionData.positionBinData;
        let lowerPricePerToken = '0';
        let upperPricePerToken = '0';

        if (bins.length > 0) {
          // Bins are sorted by binId; the first is lowest, last is highest
          const sorted = [...bins].sort((a, b) => a.binId - b.binId);
          lowerPricePerToken = sorted[0].pricePerToken;
          upperPricePerToken = sorted[sorted.length - 1].pricePerToken;
        }

        // Infer strategy type from bin distribution
        const strategyType = inferStrategyType(bins);

        results.push({
          positionAddress: pos.publicKey.toBase58(),
          lowerBinId,
          upperBinId,
          totalUnclaimedFeeX: totalFeeX,
          totalUnclaimedFeeY: totalFeeY,
          totalXAmount,
          totalYAmount,
          strategyType,
          lowerPricePerToken,
          upperPricePerToken,
          pnlPct: p.pnlPctChange !== undefined ? String(p.pnlPctChange) : '0',
          pnlSol: p.pnlSol !== undefined ? String(p.pnlSol) : '0',
          pool: {
            address: p.poolAddress,
            name: `${p.tokenX}-${p.tokenY}`,
            activeId,
            binStep,
            activePricePerToken,
            tokenX: { address: p.tokenXMint, symbol: p.tokenX, decimals: decimalsX },
            tokenY: { address: p.tokenYMint, symbol: p.tokenY, decimals: decimalsY },
            pnlPct: p.pnlPctChange !== undefined ? String(p.pnlPctChange) : '0',
            pnlSol: p.pnlSol !== undefined ? String(p.pnlSol) : '0',
          },
        });
      }
    } catch (e) {
      console.error(`[meteora] Failed to fetch position details for pool ${p.poolAddress}:`, (e as Error).message);
    }
  }

  return results;
}

/** Format a Meteora app URL for a given position */
export function getPositionUrl(positionAddress: string): string {
  return `https://app.meteora.ag/dlmm?position=${positionAddress}`;
}
