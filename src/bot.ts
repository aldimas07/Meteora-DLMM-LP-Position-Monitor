import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  addWallet,
  removeWallet,
  listWallets,
  getAllPositions,
  getProximityThreshold,
  setConfig,
  registerUser,
  isNewUser,
  getTotalUsers,
  getAllTrackedWallets,
} from './db';
import { getPositionUrl, formatPriceStr } from './meteora';
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

async function notifyAdmin(bot: Telegraf<Context>, text: string): Promise<void> {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) return;
  try {
    await bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[bot] Failed to send admin alert:', err);
  }
}

// ─── Command Registration ─────────────────────────────────────────────────────

export function registerCommands(bot: Telegraf<Context>): void {

  // ─── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const username = ctx.from?.username || '';
    const firstName = ctx.from?.first_name || '';

    const isNew = isNewUser(chatId);
    registerUser(chatId, username, firstName);

    if (isNew) {
      const userDisplay = username ? `@${username}` : firstName;
      const total = getTotalUsers();
      void notifyAdmin(
        bot,
        `🚨 <b>New User!</b>\n` +
        `👤 ${escapeHtml(userDisplay)}\n` +
        `🆔 <code>${chatId}</code>\n` +
        `📊 Total Users: ${total}`
      );
    }

    await reply(ctx,
      `👋 <b>Meteora DLMM LP Monitor</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ Chat ID <code>${chatId}</code> tersimpan.\n\n` +
      `Ketik /help untuk melihat daftar command.`
    );
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
      `/help — pesan ini`
    );
  });

  // ─── /addwallet ────────────────────────────────────────────────────────────
  bot.command('addwallet', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];

    if (!address) {
      return reply(ctx, `⚠️ Usage: /addwallet <code>&lt;solana_address&gt;</code>`);
    }
    if (!isValidSolanaAddress(address)) {
      return reply(ctx, `❌ Alamat tidak valid.`);
    }

    registerUser(chatId, ctx.from?.username || '', ctx.from?.first_name || '');

    const added = addWallet(chatId, address);
    if (added) {
      await reply(ctx,
        `✅ <b>Wallet ditambahkan!</b>\n\n` +
        `<code>${escapeHtml(address)}</code>\n\n` +
        `Monitoring dimulai di poll cycle berikutnya.`
      );
    } else {
      await reply(ctx, `ℹ️ Wallet sudah ada di daftar tracking kamu.`);
    }
  });

  // ─── /removewallet ─────────────────────────────────────────────────────────
  bot.command('removewallet', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];

    if (!address) {
      return reply(ctx, `⚠️ Usage: /removewallet <code>&lt;solana_address&gt;</code>`);
    }

    const removed = removeWallet(chatId, address);
    if (removed) {
      await reply(ctx,
        `🗑️ <b>Wallet dihapus</b>\n\n<code>${escapeHtml(address)}</code>`
      );
    } else {
      await reply(ctx, `⚠️ Wallet tidak ditemukan di daftar tracking kamu.`);
    }
  });

  // ─── /wallets ──────────────────────────────────────────────────────────────
  bot.command('wallets', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const wallets = listWallets(chatId);

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
    const chatId = String(ctx.chat.id);
    const loadingMsg = await ctx.reply('🔄 Syncing positions...');

    try {
      await runPollingCycle(bot);

      const positions = getAllPositions(chatId);
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

      if (positions.length === 0) {
        return reply(ctx,
          `📭 Tidak ada posisi aktif.\n\nPastikan wallet ditambah dan punya open DLMM positions.`
        );
      }

      const threshold = getProximityThreshold();
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

        const strategy = pos.strategy_type || 'Unknown';
        const unit = `${escapeHtml(pos.token_y_symbol)} per ${escapeHtml(pos.token_x_symbol)}`;
        const activeP = formatPriceStr(pos.active_price || '0');
        const lowP = formatPriceStr(pos.lower_price || '0');
        const highP = formatPriceStr(pos.upper_price || '0');

        cards.push([
          `<b>${escapeHtml(pos.pool_name)}</b>  ${strategyEmoji(strategy)} ${strategy}`,
          statusLine,
          `💲 Harga: <b>${activeP}</b> ${unit}`,
          `📏 Range: ${lowP} → ${highP}`,
          `💎 ${fmtNum(pos.total_x_amount)} <b>${escapeHtml(pos.token_x_symbol)}</b> + ${fmtNum(pos.total_y_amount)} <b>${escapeHtml(pos.token_y_symbol)}</b>`,
          `💰 Fees: ${fmtNum(pos.unclaimed_fee_x)} <b>${escapeHtml(pos.token_x_symbol)}</b> + ${fmtNum(pos.unclaimed_fee_y)} <b>${escapeHtml(pos.token_y_symbol)}</b>`,
          `🔗 <a href="${getPositionUrl(pos.position_address)}">${shortAddr(pos.position_address)}</a>`,
        ].join('\n'));
      }

      await reply(ctx, `📊 <b>Status — ${positions.length} posisi</b>\n━━━━━━━━━━━━━━━━━━\n\n` + cards.join('\n\n━━━━━━━━━━━━━━━━━━\n\n'));

    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      console.error('[bot] /status error:', err);
      await reply(ctx, `❌ Error mengambil data.`);
    }
  });

  // ─── /fees ─────────────────────────────────────────────────────────────────
  bot.command('fees', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const positions = getAllPositions(chatId);

    if (positions.length === 0) {
      return reply(ctx,
        `📭 Tidak ada posisi. /status untuk refresh data.`
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

    await reply(ctx, `💰 <b>Unclaimed Fees</b>\n━━━━━━━━━━━━━━━━━━\n\n` + cards.join('\n\n'));
  });

  // ─── /adminstats ───────────────────────────────────────────────────────────
  bot.command('adminstats', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const adminId = process.env.ADMIN_CHAT_ID;

    if (!adminId || chatId !== adminId) {
      return reply(ctx, `⛔ Command ini hanya untuk Admin.`);
    }

    const totalUsers = getTotalUsers();
    const wallets = getAllTrackedWallets();
    await reply(ctx,
      `📈 <b>System Stats</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
      `👥 Users: <b>${totalUsers}</b>\n` +
      `👛 Wallets: <b>${wallets.length}</b>`
    );
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
      `✅ Threshold: <b>${n} bins</b>`
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
