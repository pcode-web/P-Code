<?php
/**
 * POST api/auth/firebase_callback.php
 * Body: { id_token, expectedAccess?: "community"|"provider", loginContext?: "portal-pick", mode?: "signin"|"signup"|"password" }
 *
 * Verifies a Firebase ID token and issues a P-Code JWT (mirrors Google OAuth bridge).
 */
declare(strict_types=1);

define('PCODE_SKIP_API_HEADERS', true);
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../../config/db_connection.php';
require_once __DIR__ . '/../auth_helpers.php';
require_once __DIR__ . '/../password_helpers.php';
require_once __DIR__ . '/session_helpers.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

if (!defined('FIREBASE_WEB_API_KEY')) {
    require_once __DIR__ . '/../../config/env_loader.php';
    $envKey = pcode_env('PCODE_FIREBASE_WEB_API_KEY');
    define(
        'FIREBASE_WEB_API_KEY',
        is_string($envKey) && $envKey !== ''
            ? $envKey
            : 'AIzaSyCQo5PMVcPN-49y3onIyoy3yzoDZNn3ab0'
    );
}
if (!defined('FIREBASE_PROJECT_ID')) {
    $envProject = function_exists('pcode_env') ? pcode_env('PCODE_FIREBASE_PROJECT_ID') : getenv('PCODE_FIREBASE_PROJECT_ID');
    define(
        'FIREBASE_PROJECT_ID',
        is_string($envProject) && $envProject !== ''
            ? $envProject
            : 'project-a3473fa6-d957-4693-96a'
    );
}

function pcode_firebase_normalize_email(string $email): string
{
    return strtolower(trim($email));
}

function pcode_firebase_derive_name(string $email, string $fallback = ''): string
{
    if (strlen(trim($fallback)) >= 2) {
        return trim($fallback);
    }
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

/**
 * Verify Firebase ID token via Identity Toolkit accounts:lookup.
 * @return array{email:string,email_verified:bool,local_id:string,name:string}
 */
function pcode_firebase_verify_id_token(string $idToken): array
{
    $apiKey = FIREBASE_WEB_API_KEY;
    if ($apiKey === '') {
        throw new RuntimeException('Firebase is not configured on the server');
    }

    $url = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . rawurlencode($apiKey);
    $payload = json_encode(['idToken' => $idToken]);

    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $response = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200 || !is_string($response) || $response === '') {
        throw new RuntimeException('invalid_token');
    }

    $data = json_decode($response, true);
    if (!is_array($data) || empty($data['users'][0]) || !is_array($data['users'][0])) {
        throw new RuntimeException('invalid_token');
    }

    $user = $data['users'][0];
    $email = pcode_firebase_normalize_email((string) ($user['email'] ?? ''));
    if ($email === '') {
        throw new RuntimeException('invalid_token');
    }

    $verified = !empty($user['emailVerified']);
    // Email-link sign-in always verifies the inbox; still require verified flag when present.
    if (array_key_exists('emailVerified', $user) && !$verified) {
        throw new RuntimeException('Email is not verified');
    }

    return [
        'email' => $email,
        'email_verified' => $verified,
        'local_id' => (string) ($user['localId'] ?? ''),
        'name' => (string) ($user['displayName'] ?? ''),
    ];
}

function pcode_firebase_fetch_user(PDO $pdo, string $email): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email LIMIT 1');
    $stmt->execute(['email' => $email]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function pcode_firebase_fetch_provider(PDO $pdo, string $email): ?array
{
    $stmt = $pdo->prepare(
        'SELECT * FROM clinical_providers WHERE email = :email AND is_active = 1 LIMIT 1'
    );
    $stmt->execute(['email' => $email]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function pcode_firebase_insert_user(PDO $pdo, string $email, string $name): array
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
        'role' => 'Regular User',
        'institution' => '',
        'avatar' => null,
    ]);
    $row = pcode_firebase_fetch_user($pdo, $email);
    if ($row === null) {
        return [
            'user_id' => (int) $pdo->lastInsertId(),
            'email' => $email,
            'user_name' => $name,
            'role' => 'Regular User',
            'institution' => '',
            'avatar' => '',
        ];
    }
    return $row;
}

function pcode_firebase_map_provider(array $provider): array
{
    return [
        'user_id' => (int) ($provider['id'] ?? 0),
        'email' => (string) ($provider['email'] ?? ''),
        'user_name' => (string) ($provider['user_name'] ?? ''),
        'role' => (string) ($provider['role'] ?? 'Ob-Gyn'),
        'institution' => (string) ($provider['institution'] ?? ''),
        'avatar' => (string) ($provider['avatar'] ?? ''),
        'auth_source' => 'clinical_providers',
    ];
}

function pcode_firebase_is_patient_only(?array $user): bool
{
    if ($user === null) {
        return false;
    }
    $role = trim((string) ($user['role'] ?? ''));
    return $role === '' || $role === 'Regular User';
}

try {
    if (isGuestUser()) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Guest sessions cannot use email-link sign-in']);
        exit;
    }

    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input) || empty($input['id_token'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Missing Firebase ID token']);
        exit;
    }

    $tokenData = pcode_firebase_verify_id_token((string) $input['id_token']);
    $email = $tokenData['email'];
    $displayName = pcode_firebase_derive_name($email, $tokenData['name']);

    $expectedAccess = isset($input['expectedAccess']) ? strtolower(trim((string) $input['expectedAccess'])) : '';
    $loginContext = isset($input['loginContext']) ? strtolower(trim((string) $input['loginContext'])) : '';

    $pdo = pcode_pdo();
    $user = null;
    $isClinicalProvider = false;

    if ($expectedAccess === 'provider') {
        $clinicalProvider = pcode_firebase_fetch_provider($pdo, $email);
        if ($clinicalProvider === null) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'This email is not on the authorized clinical provider roster. Ask an administrator to add you.',
                'code' => 'provider_not_authorized',
            ]);
            exit;
        }
        $user = pcode_firebase_map_provider($clinicalProvider);
        $isClinicalProvider = true;
    } else {
        $user = pcode_firebase_fetch_user($pdo, $email);
        if ($user === null) {
            $user = pcode_firebase_insert_user($pdo, $email, $displayName);
        }
    }

    if ($loginContext === 'portal-pick' && $expectedAccess !== '') {
        if ($expectedAccess === 'provider' && !$isClinicalProvider) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'This email is not on the authorized clinical provider roster.',
                'code' => 'provider_not_authorized',
            ]);
            exit;
        }
        if ($expectedAccess === 'community' && !pcode_firebase_is_patient_only($user)) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'This account cannot access the regular user portal.',
                'code' => 'portal_role_mismatch',
            ]);
            exit;
        }
    }

    $tokenExpiry = time() + JWT_EXPIRY;
    $payload = [
        'id' => (int) $user['user_id'],
        'email' => $user['email'],
        'role' => $user['role'],
        'exp' => $tokenExpiry,
        'auth_source' => $isClinicalProvider ? 'clinical_providers' : 'users',
        'auth_provider' => 'firebase_email_link',
    ];
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
        'message' => 'Email link sign-in successful',
        'token' => $token,
        'user' => [
            'id' => (int) $user['user_id'],
            'email' => $user['email'],
            'name' => $user['user_name'] ?? $displayName,
            'role' => $user['role'] ?? '',
            'institution' => $user['institution'] ?? '',
            'picture' => $user['avatar'] ?? '',
            'avatar' => $user['avatar'] ?? '',
        ],
        'expiresIn' => JWT_EXPIRY,
    ]);
} catch (Throwable $e) {
    pcode_log('firebase_callback error: ' . $e->getMessage());
    $msg = $e->getMessage();
    $status = (stripos($msg, 'token') !== false || stripos($msg, 'Email') !== false) ? 401 : 500;
    http_response_code($status);
    echo json_encode([
        'success' => false,
        'message' => $status === 401 ? $msg : 'Firebase authentication failed',
    ]);
}
