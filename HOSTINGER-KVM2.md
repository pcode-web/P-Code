# Hostinger KVM 2 — P-Code deploy guide

KVM 2 gives you a full Ubuntu VPS (root). P-Code runs as a classic LAMP app (Apache + PHP + MySQL) with optional Python for ML.

## 1. Server packages

SSH into the VPS, then either:

```bash
# From the project (after upload)
sudo bash scripts/hostinger-kvm2-setup.sh
```

Or install manually: Apache, MariaDB/MySQL, PHP 8.1+ (`php-mysql`, `php-curl`, `php-mbstring`, `php-xml`, `php-zip`, `php-gd`), `mod_rewrite`, `mod_headers`, `mod_ssl`.

## 2. Upload the app

Recommended layout:

```text
/var/www/pcode/          ← DocumentRoot
  index.html
  api/
  config/
  css/
  js/
  ...
```

Do **not** deploy these to a public path (blocked by `.htaccess` anyway):

- `node_modules/`, `.venv/`, `config/.env`, `config/jwt_secret.key`, `logs/`

Upload built `css/tailwind.css` (or run `npm run build:prod` on the VPS).

## 3. Environment file

```bash
cd /var/www/pcode
cp config/.env.example config/.env
nano config/.env
```

Set at minimum:

| Variable | Example |
|----------|---------|
| `PCODE_BASE_URL` | `https://yourdomain.com/` |
| `FRONTEND_URL` | same |
| `API_BASE_URL` | `https://yourdomain.com/api/` |
| `PCODE_CORS_ORIGINS` | `https://yourdomain.com,https://www.yourdomain.com` |
| `PCODE_DB_*` | Hostinger MySQL user/db |
| `PCODE_JWT_SECRET` | `openssl rand -hex 32` |
| `PCODE_DEBUG` | `false` |

```bash
chmod 640 config/.env
chown -R www-data:www-data /var/www/pcode
chmod 750 config
```

## 4. Database

```bash
sudo mysql -e "CREATE DATABASE pcode CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mysql -e "CREATE USER 'pcode_user'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD';"
sudo mysql -e "GRANT ALL ON pcode.* TO 'pcode_user'@'localhost'; FLUSH PRIVILEGES;"
```

Import your schema dump (phpMyAdmin or `mysql pcode < backup.sql`).

## 5. Apache vhost

```apache
<VirtualHost *:80>
  ServerName yourdomain.com
  ServerAlias www.yourdomain.com
  DocumentRoot /var/www/pcode

  <Directory /var/www/pcode>
    AllowOverride All
    Require all granted
  </Directory>

  ErrorLog ${APACHE_LOG_DIR}/pcode-error.log
  CustomLog ${APACHE_LOG_DIR}/pcode-access.log combined
</VirtualHost>
```

```bash
sudo a2ensite pcode.conf
sudo a2enmod rewrite headers ssl
sudo systemctl reload apache2
sudo apt-get install -y certbot python3-certbot-apache
sudo certbot --apache -d yourdomain.com -d www.yourdomain.com
```

## 6. Google / Firebase (production)

1. **Google Cloud OAuth** — add authorized JavaScript origins + redirect URIs for `https://yourdomain.com`
2. **Maps API key** — restrict by HTTP referrer to your domain
3. **Firebase Auth** — authorized domains: add `yourdomain.com`
4. Email link templates — confirm sender / continue URL uses HTTPS

## 7. CSS build (local or VPS)

On a machine with Node:

```bash
npm ci
npm run build:prod
```

Commit/upload `css/tailwind.css`. Hostinger does not need Node at runtime.

## 8. Python ML (optional)

If Detect uses local `xgboost_predict.py` / `cnn_predict.py`:

```bash
cd /var/www/pcode
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt   # create if missing from your model stack
```

Ensure Apache/PHP `exec`/proc can call `.venv/bin/python` (or disable public ML and keep inference private).

## 9. Post-deploy checklist

- [ ] `https://yourdomain.com/` loads Home
- [ ] `config/.env` not reachable in browser
- [ ] Login (Google + email link) works
- [ ] API calls use HTTPS (no mixed content)
- [ ] JWT secret is unique (not the XAMPP file)
- [ ] `PCODE_DEBUG=false`
- [ ] Database backups scheduled
- [ ] Firewall: 22, 80, 443 only

## 10. Local XAMPP still works

If `config/.env` is absent, defaults remain localhost/`root`/empty password. For local override, copy `.env.example` → `.env` with XAMPP values.
