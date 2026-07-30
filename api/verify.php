<?php
require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendResponse(false, 'Method not allowed', null, 405);
}

$token = getAuthToken();

if (!$token) {
    sendResponse(false, 'No token provided', null, 401);
}

$decoded = verifyJWT($token);

if (!$decoded) {
    sendResponse(false, 'Invalid or expired token', null, 401);
}

// Get user details from database
$stmt = $conn->prepare('SELECT user_id, user_name, email, password, role, institution, avatar FROM users WHERE user_id = ?');
$stmt->bind_param('i', $decoded['id']);
$stmt->execute();
$result = $stmt->get_result();

if ($result->num_rows === 0) {
    $stmt->close();
    sendResponse(false, 'User not found', null, 404);
}

$user = $result->fetch_assoc();
$stmt->close();

sendResponse(true, 'Token is valid', [
    'user' => [
        'id' => $user['user_id'],
        'name' => $user['user_name'],
        'email' => $user['email'],
        'role' => $user['role'],
        'institution' => $user['institution'],
        'avatar' => $user['avatar'] ?: 'https://ui-avatars.com/api/?name=' . urlencode($user['user_name']) . '&background=6B46C1&color=fff'
    ]
], 200);
?>
