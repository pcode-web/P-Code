<?php
/**
 * Export XAI Insights as Comprehensive PDF Report
 * Includes all patient data: personal info, clinical parameters, ultrasound images
 * REORGANIZED: Data grouped into logical categories by topic
 */

// Enable error reporting to a log file
error_reporting(E_ALL);
ini_set('display_errors', 0);  // Don't display errors (would break JSON)
ini_set('log_errors', 1);
ini_set('error_log', dirname(__DIR__) . '/logs/php_errors.log');

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once 'config.php';
require_once __DIR__ . '/_lab_report_template.php';
require_once __DIR__ . '/patient_schema_helpers.php';
require_once __DIR__ . '/auth_helpers.php';

$response = [
    'success' => false,
    'message' => '',
    'file_url' => ''
];

try {
    // Grad-CAM (TensorFlow) can take several minutes on first load
    @ini_set('max_execution_time', '600');
    @set_time_limit(600);
    @ini_set('memory_limit', '1024M');

    $decoded = requireAuthDecoded();
    if (isGuestUser()) {
        // Guests may only export payload they already hold client-side — never DB PHI by id alone.
    }

    // Get patient ID and data from request
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) {
        throw new Exception('Invalid JSON export payload');
    }

    // DEBUG: log keys only (never dump ultrasound/Grad-CAM base64)
    error_log('=== EXPORT PDF DEBUG ===');
    error_log('Input keys: ' . json_encode(array_keys($input)));
    error_log('Has shap_explanation: ' . (!empty($input['shap_explanation']) ? 'yes' : 'no'));
    error_log('Has clinical_data.shap: ' . (!empty($input['clinical_data']['shap_explanation']) ? 'yes' : 'no'));
    error_log('Has gradcam: ' . (!empty($input['gradcam_visualization']) || !empty($input['imaging_data']['gradcam_visualization']) ? 'yes' : 'no'));
    error_log('Has ultrasound: ' . (!empty($input['ultrasound_image']) ? 'yes' : 'no'));
    error_log('Export timezone: ' . date_default_timezone_get() . ' now=' . date('Y-m-d H:i:s'));
    
    $patient_id_input = $input['patient_id'] ?? null;
    
    if (!$patient_id_input) {
        throw new Exception("Patient ID is required");
    }
    
    // Extract numeric ID if it's in "PCOS-XXX" / "PMOS-XXX" format
    // Frontend sends formatted ID like "PCOS-029", we need just the number
    if (strpos($patient_id_input, 'PCOS-') === 0 || strpos($patient_id_input, 'PMOS-') === 0) {
        $patient_id = (int)substr($patient_id_input, 5);  // Extract number after prefix
    } else if (strpos($patient_id_input, 'detected_') === 0) {
        // For detected patients (guests), extract the ID without the prefix
        $patient_id = (int)substr($patient_id_input, 9);  // Extract number after "detected_"
    } else {
        $patient_id = (int)$patient_id_input;  // Try to convert to int
    }
    
    if ($patient_id <= 0) {
        throw new Exception("Invalid patient ID format");
    }
    
    // Check if frontend provided full patient data (for guest/detected patients)
    $frontend_patient_data = $input['full_patient_data'] ?? null;
    $frontend_diagnosis_data = [
        'clinical_score' => $input['clinical_score_percentage'] ?? null,
        'imaging_score' => $input['imaging_score_percentage'] ?? null,
        'overall_diagnosis' => $input['overall_diagnosis'] ?? null,
        'overall_score' => $input['overall_diagnosis_percentage'] ?? null,
        'patient_name' => $input['patient_name'] ?? null,
        'clinical_diagnosis' => $input['clinical_diagnosis'] ?? null,
        'imaging_diagnosis' => $input['imaging_diagnosis'] ?? null
    ];
    
    // DEBUG: Log frontend diagnosis data
    error_log('Frontend diagnosis data: ' . json_encode($frontend_diagnosis_data));
    
    // Connect to database
    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if ($conn->connect_error) {
        throw new Exception("Database connection failed: " . $conn->connect_error);
    }
    pcode_ensure_clinical_recommendations_column($conn);
    
    // Get user name from database
    $user_name = 'Healthcare Professional';
    $user_id = $input['user_id'] ?? null;
    
    error_log('User ID from input: ' . ($user_id ?? 'NULL'));
    
    // If no user_id in input, try to get from Authorization header
    if (!$user_id) {
        $auth_header = $_SERVER['HTTP_AUTHORIZATION'] ?? null;
        error_log('Auth header: ' . ($auth_header ? 'Present' : 'Not present'));
        // Could decode JWT here if needed, but for now just try input
    }
    
    if ($user_id) {
        $user_query = "SELECT user_name FROM users WHERE user_id = ? LIMIT 1";
        $stmt = $conn->prepare($user_query);
        if ($stmt) {
            $stmt->bind_param("i", $user_id);
            if ($stmt->execute()) {
                $result = $stmt->get_result();
                $user_row = $result->fetch_assoc();
                if ($user_row && !empty($user_row['user_name'])) {
                    $user_name = $user_row['user_name'];
                    error_log('Found user name: ' . $user_name);
                }
            }
            $stmt->close();
        }
    } else {
        error_log('No user_id found - using default: Healthcare Professional');
    }
    
    error_log('Final user_name for PDF: ' . $user_name);
    
    // Fetch ALL patient data including personal info and clinical parameters
    pcode_ensure_owner_provider_id_column($conn);
    $query = "
        SELECT 
            `p`.`patient_id`,
            `p`.`patient_name`,
            `p`.`age`,
            `p`.`date_of_birth`,
            `p`.`date_added`,
            `p`.`contact_no`,
            `p`.`address`,
            `p`.`reffered_by`,
            `p`.`civil_status`,
            `p`.`occupation`,
            `p`.`religion`,
            `p`.`clinical_recommendations`,
            `p`.`owner_provider_id`,
            `p`.`linked_user_id`,
            `c`.`Age_yrs`,
            `c`.`Height_cm`,
            `c`.`Weight_kg`,
            `c`.`BMI`,
            `c`.`Blood_Group`,
            `c`.`Pulse_rate_bpm`,
            `c`.`RR_breath_min`,
            `c`.`BP_Systolic_mmHg`,
            `c`.`BP_Diastolic_mmHg`,
            `c`.`Hb_g_dl`,
            `c`.`CycleR_I`,
            `c`.`Cycle_length_days`,
            `c`.`Marriage_Status_years`,
            `c`.`Pregnant`,
            `c`.`No_of_abortions`,
            `c`.`FSH_mIU_mL`,
            `c`.`LH_mIU_mL`,
            `c`.`FSH_LH`,
            `c`.`I_beta_HCG_mIU_mL`,
            `c`.`II_beta_HCG_mIU_mL`,
            `c`.`AMH_ng_mL`,
            `c`.`TSH_mIU_L`,
            `c`.`PRL_ng_mL`,
            `c`.`Vit_D3_ng_mL`,
            `c`.`PRG_ng_mL`,
            `c`.`RBS_mg_dl`,
            `c`.`Follicle_no_L`,
            `c`.`Follicle_no_R`,
            `c`.`Avg_F_size_L_mm`,
            `c`.`Avg_F_size_R_mm`,
            `c`.`Endometrium_mm`,
            `c`.`Hip_inch`,
            `c`.`Waist_inch`,
            `c`.`Waist_hip_ratio`,
            `c`.`Weight_gain`,
            `c`.`Hair_growth`,
            `c`.`Skin_darkening`,
            `c`.`Hair_loss`,
            `c`.`Pimples`,
            `c`.`Fast_food`,
            `c`.`Reg_Exercise`,
            `c`.`Ultrasound_image`,
            `d`.`XGBoost_diagnosis`,
            `d`.`XGBoost_diagnosis_probability_percentage`,
            `d`.`CNN_diagnosis`,
            `d`.`CNN_diagnosis_probability_percentage`,
            `d`.`Overall_diagnosis`,
            `d`.`Overall_diagnosis_probability_percentage`,
            `d`.`diagnosis_id`
        FROM `patient_personal_info` `p`
        LEFT JOIN `patient_diagnosis_parameters` `c` ON `p`.`patient_id` = `c`.`patient_id`
        LEFT JOIN `patient_diagnosis_results` `d` ON `p`.`patient_id` = `d`.`patient_id`
        WHERE `p`.`patient_id` = ?
        ORDER BY `d`.`diagnosis_id` DESC
        LIMIT 1
    ";
    
    $stmt = $conn->prepare($query);
    if (!$stmt) {
        throw new Exception("Prepare failed: " . $conn->error);
    }
    
    // Bind as integer - we've extracted the numeric patient_id
    $stmt->bind_param("i", $patient_id);
    if (!$stmt->execute()) {
        throw new Exception("Execute failed: " . $stmt->error);
    }
    
    $result = $stmt->get_result();
    $patient = $result->fetch_assoc();

    if ($patient) {
        if (isGuestUser()) {
            throw new Exception('Guests cannot load patient records from the database');
        }
        if (isProviderRole($decoded) && !isAdminRole($decoded)) {
            $ownerId = (int) ($patient['owner_provider_id'] ?? 0);
            $providerId = (int) ($decoded['id'] ?? 0);
            if ($ownerId <= 0 || $ownerId !== $providerId) {
                http_response_code(403);
                throw new Exception('You do not have access to this patient record');
            }
        } elseif (isRegularUserRole($decoded) && !isAdminRole($decoded)) {
            $linked = (int) ($patient['linked_user_id'] ?? 0);
            $uid = (int) ($decoded['id'] ?? 0);
            if ($linked <= 0 || $linked !== $uid) {
                http_response_code(403);
                throw new Exception('You do not have access to this patient record');
            }
        }
    }
    
    // If patient not found in database, but frontend provided data (guest/detected patient)
    if (!$patient && $frontend_patient_data && is_array($frontend_patient_data)) {
        // Create patient array from frontend data
        $patient = [
            'patient_id' => $patient_id_input,
            'patient_name' => $frontend_patient_data['name'] ?? $frontend_diagnosis_data['patient_name'] ?? 'Guest Patient',
            'age' => $frontend_patient_data['age'] ?? null,
            'date_of_birth' => null,
            'contact_no' => null,
            'address' => null,
            'civil_status' => null,
            'religion' => null,
            'occupation' => null,
            'reffered_by' => null,
            'clinical_score_percentage' => $frontend_diagnosis_data['clinical_score'] ?? 0,
            'imaging_score_percentage' => $frontend_diagnosis_data['imaging_score'] ?? 0,
            'Overall_diagnosis' => $frontend_diagnosis_data['overall_diagnosis'] ?? 'pending',
            'Overall_diagnosis_probability_percentage' => $frontend_diagnosis_data['overall_score'] ?? 0,
            // Set XGBoost and CNN diagnoses from frontend overall diagnosis for display
            'XGBoost_diagnosis' => $frontend_diagnosis_data['overall_diagnosis'] ?? 'pending',
            'XGBoost_diagnosis_probability_percentage' => $frontend_diagnosis_data['clinical_score'] ?? 0,
            'CNN_diagnosis' => $frontend_diagnosis_data['overall_diagnosis'] ?? 'pending',
            'CNN_diagnosis_probability_percentage' => $frontend_diagnosis_data['imaging_score'] ?? 0,
            'diagnosis_id' => null
        ];
        
        // Merge additional fields from frontend patient data
        if (!empty($frontend_patient_data['clinical_data']) && is_array($frontend_patient_data['clinical_data'])) {
            $patient = array_merge($patient, $frontend_patient_data['clinical_data']);
        }
    } elseif (!$patient) {
        throw new Exception("Patient not found");
    }
    
    // CRUCIAL FIX: Check if database has diagnosis results for this patient
    // This ensures we use DATABASE VALUES as source of truth
    error_log('=== DIAGNOSIS DATA VALIDATION ===');
    error_log('Patient ID: ' . $patient_id);
    error_log('Database Overall_diagnosis: ' . ($patient['Overall_diagnosis'] ?? 'NULL'));
    error_log('Database Overall_diagnosis_probability_percentage: ' . ($patient['Overall_diagnosis_probability_percentage'] ?? 'NULL'));
    error_log('Database XGBoost_diagnosis: ' . ($patient['XGBoost_diagnosis'] ?? 'NULL'));
    error_log('Database CNN_diagnosis: ' . ($patient['CNN_diagnosis'] ?? 'NULL'));
    
    // If database doesn't have diagnosis results (all NULL), try explicit diagnosis query
    $has_database_diagnosis = !empty($patient['Overall_diagnosis']) || !empty($patient['XGBoost_diagnosis']) || !empty($patient['CNN_diagnosis']);
    
    if (!$has_database_diagnosis) {
        error_log('⚠️  No diagnosis found in main query, attempting targeted diagnosis query...');
        
        // Explicit query to fetch the most recent diagnosis for this patient
        $diag_query = "
            SELECT 
                `diagnosis_id`,
                `XGBoost_diagnosis`,
                `XGBoost_diagnosis_probability_percentage`,
                `CNN_diagnosis`,
                `CNN_diagnosis_probability_percentage`,
                `Overall_diagnosis`,
                `Overall_diagnosis_probability_percentage`
            FROM `patient_diagnosis_results`
            WHERE `patient_id` = ?
            ORDER BY `diagnosis_id` DESC
            LIMIT 1
        ";
        
        $diag_stmt = $conn->prepare($diag_query);
        if ($diag_stmt) {
            $diag_stmt->bind_param("i", $patient_id);
            $diag_stmt->execute();
            $diag_result = $diag_stmt->get_result();
            $diagnosis_row = $diag_result->fetch_assoc();
            
            if ($diagnosis_row) {
                error_log('✅ Found diagnosis in targeted query!');
                // Update patient array with diagnosis data from database
                $patient['diagnosis_id'] = $diagnosis_row['diagnosis_id'];
                $patient['XGBoost_diagnosis'] = $diagnosis_row['XGBoost_diagnosis'];
                $patient['XGBoost_diagnosis_probability_percentage'] = $diagnosis_row['XGBoost_diagnosis_probability_percentage'];
                $patient['CNN_diagnosis'] = $diagnosis_row['CNN_diagnosis'];
                $patient['CNN_diagnosis_probability_percentage'] = $diagnosis_row['CNN_diagnosis_probability_percentage'];
                $patient['Overall_diagnosis'] = $diagnosis_row['Overall_diagnosis'];
                $patient['Overall_diagnosis_probability_percentage'] = $diagnosis_row['Overall_diagnosis_probability_percentage'];
                $has_database_diagnosis = true;
                
                error_log('Updated patient array with diagnosis data from database');
            } else {
                error_log('❌ No diagnosis found in patient_diagnosis_results table for patient_id: ' . $patient_id);
            }
            $diag_stmt->close();
        }
    }
    
    // MERGE FRONTEND DATA: Prioritize database values, use frontend data as fallback
    // This ensures database is the source of truth while supporting temporary/guest diagnosis data
    error_log('=== DIAGNOSIS DATA MERGE ===');
    error_log('Has database diagnosis: ' . ($has_database_diagnosis ? 'YES' : 'NO'));
    error_log('Frontend clinical_score_percentage: ' . ($input['clinical_score_percentage'] ?? 'NOT SET'));
    error_log('Frontend imaging_score_percentage: ' . ($input['imaging_score_percentage'] ?? 'NOT SET'));
    
    // STRATEGY: Use database values if available, otherwise use frontend values
    
    // Clinical Score - Use database (XGBoost), fall back to frontend
    if (empty($patient['XGBoost_diagnosis_probability_percentage']) && !empty($input['clinical_score_percentage'])) {
        $patient['XGBoost_diagnosis_probability_percentage'] = $input['clinical_score_percentage'];
        $patient['clinical_score_percentage'] = $input['clinical_score_percentage'];
        error_log('Using frontend clinical_score_percentage as fallback');
    } else if (!empty($patient['XGBoost_diagnosis_probability_percentage'])) {
        $patient['clinical_score_percentage'] = $patient['XGBoost_diagnosis_probability_percentage'];
        error_log('Using database XGBoost_diagnosis_probability_percentage');
    }
    
    // Imaging Score - Use database (CNN), fall back to frontend
    if (empty($patient['CNN_diagnosis_probability_percentage']) && !empty($input['imaging_score_percentage'])) {
        $patient['CNN_diagnosis_probability_percentage'] = $input['imaging_score_percentage'];
        $patient['imaging_score_percentage'] = $input['imaging_score_percentage'];
        error_log('Using frontend imaging_score_percentage as fallback');
    } else if (!empty($patient['CNN_diagnosis_probability_percentage'])) {
        $patient['imaging_score_percentage'] = $patient['CNN_diagnosis_probability_percentage'];
        error_log('Using database CNN_diagnosis_probability_percentage');
    }
    
    // Overall Score - Use database, fall back to frontend
    if (empty($patient['Overall_diagnosis_probability_percentage']) && !empty($input['overall_diagnosis_percentage'])) {
        $patient['Overall_diagnosis_probability_percentage'] = $input['overall_diagnosis_percentage'];
        $patient['overall_diagnosis_percentage'] = $input['overall_diagnosis_percentage'];
        error_log('Using frontend overall_diagnosis_percentage as fallback');
    } else if (!empty($patient['Overall_diagnosis_probability_percentage'])) {
        $patient['overall_diagnosis_percentage'] = $patient['Overall_diagnosis_probability_percentage'];
        error_log('Using database Overall_diagnosis_probability_percentage');
    }
    
    // Overall Diagnosis - Use database, fall back to frontend
    if (empty($patient['Overall_diagnosis']) && !empty($input['overall_diagnosis'])) {
        $patient['Overall_diagnosis'] = $input['overall_diagnosis'];
        $patient['overall_diagnosis'] = $input['overall_diagnosis'];
        error_log('Using frontend overall_diagnosis as fallback');
    } else if (!empty($patient['Overall_diagnosis'])) {
        $patient['overall_diagnosis'] = $patient['Overall_diagnosis'];
        error_log('Using database Overall_diagnosis');
    }
    
    // XGBoost Diagnosis - Use database, fall back to frontend
    if (empty($patient['XGBoost_diagnosis']) && !empty($input['clinical_diagnosis'])) {
        $patient['XGBoost_diagnosis'] = $input['clinical_diagnosis'];
        $patient['xgboost_diagnosis'] = $input['clinical_diagnosis'];
        error_log('Using frontend clinical_diagnosis as fallback');
    } else if (!empty($patient['XGBoost_diagnosis'])) {
        $patient['xgboost_diagnosis'] = $patient['XGBoost_diagnosis'];
        error_log('Using database XGBoost_diagnosis');
    }
    
    // CNN Diagnosis - Use database, fall back to frontend
    if (empty($patient['CNN_diagnosis']) && !empty($input['imaging_diagnosis'])) {
        $patient['CNN_diagnosis'] = $input['imaging_diagnosis'];
        $patient['cnn_diagnosis'] = $input['imaging_diagnosis'];
        error_log('Using frontend imaging_diagnosis as fallback');
    } else if (!empty($patient['CNN_diagnosis'])) {
        $patient['cnn_diagnosis'] = $patient['CNN_diagnosis'];
        error_log('Using database CNN_diagnosis');
    }
    
    // If frontend provided full patient data (for guest patients), merge in additional fields
    if ($frontend_patient_data && is_array($frontend_patient_data)) {
        // Merge clinical and imaging diagnosis from frontend data
        if (!empty($frontend_patient_data['clinical_result']) && is_array($frontend_patient_data['clinical_result'])) {
            if (!isset($patient['clinical_score_percentage'])) {
                $patient['clinical_score_percentage'] = $frontend_patient_data['clinical_result']['probability'] ?? 0;
            }
        }
        if (!empty($frontend_patient_data['imaging_result']) && is_array($frontend_patient_data['imaging_result'])) {
            if (!isset($patient['imaging_score_percentage'])) {
                $patient['imaging_score_percentage'] = $frontend_patient_data['imaging_result']['probability'] ?? 0;
            }
        }
    }
    
    pcode_log('=== FINAL DIAGNOSIS DATA ===');
    pcode_log('XGBoost Score: ' . ($patient['XGBoost_diagnosis_probability_percentage'] ?? 'NOT SET'));
    pcode_log('CNN Score: ' . ($patient['CNN_diagnosis_probability_percentage'] ?? 'NOT SET'));
    pcode_log('Overall Score: ' . ($patient['Overall_diagnosis_probability_percentage'] ?? 'NOT SET'));
    pcode_log('Overall Diagnosis: ' . ($patient['Overall_diagnosis'] ?? 'NOT SET'));

    // Merge frontend clinical fields + imaging assets for lab-style PDF sections
    if (!empty($input['clinical_data']) && is_array($input['clinical_data'])) {
        $patient = array_merge($patient, $input['clinical_data']);
    }
    if (!empty($input['imaging_data']) && is_array($input['imaging_data'])) {
        foreach (['ultrasound_date', 'ultrasound_modality', 'Follicle_no_L', 'Follicle_no_R', 'Avg_F_size_L', 'Avg_F_size_R', 'Endometrium_mm'] as $ik) {
            if (isset($input['imaging_data'][$ik]) && ($patient[$ik] ?? '') === '') {
                $patient[$ik] = $input['imaging_data'][$ik];
            }
        }
        if (!empty($input['imaging_data']['gradcam_visualization'])) {
            $patient['gradcam_visualization'] = $input['imaging_data']['gradcam_visualization'];
        }
    }
    if (!empty($input['ultrasound_image'])) {
        $patient['Ultrasound_image'] = $input['ultrasound_image'];
        $patient['ultrasound_image'] = $input['ultrasound_image'];
    }
    if (!empty($input['gradcam_visualization'])) {
        $patient['gradcam_visualization'] = $input['gradcam_visualization'];
    } elseif (!empty($input['gradcam_image'])) {
        $patient['gradcam_visualization'] = $input['gradcam_image'];
    }
    if (empty($patient['patient_name']) && !empty($input['patient_name'])) {
        $patient['patient_name'] = $input['patient_name'];
    }
    
    // Fetch SHAP data from xai_insights and xai_feature_contributions
    $shap_data = fetchSHAPData($conn, $patient_id, $patient['diagnosis_id'] ?? null);

    // Merge SHAP from any frontend payload shape
    $liveShap = pcode_export_extract_shap_contributions($input);
    if (empty($shap_data['top_contributions']) && !empty($liveShap)) {
        $shap_data['top_contributions'] = $liveShap;
    }

    // Ensure ultrasound from DB is available even when Patients list export sends a slim payload
    if (empty($patient['Ultrasound_image']) && !empty($patient['ultrasound_image'])) {
        $patient['Ultrasound_image'] = $patient['ultrasound_image'];
    }

    // Recompute SHAP from clinical parameters if still missing
    if (empty($shap_data['top_contributions'])) {
        error_log('EXPORT PDF: recomputing SHAP from clinical parameters…');
        $recomputed = pcode_export_recompute_shap($patient, $input);
        if (!empty($recomputed)) {
            $shap_data['top_contributions'] = $recomputed;
            error_log('EXPORT PDF: SHAP recomputed, count=' . count($recomputed));
        } else {
            error_log('EXPORT PDF: SHAP recompute returned empty');
        }
    }

    // Generate Grad-CAM++ when ultrasound is present but heatmap was not sent
    if (empty($patient['gradcam_visualization'])) {
        $usForCam = $patient['Ultrasound_image'] ?? $patient['ultrasound_image'] ?? ($input['ultrasound_image'] ?? '');
        $usLen = is_string($usForCam) ? strlen($usForCam) : 0;
        error_log('EXPORT PDF: Grad-CAM missing; ultrasound_len=' . $usLen);
        if (is_string($usForCam) && $usForCam !== '') {
            $generatedCam = pcode_export_generate_gradcam($usForCam);
            if ($generatedCam !== '') {
                $patient['gradcam_visualization'] = $generatedCam;
                error_log('EXPORT PDF: Grad-CAM generated, len=' . strlen($generatedCam));
            } else {
                error_log('EXPORT PDF: Grad-CAM generation failed/empty');
            }
        }
    }
    
    // Generate comprehensive HTML report
    $html = generateComprehensiveReport($patient, $shap_data, $user_name);
    
    // DEBUG: Save the HTML to a file for inspection
    if (PCODE_DEBUG) {
        $debug_html_file = dirname(__DIR__) . "/logs/last_exported_report.html";
        file_put_contents($debug_html_file, $html);
        pcode_log('HTML Report saved to: ' . $debug_html_file);
        pcode_log('HTML length: ' . strlen($html) . ' bytes');
    }
    
    // Create exports directory if it doesn't exist
    $export_dir = dirname(__DIR__) . "/exports";
    if (!is_dir($export_dir)) {
        mkdir($export_dir, 0755, true);
    }
    
    // Generate filename with timestamp
    $timestamp = date('Ymd_His');
    $pdf_filename = "PMOS_Report_" . str_pad($patient_id, 3, '0', STR_PAD_LEFT) . "_{$timestamp}.pdf";
    $pdf_filepath = $export_dir . "/" . $pdf_filename;
    
    // Use Python to convert HTML to PDF using ReportLab
    $python_path = dirname(__DIR__) . "\\.venv\\Scripts\\python.exe";
    $converter_script = dirname(__FILE__) . "/html_to_pdf.py";
    $temp_dir = sys_get_temp_dir();
    $temp_input = $temp_dir . "/pcode_html_" . uniqid() . ".json";
    
    // Prepare input for Python script - use forward slashes for paths
    $input_data = json_encode([
        'html_content' => $html,
        'output_path' => str_replace('\\', '/', realpath($export_dir) . "/" . $pdf_filename)
    ], JSON_UNESCAPED_SLASHES);
    
    // Write temp file without BOM
    file_put_contents($temp_input, $input_data);
    
    // Call Python script with temp file as argument
    $command = "\"$python_path\" \"$converter_script\" \"$temp_input\" 2>&1";
    $output = shell_exec($command);
    
    // Trim output and check if empty
    $output = trim($output);
    if (empty($output)) {
        @unlink($temp_input);
        throw new Exception("Python converter returned empty response. Check if reportlab is installed and file permissions are correct.");
    }
    
    // Parse output - handle multiple JSON objects
    $result = null;
    $lines = explode("\n", $output);
    foreach ($lines as $line) {
        $line = trim($line);
        if (empty($line)) continue;
        if ($line[0] === '{') {
            $decoded = @json_decode($line, true);
            if (is_array($decoded)) {
                // Prefer success responses
                if (!is_array($result) || (isset($decoded['success']) && $decoded['success'])) {
                    $result = $decoded;
                }
            }
        }
    }
    
    if (!is_array($result)) {
        @unlink($temp_input);
        throw new Exception("Python conversion failed with output: " . substr($output, 0, 500));
    }
    
    if (!$result['success']) {
        $error_msg = isset($result['error']) ? $result['error'] : 'Python conversion failed: ' . substr($output, 0, 500);
        @unlink($temp_input);
        throw new Exception($error_msg);
    }
    
    // Check if PDF was created (may use forward slashes, so check both variants)
    if (!file_exists($pdf_filepath) && !file_exists(str_replace(array('/', '\\'), DIRECTORY_SEPARATOR, $result['output_path']))) {
        @unlink($temp_input);
        throw new Exception("PDF file was not created");
    }
    
    // Clean up temp file AFTER successful verification
    @unlink($temp_input);
    
    // PDF generated successfully
    $response['success'] = true;
    $response['message'] = "Report generated successfully";
    $response['file_url'] = "exports/" . $pdf_filename;
    $response['filename'] = $pdf_filename;
    $response['file_path'] = $pdf_filepath;
    
    $conn->close();
    
} catch (Exception $e) {
    $response['message'] = $e->getMessage();
}

echo json_encode($response);

/**
 * Normalize SHAP contribution rows from various frontend/API shapes.
 */
function pcode_export_normalize_shap_rows($rows) {
    if (!is_array($rows)) return [];
    $out = [];
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        $feature = $row['feature'] ?? $row['feature_name'] ?? $row['name'] ?? null;
        if ($feature === null || $feature === '') continue;
        if (!empty($row['was_missing'])) continue;
        $out[] = [
            'feature' => (string)$feature,
            'value' => $row['value'] ?? $row['feature_value'] ?? null,
            'shap_value' => (float)($row['shap_value'] ?? $row['shap'] ?? 0),
        ];
        if (count($out) >= 10) break;
    }
    return $out;
}

function pcode_export_extract_shap_contributions(array $input) {
    $candidates = [
        $input['shap_explanation']['top_contributions'] ?? null,
        $input['top_contributions'] ?? null,
        $input['clinical_data']['shap_explanation']['top_contributions'] ?? null,
        $input['clinical_data']['top_contributions'] ?? null,
        $input['full_patient_data']['api_response']['shap_explanation']['top_contributions'] ?? null,
        $input['full_patient_data']['shap_explanation']['top_contributions'] ?? null,
    ];
    foreach ($candidates as $rows) {
        $normalized = pcode_export_normalize_shap_rows($rows);
        if (!empty($normalized)) return $normalized;
    }
    return [];
}

/**
 * Python interpreter for ML export helpers (SHAP / Grad-CAM).
 * Must match predict_xgboost.php / predict_cnn_gradcam.php — NOT the PDF .venv
 * (that venv only has ReportLab and lacks tensorflow/pandas/shap).
 */
function pcode_export_python_bin() {
    $candidates = [
        'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
        getenv('PCODE_PYTHON') ?: '',
        'python',
    ];
    foreach ($candidates as $bin) {
        $bin = trim((string)$bin);
        if ($bin === '') continue;
        if ($bin === 'python' || file_exists($bin)) return $bin;
    }
    return 'python';
}

/**
 * Re-run XGBoost SHAP for PDF when Detect/XAI did not send contributions.
 */
function pcode_export_recompute_shap(array $patient, array $input) {
    $scriptPath = realpath(__DIR__ . '/../xgboost_predict.py');
    if (!$scriptPath) return [];

    $keys = [
        'age', 'Age_yrs', 'Weight_kg', 'Height_cm', 'BMI', 'Blood_Group',
        'Pulse_rate', 'Pulse_rate_bpm', 'RR_breath', 'RR_breath_min',
        'BP_systolic', 'BP_Systolic_mmHg', 'BP_diastolic', 'BP_Diastolic_mmHg',
        'Hemoglobin', 'Hb_g_dl', 'Cycle_R_I', 'CycleR_I', 'Cycle_length', 'Cycle_length_days',
        'Marriage_duration', 'Marriage_Status_years', 'Pregnant', 'Pregnant_status',
        'No_abortions', 'No_of_abortions', 'LH_level', 'LH_mIU_mL', 'FSH_level', 'FSH_mIU_mL',
        'AMH_level', 'AMH_ng_mL', 'PRL_level', 'PRL_ng_mL', 'TSH_level', 'TSH_mIU_L',
        'Progesterone_level', 'PRG_ng_mL', 'Vitamin_D3_level', 'Vit_D3_ng_mL',
        'RBS', 'RBS_mg_dl', 'Waist_inch', 'Hip_inch', 'Waist_hip_ratio',
        'Follicle_no_L', 'Follicle_no_R', 'Avg_F_size_L', 'Avg_F_size_L_mm',
        'Avg_F_size_R', 'Avg_F_size_R_mm', 'Endometrium_mm',
        'Weight_gain', 'Hair_growth', 'Skin_darkening', 'Hair_loss', 'Pimples',
        'Fast_food', 'Reg_Exercise',
    ];
    $payload = [];
    $sources = [];
    if (!empty($input['clinical_form_data']) && is_array($input['clinical_form_data'])) {
        $sources[] = $input['clinical_form_data'];
    }
    if (!empty($input['clinical_data']) && is_array($input['clinical_data'])) {
        $sources[] = $input['clinical_data'];
    }
    $sources[] = $patient;
    foreach ($sources as $src) {
        foreach ($keys as $k) {
            if (!array_key_exists($k, $payload) && array_key_exists($k, $src) && $src[$k] !== null && $src[$k] !== '') {
                $payload[$k] = $src[$k];
            }
        }
    }
    // Drop non-clinical score keys that confuse the model
    foreach (['probability', 'classification', 'description', 'missingValues', 'shap_explanation', 'reliable'] as $drop) {
        unset($payload[$drop]);
    }
    if (count($payload) < 3) return [];

    $tempFile = tempnam(sys_get_temp_dir(), 'pcode_shap_');
    file_put_contents($tempFile, json_encode($payload));
    $python = pcode_export_python_bin();
    $cmd = escapeshellarg($python) . ' ' . escapeshellarg($scriptPath) . ' ' . escapeshellarg($tempFile) . ' 2>&1';
    $output = shell_exec($cmd);
    @unlink($tempFile);
    if (!$output) {
        error_log('EXPORT PDF SHAP: empty shell output; python=' . $python);
        return [];
    }
    // Model scripts may print TF warnings before JSON — extract last JSON object
    $result = json_decode($output, true);
    if (!is_array($result)) {
        if (preg_match('/\{.*\}\s*$/s', $output, $m)) {
            $result = json_decode($m[0], true);
        }
    }
    if (!is_array($result)) {
        error_log('EXPORT PDF SHAP: non-JSON output sample=' . substr($output, 0, 300));
        return [];
    }
    return pcode_export_normalize_shap_rows($result['shap_explanation']['top_contributions'] ?? []);
}

/**
 * Generate Grad-CAM++ visualization PNG (data URI) for the PDF when missing.
 */
function pcode_export_generate_gradcam($imageBase64) {
    $scriptPath = realpath(__DIR__ . '/../cnn_predict.py');
    if (!$scriptPath || !is_string($imageBase64) || $imageBase64 === '') return '';

    $raw = $imageBase64;
    if (strpos($raw, 'data:') === 0) {
        $raw = substr($raw, strpos($raw, ',') + 1);
    }
    $bytes = base64_decode($raw, true);
    if ($bytes === false) return '';

    $tempImage = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'pcode_pdf_cam_' . uniqid() . '.tmp';
    if (file_put_contents($tempImage, $bytes) === false) return '';

    $python = pcode_export_python_bin();
    // args: image_file gradcam apply_smoothing
    $cmd = escapeshellarg($python) . ' ' . escapeshellarg($scriptPath) . ' '
        . escapeshellarg($tempImage) . ' true true 2>&1';
    $output = shell_exec($cmd);
    @unlink($tempImage);
    if (!$output) {
        error_log('EXPORT PDF Grad-CAM: empty shell output; python=' . $python);
        return '';
    }
    $result = json_decode($output, true);
    if (!is_array($result)) {
        if (preg_match('/\{.*\}\s*$/s', $output, $m)) {
            $result = json_decode($m[0], true);
        }
    }
    if (!is_array($result)) {
        error_log('EXPORT PDF Grad-CAM: non-JSON sample=' . substr($output, 0, 300));
        return '';
    }
    if (empty($result['success']) && empty($result['gradcam_visualization'])) {
        error_log('EXPORT PDF Grad-CAM: script error=' . ($result['error'] ?? 'unknown'));
        return '';
    }
    $viz = $result['gradcam_visualization'] ?? '';
    if (!is_string($viz) || $viz === '') return '';
    if (stripos($viz, 'data:image') === 0) return $viz;
    return 'data:image/png;base64,' . preg_replace('/\s+/', '', $viz);
}

/**
 * Fetch SHAP explanation data from database
 */
function fetchSHAPData($conn, $patient_id, $diagnosis_id = null) {
    $shap_data = [
        'top_contributions' => [],
        'base_value' => null,
        'interpretation_text' => ''
    ];
    
    try {
        // First, get the most recent insight for this patient
        $insight_query = "
            SELECT xi.insight_id, xi.base_value, xi.interpretation_text
            FROM xai_insights xi
            WHERE xi.patient_id = ? AND xi.model_type = 'xgboost'
            ";
        
        if ($diagnosis_id) {
            $insight_query .= "AND xi.diagnosis_id = ? ";
        }
        
        $insight_query .= "ORDER BY xi.created_at DESC LIMIT 1";
        
        $stmt = $conn->prepare($insight_query);
        if (!$stmt) {
            return $shap_data;
        }
        
        if ($diagnosis_id) {
            $stmt->bind_param("ii", $patient_id, $diagnosis_id);
        } else {
            $stmt->bind_param("i", $patient_id);
        }
        
        if (!$stmt->execute()) {
            return $shap_data;
        }
        
        $result = $stmt->get_result();
        $insight_row = $result->fetch_assoc();
        
        if (!$insight_row) {
            return $shap_data; // No insights found
        }
        
        $shap_data['base_value'] = $insight_row['base_value'];
        $shap_data['interpretation_text'] = $insight_row['interpretation_text'];
        $insight_id = $insight_row['insight_id'];
        
        // Now get the top 10 feature contributions for this insight
        $features_query = "
            SELECT feature_name, feature_value, shap_value, 
                   impact_direction, importance_rank
            FROM xai_feature_contributions
            WHERE insight_id = ?
            ORDER BY ABS(shap_value) DESC
            LIMIT 10
        ";
        
        $stmt = $conn->prepare($features_query);
        if (!$stmt) {
            return $shap_data;
        }
        
        $stmt->bind_param("i", $insight_id);
        if (!$stmt->execute()) {
            return $shap_data;
        }
        
        $result = $stmt->get_result();
        $contributions = [];
        
        while ($row = $result->fetch_assoc()) {
            if (!empty($row['feature_name'])) {
                $contributions[] = [
                    'feature' => $row['feature_name'],
                    'value' => $row['feature_value'],
                    'shap_value' => (float)$row['shap_value'],
                    'impact' => $row['impact_direction'],
                    'rank' => $row['importance_rank']
                ];
            }
        }
        
        $shap_data['top_contributions'] = $contributions;
        $stmt->close();
        
    } catch (Exception $e) {
        // Silently fail - SHAP data is optional
        error_log("SHAP data fetch error: " . $e->getMessage());
    }
    
    return $shap_data;
}
