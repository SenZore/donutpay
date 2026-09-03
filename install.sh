#!/usr/bin/env bash
# donutpay AIO installer. Interactive: tanya semua yang dibutuhkan, verifikasi,
# lalu install. Support Ubuntu/Debian, Fedora/RHEL, Arch, Alpine.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# ---------- helpers ----------
say()  { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m   ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m   ! %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m   ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { # ask VAR "prompt" [default] — passing a 3rd arg (even "") means blank is allowed
  local var="$1" prompt="$2" val
  if [ $# -ge 3 ]; then
    local def="$3"
    if [ -n "$def" ]; then read -rp "   $prompt [$def]: " val || true
    else read -rp "   $prompt (boleh kosong): " val || true; fi
    val="${val:-$def}"
  else
    while [ -z "${val:-}" ]; do
      read -rp "   $prompt: " val || die "input habis (EOF) — jawaban belum lengkap"
    done
  fi
  printf -v "$var" '%s' "$val"
}
ask_secret() { # ask_secret VAR "prompt"
  local var="$1" prompt="$2" val
  while [ -z "${val:-}" ]; do
    read -rsp "   $prompt: " val || die "input habis (EOF) — jawaban belum lengkap"
    echo
  done
  printf -v "$var" '%s' "$val"
}
ask_yn() { # ask_yn "prompt" default(y/n) -> returns 0/1
  local prompt="$1" def="${2:-y}" val
  read -rp "   $prompt [$def]: " val || true
  val="${val:-$def}"
  [[ "$val" =~ ^[Yy] ]]
}
is_root() { [ "$(id -u)" = 0 ]; }
SUDO=""
is_root || SUDO="sudo"

# ---------- OS / dependency detection ----------
say "Deteksi OS & dependencies"
PKG=""; PRETTY="unknown"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  PRETTY="$PRETTY_NAME"
  case "${ID:-} ${ID_LIKE:-}" in
    *debian*|*ubuntu*) PKG=apt ;;
    *fedora*|*rhel*|*centos*) PKG=dnf ;;
    *arch*|*manjaro*) PKG=pacman ;;
    *alpine*) PKG=apk ;;
  esac
fi
ok "OS: $PRETTY (pkg manager: ${PKG:-tidak dikenal})"

MISSING=()
command -v node  >/dev/null || MISSING+=("nodejs>=20")
command -v npm   >/dev/null || MISSING+=("npm")
command -v git   >/dev/null || MISSING+=("git")
command -v curl  >/dev/null || MISSING+=("curl")
command -v gcc   >/dev/null || MISSING+=("build tools (gcc/make)")
command -v python3 >/dev/null || MISSING+=("python3")
command -v ssh-keygen >/dev/null || MISSING+=("openssh-client")

if [ ${#MISSING[@]} -gt 0 ]; then
  warn "Kurang: ${MISSING[*]}"
  case "$PKG" in
    apt)    $SUDO apt-get update -y && $SUDO apt-get install -y curl ca-certificates git build-essential python3 openssh-client
            command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -; $SUDO apt-get install -y nodejs; } ;;
    dnf)    $SUDO dnf install -y curl ca-certificates git gcc gcc-c++ make python3 openssh-clients
            command -v node >/dev/null || { curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -; $SUDO dnf install -y nodejs; } ;;
    pacman) $SUDO pacman -Sy --noconfirm curl ca-certificates git base-devel python nodejs npm openssh ;;
    apk)    $SUDO apk add --no-cache curl ca-certificates git build-base python3 nodejs npm openssh-client ;;
    *)      die "Install manual dulu: ${MISSING[*]}" ;;
  esac
fi
command -v node >/dev/null || die "Node.js tidak terinstall dan auto-install gagal. Install manual Node 20+ dulu."
[ "$(node -v | cut -d. -f1 | tr -d v)" -ge 20 ] || die "Node.js >= 20 dibutuhkan, punyamu $(node -v)"
ok "Node $(node -v), npm $(npm -v), semua dependencies terpenuhi"

# ---------- interactive config ----------
say "Konfigurasi toko"
ask DOMAIN "Domain untuk shop (kosongkan = pakai IP:port saja)" ""
if [ -n "$DOMAIN" ]; then
  say "Cek DNS $DOMAIN"
  RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
  MYIP=$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || echo "")
  if [ -z "$RESOLVED" ]; then
    warn "$DOMAIN belum resolve ke IP manapun."
    ask_yn "Lanjut tanpa DNS? (shop tetap jalan di IP:port)" y || DOMAIN=""
  elif [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then
    warn "$DOMAIN resolve ke $RESOLVED, tapi IP server ini $MYIP."
    ask_yn "IP beda — pakai reverse proxy/Cloudflare Tunnel nanti? Lanjut?" y || DOMAIN=""
  else
    ok "DNS $DOMAIN → $RESOLVED cocok dengan IP server"
  fi
fi

say "Payment gateway"
echo "   1) pakasir  (pakasir.com — QRIS, API sederhana)"
echo "   2) midtrans (Core API QRIS)"
GW=""
until [ "$GW" = "1" ] || [ "$GW" = "2" ]; do
  ask GW "Pilih [1/2]" "1"
  [ "$GW" = "1" ] || [ "$GW" = "2" ] || warn "pilih 1 atau 2"
done
if [ "$GW" = "2" ]; then
  PROVIDER=midtrans
  ask MIDTRANS_SERVER_KEY "Midtrans Server Key (SB-... untuk sandbox)"
  ask PAYMENT_MODE "Mode (sandbox/live)" "sandbox"
  PAKASIR_SLUG=""; PAKASIR_API_KEY=""
else
  PROVIDER=pakasir
  ask PAKASIR_SLUG "Pakasir project slug (dari app.pakasir.com)"
  ask_secret PAKASIR_API_KEY "Pakasir API key"
  ask PAYMENT_MODE "Mode (sandbox/live)" "sandbox"
  MIDTRANS_SERVER_KEY=""
fi
[ "$PAYMENT_MODE" = "sandbox" ] || [ "$PAYMENT_MODE" = "live" ] || die "PAYMENT_MODE harus 'sandbox' atau 'live'"

say "Bot Minecraft"
ask MC_HOST "Server Minecraft" "donutsmp.net"
ask MC_USERNAME "Username bot (display name, dari akun Microsoft)"
ask MC_VERSION "Versi MC" "1.21.1"
ask DONUT_API_KEY "DonutSMP API key (dari /api in-game, kosongkan kalau tidak pakai stock display)" ""

say "Admin panel"
ask ADMIN_USER "Username admin" "admin"
ask_secret ADMIN_PASSWORD "Password admin"

RATE=""
until [[ "$RATE" =~ ^[0-9]+$ ]] && [ "$RATE" -gt 0 ]; do
  ask RATE "Harga per 1 juta donut (Rp)" "2000"
  [[ "$RATE" =~ ^[0-9]+$ ]] && [ "$RATE" -gt 0 ] || warn "harus angka > 0"
done
PORT=""
until [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; do
  ask PORT "Port app" "3000"
  [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || warn "harus 1-65535"
done
TRUST_CF_HEADER=""
if ask_yn "Shop di belakang Cloudflare (tunnel/proxy)? Header cf-connecting-ip bakal dipercaya buat rate-limit." n; then
  TRUST_CF_HEADER=1
else
  TRUST_CF_HEADER=0
fi

# ---------- write .env ----------
say "Tulis .env"
if [ -f .env ] && ! ask_yn ".env sudah ada, timpa?" n; then
  warn ".env lama dipertahankan"
else
cat > .env <<EOF
PAYMENT_PROVIDER=$PROVIDER
PAYMENT_MODE=$PAYMENT_MODE
PAKASIR_SLUG=$PAKASIR_SLUG
PAKASIR_API_KEY=$PAKASIR_API_KEY
MIDTRANS_SERVER_KEY=$MIDTRANS_SERVER_KEY
MC_HOST=$MC_HOST
MC_PORT=25565
MC_USERNAME=$MC_USERNAME
MC_VERSION=$MC_VERSION
MC_AUTH_CACHE=./auth_cache
DONUT_API_KEY=$DONUT_API_KEY
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASSWORD
RATE=$RATE
PORT=$PORT
TRUST_CF_HEADER=$TRUST_CF_HEADER
EOF
chmod 600 .env
ok ".env tersimpan (chmod 600)"
fi

# ---------- npm ----------
say "npm install"
npm install --omit=dev --no-audit --no-fund
# npm 11+ bisa blok install scripts (better-sqlite3 butuh native build). Verifikasi & rebuild kalau perlu.
if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  warn "better-sqlite3 native binding belum ke-build, coba rebuild..."
  npm rebuild better-sqlite3 || npm approve-scripts better-sqlite3 2>/dev/null && npm rebuild better-sqlite3 || true
  node -e "require('better-sqlite3')" || die "better-sqlite3 gagal di-build. Install build tools (gcc, make, python3) lalu ulangi: npm rebuild better-sqlite3"
fi
node -e "require('./src/db')" || die "gagal load db module"
ok "dependencies terinstall & terverifikasi (better-sqlite3 OK)"

# ---------- ssh key ----------
if ask_yn "Generate SSH key (buat deploy/git)?" n; then
  if [ ! -f ~/.ssh/id_ed25519 ]; then
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "donutpay@$(hostname)"
    ok "SSH key dibuat: ~/.ssh/id_ed25519.pub"
    echo "   Public key (add ke GitHub/GitLab):"
    cat ~/.ssh/id_ed25519.pub
  else
    ok "SSH key sudah ada, skip"
  fi
fi

# ---------- microsoft login ----------
if ask_yn "Login Microsoft buat bot sekarang? (device code, butuh browser)" y; then
  node src/login.js || warn "Login gagal/batal — ulangi nanti dengan: npm run login"
else
  warn "Bot belum login. Jalankan 'npm run login' sebelum start kalau mau delivery otomatis."
fi

# ---------- done ----------
say "Selesai 🎉"
echo "   Start:    npm start"
[ -n "$DOMAIN" ] && echo "   URL:      https://$DOMAIN (arahkan reverse proxy/tunnel ke localhost:$PORT)" \
                 || echo "   URL:      http://$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<ip-server>'):$PORT"
echo "   Admin:    /admin.html (user: $ADMIN_USER)"
echo "   Service:  sudo bash install-service.sh (systemd auto-start)"
