import { Telegraf, Context } from 'telegraf';
import { PortfolioPosition, AlertType, PositionAlert } from './types';
import {
  getAllTrackedWallets,
  getPosition,
  upsertPosition,
  deletePosition,
  getKnownPositionAddresses,
  getProximityThreshold,
} from './db';
import { fetchPortfolio, RateLimitError, delay } from './meteora';
import { sendAlert } from './alerts';

// ─── Core Computation ─────────────────────────────────────────────────────────

interface PositionState {
  isInRange: boolean;
  proximityDistance: number;
  proximitySide: 'upper' | 'lower' | null;
}

function computeState(
  lowerBinId: number,
  upperBinId: number,
  activeId: number
): PositionState {
  const isInRange = activeId >= lowerBinId && activeId <= upperBinId;

  if (!isInRange) {
    return { isInRange, proximityDistance: Infinity, proximitySide: null };
  }

  const distToUpper = upperBinId - activeId;
  const distToLower = activeId - lowerBinId;

  if (distToUpper <= distToLower) {
    return { isInRange, proximityDistance: distToUpper, proximitySide: 'upper' };
  } else {
    return { isInRange, proximityDistance: distToLower, proximitySide: 'lower' };
  }
}

// ─── Single Position Processing ───────────────────────────────────────────────

async function processPosition(
  bot: Telegraf<Context>,
  chatId: string,
  walletAddress: string,
  apiPos: PortfolioPosition,
  threshold: number
): Promise<void> {
  const {
    positionAddress, lowerBinId, upperBinId,
    totalUnclaimedFeeX, totalUnclaimedFeeY,
    totalXAmount, totalYAmount, strategyType,
    lowerPricePerToken, upperPricePerToken,
    pool,
  } = apiPos;
  const activeId = pool.activeId;
  const { isInRange, proximityDistance, proximitySide } = computeState(lowerBinId, upperBinId, activeId);

  const stored = getPosition(chatId, positionAddress);

  const baseAlert: Omit<PositionAlert, 'alertType'> = {
    chatId,
    walletAddress,
    positionAddress,
    poolAddress: pool.address,
    poolName: pool.name,
    tokenXSymbol: pool.tokenX.symbol,
    tokenYSymbol: pool.tokenY.symbol,
    tokenXDecimals: pool.tokenX.decimals,
    tokenYDecimals: pool.tokenY.decimals,
    lowerBinId,
    upperBinId,
    activeId,
    binStep: pool.binStep,
    isInRange,
    proximityDistance,
    proximitySide,
    unclaimedFeeX: totalUnclaimedFeeX,
    unclaimedFeeY: totalUnclaimedFeeY,
    totalXAmount,
    totalYAmount,
    strategyType,
    activePrice: pool.activePricePerToken,
    lowerPrice: lowerPricePerToken,
    upperPrice: upperPricePerToken,
  };

  let oorAlertSent = stored?.oor_alert_sent ? 1 : 0;
  let approachingAlertSent = stored?.approaching_alert_sent ? 1 : 0;

  if (!stored) {
    await sendAlert(bot, chatId, { ...baseAlert, alertType: AlertType.NEW_POSITION });
    oorAlertSent = 0;
    approachingAlertSent = 0;
  } else {
    const wasInRange = Boolean(stored.is_in_range);

    if (wasInRange && !isInRange) {
      await sendAlert(bot, chatId, { ...baseAlert, alertType: AlertType.OOR });
      oorAlertSent = 1;
      approachingAlertSent = 1;
    } else if (!wasInRange && isInRange) {
      await sendAlert(bot, chatId, { ...baseAlert, alertType: AlertType.BACK_IN_RANGE });
      oorAlertSent = 0;
      approachingAlertSent = 0;
    } else if (isInRange && !stored.approaching_alert_sent) {
      if (proximityDistance <= threshold) {
        await sendAlert(bot, chatId, { ...baseAlert, alertType: AlertType.APPROACHING });
        approachingAlertSent = 1;
      }
    }
  }

  upsertPosition({
    chat_id: chatId,
    wallet_address: walletAddress,
    position_address: positionAddress,
    pool_address: pool.address,
    pool_name: pool.name,
    token_x_symbol: pool.tokenX.symbol,
    token_y_symbol: pool.tokenY.symbol,
    token_x_decimals: pool.tokenX.decimals,
    token_y_decimals: pool.tokenY.decimals,
    lower_bin_id: lowerBinId,
    upper_bin_id: upperBinId,
    last_known_active_bin: activeId,
    bin_step: pool.binStep,
    is_in_range: isInRange ? 1 : 0,
    oor_alert_sent: oorAlertSent,
    approaching_alert_sent: approachingAlertSent,
    unclaimed_fee_x: totalUnclaimedFeeX,
    unclaimed_fee_y: totalUnclaimedFeeY,
    total_x_amount: totalXAmount,
    total_y_amount: totalYAmount,
    strategy_type: strategyType,
    active_price: pool.activePricePerToken,
    lower_price: lowerPricePerToken,
    upper_price: upperPricePerToken,
    updated_at: Date.now(),
  });
}

// ─── Single Wallet Processing ─────────────────────────────────────────────────

async function processWallet(
  bot: Telegraf<Context>,
  chatId: string,
  walletAddress: string,
  threshold: number
): Promise<void> {
  let positions: PortfolioPosition[];

  try {
    positions = await fetchPortfolio(walletAddress);
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw err;
    }
    console.error(`[monitor] Error fetching portfolio for ${walletAddress}:`, err);
    return;
  }

  const knownAddresses = getKnownPositionAddresses(chatId, walletAddress);
  const seenAddresses = new Set<string>();

  for (const pos of positions) {
    seenAddresses.add(pos.positionAddress);
    await processPosition(bot, chatId, walletAddress, pos, threshold);
    await delay(100);
  }

  for (const addr of knownAddresses) {
    if (!seenAddresses.has(addr)) {
      deletePosition(chatId, addr);
      console.log(`[monitor] Removed closed position for user ${chatId}: ${addr}`);
    }
  }
}

// ─── Main Poll Cycle ──────────────────────────────────────────────────────────

export async function runPollingCycle(bot: Telegraf<Context>): Promise<void> {
  const allWallets = getAllTrackedWallets();
  if (allWallets.length === 0) {
    return;
  }

  const threshold = getProximityThreshold();
  console.log(`[monitor] Polling ${allWallets.length} wallet(s) at ${new Date().toISOString()}`);

  for (const wallet of allWallets) {
    try {
      await processWallet(bot, wallet.chat_id, wallet.address, threshold);
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.warn('[monitor] Rate limited. Aborting poll cycle.');
        return;
      }
      console.error(`[monitor] Unexpected error for wallet ${wallet.address}:`, err);
    }
    await delay(200);
  }

  console.log('[monitor] Poll cycle complete.');
}

// ─── Start Monitor ────────────────────────────────────────────────────────────

export function startMonitor(bot: Telegraf<Context>): NodeJS.Timeout {
  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10);
  console.log(`[monitor] Starting polling loop every ${intervalMs}ms`);

  setTimeout(() => {
    runPollingCycle(bot).catch((err) => console.error('[monitor] Initial poll error:', err));
  }, 5000);

  return setInterval(() => {
    runPollingCycle(bot).catch((err) => console.error('[monitor] Poll error:', err));
  }, intervalMs);
}
