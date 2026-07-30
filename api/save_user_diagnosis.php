<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);
ob_start();

header('Content-Type: application/json');
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/diagnosis_history_helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

function pcode_users_ensure_tables($conn) {
    // Ensure tables exist. Types are aligned via setup script (`setup_users_database.php`) using LIKE.
    @$conn->query("CREATE TABLE IF NOT EXISTS user_diagnosis_parameters (user_id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    @$conn->query("CREATE TABLE IF NOT EXISTS user_diagnosis_results (diagnosis_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL UNIQUE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // Ensure "latest-only" semantics per user by enforcing a UNIQUE/PRIMARY key on user_id.
    // (Older clones may have parameter_id as PK and allow multiple rows per user_id.)
    @$conn->query("ALTER TABLE user_diagnosis_parameters ADD UNIQUE KEY uq_user_id (user_id)");
    @$conn->query("ALTER TABLE user_diagnosis_results ADD UNIQUE KEY uq_results_user_id (user_id)");
}

try {
    $decoded = requireRegularUser();
    $user_id = requireUserId($decoded);

    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        http_response_code(400);
        @ob_end_clean();
        echo json_encode(['success' => false, 'message' => 'No valid JSON data provided']);
        exit;
    }

    $conn = pcode_users_db();
    pcode_users_ensure_tables($conn);
    pcode_diagnosis_history_ensure_columns($conn);

    // If older schema allowed duplicates, keep only the latest row per user_id.
    // This prevents creation of multiple parameter rows for the same Regular User.
    try {
        $stmt = $conn->prepare("
            DELETE FROM user_diagnosis_parameters
            WHERE user_id = ?
              AND parameter_id IS NOT NULL
              AND parameter_id <> (
                SELECT max_id FROM (
                  SELECT MAX(parameter_id) AS max_id
                  FROM user_diagnosis_parameters
                  WHERE user_id = ?
                ) t
              )
        ");
        if ($stmt) {
            $stmt->bind_param("ii", $user_id, $user_id);
            @$stmt->execute();
            $stmt->close();
        }
    } catch (Exception $_) {}

    // Map detect-form keys -> DB column names (same mapping style as save_patient.php)
    $map = [
        'age' => 'Age_yrs',
        'Pulse_rate' => 'Pulse_rate_bpm',
        'RR_breath' => 'RR_breath_min',
        'BP_systolic' => 'BP_Systolic_mmHg',
        'BP_diastolic' => 'BP_Diastolic_mmHg',
        'Hemoglobin' => 'Hb_g_dl',
        'Cycle_R_I' => 'CycleR_I',
        'Cycle_length' => 'Cycle_length_days',
        'Marriage_duration' => 'Marriage_Status_years',
        'Pregnant_status' => 'Pregnant',
        'No_abortions' => 'No_of_abortions',
        'I_Beta_HCG' => 'I_beta_HCG_mIU_mL',
        'II_Beta_HCG' => 'II_beta_HCG_mIU_mL',
        'LH_level' => 'LH_mIU_mL',
        'FSH_level' => 'FSH_mIU_mL',
        'AMH_level' => 'AMH_ng_mL',
        'PRL_level' => 'PRL_ng_mL',
        'TSH_level' => 'TSH_mIU_L',
        'Vitamin_D3_level' => 'Vit_D3_ng_mL',
        'Progesterone_level' => 'PRG_ng_mL',
        'RBS' => 'RBS_mg_dl',
        'Avg_F_size_L' => 'Avg_F_size_L_mm',
        'Avg_F_size_R' => 'Avg_F_size_R_mm',
    ];

    $clinical = $data['clinical_inputs'] ?? [];
    if (!is_array($clinical)) $clinical = [];

    $params = [];
    foreach ($clinical as $k => $v) {
        $dbKey = $map[$k] ?? $k;
        $params[$dbKey] = $v;
    }

    // Ultrasound image comes separately from detect.
    // Only modify DB on Save:
    // - if clear_ultrasound_image=true -> set NULL (explicit clear)
    // - else if ultrasound_image is a string -> store decoded bytes (BLOB like patient table)
    if (isset($data['clear_ultrasound_image']) && $data['clear_ultrasound_image'] === true) {
        $params['Ultrasound_image'] = null;
    } else if (array_key_exists('ultrasound_image', $data) && is_string($data['ultrasound_image'])) {
        $img = trim($data['ultrasound_image']);
        if ($img !== '') {
            // Strip data URI prefix if present
            if (strpos($img, 'data:') === 0) {
                $comma = strpos($img, ',');
                if ($comma !== false) {
                    $img = substr($img, $comma + 1);
                }
            }
            // Remove whitespace/newlines
            $img = preg_replace('/\s+/', '', $img);
            $bytes = base64_decode($img, true);
            $params['Ultrasound_image'] = ($bytes !== false) ? $bytes : null;
        }
    }

    // Upsert parameters (explicit column list)
    $allowedCols = [
        'Age_yrs','Weight_kg','Height_cm','BMI','Blood_Group','Pulse_rate_bpm','RR_breath_min',
        'BP_Systolic_mmHg','BP_Diastolic_mmHg','Hb_g_dl','CycleR_I','Cycle_length_days','Marriage_Status_years',
        'Pregnant','No_of_abortions','I_beta_HCG_mIU_mL','II_beta_HCG_mIU_mL','FSH_mIU_mL','LH_mIU_mL','FSH_LH',
        'Hip_inch','Waist_inch','Waist_hip_ratio','TSH_mIU_L','AMH_ng_mL','PRL_ng_mL','Vit_D3_ng_mL','PRG_ng_mL',
        'RBS_mg_dl','Weight_gain','Hair_growth','Skin_darkening','Hair_loss','Pimples','Fast_food','Reg_Exercise',
        'Follicle_no_L','Follicle_no_R','Avg_F_size_L_mm','Avg_F_size_R_mm','Endometrium_mm','Ultrasound_image'
    ];

    $setParts = [];
    $types = '';
    $values = [];

    foreach ($allowedCols as $col) {
        if (!array_key_exists($col, $params)) continue;
        $setParts[] = "$col = ?";
        $values[] = $params[$col];
        $types .= 's';
    }

    if (count($setParts) > 0) {
        // Use INSERT ... ON DUPLICATE KEY UPDATE so we always have a row per user
        $insertCols = array_merge(['user_id'], array_map(fn($s) => trim(explode('=', $s)[0]), $setParts));
        $placeholders = array_merge(['?'], array_fill(0, count($setParts), '?'));

        $sql = "INSERT INTO user_diagnosis_parameters (" . implode(',', $insertCols) . ")
                VALUES (" . implode(',', $placeholders) . ")
                ON DUPLICATE KEY UPDATE " . implode(',', $setParts);

        $stmt = $conn->prepare($sql);
        if (!$stmt) throw new Exception("Prepare failed: " . $conn->error);

        $bindTypes = 'i' . $types;
        $bindValues = array_merge([$user_id], $values, $values);
        // For UPDATE portion we need values again
        $bindTypes .= $types;

        $stmt->bind_param($bindTypes, ...$bindValues);
        if (!$stmt->execute()) throw new Exception("Execute failed: " . $stmt->error);
        $stmt->close();
    } else {
        // Ensure row exists
        $stmt = $conn->prepare("INSERT IGNORE INTO user_diagnosis_parameters (user_id) VALUES (?)");
        $stmt->bind_param("i", $user_id);
        $stmt->execute();
        $stmt->close();
    }

    // Upsert results
    $res = $data['results'] ?? [];
    if (!is_array($res)) $res = [];

    $xg_d = isset($res['xgboost_diagnosis']) ? (int)$res['xgboost_diagnosis'] : null;
    $xg_p = isset($res['xgboost_probability']) ? (float)$res['xgboost_probability'] : null;
    $cnn_d = isset($res['cnn_diagnosis']) ? (int)$res['cnn_diagnosis'] : null;
    $cnn_p = isset($res['cnn_probability']) ? (float)$res['cnn_probability'] : null;
    $ov_d = isset($res['overall_diagnosis']) ? (int)$res['overall_diagnosis'] : null;
    $ov_p = isset($res['overall_probability']) ? (float)$res['overall_probability'] : null;

    $normPercent = static function ($v) {
        if ($v === null) return null;
        $n = (float) $v;
        if (!is_finite($n)) return null;
        if ($n >= 0.0 && $n <= 1.0) return $n * 100.0;
        return $n;
    };
    if ($xg_p !== null) $xg_p = $normPercent($xg_p);
    if ($cnn_p !== null) $cnn_p = $normPercent($cnn_p);
    if ($ov_p !== null) $ov_p = $normPercent($ov_p);

    $clinical_snapshot = pcode_encode_clinical_snapshot($clinical);
    $created_by = 'Patient';
    $screening_id = pcode_generate_screening_id();

    // Append a new self-screening history row (never overwrite prior runs).
    $stmt = $conn->prepare("
        INSERT INTO user_diagnosis_results
            (user_id, screening_id, XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
             CNN_diagnosis, CNN_diagnosis_probability_percentage,
             Overall_diagnosis, Overall_diagnosis_probability_percentage,
             created_by, clinical_inputs_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ");
    if (!$stmt) throw new Exception("Prepare failed: " . $conn->error);

    $stmt->bind_param(
        "isidididss",
        $user_id,
        $screening_id,
        $xg_d,
        $xg_p,
        $cnn_d,
        $cnn_p,
        $ov_d,
        $ov_p,
        $created_by,
        $clinical_snapshot
    );
    if (!$stmt->execute()) throw new Exception("Execute failed: " . $stmt->error);
    $user_diagnosis_id = $conn->insert_id;
    $stmt->close();

    $conn->close();

    @ob_end_clean();
    echo json_encode([
        'success' => true,
        'message' => 'User diagnosis saved',
        'diagnosis_id' => $user_diagnosis_id,
        'screening_id' => $screening_id,
    ]);
} catch (Exception $e) {
    http_response_code(500);
    @ob_end_clean();
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}

