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
  if (!positionBinData || positionBinData.length === 0) return 'Unknown';
  if (positionBinData.length === 1) return 'Spot';
  if (positionBinData.length <= 2) return 'Spot';

  const liquidities = positionBinData.map(b => parseFloat(b.positionLiquidity || '0'));
  const total = liquidities.reduce((a, b) => a + b, 0);
  if (total === 0) return 'Unknown';

  const n = liquidities.length;
  const normalized = liquidities.map(l => l / total);

  // Coefficient of Variation — how "uneven" the distribution is
  const mean = 1 / n; // normalized mean is always 1/n
  const variance = normalized.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const cv = Math.sqrt(variance) / mean;

  // If very uniform (CV < 0.15), it's Spot
  if (cv < 0.15) return 'Spot';

  // Compare edge weight vs center weight to distinguish Curve from BidAsk
  // Take outer 25% bins as "edges" and inner 50% as "center"
  const edgeCount = Math.max(1, Math.floor(n * 0.25));
  const edgeSum =
    normalized.slice(0, edgeCount).reduce((a, b) => a + b, 0) +
    normalized.slice(n - edgeCount).reduce((a, b) => a + b, 0);
  const centerStart = Math.floor(n * 0.25);
  const centerEnd = Math.ceil(n * 0.75);
  const centerSlice = normalized.slice(centerStart, centerEnd);
  const centerSum = centerSlice.reduce((a, b) => a + b, 0);

  // Ratio: how much heavier is center vs edges?
  // Curve: center >> edges → centerWeight high
  // BidAsk: edges >> center → edgeWeight high
  const totalEdgeBins = edgeCount * 2;
  const totalCenterBins = centerEnd - centerStart;
  const edgeAvg = edgeSum / totalEdgeBins;
  const centerAvg = centerSum / totalCenterBins;

  if (centerAvg > edgeAvg * 1.3) {
    return 'Curve';
  } else if (edgeAvg > centerAvg * 1.3) {
    return 'BidAsk';
  }

  // If distribution is uneven but doesn't clearly match either pattern,
  // check if one side dominates (another BidAsk indicator)
  const midpoint = Math.floor(n / 2);
  const leftSum = normalized.slice(0, midpoint).reduce((a, b) => a + b, 0);
  const rightSum = normalized.slice(midpoint).reduce((a, b) => a + b, 0);
  const sideRatio = Math.min(leftSum, rightSum) / Math.max(leftSum, rightSum);

  // Strong one-sided concentration suggests BidAsk
  if (sideRatio < 0.35 && cv > 0.3) return 'BidAsk';

  // Moderate unevenness that's still somewhat symmetric → Curve
  if (cv > 0.2) return 'Curve';

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
          pool: {
            address: p.poolAddress,
            name: `${p.tokenX}-${p.tokenY}`,
            activeId,
            binStep,
            activePricePerToken,
            tokenX: { address: p.tokenXMint, symbol: p.tokenX, decimals: decimalsX },
            tokenY: { address: p.tokenYMint, symbol: p.tokenY, decimals: decimalsY },
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
