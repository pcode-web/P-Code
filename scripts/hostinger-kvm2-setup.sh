#!/usr/bin/env bash
# P-Code — Hostinger KVM 2 (Ubuntu) bootstrap
# Run as root on a fresh KVM2 VPS:  bash scripts/hostinger-kvm2-setup.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "==> Updating apt"
apt-get update -y
apt-get upgrade -y

echo "==> Installing LAMP + tools"
apt-get install -y \
  apache2 \
  mariadb-server \
  php php-cli php-mysql php-curl php-mbstring php-xml php-zip php-gd php-intl \
  libapache2-mod-php \
  unzip curl git openssl ufw

echo "==> Enabling Apache modules"
a2enmod rewrite headers ssl expires
systemctl restart apache2

echo "==> Firewall (SSH + HTTP/HTTPS)"
ufw allow OpenSSH
ufw allow 'Apache Full'
ufw --force enable || true

echo "==> Optional: Node 20 (for CSS rebuilds on server)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Optional: Python 3 + venv (ML inference)"
apt-get install -y python3 python3-venv python3-pip

APP_DIR="${PCODE_APP_DIR:-/var/www/pcode}"
echo "==> App directory hint: ${APP_DIR}"
echo "    Upload/clone the project there, then:"
echo "    1) cp ${APP_DIR}/config/.env.example ${APP_DIR}/config/.env && nano ${APP_DIR}/config/.env"
echo "    2) Create MySQL DB/user matching .env"
echo "    3) Point Apache DocumentRoot to ${APP_DIR} (or a subdomain vhost)"
echo "    4) chown -R www-data:www-data ${APP_DIR} && chmod 750 ${APP_DIR}/config"
echo "    5) Install certbot: apt-get install -y certbot python3-certbot-apache && certbot --apache"
echo "    6) npm ci && npm run build:prod  (or build locally and upload css/tailwind.css)"
echo "Done."
