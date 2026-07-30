<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/password_helpers.php';
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
    // Validate required fields
    if (!isset($input['name']) || !isset($input['email']) || !isset($input['role'])) {
        throw new Exception('Name, email, and role are required');
    }

    $name = trim($input['name']);
    $email = trim($input['email']);
    $role = trim($input['role']);
    $institution = isset($input['institution']) ? trim($input['institution']) : '';
    $password = isset($input['password']) ? trim($input['password']) : null;

    $allowedRoles = [
        'Radiologist',
        'Ob-Gyn',
        'OB-Sonologist',
        'Other',
        'Health Expert',
        'Physician',
        'Regular User',
    ];
    if (!in_array($role, $allowedRoles, true)) {
        throw new Exception('Role is not allowed');
    }

    // Validate email
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new Exception('Invalid email format');
    }

    // Check if email already exists
    $stmt = $conn->prepare('SELECT user_id FROM users WHERE email = ?');
    $stmt->bind_param('s', $email);
    $stmt->execute();
    $result = $stmt->get_result();
    $stmt->close();

    if ($result->num_rows > 0) {
        throw new Exception('Email already exists in the system');
    }

    // Hash password if provided (bcrypt of SHA-256 digest)
    if ($password) {
        if (!pcode_password_is_sha256_digest($password) && strlen($password) < 8) {
            throw new Exception('Password must be at least 8 characters');
        }
        $hashed_password = pcode_hash_password_for_storage($password);
    } else {
        // Generate random unusable password
        $hashed_password = pcode_hash_password_for_storage(bin2hex(random_bytes(16)));
    }

    // Insert user
    $stmt = $conn->prepare('INSERT INTO users (user_name, email, password, role, institution) VALUES (?, ?, ?, ?, ?)');
    if (!$stmt) {
        throw new Exception('Database error: ' . $conn->error);
    }

    $stmt->bind_param('sssss', $name, $email, $hashed_password, $role, $institution);

    if ($stmt->execute()) {
        echo json_encode([
            'success' => true,
            'message' => 'User created successfully',
            'user_id' => $stmt->insert_id
        ]);
    } else {
        throw new Exception('Failed to create user: ' . $stmt->error);
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
