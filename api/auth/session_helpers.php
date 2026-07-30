<?php
/**
 * Shared PHP session + JWT helpers for OAuth and credential login redirects.
 */
declare(strict_types=1);

require_once __DIR__ . '/../../config/db_connection.php';

function pcode_auth_establish_redirect_session(
    array $user,
    string $email,
    string $avatar = '',
    bool $isClinicalProvider = false
): void {
    $userId = (int) ($user['user_id'] ?? 0);
    $userName = (string) ($user['user_name'] ?? '');
    $role = (string) ($user['role'] ?? '');
    $avatarUrl = $avatar !== '' ? $avatar : (string) ($user['avatar'] ?? '');

    $_SESSION['user_id'] = $userId;
    $_SESSION['user_name'] = $userName;
    $_SESSION['role'] = $role;
    $_SESSION['user_email'] = $email;
    $_SESSION['user_role'] = $role;
    $_SESSION['auth_expires'] = time() + JWT_EXPIRY;

    if ($isClinicalProvider) {
        $_SESSION['provider_id'] = $userId;
        $_SESSION['auth_source'] = 'clinical_providers';
    } else {
        unset($_SESSION['provider_id']);
        unset($_SESSION['auth_source']);
    }

    $jwt = pcode_oauth_build_jwt([
        'id' => $userId,
        'email' => $email,
        'name' => $userName,
        'role' => $role,
    ]);
    $_SESSION['pcos_auth_token'] = $jwt;
    $_SESSION['pcos_auth_user'] = [
        'id' => $userId,
        'email' => $email,
        'name' => $userName,
        'role' => $role,
        'institution' => (string) ($user['institution'] ?? ''),
        'picture' => $avatarUrl,
        'avatar' => $avatarUrl,
        'authSource' => $isClinicalProvider ? 'clinical_providers' : 'users',
    ];
}

function pcode_auth_sanitize_email(string $raw): string
{
    $trimmed = trim($raw);
    if ($trimmed === '') {
        return '';
    }
    $filtered = filter_var($trimmed, FILTER_SANITIZE_EMAIL);
    if (!is_string($filtered) || $filtered === '') {
        return '';
    }
    return strtolower($filtered);
}

function pcode_auth_login_error_url(string $portal, string $error = 'invalid_credentials'): string
{
    $page = $portal === 'provider' ? 'provider-login.html' : 'login.html';
    return PCODE_BASE_URL . $page . '?error=' . rawurlencode($error);
}

function pcode_auth_timing_safe_password_check(): void
{
    password_verify(
        'placeholder',
        '$2y$10$abcdefghijklmnopqrstuv0123456789012345678901234567890'
    );
}
