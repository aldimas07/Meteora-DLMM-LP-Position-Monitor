import { Telegraf, Context } from 'telegraf';
import { PositionAlert, AlertType } from './types';
import { getPositionUrl } from './meteora';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddr(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatFees(feeX: number, feeY: number, symbolX: string, symbolY: string): string {
  const fmtX = feeX.toLocaleString('en-US', { maximumFractionDigits: 6 });
  const fmtY = feeY.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return `${fmtX} ${symbolX} / ${fmtY} ${symbolY}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Message Formatters ───────────────────────────────────────────────────────

export function formatOOR(alert: PositionAlert): string {
  const direction = alert.activeId > alert.upperBinId
    ? '📈 Harga naik (melewati upper edge)'
    : '📉 Harga turun (melewati lower edge)';

  return [
    `🔴 <b>OUT OF RANGE</b>`,
    ``,
    `🏊 Pool: <b>${escapeHtml(alert.poolName)}</b>`,
    `📍 Posisi: <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `🎯 Active Bin: <b>${alert.activeId}</b>`,
    `📏 Range Kamu: ${alert.lowerBinId} — ${alert.upperBinId}`,
    `🧭 Arah: ${direction}`,
    ``,
    `💰 Unclaimed Fees:`,
    `   ${formatFees(alert.unclaimedFeeX, alert.unclaimedFeeY, alert.tokenXSymbol, alert.tokenYSymbol)}`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Lihat di Meteora</a>`,
  ].join('\n');
}

export function formatApproaching(alert: PositionAlert): string {
  const side = alert.proximitySide === 'upper' ? 'Upper (atas)' : 'Lower (bawah)';

  return [
    `⚠️ <b>APPROACHING RANGE EDGE</b>`,
    ``,
    `🏊 Pool: <b>${escapeHtml(alert.poolName)}</b>`,
    `📍 Posisi: <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `🎯 Active Bin: <b>${alert.activeId}</b>`,
    `📏 Range: ${alert.lowerBinId} — ${alert.upperBinId}`,
    `📐 Jarak ke edge: <b>${alert.proximityDistance} bins</b>`,
    `🧭 Sisi: ${side}`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Lihat di Meteora</a>`,
  ].join('\n');
}

export function formatBackInRange(alert: PositionAlert): string {
  return [
    `✅ <b>BACK IN RANGE</b>`,
    ``,
    `🏊 Pool: <b>${escapeHtml(alert.poolName)}</b>`,
    `📍 Posisi: <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `🎯 Active Bin: <b>${alert.activeId}</b> — kembali ke dalam range`,
    `📏 Range: ${alert.lowerBinId} — ${alert.upperBinId}`,
    ``,
    `💰 Unclaimed Fees:`,
    `   ${formatFees(alert.unclaimedFeeX, alert.unclaimedFeeY, alert.tokenXSymbol, alert.tokenYSymbol)}`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Lihat di Meteora</a>`,
  ].join('\n');
}

export function formatNewPosition(alert: PositionAlert): string {
  const statusEmoji = alert.isInRange ? '✅' : '🔴';
  const statusText = alert.isInRange ? 'IN RANGE' : 'OUT OF RANGE';

  return [
    `🆕 <b>NEW POSITION DETECTED</b>`,
    ``,
    `🏊 Pool: <b>${escapeHtml(alert.poolName)}</b>`,
    `📍 Posisi: <code>${escapeHtml(shortAddr(alert.positionAddress))}</code>`,
    ``,
    `📏 Range: ${alert.lowerBinId} — ${alert.upperBinId}`,
    `🎯 Active Bin: ${alert.activeId}`,
    `${statusEmoji} Status: <b>${statusText}</b>`,
    ``,
    `💰 Unclaimed Fees:`,
    `   ${formatFees(alert.unclaimedFeeX, alert.unclaimedFeeY, alert.tokenXSymbol, alert.tokenYSymbol)}`,
    ``,
    `🔗 <a href="${getPositionUrl(alert.positionAddress)}">Lihat di Meteora</a>`,
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
