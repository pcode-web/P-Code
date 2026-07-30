<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth_helpers.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

requireAdmin();

$input = json_decode(file_get_contents('php://input'), true);

try {
    if (!isset($input['user_id'])) {
        throw new Exception('User ID is required');
    }

    $user_id = intval($input['user_id']);
    $admin = requireAuthDecoded();
    $adminId = requireUserId($admin);
    if ($user_id === $adminId) {
        throw new Exception('Cannot delete your own account');
    }

    // Prevent deleting the admin account
    $stmt = $conn->prepare('SELECT role FROM users WHERE user_id = ?');
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $result = $stmt->get_result();
    $stmt->close();

    if ($result->num_rows === 0) {
        throw new Exception('User not found');
    }

    $user = $result->fetch_assoc();
    $roleLower = strtolower(trim((string) ($user['role'] ?? '')));
    if ($roleLower === 'administrator' || $roleLower === 'admin' || $roleLower === 'system administrator') {
        throw new Exception('Cannot delete administrator accounts');
    }

    // Delete user
    $stmt = $conn->prepare('DELETE FROM users WHERE user_id = ?');
    $stmt->bind_param('i', $user_id);

    if ($stmt->execute()) {
        echo json_encode([
            'success' => true,
            'message' => 'User deleted successfully'
        ]);
    } else {
        throw new Exception('Failed to delete user: ' . $stmt->error);
    }

    $stmt->close();

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

$conn->close();
?>
