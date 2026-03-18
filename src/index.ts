import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { initDb } from './db';
import { registerCommands } from './bot';
import { startMonitor } from './monitor';

async function main(): Promise<void> {
  // ── Validate environment ─────────────────────────────────────────────────
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[index] TELEGRAM_BOT_TOKEN is not set. Exiting.');
    process.exit(1);
  }

  // ── Initialize database ──────────────────────────────────────────────────
  console.log('[index] Initializing SQLite database...');
  initDb();
  console.log('[index] Database ready.');

  // ── Create Telegraf bot ──────────────────────────────────────────────────
  const bot = new Telegraf(token);

  // ── Register command handlers ────────────────────────────────────────────
  registerCommands(bot);

  // ── Start polling monitor ─────────────────────────────────────────────────
  const monitorHandle = startMonitor(bot);

  // ── Launch bot ────────────────────────────────────────────────────────────
  await bot.launch({
    allowedUpdates: ['message', 'callback_query'],
  });

  console.log('[index] ✅ Bot launched. Listening for Telegram updates...');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    console.log(`\n[index] ${signal} received. Shutting down...`);
    clearInterval(monitorHandle);
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[index] Fatal error:', err);
  process.exit(1);
});
