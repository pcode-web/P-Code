<?php
header('Content-Type: application/json');
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/password_helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendResponse(false, 'Method not allowed', null, 405);
}

/**
 * Provider portal accounts live in clinical_providers; community accounts in users.
 * JWT may omit auth_source, so resolve from claim / role / table membership.
 */
function pcode_profile_resolve_source(mysqli $conn, array $decoded): array
{
    $id = (int) ($decoded['id'] ?? $decoded['user_id'] ?? 0);
    $email = trim((string) ($decoded['email'] ?? ''));
    $authSource = strtolower(trim((string) (
        $decoded['auth_source'] ?? $decoded['authSource'] ?? ''
    )));
    $role = strtolower(trim((string) ($decoded['role'] ?? '')));

    if ($authSource === 'clinical_providers') {
        return ['source' => 'clinical_providers', 'id' => $id, 'email' => $email];
    }
    if ($authSource === 'users') {
        return ['source' => 'users', 'id' => $id, 'email' => $email];
    }

    $providerRoles = ['ob-gyn', 'obgyn', 'physician', 'provider', 'specialist', 'clinician'];
    if (in_array($role, $providerRoles, true)) {
        return ['source' => 'clinical_providers', 'id' => $id, 'email' => $email];
    }

    if ($id > 0) {
        $stmt = $conn->prepare('SELECT user_id FROM users WHERE user_id = ? LIMIT 1');
        if ($stmt) {
            $stmt->bind_param('i', $id);
            $stmt->execute();
            $res = $stmt->get_result();
            $found = $res && $res->num_rows > 0;
            $stmt->close();
            if ($found) {
                return ['source' => 'users', 'id' => $id, 'email' => $email];
            }
        }

        $stmt = $conn->prepare('SELECT id FROM clinical_providers WHERE id = ? LIMIT 1');
        if ($stmt) {
            $stmt->bind_param('i', $id);
            $stmt->execute();
            $res = $stmt->get_result();
            $found = $res && $res->num_rows > 0;
            $stmt->close();
            if ($found) {
                return ['source' => 'clinical_providers', 'id' => $id, 'email' => $email];
            }
        }
    }

    if ($email !== '') {
        $stmt = $conn->prepare('SELECT id FROM clinical_providers WHERE email = ? LIMIT 1');
        if ($stmt) {
            $stmt->bind_param('s', $email);
            $stmt->execute();
            $res = $stmt->get_result();
            $row = $res ? $res->fetch_assoc() : null;
            $stmt->close();
            if ($row) {
                return [
                    'source' => 'clinical_providers',
                    'id' => (int) $row['id'],
                    'email' => $email,
                ];
            }
        }

        $stmt = $conn->prepare('SELECT user_id FROM users WHERE email = ? LIMIT 1');
        if ($stmt) {
            $stmt->bind_param('s', $email);
            $stmt->execute();
            $res = $stmt->get_result();
            $row = $res ? $res->fetch_assoc() : null;
            $stmt->close();
            if ($row) {
                return [
                    'source' => 'users',
                    'id' => (int) $row['user_id'],
                    'email' => $email,
                ];
            }
        }
    }

    return ['source' => '', 'id' => $id, 'email' => $email];
}

function pcode_profile_response_user(array $row, string $source): array
{
    $id = $source === 'clinical_providers'
        ? (int) ($row['id'] ?? 0)
        : (int) ($row['user_id'] ?? 0);
    $name = (string) ($row['user_name'] ?? '');
    $avatar = trim((string) ($row['avatar'] ?? ''));
    if ($avatar === '') {
        $avatar = 'https://ui-avatars.com/api/?name=' . urlencode($name !== '' ? $name : 'User')
            . '&background=6B46C1&color=fff';
    }

    return [
        'id' => $id,
        'name' => $name,
        'email' => (string) ($row['email'] ?? ''),
        'role' => (string) ($row['role'] ?? ''),
        'institution' => (string) ($row['institution'] ?? ''),
        'avatar' => $avatar,
        'auth_source' => $source,
    ];
}

try {
    if (isGuestUser()) {
        sendResponse(false, 'Guest users cannot edit profiles. Please create an account.', null, 403);
    }

    $token = getAuthToken();
    if (!$token) {
        sendResponse(false, 'Not authenticated', null, 401);
    }

    $decoded = verifyJWT($token);
    if (!$decoded || (!isset($decoded['id']) && !isset($decoded['user_id']))) {
        sendResponse(false, 'Invalid or expired token', null, 401);
    }

    $resolved = pcode_profile_resolve_source($conn, $decoded);
    $source = $resolved['source'];
    $user_id = (int) $resolved['id'];

    if ($source === '' || $user_id <= 0) {
        sendResponse(false, 'User not found', null, 404);
    }

    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) {
        sendResponse(false, 'Invalid JSON payload', null, 400);
    }

    $name = isset($input['name']) ? trim($input['name']) : '';
    $institution = isset($input['institution']) ? trim($input['institution']) : '';
    $password = isset($input['password']) ? trim($input['password']) : '';

    if ($name === '' || strlen($name) < 2) {
        sendResponse(false, 'Name must be at least 2 characters', null, 400);
    }

    $fields = [];
    $types = '';
    $values = [];

    $fields[] = 'user_name = ?';
    $types .= 's';
    $values[] = $name;

    $fields[] = 'institution = ?';
    $types .= 's';
    $values[] = $institution;

    if ($password !== '') {
        if (!pcode_password_is_sha256_digest($password) && strlen($password) < 8) {
            sendResponse(false, 'Password must be at least 8 characters', null, 400);
        }
        $hashed_password = pcode_hash_password_for_storage($password);
        $fields[] = 'password = ?';
        $types .= 's';
        $values[] = $hashed_password;
    }

    $types .= 'i';
    $values[] = $user_id;

    if ($source === 'clinical_providers') {
        $sql = 'UPDATE clinical_providers SET ' . implode(', ', $fields) . ' WHERE id = ? LIMIT 1';
    } else {
        $sql = 'UPDATE users SET ' . implode(', ', $fields) . ' WHERE user_id = ? LIMIT 1';
    }

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendResponse(false, 'Database error', null, 500);
    }

    $stmt->bind_param($types, ...$values);
    if (!$stmt->execute()) {
        $stmt->close();
        sendResponse(false, 'Could not update profile', null, 500);
    }
    $stmt->close();

    if ($source === 'clinical_providers') {
        $stmt2 = $conn->prepare(
            'SELECT id, user_name, email, role, institution FROM clinical_providers WHERE id = ? LIMIT 1'
        );
    } else {
        $stmt2 = $conn->prepare(
            'SELECT user_id, user_name, email, role, institution FROM users WHERE user_id = ? LIMIT 1'
        );
    }

    if (!$stmt2) {
        sendResponse(false, 'Database error', null, 500);
    }

    $stmt2->bind_param('i', $user_id);
    $stmt2->execute();
    $res = $stmt2->get_result();
    $user = $res ? $res->fetch_assoc() : null;
    $stmt2->close();

    if (!$user) {
        sendResponse(false, 'User not found', null, 404);
    }

    sendResponse(true, 'Profile updated', [
        'user' => pcode_profile_response_user($user, $source),
    ], 200);
} catch (Exception $e) {
    sendResponse(false, $e->getMessage(), null, 400);
}
