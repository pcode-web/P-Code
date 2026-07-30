<?php
/**
 * Hydrate PHP session from a valid JWT (companion to Bearer + cookie auth).
 * Renews expired tokens within grace period so dashboards keep working after login.
 */
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth_helpers.php';

pcode_session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error_and_exit(405, 'Method not allowed');
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    $input = [];
}

$token = pcode_request_bearer_token($input);
if (!$token) {
    json_error_and_exit(401, 'Unauthorized: missing Authorization token');
}

$decoded = verifyJWT($token, 0);
$renewToken = false;
if (!$decoded) {
    $decoded = verifyJWT($token, defined('JWT_EXPIRY') ? (int)JWT_EXPIRY : 2592000);
    if (!$decoded) {
        json_error_and_exit(401, 'Unauthorized: invalid or expired token');
    }
    $renewToken = true;
}

$userId = $decoded['id'] ?? null;
if (!$userId) {
    json_error_and_exit(401, 'Unauthorized: invalid token payload');
}

pcode_establish_user_session([
    'user_id' => $userId,
    'email' => $decoded['email'] ?? '',
    'user_name' => $decoded['name'] ?? '',
    'role' => $decoded['role'] ?? '',
]);

$response = [
    'success' => true,
    'message' => 'Session synchronized',
    'provider_id' => $_SESSION['provider_id'] ?? null,
    'user_id' => $_SESSION['user_id'] ?? null,
];

if ($renewToken) {
    $jwtPayload = [
        'id' => $userId,
        'email' => $decoded['email'] ?? '',
        'name' => $decoded['name'] ?? '',
        'role' => $decoded['role'] ?? '',
    ];
    if (!empty($decoded['isGuest'])) {
        $jwtPayload['isGuest'] = true;
    }
    $response['token'] = generateJWT($jwtPayload);
    $response['expiresIn'] = JWT_EXPIRY;
    $response['renewed'] = true;
}

http_response_code(200);
echo json_encode($response);
