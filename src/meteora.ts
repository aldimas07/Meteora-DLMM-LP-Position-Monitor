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
}

interface DatapiPortfolioResponse {
  pools?: DatapiPool[];
  listPositions?: string[]; // optionally present directly
}

// ─── API Client ───────────────────────────────────────────────────────────────

/**
 * Fetch all open DLMM positions for a given wallet address.
 * It first hits the REST API to discover which pools the user is in.
 * Then it uses the DLMM SDK to fetch the exact position limits & active bin.
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
    
    // The datapi returns { page, pageSize, hasNext, totalCount, pools: [...] }
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
      // Small delay to treat rate limits nice
      await delay(100);

      const poolPubkey = new PublicKey(p.poolAddress);
      
      // Load pool state via SDK to get activeBin
      const dlmm = await DLMM.create(conn, poolPubkey, { cluster: 'mainnet-beta' });
      const activeBin = await dlmm.getActiveBin();
      const activeId = activeBin.binId;
      
      // Load positions for this exact pool for the user
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(userPubkey);

      for (const pos of userPositions) {
        const lowerBinId = pos.positionData.lowerBinId;
        const upperBinId = pos.positionData.upperBinId;
        
        // Fee data from SDK is in BN. We approximate with 9 and 6 decimals
        // For accurate tracking, production bots would fetch mint info on-chain.
        const decimalsX = 9; // Common Solana default for base tokens
        const decimalsY = 6; // Common for stablecoins (USDC/USDT)
        
        // We use pure numbers for simplicity here
        const feeXRaw = parseFloat(pos.positionData.feeX.toString());
        const feeYRaw = parseFloat(pos.positionData.feeY.toString());
        
        const totalFeeX = feeXRaw / Math.pow(10, decimalsX);
        const totalFeeY = feeYRaw / Math.pow(10, decimalsY);

        results.push({
          positionAddress: pos.publicKey.toBase58(),
          lowerBinId,
          upperBinId,
          totalUnclaimedFeeX: totalFeeX,
          totalUnclaimedFeeY: totalFeeY,
          pool: {
            address: p.poolAddress,
            name: `${p.tokenX}-${p.tokenY}`,
            activeId,
            tokenX: {
              address: p.tokenXMint,
              symbol: p.tokenX,
              decimals: decimalsX
            },
            tokenY: {
              address: p.tokenYMint,
              symbol: p.tokenY,
              decimals: decimalsY
            }
          }
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
