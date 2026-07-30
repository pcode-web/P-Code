<?php
/**
 * Open registration for Patient (users) and Provider (clinical_providers) portals.
 * Expects JSON: { email, password, user_name?, institution?, registration_portal: "patient"|"provider"|"community" }
 * Password may be plaintext or SHA-256 hex digest (client-hashed).
 */
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/password_helpers.php';

$logFile = __DIR__ . '/../logs/register_debug.log';
if (!is_dir(__DIR__ . '/../logs')) {
    @mkdir(__DIR__ . '/../logs', 0777, true);
}

function debugLog($message) {
    if (!PCODE_DEBUG) return;
    global $logFile;
    $timestamp = date('Y-m-d H:i:s');
    file_put_contents($logFile, "[$timestamp] $message\n", FILE_APPEND);
}

function pcode_derive_display_name_from_email($email, $fallback = 'User') {
    $local = trim((string) strtok((string) $email, '@'));
    $cleaned = preg_replace('/[._+\-]+/', ' ', $local);
    $cleaned = preg_replace('/\s+/', ' ', trim((string) $cleaned));
    if (strlen($cleaned) >= 2) {
        $parts = preg_split('/\s+/', $cleaned);
        $parts = array_map(function ($part) {
            $part = strtolower($part);
            return ucfirst($part);
        }, $parts);
        return implode(' ', $parts);
    }
    return $fallback;
}

function pcode_derive_provider_display_name($email) {
    return pcode_derive_display_name_from_email($email, 'OB-GYN');
}

function pcode_email_taken_anywhere(mysqli $conn, string $email): bool
{
    $stmt = $conn->prepare('SELECT 1 FROM users WHERE email = ? LIMIT 1');
    if ($stmt) {
        $stmt->bind_param('s', $email);
        $stmt->execute();
        if ($stmt->get_result()->num_rows > 0) {
            $stmt->close();
            return true;
        }
        $stmt->close();
    }
    $stmt = $conn->prepare('SELECT 1 FROM clinical_providers WHERE email = ? LIMIT 1');
    if ($stmt) {
        $stmt->bind_param('s', $email);
        $stmt->execute();
        $taken = $stmt->get_result()->num_rows > 0;
        $stmt->close();
        return $taken;
    }
    return false;
}

debugLog('=== NEW REGISTRATION REQUEST ===');
debugLog('Method: ' . $_SERVER['REQUEST_METHOD']);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    debugLog('ERROR: Invalid method');
    sendResponse(false, 'Method not allowed', null, 405);
}

$raw_input = file_get_contents('php://input');
if ($raw_input === false || trim($raw_input) === '') {
    debugLog('ERROR: Empty request body');
    sendResponse(false, 'Empty request body', null, 400);
}

$input = json_decode($raw_input, true);
if (!is_array($input)) {
    debugLog('ERROR: Invalid JSON — ' . json_last_error_msg());
    sendResponse(false, 'Invalid JSON format', null, 400);
}

$registration_portal = isset($input['registration_portal'])
    ? strtolower(trim((string) $input['registration_portal']))
    : 'patient';
if ($registration_portal === 'community' || $registration_portal === 'user') {
    $registration_portal = 'patient';
}
$is_provider_portal = ($registration_portal === 'provider');

$email = isset($input['email']) ? strtolower(trim((string) $input['email'])) : '';
$password = isset($input['password']) ? trim((string) $input['password']) : '';
$name = isset($input['user_name']) ? trim((string) $input['user_name']) : '';
$institution = isset($input['institution']) ? trim((string) $input['institution']) : '';

if ($email === '' || $password === '') {
    sendResponse(false, 'Email and password are required', null, 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    sendResponse(false, 'Invalid email format', null, 400);
}

if ($is_provider_portal) {
    if (strlen($name) < 2) {
        $name = pcode_derive_provider_display_name($email);
    }
} elseif (strlen($name) < 2) {
    $name = pcode_derive_display_name_from_email($email, 'Patient');
}

if (!pcode_password_is_sha256_digest($password) && strlen($password) < 8) {
    sendResponse(false, 'Password must be at least 8 characters', null, 400);
}

if (!pcode_password_is_sha256_digest($password)) {
    if (!preg_match('/[A-Z]/', $password) ||
        !preg_match('/[a-z]/', $password) ||
        !preg_match('/[0-9]/', $password) ||
        !preg_match('/[!@#$%^&*(),.?":{}|<>]/', $password)) {
        sendResponse(false, 'Password must contain uppercase, lowercase, number, and special character', null, 400);
    }
}

try {
    $hashed_password = pcode_hash_password_for_storage($password);
} catch (Throwable $e) {
    sendResponse(false, 'Failed to secure password', null, 500);
}

if (pcode_email_taken_anywhere($conn, $email)) {
    sendResponse(false, 'Email already registered', null, 409);
}

if ($is_provider_portal) {
    sendResponse(
        false,
        'Provider accounts must be created by an administrator. Self-registration for OB-GYN portals is disabled.',
        ['code' => 'provider_registration_disabled'],
        403
    );
}

// Patient / community portal → users table
$role = 'Regular User';
$stmt = $conn->prepare(
    'INSERT INTO users (user_name, email, password, role, institution) VALUES (?, ?, ?, ?, ?)'
);
if (!$stmt) {
    sendResponse(false, 'Database error: ' . $conn->error, null, 500);
}
$stmt->bind_param('sssss', $name, $email, $hashed_password, $role, $institution);
if (!$stmt->execute()) {
    $err = $stmt->error;
    $stmt->close();
    sendResponse(false, 'Registration failed: ' . $err, null, 500);
}
$newId = (int) $conn->insert_id;
$stmt->close();

if ($newId <= 0) {
    sendResponse(false, 'Failed to retrieve user ID', null, 500);
}

$token = generateJWT([
    'id' => $newId,
    'email' => $email,
    'user_name' => $name,
    'role' => $role,
]);

debugLog("Patient registered id=$newId email=$email");
sendResponse(true, 'Patient account created. You can sign in now.', [
    'portal' => 'patient',
    'token' => $token,
    'expiresIn' => JWT_EXPIRY,
    'user' => [
        'id' => $newId,
        'name' => $name,
        'email' => $email,
        'role' => $role,
        'institution' => $institution,
        'avatar' => 'https://ui-avatars.com/api/?name=' . urlencode($name) . '&background=6B46C1&color=fff',
    ],
], 201);
