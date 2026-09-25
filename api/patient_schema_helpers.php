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

function pcode_column_exists(mysqli $conn, string $table, string $column): bool
{
    $safeTable = $conn->real_escape_string($table);
    $safeColumn = $conn->real_escape_string($column);
    $result = $conn->query("SHOW COLUMNS FROM `{$safeTable}` LIKE '{$safeColumn}'");
    return (bool) ($result && $result->num_rows > 0);
}

function pcode_ensure_patient_address_columns(mysqli $conn): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $hasBarangay = pcode_column_exists($conn, 'patient_personal_info', 'address_barangay');
    $hasTown = pcode_column_exists($conn, 'patient_personal_info', 'address_town');
    if (!$hasBarangay && $hasTown) {
        $conn->query(
            'ALTER TABLE patient_personal_info CHANGE COLUMN `address_town` `address_barangay` VARCHAR(128) DEFAULT NULL'
        );
        $hasBarangay = pcode_column_exists($conn, 'patient_personal_info', 'address_barangay');
        $hasTown = pcode_column_exists($conn, 'patient_personal_info', 'address_town');
    }
    $columns = [
        'address_street' => 'VARCHAR(255) DEFAULT NULL',
        'address_barangay' => 'VARCHAR(128) DEFAULT NULL',
        'address_municipality' => 'VARCHAR(128) DEFAULT NULL',
        'address_city' => 'VARCHAR(128) DEFAULT NULL',
        'address_province' => 'VARCHAR(128) DEFAULT NULL',
    ];
    foreach ($columns as $name => $definition) {
        if (pcode_column_exists($conn, 'patient_personal_info', $name)) {
            continue;
        }
        $conn->query(
            "ALTER TABLE patient_personal_info ADD COLUMN `{$name}` {$definition}"
        );
    }
    $hasBarangay = pcode_column_exists($conn, 'patient_personal_info', 'address_barangay');
    $hasTown = pcode_column_exists($conn, 'patient_personal_info', 'address_town');
    if ($hasBarangay && $hasTown) {
        $conn->query(
            'UPDATE patient_personal_info
             SET address_barangay = address_town
             WHERE (address_barangay IS NULL OR address_barangay = \'\')
               AND address_town IS NOT NULL AND address_town <> \'\''
        );
        $conn->query('ALTER TABLE patient_personal_info DROP COLUMN `address_town`');
    }
    $done = true;
}

function pcode_ensure_patient_name_columns(mysqli $conn): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $columns = [
        'first_name' => 'VARCHAR(128) DEFAULT NULL',
        'middle_name' => 'VARCHAR(128) DEFAULT NULL',
        'surname' => 'VARCHAR(128) DEFAULT NULL',
    ];
    foreach ($columns as $name => $definition) {
        $safeName = $conn->real_escape_string($name);
        $result = $conn->query("SHOW COLUMNS FROM patient_personal_info LIKE '{$safeName}'");
        if ($result && $result->num_rows === 0) {
            $conn->query(
                "ALTER TABLE patient_personal_info ADD COLUMN `{$name}` {$definition}"
            );
        }
    }
    $done = true;
}

function pcode_compose_patient_name(
    ?string $first,
    ?string $middle,
    ?string $surname
): string {
    $parts = [];
    foreach ([$first, $middle, $surname] as $part) {
        $part = trim((string) ($part ?? ''));
        if ($part !== '') {
            $parts[] = $part;
        }
    }
    return implode(' ', $parts);
}

/** @return array{0: string, 1: string, 2: string} */
function pcode_split_legacy_patient_name(?string $legacy): array
{
    $text = trim((string) ($legacy ?? ''));
    $text = preg_replace('/^(?:PMOS|PCOS)-\d+\s*[:\-–]\s*/i', '', $text) ?? $text;
    $text = trim($text);
    $parts = preg_split('/\s+/', $text, -1, PREG_SPLIT_NO_EMPTY);
    if (!$parts) {
        return ['', '', ''];
    }
    if (count($parts) === 1) {
        return [$parts[0], '', ''];
    }
    if (count($parts) === 2) {
        return [$parts[0], '', $parts[1]];
    }
    $first = array_shift($parts);
    $surname = array_pop($parts);
    return [$first, implode(' ', $parts), $surname];
}

/** @param array<string, mixed> $data */
function pcode_patient_name_from_payload(array $data): array
{
    $first = trim((string) ($data['first_name'] ?? $data['first'] ?? ''));
    $middle = trim((string) ($data['middle_name'] ?? $data['middle'] ?? ''));
    $surname = trim((string) ($data['surname'] ?? $data['last_name'] ?? $data['last'] ?? ''));
    $legacy = trim((string) ($data['patient_name'] ?? $data['name'] ?? ''));
    if (preg_match('/(?:PMOS|PCOS)-\d+/i', $legacy)) {
        $legacy = '';
    }
    if ($first === '' && $middle === '' && $surname === '' && $legacy !== '') {
        [$first, $middle, $surname] = pcode_split_legacy_patient_name($legacy);
    }
    $composed = pcode_compose_patient_name($first, $middle, $surname);
    if ($composed === '' && $legacy !== '') {
        $composed = $legacy;
    }
    return [
        'first_name' => $first !== '' ? $first : null,
        'middle_name' => $middle !== '' ? $middle : null,
        'surname' => $surname !== '' ? $surname : null,
        'patient_name' => $composed !== '' ? $composed : null,
        'name' => $composed !== '' ? $composed : null,
    ];
}

/** @param array<string, mixed> $row */
function pcode_patient_name_response(array $row): array
{
    $first = $row['first_name'] ?? null;
    $middle = $row['middle_name'] ?? null;
    $surname = $row['surname'] ?? ($row['last_name'] ?? null);
    $legacy = $row['patient_name'] ?? ($row['name'] ?? null);
    $firstStr = trim((string) ($first ?? ''));
    $middleStr = trim((string) ($middle ?? ''));
    $surnameStr = trim((string) ($surname ?? ''));
    if ($firstStr === '' && $middleStr === '' && $surnameStr === '' && $legacy) {
        [$first, $middle, $surname] = pcode_split_legacy_patient_name((string) $legacy);
        $firstStr = trim((string) ($first ?? ''));
        $middleStr = trim((string) ($middle ?? ''));
        $surnameStr = trim((string) ($surname ?? ''));
    }
    $composed = pcode_compose_patient_name($firstStr, $middleStr, $surnameStr);
    if ($composed === '' && $legacy) {
        $composed = (string) $legacy;
    }
    return [
        'first_name' => $firstStr !== '' ? $first : null,
        'middle_name' => $middleStr !== '' ? $middle : null,
        'surname' => $surnameStr !== '' ? $surname : null,
        'patient_name' => $composed !== '' ? $composed : $legacy,
        'name' => $composed !== '' ? $composed : $legacy,
    ];
}

function pcode_compose_patient_address(
    ?string $street,
    ?string $barangay,
    ?string $municipality,
    ?string $city,
    ?string $province = null
): string {
    $parts = [];
    foreach ([$street, $barangay, $municipality, $city, $province] as $part) {
        $part = trim((string) ($part ?? ''));
        if ($part !== '') {
            $parts[] = $part;
        }
    }
    return implode(', ', $parts);
}

function pcode_pick_address_barangay(array $data): string
{
    foreach (['address_barangay', 'barangay', 'address_town', 'town'] as $key) {
        $value = trim((string) ($data[$key] ?? ''));
        if ($value !== '') {
            return $value;
        }
    }
    return '';
}

/** @param array<string, mixed> $data */
function pcode_patient_address_from_payload(array $data): array
{
    $street = trim((string) ($data['address_street'] ?? $data['street'] ?? ''));
    $barangay = pcode_pick_address_barangay($data);
    $municipality = trim((string) ($data['address_municipality'] ?? $data['municipality'] ?? ''));
    $city = trim((string) ($data['address_city'] ?? $data['city'] ?? ''));
    $province = trim((string) ($data['address_province'] ?? $data['province'] ?? ''));
    $legacy = trim((string) ($data['address'] ?? ''));
    if ($street === '' && $barangay === '' && $municipality === '' && $city === '' && $province === '' && $legacy !== '') {
        $street = $legacy;
    }
    $composed = pcode_compose_patient_address($street, $barangay, $municipality, $city, $province);
    if ($composed === '' && $legacy !== '') {
        $composed = $legacy;
    }
    $barangayOrNull = $barangay !== '' ? $barangay : null;
    return [
        'address_street' => $street !== '' ? $street : null,
        'address_barangay' => $barangayOrNull,
        'address_town' => $barangayOrNull,
        'address_municipality' => $municipality !== '' ? $municipality : null,
        'address_city' => $city !== '' ? $city : null,
        'address_province' => $province !== '' ? $province : null,
        'address' => $composed !== '' ? $composed : null,
    ];
}

/** @param array<string, mixed> $row */
function pcode_patient_address_response(array $row): array
{
    $street = $row['address_street'] ?? null;
    $barangay = $row['address_barangay'] ?? ($row['address_town'] ?? null);
    $municipality = $row['address_municipality'] ?? null;
    $city = $row['address_city'] ?? null;
    $province = $row['address_province'] ?? null;
    $legacy = $row['address'] ?? null;
    if (!$street && !$barangay && !$municipality && !$city && !$province && $legacy) {
        $street = $legacy;
    }
    $composed = pcode_compose_patient_address(
        is_string($street) ? $street : (string) ($street ?? ''),
        is_string($barangay) ? $barangay : (string) ($barangay ?? ''),
        is_string($municipality) ? $municipality : (string) ($municipality ?? ''),
        is_string($city) ? $city : (string) ($city ?? ''),
        is_string($province) ? $province : (string) ($province ?? '')
    );
    if ($composed === '' && $legacy) {
        $composed = (string) $legacy;
    }
    return [
        'address_street' => $street,
        'address_barangay' => $barangay,
        'address_town' => $barangay,
        'address_municipality' => $municipality,
        'address_city' => $city,
        'address_province' => $province,
        'address' => $composed !== '' ? $composed : $legacy,
    ];
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
