<?php
/**
 * Expose pending OAuth session (JWT + user) to the frontend after GIS redirect login.
 */
declare(strict_types=1);

define('PCODE_SKIP_API_HEADERS', true);
require_once __DIR__ . '/../../config/db_connection.php';
pcode_oauth_session_start();

header('Content-Type: application/json');

if (empty($_SESSION['pcos_auth_token']) || empty($_SESSION['pcos_auth_user'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'No active OAuth session']);
    exit;
}

$expires = (int) ($_SESSION['auth_expires'] ?? (time() + JWT_EXPIRY));
echo json_encode([
    'success' => true,
    'token' => (string) $_SESSION['pcos_auth_token'],
    'user' => $_SESSION['pcos_auth_user'],
    'expiresIn' => max(60, $expires - time()),
    'portal' => !empty($_SESSION['provider_id']) ? 'provider' : 'patient',
]);
