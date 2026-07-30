<?php
/**
 * Google OAuth 2.0 callback — redirect (GIS POST credential) + JSON API (embedded modals).
 * - Provider / OB-GYN portal → clinical_providers roster
 * - Patient / community portal → users table
 */
declare(strict_types=1);

require_once __DIR__ . '/session_helpers.php';
require_once dirname(__DIR__) . '/password_helpers.php';

// --- Shared PDO helpers (redirect + JSON paths) ------------------------------

function pcode_oauth_resolve_portal_context(): string
{
    $state = strtolower(trim((string) ($_POST['state'] ?? $_GET['state'] ?? '')));
    if (in_array($state, ['provider', 'obgyn', 'clinical'], true)) {
        return 'provider';
    }
    if (in_array($state, ['patient', 'community', 'user'], true)) {
        return 'patient';
    }

    $referer = strtolower((string) ($_SERVER['HTTP_REFERER'] ?? ''));
    if (
        strpos($referer, 'provider-login') !== false
        || strpos($referer, 'detect-provider') !== false
        || strpos($referer, 'provider-dashboard') !== false
    ) {
        return 'provider';
    }

    if (isset($_SESSION['pcode_oauth_portal'])) {
        $saved = strtolower((string) $_SESSION['pcode_oauth_portal']);
        if ($saved === 'provider') {
            return 'provider';
        }
    }

    return 'patient';
}

function pcode_oauth_verify_google_token(string $idToken): array
{
    $clientId = GOOGLE_CLIENT_ID;
    $url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($idToken);
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $response = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200 || !$response) {
        throw new RuntimeException('invalid_token');
    }

    $tokenData = json_decode($response, true);
    if (!is_array($tokenData) || empty($tokenData['email'])) {
        throw new RuntimeException('invalid_token');
    }
    if (($tokenData['aud'] ?? '') !== $clientId) {
        throw new RuntimeException('invalid_token');
    }
    if (isset($tokenData['email_verified']) && $tokenData['email_verified'] !== 'true' && $tokenData['email_verified'] !== true) {
        throw new RuntimeException('invalid_token');
    }

    return $tokenData;
}

function pcode_oauth_extract_picture_from_id_token(string $idToken): string
{
    $parts = explode('.', $idToken);
    if (count($parts) < 2) {
        return '';
    }
    $payloadSegment = strtr($parts[1], '-_', '+/');
    $padding = strlen($payloadSegment) % 4;
    if ($padding > 0) {
        $payloadSegment .= str_repeat('=', 4 - $padding);
    }
    $decoded = base64_decode($payloadSegment, true);
    if ($decoded === false) {
        return '';
    }
    $payload = json_decode($decoded, true);
    if (!is_array($payload)) {
        return '';
    }
    return trim((string) ($payload['picture'] ?? ''));
}

function pcode_oauth_resolve_google_picture(array $tokenData, string $idToken): string
{
    $picture = trim((string) ($tokenData['picture'] ?? ''));
    if ($picture !== '') {
        return $picture;
    }
    return pcode_oauth_extract_picture_from_id_token($idToken);
}

function pcode_oauth_fetch_clinical_provider_by_email(PDO $pdo, string $email): ?array
{
    $stmt = $pdo->prepare(
        'SELECT * FROM clinical_providers WHERE email = :email AND is_active = 1 LIMIT 1'
    );
    $stmt->execute(['email' => $email]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function pcode_oauth_insert_clinical_provider(
    PDO $pdo,
    string $email,
    string $name,
    string $role = 'Ob-Gyn',
    string $institution = '',
    string $avatar = ''
): array {
    require_once dirname(__DIR__) . '/password_helpers.php';
    $passwordHash = pcode_hash_password_for_storage(bin2hex(random_bytes(16)));
    $stmt = $pdo->prepare(
        'INSERT INTO clinical_providers (email, password, user_name, role, institution, avatar, is_active)
         VALUES (:email, :password, :user_name, :role, :institution, :avatar, 1)'
    );
    $stmt->execute([
        'email' => $email,
        'password' => $passwordHash,
        'user_name' => $name,
        'role' => $role !== '' ? $role : 'Ob-Gyn',
        'institution' => $institution,
        'avatar' => $avatar !== '' ? $avatar : null,
    ]);
    $id = (int) $pdo->lastInsertId();
    $row = pcode_oauth_fetch_clinical_provider_by_email($pdo, $email);
    if ($row === null) {
        return [
            'id' => $id,
            'email' => $email,
            'user_name' => $name,
            'role' => $role !== '' ? $role : 'Ob-Gyn',
            'institution' => $institution,
            'avatar' => $avatar,
            'is_active' => 1,
        ];
    }
    return $row;
}

function pcode_oauth_fetch_user_by_email(PDO $pdo, string $email): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email LIMIT 1');
    $stmt->execute(['email' => $email]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function pcode_oauth_map_clinical_provider_for_auth(array $provider, string $picture = ''): array
{
    $storedAvatar = trim((string) ($provider['avatar'] ?? ''));
    $avatar = $picture !== '' ? $picture : $storedAvatar;
    return [
        'user_id' => (int) ($provider['id'] ?? 0),
        'email' => (string) ($provider['email'] ?? ''),
        'user_name' => (string) ($provider['user_name'] ?? ''),
        'role' => (string) ($provider['role'] ?? 'Ob-Gyn'),
        'institution' => (string) ($provider['institution'] ?? ''),
        'avatar' => $avatar,
        'auth_source' => 'clinical_providers',
    ];
}

function pcode_oauth_is_patient_only_user(?array $user): bool
{
    if ($user === null) {
        return false;
    }
    $role = trim((string) ($user['role'] ?? ''));
    return $role === '' || $role === 'Regular User';
}

function pcode_oauth_derive_name_from_email(string $email): string
{
    $local = trim((string) strtok($email, '@'));
    $cleaned = preg_replace('/[._+\-]+/', ' ', $local);
    $cleaned = preg_replace('/\s+/', ' ', trim((string) $cleaned));
    if (strlen($cleaned) < 2) {
        return 'P-Code User';
    }
    $parts = preg_split('/\s+/', $cleaned);
    $parts = array_map(static function ($part) {
        return ucfirst(strtolower($part));
    }, $parts);
    return implode(' ', $parts);
}

function pcode_oauth_compose_name(string $given, string $family, string $email, string $fallback = ''): string
{
    $composed = trim($given . ' ' . $family);
    if (strlen($composed) >= 2) {
        return $composed;
    }
    if (strlen(trim($fallback)) >= 2) {
        return trim($fallback);
    }
    return pcode_oauth_derive_name_from_email($email);
}

function pcode_oauth_build_display_name(array $tokenData): string
{
    return pcode_oauth_compose_name(
        (string) ($tokenData['given_name'] ?? ''),
        (string) ($tokenData['family_name'] ?? ''),
        (string) ($tokenData['email'] ?? ''),
        (string) ($tokenData['name'] ?? '')
    );
}

function pcode_oauth_insert_user(PDO $pdo, string $email, string $name, string $role, string $institution = '', string $avatar = ''): array
{
    $passwordHash = pcode_hash_password_for_storage(bin2hex(random_bytes(16)));
    $stmt = $pdo->prepare(
        'INSERT INTO users (email, user_name, password, role, institution, avatar, created_at)
         VALUES (:email, :user_name, :password, :role, :institution, :avatar, NOW())'
    );
    $stmt->execute([
        'email' => $email,
        'user_name' => $name,
        'password' => $passwordHash,
        'role' => $role,
        'institution' => $institution,
        'avatar' => $avatar !== '' ? $avatar : null,
    ]);

    return [
        'user_id' => (int) $pdo->lastInsertId(),
        'email' => $email,
        'user_name' => $name,
        'role' => $role,
        'institution' => $institution,
        'avatar' => $avatar,
    ];
}

function pcode_oauth_update_user_avatar(PDO $pdo, int $userId, string $avatar): void
{
    if ($avatar === '') {
        return;
    }
    $stmt = $pdo->prepare('UPDATE users SET avatar = :avatar WHERE user_id = :user_id');
    $stmt->execute([
        'avatar' => $avatar,
        'user_id' => $userId,
    ]);
}

function pcode_oauth_update_clinical_provider_avatar(PDO $pdo, int $providerId, string $avatar): void
{
    if ($avatar === '' || $providerId <= 0) {
        return;
    }
    try {
        $stmt = $pdo->prepare('UPDATE clinical_providers SET avatar = :avatar WHERE id = :id');
        $stmt->execute([
            'avatar' => $avatar,
            'id' => $providerId,
        ]);
    } catch (PDOException $e) {
        // avatar column may be missing on older databases
    }
}

function pcode_oauth_establish_redirect_session(array $user, string $email, string $avatar = '', bool $isClinicalProvider = false): void
{
    pcode_auth_establish_redirect_session($user, $email, $avatar, $isClinicalProvider);
}

// ---------------------------------------------------------------------------
// A) Google Identity Services redirect lifecycle (form POST credential JWT)
// ---------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['credential'])) {
    require_once __DIR__ . '/../../config/db_connection.php';
    pcode_oauth_session_start();

    try {
        $credential = trim((string) $_POST['credential']);
        if ($credential === '') {
            throw new RuntimeException('invalid_token');
        }

        $portal = pcode_oauth_resolve_portal_context();
        $loginUrl = pcode_oauth_login_url($portal);

        $tokenData = pcode_oauth_verify_google_token($credential);
        $email = strtolower(trim((string) ($tokenData['email'] ?? '')));
        $givenName = trim((string) ($tokenData['given_name'] ?? ''));
        $familyName = trim((string) ($tokenData['family_name'] ?? ''));
        $picture = pcode_oauth_resolve_google_picture($tokenData, $credential);

        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new RuntimeException('invalid_token');
        }

        $pdo = pcode_pdo();

        if ($portal === 'provider') {
            $clinicalProvider = pcode_oauth_fetch_clinical_provider_by_email($pdo, $email);
            if ($clinicalProvider === null) {
                $loginUrl = pcode_oauth_login_url('provider');
                pcode_oauth_redirect($loginUrl . '?error=provider_not_authorized');
            } elseif ($picture !== '') {
                pcode_oauth_update_clinical_provider_avatar($pdo, (int) $clinicalProvider['id'], $picture);
                $clinicalProvider['avatar'] = $picture;
            }

            $providerAuth = pcode_oauth_map_clinical_provider_for_auth($clinicalProvider, $picture);
            pcode_oauth_establish_redirect_session($providerAuth, $email, $picture, true);
            pcode_oauth_redirect(pcode_oauth_dashboard_url('provider'));
        }

        // Patient / community portal — users table only
        $user = pcode_oauth_fetch_user_by_email($pdo, $email);
        if ($user === null) {
            $displayName = pcode_oauth_compose_name($givenName, $familyName, $email, '');
            $user = pcode_oauth_insert_user($pdo, $email, $displayName, 'Regular User', '', $picture);
        } else {
            pcode_oauth_update_user_avatar($pdo, (int) $user['user_id'], $picture);
            if ($picture !== '') {
                $user['avatar'] = $picture;
            }
        }

        pcode_oauth_establish_redirect_session($user, $email, $picture, false);
        pcode_oauth_redirect(pcode_oauth_dashboard_url('patient'));
    } catch (Throwable $e) {
        $portal = pcode_oauth_resolve_portal_context();
        $loginUrl = pcode_oauth_login_url($portal);
        pcode_oauth_redirect($loginUrl . '?error=invalid_token');
    }
}

// ---------------------------------------------------------------------------
// B) JSON API for embedded GIS credential flow (auth.js / modals)
// ---------------------------------------------------------------------------
define('PCODE_SKIP_API_HEADERS', true);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../../config/db_connection.php';
require_once __DIR__ . '/../auth_portal_enforcement.php';
require_once __DIR__ . '/../auth_helpers.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

function pcode_normalize_email(string $email): string
{
    return strtolower(trim($email));
}

function pcode_verify_google_id_token(string $idToken): array
{
    $clientId = defined('GOOGLE_CLIENT_ID') ? GOOGLE_CLIENT_ID : '';
    if ($clientId === '') {
        throw new Exception('Google OAuth is not configured on the server');
    }

    $url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($idToken);
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $response = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200 || !$response) {
        throw new Exception('Invalid Google token');
    }

    $tokenData = json_decode($response, true);
    if (!is_array($tokenData) || empty($tokenData['email'])) {
        throw new Exception('Google token missing email');
    }

    if (($tokenData['aud'] ?? '') !== $clientId) {
        throw new Exception('Token audience mismatch');
    }

    if (isset($tokenData['email_verified']) && $tokenData['email_verified'] !== 'true' && $tokenData['email_verified'] !== true) {
        throw new Exception('Google email is not verified');
    }

    return $tokenData;
}

try {
    if (isGuestUser()) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Guest sessions cannot use Google sign-in']);
        exit;
    }

    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input) || empty($input['id_token'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Missing ID token']);
        exit;
    }

    $tokenData = pcode_verify_google_id_token((string) $input['id_token']);
    $email = pcode_normalize_email((string) $tokenData['email']);
    $picture = pcode_oauth_resolve_google_picture($tokenData, (string) $input['id_token']);
    $displayName = pcode_oauth_build_display_name($tokenData);

    $expectedAccess = isset($input['expectedAccess']) ? strtolower(trim((string) $input['expectedAccess'])) : '';
    $loginContext = isset($input['loginContext']) ? strtolower(trim((string) $input['loginContext'])) : '';

    $pdo = pcode_pdo();
    $user = null;
    $isClinicalProvider = false;

    if ($expectedAccess === 'provider') {
        $clinicalProvider = pcode_oauth_fetch_clinical_provider_by_email($pdo, $email);
        if ($clinicalProvider === null) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'This Google account is not on the authorized clinical provider roster. Ask an administrator to add you.',
                'code' => 'provider_not_authorized',
            ]);
            exit;
        }
        if ($picture !== '') {
            pcode_oauth_update_clinical_provider_avatar($pdo, (int) $clinicalProvider['id'], $picture);
            $clinicalProvider['avatar'] = $picture;
        }
        $user = pcode_oauth_map_clinical_provider_for_auth($clinicalProvider, $picture);
        $isClinicalProvider = true;
    } else {
        $user = pcode_oauth_fetch_user_by_email($pdo, $email);
        if ($user === null) {
            $user = pcode_oauth_insert_user($pdo, $email, $displayName, 'Regular User', '', $picture);
        } else {
            pcode_oauth_update_user_avatar($pdo, (int) $user['user_id'], $picture);
            if ($picture !== '') {
                $user['avatar'] = $picture;
            }
        }
    }

    if ($loginContext === 'portal-pick' && $expectedAccess !== '') {
        if ($expectedAccess === 'provider' && !$isClinicalProvider) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'This Google account is not on the authorized clinical provider roster.',
                'code' => 'provider_not_authorized',
            ]);
            exit;
        }
        if ($expectedAccess === 'community' && !pcode_oauth_is_patient_only_user($user)) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'This Google account cannot access the regular user portal.',
                'code' => 'portal_role_mismatch',
            ]);
            exit;
        }
    } elseif ($expectedAccess === 'provider' && !$isClinicalProvider) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'This Google account is not on the authorized clinical provider roster.',
            'code' => 'provider_not_authorized',
        ]);
        exit;
    } elseif ($expectedAccess === 'community' && !pcode_oauth_is_patient_only_user($user)) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Portal access denied for this account',
            'code' => 'portal_role_mismatch',
        ]);
        exit;
    }

    $tokenExpiry = time() + JWT_EXPIRY;
    $payload = [
        'id' => (int) $user['user_id'],
        'email' => $user['email'],
        'role' => $user['role'],
        'exp' => $tokenExpiry,
    ];
    if (!empty($user['auth_source'])) {
        $payload['auth_source'] = (string) $user['auth_source'];
    } elseif ($isClinicalProvider) {
        $payload['auth_source'] = 'clinical_providers';
    } else {
        $payload['auth_source'] = 'users';
    }
    $token = generateJWT($payload);

    pcode_establish_user_session([
        'user_id' => $user['user_id'],
        'email' => $user['email'],
        'user_name' => $user['user_name'] ?? $displayName,
        'role' => $user['role'] ?? '',
    ]);

    if ($isClinicalProvider) {
        pcode_oauth_session_start();
        $_SESSION['provider_id'] = (int) $user['user_id'];
        $_SESSION['auth_source'] = 'clinical_providers';
    }

    echo json_encode([
        'success' => true,
        'message' => 'Google sign-in successful',
        'token' => $token,
        'user' => [
            'id' => (int) $user['user_id'],
            'email' => $user['email'],
            'name' => $user['user_name'] ?? $displayName,
            'role' => $user['role'] ?? '',
            'institution' => $user['institution'] ?? '',
            'picture' => $user['avatar'] ?? $picture,
            'avatar' => $user['avatar'] ?? $picture,
        ],
        'expiresIn' => JWT_EXPIRY,
    ]);
} catch (Throwable $e) {
    pcode_log('google_callback error: ' . $e->getMessage());
    $status = 500;
    $message = 'Google authentication failed';
    if (stripos($e->getMessage(), 'token') !== false || stripos($e->getMessage(), 'Google') !== false) {
        $status = 401;
        $message = $e->getMessage();
    }
    http_response_code($status);
    echo json_encode(['success' => false, 'message' => $message]);
}
