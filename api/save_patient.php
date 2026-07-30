<?php
header('Content-Type: application/json');
require_once 'config.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/ultrasound_imaging.php';
require_once __DIR__ . '/clinical_validity.php';
require_once __DIR__ . '/patient_schema_helpers.php';

// Enable error logging
pcode_log("=== SAVE PATIENT DEBUG START ===");

try {
    // Providers only (guests already blocked below)
    $providerDecoded = null;
    if (!isGuestUser()) {
        $providerDecoded = requireProvider();
    }

    // Check if user is guest - if so, prevent writing to database
    if (isGuestUser()) {
        pcode_log("Guest user attempting to save patient data - blocked");
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'error' => 'Guest users cannot permanently save patient data. Please create an account to save.',
            'message' => 'Register an account to save and manage patient records.'
        ]);
        exit;
    }
    
    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    
    if ($conn->connect_error) {
        throw new Exception("Connection failed: " . $conn->connect_error);
    }

    pcode_clinical_validity_ensure_columns_mysqli($conn);
    pcode_ensure_clinical_recommendations_column($conn);
    pcode_ensure_owner_provider_id_column($conn);
    pcode_backfill_unscoped_patients_to_first_provider($conn);
    $ownerProviderId = pcode_current_provider_id_from_auth($providerDecoded);
    
    $data = json_decode(file_get_contents('php://input'), true);
    // Never log raw patient payloads in production
    pcode_log("Raw data received: " . json_encode($data));
    
    if (!$data) {
        throw new Exception("No data provided");
    }
    
    // Remap form field names to database column names
    $field_name_mapping = [
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
        'LH_FSH_Ratio' => 'FSH_LH',
        'AMH_level' => 'AMH_ng_mL',
        'PRL_level' => 'PRL_ng_mL',
        'TSH_level' => 'TSH_mIU_L',
        'Progesterone_level' => 'PRG_ng_mL',
        'Vitamin_D3_level' => 'Vit_D3_ng_mL',
        'RBS' => 'RBS_mg_dl',
        'Avg_F_size_L' => 'Avg_F_size_L_mm',
        'Avg_F_size_R' => 'Avg_F_size_R_mm',
        'Regular_exercise' => 'Reg_Exercise',
        'weight_gain' => 'Weight_gain',
        'hair_growth' => 'Hair_growth',
        'skin_darkening' => 'Skin_darkening',
        'hair_loss' => 'Hair_loss',
        'pimples' => 'Pimples',
        'fast_food' => 'Fast_food',
        'reg_exercise' => 'Reg_Exercise',
        'pregnant' => 'Pregnant',
        'lh' => 'LH_mIU_mL',
        'fsh' => 'FSH_mIU_mL',
        'lh_fsh_ratio' => 'FSH_LH',
        'amh' => 'AMH_ng_mL',
        'prl' => 'PRL_ng_mL',
        'vit_d3' => 'Vit_D3_ng_mL',
        'beta_hcg_i' => 'I_beta_HCG_mIU_mL',
        'beta_hcg_ii' => 'II_beta_HCG_mIU_mL',
        'prg' => 'PRG_ng_mL',
        'hb' => 'Hb_g_dl',
        'rbs' => 'RBS_mg_dl',
        'tsh' => 'TSH_mIU_L',
        'cycle_regularity' => 'CycleR_I',
        'marriage_years' => 'Marriage_Status_years',
        'follicle_left' => 'Follicle_no_L',
        'follicle_right' => 'Follicle_no_R',
        'follicle_size_left' => 'Avg_F_size_L_mm',
        'follicle_size_right' => 'Avg_F_size_R_mm',
        'endometrium_thickness' => 'Endometrium_mm',
        'hip_inch' => 'Hip_inch',
        'waist_inch' => 'Waist_inch',
        'waist_hip_ratio' => 'Waist_hip_ratio',
        'blood_group' => 'Blood_Group',
        'patient_name' => 'patient_name',
        'date_of_birth' => 'DOB',
        'contact_no' => 'contact_no',
        'address' => 'address',
        'civil_status' => 'civil_status',
        'occupation' => 'occupation',
        'religion' => 'religion',
        'referred_by' => 'referred_by',
        'height' => 'Height_cm',
        'weight' => 'Weight_kg',
        'bmi' => 'BMI',
        'pulse_rate' => 'Pulse_rate_bpm',
        'rr_breath' => 'RR_breath_min',
        'bp_systolic' => 'BP_Systolic_mmHg',
        'bp_diastolic' => 'BP_Diastolic_mmHg',
        'cycle_length' => 'Cycle_length_days',
        'no_abortions' => 'No_of_abortions',
        'blood_draw_date' => 'blood_draw_date',
        'last_menstrual_period_date' => 'last_menstrual_period_date',
        'ultrasound_date' => 'ultrasound_date',
        'symptom_evaluation_date' => 'symptom_evaluation_date',
        'fasting_hours' => 'fasting_hours',
        'ultrasound_modality' => 'ultrasound_modality',
        'clinical_recommendations' => 'clinical_recommendations',
        'recommendations' => 'clinical_recommendations',
    ];

    // UI-only / derived keys that must never be written as ghost DB columns
    $ghost_field_keys = [
        'LH_FSH_Ratio', 'smoothing_factor', 'user_mode', 'image',
        'xgboost_diagnosis', 'xgboost_probability', 'cnn_diagnosis', 'cnn_probability',
        'overall_diagnosis', 'overall_probability', 'clear_old_cnn', 'clear_old_xgboost',
    ];
    
    // Apply field name mapping
    $remapped_data = [];
    foreach ($data as $key => $value) {
        if (in_array($key, $ghost_field_keys, true)) {
            continue;
        }
        $db_field_name = $field_name_mapping[$key] ?? $key;
        $remapped_data[$db_field_name] = $value;
    }
    $data = $remapped_data;
    
    error_log("Remapped data: " . json_encode($data));
    
    // Extract patient ID (prefer explicit numeric patient_id; fallback to id with optional PMOS-/PCOS- prefix)
    $patient_id = null;
    if (isset($data['patient_id']) && $data['patient_id'] !== null && $data['patient_id'] !== '') {
        $patient_id = intval($data['patient_id']);
    } else if (isset($data['id']) && !empty($data['id'])) {
        $patient_id = intval(preg_replace('/^(?:PCOS|PMOS)-/i', '', (string) $data['id']));
    }
    error_log("Patient ID: " . ($patient_id ?? "NULL (new patient)"));
    
    // Personal info table fields
    $name = $data['patient_name'] ?? $data['name'] ?? '';
    // Use null for missing numeric fields instead of defaulting to 0
    $age = isset($data['Age_yrs']) && $data['Age_yrs'] !== null && $data['Age_yrs'] !== '' ? intval($data['Age_yrs']) : null;
    $dob = $data['DOB'] ?? null;
    // Store contact_no as-is (now using BIGINT in database to support 11-digit numbers)
    $contact = isset($data['contact_no']) && $data['contact_no'] !== null && $data['contact_no'] !== '' ? $data['contact_no'] : null;
    $address = $data['address'] ?? '';
    $civil_status = $data['civil_status'] ?? '';
    $occupation = $data['occupation'] ?? '';
    $religion = $data['religion'] ?? '';
    $reffered_by = $data['referred_by'] ?? ''; // Note: database column is reffered_by (double f)
    $hasRecommendationsUpdate = array_key_exists('clinical_recommendations', $data);
    $clinical_recommendations = $hasRecommendationsUpdate
        ? trim((string) $data['clinical_recommendations'])
        : '';
    $ultrasound_image = $data['Ultrasound_image'] ?? null; // Base64 encoded image
    
    error_log("Personal info: name=$name, age=$age, dob=$dob, contact=$contact");
    
    if ($ownerProviderId <= 0) {
        http_response_code(401);
        echo json_encode([
            'success' => false,
            'error' => 'Provider session required to save patient data',
        ]);
        exit;
    }

    // Check if patient exists (only if ID is provided) and belongs to this provider
    $exists = false;
    if ($patient_id) {
        $access = pcode_provider_patient_access($conn, $patient_id, $ownerProviderId);
        if ($access === 'forbidden') {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'error' => 'You can only update patients in your own care',
            ]);
            exit;
        }
        if ($access === 'ok') {
            $exists = true;
        }
        // access === not_found → create new chart only when personal fields are present
        error_log("Patient exists: " . ($exists ? "YES" : "NO") . " (access=$access)");
    }
    
    // Update or Insert personal info
    // Detect page may send only clinical parameters; in that case, preserve existing personal info.
    $hasPersonalUpdate =
        ($name !== null && trim($name) !== '') ||
        ($age !== null) ||
        ($dob !== null && $dob !== '') ||
        ($contact !== null && $contact !== '') ||
        ($address !== null && trim($address) !== '') ||
        ($civil_status !== null && trim($civil_status) !== '') ||
        ($occupation !== null && trim($occupation) !== '') ||
        ($religion !== null && trim($religion) !== '') ||
        ($reffered_by !== null && trim($reffered_by) !== '') ||
        $hasRecommendationsUpdate;

    // Clinical-only update requires an existing owned chart (never write another provider's parameters)
    if ($patient_id && !$exists && !$hasPersonalUpdate) {
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'error' => 'Patient not found in your care',
        ]);
        exit;
    }

    if (!$exists || $hasPersonalUpdate) {
        if ($exists) {
            error_log("Executing UPDATE for patient_id: $patient_id");
            if ($hasRecommendationsUpdate) {
                $update_query = "
                    UPDATE patient_personal_info 
                    SET patient_name = ?, age = ?, date_of_birth = ?, contact_no = ?, 
                        address = ?, civil_status = ?, occupation = ?, religion = ?, reffered_by = ?,
                        clinical_recommendations = ?
                    WHERE patient_id = ?
                      AND owner_provider_id = ?
                ";
                $stmt = $conn->prepare($update_query);
                if (!$stmt) {
                    throw new Exception("Prepare UPDATE failed: " . $conn->error);
                }
                $stmt->bind_param("sisisissssii", $name, $age, $dob, $contact, $address, $civil_status, $occupation, $religion, $reffered_by, $clinical_recommendations, $patient_id, $ownerProviderId);
            } else {
                $update_query = "
                    UPDATE patient_personal_info 
                    SET patient_name = ?, age = ?, date_of_birth = ?, contact_no = ?, 
                        address = ?, civil_status = ?, occupation = ?, religion = ?, reffered_by = ?
                    WHERE patient_id = ?
                      AND owner_provider_id = ?
                ";
                $stmt = $conn->prepare($update_query);
                if (!$stmt) {
                    throw new Exception("Prepare UPDATE failed: " . $conn->error);
                }
                $stmt->bind_param("sisisisssii", $name, $age, $dob, $contact, $address, $civil_status, $occupation, $religion, $reffered_by, $patient_id, $ownerProviderId);
            }
        } else {
            // New patient — scope to creating provider when known
            error_log("Executing INSERT for new patient");
            if ($ownerProviderId > 0) {
                $insert_query = "
                    INSERT INTO patient_personal_info 
                    (patient_name, age, date_of_birth, contact_no, address, civil_status, occupation, religion, reffered_by, clinical_recommendations, owner_provider_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ";
                $stmt = $conn->prepare($insert_query);
                if (!$stmt) {
                    throw new Exception("Prepare INSERT failed: " . $conn->error);
                }
                $stmt->bind_param("sisissssssi", $name, $age, $dob, $contact, $address, $civil_status, $occupation, $religion, $reffered_by, $clinical_recommendations, $ownerProviderId);
            } else {
                $insert_query = "
                    INSERT INTO patient_personal_info 
                    (patient_name, age, date_of_birth, contact_no, address, civil_status, occupation, religion, reffered_by, clinical_recommendations)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ";
                $stmt = $conn->prepare($insert_query);
                if (!$stmt) {
                    throw new Exception("Prepare INSERT failed: " . $conn->error);
                }
                $stmt->bind_param("sisissssss", $name, $age, $dob, $contact, $address, $civil_status, $occupation, $religion, $reffered_by, $clinical_recommendations);
            }
        }
        
        if (!$stmt->execute()) {
            error_log("Execute personal info failed: " . $stmt->error);
            throw new Exception("Error saving personal info: " . $stmt->error);
        }
        
        // Get patient ID - either from update or from newly inserted row
        if (!$exists) {
            $patient_id = $conn->insert_id;
            error_log("New patient ID generated: $patient_id");
        }
        $stmt->close();
    } else {
        error_log("Skipping personal info update (no personal fields provided) for patient_id: $patient_id");
    }
    
    // Clinical parameters — editable draft row (screening_id IS NULL); ledger rows are append-only on diagnosis.
    $check_clinical = "SELECT parameter_id FROM patient_diagnosis_parameters WHERE patient_id = ? AND (screening_id IS NULL OR screening_id = '') ORDER BY parameter_id DESC LIMIT 1";
    $stmt = $conn->prepare($check_clinical);
    if (!$stmt) {
        throw new Exception("Prepare check_clinical failed: " . $conn->error);
    }
    $stmt->bind_param("i", $patient_id);
    $stmt->execute();
    $clinical_exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    error_log("Clinical parameters exist: " . ($clinical_exists ? "YES" : "NO"));
    
    // Clinical parameters fields
    $clinical_fields = [
        'Age_yrs', 'Weight_kg', 'Height_cm', 'BMI', 'Blood_Group', 'Pulse_rate_bpm', 'RR_breath_min',
        'Hb_g_dl', 'CycleR_I', 'Cycle_length_days', 'Marriage_Status_years', 'Pregnant', 'No_of_abortions',
        'I_beta_HCG_mIU_mL', 'II_beta_HCG_mIU_mL', 'FSH_mIU_mL', 'LH_mIU_mL', 'FSH_LH', 'Hip_inch',
        'Waist_inch', 'Waist_hip_ratio', 'TSH_mIU_L', 'AMH_ng_mL', 'PRL_ng_mL', 'Vit_D3_ng_mL',
        'PRG_ng_mL', 'RBS_mg_dl', 'Weight_gain', 'Hair_growth', 'Skin_darkening', 'Hair_loss',
        'Pimples', 'Fast_food', 'Reg_Exercise', 'BP_Systolic_mmHg', 'BP_Diastolic_mmHg',
        'Follicle_no_L', 'Follicle_no_R', 'Avg_F_size_L_mm', 'Avg_F_size_R_mm', 'Endometrium_mm', 'Ultrasound_image',
        'last_menstrual_period_date', 'blood_draw_date', 'ultrasound_date', 'symptom_evaluation_date', 'fasting_hours',
        'ultrasound_modality'
    ];
    
    // Define which fields are integers
    $int_fields = [
        'Age_yrs', 'Blood_Group', 'Pulse_rate_bpm', 'RR_breath_min', 'Cycle_length_days', 
        'Marriage_Status_years', 'No_of_abortions', 'BP_Systolic_mmHg', 'BP_Diastolic_mmHg',
        'Follicle_no_L', 'Follicle_no_R', 'Weight_gain', 'Hair_growth', 'Skin_darkening', 
        'Hair_loss', 'Pimples', 'Fast_food', 'Reg_Exercise'
    ];
    
    // Define which fields are strings (blobs)
    $string_fields = ['Ultrasound_image', 'last_menstrual_period_date', 'blood_draw_date', 'ultrasound_date', 'symptom_evaluation_date', 'ultrasound_modality'];
    
    // Convert cycle regularity strings to numeric values
    if (isset($data['Cycle_R_I']) && !isset($data['CycleR_I'])) {
        $data['CycleR_I'] = $data['Cycle_R_I'];
    }
    if (isset($data['CycleR_I']) && is_string($data['CycleR_I'])) {
        if (strtolower($data['CycleR_I']) === 'regular') {
            $data['CycleR_I'] = 1;
        } elseif (strtolower($data['CycleR_I']) === 'irregular') {
            $data['CycleR_I'] = 0;
        } elseif (in_array(strtolower($data['CycleR_I']), ['amenorrhea', 'amenorrhoea'], true)) {
            $data['CycleR_I'] = 0;
        }
    }

    if (isset($data['blood_draw_date']) && $data['blood_draw_date'] !== '') {
        $data['blood_draw_date'] = substr((string) $data['blood_draw_date'], 0, 10);
    }
    if (isset($data['last_menstrual_period_date']) && $data['last_menstrual_period_date'] !== '') {
        $data['last_menstrual_period_date'] = substr((string) $data['last_menstrual_period_date'], 0, 10);
    }
    if (isset($data['ultrasound_date']) && $data['ultrasound_date'] !== '') {
        $data['ultrasound_date'] = substr((string) $data['ultrasound_date'], 0, 10);
    }
    if (isset($data['symptom_evaluation_date']) && $data['symptom_evaluation_date'] !== '') {
        $data['symptom_evaluation_date'] = substr((string) $data['symptom_evaluation_date'], 0, 10);
    }
    if (isset($data['ultrasound_modality']) && $data['ultrasound_modality'] !== '') {
        $data['ultrasound_modality'] = pcode_ultrasound_normalize_modality((string) $data['ultrasound_modality']);
    }
    
    // Convert Yes/No strings to 0/1 for binary fields
    $binary_yes_no_fields = [
        'Weight_gain', 'Hair_growth', 'Skin_darkening', 'Hair_loss', 'Pimples', 
        'Fast_food', 'Reg_Exercise', 'Pregnant'
    ];
    
    foreach ($binary_yes_no_fields as $field) {
        if (isset($data[$field]) && is_string($data[$field])) {
            if (strtolower($data[$field]) === 'yes') {
                $data[$field] = 1;
            } elseif (strtolower($data[$field]) === 'no') {
                $data[$field] = 0;
            }
        }
    }
    
    if ($clinical_exists) {
        error_log("Executing UPDATE for clinical parameters");
        // Build update query - explicitly handle NULL values
        // IMPORTANT: Don't update Ultrasound_image if it's not provided (to preserve existing value)
        $set_parts = [];
        foreach ($clinical_fields as $field) {
            // Skip Ultrasound_image if not provided (allows updating other fields without losing the image)
            if ($field === 'Ultrasound_image' && !isset($data['Ultrasound_image'])) {
                error_log("UPDATE: Preserving existing Ultrasound_image - not included in update");
                continue;
            }
            
            $value = $data[$field] ?? null;
            if ($value === null || $value === '') {
                $set_parts[] = "$field = NULL";
            } else {
                $set_parts[] = "$field = ?";
            }
        }
        $set_clause = implode(', ', $set_parts);
        $update_clinical = "UPDATE patient_diagnosis_parameters SET $set_clause WHERE patient_id = ? AND (screening_id IS NULL OR screening_id = '')";
        error_log("UPDATE clinical query: $update_clinical");
        $stmt = $conn->prepare($update_clinical);
        if (!$stmt) {
            error_log("Prepare UPDATE clinical failed: " . $conn->error);
            throw new Exception("Prepare UPDATE clinical failed: " . $conn->error);
        }
        
        $values = [];
        $types = '';
        foreach ($clinical_fields as $field) {
            // Skip Ultrasound_image if not provided
            if ($field === 'Ultrasound_image' && !isset($data['Ultrasound_image'])) {
                continue;
            }
            
            $value = $data[$field] ?? null;
            // Skip null values - they're handled with explicit NULL in SQL
            if ($value !== null && $value !== '') {
                if (in_array($field, $int_fields)) {
                    $values[] = intval($value);
                    $types .= 'i';
                } else if (in_array($field, $string_fields)) {
                    $values[] = $value;  // Keep as string (base64 blob)
                    $types .= 's';
                } else {
                    $values[] = floatval($value);
                    $types .= 'd';
                }
            }
        }
        $values[] = $patient_id;
        $types .= 'i';
        
        error_log("Clinical UPDATE types: $types, non-null fields: " . count($values) - 1);
        if (strlen($types) > 1) {  // Only bind if there are non-null values
            $stmt->bind_param($types, ...$values);
        } else {
            // All fields are null, just bind the patient_id
            $stmt->bind_param('i', $patient_id);
        }
    } else {
        error_log("Executing INSERT for clinical parameters");
        // Build insert query - explicitly handle NULL values
        $columns = ['patient_id'];
        $placeholders = ['?'];
        foreach ($clinical_fields as $field) {
            $value = $data[$field] ?? null;
            $columns[] = $field;
            if ($value === null || $value === '') {
                $placeholders[] = 'NULL';
            } else {
                $placeholders[] = '?';
            }
        }
        $columns_str = implode(', ', $columns);
        $placeholders_str = implode(', ', $placeholders);
        $insert_clinical = "INSERT INTO patient_diagnosis_parameters ($columns_str) VALUES ($placeholders_str)";
        error_log("INSERT clinical query: $insert_clinical");
        $stmt = $conn->prepare($insert_clinical);
        if (!$stmt) {
            error_log("Prepare INSERT clinical failed: " . $conn->error);
            throw new Exception("Prepare INSERT clinical failed: " . $conn->error);
        }
        
        $values = [$patient_id];
        $types = 'i';
        foreach ($clinical_fields as $field) {
            $value = $data[$field] ?? null;
            // Skip null values - they're handled with explicit NULL in SQL
            if ($value !== null && $value !== '') {
                if (in_array($field, $int_fields)) {
                    $values[] = intval($value);
                    $types .= 'i';
                } else if (in_array($field, $string_fields)) {
                    $values[] = $value;  // Keep as string (base64 blob)
                    $types .= 's';
                } else {
                    $values[] = floatval($value);
                    $types .= 'd';
                }
            }
        }
        
        error_log("Clinical INSERT types: $types, non-null fields: " . count($values) - 1);
        if (strlen($types) > 1) {  // Only bind if there are non-null values
            $stmt->bind_param($types, ...$values);
        } else {
            // All fields are null, just bind the patient_id
            $stmt->bind_param('i', $patient_id);
        }
    }
    
    if (!$stmt->execute()) {
        error_log("Execute clinical parameters failed: " . $stmt->error);
        throw new Exception("Error saving clinical parameters: " . $stmt->error);
    }
    error_log("Clinical parameters saved successfully");
    $stmt->close();
    
    $conn->close();
    
    error_log("=== SAVE PATIENT SUCCESS ===");
    echo json_encode([
        'success' => true,
        'message' => 'Patient data saved successfully',
        'patient_id' => 'PMOS-' . str_pad($patient_id, 3, '0', STR_PAD_LEFT)
    ]);
    
} catch (Exception $e) {
    error_log("=== SAVE PATIENT ERROR: " . $e->getMessage() . " ===");
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}
?>
