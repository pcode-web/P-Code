<?php
header('Content-Type: application/json');

// Include database config
require_once './config.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/diagnosis_history_helpers.php';
require_once __DIR__ . '/patient_schema_helpers.php';

$debug_log = [];
$debug_log[] = "=== SAVE DIAGNOSIS RESULTS API ===";
$debug_log[] = "Time: " . date('Y-m-d H:i:s');
$debug_log[] = "Method: " . $_SERVER['REQUEST_METHOD'];

try {
    $debug_log[] = "Checking guest user status...";
    
    // Check if user is guest - if so, prevent writing to database
    if (isGuestUser()) {
        $debug_log[] = "❌ Guest user detected - not allowed to save";
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'error' => 'Guest users cannot permanently save diagnosis results. Please create an account to save.',
            'message' => 'Register an account to save and manage diagnosis records.'
        ]);
        exit;
    }
    
    $debug_log[] = "✅ User is not guest or guest check passed";
    
    // Check if user is authenticated via JWT token
    $token = getAuthToken();
    $debug_log[] = "Token from getAuthToken(): " . ($token ? "Found" : "Not found");
    
    // For development/testing: if no token found via getAuthToken(), try to get it directly from headers
    if (!$token && isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $auth_header = $_SERVER['HTTP_AUTHORIZATION'];
        $debug_log[] = "Attempting to extract from Authorization header...";
        if (preg_match('/Bearer\s+(.+)/', $auth_header, $matches)) {
            $token = $matches[1];
            $debug_log[] = "✅ Token extracted from Authorization header";
        }
    }
    
    if (!$token) {
        $debug_log[] = "❌ No token available";
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Not authenticated'] + (PCODE_DEBUG ? ['debug' => $debug_log] : []));
        exit;
    }
    
    $debug_log[] = "Verifying JWT token...";
    $decoded = verifyJWT($token);
    if (!$decoded) {
        $debug_log[] = "❌ Token verification failed";
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Invalid or expired token'] + (PCODE_DEBUG ? ['debug' => $debug_log] : []));
        exit;
    }
    
    $debug_log[] = "✅ Token verified successfully";
    $user_id = $decoded['id'];
    $debug_log[] = "User ID from token: " . $user_id;

    // Get POST data
    $raw_input = file_get_contents('php://input');
    $debug_log[] = "Raw input received: " . strlen($raw_input) . " bytes";
    
    $data = json_decode($raw_input, true);
    
    if (!$data) {
        $debug_log[] = "❌ JSON decode failed or no data provided";
        http_response_code(400);
        $resp = [
            'success' => false,
            'error' => 'No valid JSON data provided'
        ];
        if (PCODE_DEBUG) {
            $resp['received'] = strlen($raw_input) > 0 ? substr($raw_input, 0, 100) : 'empty';
            $resp['debug'] = $debug_log;
        }
        echo json_encode($resp);
        exit;
    }
    
    $debug_log[] = "✅ JSON decoded successfully";
    $debug_log[] = "Fields received: " . implode(', ', array_keys($data));

    // Extract and validate input data
    $patient_id = intval($data['patient_id'] ?? 0);
    
    // Allow partial diagnosis data - can be clinical (xgboost) OR imaging (cnn) OR both
    $has_xgboost = isset($data['xgboost_diagnosis']) && $data['xgboost_diagnosis'] !== null;
    $has_cnn = isset($data['cnn_diagnosis']) && $data['cnn_diagnosis'] !== null;
    
    // Check if we should clear old data from algorithms not being updated
    $clear_old_xgboost = isset($data['clear_old_xgboost']) && $data['clear_old_xgboost'] === true;
    $clear_old_cnn = isset($data['clear_old_cnn']) && $data['clear_old_cnn'] === true;
    
    $xgboost_diagnosis = $has_xgboost ? intval($data['xgboost_diagnosis']) : null;
    $xgboost_probability = $has_xgboost ? floatval($data['xgboost_probability'] ?? 0) : null;
    $cnn_diagnosis = $has_cnn ? intval($data['cnn_diagnosis']) : null;
    $cnn_probability = $has_cnn ? floatval($data['cnn_probability'] ?? 0) : null;
    $overall_diagnosis = intval($data['overall_diagnosis'] ?? null);
    $overall_probability = floatval($data['overall_probability'] ?? null);

    /**
     * Our DB columns are *_probability_percentage.
     * Some callers send probabilities as 0..1 instead of 0..100. Normalize on write.
     */
    $normPercent = function($v) {
        if ($v === null) return null;
        $n = floatval($v);
        if (!is_finite($n)) return null;
        if ($n >= 0.0 && $n <= 1.0) return $n * 100.0;
        return $n;
    };
    if ($has_xgboost) $xgboost_probability = $normPercent($xgboost_probability);
    if ($has_cnn) $cnn_probability = $normPercent($cnn_probability);
    if ($overall_diagnosis !== null) $overall_probability = $normPercent($overall_probability);
    
    $debug_log[] = "Parsed patient_id: $patient_id (type: " . gettype($patient_id) . ")";
    $debug_log[] = "Has XGBoost data: " . ($has_xgboost ? "yes" : "no");
    $debug_log[] = "Has CNN data: " . ($has_cnn ? "yes" : "no");
    $debug_log[] = "Clear old XGBoost: " . ($clear_old_xgboost ? "yes" : "no");
    $debug_log[] = "Clear old CNN: " . ($clear_old_cnn ? "yes" : "no");

    if (!$patient_id || $patient_id <= 0) {
        $debug_log[] = "❌ Invalid patient_id: $patient_id";
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => "Invalid patient_id: $patient_id. Must be a positive integer.",
            'received_patient_id' => $data['patient_id'] ?? 'missing',
            'debug' => $debug_log
        ]);
        exit;
    }
    
    // Require at least one diagnosis type (clinical or imaging)
    if (!$has_xgboost && !$has_cnn) {
        $debug_log[] = "❌ No diagnosis data provided - must have either xgboost_diagnosis or cnn_diagnosis";
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => 'At least one diagnosis type is required (clinical or imaging)',
            'debug' => $debug_log
        ]);
        exit;
    }
    
    $debug_log[] = "Patient ID validation passed";
    $debug_log[] = "Diagnosis data validation passed";

    // Connect to database
    $debug_log[] = "Connecting to database: " . DB_HOST . "/" . DB_NAME;
    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if ($conn->connect_error) {
        $debug_log[] = "❌ Database connection failed: " . $conn->connect_error;
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Database connection failed',
            'debug' => $debug_log
        ]);
        exit;
    }
    
    $debug_log[] = "✅ Database connected";

    pcode_diagnosis_history_ensure_columns($conn);

    // Providers may only write diagnosis results onto their own patient charts
    if (isProviderRole($decoded)) {
        $providerId = pcode_current_provider_id_from_auth($decoded);
        $access = pcode_provider_patient_access($conn, $patient_id, $providerId);
        if ($access !== 'ok') {
            http_response_code($access === 'forbidden' ? 403 : 404);
            echo json_encode([
                'success' => false,
                'error' => $access === 'forbidden'
                    ? 'You can only save results for patients in your own care'
                    : "Patient ID $patient_id not found in database",
            ] + (PCODE_DEBUG ? ['debug' => $debug_log] : []));
            exit;
        }
    }

    $created_by = pcode_resolve_created_by_from_token($decoded, 'Physician');
    if (!empty($data['created_by'])) {
        $rawOrigin = strtolower(trim((string) $data['created_by']));
        $created_by = in_array($rawOrigin, ['patient', 'self', 'regular user'], true) ? 'Patient' : 'Physician';
    }
    $clinical_snapshot = pcode_encode_clinical_snapshot(
        $data['clinical_inputs_snapshot'] ?? $data['clinical_inputs'] ?? null
    );
    $snapshot_array = pcode_decode_clinical_snapshot($clinical_snapshot);
    $initiated_by_user_id = pcode_resolve_initiated_by_user_id($conn, $decoded);
    $screening_id = pcode_generate_screening_id();
    $debug_log[] = 'initiated_by_user_id: ' . ($initiated_by_user_id === null ? 'NULL (provider or unknown)' : (string) $initiated_by_user_id);

    // Verify patient exists
    $debug_log[] = "Checking if patient_id $patient_id exists in database...";
    $check_stmt = $conn->prepare("SELECT patient_id, patient_name FROM patient_personal_info WHERE patient_id = ?");
    if (!$check_stmt) {
        $debug_log[] = "❌ Prepare failed: " . $conn->error;
        throw new Exception("Prepare failed: " . $conn->error);
    }
    
    $check_stmt->bind_param("i", $patient_id);
    if (!$check_stmt->execute()) {
        $debug_log[] = "❌ Execute failed: " . $check_stmt->error;
        throw new Exception("Execute failed: " . $check_stmt->error);
    }
    
    $check_result = $check_stmt->get_result();
    if ($check_result->num_rows === 0) {
        $debug_log[] = "❌ Patient $patient_id not found in database";
        
        // List available patients for debugging
        $list_query = $conn->query("SELECT patient_id, patient_name FROM patient_personal_info LIMIT 5");
        $available = [];
        while ($row = $list_query->fetch_assoc()) {
            $available[] = $row['patient_id'] . ': ' . $row['patient_name'];
        }
        $debug_log[] = "Sample available patients: " . implode(', ', $available);
        
        $check_stmt->close();
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'error' => "Patient ID $patient_id not found in database",
            'debug' => $debug_log
        ]);
        exit;
    }
    
    $patient_data = $check_result->fetch_assoc();
    $debug_log[] = "✅ Patient found: " . $patient_data['patient_name'] . " (ID: " . $patient_data['patient_id'] . ")";
    $check_stmt->close();

    // Append frozen clinical inputs ledger row (1:1 with inference via screening_id).
    if (!empty($snapshot_array)) {
        $parameter_id = pcode_insert_screening_parameters($conn, $patient_id, $screening_id, $created_by, $snapshot_array);
        $debug_log[] = $parameter_id
            ? "✅ Parameter ledger row inserted (parameter_id=$parameter_id, screening_id=$screening_id)"
            : "⚠️ Parameter ledger insert skipped or failed for screening_id=$screening_id";
    } else {
        $debug_log[] = "⚠️ No clinical snapshot provided — parameter ledger row not created";
    }

    // Always INSERT a new historical diagnosis run (never overwrite prior entries).
    $debug_log[] = "Appending new diagnosis history row for patient $patient_id (screening_id=$screening_id)";

    $columns = ['patient_id', 'screening_id', 'created_by'];
    $placeholders = ['?', '?', '?'];
    $bind_params = [&$patient_id, &$screening_id, &$created_by];
    $bind_types = 'iss';

    // Only set FK when the JWT id is a real users.user_id (not clinical_providers.id)
    if ($initiated_by_user_id !== null) {
        $columns[] = 'initiated_by_user_id';
        $placeholders[] = '?';
        $bind_params[] = &$initiated_by_user_id;
        $bind_types .= 'i';
    }

    if ($has_xgboost) {
        $columns[] = 'XGBoost_diagnosis';
        $columns[] = 'XGBoost_diagnosis_probability_percentage';
        $placeholders[] = '?';
        $placeholders[] = '?';
        $bind_params[] = &$xgboost_diagnosis;
        $bind_params[] = &$xgboost_probability;
        $bind_types .= 'id';
        $debug_log[] = 'Including XGBoost fields in INSERT';
    }

    if ($has_cnn) {
        $columns[] = 'CNN_diagnosis';
        $columns[] = 'CNN_diagnosis_probability_percentage';
        $placeholders[] = '?';
        $placeholders[] = '?';
        $bind_params[] = &$cnn_diagnosis;
        $bind_params[] = &$cnn_probability;
        $bind_types .= 'id';
        $debug_log[] = 'Including CNN fields in INSERT';
    }

    if ($overall_diagnosis !== null) {
        $columns[] = 'Overall_diagnosis';
        $columns[] = 'Overall_diagnosis_probability_percentage';
        $placeholders[] = '?';
        $placeholders[] = '?';
        $bind_params[] = &$overall_diagnosis;
        $bind_params[] = &$overall_probability;
        $bind_types .= 'id';
        $debug_log[] = 'Including Overall diagnosis fields in INSERT';
    }

    if ($clinical_snapshot !== null) {
        $columns[] = 'clinical_inputs_snapshot';
        $placeholders[] = '?';
        $bind_params[] = &$clinical_snapshot;
        $bind_types .= 's';
        $debug_log[] = 'Including clinical_inputs_snapshot in INSERT';
    }

    $columns_str = implode(', ', $columns);
    $placeholders_str = implode(', ', $placeholders);
    $insert_query = "INSERT INTO patient_diagnosis_results ($columns_str) VALUES ($placeholders_str)";

    $stmt = $conn->prepare($insert_query);
    if (!$stmt) {
        $debug_log[] = '❌ INSERT Prepare failed: ' . $conn->error;
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Database prepare failed',
            'debug' => $debug_log,
        ]);
        exit;
    }

    $bind_result = call_user_func_array(
        [$stmt, 'bind_param'],
        array_merge([$bind_types], $bind_params)
    );

    if (!$bind_result) {
        $debug_log[] = '❌ INSERT Bind failed: ' . $stmt->error;
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Database bind failed',
            'debug' => $debug_log,
        ]);
        $stmt->close();
        exit;
    }

    if (!$stmt->execute()) {
        $debug_log[] = '❌ INSERT Execute failed: ' . $stmt->error;
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Database insert failed: ' . $stmt->error,
            'debug' => $debug_log,
        ]);
        $stmt->close();
        exit;
    }

    $diagnosis_id = $conn->insert_id;
    $stmt->close();

    $debug_log[] = "✅ INSERT successful - new diagnosis history ID: $diagnosis_id";

    echo json_encode([
        'success' => true,
        'message' => 'Diagnosis results saved to history',
        'diagnosis_id' => $diagnosis_id,
        'screening_id' => $screening_id,
        'action' => 'created',
        'created_by' => $created_by,
        'debug' => $debug_log,
    ]);

} catch (Exception $e) {
    $debug_log[] = "❌ EXCEPTION: " . $e->getMessage();
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage(),
        'debug' => $debug_log
    ]);
}

if (isset($conn)) {
    $conn->close();
}
?>
