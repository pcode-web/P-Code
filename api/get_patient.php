<?php
header('Content-Type: application/json');
require_once 'config.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/clinical_validity.php';
require_once __DIR__ . '/patient_schema_helpers.php';

// Convert uncaught fatal errors (e.g. bad SQL / missing column) into a JSON 500
// instead of an empty body, so the client never receives a null response.
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json');
        }
        echo json_encode([
            'success' => false,
            'error' => PCODE_DEBUG ? ('Fatal: ' . $err['message']) : 'Server error while loading patient data'
        ]);
    }
});

try {
    // Providers only
    $providerAuth = requireProvider();

    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    
    if ($conn->connect_error) {
        throw new Exception("Connection failed: " . $conn->connect_error);
    }

    // Ensure the extended clinical-timing columns exist before selecting them.
    // (Some databases predate the clinical-tracking migration.)
    pcode_clinical_validity_ensure_columns_mysqli($conn);
    pcode_ensure_clinical_recommendations_column($conn);
    pcode_ensure_owner_provider_id_column($conn);
    
    $patient_id = isset($_GET['id']) ? $_GET['id'] : null;
    
    if (!$patient_id) {
        throw new Exception("Patient ID is required");
    }
    
    // Extract numeric ID from PMOS-/PCOS- display format if present
    if (preg_match('/^(?:PCOS|PMOS)-/i', (string) $patient_id)) {
        $patient_id = intval(preg_replace('/^(?:PCOS|PMOS)-/i', '', (string) $patient_id));
    } else {
        $patient_id = intval($patient_id);
    }
    
    // Validate that we have a valid numeric ID
    if (!$patient_id || $patient_id <= 0) {
        throw new Exception("Patient ID is required");
    }

    $providerId = pcode_require_provider_owns_patient($conn, $patient_id, $providerAuth);
    
    $query = "
        SELECT 
            p.patient_id as id,
            p.patient_name as name,
            p.age as Age_yrs,
            p.date_of_birth as DOB,
            p.contact_no as contact_no,
            p.address as address,
            p.civil_status as civil_status,
            p.occupation as occupation,
            p.religion as religion,
            p.reffered_by as referred_by,
            p.clinical_recommendations as clinical_recommendations,
            c.Ultrasound_image as Ultrasound_image,
            c.Weight_kg,
            c.Height_cm,
            c.BMI,
            c.Blood_Group,
            c.Pulse_rate_bpm,
            c.RR_breath_min,
            c.Hb_g_dl,
            c.CycleR_I,
            c.Cycle_length_days,
            c.Marriage_Status_years,
            c.Pregnant,
            c.No_of_abortions,
            c.I_beta_HCG_mIU_mL,
            c.II_beta_HCG_mIU_mL,
            c.FSH_mIU_mL,
            c.LH_mIU_mL,
            c.FSH_LH,
            c.Hip_inch,
            c.Waist_inch,
            c.Waist_hip_ratio,
            c.TSH_mIU_L,
            c.AMH_ng_mL,
            c.PRL_ng_mL,
            c.Vit_D3_ng_mL,
            c.PRG_ng_mL,
            c.RBS_mg_dl,
            c.Weight_gain,
            c.Hair_growth,
            c.Skin_darkening,
            c.Hair_loss,
            c.Pimples,
            c.Fast_food,
            c.Reg_Exercise,
            c.BP_Systolic_mmHg,
            c.BP_Diastolic_mmHg,
            c.Follicle_no_L,
            c.Follicle_no_R,
            c.Avg_F_size_L_mm,
            c.Avg_F_size_R_mm,
            c.Endometrium_mm,
            c.last_menstrual_period_date,
            c.blood_draw_date,
            c.ultrasound_date,
            c.symptom_evaluation_date,
            c.fasting_hours,
            c.ultrasound_modality,
            NULL as clinical_score_percentage,
            NULL as imaging_score_percentage,
            NULL as overall_diagnosis_percentage
        FROM patient_personal_info p
        LEFT JOIN patient_diagnosis_parameters c ON p.patient_id = c.patient_id
            AND (c.screening_id IS NULL OR c.screening_id = '')
        WHERE p.patient_id = ?
          AND p.owner_provider_id = ?
    ";
    
    $stmt = $conn->prepare($query);
    if (!$stmt) {
        throw new Exception("Query prepare failed: " . $conn->error);
    }
    $stmt->bind_param("ii", $patient_id, $providerId);
    $stmt->execute();
    $result = $stmt->get_result();
    
    if ($result->num_rows === 0) {
        throw new Exception("Patient not found");
    }
    
    $patient = $result->fetch_assoc();
    
    // Convert numeric fields while preserving NULL values for text fields
    // But convert NULL to 0 for checkbox fields (symptoms)
    $checkboxFields = ['Weight_gain', 'Hair_growth', 'Skin_darkening', 'Hair_loss', 'Pimples', 'Fast_food', 'Reg_Exercise'];
    
    foreach ($patient as $key => $value) {
        // For checkbox fields, convert NULL to 0 (unchecked)
        if (in_array($key, $checkboxFields)) {
            // Convert any truthy value for checked=1, falsy for checked=0
            if ($value === null || $value === '' || $value === 0 || $value === '0' || $value === false) {
                $patient[$key] = 0;
            } else if ($value === 1 || $value === '1' || $value === true || $value === 'yes' || $value === 'Yes' || $value === 'TRUE') {
                $patient[$key] = 1;
            } else {
                // For any other value, try to convert - empty strings or unknown values = 0, anything else = 1
                $patient[$key] = empty($value) ? 0 : 1;
            }
        }
        // For other numeric fields, preserve NULL values
        else if ($value === null) {
            $patient[$key] = null;
        } else if (in_array($key, ['Age_yrs', 'contact_no', 'Blood_Group', 'Pulse_rate_bpm', 'RR_breath_min', 
            'Cycle_length_days', 'Marriage_Status_years', 'No_of_abortions', 'BP_Systolic_mmHg', 'BP_Diastolic_mmHg'])) {
            $patient[$key] = (int)$value;
        } else if (in_array($key, ['Weight_kg', 'Height_cm', 'BMI', 'Hb_g_dl', 'CycleR_I', 'I_beta_HCG_mIU_mL', 
            'II_beta_HCG_mIU_mL', 'FSH_mIU_mL', 'LH_mIU_mL', 'FSH_LH', 'Hip_inch', 'Waist_inch', 'Waist_hip_ratio',
            'TSH_mIU_L', 'AMH_ng_mL', 'PRL_ng_mL', 'Vit_D3_ng_mL', 'PRG_ng_mL', 'RBS_mg_dl', 'Follicle_no_L',
            'Follicle_no_R', 'Avg_F_size_L_mm', 'Avg_F_size_R_mm', 'Endometrium_mm'])) {
            $patient[$key] = (float)$value;
        } else if (in_array($key, ['clinical_score_percentage', 'imaging_score_percentage', 'overall_diagnosis_percentage'])) {
            $patient[$key] = $value !== null ? (float)$value : null;
        }
    }
    
    $patient['id'] = 'PMOS-' . str_pad($patient['id'], 3, '0', STR_PAD_LEFT);
    
    // Include ultrasound image if available.
    // The column stores a raw binary BLOB, which is NOT valid UTF-8 and would make
    // json_encode() return false (empty body). Normalize to a base64 data URI so the
    // payload is always valid JSON — matching get_patients.php behavior.
    if (empty($patient['Ultrasound_image'])) {
        $patient['Ultrasound_image'] = null;
    } else {
        $img = $patient['Ultrasound_image'];
        if (strpos($img, 'data:image') === 0) {
            // Already a data URI — return as-is
            $patient['Ultrasound_image'] = $img;
        } else {
            $patient['Ultrasound_image'] = 'data:image/jpeg;base64,' . base64_encode($img);
        }
    }
    // Also alias as medical_image for frontend compatibility
    $patient['medical_image'] = $patient['Ultrasound_image'];
    
    $json = json_encode([
        'success' => true,
        'data' => $patient
    ]);
    
    // Safety net: if encoding still fails for any reason, drop the image rather than
    // emitting an empty body (which would crash the client with a null response).
    if ($json === false) {
        $patient['Ultrasound_image'] = null;
        $patient['medical_image'] = null;
        $json = json_encode([
            'success' => true,
            'data' => $patient,
            'warning' => 'Ultrasound image omitted (encoding error)'
        ]);
    }
    
    echo $json;
    
    $stmt->close();
    $conn->close();
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}
?>
