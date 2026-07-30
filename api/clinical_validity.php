<?php
/**
 * P-Code clinical timing, freshness, and inference gate validation.
 */
declare(strict_types=1);

require_once __DIR__ . '/ultrasound_imaging.php';

const PCODE_INFERENCE_CONFIDENCE_THRESHOLD = 0.75;
const PCODE_LAB_MAX_AGE_DAYS = 90;
const PCODE_ULTRASOUND_MAX_AGE_DAYS = 60;
const PCODE_SYMPTOM_MAX_AGE_DAYS = 180;
const PCODE_FOLLICULAR_DAY_MIN = 2;
const PCODE_FOLLICULAR_DAY_MAX = 5;

function pcode_clinical_validity_ensure_columns_mysqli(mysqli $conn): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $columns = [
        'last_menstrual_period_date' => 'DATE DEFAULT NULL',
        'blood_draw_date' => 'DATE DEFAULT NULL',
        'ultrasound_date' => 'DATE DEFAULT NULL',
        'symptom_evaluation_date' => 'DATE DEFAULT NULL',
        'fasting_hours' => 'DECIMAL(4,1) DEFAULT NULL',
        'ultrasound_modality' => "VARCHAR(32) DEFAULT 'TVUS'",
    ];
    foreach ($columns as $name => $definition) {
        $safeName = $conn->real_escape_string($name);
        $result = $conn->query("SHOW COLUMNS FROM patient_diagnosis_parameters LIKE '{$safeName}'");
        if ($result && $result->num_rows === 0) {
            $conn->query(
                "ALTER TABLE patient_diagnosis_parameters ADD COLUMN `{$name}` {$definition}"
            );
        }
    }
    $done = true;
}

function pcode_clinical_validity_ensure_columns(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $columns = [
        'last_menstrual_period_date' => 'DATE DEFAULT NULL',
        'blood_draw_date' => 'DATE DEFAULT NULL',
        'ultrasound_date' => 'DATE DEFAULT NULL',
        'symptom_evaluation_date' => 'DATE DEFAULT NULL',
        'fasting_hours' => 'DECIMAL(4,1) DEFAULT NULL',
        'ultrasound_modality' => "VARCHAR(32) DEFAULT 'TVUS'",
    ];
    foreach ($columns as $name => $definition) {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $stmt->execute(['patient_diagnosis_parameters', $name]);
        if ((int) $stmt->fetchColumn() === 0) {
            $pdo->exec(
                "ALTER TABLE patient_diagnosis_parameters ADD COLUMN `{$name}` {$definition}"
            );
        }
    }
    $done = true;
}

function pcode_clinical_validity_parse_date(?string $raw): ?DateTimeImmutable
{
    if ($raw === null) {
        return null;
    }
    $raw = trim($raw);
    if ($raw === '') {
        return null;
    }
    $formats = ['Y-m-d', 'Y-m-d H:i:s', 'm/d/Y', 'd/m/Y'];
    foreach ($formats as $format) {
        $dt = DateTimeImmutable::createFromFormat($format, $raw);
        if ($dt instanceof DateTimeImmutable) {
            return $dt->setTime(0, 0, 0);
        }
    }
    try {
        return (new DateTimeImmutable($raw))->setTime(0, 0, 0);
    } catch (Exception $e) {
        return null;
    }
}

function pcode_clinical_validity_pick(array $payload, array $keys): ?string
{
    foreach ($keys as $key) {
        if (!array_key_exists($key, $payload)) {
            continue;
        }
        $val = $payload[$key];
        if ($val === null || $val === '') {
            continue;
        }
        return trim((string) $val);
    }
    return null;
}

function pcode_clinical_validity_days_between(?DateTimeImmutable $from, ?DateTimeImmutable $to): ?int
{
    if (!$from || !$to) {
        return null;
    }
    return (int) $from->diff($to)->format('%r%a');
}

function pcode_clinical_validity_is_amenorrhea(array $payload): bool
{
    $raw = strtolower(trim((string) pcode_clinical_validity_pick($payload, [
        'Cycle_R_I', 'CycleR_I', 'cycle_regularity', 'cycle_r_i',
    ])));
    return in_array($raw, ['amenorrhea', 'amenorrhoea', 'no_period', 'absent'], true);
}

function pcode_clinical_validity_age_label(?int $days, int $maxDays): string
{
    if ($days === null) {
        return 'Valid';
    }
    if ($days > $maxDays) {
        return "Age is {$days} days (Max: {$maxDays})";
    }
    return 'Valid';
}

function pcode_clinical_validity_has_lab_values(array $payload): bool
{
    $keys = [
        'LH_level', 'LH_mIU_mL', 'FSH_level', 'FSH_mIU_mL', 'TSH_level', 'TSH_mIU_L',
        'AMH_level', 'AMH_ng_mL', 'PRL_level', 'PRL_ng_mL', 'RBS', 'RBS_mg_dl',
        'Progesterone_level', 'PRG_ng_mL', 'Vitamin_D3_level', 'Vit_D3_ng_mL',
    ];
    foreach ($keys as $key) {
        if (isset($payload[$key]) && $payload[$key] !== '' && $payload[$key] !== null) {
            return true;
        }
    }
    return false;
}

function pcode_clinical_validity_has_ultrasound_values(array $payload): bool
{
    $keys = ['Follicle_no_L', 'Follicle_no_R', 'Avg_F_size_L', 'Avg_F_size_L_mm', 'Avg_F_size_R', 'Avg_F_size_R_mm'];
    foreach ($keys as $key) {
        if (isset($payload[$key]) && $payload[$key] !== '' && $payload[$key] !== null) {
            return true;
        }
    }
    return isset($_POST['image']) && $_POST['image'] !== '';
}

function pcode_clinical_validity_has_symptom_values(array $payload): bool
{
    $keys = ['Weight_gain', 'Hair_growth', 'Skin_darkening', 'Pimples'];
    foreach ($keys as $key) {
        if (isset($payload[$key]) && $payload[$key] !== '' && $payload[$key] !== null) {
            return true;
        }
    }
    return false;
}

function pcode_clinical_validity_evaluate(array $payload, ?DateTimeImmutable $now = null): array
{
    $now = $now ?? new DateTimeImmutable('today');
    $warnings = [];
    $notes = [];

    $lmp = pcode_clinical_validity_parse_date(pcode_clinical_validity_pick($payload, [
        'last_menstrual_period_date', 'lmp_date', 'LMP_date',
    ]));
    $bloodDraw = pcode_clinical_validity_parse_date(pcode_clinical_validity_pick($payload, [
        'blood_draw_date', 'lab_draw_date', 'hormone_panel_date',
    ]));
    $ultrasoundDate = pcode_clinical_validity_parse_date(pcode_clinical_validity_pick($payload, [
        'ultrasound_date', 'scan_date', 'us_date',
    ]));
    $symptomDate = pcode_clinical_validity_parse_date(pcode_clinical_validity_pick($payload, [
        'symptom_evaluation_date', 'symptom_date', 'clinical_symptom_date',
    ]));

    $cycleLength = (int) (pcode_clinical_validity_pick($payload, ['Cycle_length', 'Cycle_length_days']) ?? 28);
    if ($cycleLength < 21) {
        $cycleLength = 28;
    }

    $amenorrhea = pcode_clinical_validity_is_amenorrhea($payload);

    if ($amenorrhea) {
        $notes['hormone_cycle'] = 'amenorrhea_bypass';
    } elseif ($lmp && $bloodDraw) {
        $cycleDay = pcode_clinical_validity_days_between($lmp, $bloodDraw) + 1;
        if ($cycleDay < PCODE_FOLLICULAR_DAY_MIN || $cycleDay > PCODE_FOLLICULAR_DAY_MAX) {
            $warnings[] = [
                'code' => 'follicular_window_mismatch',
                'message' => "Blood draw appears to be on cycle day {$cycleDay}; ideal baseline window is days "
                    . PCODE_FOLLICULAR_DAY_MIN . '–' . PCODE_FOLLICULAR_DAY_MAX . '.',
                'cycle_day' => $cycleDay,
            ];
        }
    } elseif ($bloodDraw && !$lmp) {
        $warnings[] = [
            'code' => 'missing_lmp',
            'message' => 'Last menstrual period date is missing; cycle-day alignment could not be verified.',
        ];
    }

    if ($lmp && $bloodDraw) {
        $expectedMidLuteal = $lmp->modify('+' . min(21, max(1, $cycleLength - 7)) . ' days');
        $progesteroneDrawDay = pcode_clinical_validity_days_between($lmp, $bloodDraw) + 1;
        $expectedDay = (int) $expectedMidLuteal->diff($lmp)->format('%a') + 1;
        $delta = abs($progesteroneDrawDay - $expectedDay);
        if ($delta > 2) {
            $warnings[] = [
                'code' => 'progesterone_timing',
                'message' => "Progesterone panel timing is {$progesteroneDrawDay} days from LMP; mid-luteal target is ~day {$expectedDay} "
                    . "(21-day standard or 7 days before predicted menses).",
            ];
        }
    }

    $fastingHours = pcode_clinical_validity_pick($payload, ['fasting_hours', 'Fasting_hours', 'fasting_hours_before_draw']);
    if ($fastingHours !== null && is_numeric($fastingHours) && (float) $fastingHours < 8) {
        $warnings[] = [
            'code' => 'non_fasting_rbs',
            'message' => 'Non-fasting baseline detected. System will flag this record to prevent insulin-resistance data skewing in XAI models.',
        ];
    }

    $labAge = $bloodDraw ? pcode_clinical_validity_days_between($bloodDraw, $now) : null;
    $usAge = $ultrasoundDate ? pcode_clinical_validity_days_between($ultrasoundDate, $now) : null;
    $symptomAge = $symptomDate ? pcode_clinical_validity_days_between($symptomDate, $now) : null;

    $expiredFields = [
        'hormone_panel' => 'Valid',
        'ultrasound' => 'Valid',
        'symptom_markers' => 'Valid',
    ];

    if (pcode_clinical_validity_has_lab_values($payload)) {
        $expiredFields['hormone_panel'] = pcode_clinical_validity_age_label($labAge, PCODE_LAB_MAX_AGE_DAYS);
        if ($labAge !== null && $labAge > PCODE_LAB_MAX_AGE_DAYS) {
            $warnings[] = [
                'code' => 'lab_expired',
                'message' => 'Hormone/metabolic panel exceeds ' . PCODE_LAB_MAX_AGE_DAYS . '-day validity.',
            ];
        }
    }

    if (pcode_clinical_validity_has_ultrasound_values($payload)) {
        $expiredFields['ultrasound'] = pcode_clinical_validity_age_label($usAge, PCODE_ULTRASOUND_MAX_AGE_DAYS);
        if ($usAge !== null && $usAge > PCODE_ULTRASOUND_MAX_AGE_DAYS) {
            $warnings[] = [
                'code' => 'ultrasound_expired',
                'message' => 'Ultrasound follicle metrics exceed ' . PCODE_ULTRASOUND_MAX_AGE_DAYS . '-day validity.',
            ];
        }
    }

    $modality = pcode_ultrasound_normalize_modality(pcode_clinical_validity_pick($payload, [
        'ultrasound_modality', 'Ultrasound_modality', 'us_modality',
    ]));
    $notes['ultrasound_modality'] = $modality;
    if ($modality === 'Transabdominal') {
        $warnings[] = [
            'code' => 'transabdominal_modality',
            'message' => 'Transabdominal/Pelvic scan selected — CNN will proceed with diminished follicle boundary resolution vs TVUS baseline.',
        ];
    } elseif ($modality === 'Other') {
        $warnings[] = [
            'code' => 'alternate_modality',
            'message' => 'Alternate pelvic imaging modality selected — feature extraction confidence may vary.',
        ];
    }

    $ultrasoundImaging = null;
    if (pcode_clinical_validity_has_ultrasound_values($payload)) {
        $ultrasoundImaging = pcode_ultrasound_build_imaging_context(
            $payload,
            ['expired_fields' => $expiredFields],
            $modality,
            null
        );
    }

    if (pcode_clinical_validity_has_symptom_values($payload)) {
        $expiredFields['symptom_markers'] = pcode_clinical_validity_age_label($symptomAge, PCODE_SYMPTOM_MAX_AGE_DAYS);
        if ($symptomAge !== null && $symptomAge > PCODE_SYMPTOM_MAX_AGE_DAYS) {
            $warnings[] = [
                'code' => 'symptom_expired',
                'message' => 'Hyperandrogenism symptom markers exceed ' . PCODE_SYMPTOM_MAX_AGE_DAYS . '-day validity.',
            ];
        }
    }

    $inferenceBlocked = ($expiredFields['hormone_panel'] !== 'Valid' && pcode_clinical_validity_has_lab_values($payload))
        || ($expiredFields['ultrasound'] !== 'Valid' && pcode_clinical_validity_has_ultrasound_values($payload));

    $actionRequired = null;
    if ($expiredFields['ultrasound'] !== 'Valid') {
        $actionRequired = 'Please update or re-order the pelvic ultrasound scan to proceed with diagnostic inference.';
    } elseif ($expiredFields['hormone_panel'] !== 'Valid') {
        $actionRequired = 'Please update or re-order baseline hormone and metabolic labs to proceed with diagnostic inference.';
    }

    return [
        'valid' => !$inferenceBlocked,
        'warnings' => $warnings,
        'notes' => $notes,
        'expired_fields' => $expiredFields,
        'inference_blocked' => $inferenceBlocked,
        'stale_response' => $inferenceBlocked ? [
            'status' => 'stale_clinical_data',
            'error' => 'Inference locked due to expired parameters.',
            'expired_fields' => $expiredFields,
            'action_required' => $actionRequired,
            'warnings' => $warnings,
            'ultrasound_imaging' => $ultrasoundImaging,
        ] : null,
        'ultrasound_imaging' => $ultrasoundImaging,
        'ultrasound_modality' => $modality,
    ];
}

function pcode_clinical_validity_follow_up(?float $confidenceScore): array
{
    if ($confidenceScore === null) {
        return [
            'window' => '12_month_routine_baseline',
            'label' => 'Schedule routine 12-month baseline re-screening.',
        ];
    }
    if ($confidenceScore >= PCODE_INFERENCE_CONFIDENCE_THRESHOLD) {
        return [
            'window' => '3_to_6_months',
            'label' => 'Recommend clinical follow-up in 3–6 months.',
        ];
    }
    return [
        'window' => '12_month_routine_baseline',
        'label' => 'Negative screening with persistent symptoms — schedule 12-month routine baseline re-screening.',
    ];
}

function pcode_clinical_validity_block_json(array $evaluation): void
{
    if (empty($evaluation['stale_response'])) {
        return;
    }
    http_response_code(409);
    echo json_encode(array_merge(['success' => false], $evaluation['stale_response']), JSON_UNESCAPED_UNICODE);
    exit;
}
