# 🍩 donutpay

Jual in-game currency server Minecraft bayar QRIS. Pembeli scan & bayar, bot mineflayer otomatis `/pay` ke akun mereka. Satu proses Node.js, SQLite, frontend tanpa build step, admin panel bawaan.

Support **Pakasir** atau **Midtrans** (pilih saat install), stock display via DonutSMP API, order manual gratis dari admin panel.

## Cara kerja

```
pembeli → username + jumlah → POST /api/order
       → gateway bikin QRIS → QR muncul
       → bayar → webhook + poller verify ke gateway
       → status paid → bot mineflayer /pay {user} {amt}m
       → delivered (retry 5x, re-queue saat restart)
```

Status selalu di-verify langsung ke gateway — webhook cuma hint, bukan kebenaran.

## Install (interactive)

```bash
git clone https://github.com/Senzore/donutpay && cd donutpay
bash install.sh
```

Script nanya semuanya: OS/dependency check (Ubuntu, Debian, Fedora, Arch, Alpine), domain + DNS verify, payment gateway (pakasir/midtrans) + credentials, bot Minecraft, DonutSMP API key, admin user/pass, SSH key (opsional), login Microsoft (device code) langsung dari installer.

## Menjalankan

```bash
npm start                    # foreground
sudo bash install-service.sh # systemd auto-start
```

- Landing: `http://ip:3000`
- Admin panel: `http://ip:3000/admin.html`

## Admin panel

Login (user/pass dari install). Fitur:
- Overview: pending/paid/delivered counts, bot status, **stok balance bot** (DonutSMP API)
- **Order Manual**: kirim donut ke siapapun tanpa pembayaran (buat giveaway/support)
- Requeue order gagal, export CSV orders+logs, live logs feed
- Settings: ganti rate tanpa restart, toggle stock display di landing

## Payment gateway

### Pakasir (default)
1. [app.pakasir.com](https://app.pakasir.com) → bikin project → catat slug & API key
2. Webhook URL: `https://domainmu/webhook/pakasir`
3. Sandbox punya simulate API: `POST /api/dev/simulate?token=ADMIN_PASSWORD {"id":"DP..."}`

### Midtrans
1. Dashboard Midtrans → Settings → Access Keys → Server Key
2. Aktifkan QRIS channel di dashboard (error 402 = belum diaktifkan)
3. Notification URL: `https://domainmu/webhook/midtrans`

## DonutSMP API (stock display)

In-game ketik `/api` → dapat API key → masukkan saat install. Bot balance (`/v1/stats/{MC_USERNAME}` → `money`) tampil di admin panel dan landing page (bisa dimatikan di Settings).

## Bot Minecraft

- `npm run login` — device code flow sekali jalan, token tersimpan di `auth_cache/`
- Auto-reconnect dengan backoff kalau di-kick/disconnect
- Auto-respawn kalau mati dibunuh
- Kalau server minta konfirmasi IP baru (Discord DM), klik dulu lalu `npm run login` ulang

## API publik

| Endpoint | Fungsi |
|---|---|
| `POST /api/order` | `{user, amt}` → bikin order + QRIS |
| `GET /api/order/:id/status` | status (re-verify ke gateway kalau pending) |
| `GET /api/order/:id/qr.png` | gambar QR |
| `POST /api/order/:id/cancel` | batal (pending only) |
| `POST /webhook/:provider` | webhook receiver |
| `GET /api/config` | rate, provider, stock (public) |
| `GET /api/stats` | bot_online, queue, uptime |

Admin endpoints (`/admin/*`) pakai session token dari `/admin/login`.

## Struktur

```
src/server.js        Express + order flow + webhook
src/payment.js       provider loader (PAYMENT_PROVIDER env)
src/payments/        pakasir.js, midtrans.js
src/donutapi.js      DonutSMP API (balance bot)
src/admin.js         admin routes (session, manual order, settings)
src/bot.js           mineflayer: queue, /pay, auto-reconnect/respawn
src/worker.js        poller status + re-queue saat boot
src/db.js            SQLite: orders, logs, cfg
src/login.js         Microsoft device-code login
public/              index.html (landing) + admin.html (panel), zero build
install.sh           interactive AIO installer
install-service.sh   systemd unit
```

## License

MIT
