<?php
/**
 * P-Code PDO database connection (OAuth callback + secure queries).
 */
declare(strict_types=1);

require_once __DIR__ . '/env_loader.php';

if (!defined('DB_HOST')) {
    define('DB_HOST', pcode_env('PCODE_DB_HOST', 'localhost') ?: 'localhost');
}
if (!defined('DB_USER')) {
    define('DB_USER', pcode_env('PCODE_DB_USER', 'root') ?: 'root');
}
if (!defined('DB_PASS')) {
    define('DB_PASS', pcode_env('PCODE_DB_PASS', '') ?? '');
}
if (!defined('DB_NAME')) {
    define('DB_NAME', pcode_env('PCODE_DB_NAME', 'pcode') ?: 'pcode');
}
if (!defined('GOOGLE_CLIENT_ID')) {
    $envGoogleId = pcode_env('PCODE_GOOGLE_CLIENT_ID');
    define(
        'GOOGLE_CLIENT_ID',
        $envGoogleId !== null && $envGoogleId !== ''
            ? $envGoogleId
            : '953442697406-1nisk0lf775augnlkbbftpk19g4fkgl3.apps.googleusercontent.com'
    );
}
if (!defined('GOOGLE_MAPS_API_KEY')) {
    $envMapsKey = pcode_env('PCODE_GOOGLE_MAPS_API_KEY');
    define(
        'GOOGLE_MAPS_API_KEY',
        $envMapsKey !== null && $envMapsKey !== ''
            ? $envMapsKey
            : 'AIzaSyCIl3LDXufPtpKn7sxZMTN6DywQJokMpA0'
    );
}
if (!defined('JWT_SECRET')) {
    // Prefer shared resolver from api/config.php when already loaded.
    if (function_exists('pcode_resolve_jwt_secret')) {
        define('JWT_SECRET', pcode_resolve_jwt_secret());
    } else {
        $env = pcode_env('PCODE_JWT_SECRET');
        $secretFile = __DIR__ . DIRECTORY_SEPARATOR . 'jwt_secret.key';
        if (is_string($env) && strlen(trim($env)) >= 32) {
            define('JWT_SECRET', trim($env));
        } elseif (is_readable($secretFile)) {
            $fromFile = trim((string) file_get_contents($secretFile));
            if (strlen($fromFile) >= 32) {
                define('JWT_SECRET', $fromFile);
            } else {
                $generated = bin2hex(random_bytes(32));
                @file_put_contents($secretFile, $generated);
                define('JWT_SECRET', $generated);
            }
        } else {
            $generated = bin2hex(random_bytes(32));
            @file_put_contents($secretFile, $generated);
            define('JWT_SECRET', $generated);
        }
    }
}
if (!defined('JWT_EXPIRY')) {
    define('JWT_EXPIRY', 2592000);
}
if (!defined('PCODE_BASE_URL')) {
    define('PCODE_BASE_URL', pcode_detect_public_base_url());
}

/**
 * @return PDO
 */
function pcode_pdo(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4';
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    return $pdo;
}

function pcode_oauth_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    session_set_cookie_params([
        'lifetime' => JWT_EXPIRY,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function pcode_oauth_build_jwt(array $payload): string
{
    $header = base64_encode(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $body = base64_encode(json_encode(array_merge($payload, [
        'iat' => time(),
        'exp' => time() + JWT_EXPIRY,
    ])));
    $signature = base64_encode(hash_hmac('sha256', "$header.$body", JWT_SECRET, true));
    return "$header.$body.$signature";
}

function pcode_oauth_redirect(string $url): void
{
    header('Location: ' . $url);
    exit;
}

function pcode_oauth_login_url(string $portal): string
{
    return $portal === 'provider'
        ? PCODE_BASE_URL . 'provider-login.html'
        : PCODE_BASE_URL . 'login.html';
}

function pcode_oauth_dashboard_url(string $portal): string
{
    return $portal === 'provider'
        ? PCODE_BASE_URL . 'obgyn/dashboard.html'
        : PCODE_BASE_URL . 'user/dashboard.html';
}
