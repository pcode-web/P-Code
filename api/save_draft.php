<?php
header('Content-Type: application/json');
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth_helpers.php';

function ensure_form_drafts_table(mysqli $conn): void
{
    $sql = "
        CREATE TABLE IF NOT EXISTS form_drafts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            auth_source VARCHAR(32) NOT NULL DEFAULT 'users',
            draft_key VARCHAR(191) NOT NULL,
            form_type VARCHAR(64) NOT NULL DEFAULT '',
            entity_id VARCHAR(64) NOT NULL DEFAULT '',
            draft_json LONGTEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_user_draft (user_id, draft_key),
            KEY idx_user_updated (user_id, updated_at),
            KEY idx_form_drafts_auth (auth_source, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ";
    if (!$conn->query($sql)) {
        throw new Exception('Failed to ensure form_drafts table: ' . $conn->error);
    }

    $col = $conn->query("SHOW COLUMNS FROM form_drafts LIKE 'auth_source'");
    if ($col && $col->num_rows === 0) {
        $conn->query(
            "ALTER TABLE form_drafts
             ADD COLUMN auth_source VARCHAR(32) NOT NULL DEFAULT 'users' AFTER user_id"
        );
    }
}

function pcode_resolve_draft_auth_source(?array $decoded): string
{
    pcode_session_start();
    $sessionSource = strtolower(trim((string) ($_SESSION['auth_source'] ?? '')));
    if ($sessionSource === 'clinical_providers' || $sessionSource === 'users') {
        return $sessionSource;
    }
    if (!empty($_SESSION['provider_id'])) {
        return 'clinical_providers';
    }
    if (is_array($decoded)) {
        $role = strtolower(trim((string) ($decoded['role'] ?? '')));
        if ($role !== '' && $role !== 'regular user' && $role !== 'administrator' && $role !== 'admin' && $role !== 'guest') {
            return 'clinical_providers';
        }
    }
    return 'users';
}

try {
    if (isGuestUser()) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Guest drafts are stored locally only',
            'offline_only' => true,
        ]);
        exit;
    }

    $decoded = requireAuthDecoded();
    $userId = requireUserId($decoded);
    $authSource = pcode_resolve_draft_auth_source($decoded);

    $conn = pcode_users_db();
    ensure_form_drafts_table($conn);

    if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
        $data = json_decode(file_get_contents('php://input'), true) ?: [];
        $draftKey = trim((string) ($data['draft_key'] ?? ''));
        if ($draftKey === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'draft_key required']);
            exit;
        }
        $stmt = $conn->prepare(
            'DELETE FROM form_drafts WHERE user_id = ? AND draft_key = ? AND auth_source = ?'
        );
        $stmt->bind_param('iss', $userId, $draftKey, $authSource);
        $stmt->execute();
        $stmt->close();
        $conn->close();
        echo json_encode(['success' => true]);
        exit;
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'message' => 'Method not allowed']);
        exit;
    }

    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid JSON body']);
        exit;
    }

    $draftKey = trim((string) ($data['draft_key'] ?? ''));
    if ($draftKey === '' || strlen($draftKey) > 191) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid draft_key']);
        exit;
    }

    if (!str_starts_with($draftKey, 'pcode_draft_')) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'draft_key must use pcode_draft_ prefix']);
        exit;
    }

    $formType = substr((string) ($data['form_type'] ?? ''), 0, 64);
    $entityId = substr((string) ($data['entity_id'] ?? ''), 0, 64);
    $draftJson = $data['draft_json'] ?? null;
    if (!is_array($draftJson)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'draft_json must be an object']);
        exit;
    }

    $encoded = json_encode($draftJson);
    if ($encoded === false) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'draft_json could not be encoded']);
        exit;
    }

    if (strlen($encoded) > 4 * 1024 * 1024) {
        http_response_code(413);
        echo json_encode(['success' => false, 'message' => 'Draft payload too large']);
        exit;
    }

    // Upsert by (user_id, draft_key); also keep auth_source current
    $sql = "
        INSERT INTO form_drafts (user_id, auth_source, draft_key, form_type, entity_id, draft_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            auth_source = VALUES(auth_source),
            form_type = VALUES(form_type),
            entity_id = VALUES(entity_id),
            draft_json = VALUES(draft_json),
            updated_at = CURRENT_TIMESTAMP
    ";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        throw new Exception('Prepare failed: ' . $conn->error);
    }
    $stmt->bind_param('isssss', $userId, $authSource, $draftKey, $formType, $entityId, $encoded);
    if (!$stmt->execute()) {
        throw new Exception('Execute failed: ' . $stmt->error);
    }
    $stmt->close();
    $conn->close();

    echo json_encode([
        'success' => true,
        'draft_key' => $draftKey,
        'auth_source' => $authSource,
    ]);
} catch (Throwable $e) {
    pcode_log('save_draft error: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to save draft']);
}
