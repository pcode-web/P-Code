<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth_portal_enforcement.php';

function json_error_and_exit($statusCode, $message) {
    http_response_code($statusCode);
    echo json_encode(['success' => false, 'message' => $message]);
    exit();
}

function pcode_session_start() {
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    session_set_cookie_params([
        'lifetime' => defined('JWT_EXPIRY') ? (int) JWT_EXPIRY : 3600,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function pcode_clear_user_session() {
    pcode_session_start();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
}

/**
 * Persist provider / user identity in PHP session (companion to JWT for cookie-based API auth).
 */
function pcode_establish_user_session(array $user) {
    pcode_session_start();
    $uid = (int)($user['user_id'] ?? $user['id'] ?? 0);
    if ($uid <= 0) {
        return;
    }
    $role = (string)($user['role'] ?? '');
    $_SESSION['user_id'] = $uid;
    $_SESSION['user_email'] = (string)($user['email'] ?? '');
    $_SESSION['user_name'] = (string)($user['user_name'] ?? $user['name'] ?? '');
    $_SESSION['user_role'] = $role;
    $_SESSION['auth_expires'] = time() + (defined('JWT_EXPIRY') ? (int) JWT_EXPIRY : 3600);

    $isProvider = !pcode_role_is_regular_user($role)
        && strtolower(trim($role)) !== 'administrator'
        && strtolower(trim($role)) !== 'admin'
        && pcode_normalize_db_role($role) !== 'guest';

    if ($isProvider) {
        $_SESSION['provider_id'] = $uid;
        $_SESSION['auth_source'] = 'clinical_providers';
    } else {
        unset($_SESSION['provider_id']);
        $_SESSION['auth_source'] = 'users';
    }
}

function pcode_session_auth_payload() {
    pcode_session_start();
    if (empty($_SESSION['user_id']) && empty($_SESSION['provider_id'])) {
        return null;
    }
    $id = !empty($_SESSION['provider_id'])
        ? (int)$_SESSION['provider_id']
        : (int)($_SESSION['user_id'] ?? 0);
    if ($id <= 0) {
        return null;
    }
    return [
        'id' => $id,
        'email' => (string)($_SESSION['user_email'] ?? ''),
        'name' => (string)($_SESSION['user_name'] ?? ''),
        'role' => (string)($_SESSION['user_role'] ?? ''),
    ];
}

function getBearerTokenFromHeaders() {
    return getAuthToken();
}

function requireAuthDecoded() {
    $token = getBearerTokenFromHeaders();
    if ($token) {
        $decoded = verifyJWT($token, 0);
        if ($decoded) {
            return $decoded;
        }
        // Bearer present but expired/invalid — fall back to PHP session (sync_session.php).
        $sessionUser = pcode_session_auth_payload();
        if ($sessionUser) {
            return $sessionUser;
        }
        json_error_and_exit(401, 'Invalid or expired token');
    }

    $sessionUser = pcode_session_auth_payload();
    if ($sessionUser) {
        return $sessionUser;
    }

    json_error_and_exit(401, 'Unauthorized: missing Authorization token or valid provider session');
}

function normalizedRole($decoded) {
    return strtolower(trim((string)($decoded['role'] ?? '')));
}

function isAdminRole($decoded) {
    $r = normalizedRole($decoded);
    return $r === 'administrator' || $r === 'admin' || $r === 'system administrator';
}

function isRegularUserRole($decoded) {
    return pcode_role_is_regular_user((string)($decoded['role'] ?? ''));
}

function isProviderRole($decoded) {
    if (isAdminRole($decoded)) {
        return false;
    }
    $r = (string)($decoded['role'] ?? '');
    if (!trim($r) || pcode_role_is_regular_user($r)) {
        return false;
    }
    if (pcode_normalize_db_role($r) === 'guest') {
        return false;
    }
    return true;
}

function requireProvider() {
    if (isGuestUser()) {
        json_error_and_exit(403, 'Guest users are not allowed');
    }
    $decoded = requireAuthDecoded();
    if (!isProviderRole($decoded)) {
        json_error_and_exit(403, 'Provider access required');
    }
    return $decoded;
}

function requireAdmin() {
    if (isGuestUser()) {
        json_error_and_exit(403, 'Guest users are not allowed');
    }
    $decoded = requireAuthDecoded();
    if (!isAdminRole($decoded)) {
        json_error_and_exit(403, 'Administrator access required');
    }
    return $decoded;
}

function requireRegularUser() {
    if (isGuestUser()) {
        json_error_and_exit(403, 'Guest users are not allowed');
    }
    $decoded = requireAuthDecoded();
    if (!isRegularUserRole($decoded)) {
        json_error_and_exit(403, 'Regular user access required');
    }
    return $decoded;
}

function requireUserId($decoded) {
    $id = $decoded['id'] ?? null;
    if (!$id) {
        json_error_and_exit(401, 'Invalid token payload (missing user id)');
    }
    return (int)$id;
}

