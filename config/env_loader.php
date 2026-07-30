<?php
/**
 * Load config/.env into putenv/$_ENV (simple KEY=VALUE parser).
 * Safe to call multiple times. Does not override existing real env vars.
 */
declare(strict_types=1);

if (!function_exists('pcode_load_dotenv')) {
    function pcode_load_dotenv(?string $path = null): void
    {
        static $loaded = false;
        if ($loaded) {
            return;
        }
        $loaded = true;

        $file = $path ?: (dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . '.env');
        // Also allow project-root .env
        if (!is_readable($file)) {
            $alt = dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env';
            if (is_readable($alt)) {
                $file = $alt;
            } else {
                return;
            }
        }

        $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines === false) {
            return;
        }

        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            if (strpos($line, '=') === false) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            $value = trim($value);
            if ($key === '') {
                continue;
            }
            // Strip optional quotes
            if (
                strlen($value) >= 2 &&
                (($value[0] === '"' && substr($value, -1) === '"') ||
                    ($value[0] === "'" && substr($value, -1) === "'"))
            ) {
                $value = substr($value, 1, -1);
            }

            $existing = getenv($key);
            if ($existing !== false && $existing !== '') {
                continue;
            }
            putenv($key . '=' . $value);
            $_ENV[$key] = $value;
            $_SERVER[$key] = $value;
        }
    }
}

if (!function_exists('pcode_env')) {
    function pcode_env(string $key, ?string $default = null): ?string
    {
        $v = getenv($key);
        if ($v === false || $v === '') {
            return $default;
        }
        return $v;
    }
}

/**
 * Public site origin, e.g. https://example.com or https://example.com/pcode
 */
if (!function_exists('pcode_detect_public_base_url')) {
    function pcode_detect_public_base_url(): string
    {
        $fromEnv = pcode_env('PCODE_BASE_URL', pcode_env('FRONTEND_URL'));
        if (is_string($fromEnv) && $fromEnv !== '') {
            return rtrim($fromEnv, '/') . '/';
        }

        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || ((string) ($_SERVER['SERVER_PORT'] ?? '') === '443')
            || (strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https');
        $scheme = $https ? 'https' : 'http';
        $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
        // Prefer script path under /pcode when present
        $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
        $basePath = '';
        if (preg_match('#^(.*?)/(?:api|config)/#', $script, $m)) {
            $basePath = $m[1];
        } elseif (preg_match('#^(.*)/[^/]+\.php$#', $script, $m)) {
            $basePath = $m[1];
        }
        if ($basePath === '' || $basePath === '/') {
            return $scheme . '://' . $host . '/';
        }
        return $scheme . '://' . $host . rtrim($basePath, '/') . '/';
    }
}

pcode_load_dotenv();
