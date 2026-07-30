<?php
/**
 * Lazy schema helpers for patient_personal_info columns.
 */
declare(strict_types=1);

function pcode_ensure_clinical_recommendations_column(mysqli $conn): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $result = $conn->query("SHOW COLUMNS FROM patient_personal_info LIKE 'clinical_recommendations'");
    if ($result && $result->num_rows === 0) {
        $conn->query(
            'ALTER TABLE patient_personal_info ADD COLUMN clinical_recommendations TEXT NULL DEFAULT NULL'
        );
    }
    $done = true;
}

/**
 * Scopes clinical patient records to the provider who created them.
 * Unscoped legacy rows are assigned via pcode_backfill_unscoped_patients_to_first_provider().
 */
function pcode_ensure_owner_provider_id_column(mysqli $conn): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $result = $conn->query("SHOW COLUMNS FROM patient_personal_info LIKE 'owner_provider_id'");
    if ($result && $result->num_rows === 0) {
        $conn->query(
            'ALTER TABLE patient_personal_info
             ADD COLUMN owner_provider_id INT NULL DEFAULT NULL,
             ADD KEY idx_owner_provider_id (owner_provider_id)'
        );
    }
    $done = true;
}

/**
 * Look up whether $patientId is owned by $providerId.
 * Returns: 'ok' | 'not_found' | 'forbidden' | 'bad_request'
 */
function pcode_provider_patient_access(mysqli $conn, int $patientId, int $providerId): string
{
    pcode_ensure_owner_provider_id_column($conn);
    pcode_backfill_unscoped_patients_to_first_provider($conn);

    if ($patientId <= 0 || $providerId <= 0) {
        return 'bad_request';
    }

    $stmt = $conn->prepare(
        'SELECT owner_provider_id FROM patient_personal_info WHERE patient_id = ? LIMIT 1'
    );
    if (!$stmt) {
        return 'not_found';
    }
    $stmt->bind_param('i', $patientId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) {
        return 'not_found';
    }

    $ownerId = (int) ($row['owner_provider_id'] ?? 0);
    if ($ownerId <= 0 || $ownerId !== $providerId) {
        return 'forbidden';
    }

    return 'ok';
}

/**
 * Require that the authenticated provider owns this patient chart.
 * Exits with JSON 400/403/404 on failure. Returns the provider id on success.
 */
function pcode_require_provider_owns_patient(mysqli $conn, int $patientId, ?array $decoded = null): int
{
    $providerId = pcode_current_provider_id_from_auth($decoded);
    if ($providerId <= 0 && session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['provider_id'])) {
        $providerId = (int) $_SESSION['provider_id'];
    }

    $access = pcode_provider_patient_access($conn, $patientId, $providerId);
    if ($access === 'ok') {
        return $providerId;
    }

    if ($access === 'bad_request') {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Patient ID and provider session are required']);
        exit;
    }
    if ($access === 'forbidden') {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'You can only access patients in your own care']);
        exit;
    }

    http_response_code(404);
    echo json_encode(['success' => false, 'error' => 'Patient not found']);
    exit;
}

/**
 * One-time: assign legacy unscoped charts to the earliest clinical provider
 * so newly registered providers start with an empty dataset.
 */
function pcode_backfill_unscoped_patients_to_first_provider(mysqli $conn): void
{
    static $done = false;
    if ($done) {
        return;
    }
    pcode_ensure_owner_provider_id_column($conn);
    $check = $conn->query(
        'SELECT COUNT(*) AS c FROM patient_personal_info WHERE owner_provider_id IS NULL'
    );
    $row = $check ? $check->fetch_assoc() : null;
    if (!$row || (int) ($row['c'] ?? 0) === 0) {
        $done = true;
        return;
    }
    $first = $conn->query(
        'SELECT id FROM clinical_providers ORDER BY id ASC LIMIT 1'
    );
    $provider = $first ? $first->fetch_assoc() : null;
    $firstId = $provider ? (int) ($provider['id'] ?? 0) : 0;
    if ($firstId > 0) {
        $conn->query(
            'UPDATE patient_personal_info
             SET owner_provider_id = ' . $firstId . '
             WHERE owner_provider_id IS NULL'
        );
    }
    $done = true;
}

function pcode_current_provider_id_from_auth(?array $decoded): int
{
    if (is_array($decoded) && isset($decoded['id'])) {
        return (int) $decoded['id'];
    }
    if (session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['provider_id'])) {
        return (int) $_SESSION['provider_id'];
    }
    return 0;
}
