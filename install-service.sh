#!/usr/bin/env bash
# Install donutpay sebagai systemd service (auto-start saat boot).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "jalankan sebagai root: sudo bash install-service.sh"; exit 1; }

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-root}"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node tidak ditemukan di PATH"; exit 1; }

cat >/etc/systemd/system/donutpay.service <<EOF
[Unit]
Description=DonutPay shop (QRIS + mineflayer)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/src/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now donutpay
echo "Service aktif. Cek: systemctl status donutpay — logs: journalctl -u donutpay -f"
