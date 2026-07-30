<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth_helpers.php';

header('Content-Type: application/json');

try {
    requireAdmin();

    // Get all users
    $query = "SELECT user_id, user_name, email, role, institution, 
                     CASE WHEN last_login IS NOT NULL THEN 1 ELSE 0 END as is_active,
                     created_at, updated_at
              FROM users
              WHERE role NOT IN ('Administrator', 'System Administrator')
              ORDER BY created_at DESC";
    
    $result = $conn->query($query);
    
    if (!$result) {
        throw new Exception('Database query failed: ' . $conn->error);
    }
    
    $users = [];
    while ($row = $result->fetch_assoc()) {
        $users[] = $row;
    }
    
    echo json_encode([
        'success' => true,
        'message' => 'Users retrieved successfully',
        'users' => $users,
        'total' => count($users)
    ]);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Error retrieving users: ' . $e->getMessage()
    ]);
}

$conn->close();
?>
