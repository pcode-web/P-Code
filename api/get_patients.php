<?php
header('Content-Type: application/json');
require_once 'config.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/diagnosis_history_helpers.php';
require_once __DIR__ . '/patient_schema_helpers.php';

pcode_session_start();

pcode_log("GET_PATIENTS: Starting request");

try {
    // Providers only (guests are handled separately below)
    // Note: guest flow returns sample patients without DB access.
    $providerAuth = null;
    if (!isGuestUser()) {
        $providerAuth = requireProvider();
        if (empty($providerAuth['id']) && empty($_SESSION['provider_id'])) {
            http_response_code(401);
            echo json_encode([
                'success' => false,
                'message' => 'Unauthorized: provider session verification failed',
            ]);
            exit;
        }
    }

    // Check if user is guest - if so, return sample data
    if (isGuestUser()) {
        pcode_log("GET_PATIENTS: Guest user detected, returning sample data");
        $samplePatients = getGuestSamplePatients();
        echo json_encode([
            'success' => true,
            'data' => $samplePatients,
            'count' => count($samplePatients),
            'message' => 'Sample data for guest user'
        ]);
        exit;
    }
    
    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    
    if ($conn->connect_error) {
        pcode_log("GET_PATIENTS: Connection failed: " . $conn->connect_error);
        throw new Exception("Connection failed: " . $conn->connect_error);
    }
    
    pcode_log("GET_PATIENTS: Database connected successfully");

    pcode_diagnosis_history_ensure_columns($conn);
    pcode_ensure_owner_provider_id_column($conn);
    pcode_backfill_unscoped_patients_to_first_provider($conn);

    $providerId = pcode_current_provider_id_from_auth($providerAuth);
    if ($providerId <= 0 && !empty($_SESSION['provider_id'])) {
        $providerId = (int) $_SESSION['provider_id'];
    }
    
    // Function to convert diagnosis code to text label
    function getDiagnosisLabel($code) {
        if ($code === null || $code === '') {
            return 'pending';
        }
        $code = (int)$code;
        $diagnosisMap = [
            0 => 'negative',
            1 => 'positive',
            2 => 'borderline'
        ];
        return isset($diagnosisMap[$code]) ? $diagnosisMap[$code] : 'pending';
    }
    
    // Function to determine overall diagnosis status
    // Pending only if BOTH clinical and imaging are missing
    function getOverallDiagnosisStatus($xgboost_code, $cnn_code, $overall_code) {
        // If both clinical and imaging predictions are missing, it's pending
        if ((is_null($xgboost_code) || $xgboost_code === '') && (is_null($cnn_code) || $cnn_code === '')) {
            return 'pending';
        }
        
        // Otherwise, use the overall diagnosis if available
        if ($overall_code !== null && $overall_code !== '') {
            return getDiagnosisLabel($overall_code);
        }
        
        // If no overall diagnosis, use whichever single result is available
        if ($xgboost_code !== null && $xgboost_code !== '') {
            return getDiagnosisLabel($xgboost_code);
        }
        
        if ($cnn_code !== null && $cnn_code !== '') {
            return getDiagnosisLabel($cnn_code);
        }
        
        // Fallback to pending
        return 'pending';
    }
    
    // Step 1: Get basic patient info scoped to this provider only
    if ($providerId > 0) {
        $basic_query = "SELECT p.patient_id, p.patient_name, p.age, p.date_of_birth, p.contact_no, p.civil_status, p.address, p.occupation, p.religion, p.reffered_by, DATE_FORMAT(p.date_added, '%Y-%m-%d') as date_added
                        FROM patient_personal_info p
                        WHERE p.owner_provider_id = " . (int) $providerId . "
                        ORDER BY p.date_added DESC";
    } else {
        $basic_query = "SELECT p.patient_id, p.patient_name, p.age, p.date_of_birth, p.contact_no, p.civil_status, p.address, p.occupation, p.religion, p.reffered_by, DATE_FORMAT(p.date_added, '%Y-%m-%d') as date_added
                        FROM patient_personal_info p
                        WHERE 1 = 0";
    }
    
    $basic_result = $conn->query($basic_query);
    if (!$basic_result) {
        error_log("GET_PATIENTS: Basic query failed: " . $conn->error);
        throw new Exception("Basic query failed: " . $conn->error);
    }
    
    error_log("GET_PATIENTS: Found " . $basic_result->num_rows . " patients");
    
    if ($basic_result->num_rows == 0) {
        error_log("GET_PATIENTS: No patients in database");
        echo json_encode([
            'success' => true,
            'data' => [],
            'count' => 0,
            'message' => 'No patients found in database'
        ]);
        $conn->close();
        exit;
    }
    
    $patients = [];
    
    // Step 2: For each patient, fetch their diagnosis and parameters
    while ($patient = $basic_result->fetch_assoc()) {
        $pid = (int)$patient['patient_id'];
        
        // Get diagnosis parameters (clinical data)
        $params_query = "SELECT * FROM patient_diagnosis_parameters WHERE patient_id = $pid AND (screening_id IS NULL OR screening_id = '') ORDER BY parameter_id DESC LIMIT 1";
        $params_result = $conn->query($params_query);
        $params = $params_result && $params_result->num_rows > 0 ? $params_result->fetch_assoc() : [];
        
        // Get latest diagnosis result (fallback when unified history is empty)
        $diagnosis_query = "SELECT * FROM patient_diagnosis_results WHERE patient_id = $pid ORDER BY created_at DESC, diagnosis_id DESC LIMIT 1";
        $diagnosis_result = $conn->query($diagnosis_query);
        $diagnosis = $diagnosis_result && $diagnosis_result->num_rows > 0 ? $diagnosis_result->fetch_assoc() : [];

        $linkedUserId = 0;
        $link_query = "SELECT linked_user_id FROM patient_personal_info WHERE patient_id = $pid LIMIT 1";
        $link_result = $conn->query($link_query);
        if ($link_result && $link_result->num_rows > 0) {
            $link_row = $link_result->fetch_assoc();
            $linkedUserId = isset($link_row['linked_user_id']) ? (int) $link_row['linked_user_id'] : 0;
        }

        $latestHistory = pcode_fetch_latest_unified_history($conn, $pid, $linkedUserId);
        $historyRunCount = pcode_count_unified_history_runs($conn, $pid, $linkedUserId);

        if ($latestHistory) {
            $diagnosis = array_merge($diagnosis, [
                'XGBoost_diagnosis' => $latestHistory['xgboost_diagnosis'],
                'XGBoost_diagnosis_probability_percentage' => $latestHistory['xgboost_probability_percent'],
                'CNN_diagnosis' => $latestHistory['cnn_diagnosis'],
                'CNN_diagnosis_probability_percentage' => $latestHistory['cnn_probability_percent'],
                'Overall_diagnosis' => $latestHistory['overall_diagnosis'],
                'Overall_diagnosis_probability_percentage' => $latestHistory['confidence_percent'],
                'diagnosis_id' => $latestHistory['diagnosis_id'],
                'created_at' => $latestHistory['created_at'],
            ]);
        }
        
        // Build patient array with all data
        $pmos_id = 'PMOS-' . str_pad($pid, 3, '0', STR_PAD_LEFT);
        
        $formatted_patient = [
            'id' => $pmos_id,
            'name' => $patient['patient_name'],
            'patient_id' => $pid,
            'age' => (int)($patient['age'] ?? 0),
            'date_added' => $patient['date_added'],
            
            // Personal Information
            'address' => $patient['address'] ?? null,
            'contact_no' => $patient['contact_no'] ?? null,
            'DOB' => $patient['date_of_birth'] ?? null,
            'civil_status' => $patient['civil_status'] ?? null,
            'occupation' => $patient['occupation'] ?? null,
            'religion' => $patient['religion'] ?? null,
            'referred_by' => $patient['reffered_by'] ?? null,
            
            // Diagnosis scores
            'clinical_score_percentage' => isset($diagnosis['XGBoost_diagnosis_probability_percentage'])
                ? pcode_norm_probability_percent($diagnosis['XGBoost_diagnosis_probability_percentage'])
                : null,
            'imaging_score_percentage' => isset($diagnosis['CNN_diagnosis_probability_percentage'])
                ? pcode_norm_probability_percent($diagnosis['CNN_diagnosis_probability_percentage'])
                : null,
            'overall_diagnosis_percentage' => isset($diagnosis['Overall_diagnosis_probability_percentage'])
                ? pcode_norm_probability_percent($diagnosis['Overall_diagnosis_probability_percentage'])
                : null,
            
            // Diagnosis results
            'xgboost_diagnosis' => getDiagnosisLabel($diagnosis['XGBoost_diagnosis'] ?? null),
            'cnn_diagnosis' => getDiagnosisLabel($diagnosis['CNN_diagnosis'] ?? null),
            'overall_diagnosis' => getOverallDiagnosisStatus($diagnosis['XGBoost_diagnosis'] ?? null, $diagnosis['CNN_diagnosis'] ?? null, $diagnosis['Overall_diagnosis'] ?? null),
            'diagnosis_id' => isset($diagnosis['diagnosis_id']) ? (int)$diagnosis['diagnosis_id'] : null,

            // Latest unified screening history (clinician + linked self-screening)
            'latest_screening_at' => $latestHistory['created_at'] ?? ($diagnosis['created_at'] ?? null),
            'latest_screening_display' => $latestHistory['created_at_display'] ?? null,
            'latest_screening_origin' => $latestHistory['origin_label'] ?? null,
            'latest_screening_origin_code' => $latestHistory['created_by'] ?? null,
            'latest_screening_status' => $latestHistory['status_label'] ?? null,
            'latest_screening_status_code' => $latestHistory['status_code'] ?? null,
            'history_run_count' => $historyRunCount,
            
            // Demographic & Vitals
            'Age_yrs' => isset($params['Age_yrs']) ? (int)$params['Age_yrs'] : null,
            'Weight_kg' => isset($params['Weight_kg']) ? (float)$params['Weight_kg'] : null,
            'Height_cm' => isset($params['Height_cm']) ? (float)$params['Height_cm'] : null,
            'Blood_Group' => isset($params['Blood_Group']) ? (int)$params['Blood_Group'] : null,
            'Pulse_rate_bpm' => isset($params['Pulse_rate_bpm']) ? (int)$params['Pulse_rate_bpm'] : null,
            'RR_breath_min' => isset($params['RR_breath_min']) ? (int)$params['RR_breath_min'] : null,
            'BP_Systolic_mmHg' => isset($params['BP_Systolic_mmHg']) ? (int)$params['BP_Systolic_mmHg'] : null,
            'BP_Diastolic_mmHg' => isset($params['BP_Diastolic_mmHg']) ? (int)$params['BP_Diastolic_mmHg'] : null,
            'Hb_g_dl' => isset($params['Hb_g_dl']) ? (float)$params['Hb_g_dl'] : null,
            'BMI' => isset($params['BMI']) ? (float)$params['BMI'] : null,
            
            // Anthropometric
            'Hip_inch' => isset($params['Hip_inch']) ? (float)$params['Hip_inch'] : null,
            'Waist_inch' => isset($params['Waist_inch']) ? (float)$params['Waist_inch'] : null,
            'Waist_hip_ratio' => isset($params['Waist_hip_ratio']) ? (float)$params['Waist_hip_ratio'] : null,
            
            // Menstrual & Reproductive
            'CycleR_I' => isset($params['CycleR_I']) ? (float)$params['CycleR_I'] : null,
            'Cycle_length_days' => isset($params['Cycle_length_days']) ? (int)$params['Cycle_length_days'] : null,
            'Marriage_Status_years' => isset($params['Marriage_Status_years']) ? (float)$params['Marriage_Status_years'] : null,
            'Pregnant' => isset($params['Pregnant']) ? (int)$params['Pregnant'] : null,
            'No_of_abortions' => isset($params['No_of_abortions']) ? (int)$params['No_of_abortions'] : null,
            
            // Hormonal Panel
            'AMH_ng_mL' => isset($params['AMH_ng_mL']) ? (float)$params['AMH_ng_mL'] : null,
            'LH_mIU_mL' => isset($params['LH_mIU_mL']) ? (float)$params['LH_mIU_mL'] : null,
            'FSH_mIU_mL' => isset($params['FSH_mIU_mL']) ? (float)$params['FSH_mIU_mL'] : null,
            'FSH_LH' => isset($params['FSH_LH']) ? (float)$params['FSH_LH'] : null,
            'TSH_mIU_L' => isset($params['TSH_mIU_L']) ? (float)$params['TSH_mIU_L'] : null,
            'PRL_ng_mL' => isset($params['PRL_ng_mL']) ? (float)$params['PRL_ng_mL'] : null,
            'Vit_D3_ng_mL' => isset($params['Vit_D3_ng_mL']) ? (float)$params['Vit_D3_ng_mL'] : null,
            'I_beta_HCG_mIU_mL' => isset($params['I_beta_HCG_mIU_mL']) ? (float)$params['I_beta_HCG_mIU_mL'] : null,
            'II_beta_HCG_mIU_mL' => isset($params['II_beta_HCG_mIU_mL']) ? (float)$params['II_beta_HCG_mIU_mL'] : null,
            'PRG_ng_mL' => isset($params['PRG_ng_mL']) ? (float)$params['PRG_ng_mL'] : null,
            'RBS_mg_dl' => isset($params['RBS_mg_dl']) ? (float)$params['RBS_mg_dl'] : null,
            
            // Ultrasound Parameters
            'Follicle_no_L' => isset($params['Follicle_no_L']) ? (int)$params['Follicle_no_L'] : null,
            'Follicle_no_R' => isset($params['Follicle_no_R']) ? (int)$params['Follicle_no_R'] : null,
            'Avg_F_size_L_mm' => isset($params['Avg_F_size_L_mm']) ? (float)$params['Avg_F_size_L_mm'] : null,
            'Avg_F_size_R_mm' => isset($params['Avg_F_size_R_mm']) ? (float)$params['Avg_F_size_R_mm'] : null,
            'Endometrium_mm' => isset($params['Endometrium_mm']) ? (float)$params['Endometrium_mm'] : null,
            
            // Clinical Symptoms
            'Weight_gain' => isset($params['Weight_gain']) ? (int)$params['Weight_gain'] : null,
            'Hair_growth' => isset($params['Hair_growth']) ? (int)$params['Hair_growth'] : null,
            'Skin_darkening' => isset($params['Skin_darkening']) ? (int)$params['Skin_darkening'] : null,
            'Hair_loss' => isset($params['Hair_loss']) ? (int)$params['Hair_loss'] : null,
            'Pimples' => isset($params['Pimples']) ? (int)$params['Pimples'] : null,
            'Fast_food' => isset($params['Fast_food']) ? (int)$params['Fast_food'] : null,
            'Reg_Exercise' => isset($params['Reg_Exercise']) ? (int)$params['Reg_Exercise'] : null,
            
            // Ultrasound Image - Handle both raw binary and already-encoded base64
            'Ultrasound_image' => isset($params['Ultrasound_image']) && !empty($params['Ultrasound_image']) 
                ? (strpos($params['Ultrasound_image'], 'data:image') === 0 
                    ? $params['Ultrasound_image']  // Already encoded, return as-is
                    : 'data:image/jpeg;base64,' . base64_encode($params['Ultrasound_image']))  // Raw binary, encode it
                : null
        ];
        
        $patients[] = $formatted_patient;
        error_log("GET_PATIENTS: Patient $pid - diagnosis: " . $formatted_patient['overall_diagnosis']);
    }
    
    error_log("GET_PATIENTS: Returning " . count($patients) . " patients");
    echo json_encode([
        'success' => true,
        'data' => $patients,
        'count' => count($patients)
    ]);
    
    $conn->close();
    
} catch (Exception $e) {
    error_log("GET_PATIENTS: Exception - " . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}
?>
