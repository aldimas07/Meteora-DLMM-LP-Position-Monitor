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
import { fetchPortfolio, RateLimitError, getPositionUrl } from './meteora';
import { runPollingCycle } from './monitor';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Basic Solana address validation (base58, 32-44 chars) */
function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function shortAddr(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtFee(val: number): string {
  return val.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** Reply safely — falls back to plain text on HTML error */
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

// ─── Command: /start ──────────────────────────────────────────────────────────

export function registerCommands(bot: Telegraf<Context>): void {

  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const existing = getChatId();

    if (!existing) {
      setChatId(chatId);
      await reply(ctx,
        `👋 <b>Meteora DLMM LP Monitor</b> siap!\n\n` +
        `✅ Chat ID <code>${chatId}</code> disimpan. Semua alert akan dikirim ke sini.\n\n` +
        `Gunakan /help untuk melihat daftar command.`
      );
    } else {
      await reply(ctx,
        `👋 Bot sudah aktif!\n\nChat ID aktif: <code>${existing}</code>\n\nGunakan /help untuk melihat daftar command.`
      );
    }
  });

  // ─── Command: /help ────────────────────────────────────────────────────────

  bot.command('help', async (ctx) => {
    await reply(ctx,
      `📖 <b>Daftar Command</b>\n\n` +
      `<b>Wallet Management</b>\n` +
      `/addwallet <code>&lt;address&gt;</code> — tambah wallet untuk di-track\n` +
      `/removewallet <code>&lt;address&gt;</code> — stop tracking wallet\n` +
      `/wallets — lihat semua wallet yang ditrack\n\n` +
      `<b>Monitoring</b>\n` +
      `/status — snapshot semua posisi saat ini\n` +
      `/fees — lihat unclaimed fees semua posisi\n` +
      `/setthreshold <code>&lt;N&gt;</code> — ubah jarak warning (default: 5 bins)\n\n` +
      `<b>Info</b>\n` +
      `/help — tampilkan pesan ini\n` +
      `/start — set/cek chat ID alert`
    );
  });

  // ─── Command: /addwallet ───────────────────────────────────────────────────

  bot.command('addwallet', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];

    if (!address) {
      return reply(ctx, `⚠️ Usage: /addwallet <code>&lt;solana_address&gt;</code>`);
    }
    if (!isValidSolanaAddress(address)) {
      return reply(ctx, `❌ Alamat tidak valid. Pastikan itu adalah Solana address yang benar.`);
    }

    const added = addWallet(address);
    if (added) {
      await reply(ctx,
        `✅ Wallet ditambahkan!\n\n<code>${escapeHtml(address)}</code>\n\nMonitoring akan mulai di poll cycle berikutnya.`
      );
    } else {
      await reply(ctx,
        `ℹ️ Wallet sudah ada di daftar tracking:\n\n<code>${escapeHtml(address)}</code>`
      );
    }
  });

  // ─── Command: /removewallet ────────────────────────────────────────────────

  bot.command('removewallet', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = parts[1];

    if (!address) {
      return reply(ctx, `⚠️ Usage: /removewallet <code>&lt;solana_address&gt;</code>`);
    }

    const removed = removeWallet(address);
    if (removed) {
      await reply(ctx,
        `🗑️ Wallet dihapus dari tracking:\n\n<code>${escapeHtml(address)}</code>\n\nSemua data posisi terkait juga dihapus.`
      );
    } else {
      await reply(ctx,
        `⚠️ Wallet tidak ditemukan di daftar tracking:\n\n<code>${escapeHtml(address)}</code>`
      );
    }
  });

  // ─── Command: /wallets ─────────────────────────────────────────────────────

  bot.command('wallets', async (ctx) => {
    const wallets = listWallets();

    if (wallets.length === 0) {
      return reply(ctx,
        `📭 Belum ada wallet yang ditrack.\n\nGunakan /addwallet <code>&lt;address&gt;</code> untuk mulai.`
      );
    }

    const lines = wallets.map((w, i) => {
      const date = new Date(w.added_at).toLocaleDateString('id-ID');
      return `${i + 1}. <code>${escapeHtml(w.address)}</code>\n    📅 Ditambah: ${date}`;
    });

    await reply(ctx,
      `👛 <b>Wallet yang Ditrack (${wallets.length})</b>\n\n${lines.join('\n\n')}`
    );
  });

  // ─── Command: /status ──────────────────────────────────────────────────────

  bot.command('status', async (ctx) => {
    const loadingMsg = await ctx.reply('🔄 Mengambil data posisi terbaru...');

    try {
      const chatId = getChatId();
      if (!chatId) {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        return reply(ctx, `⚠️ Chat ID belum di-set. Kirim /start dulu.`);
      }

      // Trigger a fresh poll cycle to update DB
      await runPollingCycle(bot);

      const positions = getAllPositions();
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);

      if (positions.length === 0) {
        return reply(ctx,
          `📭 Tidak ada posisi aktif ditemukan.\n\n` +
          `Pastikan wallet sudah ditambah dan punya open DLMM positions.`
        );
      }

      const threshold = getProximityThreshold();
      const lines: string[] = [`📊 <b>Status Posisi (${positions.length})</b>\n`];

      for (const pos of positions) {
        const inRange = Boolean(pos.is_in_range);
        const distToUpper = pos.upper_bin_id - pos.last_known_active_bin;
        const distToLower = pos.last_known_active_bin - pos.lower_bin_id;
        const prox = Math.min(distToUpper, distToLower);

        let statusEmoji: string;
        let statusText: string;
        if (!inRange) {
          statusEmoji = '🔴';
          statusText = 'OUT OF RANGE';
        } else if (prox <= threshold) {
          statusEmoji = '⚠️';
          statusText = `APPROACHING (${prox} bins)`;
        } else {
          statusEmoji = '✅';
          statusText = 'IN RANGE';
        }

        lines.push(
          `${statusEmoji} <b>${escapeHtml(pos.pool_name)}</b>\n` +
          `   Status: <b>${statusText}</b>\n` +
          `   Active Bin: ${pos.last_known_active_bin} | Range: ${pos.lower_bin_id}–${pos.upper_bin_id}\n` +
          `   Fees: ${fmtFee(pos.unclaimed_fee_x)} ${escapeHtml(pos.token_x_symbol)} / ${fmtFee(pos.unclaimed_fee_y)} ${escapeHtml(pos.token_y_symbol)}\n` +
          `   <a href="${getPositionUrl(pos.position_address)}"><code>${shortAddr(pos.position_address)}</code></a>`
        );
      }

      await reply(ctx, lines.join('\n'));
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
      if (err instanceof RateLimitError) {
        return reply(ctx, `⚠️ Rate limit API. Coba lagi dalam beberapa detik.`);
      }
      console.error('[bot] /status error:', err);
      await reply(ctx, `❌ Terjadi error saat mengambil data. Cek log untuk detail.`);
    }
  });

  // ─── Command: /fees ────────────────────────────────────────────────────────

  bot.command('fees', async (ctx) => {
    const positions = getAllPositions();

    if (positions.length === 0) {
      return reply(ctx,
        `📭 Tidak ada posisi ditemukan di database.\n\nGunakan /addwallet lalu tunggu poll cycle pertama, atau coba /status untuk refresh.`
      );
    }

    const lines: string[] = [`💰 <b>Unclaimed Fees</b>\n`];

    let anyFees = false;
    for (const pos of positions) {
      const hasFees = pos.unclaimed_fee_x > 0 || pos.unclaimed_fee_y > 0;
      if (hasFees) anyFees = true;

      lines.push(
        `🏊 <b>${escapeHtml(pos.pool_name)}</b>\n` +
        `   ${fmtFee(pos.unclaimed_fee_x)} <b>${escapeHtml(pos.token_x_symbol)}</b> / ${fmtFee(pos.unclaimed_fee_y)} <b>${escapeHtml(pos.token_y_symbol)}</b>\n` +
        `   <a href="${getPositionUrl(pos.position_address)}"><code>${shortAddr(pos.position_address)}</code></a>`
      );
    }

    if (!anyFees) {
      lines.push(`\nℹ️ Semua posisi belum ada unclaimed fees.`);
    }

    await reply(ctx, lines.join('\n'));
  });

  // ─── Command: /setthreshold ────────────────────────────────────────────────

  bot.command('setthreshold', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const raw = parts[1];

    if (!raw) {
      const current = getProximityThreshold();
      return reply(ctx,
        `⚠️ Usage: /setthreshold <code>&lt;N&gt;</code>\n\nThreshold saat ini: <b>${current} bins</b>`
      );
    }

    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1 || n > 1000) {
      return reply(ctx, `❌ Nilai tidak valid. Gunakan angka antara 1–1000.`);
    }

    setConfig('proximity_threshold', String(n));
    await reply(ctx,
      `✅ Proximity threshold diubah ke <b>${n} bins</b>.\n\nBot akan kirim ⚠️ warning saat posisi dalam jarak ${n} bin dari edge.`
    );
  });

  // ─── Fallback: unknown commands ────────────────────────────────────────────

  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      await reply(ctx,
        `❓ Command tidak dikenal. Gunakan /help untuk melihat daftar command yang tersedia.`
      );
    }
  });
}
