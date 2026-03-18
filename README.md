# 🤖 Meteora DLMM LP Monitor

Telegram bot untuk memonitor posisi Meteora DLMM Liquidity Provider secara otomatis. Bot akan mengirim alert ketika posisi keluar dari range, mendekati edge, kembali ke range, atau saat posisi baru terdeteksi.

## Fitur

- 🔴 **Out of Range** alert — kirim sekali saat transisi in → out
- ⚠️ **Approaching** alert — kirim sekali saat bin aktif mendekati edge (configurable threshold)
- ✅ **Back in Range** alert — kirim saat posisi kembali ke dalam range
- 🆕 **New Position** alert — kirim saat posisi baru terdeteksi
- 📊 `/status` — snapshot semua posisi real-time
- 💰 `/fees` — lihat unclaimed fees semua posisi
- 👛 Multi-wallet tracking

---

## Setup

### 1. Clone & Install

```bash
git clone <repo>
cd meteora-lp-monitor
npm install
```

### 2. Konfigurasi `.env`

```bash
cp .env.example .env
```

Isi file `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here   # dari @BotFather
TELEGRAM_CHAT_ID=                        # bisa kosong, set via /start
POLL_INTERVAL_MS=60000                   # interval polling (ms)
PROXIMITY_THRESHOLD=5                    # jarak warning threshold (bins)
```

**Cara dapatkan bot token:**
1. Chat ke [@BotFather](https://t.me/BotFather) di Telegram
2. Ketik `/newbot` dan ikuti instruksi
3. Copy token yang diberikan ke `TELEGRAM_BOT_TOKEN`

### 3. Jalankan (Development)

```bash
npm run dev
```

Lalu buka Telegram → chat ke bot kamu → kirim `/start`

---

## Commands

| Command | Keterangan |
|---------|-----------|
| `/start` | Set chat ID untuk alert, tampilkan welcome |
| `/addwallet <address>` | Tambah wallet Solana untuk ditrack |
| `/removewallet <address>` | Stop tracking wallet |
| `/wallets` | List semua wallet yang ditrack |
| `/status` | Snapshot real-time semua posisi |
| `/fees` | Lihat unclaimed fees semua posisi |
| `/setthreshold <N>` | Ubah proximity warning threshold (default: 5) |
| `/help` | Tampilkan daftar command |

---

## Flow Monitoring

```
Setiap 60 detik:
  → Fetch portfolio tiap wallet dari Meteora API
  → Hitung isInRange & jarak ke edge
  → Bandingkan dengan state di DB
  → Kirim alert jika ada transisi (OOR / approaching / back in range / new)
  → Update DB
```

**Anti-spam logic:**
- OOR alert → hanya sekali per "episode" keluar range
- Approaching alert → hanya sekali per episode, reset saat masuk/keluar range
- Semua flag persist di SQLite → aman kalau bot restart

---

## Deploy Production (PM2)

```bash
# Build TypeScript
npm run build

# Buat folder logs
mkdir -p logs

# Start dengan PM2
npm install -g pm2
pm2 start ecosystem.config.js

# Lihat logs
pm2 logs meteora-lp-monitor

# Monitor live
pm2 monit

# Auto-start saat reboot
pm2 startup
pm2 save
```

---

## Deploy ke Railway

1. Push ke GitHub
2. Buat project baru di [Railway](https://railway.app)
3. Connect repo
4. Tambah environment variables (isi dari `.env`)
5. Set start command: `npm run build && npm start`

---

## Project Structure

```
src/
  index.ts      → Entry point
  bot.ts        → Telegraf command handlers
  monitor.ts    → Polling engine & alert dispatch
  meteora.ts    → Meteora REST API client
  db.ts         → SQLite database layer
  alerts.ts     → Alert formatters & sender
  types.ts      → TypeScript interfaces
ecosystem.config.js  → PM2 config
.env.example         → Environment variables template
data.db              → SQLite database (auto-created)
```

---

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Bot**: [Telegraf](https://telegraf.js.org/)
- **Database**: SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- **API**: [Meteora DLMM REST API](https://dlmm.datapi.meteora.ag)
- **HTTP**: Axios
