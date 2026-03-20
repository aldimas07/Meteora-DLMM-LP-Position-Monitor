import { Telegraf, Context } from 'telegraf';
import { PositionAlert, AlertType } from './types';
import { getPositionUrl, formatPriceStr } from './meteora';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddr(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function fmtNum(n: number, digits = 6): string {
  if (n === 0) return '0';
  if (Math.abs(n) < 0.000001) return n.toExponential(2);
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function strategyEmoji(s: string): string {
  switch (s) {
    case 'Spot': return '🎯';
    case 'Curve': return '🔔';
    case 'BidAsk': return '📊';
    default: return '❓';
  }
}

function directionText(activeId: number, upperBinId: number): string {
  return activeId > upperBinId
    ? '📈 Harga naik (melewati upper)'
    : '📉 Harga turun (melewati lower)';
}

/** Format price unit label, e.g. "USDC per SOL" */
function priceUnit(alert: PositionAlert): string {
  return `${escapeHtml(alert.tokenYSymbol)} per ${escapeHtml(alert.tokenXSymbol)}`;
}

/** Format the range using SDK prices */
function priceRange(alert: PositionAlert): string {
  return `${formatPriceStr(alert.lowerPrice)} → ${formatPriceStr(alert.upperPrice)} ${priceUnit(alert)}`;
}

/** Format current price using SDK activePricePerToken */
function currentPrice(alert: PositionAlert): string {
  return `${formatPriceStr(alert.activePrice)} ${priceUnit(alert)}`;
}

// ─── Message Formatters ───────────────────────────────────────────────────────

export function formatOOR(alert: PositionAlert): string {
  return [
    `🔴 <b>OUT OF RANGE</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏊 <b>${escapeHtml(alert.poolName)}</b>  ${strategyEmoji(alert.strategyType)} ${alert.strategyType}`,
    `📍 <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `💲 Harga: <b>${currentPrice(alert)}</b>`,
    `📏 Range: ${priceRange(alert)}`,
    `🧭 ${directionText(alert.activeId, alert.upperBinId)}`,
    ``,
    `💎 Deposit:`,
    `   ${fmtNum(alert.totalXAmount)} <b>${escapeHtml(alert.tokenXSymbol)}</b> + ${fmtNum(alert.totalYAmount)} <b>${escapeHtml(alert.tokenYSymbol)}</b>`,
    `💰 Unclaimed Fees:`,
    `   ${fmtNum(alert.unclaimedFeeX)} <b>${escapeHtml(alert.tokenXSymbol)}</b> + ${fmtNum(alert.unclaimedFeeY)} <b>${escapeHtml(alert.tokenYSymbol)}</b>`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Buka di Meteora ↗</a>`,
  ].join('\n');
}

export function formatApproaching(alert: PositionAlert): string {
  const side = alert.proximitySide === 'upper' ? '⬆️ Upper' : '⬇️ Lower';

  return [
    `⚠️ <b>APPROACHING RANGE EDGE</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏊 <b>${escapeHtml(alert.poolName)}</b>  ${strategyEmoji(alert.strategyType)} ${alert.strategyType}`,
    `📍 <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `💲 Harga: <b>${currentPrice(alert)}</b>`,
    `📏 Range: ${priceRange(alert)}`,
    `📐 Jarak: <b>${alert.proximityDistance} bins</b> dari ${side}`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Buka di Meteora ↗</a>`,
  ].join('\n');
}

export function formatBackInRange(alert: PositionAlert): string {
  return [
    `✅ <b>BACK IN RANGE</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏊 <b>${escapeHtml(alert.poolName)}</b>  ${strategyEmoji(alert.strategyType)} ${alert.strategyType}`,
    `📍 <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `💲 Harga: <b>${currentPrice(alert)}</b> — kembali ke range!`,
    `📏 Range: ${priceRange(alert)}`,
    ``,
    `💎 Deposit:`,
    `   ${fmtNum(alert.totalXAmount)} <b>${escapeHtml(alert.tokenXSymbol)}</b> + ${fmtNum(alert.totalYAmount)} <b>${escapeHtml(alert.tokenYSymbol)}</b>`,
    `💰 Unclaimed Fees:`,
    `   ${fmtNum(alert.unclaimedFeeX)} <b>${escapeHtml(alert.tokenXSymbol)}</b> + ${fmtNum(alert.unclaimedFeeY)} <b>${escapeHtml(alert.tokenYSymbol)}</b>`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Buka di Meteora ↗</a>`,
  ].join('\n');
}

export function formatNewPosition(alert: PositionAlert): string {
  const statusEmoji = alert.isInRange ? '✅' : '🔴';
  const statusText = alert.isInRange ? 'IN RANGE' : 'OUT OF RANGE';

  return [
    `🆕 <b>NEW POSITION DETECTED</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏊 <b>${escapeHtml(alert.poolName)}</b>  ${strategyEmoji(alert.strategyType)} ${alert.strategyType}`,
    `📍 <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `💲 Harga: <b>${currentPrice(alert)}</b>`,
    `📏 Range: ${priceRange(alert)}`,
    `${statusEmoji} Status: <b>${statusText}</b>`,
    ``,
    `💎 Deposit:`,
    `   ${fmtNum(alert.totalXAmount)} <b>${escapeHtml(alert.tokenXSymbol)}</b> + ${fmtNum(alert.totalYAmount)} <b>${escapeHtml(alert.tokenYSymbol)}</b>`,
    `💰 Unclaimed Fees:`,
    `   ${fmtNum(alert.unclaimedFeeX)} <b>${escapeHtml(alert.tokenXSymbol)}</b> + ${fmtNum(alert.unclaimedFeeY)} <b>${escapeHtml(alert.tokenYSymbol)}</b>`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Buka di Meteora ↗</a>`,
  ].join('\n');
}

// ─── Send Functions ───────────────────────────────────────────────────────────

export async function sendAlert(
  bot: Telegraf<Context>,
  chatId: string,
  alert: PositionAlert
): Promise<void> {
  let text: string;

  switch (alert.alertType) {
    case AlertType.OOR:
      text = formatOOR(alert);
      break;
    case AlertType.APPROACHING:
      text = formatApproaching(alert);
      break;
    case AlertType.BACK_IN_RANGE:
      text = formatBackInRange(alert);
      break;
    case AlertType.NEW_POSITION:
      text = formatNewPosition(alert);
      break;
    default:
      return;
  }

  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error(`[alerts] Failed to send ${alert.alertType} alert:`, err);
  }
}

export async function sendMessage(
  bot: Telegraf<Context>,
  chatId: string,
  text: string
): Promise<void> {
  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error('[alerts] Failed to send message:', err);
  }
}
