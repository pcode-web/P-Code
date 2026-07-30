<?php
require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendResponse(false, 'Method not allowed', null, 405);
}

// Guest login - no credentials needed
$guestUser = [
    'id' => 'guest_' . uniqid(),
    'email' => 'guest@pcode.local',
    'name' => 'Guest User',
    'role' => 'Guest',
    'isGuest' => true
];

// Generate JWT token for guest
$token_data = [
    'id' => $guestUser['id'],
    'email' => $guestUser['email'],
    'name' => $guestUser['name'],
    'role' => 'Guest',
    'isGuest' => true
];

$token = generateJWT($token_data);

// Return success with guest user data
sendResponse(true, 'Guest login successful', [
    'token' => $token,
    'expiresIn' => JWT_EXPIRY,
    'user' => [
        'id' => $guestUser['id'],
        'name' => $guestUser['name'],
        'email' => $guestUser['email'],
        'role' => 'Guest',
        'isGuest' => true,
        'avatar' => 'https://ui-avatars.com/api/?name=Guest+User&background=9CA3AF&color=fff'
    ]
], 200);
?>
