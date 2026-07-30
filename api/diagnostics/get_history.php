<?php
/**
 * GET api/diagnostics/get_history.php?patient_id=123
 *
 * Returns a unified chronological diagnosis history for an OB-GYN patient profile,
 * merging clinician-administered runs and linked Regular User self-screenings.
 */
header('Content-Type: application/json');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../auth_helpers.php';
require_once __DIR__ . '/../diagnosis_history_helpers.php';
require_once __DIR__ . '/../patient_schema_helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

try {
    if (isGuestUser()) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Guest users cannot access diagnosis history']);
        exit;
    }

    $providerAuth = requireProvider();

    $patientId = isset($_GET['patient_id']) ? (int) $_GET['patient_id'] : 0;
    if ($patientId <= 0) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'message' => 'A valid patient_id query parameter is required',
        ]);
        exit;
    }

    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );

    // Ensure schema extensions exist (idempotent for dev environments).
    $mysqli = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if ($mysqli->connect_error) {
        throw new Exception('Database connection failed');
    }
    pcode_diagnosis_history_ensure_columns($mysqli);
    $providerId = pcode_require_provider_owns_patient($mysqli, $patientId, $providerAuth);
    $mysqli->close();

    $patientStmt = $pdo->prepare('
        SELECT patient_id, patient_name, linked_user_id
        FROM patient_personal_info
        WHERE patient_id = :patient_id
          AND owner_provider_id = :owner_provider_id
        LIMIT 1
    ');
    $patientStmt->execute([
        'patient_id' => $patientId,
        'owner_provider_id' => $providerId,
    ]);
    $patient = $patientStmt->fetch();

    if (!$patient) {
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'message' => 'Patient not found',
        ]);
        exit;
    }

    $historyStmt = $pdo->prepare('
        SELECT
            diagnosis_id,
            patient_id,
            XGBoost_diagnosis,
            XGBoost_diagnosis_probability_percentage,
            CNN_diagnosis,
            CNN_diagnosis_probability_percentage,
            Overall_diagnosis,
            Overall_diagnosis_probability_percentage,
            created_by,
            created_at,
            clinical_inputs_snapshot,
            initiated_by_user_id
        FROM patient_diagnosis_results
        WHERE patient_id = :patient_id
        ORDER BY created_at DESC, diagnosis_id DESC
    ');
    $historyStmt->execute(['patient_id' => $patientId]);
    $patientRows = $historyStmt->fetchAll();

    $selfRows = [];
    $linkedUserId = isset($patient['linked_user_id']) ? (int) $patient['linked_user_id'] : 0;
    if ($linkedUserId > 0) {
        $selfStmt = $pdo->prepare('
            SELECT
                diagnosis_id,
                user_id,
                XGBoost_diagnosis,
                XGBoost_diagnosis_probability_percentage,
                CNN_diagnosis,
                CNN_diagnosis_probability_percentage,
                Overall_diagnosis,
                Overall_diagnosis_probability_percentage,
                created_by,
                created_at,
                clinical_inputs_snapshot
            FROM user_diagnosis_results
            WHERE user_id = :user_id
            ORDER BY created_at DESC, diagnosis_id DESC
        ');
        $selfStmt->execute(['user_id' => $linkedUserId]);
        $selfRows = $selfStmt->fetchAll();
    }

    $entries = [];
    foreach ($patientRows as $row) {
        $entries[] = pcode_normalize_history_row($row, 'patient_diagnosis_results');
    }
    foreach ($selfRows as $row) {
        $row['created_by'] = $row['created_by'] ?? 'Patient';
        $entries[] = pcode_normalize_history_row($row, 'user_diagnosis_results');
    }

    usort($entries, static function ($a, $b) {
        return strcmp($b['created_at'], $a['created_at']);
    });

    $isBaseline = count($entries) === 0;

    echo json_encode([
        'success' => true,
        'patient_id' => $patientId,
        'patient_name' => $patient['patient_name'],
        'linked_user_id' => $linkedUserId > 0 ? $linkedUserId : null,
        'threshold' => PCODE_DIAGNOSIS_THRESHOLD,
        'is_baseline' => $isBaseline,
        'message' => $isBaseline
            ? 'No prior diagnostic runs recorded. Baseline history is ready for the first screening.'
            : 'Diagnosis history loaded successfully',
        'count' => count($entries),
        'history' => $entries,
    ], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Failed to load diagnosis history',
        'error' => PCODE_DEBUG ? $e->getMessage() : null,
    ]);
}
