<?php
/**
 * GET api/patients/get_patients_list.php
 *
 * Master patient dashboard grid — one row per patient with LATEST diagnostic run only.
 */
header('Content-Type: application/json');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../auth_helpers.php';
require_once __DIR__ . '/../diagnosis_history_helpers.php';
require_once __DIR__ . '/../patient_schema_helpers.php';

pcode_session_start();

try {
    if (isGuestUser()) {
        $samplePatients = getGuestSamplePatients();
        echo json_encode([
            'success' => true,
            'data' => $samplePatients,
            'count' => count($samplePatients),
            'message' => 'Sample data for guest user',
        ]);
        exit;
    }

    requireProvider();

    $conn = pcode_mysqli();

    pcode_diagnosis_history_ensure_columns($conn);
    pcode_ensure_clinical_recommendations_column($conn);
    pcode_ensure_owner_provider_id_column($conn);
    pcode_backfill_unscoped_patients_to_first_provider($conn);

    $providerId = 0;
    if (session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['provider_id'])) {
        $providerId = (int) $_SESSION['provider_id'];
    }
    if ($providerId <= 0) {
        $decoded = requireAuthDecoded();
        $providerId = pcode_current_provider_id_from_auth($decoded);
    }

  /**
   * Latest physician-administered result per patient (correlated subquery).
   * Strictly scoped to the signed-in provider's records.
   */
    $sql = "
        SELECT
            p.patient_id,
            p.patient_name,
            p.age,
            p.date_of_birth,
            p.contact_no,
            p.civil_status,
            p.address,
            p.occupation,
            p.religion,
            p.reffered_by AS referred_by,
            p.clinical_recommendations,
            p.linked_user_id,
            p.owner_provider_id,
            DATE_FORMAT(p.date_added, '%Y-%m-%d') AS date_added,
            r.diagnosis_id,
            r.screening_id,
            r.XGBoost_diagnosis,
            r.XGBoost_diagnosis_probability_percentage,
            r.CNN_diagnosis,
            r.CNN_diagnosis_probability_percentage,
            r.Overall_diagnosis,
            r.Overall_diagnosis_probability_percentage,
            r.created_by AS result_created_by,
            r.created_at AS last_screened_at
        FROM patient_personal_info p
        LEFT JOIN patient_diagnosis_results r
            ON r.patient_id = p.patient_id
           AND r.diagnosis_id = (
                SELECT r2.diagnosis_id
                FROM patient_diagnosis_results r2
                WHERE r2.patient_id = p.patient_id
                ORDER BY r2.created_at DESC, r2.diagnosis_id DESC
                LIMIT 1
           )
    ";

    if ($providerId > 0) {
        $sql .= ' WHERE p.owner_provider_id = ' . (int) $providerId;
    } else {
        $sql .= ' WHERE 1 = 0';
    }

    $sql .= ' ORDER BY COALESCE(r.created_at, p.date_added) DESC, p.patient_id DESC';

    $result = $conn->query($sql);
    if (!$result) {
        throw new Exception('Patient list query failed: ' . $conn->error);
    }

    $patients = [];

    while ($row = $result->fetch_assoc()) {
        $pid = (int) $row['patient_id'];
        $linkedUserId = isset($row['linked_user_id']) ? (int) $row['linked_user_id'] : 0;

        // Draft parameters for modal editing (non-ledger row).
        $params = [];
        $paramsStmt = $conn->prepare(
            'SELECT * FROM patient_diagnosis_parameters
             WHERE patient_id = ? AND (screening_id IS NULL OR screening_id = \'\')
             ORDER BY parameter_id DESC LIMIT 1'
        );
        if ($paramsStmt) {
            $paramsStmt->bind_param('i', $pid);
            if ($paramsStmt->execute()) {
                $paramsRow = $paramsStmt->get_result()->fetch_assoc();
                $params = $paramsRow ?: [];
            }
            $paramsStmt->close();
        }

        $latestHistory = pcode_fetch_latest_unified_history($conn, $pid, $linkedUserId);
        $historyRunCount = pcode_count_unified_history_runs($conn, $pid, $linkedUserId);

        $diagnosis = $row;
        if ($latestHistory) {
            $useUnified = !$row['last_screened_at']
                || strcmp($latestHistory['created_at'], $row['last_screened_at']) > 0;
            if ($useUnified) {
                $diagnosis = array_merge($row, [
                    'XGBoost_diagnosis' => $latestHistory['xgboost_diagnosis'],
                    'XGBoost_diagnosis_probability_percentage' => $latestHistory['xgboost_probability_percent'],
                    'CNN_diagnosis' => $latestHistory['cnn_diagnosis'],
                    'CNN_diagnosis_probability_percentage' => $latestHistory['cnn_probability_percent'],
                    'Overall_diagnosis' => $latestHistory['overall_diagnosis'],
                    'Overall_diagnosis_probability_percentage' => $latestHistory['confidence_percent'],
                    'last_screened_at' => $latestHistory['created_at'],
                    'result_created_by' => $latestHistory['created_by'] === 'Patient' ? 'Patient' : 'Physician',
                ]);
            }
        }

        $xgLabel = pcode_get_diagnosis_label($diagnosis['XGBoost_diagnosis'] ?? null);
        $cnnLabel = pcode_get_diagnosis_label($diagnosis['CNN_diagnosis'] ?? null);
        $overallLabel = pcode_get_diagnosis_label($diagnosis['Overall_diagnosis'] ?? null);
        if ($overallLabel === 'pending' && ($xgLabel !== 'pending' || $cnnLabel !== 'pending')) {
            $overallLabel = $xgLabel !== 'pending' ? $xgLabel : $cnnLabel;
        }

        $lastScreenedAt = $diagnosis['last_screened_at'] ?? null;
        $lastTestedDisplay = $lastScreenedAt
            ? date('M j, Y · g:i A', strtotime($lastScreenedAt))
            : null;

        $pcosId = 'PMOS-' . str_pad((string) $pid, 3, '0', STR_PAD_LEFT);

        $formatted = [
            'id' => $pcosId,
            'patient_id' => $pid,
            'name' => $row['patient_name'],
            'age' => (int) ($row['age'] ?? 0),
            'date_added' => $row['date_added'],
            'address' => $row['address'] ?? null,
            'contact_no' => $row['contact_no'] ?? null,
            'DOB' => $row['date_of_birth'] ?? null,
            'civil_status' => $row['civil_status'] ?? null,
            'occupation' => $row['occupation'] ?? null,
            'religion' => $row['religion'] ?? null,
            'referred_by' => $row['referred_by'] ?? null,
            'clinical_recommendations' => $row['clinical_recommendations'] ?? null,
            'clinical_score_percentage' => isset($diagnosis['XGBoost_diagnosis_probability_percentage'])
                ? pcode_norm_probability_percent((float) $diagnosis['XGBoost_diagnosis_probability_percentage'])
                : null,
            'imaging_score_percentage' => isset($diagnosis['CNN_diagnosis_probability_percentage'])
                ? pcode_norm_probability_percent((float) $diagnosis['CNN_diagnosis_probability_percentage'])
                : null,
            'overall_diagnosis_percentage' => isset($diagnosis['Overall_diagnosis_probability_percentage'])
                ? pcode_norm_probability_percent((float) $diagnosis['Overall_diagnosis_probability_percentage'])
                : null,
            'xgboost_diagnosis' => $xgLabel,
            'cnn_diagnosis' => $cnnLabel,
            'overall_diagnosis' => $overallLabel,
            'diagnosis_id' => isset($diagnosis['diagnosis_id']) ? (int) $diagnosis['diagnosis_id'] : null,
            'screening_id' => $diagnosis['screening_id'] ?? ($latestHistory['screening_id'] ?? null),
            'last_screened_at' => $lastScreenedAt,
            'last_tested_display' => $lastTestedDisplay,
            'latest_screening_at' => $lastScreenedAt,
            'latest_screening_display' => $lastTestedDisplay,
            'latest_screening_origin' => $latestHistory['origin_label'] ?? (
                ($diagnosis['result_created_by'] ?? '') === 'Patient' ? 'User App Self-Screening' : 'Clinician Upload'
            ),
            'latest_screening_origin_code' => $latestHistory['created_by'] ?? (
                ($diagnosis['result_created_by'] ?? '') === 'Patient' ? 'Patient' : 'Physician'
            ),
            'latest_screening_status' => $latestHistory['status_label'] ?? (
                $overallLabel === 'positive' ? 'Positive' : ($overallLabel === 'negative' ? 'Negative' : 'Pending')
            ),
            'latest_screening_status_code' => $latestHistory['status_code'] ?? $overallLabel,
            'history_run_count' => $historyRunCount,
        ];

        // Merge draft clinical parameters for patient modal population.
        $paramFields = [
            'Age_yrs', 'Weight_kg', 'Height_cm', 'BMI', 'Blood_Group', 'Pulse_rate_bpm', 'RR_breath_min',
            'Hb_g_dl', 'CycleR_I', 'Cycle_length_days', 'Marriage_Status_years', 'Pregnant', 'No_of_abortions',
            'I_beta_HCG_mIU_mL', 'II_beta_HCG_mIU_mL', 'FSH_mIU_mL', 'LH_mIU_mL', 'FSH_LH', 'Hip_inch',
            'Waist_inch', 'Waist_hip_ratio', 'TSH_mIU_L', 'AMH_ng_mL', 'PRL_ng_mL', 'Vit_D3_ng_mL',
            'PRG_ng_mL', 'RBS_mg_dl', 'Weight_gain', 'Hair_growth', 'Skin_darkening', 'Hair_loss',
            'Pimples', 'Fast_food', 'Reg_Exercise', 'BP_Systolic_mmHg', 'BP_Diastolic_mmHg',
            'Follicle_no_L', 'Follicle_no_R', 'Avg_F_size_L_mm', 'Avg_F_size_R_mm', 'Endometrium_mm',
            'Ultrasound_image',
        ];
        foreach ($paramFields as $field) {
            if (array_key_exists($field, $params)) {
                if ($field === 'Ultrasound_image' && !empty($params[$field])) {
                    $formatted[$field] = strpos($params[$field], 'data:image') === 0
                        ? $params[$field]
                        : 'data:image/jpeg;base64,' . base64_encode($params[$field]);
                } else {
                    $formatted[$field] = $params[$field];
                }
            }
        }

        $patients[] = $formatted;
    }

    $conn->close();

    echo json_encode([
        'success' => true,
        'data' => $patients,
        'count' => count($patients),
    ], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage(),
    ]);
}
