<?php
/**
 * XAI Insights Patient List API
 * Simplified endpoint specifically for XAI page with aggressive debugging
 */
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once 'config.php';
require_once __DIR__ . '/diagnosis_history_helpers.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/patient_schema_helpers.php';

$debug_log = [];
$debug_log[] = "=== XAI API START ===";
$debug_log[] = "Time: " . date('Y-m-d H:i:s');

try {
    // Check if user is guest - if so, return sample data
    if (isGuestUser()) {
        $debug_log[] = "Guest user detected, returning sample XAI data";
        $samplePatients = getGuestSamplePatients();
        
        // Add XAI explanation data to sample patients
        foreach ($samplePatients as &$patient) {
            $patient['xai_explanation'] = [
                'feature_importance' => [
                    'AMH_ng_mL' => 0.28,
                    'LH_mIU_mL' => 0.19,
                    'Follicle_no_L' => 0.15,
                    'FSH_LH' => 0.12,
                    'BMI' => 0.10,
                    'Waist_hip_ratio' => 0.08,
                    'Hair_growth' => 0.05,
                    'others' => 0.03
                ],
                'shap_values' => [
                    'positive_contributors' => ['AMH', 'LH', 'Hair_growth'],
                    'negative_contributors' => ['FSH', 'BMI'],
                    'neutral_contributors' => ['Age', 'Blood_Group']
                ]
            ];
        }
        
        echo json_encode([
            'success' => true,
            'data' => $samplePatients,
            'count' => count($samplePatients),
            'message' => 'Sample XAI data for guest user'
        ]);
        exit;
    }

    $decoded = requireAuthDecoded();
    $isProvider = isProviderRole($decoded);
    $isAdmin = isAdminRole($decoded);
    $isRegular = isRegularUserRole($decoded);
    if (!$isProvider && !$isAdmin && !$isRegular) {
        json_error_and_exit(403, 'Authorized clinical or patient access required');
    }
    
    // Connect to database
    $debug_log[] = "Attempting database connection to: " . DB_HOST . " / " . DB_NAME;
    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    
    if ($conn->connect_error) {
        $debug_log[] = "CONNECTION FAILED: " . $conn->connect_error;
        throw new Exception("Connection failed: " . $conn->connect_error);
    }
    
    $debug_log[] = "Database connection successful";
    
    // Check if tables exist
    $tables_query = "SELECT GROUP_CONCAT(TABLE_NAME) as tables FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '" . DB_NAME . "'";
    $tables_result = $conn->query($tables_query);
    if ($tables_result) {
        $row = $tables_result->fetch_assoc();
        $debug_log[] = "Tables in database: " . ($row['tables'] ?: 'NONE');
    }
    
    // Count patients in patient_personal_info
    $count_query = "SELECT COUNT(*) as count FROM patient_personal_info";
    $count_result = $conn->query($count_query);
    $count_row = $count_result->fetch_assoc();
    $patient_count = $count_row['count'] ?? 0;
    $debug_log[] = "Patients in patient_personal_info: " . $patient_count;
    
    if ($patient_count == 0) {
        $debug_log[] = "WARNING: No patients found in database";
        throw new Exception("No patients in database");
    }
    
    // Fetch patients with JOIN - ONLY patients with completed diagnosis results
    $debug_log[] = "Fetching patients with diagnosis data...";
    pcode_ensure_owner_provider_id_column($conn);
    if (function_exists('pcode_diagnosis_history_ensure_columns')) {
        pcode_diagnosis_history_ensure_columns($conn);
    }

    $whereExtra = '';
    $bindTypes = '';
    $bindValues = [];
    if ($isProvider && !$isAdmin) {
        $providerId = (int) ($decoded['id'] ?? 0);
        if ($providerId <= 0) {
            json_error_and_exit(401, 'Invalid provider identity');
        }
        // Own charts only (legacy NULL owner rows stay hidden from other providers)
        $whereExtra = ' AND p.owner_provider_id = ? ';
        $bindTypes = 'i';
        $bindValues[] = $providerId;
        $debug_log[] = "Scoped to owner_provider_id=$providerId";
    } elseif ($isRegular && !$isAdmin) {
        $userId = (int) ($decoded['id'] ?? 0);
        if ($userId <= 0) {
            json_error_and_exit(401, 'Invalid user identity');
        }
        $whereExtra = ' AND p.linked_user_id = ? ';
        $bindTypes = 'i';
        $bindValues[] = $userId;
        $debug_log[] = "Scoped to linked_user_id=$userId";
    }
    
    $query = "
        SELECT 
            p.patient_id,
            p.patient_name,
            p.age,
            DATE_FORMAT(p.date_added, '%Y-%m-%d') as date_added,
            c.AMH_ng_mL,
            c.LH_mIU_mL,
            c.FSH_mIU_mL,
            c.FSH_LH,
            c.BMI,
            c.Cycle_length_days,
            c.Follicle_no_L,
            c.Follicle_no_R,
            c.Weight_gain,
            c.Hair_growth,
            c.Skin_darkening,
            c.Hair_loss,
            c.Pimples,
            c.Ultrasound_image,
            d.XGBoost_diagnosis,
            d.XGBoost_diagnosis_probability_percentage,
            d.CNN_diagnosis,
            d.CNN_diagnosis_probability_percentage,
            d.Overall_diagnosis,
            d.Overall_diagnosis_probability_percentage
        FROM patient_personal_info p
        LEFT JOIN patient_diagnosis_parameters c ON p.patient_id = c.patient_id
        INNER JOIN patient_diagnosis_results d ON p.patient_id = d.patient_id 
            AND d.diagnosis_id = (
                SELECT MAX(diagnosis_id) FROM patient_diagnosis_results 
                WHERE patient_id = p.patient_id
            )
        WHERE (d.Overall_diagnosis IS NOT NULL OR d.CNN_diagnosis IS NOT NULL OR d.XGBoost_diagnosis IS NOT NULL)
        {$whereExtra}
        ORDER BY p.date_added DESC
        LIMIT 100
    ";
    
    if ($bindTypes !== '') {
        $stmt = $conn->prepare($query);
        if (!$stmt) {
            throw new Exception('Query prepare failed: ' . $conn->error);
        }
        $stmt->bind_param($bindTypes, ...$bindValues);
        if (!$stmt->execute()) {
            throw new Exception('Query failed: ' . $stmt->error);
        }
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($query);
    }
    
    if (!$result) {
        $debug_log[] = "QUERY ERROR: " . $conn->error;
        throw new Exception("Query failed: " . $conn->error);
    }
    
    $debug_log[] = "Query returned " . $result->num_rows . " rows";
    
    $patients = [];
    
    function getDiagnosisLabel($code) {
        if ($code === null || $code === '') return 'pending';
        $code = (int)$code;
        $map = [0 => 'negative', 1 => 'positive', 2 => 'borderline'];
        return $map[$code] ?? 'pending';
    }
    
    while ($row = $result->fetch_assoc()) {
        $pcos_id = 'PMOS-' . str_pad($row['patient_id'], 3, '0', STR_PAD_LEFT);
        
        $xgb_diagnosis = getDiagnosisLabel($row['XGBoost_diagnosis']);
        $cnn_diagnosis = getDiagnosisLabel($row['CNN_diagnosis']);
        $overall_diagnosis = getDiagnosisLabel($row['Overall_diagnosis']);

        // If "overall" wasn't persisted, fall back to whichever model ran.
        if ($overall_diagnosis === 'pending') {
            if ($cnn_diagnosis !== 'pending') {
                $overall_diagnosis = $cnn_diagnosis;
            } elseif ($xgb_diagnosis !== 'pending') {
                $overall_diagnosis = $xgb_diagnosis;
            }
        }
        
        $patients[] = [
            'id' => $pcos_id,
            'name' => $row['patient_name'],
            'patient_id' => (int)$row['patient_id'],
            'age' => (int)($row['age'] ?? 0),
            'date_added' => $row['date_added'],
            'clinical_score_percentage' => $row['XGBoost_diagnosis_probability_percentage'] !== null
                ? pcode_norm_probability_percent($row['XGBoost_diagnosis_probability_percentage'])
                : 0,
            'imaging_score_percentage' => $row['CNN_diagnosis_probability_percentage'] !== null
                ? pcode_norm_probability_percent($row['CNN_diagnosis_probability_percentage'])
                : 0,
            'overall_diagnosis_percentage' => $row['Overall_diagnosis_probability_percentage'] !== null
                ? pcode_norm_probability_percent($row['Overall_diagnosis_probability_percentage'])
                : (($row['CNN_diagnosis_probability_percentage'] !== null)
                    ? pcode_norm_probability_percent($row['CNN_diagnosis_probability_percentage'])
                    : (($row['XGBoost_diagnosis_probability_percentage'] !== null)
                        ? pcode_norm_probability_percent($row['XGBoost_diagnosis_probability_percentage'])
                        : 0)),
            'xgboost_diagnosis' => $xgb_diagnosis,
            'cnn_diagnosis' => $cnn_diagnosis,
            'overall_diagnosis' => $overall_diagnosis,
            'AMH_ng_mL' => $row['AMH_ng_mL'] !== null ? (float)$row['AMH_ng_mL'] : null,
            'LH_mIU_mL' => $row['LH_mIU_mL'] !== null ? (float)$row['LH_mIU_mL'] : null,
            'FSH_mIU_mL' => $row['FSH_mIU_mL'] !== null ? (float)$row['FSH_mIU_mL'] : null,
            'BMI' => $row['BMI'] !== null ? (float)$row['BMI'] : null,
            'Cycle_length_days' => $row['Cycle_length_days'] !== null ? (int)$row['Cycle_length_days'] : null,
            'Follicle_no_L' => $row['Follicle_no_L'] !== null ? (int)$row['Follicle_no_L'] : null,
            'Follicle_no_R' => $row['Follicle_no_R'] !== null ? (int)$row['Follicle_no_R'] : null,
            'Weight_gain' => $row['Weight_gain'] !== null ? (int)$row['Weight_gain'] : null,
            'Hair_growth' => $row['Hair_growth'] !== null ? (int)$row['Hair_growth'] : null,
            'Skin_darkening' => $row['Skin_darkening'] !== null ? (int)$row['Skin_darkening'] : null,
            'Hair_loss' => $row['Hair_loss'] !== null ? (int)$row['Hair_loss'] : null,
            'Pimples' => $row['Pimples'] !== null ? (int)$row['Pimples'] : null,
            'ultrasound_image' => $row['Ultrasound_image'] !== null ? $row['Ultrasound_image'] : null
        ];
        
        $debug_log[] = "Added patient: {$row['patient_name']} - Diagnosis: $overall_diagnosis ({$row['Overall_diagnosis_probability_percentage']}%)";
    }
    
    $debug_log[] = "Total patients formatted: " . count($patients);
    
    $conn->close();
    
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'data' => $patients,
        'count' => count($patients),
        'debug' => (PCODE_DEBUG && isset($_GET['debug']) && $_GET['debug'] === '1') ? $debug_log : null
    ]);
    
} catch (Exception $e) {
    $debug_log[] = "EXCEPTION: " . $e->getMessage();
    
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage(),
        'debug' => $_GET['debug'] === '1' ? $debug_log : null
    ]);
}
?>
