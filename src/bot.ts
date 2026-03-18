import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  addWallet,
  removeWallet,
  listWallets,
  getAllPositions,
  getProximityThreshold,
  setConfig,
  setChatId,
  getChatId,
  walletExists,
} from './db';
import { fetchPortfolio, RateLimitError, getPositionUrl, binIdToPrice } from './meteora';
import { runPollingCycle } from './monitor';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function shortAddr(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtNum(n: number, digits = 6): string {
  if (n === 0) return '0';
  if (Math.abs(n) < 0.000001) return n.toExponential(2);
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtPrice(price: number): string {
  if (price === 0) return '0';
  if (price < 0.0001) return price.toExponential(4);
  if (price < 1) return price.toFixed(6);
  if (price < 1000) return price.toFixed(4);
  return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function strategyEmoji(s: string): string {
  switch (s) {
    case 'Spot': return '🎯';
    case 'Curve': return '🔔';
    case 'BidAsk': return '📊';
    default: return '❓';
  }
}

async function reply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await ctx.reply(text.replace(/<[^>]*>/g, ''));
  }
}

// ─── Command Registration ─────────────────────────────────────────────────────

export function registerCommands(bot: Telegraf<Context>): void {

  // ─── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const existing = getChatId();

    if (!existing) {
      setChatId(chatId);
      await reply(ctx,
        `👋 <b>Meteora DLMM LP Monitor</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `✅ Chat ID <code>${chatId}</code> disimpan.\n` +
        `Semua alert akan dikirim ke sini.\n\n` +
        `Ketik /help untuk melihat daftar command.`
      );
    } else {
      await reply(ctx,
        `👋 Bot sudah aktif!\n\nChat ID: <code>${existing}</code>\nKetik /help untuk melihat command.`
      );
    }
  });

  // ─── /help ─────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await reply(ctx,
      `📖 <b>Meteora LP Monitor — Commands</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>🔑 Wallet</b>\n` +
      `/addwallet <code>&lt;address&gt;</code> — track wallet\n` +
      `/removewallet <code>&lt;address&gt;</code> — stop tracking\n` +
      `/wallets — list semua wallet\n\n` +
      `<b>📊 Monitor</b>\n` +
      `/status — snapshot semua posisi\n` +
      `/fees — lihat unclaimed fees\n` +
      `/setthreshold <code>&lt;N&gt;</code> — jarak warning (bins)\n\n` +
      `<b>ℹ️ Info</b>\n` +
      `/help — pesan ini\n` +
      `/start — set chat ID\n\n` +
      `<b>Alert Types:</b>\n` +
      `🔴 Out of Range\n` +
      `⚠️ Approaching Edge\n` +
      `✅ Back in Range\n` +
      `🆕 New Position`
    );
  });

  // ─── /addwallet ────────────────────────────────────────────────────────────
  bot.command('addwallet', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];

    if (!address) {
      return reply(ctx, `⚠️ Usage: /addwallet <code>&lt;solana_address&gt;</code>`);
    }
    if (!isValidSolanaAddress(address)) {
      return reply(ctx, `❌ Alamat tidak valid. Pastikan itu Solana address yang benar.`);
    }

    const added = addWallet(address);
    if (added) {
      await reply(ctx,
        `✅ <b>Wallet ditambahkan!</b>\n\n` +
        `<code>${escapeHtml(address)}</code>\n\n` +
        `Monitoring akan mulai di poll cycle berikutnya (maks 60 detik).`
      );
    } else {
      await reply(ctx, `ℹ️ Wallet sudah ada di daftar tracking.`);
    }
  });

  // ─── /removewallet ─────────────────────────────────────────────────────────
  bot.command('removewallet', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];

    if (!address) {
      return reply(ctx, `⚠️ Usage: /removewallet <code>&lt;solana_address&gt;</code>`);
    }

    const removed = removeWallet(address);
    if (removed) {
      await reply(ctx,
        `🗑️ <b>Wallet dihapus</b>\n\n<code>${escapeHtml(address)}</code>\n\nSemua data posisi terkait juga dihapus.`
      );
    } else {
      await reply(ctx, `⚠️ Wallet tidak ditemukan di daftar tracking.`);
    }
  });

  // ─── /wallets ──────────────────────────────────────────────────────────────
  bot.command('wallets', async (ctx) => {
    const wallets = listWallets();

    if (wallets.length === 0) {
      return reply(ctx,
        `📭 Belum ada wallet ditrack.\n\nGunakan /addwallet <code>&lt;address&gt;</code>`
      );
    }

    const lines = wallets.map((w, i) => {
      const date = new Date(w.added_at).toLocaleDateString('id-ID');
      return `${i + 1}. <code>${escapeHtml(w.address)}</code>\n    📅 ${date}`;
    });

    await reply(ctx,
      `👛 <b>Wallet Ditrack (${wallets.length})</b>\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n\n')}`
    );
  });

  // ─── /status ───────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const loadingMsg = await ctx.reply('🔄 Fetching positions...');

    try {
      const chatId = getChatId();
      if (!chatId) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        return reply(ctx, `⚠️ Chat ID belum di-set. Kirim /start dulu.`);
      }

      await runPollingCycle(bot);
      const positions = getAllPositions();
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);

      if (positions.length === 0) {
        return reply(ctx,
          `📭 Tidak ada posisi aktif.\n\nPastikan wallet sudah ditambah dan punya open DLMM positions.`
        );
      }

      const threshold = getProximityThreshold();

      // Build per-position cards
      const cards: string[] = [];
      for (const pos of positions) {
        const inRange = Boolean(pos.is_in_range);
        const distToUpper = pos.upper_bin_id - pos.last_known_active_bin;
        const distToLower = pos.last_known_active_bin - pos.lower_bin_id;
        const prox = Math.min(distToUpper, distToLower);

        let statusLine: string;
        if (!inRange) {
          const dir = pos.last_known_active_bin > pos.upper_bin_id ? '📈' : '📉';
          statusLine = `🔴 <b>OUT OF RANGE</b> ${dir}`;
        } else if (prox <= threshold) {
          const side = distToUpper <= distToLower ? '⬆️' : '⬇️';
          statusLine = `⚠️ <b>APPROACHING</b> ${side} (${prox} bins)`;
        } else {
          statusLine = `✅ <b>IN RANGE</b>`;
        }

        // Price display
        const binStep = pos.bin_step || 0;
        let priceInfo: string;
        if (binStep > 0) {
          const curPrice = binIdToPrice(pos.last_known_active_bin, binStep, pos.token_x_decimals, pos.token_y_decimals);
          const lowPrice = binIdToPrice(pos.lower_bin_id, binStep, pos.token_x_decimals, pos.token_y_decimals);
          const highPrice = binIdToPrice(pos.upper_bin_id, binStep, pos.token_x_decimals, pos.token_y_decimals);
          const unit = `${escapeHtml(pos.token_y_symbol)}/${escapeHtml(pos.token_x_symbol)}`;
          priceInfo = [
            `💲 Price: <b>${fmtPrice(curPrice)}</b> ${unit}`,
            `📏 Range: ${fmtPrice(lowPrice)} → ${fmtPrice(highPrice)}`,
          ].join('\n');
        } else {
          priceInfo = [
            `🎯 Active Bin: <b>${pos.last_known_active_bin}</b>`,
            `📏 Range: ${pos.lower_bin_id} → ${pos.upper_bin_id}`,
          ].join('\n');
        }

        const strategy = pos.strategy_type || 'Unknown';

        cards.push([
          `<b>${escapeHtml(pos.pool_name)}</b>  ${strategyEmoji(strategy)} ${strategy}`,
          statusLine,
          priceInfo,
          `💎 ${fmtNum(pos.total_x_amount)} <b>${escapeHtml(pos.token_x_symbol)}</b> + ${fmtNum(pos.total_y_amount)} <b>${escapeHtml(pos.token_y_symbol)}</b>`,
          `💰 Fees: ${fmtNum(pos.unclaimed_fee_x)} <b>${escapeHtml(pos.token_x_symbol)}</b> + ${fmtNum(pos.unclaimed_fee_y)} <b>${escapeHtml(pos.token_y_symbol)}</b>`,
          `🔗 <a href="${getPositionUrl(pos.position_address)}">${shortAddr(pos.position_address)}</a>`,
        ].join('\n'));
      }

      const header = `📊 <b>Status — ${positions.length} posisi</b>\n━━━━━━━━━━━━━━━━━━`;
      await reply(ctx, header + '\n\n' + cards.join('\n\n━━━━━━━━━━━━━━━━━━\n\n'));

    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      if (err instanceof RateLimitError) {
        return reply(ctx, `⚠️ Rate limit API. Coba lagi dalam beberapa detik.`);
      }
      console.error('[bot] /status error:', err);
      await reply(ctx, `❌ Error saat mengambil data. Cek log untuk detail.`);
    }
  });

  // ─── /fees ─────────────────────────────────────────────────────────────────
  bot.command('fees', async (ctx) => {
    const positions = getAllPositions();

    if (positions.length === 0) {
      return reply(ctx,
        `📭 Tidak ada posisi. Gunakan /addwallet lalu /status untuk refresh.`
      );
    }

    const cards: string[] = [];
    for (const pos of positions) {
      const hasFees = pos.unclaimed_fee_x > 0 || pos.unclaimed_fee_y > 0;
      const feeEmoji = hasFees ? '💰' : '➖';

      cards.push([
        `<b>${escapeHtml(pos.pool_name)}</b>  ${strategyEmoji(pos.strategy_type || 'Unknown')} ${pos.strategy_type || 'Unknown'}`,
        `${feeEmoji} ${fmtNum(pos.unclaimed_fee_x)} <b>${escapeHtml(pos.token_x_symbol)}</b> + ${fmtNum(pos.unclaimed_fee_y)} <b>${escapeHtml(pos.token_y_symbol)}</b>`,
        `🔗 <a href="${getPositionUrl(pos.position_address)}">${shortAddr(pos.position_address)}</a>`,
      ].join('\n'));
    }

    const header = `💰 <b>Unclaimed Fees</b>\n━━━━━━━━━━━━━━━━━━`;
    await reply(ctx, header + '\n\n' + cards.join('\n\n'));
  });

  // ─── /setthreshold ─────────────────────────────────────────────────────────
  bot.command('setthreshold', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const raw = parts[1];

    if (!raw) {
      const current = getProximityThreshold();
      return reply(ctx,
        `⚠️ Usage: /setthreshold <code>&lt;N&gt;</code>\n\nSaat ini: <b>${current} bins</b>`
      );
    }

    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1 || n > 1000) {
      return reply(ctx, `❌ Nilai tidak valid. Gunakan angka 1–1000.`);
    }

    setConfig('proximity_threshold', String(n));
    await reply(ctx,
      `✅ Threshold diubah ke <b>${n} bins</b>.\n\n⚠️ Warning akan dikirim saat posisi dalam jarak ${n} bin dari edge.`
    );
  });

  // ─── Fallback ──────────────────────────────────────────────────────────────
  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      await reply(ctx, `❓ Command tidak dikenal. Ketik /help`);
    }
  });
}
