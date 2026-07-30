<?php
/**
 * GET api/diagnostics/get_patient_history.php?patient_id=123
 *
 * Full chronological diagnosis ledger with frozen parameter rows per screening_id.
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
        echo json_encode(['success' => false, 'message' => 'A valid patient_id query parameter is required']);
        exit;
    }

    $mysqli = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if ($mysqli->connect_error) {
        throw new Exception('Database connection failed');
    }
    pcode_diagnosis_history_ensure_columns($mysqli);
    $providerId = pcode_require_provider_owns_patient($mysqli, $patientId, $providerAuth);

    $patientStmt = $mysqli->prepare(
        'SELECT patient_id, patient_name, linked_user_id
         FROM patient_personal_info
         WHERE patient_id = ? AND owner_provider_id = ?
         LIMIT 1'
    );
    $patientStmt->bind_param('ii', $patientId, $providerId);
    $patientStmt->execute();
    $patient = $patientStmt->get_result()->fetch_assoc();
    $patientStmt->close();

    if (!$patient) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Patient not found']);
        $mysqli->close();
        exit;
    }

    $historyStmt = $mysqli->prepare('
        SELECT
            r.diagnosis_id,
            r.screening_id,
            r.patient_id,
            r.XGBoost_diagnosis,
            r.XGBoost_diagnosis_probability_percentage,
            r.CNN_diagnosis,
            r.CNN_diagnosis_probability_percentage,
            r.Overall_diagnosis,
            r.Overall_diagnosis_probability_percentage,
            r.created_by,
            r.created_at,
            r.clinical_inputs_snapshot,
            r.initiated_by_user_id,
            p.parameter_id,
            p.Age_yrs,
            p.Weight_kg,
            p.Height_cm,
            p.BMI,
            p.AMH_ng_mL,
            p.LH_mIU_mL,
            p.FSH_mIU_mL,
            p.FSH_LH,
            p.TSH_mIU_L,
            p.RBS_mg_dl,
            p.Follicle_no_L,
            p.Follicle_no_R,
            p.Avg_F_size_L_mm,
            p.Avg_F_size_R_mm,
            p.Endometrium_mm,
            p.ultrasound_modality,
            p.Ultrasound_image
        FROM patient_diagnosis_results r
        LEFT JOIN patient_diagnosis_parameters p
            ON p.screening_id = r.screening_id AND p.patient_id = r.patient_id
        WHERE r.patient_id = ?
        ORDER BY r.created_at DESC, r.diagnosis_id DESC
    ');
    $historyStmt->bind_param('i', $patientId);
    $historyStmt->execute();
    $patientRows = $historyStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $historyStmt->close();

    $entries = [];
    foreach ($patientRows as $row) {
        $parameterRow = [];
        foreach ($row as $key => $value) {
            if (in_array($key, ['parameter_id', 'Age_yrs', 'Weight_kg', 'Height_cm', 'BMI', 'AMH_ng_mL', 'LH_mIU_mL', 'FSH_mIU_mL', 'FSH_LH', 'TSH_mIU_L', 'RBS_mg_dl', 'Follicle_no_L', 'Follicle_no_R', 'Avg_F_size_L_mm', 'Avg_F_size_R_mm', 'Endometrium_mm', 'ultrasound_modality', 'Ultrasound_image'], true) && $value !== null) {
                $parameterRow[$key] = $value;
            }
        }
        if (!empty($parameterRow)) {
            $row['parameter_row'] = $parameterRow;
            $row['parameter_id'] = $parameterRow['parameter_id'] ?? null;
            if (!empty($parameterRow['Ultrasound_image'])) {
                $row['ultrasound_image'] = $parameterRow['Ultrasound_image'];
            }
        } elseif (!empty($row['screening_id'])) {
            $linked = pcode_fetch_parameters_by_screening($mysqli, (string) $row['screening_id']);
            if ($linked) {
                $row['parameter_row'] = $linked;
                $row['parameter_id'] = $linked['parameter_id'] ?? null;
                if (!empty($linked['Ultrasound_image'])) {
                    $row['ultrasound_image'] = $linked['Ultrasound_image'];
                }
            }
        } elseif (!empty($row['Ultrasound_image'])) {
            $row['ultrasound_image'] = $row['Ultrasound_image'];
        }
        $entries[] = pcode_normalize_history_row($row, 'patient_diagnosis_results');
    }

    $linkedUserId = isset($patient['linked_user_id']) ? (int) $patient['linked_user_id'] : 0;
    if ($linkedUserId > 0) {
        $selfStmt = $mysqli->prepare('
            SELECT diagnosis_id, screening_id, user_id, XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
                   CNN_diagnosis, CNN_diagnosis_probability_percentage, Overall_diagnosis,
                   Overall_diagnosis_probability_percentage, created_by, created_at, clinical_inputs_snapshot
            FROM user_diagnosis_results
            WHERE user_id = ?
            ORDER BY created_at DESC, diagnosis_id DESC
        ');
        $selfStmt->bind_param('i', $linkedUserId);
        $selfStmt->execute();
        $selfRows = $selfStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $selfStmt->close();

        foreach ($selfRows as $row) {
            $row['created_by'] = $row['created_by'] ?? 'Patient';
            $entries[] = pcode_normalize_history_row($row, 'user_diagnosis_results');
        }
    }

    usort($entries, static function ($a, $b) {
        return strcmp($b['created_at'], $a['created_at']);
    });

    $mysqli->close();

    echo json_encode([
        'success' => true,
        'patient_id' => $patientId,
        'patient_name' => $patient['patient_name'],
        'linked_user_id' => $linkedUserId > 0 ? $linkedUserId : null,
        'threshold' => PCODE_DIAGNOSIS_THRESHOLD,
        'is_baseline' => count($entries) === 0,
        'message' => count($entries) === 0
            ? 'No prior diagnostic runs recorded. Baseline history is ready for the first screening.'
            : 'Patient diagnosis history loaded successfully',
        'count' => count($entries),
        'history' => $entries,
    ], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Failed to load patient history',
        'error' => PCODE_DEBUG ? $e->getMessage() : null,
    ]);
}
