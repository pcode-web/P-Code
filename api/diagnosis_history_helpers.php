<?php
/**
 * Shared helpers for diagnosis history schema + response normalization.
 */
require_once __DIR__ . '/config.php';

const PCODE_DIAGNOSIS_THRESHOLD = 0.75;
const PCODE_NEGATIVE_MAX_PERCENT = 54;
const PCODE_BORDERLINE_MAX_PERCENT = 74;
const PCODE_POSITIVE_MIN_PERCENT = 75;

function pcode_diagnosis_history_ensure_columns(mysqli $conn): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;

    $alterPatientInfo = "
        ALTER TABLE patient_personal_info
          ADD COLUMN linked_user_id INT NULL DEFAULT NULL
    ";
    @$conn->query($alterPatientInfo);
    @$conn->query("ALTER TABLE patient_personal_info ADD KEY idx_linked_user_id (linked_user_id)");

    $patientCols = [
        "ADD COLUMN created_by VARCHAR(32) NOT NULL DEFAULT 'Physician'",
        "ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "ADD COLUMN clinical_inputs_snapshot JSON NULL",
        "ADD COLUMN initiated_by_user_id INT NULL DEFAULT NULL",
    ];
    foreach ($patientCols as $fragment) {
        @$conn->query("ALTER TABLE patient_diagnosis_results $fragment");
    }
    @$conn->query("ALTER TABLE patient_diagnosis_results ADD COLUMN screening_id VARCHAR(36) NULL DEFAULT NULL");
    @$conn->query("ALTER TABLE patient_diagnosis_results ADD KEY idx_pdr_screening_id (screening_id)");
    @$conn->query("ALTER TABLE patient_diagnosis_results ADD KEY idx_pdr_patient_created (patient_id, created_at)");

    $paramCols = [
        "ADD COLUMN screening_id VARCHAR(36) NULL DEFAULT NULL",
        "ADD COLUMN created_by VARCHAR(32) NOT NULL DEFAULT 'Physician'",
        "ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
    ];
    foreach ($paramCols as $fragment) {
        @$conn->query("ALTER TABLE patient_diagnosis_parameters $fragment");
    }
    @$conn->query("ALTER TABLE patient_diagnosis_parameters ADD KEY idx_pdp_screening_id (screening_id)");
    @$conn->query("ALTER TABLE patient_diagnosis_parameters ADD KEY idx_pdp_patient_created (patient_id, created_at)");

    $userCols = [
        "ADD COLUMN screening_id VARCHAR(36) NULL DEFAULT NULL",
        "ADD COLUMN created_by VARCHAR(32) NOT NULL DEFAULT 'Patient'",
        "ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "ADD COLUMN clinical_inputs_snapshot JSON NULL",
    ];
    foreach ($userCols as $fragment) {
        @$conn->query("ALTER TABLE user_diagnosis_results $fragment");
    }
    @$conn->query("ALTER TABLE user_diagnosis_results ADD KEY idx_udr_screening_id (screening_id)");
    @$conn->query("ALTER TABLE user_diagnosis_results ADD KEY idx_udr_user_created (user_id, created_at)");

    @$conn->query("ALTER TABLE user_diagnosis_results DROP INDEX uniq_user");
    @$conn->query("ALTER TABLE user_diagnosis_results DROP INDEX uq_results_user_id");
}

function pcode_norm_probability_fraction(?float $value): ?float
{
    if ($value === null || !is_finite($value)) {
        return null;
    }
    if ($value > 1.0) {
        return $value / 100.0;
    }
    return $value;
}

function pcode_norm_probability_percent(?float $value): ?float
{
    if ($value === null || !is_finite($value)) {
        return null;
    }
    if ($value >= 0.0 && $value <= 1.0) {
        return $value * 100.0;
    }
    return $value;
}

function pcode_resolve_overall_probability(array $row): ?float
{
    $overall = isset($row['Overall_diagnosis_probability_percentage'])
        ? pcode_norm_probability_fraction((float) $row['Overall_diagnosis_probability_percentage'])
        : null;
    if ($overall !== null) {
        return $overall;
    }

    $xg = isset($row['XGBoost_diagnosis_probability_percentage'])
        ? pcode_norm_probability_fraction((float) $row['XGBoost_diagnosis_probability_percentage'])
        : null;
    $cnn = isset($row['CNN_diagnosis_probability_percentage'])
        ? pcode_norm_probability_fraction((float) $row['CNN_diagnosis_probability_percentage'])
        : null;

    $candidates = array_filter([$xg, $cnn], static fn($v) => $v !== null);
    if (empty($candidates)) {
        return null;
    }
    return max($candidates);
}

function pcode_classify_probability_percent(?float $percent): ?array
{
    if ($percent === null || !is_finite($percent)) {
        return null;
    }
    $p = pcode_norm_probability_percent($percent);
    if ($p === null) {
        return null;
    }
    if ($p <= PCODE_NEGATIVE_MAX_PERCENT) {
        return [
            'code' => 0,
            'status_code' => 'negative',
            'label' => 'Negative',
            'badge_class' => 'pcode-history-status--clear',
        ];
    }
    if ($p <= PCODE_BORDERLINE_MAX_PERCENT) {
        return [
            'code' => 2,
            'status_code' => 'borderline',
            'label' => 'Borderline',
            'badge_class' => 'pcode-history-status--borderline',
        ];
    }
    return [
        'code' => 1,
        'status_code' => 'positive',
        'label' => 'Positive',
        'badge_class' => 'pcode-history-status--detected',
    ];
}

function pcode_resolve_overall_diagnosis_code(array $row, ?float $probabilityFraction): ?int
{
    if (isset($row['Overall_diagnosis']) && $row['Overall_diagnosis'] !== null && $row['Overall_diagnosis'] !== '') {
        return (int) $row['Overall_diagnosis'];
    }
    if ($probabilityFraction === null) {
        return null;
    }
    $classified = pcode_classify_probability_percent($probabilityFraction * 100.0);
    return $classified['code'] ?? null;
}

function pcode_decode_clinical_snapshot(?string $json): array
{
    if ($json === null || $json === '') {
        return [];
    }
    $decoded = json_decode($json, true);
    return is_array($decoded) ? $decoded : [];
}

function pcode_format_history_origin(string $createdBy): array
{
    $normalized = strtolower(trim($createdBy));
    if (in_array($normalized, ['patient', 'self', 'regular user', 'patient/self'], true)) {
        return [
            'code' => 'Patient',
            'label' => 'User App Self-Screening',
            'badge_class' => 'pcode-history-origin--patient',
        ];
    }
    return [
        'code' => 'Physician',
        'label' => 'Clinician Upload',
        'badge_class' => 'pcode-history-origin--physician',
    ];
}

function pcode_format_history_status(?int $diagnosisCode, ?float $probabilityFraction): array
{
    if ($diagnosisCode !== null) {
        $map = [
            0 => [
                'code' => 'negative',
                'label' => 'Negative',
                'badge_class' => 'pcode-history-status--clear',
            ],
            1 => [
                'code' => 'positive',
                'label' => 'Positive',
                'badge_class' => 'pcode-history-status--detected',
            ],
            2 => [
                'code' => 'borderline',
                'label' => 'Borderline',
                'badge_class' => 'pcode-history-status--borderline',
            ],
        ];
        if (isset($map[(int) $diagnosisCode])) {
            return $map[(int) $diagnosisCode];
        }
    }

    if ($probabilityFraction !== null) {
        $classified = pcode_classify_probability_percent($probabilityFraction * 100.0);
        if ($classified) {
            return [
                'code' => $classified['status_code'],
                'label' => $classified['label'],
                'badge_class' => $classified['badge_class'],
            ];
        }
    }

    return [
        'code' => 'negative',
        'label' => 'Negative',
        'badge_class' => 'pcode-history-status--clear',
    ];
}

function pcode_extract_history_metrics(array $clinical): array
{
    $pick = static function (array $keys) use ($clinical) {
        foreach ($keys as $key) {
            if (array_key_exists($key, $clinical) && $clinical[$key] !== null && $clinical[$key] !== '') {
                return $clinical[$key];
            }
        }
        return null;
    };

    return [
        'amh' => $pick(['AMH_ng_mL', 'AMH_level', 'amh', 'AMH']),
        'lh_fsh_ratio' => $pick(['FSH_LH', 'LH_FSH_Ratio', 'lh_fsh_ratio', 'LH_FSH_Ratio']),
        'lh' => $pick(['LH_mIU_mL', 'LH_level', 'lh']),
        'fsh' => $pick(['FSH_mIU_mL', 'FSH_level', 'fsh']),
        'follicle_left' => $pick(['Follicle_no_L', 'follicle_left']),
        'follicle_right' => $pick(['Follicle_no_R', 'follicle_right']),
        'follicle_size_left' => $pick(['Avg_F_size_L_mm', 'follicle_size_left']),
        'follicle_size_right' => $pick(['Avg_F_size_R_mm', 'follicle_size_right']),
        'endometrium_mm' => $pick(['Endometrium_mm', 'endometrium_thickness']),
        'ultrasound_modality' => $pick(['ultrasound_modality']),
        'tsh' => $pick(['TSH_mIU_L', 'TSH_level', 'tsh']),
        'rbs' => $pick(['RBS_mg_dl', 'RBS', 'rbs']),
    ];
}

function pcode_normalize_history_row(array $row, string $sourceTable): array
{
    $probabilityFraction = pcode_resolve_overall_probability($row);
    $probabilityPercent = $probabilityFraction !== null ? round($probabilityFraction * 100, 1) : null;
    $diagnosisCode = pcode_resolve_overall_diagnosis_code($row, $probabilityFraction);
    $clinical = pcode_decode_clinical_snapshot($row['clinical_inputs_snapshot'] ?? null);
    if (!empty($row['frozen_parameters']) && is_array($row['frozen_parameters'])) {
        $clinical = array_merge($clinical, $row['frozen_parameters']);
    } elseif (!empty($row['parameter_row']) && is_array($row['parameter_row'])) {
        $clinical = array_merge($clinical, pcode_parameter_row_to_clinical_array($row['parameter_row']));
    }

    $origin = pcode_format_history_origin((string) ($row['created_by'] ?? 'Physician'));
    $status = pcode_format_history_status($diagnosisCode, $probabilityFraction);

    $createdAt = $row['created_at'] ?? null;
    if ($createdAt === null || $createdAt === '') {
        $createdAt = date('Y-m-d H:i:s');
    }

    return [
        'diagnosis_id' => (int) ($row['diagnosis_id'] ?? 0),
        'screening_id' => $row['screening_id'] ?? null,
        'parameter_id' => isset($row['parameter_id']) ? (int) $row['parameter_id'] : null,
        'source' => $sourceTable,
        'created_at' => $createdAt,
        'created_at_display' => date('M j, Y · g:i A', strtotime($createdAt)),
        'created_by' => $origin['code'],
        'origin_label' => $origin['label'],
        'origin_badge_class' => $origin['badge_class'],
        'status_code' => $status['code'],
        'status_label' => $status['label'],
        'status_badge_class' => $status['badge_class'],
        'confidence_fraction' => $probabilityFraction,
        'confidence_percent' => $probabilityPercent,
        'confidence_display' => $probabilityPercent !== null ? number_format($probabilityPercent, 1) . '% Confidence' : 'N/A',
        'threshold' => PCODE_DIAGNOSIS_THRESHOLD,
        'xgboost_diagnosis' => isset($row['XGBoost_diagnosis']) ? (int) $row['XGBoost_diagnosis'] : null,
        'xgboost_probability_percent' => isset($row['XGBoost_diagnosis_probability_percentage'])
            ? pcode_norm_probability_percent((float) $row['XGBoost_diagnosis_probability_percentage'])
            : null,
        'cnn_diagnosis' => isset($row['CNN_diagnosis']) ? (int) $row['CNN_diagnosis'] : null,
        'cnn_probability_percent' => isset($row['CNN_diagnosis_probability_percentage'])
            ? pcode_norm_probability_percent((float) $row['CNN_diagnosis_probability_percentage'])
            : null,
        'overall_diagnosis' => $diagnosisCode,
        'clinical_inputs' => $clinical,
        'metrics_summary' => pcode_extract_history_metrics($clinical),
        'frozen_parameters' => $clinical,
        'ultrasound_image' => pcode_format_ultrasound_image($row['ultrasound_image'] ?? null),
    ];
}

function pcode_encode_clinical_snapshot($payload): ?string
{
    if ($payload === null) {
        return null;
    }
    if (is_string($payload)) {
        $decoded = json_decode($payload, true);
        if (is_array($decoded)) {
            return json_encode($decoded, JSON_UNESCAPED_UNICODE);
        }
        return null;
    }
    if (!is_array($payload)) {
        return null;
    }
    return json_encode($payload, JSON_UNESCAPED_UNICODE);
}

function pcode_resolve_created_by_from_token(?array $decoded, string $default = 'Physician'): string
{
    if (!$decoded) {
        return $default;
    }
    $role = strtolower(trim((string) ($decoded['role'] ?? '')));
    if ($role === 'regular user') {
        return 'Patient';
    }
    return $default;
}

/**
 * initiated_by_user_id FK → users.user_id only.
 * Provider JWT ids live in clinical_providers and must not be written here.
 */
function pcode_resolve_initiated_by_user_id(mysqli $conn, ?array $decoded): ?int
{
    if (!$decoded) {
        return null;
    }

    $authSource = strtolower(trim((string) (
        $decoded['auth_source']
        ?? $decoded['authSource']
        ?? ''
    )));
    if ($authSource === 'clinical_providers') {
        return null;
    }

    $role = strtolower(trim((string) ($decoded['role'] ?? '')));
    // Provider portal roles are never rows in users for this FK.
    if (in_array($role, ['ob-gyn', 'obgyn', 'physician', 'provider', 'specialist'], true)) {
        return null;
    }

    $id = (int) ($decoded['id'] ?? $decoded['user_id'] ?? 0);
    if ($id <= 0) {
        return null;
    }

    $stmt = $conn->prepare('SELECT user_id FROM users WHERE user_id = ? LIMIT 1');
    if (!$stmt) {
        return null;
    }
    $stmt->bind_param('i', $id);
    if (!$stmt->execute()) {
        $stmt->close();
        return null;
    }
    $res = $stmt->get_result();
    $ok = $res && $res->num_rows > 0;
    $stmt->close();

    return $ok ? $id : null;
}

function pcode_generate_screening_id(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return sprintf(
        '%s-%s-%s-%s-%s',
        substr($hex, 0, 8),
        substr($hex, 8, 4),
        substr($hex, 12, 4),
        substr($hex, 16, 4),
        substr($hex, 20, 12)
    );
}

/** Map detect-form / snapshot keys to patient_diagnosis_parameters column names. */
function pcode_clinical_snapshot_field_map(): array
{
    return [
        'age' => 'Age_yrs',
        'Age_yrs' => 'Age_yrs',
        'weight' => 'Weight_kg',
        'Weight_kg' => 'Weight_kg',
        'height' => 'Height_cm',
        'Height_cm' => 'Height_cm',
        'bmi' => 'BMI',
        'BMI' => 'BMI',
        'blood_group' => 'Blood_Group',
        'Blood_Group' => 'Blood_Group',
        'pulse_rate' => 'Pulse_rate_bpm',
        'Pulse_rate_bpm' => 'Pulse_rate_bpm',
        'rr_breath' => 'RR_breath_min',
        'RR_breath_min' => 'RR_breath_min',
        'bp_systolic' => 'BP_Systolic_mmHg',
        'BP_Systolic_mmHg' => 'BP_Systolic_mmHg',
        'bp_diastolic' => 'BP_Diastolic_mmHg',
        'BP_Diastolic_mmHg' => 'BP_Diastolic_mmHg',
        'hb' => 'Hb_g_dl',
        'Hb_g_dl' => 'Hb_g_dl',
        'cycle_regularity' => 'CycleR_I',
        'CycleR_I' => 'CycleR_I',
        'Cycle_R_I' => 'CycleR_I',
        'cycle_length' => 'Cycle_length_days',
        'Cycle_length_days' => 'Cycle_length_days',
        'marriage_years' => 'Marriage_Status_years',
        'Marriage_Status_years' => 'Marriage_Status_years',
        'pregnant' => 'Pregnant',
        'Pregnant' => 'Pregnant',
        'no_abortions' => 'No_of_abortions',
        'No_of_abortions' => 'No_of_abortions',
        'lh' => 'LH_mIU_mL',
        'LH_mIU_mL' => 'LH_mIU_mL',
        'LH_level' => 'LH_mIU_mL',
        'fsh' => 'FSH_mIU_mL',
        'FSH_mIU_mL' => 'FSH_mIU_mL',
        'FSH_level' => 'FSH_mIU_mL',
        'lh_fsh_ratio' => 'FSH_LH',
        'FSH_LH' => 'FSH_LH',
        'LH_FSH_Ratio' => 'FSH_LH',
        'amh' => 'AMH_ng_mL',
        'AMH_ng_mL' => 'AMH_ng_mL',
        'AMH_level' => 'AMH_ng_mL',
        'prl' => 'PRL_ng_mL',
        'PRL_ng_mL' => 'PRL_ng_mL',
        'vit_d3' => 'Vit_D3_ng_mL',
        'Vit_D3_ng_mL' => 'Vit_D3_ng_mL',
        'prg' => 'PRG_ng_mL',
        'PRG_ng_mL' => 'PRG_ng_mL',
        'tsh' => 'TSH_mIU_L',
        'TSH_mIU_L' => 'TSH_mIU_L',
        'TSH_level' => 'TSH_mIU_L',
        'rbs' => 'RBS_mg_dl',
        'RBS_mg_dl' => 'RBS_mg_dl',
        'RBS' => 'RBS_mg_dl',
        'hip_inch' => 'Hip_inch',
        'Hip_inch' => 'Hip_inch',
        'waist_inch' => 'Waist_inch',
        'Waist_inch' => 'Waist_inch',
        'waist_hip_ratio' => 'Waist_hip_ratio',
        'Waist_hip_ratio' => 'Waist_hip_ratio',
        'follicle_left' => 'Follicle_no_L',
        'Follicle_no_L' => 'Follicle_no_L',
        'follicle_right' => 'Follicle_no_R',
        'Follicle_no_R' => 'Follicle_no_R',
        'follicle_size_left' => 'Avg_F_size_L_mm',
        'Avg_F_size_L_mm' => 'Avg_F_size_L_mm',
        'follicle_size_right' => 'Avg_F_size_R_mm',
        'Avg_F_size_R_mm' => 'Avg_F_size_R_mm',
        'endometrium_thickness' => 'Endometrium_mm',
        'Endometrium_mm' => 'Endometrium_mm',
        'ultrasound_modality' => 'ultrasound_modality',
        'weight_gain' => 'Weight_gain',
        'hair_growth' => 'Hair_growth',
        'skin_darkening' => 'Skin_darkening',
        'hair_loss' => 'Hair_loss',
        'pimples' => 'Pimples',
        'fast_food' => 'Fast_food',
        'reg_exercise' => 'Reg_Exercise',
        'Ultrasound_image' => 'Ultrasound_image',
    ];
}

function pcode_map_snapshot_to_parameter_columns(array $snapshot): array
{
    $map = pcode_clinical_snapshot_field_map();
    $out = [];
    foreach ($snapshot as $key => $value) {
        if ($value === null || $value === '') {
            continue;
        }
        $col = $map[$key] ?? (is_string($key) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $key) ? $key : null);
        if ($col) {
            $out[$col] = $value;
        }
    }
    return $out;
}

function pcode_parameter_row_to_clinical_array(array $row): array
{
    $skip = ['parameter_id', 'patient_id', 'user_id', 'screening_id', 'created_by', 'created_at', 'Ultrasound_image'];
    $clinical = [];
    foreach ($row as $key => $value) {
        if (in_array($key, $skip, true) || $value === null || $value === '') {
            continue;
        }
        $clinical[$key] = $value;
    }
    return $clinical;
}

/**
 * Append a frozen parameter ledger row linked to a screening run.
 */
function pcode_insert_screening_parameters(
    mysqli $conn,
    int $patientId,
    string $screeningId,
    string $createdBy,
    array $snapshot
): ?int {
    $columns = pcode_map_snapshot_to_parameter_columns($snapshot);
    if (empty($columns) && empty($snapshot)) {
        return null;
    }

    $fields = ['patient_id', 'screening_id', 'created_by'];
    $placeholders = ['?', '?', '?'];
    $types = 'iss';
    $values = [$patientId, $screeningId, $createdBy];

    $intCols = [
        'Age_yrs', 'Blood_Group', 'Pulse_rate_bpm', 'RR_breath_min', 'Cycle_length_days',
        'Marriage_Status_years', 'No_of_abortions', 'BP_Systolic_mmHg', 'BP_Diastolic_mmHg',
        'Follicle_no_L', 'Follicle_no_R', 'Weight_gain', 'Hair_growth', 'Skin_darkening',
        'Hair_loss', 'Pimples', 'Fast_food', 'Reg_Exercise',
    ];

    foreach ($columns as $col => $val) {
        if ($col === 'Ultrasound_image' && is_string($val) && strpos($val, 'data:image') === 0) {
            $comma = strpos($val, ',');
            $val = $comma !== false ? base64_decode(substr($val, $comma + 1), true) : null;
        }
        if ($val === null || $val === '') {
            continue;
        }
        $fields[] = $col;
        $placeholders[] = '?';
        $values[] = $val;
        if (in_array($col, $intCols, true)) {
            $types .= 'i';
            $values[count($values) - 1] = (int) $val;
        } elseif ($col === 'Ultrasound_image') {
            $types .= 's';
        } else {
            $types .= is_numeric($val) ? 'd' : 's';
            if (is_numeric($val)) {
                $values[count($values) - 1] = (float) $val;
            }
        }
    }

    $sql = 'INSERT INTO patient_diagnosis_parameters (' . implode(', ', $fields) . ') VALUES (' . implode(', ', $placeholders) . ')';
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return null;
    }
    $stmt->bind_param($types, ...$values);
    if (!$stmt->execute()) {
        $stmt->close();
        return null;
    }
    $parameterId = (int) $conn->insert_id;
    $stmt->close();
    return $parameterId > 0 ? $parameterId : null;
}

function pcode_fetch_parameters_by_screening(mysqli $conn, string $screeningId): ?array
{
    if ($screeningId === '') {
        return null;
    }
    $stmt = $conn->prepare('SELECT * FROM patient_diagnosis_parameters WHERE screening_id = ? LIMIT 1');
    if (!$stmt) {
        return null;
    }
    $stmt->bind_param('s', $screeningId);
    if (!$stmt->execute()) {
        $stmt->close();
        return null;
    }
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * Regular-user parameter ledger row for a specific screening_id (never a shared draft).
 */
function pcode_fetch_user_parameters_by_screening(mysqli $conn, int $userId, string $screeningId): ?array
{
    if ($userId <= 0 || $screeningId === '') {
        return null;
    }
    $stmt = $conn->prepare(
        'SELECT * FROM user_diagnosis_parameters WHERE user_id = ? AND screening_id = ? LIMIT 1'
    );
    if (!$stmt) {
        return null;
    }
    $stmt->bind_param('is', $userId, $screeningId);
    if (!$stmt->execute()) {
        $stmt->close();
        return null;
    }
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * True when clinical_inputs_snapshot is null/empty/{} so history UI should not invent diffs.
 */
function pcode_clinical_snapshot_is_empty($snapshot): bool
{
    if ($snapshot === null || $snapshot === '') {
        return true;
    }
    if (is_string($snapshot)) {
        $decoded = json_decode($snapshot, true);
        return !is_array($decoded) || count($decoded) === 0;
    }
    if (is_array($snapshot)) {
        return count($snapshot) === 0;
    }
    return true;
}

function pcode_get_diagnosis_label(?int $code): string
{
    if ($code === null) {
        return 'pending';
    }
    $map = [0 => 'negative', 1 => 'positive', 2 => 'borderline'];
    return $map[(int) $code] ?? 'pending';
}

function pcode_format_ultrasound_image($img): ?string
{
    if ($img === null || $img === '') {
        return null;
    }
    if (is_string($img) && strpos($img, 'data:image') === 0) {
        return $img;
    }
    if (!is_string($img)) {
        return null;
    }
    return 'data:image/jpeg;base64,' . base64_encode($img);
}

/**
 * Fetch the most recent unified history entry for a patient profile
 * (clinician runs + linked Regular User self-screenings).
 */
function pcode_fetch_latest_unified_history(mysqli $conn, int $patientId, ?int $linkedUserId = null): ?array
{
    $entries = [];

    $stmt = $conn->prepare('
        SELECT diagnosis_id, patient_id, screening_id, XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
               CNN_diagnosis, CNN_diagnosis_probability_percentage, Overall_diagnosis,
               Overall_diagnosis_probability_percentage, created_by, created_at, clinical_inputs_snapshot
        FROM patient_diagnosis_results
        WHERE patient_id = ?
        ORDER BY created_at DESC, diagnosis_id DESC
    ');
    if ($stmt) {
        $stmt->bind_param('i', $patientId);
        if ($stmt->execute()) {
            $result = $stmt->get_result();
            while ($row = $result->fetch_assoc()) {
                $entries[] = pcode_normalize_history_row($row, 'patient_diagnosis_results');
            }
        }
        $stmt->close();
    }

    if ($linkedUserId === null) {
        $linkStmt = $conn->prepare('SELECT linked_user_id FROM patient_personal_info WHERE patient_id = ? LIMIT 1');
        if ($linkStmt) {
            $linkStmt->bind_param('i', $patientId);
            if ($linkStmt->execute()) {
                $linkRow = $linkStmt->get_result()->fetch_assoc();
                $linkedUserId = isset($linkRow['linked_user_id']) ? (int) $linkRow['linked_user_id'] : 0;
            }
            $linkStmt->close();
        }
    }

    if ($linkedUserId > 0) {
        $selfStmt = $conn->prepare('
            SELECT diagnosis_id, user_id, XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
                   CNN_diagnosis, CNN_diagnosis_probability_percentage, Overall_diagnosis,
                   Overall_diagnosis_probability_percentage, created_by, created_at, clinical_inputs_snapshot
            FROM user_diagnosis_results
            WHERE user_id = ?
            ORDER BY created_at DESC, diagnosis_id DESC
        ');
        if ($selfStmt) {
            $selfStmt->bind_param('i', $linkedUserId);
            if ($selfStmt->execute()) {
                $selfResult = $selfStmt->get_result();
                while ($row = $selfResult->fetch_assoc()) {
                    $row['created_by'] = $row['created_by'] ?? 'Patient';
                    $entries[] = pcode_normalize_history_row($row, 'user_diagnosis_results');
                }
            }
            $selfStmt->close();
        }
    }

    if (empty($entries)) {
        return null;
    }

    usort($entries, static function ($a, $b) {
        return strcmp($b['created_at'], $a['created_at']);
    });

    return $entries[0];
}

function pcode_count_unified_history_runs(mysqli $conn, int $patientId, ?int $linkedUserId = null): int
{
    $count = 0;

    $stmt = $conn->prepare('SELECT COUNT(*) AS c FROM patient_diagnosis_results WHERE patient_id = ?');
    if ($stmt) {
        $stmt->bind_param('i', $patientId);
        if ($stmt->execute()) {
            $row = $stmt->get_result()->fetch_assoc();
            $count += (int) ($row['c'] ?? 0);
        }
        $stmt->close();
    }

    if ($linkedUserId === null) {
        $linkStmt = $conn->prepare('SELECT linked_user_id FROM patient_personal_info WHERE patient_id = ? LIMIT 1');
        if ($linkStmt) {
            $linkStmt->bind_param('i', $patientId);
            if ($linkStmt->execute()) {
                $linkRow = $linkStmt->get_result()->fetch_assoc();
                $linkedUserId = isset($linkRow['linked_user_id']) ? (int) $linkRow['linked_user_id'] : 0;
            }
            $linkStmt->close();
        }
    }

    if ($linkedUserId > 0) {
        $selfStmt = $conn->prepare('SELECT COUNT(*) AS c FROM user_diagnosis_results WHERE user_id = ?');
        if ($selfStmt) {
            $selfStmt->bind_param('i', $linkedUserId);
            if ($selfStmt->execute()) {
                $row = $selfStmt->get_result()->fetch_assoc();
                $count += (int) ($row['c'] ?? 0);
            }
            $selfStmt->close();
        }
    }

    return $count;
}
