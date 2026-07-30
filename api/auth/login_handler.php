<?php
/**
 * Credential (email + password) login for Patient and Provider portals.
 * Google OAuth continues to use google_callback.php.
 */
declare(strict_types=1);

require_once __DIR__ . '/session_helpers.php';
require_once dirname(__DIR__) . '/password_helpers.php';

pcode_oauth_session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit('Method not allowed');
}

$portal = strtolower(trim((string) ($_POST['portal'] ?? '')));
if (!in_array($portal, ['patient', 'provider'], true)) {
    pcode_oauth_redirect(pcode_auth_login_error_url('patient'));
}

$email = pcode_auth_sanitize_email((string) ($_POST['email'] ?? ''));
$password = (string) ($_POST['password'] ?? '');

if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    pcode_oauth_redirect(pcode_auth_login_error_url($portal));
}

if ($password === '') {
    pcode_auth_timing_safe_password_check();
    pcode_oauth_redirect(pcode_auth_login_error_url($portal));
}

try {
    $pdo = pcode_pdo();

    if ($portal === 'provider') {
        $stmt = $pdo->prepare(
            'SELECT * FROM clinical_providers WHERE email = :email LIMIT 1'
        );
        $stmt->execute(['email' => $email]);
        $provider = $stmt->fetch();

        $storedHash = is_array($provider) ? (string) ($provider['password'] ?? '') : '';
        $isActive = is_array($provider) && (int) ($provider['is_active'] ?? 0) === 1;
        $providerId = is_array($provider) ? (int) ($provider['id'] ?? 0) : 0;

        if (
            !is_array($provider)
            || !$isActive
            || $storedHash === ''
            || $providerId <= 0
            || !pcode_verify_and_upgrade_password($pdo, 'clinical_providers', 'id', $providerId, $password, $storedHash)
        ) {
            pcode_auth_timing_safe_password_check();
            pcode_oauth_redirect(pcode_auth_login_error_url('provider'));
        }

        $providerAuth = [
            'user_id' => (int) $provider['id'],
            'email' => (string) $provider['email'],
            'user_name' => (string) ($provider['user_name'] ?? ''),
            'role' => (string) ($provider['role'] ?? 'Ob-Gyn'),
            'institution' => (string) ($provider['institution'] ?? ''),
            'avatar' => (string) ($provider['avatar'] ?? ''),
        ];

        pcode_auth_establish_redirect_session($providerAuth, $email, $providerAuth['avatar'], true);
        pcode_oauth_redirect(pcode_oauth_dashboard_url('provider'));
    }

    // Patient portal — users table
    $stmt = $pdo->prepare(
        'SELECT user_id, user_name, email, password, role, institution, avatar
         FROM users WHERE email = :email LIMIT 1'
    );
    $stmt->execute(['email' => $email]);
    $user = $stmt->fetch();

    $storedHash = is_array($user) ? (string) ($user['password'] ?? '') : '';
    $userId = is_array($user) ? (int) ($user['user_id'] ?? 0) : 0;
    if (
        !is_array($user)
        || $storedHash === ''
        || $userId <= 0
        || !pcode_verify_and_upgrade_password($pdo, 'users', 'user_id', $userId, $password, $storedHash)
    ) {
        pcode_auth_timing_safe_password_check();
        pcode_oauth_redirect(pcode_auth_login_error_url('patient'));
    }

    $role = (string) ($user['role'] ?? '');
    $roleLower = strtolower($role);
    if ($roleLower === 'administrator' || $roleLower === 'admin') {
        pcode_oauth_redirect(pcode_auth_login_error_url('patient'));
    }

    $patientAuth = [
        'user_id' => (int) $user['user_id'],
        'email' => (string) $user['email'],
        'user_name' => (string) ($user['user_name'] ?? ''),
        'role' => $role !== '' ? $role : 'Regular User',
        'institution' => (string) ($user['institution'] ?? ''),
        'avatar' => (string) ($user['avatar'] ?? ''),
    ];

    $updateLogin = $pdo->prepare('UPDATE users SET last_login = NOW() WHERE user_id = :user_id');
    $updateLogin->execute(['user_id' => $patientAuth['user_id']]);

    pcode_auth_establish_redirect_session($patientAuth, $email, $patientAuth['avatar'], false);
    pcode_oauth_redirect(pcode_oauth_dashboard_url('patient'));
} catch (Throwable $e) {
    pcode_oauth_redirect(pcode_auth_login_error_url($portal));
}
