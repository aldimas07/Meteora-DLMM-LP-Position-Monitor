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
 * On-chain positions don't store strategy type — we approximate by
 * analyzing per-bin liquidity distribution.
 */
function inferStrategyType(positionBinData: Array<{ positionLiquidity: string; binId: number }>): string {
  if (!positionBinData || positionBinData.length === 0) return 'Unknown';
  if (positionBinData.length === 1) return 'Spot';

  const liquidities = positionBinData.map(b => parseFloat(b.positionLiquidity || '0'));
  const maxLiq = Math.max(...liquidities);
  if (maxLiq === 0) return 'Unknown';

  const normalized = liquidities.map(l => l / maxLiq);

  // Check if relatively uniform → Spot
  const avg = normalized.reduce((a, b) => a + b, 0) / normalized.length;
  const variance = normalized.reduce((a, b) => a + (b - avg) ** 2, 0) / normalized.length;
  if (variance < 0.05) return 'Spot';

  // Check if peaked in the middle → Curve
  const midIndex = Math.floor(normalized.length / 2);
  const midValue = normalized[midIndex];
  const edgeAvg = (normalized[0] + normalized[normalized.length - 1]) / 2;
  if (midValue > edgeAvg * 1.5 && variance > 0.05) return 'Curve';

  // Check if one-sided concentration → BidAsk
  const firstHalf = normalized.slice(0, midIndex).reduce((a, b) => a + b, 0);
  const secondHalf = normalized.slice(midIndex).reduce((a, b) => a + b, 0);
  const sideRatio = Math.min(firstHalf, secondHalf) / Math.max(firstHalf, secondHalf);
  if (sideRatio < 0.3) return 'BidAsk';

  return 'Spot';
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

        // Infer strategy type from bin distribution
        const strategyType = inferStrategyType(pos.positionData.positionBinData);

        results.push({
          positionAddress: pos.publicKey.toBase58(),
          lowerBinId,
          upperBinId,
          totalUnclaimedFeeX: totalFeeX,
          totalUnclaimedFeeY: totalFeeY,
          totalXAmount,
          totalYAmount,
          strategyType,
          pool: {
            address: p.poolAddress,
            name: `${p.tokenX}-${p.tokenY}`,
            activeId,
            binStep,
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

/** Convert a bin ID to a human-readable price using binStep */
export function binIdToPrice(binId: number, binStep: number, decimalsX: number, decimalsY: number): number {
  const pricePerLamport = Math.pow(1 + binStep / 10000, binId);
  return pricePerLamport * Math.pow(10, decimalsX - decimalsY);
}
