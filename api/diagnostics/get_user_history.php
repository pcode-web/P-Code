<?php
/**
 * GET api/diagnostics/get_user_history.php
 *
 * Chronological self-screening history for the authenticated Regular User.
 * Mirrors OB-GYN get_patient_history.php, scoped to user_diagnosis_results.
 */
header('Content-Type: application/json');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../auth_helpers.php';
require_once __DIR__ . '/../diagnosis_history_helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

try {
    if (isGuestUser()) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Guest users cannot access screening history. Sign in to save and view your runs.']);
        exit;
    }

    $decoded = requireRegularUser();
    $userId = requireUserId($decoded);
    if ($userId <= 0) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Invalid user session']);
        exit;
    }

    $mysqli = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if ($mysqli->connect_error) {
        throw new Exception('Database connection failed');
    }
    pcode_diagnosis_history_ensure_columns($mysqli);

    $historyStmt = $mysqli->prepare('
        SELECT
            diagnosis_id,
            screening_id,
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
        WHERE user_id = ?
        ORDER BY created_at DESC, diagnosis_id DESC
    ');
    if (!$historyStmt) {
        // Tables may not exist yet in a fresh install
        $mysqli->close();
        echo json_encode([
            'success' => true,
            'user_id' => $userId,
            'threshold' => PCODE_DIAGNOSIS_THRESHOLD,
            'is_baseline' => true,
            'message' => 'No screening history yet. Complete a Detect run and tap Save Record to start your timeline.',
            'count' => 0,
            'history' => [],
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $historyStmt->bind_param('i', $userId);
    $historyStmt->execute();
    $rows = $historyStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $historyStmt->close();

    $entries = [];
    foreach ($rows as $row) {
        $row['created_by'] = $row['created_by'] ?? 'Patient';
        // Prefer frozen snapshot; only fall back to the ledger row for THIS screening_id.
        // Never use "latest draft for user" — that made every run look identical and broke compare.
        if (pcode_clinical_snapshot_is_empty($row['clinical_inputs_snapshot'] ?? null)
            && !empty($row['screening_id'])) {
            $paramRow = pcode_fetch_user_parameters_by_screening(
                $mysqli,
                $userId,
                (string) $row['screening_id']
            );
            if ($paramRow) {
                $row['parameter_row'] = $paramRow;
                if (!empty($paramRow['Ultrasound_image'])) {
                    $row['ultrasound_image'] = $paramRow['Ultrasound_image'];
                }
            }
        }
        $entries[] = pcode_normalize_history_row($row, 'user_diagnosis_results');
    }

    $mysqli->close();

    $count = count($entries);
    echo json_encode([
        'success' => true,
        'user_id' => $userId,
        'threshold' => PCODE_DIAGNOSIS_THRESHOLD,
        'is_baseline' => $count === 0,
        'message' => $count === 0
            ? 'No screening history yet. Complete a Detect run and tap Save Record to start your timeline.'
            : 'Screening history loaded successfully',
        'count' => $count,
        'history' => $entries,
    ], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Failed to load screening history',
        'error' => PCODE_DEBUG ? $e->getMessage() : null,
    ]);
}
