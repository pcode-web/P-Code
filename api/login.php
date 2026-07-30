<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/password_helpers.php';
require_once __DIR__ . '/auth_portal_enforcement.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendResponse(false, 'Method not allowed', null, 405);
}

$input = json_decode(file_get_contents('php://input'), true);

if (!isset($input['email']) || !isset($input['password'])) {
    sendResponse(false, 'Email and password are required', null, 400);
}

$email = trim($input['email']);
$password = trim($input['password']);
$isAdminLogin = isset($input['isAdminLogin']) && $input['isAdminLogin'] === true;
$expectedAccess = '';
if (isset($input['expectedAccess'])) {
    $expectedAccess = strtolower(trim((string) $input['expectedAccess']));
}
$loginContext = isset($input['loginContext']) ? strtolower(trim((string) $input['loginContext'])) : '';

// Validate email format
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    sendResponse(false, 'Invalid email format', null, 400);
}

// Validate password length (SHA-256 digest is 64 hex chars)
if ($password === '' || (!pcode_password_is_sha256_digest($password) && strlen($password) < 8)) {
    sendResponse(false, 'Invalid email or password', null, 401);
}

/**
 * Verify password against stored hash (digest preferred; legacy bcrypt/plain accepted).
 */
function pcode_login_verify_password(string $password, string $stored): bool
{
    if ($stored === '') {
        return false;
    }
    $digest = pcode_password_to_digest($password);
    return password_verify($digest, $stored)
        || (!pcode_password_is_sha256_digest($password) && password_verify($password, $stored))
        || (!pcode_password_looks_bcrypt_or_argon($stored) && (
            hash_equals($stored, $password)
            || hash_equals(hash('sha256', $stored), $digest)
        ));
}

// Provider portal — clinical_providers roster
if (!$isAdminLogin && $expectedAccess === 'provider') {
    $stmt = $conn->prepare(
        'SELECT id, email, password, user_name, role, institution, avatar, is_active
         FROM clinical_providers WHERE email = ? LIMIT 1'
    );
    if (!$stmt) {
        sendResponse(false, 'Database error', null, 500);
    }
    $stmt->bind_param('s', $email);
    if (!$stmt->execute()) {
        sendResponse(false, 'Database query failed', null, 500);
    }
    $result = $stmt->get_result();
    $provider = $result->num_rows > 0 ? $result->fetch_assoc() : null;
    $stmt->close();

    $stored = is_array($provider) ? (string) ($provider['password'] ?? '') : '';
    $active = is_array($provider) && (int) ($provider['is_active'] ?? 0) === 1;
    $providerId = is_array($provider) ? (int) ($provider['id'] ?? 0) : 0;

    if (!$provider || !$active || $providerId <= 0 || !pcode_login_verify_password($password, $stored)) {
        password_verify('placeholder', password_hash('placeholder', PASSWORD_BCRYPT));
        sendResponse(false, 'Invalid email or password', null, 401);
    }

    // Upgrade legacy storage when possible
    if (pcode_password_looks_bcrypt_or_argon($stored) && !password_verify(pcode_password_to_digest($password), $stored)
        && !pcode_password_is_sha256_digest($password) && password_verify($password, $stored)) {
        try {
            $newHash = pcode_hash_password_for_storage($password);
            $up = $conn->prepare('UPDATE clinical_providers SET password = ? WHERE id = ? LIMIT 1');
            if ($up) {
                $up->bind_param('si', $newHash, $providerId);
                $up->execute();
                $up->close();
            }
        } catch (Throwable $e) {
            // allow login even if upgrade fails
        }
    }

    $role = (string) ($provider['role'] ?? 'Ob-Gyn');
    $name = (string) ($provider['user_name'] ?? '');
    $institution = (string) ($provider['institution'] ?? '');
    $avatar = (string) ($provider['avatar'] ?? '');
    if ($avatar === '') {
        $avatar = 'https://ui-avatars.com/api/?name=' . urlencode($name !== '' ? $name : 'OB-GYN') . '&background=6B46C1&color=fff';
    }

    $token = generateJWT([
        'id' => $providerId,
        'email' => $email,
        'name' => $name,
        'role' => $role,
        'auth_source' => 'clinical_providers',
    ]);

    require_once __DIR__ . '/auth_helpers.php';
    pcode_establish_user_session([
        'user_id' => $providerId,
        'email' => $email,
        'user_name' => $name,
        'role' => $role,
    ]);

    sendResponse(true, 'Login successful', [
        'token' => $token,
        'expiresIn' => JWT_EXPIRY,
        'user' => [
            'id' => $providerId,
            'name' => $name,
            'email' => $email,
            'role' => $role,
            'institution' => $institution,
            'avatar' => $avatar,
            'picture' => $avatar,
            'authSource' => 'clinical_providers',
        ],
    ], 200);
}

// Patient / admin — users table
$stmt = $conn->prepare('SELECT user_id, user_name, email, password, role, institution FROM users WHERE email = ? LIMIT 1');
if (!$stmt) {
    sendResponse(false, 'Database error', null, 500);
}

$stmt->bind_param('s', $email);
if (!$stmt->execute()) {
    sendResponse(false, 'Database query failed', null, 500);
}

$result = $stmt->get_result();

if ($result->num_rows === 0) {
    password_verify('placeholder', password_hash('placeholder', PASSWORD_BCRYPT));
    sendResponse(false, 'Invalid email or password', null, 401);
}

$user = $result->fetch_assoc();
$stmt->close();

$stored = (string) ($user['password'] ?? '');
if (!pcode_login_verify_password($password, $stored)) {
    sendResponse(false, 'Invalid email or password', null, 401);
}

// Upgrade legacy storage when possible (mysqli path)
if (pcode_password_looks_bcrypt_or_argon($stored) && !password_verify(pcode_password_to_digest($password), $stored)
    && !pcode_password_is_sha256_digest($password) && password_verify($password, $stored)) {
    try {
        $newHash = pcode_hash_password_for_storage($password);
        $up = $conn->prepare('UPDATE users SET password = ? WHERE user_id = ? LIMIT 1');
        if ($up) {
            $uid = (int) $user['user_id'];
            $up->bind_param('si', $newHash, $uid);
            $up->execute();
            $up->close();
        }
    } catch (Throwable $e) {
        // allow login even if upgrade fails
    }
}

// Prevent administrator accounts from logging in through regular login
// unless they specifically requested admin login
if (!$isAdminLogin && (strtolower($user['role']) === 'administrator' || strtolower($user['role']) === 'admin')) {
    sendResponse(false, 'Admin accounts cannot log in through this portal. Please use the "Continue as Administrator" option.', null, 403);
}

// If admin login was requested, ensure user is actually an admin
if ($isAdminLogin && !(strtolower($user['role']) === 'administrator' || strtolower($user['role']) === 'admin')) {
    sendResponse(false, 'Only administrator accounts can log in here. Please use the regular login option.', null, 403);
}

if (!$isAdminLogin) {
    if ($loginContext === 'portal-pick') {
        if ($expectedAccess !== 'community' && $expectedAccess !== 'provider') {
            sendResponse(false, 'Invalid email or password', null, 401);
        }
        if (!pcode_portal_allows_role($expectedAccess, $user['role'])) {
            sendResponse(false, 'Invalid email or password', null, 401);
        }
    } elseif ($expectedAccess !== '' && !pcode_portal_allows_role($expectedAccess, $user['role'])) {
        sendResponse(false, 'Invalid email or password', null, 401);
    }
}

// Generate JWT token
$token_data = [
    'id' => $user['user_id'],
    'email' => $user['email'],
    'name' => $user['user_name'],
    'role' => $user['role']
];

$token = generateJWT($token_data);

require_once __DIR__ . '/auth_helpers.php';
pcode_establish_user_session([
    'user_id' => $user['user_id'],
    'email' => $user['email'],
    'user_name' => $user['user_name'],
    'role' => $user['role'],
]);

// Return success with user data
sendResponse(true, 'Login successful', [
    'token' => $token,
    'expiresIn' => JWT_EXPIRY,
    'user' => [
        'id' => $user['user_id'],
        'name' => $user['user_name'],
        'email' => $user['email'],
        'role' => $user['role'],
        'institution' => $user['institution'],
        'avatar' => 'https://ui-avatars.com/api/?name=' . urlencode($user['user_name']) . '&background=6B46C1&color=fff'
    ]
], 200);
?>
