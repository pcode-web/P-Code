<?php
/**
 * XGBoost Model Prediction API
 * Accepts clinical data and returns PMOS prediction
 */
header('Content-Type: application/json');
require_once 'config.php';
require_once __DIR__ . '/clinical_validity.php';

try {
    // Get JSON POST data
    $inputData = file_get_contents('php://input');
    $clinicalData = json_decode($inputData, true);
    
    if (!$clinicalData || empty($clinicalData)) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => 'No clinical data provided',
            'received_data' => $inputData ? substr($inputData, 0, 100) : 'empty'
        ]);
        exit;
    }
    
    // NOTE: Removed the ">= 6 meaningful fields" requirement so both
    // OB-GYN specialists and regular users can run predictions with partial data.
    $validation_log = [
        'total_fields_received' => count($clinicalData)
    ];

    $validityEvaluation = pcode_clinical_validity_evaluate($clinicalData);
    $validation_log['clinical_validity'] = $validityEvaluation;
    if ($validityEvaluation['inference_blocked']) {
        pcode_clinical_validity_block_json($validityEvaluation);
    }
    
    // Remap form field names to normalized field names for Python
    // Python will then remap these to model feature names
    $field_name_mapping = [
        'age' => 'age',
        'Age_yrs' => 'age',  // Also accept database column name
        'Pulse_rate' => 'Pulse_rate',
        'Pulse_rate_bpm' => 'Pulse_rate',  // Database column name
        'RR_breath' => 'RR_breath',
        'RR_breath_min' => 'RR_breath',  // Database column name
        'BP_systolic' => 'BP_systolic',
        'BP_Systolic_mmHg' => 'BP_systolic',  // Database column name
        'BP_diastolic' => 'BP_diastolic',
        'BP_Diastolic_mmHg' => 'BP_diastolic',  // Database column name
        'Hemoglobin' => 'Hemoglobin',
        'Hb_g_dl' => 'Hemoglobin',  // Database column name
        'Cycle_R_I' => 'Cycle_R_I',
        'CycleR_I' => 'Cycle_R_I',  // Database column name
        'Cycle_length' => 'Cycle_length',
        'Cycle_length_days' => 'Cycle_length',  // Database column name
        'Marriage_duration' => 'Marriage_duration',
        'Marriage_Status_years' => 'Marriage_duration',  // Database column name
        'Pregnant_status' => 'Pregnant_status',
        'Pregnant' => 'Pregnant_status',  // Database column name
        'No_abortions' => 'No_abortions',
        'No_of_abortions' => 'No_abortions',  // Database column name
        'I_Beta_HCG' => 'I_Beta_HCG',
        'I_beta_HCG_mIU_mL' => 'I_Beta_HCG',  // Database column name
        'II_Beta_HCG' => 'II_Beta_HCG',
        'II_beta_HCG_mIU_mL' => 'II_Beta_HCG',  // Database column name
        'LH_level' => 'LH_level',
        'LH_mIU_mL' => 'LH_level',  // Database column name
        'FSH_level' => 'FSH_level',
        'FSH_mIU_mL' => 'FSH_level',  // Database column name
        'AMH_level' => 'AMH_level',
        'AMH_ng_mL' => 'AMH_level',  // Database column name
        'PRL_level' => 'PRL_level',
        'PRL_ng_mL' => 'PRL_level',  // Database column name
        'TSH_level' => 'TSH_level',
        'TSH_mIU_L' => 'TSH_level',  // Database column name
        'Progesterone_level' => 'Progesterone_level',
        'PRG_ng_mL' => 'Progesterone_level',  // Database column name
        'Vitamin_D3_level' => 'Vitamin_D3_level',
        'Vit_D3_ng_mL' => 'Vitamin_D3_level',  // Database column name
        'RBS' => 'RBS',
        'RBS_mg_dl' => 'RBS',  // Database column name
        // Ultrasound parameters
        'Follicle_no_L' => 'Follicle_no_L',  // Follicles Count Left
        'Follicle_no_R' => 'Follicle_no_R',  // Follicles Count Right
        'Avg_F_size_L' => 'Avg_F_size_L',
        'Avg_F_size_L_mm' => 'Avg_F_size_L',  // Database column name
        'Avg_F_size_R' => 'Avg_F_size_R',
        'Avg_F_size_R_mm' => 'Avg_F_size_R',  // Database column name
        'Endometrium_mm' => 'Endometrium_mm',  // Endometrium thickness
        
        'Regular_exercise' => 'Regular_exercise',
        'Reg_Exercise' => 'Regular_exercise',  // Database column name
    ];
    
    // Apply field name mapping
    $remapped_data = [];
    foreach ($clinicalData as $key => $value) {
        $normalized_name = $field_name_mapping[$key] ?? $key;
        $remapped_data[$normalized_name] = $value;
    }
    $clinicalData = $remapped_data;
    
    // Convert cycle regularity strings to numeric values for model input
    if (isset($clinicalData['Cycle_R_I']) && is_string($clinicalData['Cycle_R_I'])) {
        $cycleRaw = strtolower(trim($clinicalData['Cycle_R_I']));
        if ($cycleRaw === 'regular') {
            $clinicalData['Cycle_R_I'] = 1;
        } elseif ($cycleRaw === 'irregular') {
            $clinicalData['Cycle_R_I'] = 0;
        } elseif ($cycleRaw === 'amenorrhea') {
            $clinicalData['Cycle_R_I'] = 0;
        }
    }
    
    // Get Python path (modify based on your system)
    $pythonPath = 'C:/Users/USER/AppData/Local/Programs/Python/Python313/python.exe';
    
    // Get the script path
    $scriptPath = realpath(__DIR__ . '/../xgboost_predict.py');
    
    // Optional: allow client to request stronger smoothing (Regular Users only).
    // Lower factor => stronger smoothing (less extreme probabilities).
    $smoothingFactor = null;
    if (isset($clinicalData['smoothing_factor'])) {
        $sf = floatval($clinicalData['smoothing_factor']);
        unset($clinicalData['smoothing_factor']); // remove from features
        // Clamp to safe range
        if ($sf > 0) {
            $smoothingFactor = max(0.50, min(1.0, $sf));
        }
    }

    // Encode clinical data as JSON string argument (after removing control fields)
    $clinicalDataJson = json_encode($clinicalData);

    // Create a temporary file to store the JSON data (more reliable than shell escaping)
    $tempFile = tempnam(sys_get_temp_dir(), 'pcode_');
    file_put_contents($tempFile, $clinicalDataJson);

    // Prepare command with file path instead of direct JSON
    $escapedPython = escapeshellarg($pythonPath);
    $escapedScript = escapeshellarg($scriptPath);
    $escapedTempFile = escapeshellarg($tempFile);
    $command = "{$escapedPython} {$escapedScript} {$escapedTempFile}";
    if ($smoothingFactor !== null) {
        $command .= " " . escapeshellarg((string)$smoothingFactor);
    }
    
    // Execute prediction
    $output = shell_exec($command . ' 2>&1');
    
    // Clean up temporary file
    @unlink($tempFile);
    
    if ($output === null) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Failed to execute prediction script'
        ]);
        exit;
    }
    
    // Parse JSON response
    $result = json_decode($output, true);
    
    if (!$result) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Invalid response from prediction script: ' . substr($output, 0, 200),
            'validation_log' => $validation_log
        ]);
        exit;
    }
    
    // Inject validation log into response for transparency
    $result['validation_log'] = $validation_log;
    $result['clinical_validity'] = $validityEvaluation;

    $confidence = null;
    if (isset($result['probability_percentage'])) {
        $confidence = floatval($result['probability_percentage']) / 100;
    } elseif (isset($result['probability'])) {
        $confidence = floatval($result['probability']);
    }
    $result['follow_up_recommendation'] = pcode_clinical_validity_follow_up($confidence);
    
    echo json_encode($result);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage(),
        'validation_log' => $validation_log ?? []
    ]);
}
?>
