<?php
/**
 * Lab-style PMOS screening PDF — ordered for patients and clinicians:
 * 1) Patient information
 * 2) Clinical findings (Detect groups: Vitals → Hormones → Reproductive → Metabolic → Ultrasound → Symptoms)
 * 3) Top factors that influenced the clinical screening
 * 4) Ultrasound image with AI attention heatmap
 * 5) Screening results and health-expert validation
 */

function pcode_pdf_empty($html = true) {
    return $html ? '<span style="color:#888;">—</span>' : '—';
}

function pcode_pdf_esc($value) {
    return htmlspecialchars((string)$value, ENT_QUOTES, 'UTF-8');
}

function pcode_pdf_fmt($value, $decimals = null) {
    if ($value === null || $value === '' || $value === false) {
        return pcode_pdf_empty();
    }
    if (is_numeric($value) && $decimals !== null) {
        return number_format((float)$value, $decimals);
    }
    return pcode_pdf_esc($value);
}

function pcode_pdf_yn($value) {
    if ($value === null || $value === '') return pcode_pdf_empty();
    if ($value === true || $value === 1 || $value === '1' || strcasecmp((string)$value, 'yes') === 0) return 'Yes';
    if ($value === false || $value === 0 || $value === '0' || strcasecmp((string)$value, 'no') === 0) return 'No';
    return pcode_pdf_esc($value);
}

function pcode_pdf_map_dx($raw, $map = [0 => 'Negative', 1 => 'Positive', 2 => 'Borderline']) {
    if ($raw === null || $raw === '') return 'Pending';
    if (is_numeric($raw)) return $map[(int)$raw] ?? (string)$raw;
    $lower = strtolower(trim((string)$raw));
    if ($lower === '0' || $lower === 'negative') return 'Negative';
    if ($lower === '1' || $lower === 'positive') return 'Positive';
    if ($lower === '2' || $lower === 'borderline') return 'Borderline';
    return ucfirst(str_replace('_', ' ', (string)$raw));
}

function pcode_pdf_dx_plain($label) {
    $lower = strtolower(trim((string)$label));
    if ($lower === 'positive') {
        return 'Findings suggest a higher likelihood of PMOS. Clinical correlation is required.';
    }
    if ($lower === 'negative') {
        return 'Findings suggest a lower likelihood of PMOS at this time.';
    }
    if ($lower === 'borderline') {
        return 'Findings are inconclusive. Follow-up evaluation is recommended.';
    }
    if ($lower === 'pending') {
        return 'Screening result is not yet available.';
    }
    return 'Interpret together with clinical history and examination.';
}

/**
 * Blood group labels — same codes as Detect / XAI (11–18; legacy 1–8).
 */
function pcode_pdf_blood_group($raw) {
    if ($raw === null || $raw === '') return pcode_pdf_empty();
    $str = trim((string)$raw);
    if ($str === '' || $str === '0') return pcode_pdf_empty();
    // Already a letter label (O+, A-, AB+, …)
    if (preg_match('/^(A|B|AB|O)[+-]?$/i', $str)) {
        return strtoupper(str_replace(['a', 'b', 'o'], ['A', 'B', 'O'], $str));
    }
    $map = [
        11 => 'O+', 12 => 'O-', 13 => 'A+', 14 => 'A-',
        15 => 'B+', 16 => 'B-', 17 => 'AB+', 18 => 'AB-',
        // Legacy 1–8
        1 => 'O+', 2 => 'O-', 3 => 'A+', 4 => 'A-',
        5 => 'B+', 6 => 'B-', 7 => 'AB+', 8 => 'AB-',
    ];
    if (is_numeric($str)) {
        $code = (int)round((float)$str);
        if (isset($map[$code])) return $map[$code];
    }
    return pcode_pdf_esc($str);
}

/**
 * Cycle regularity — same logic as patients.html / Detect save:
 * DB numeric 0 = Regular, 1 = Irregular; also accepts text labels.
 * @return array{text:string,abnormal:bool}
 */
function pcode_pdf_cycle_regularity($raw) {
    if ($raw === null || $raw === '') {
        return ['text' => pcode_pdf_empty(), 'abnormal' => false];
    }
    $str = trim((string)$raw);
    if ($str === '') {
        return ['text' => pcode_pdf_empty(), 'abnormal' => false];
    }
    if (strcasecmp($str, 'Regular') === 0) {
        return ['text' => 'Regular', 'abnormal' => false];
    }
    if (strcasecmp($str, 'Irregular') === 0) {
        return ['text' => 'Irregular', 'abnormal' => true];
    }
    if (strcasecmp($str, 'Amenorrhea') === 0) {
        return ['text' => 'Amenorrhea', 'abnormal' => true];
    }
    if (is_numeric($str)) {
        $n = (int)round((float)$str);
        if ($n === 0) {
            return ['text' => 'Regular', 'abnormal' => false];
        }
        // Any non-zero coded value → Irregular (Detect model convention)
        return ['text' => 'Irregular', 'abnormal' => true];
    }
    return ['text' => pcode_pdf_esc($str), 'abnormal' => false];
}

function pcode_pdf_feature_label($raw) {
    $key = trim((string)$raw);
    $map = [
        'Age_yrs' => 'Age',
        'age' => 'Age',
        'Weight_kg' => 'Weight',
        'Height_cm' => 'Height',
        'BMI' => 'Body Mass Index (BMI)',
        'Blood_Group' => 'Blood Group',
        'Pulse_rate_bpm' => 'Pulse Rate',
        'Pulse_rate' => 'Pulse Rate',
        'RR_breath_min' => 'Respiratory Rate',
        'RR_breath' => 'Respiratory Rate',
        'Hb_g_dl' => 'Hemoglobin',
        'Hemoglobin' => 'Hemoglobin',
        'Waist_inch' => 'Waist Circumference',
        'Hip_inch' => 'Hip Circumference',
        'Waist_hip_ratio' => 'Waist–Hip Ratio',
        'LH_mIU_mL' => 'LH (Luteinizing Hormone)',
        'LH_level' => 'LH (Luteinizing Hormone)',
        'FSH_mIU_mL' => 'FSH (Follicle-Stimulating Hormone)',
        'FSH_level' => 'FSH (Follicle-Stimulating Hormone)',
        'FSH_LH' => 'LH/FSH Ratio',
        'LH_FSH_Ratio' => 'LH/FSH Ratio',
        'AMH_ng_mL' => 'AMH (Anti-Müllerian Hormone)',
        'AMH_level' => 'AMH (Anti-Müllerian Hormone)',
        'PRL_ng_mL' => 'Prolactin (PRL)',
        'PRL_level' => 'Prolactin (PRL)',
        'TSH_mIU_L' => 'TSH (Thyroid-Stimulating Hormone)',
        'TSH_level' => 'TSH (Thyroid-Stimulating Hormone)',
        'Vit_D3_ng_mL' => 'Vitamin D3',
        'Vitamin_D3_level' => 'Vitamin D3',
        'I_beta_HCG_mIU_mL' => 'β-hCG (I)',
        'II_beta_HCG_mIU_mL' => 'β-hCG (II)',
        'Cycle_length_days' => 'Menstrual Cycle Length',
        'Cycle_length' => 'Menstrual Cycle Length',
        'CycleR_I' => 'Cycle Regularity',
        'Cycle' => 'Cycle Regularity',
        'Marriage_Status_years' => 'Years Married',
        'Pregnant' => 'Currently Pregnant',
        'No_of_abortions' => 'Number of Abortions',
        'RBS_mg_dl' => 'Random Blood Sugar (RBS)',
        'RBS' => 'Random Blood Sugar (RBS)',
        'PRG_ng_mL' => 'Progesterone',
        'Progesterone_level' => 'Progesterone',
        'BP_Systolic_mmHg' => 'Blood Pressure (Systolic)',
        'BP_Diastolic_mmHg' => 'Blood Pressure (Diastolic)',
        'Follicle_no_L' => 'Follicle Count (Left Ovary)',
        'Follicle_no_R' => 'Follicle Count (Right Ovary)',
        'Avg_F_size_L_mm' => 'Average Follicle Size (Left)',
        'Avg_F_size_R_mm' => 'Average Follicle Size (Right)',
        'Endometrium_mm' => 'Endometrial Thickness',
        'ultrasound_modality' => 'Ultrasound Modality',
        'Weight_gain' => 'Unexplained Weight Gain',
        'Hair_growth' => 'Excess Hair Growth (Hirsutism)',
        'Skin_darkening' => 'Skin Darkening',
        'Hair_loss' => 'Hair Loss',
        'Pimples' => 'Acne / Pimples',
        'Fast_food' => 'Regular Fast-Food Intake',
        'Reg_Exercise' => 'Regular Exercise',
    ];
    if (isset($map[$key])) return $map[$key];
    $pretty = preg_replace('/[_]+/', ' ', $key);
    $pretty = preg_replace('/\b(mm|cm|kg|ng|mIU|mL|dl)\b/i', '', $pretty);
    $pretty = trim(preg_replace('/\s+/', ' ', (string)$pretty));
    return $pretty !== '' ? ucwords(strtolower($pretty)) : 'Clinical Parameter';
}

function pcode_pdf_abnormal_html($text, $flag = '') {
    $safe = is_string($text) && strpos($text, '<') !== false ? $text : pcode_pdf_esc($text);
    $flagHtml = $flag !== '' ? ' <span style="color:#cc0000;font-weight:bold;">' . pcode_pdf_esc($flag) . '</span>' : '';
    return '<span style="color:#cc0000;font-weight:bold;">' . $safe . '</span>' . $flagHtml;
}

function pcode_pdf_result_row($analyte, $result, $unit = '', $ref = '', $abnormal = false, $flag = '') {
    $analyteEsc = pcode_pdf_esc($analyte);
    $unitEsc = pcode_pdf_esc((string)$unit);
    $refEsc = $ref === '' ? pcode_pdf_empty() : (strpos((string)$ref, '<') !== false ? $ref : pcode_pdf_esc($ref));
    if ($abnormal) {
        $resultHtml = pcode_pdf_abnormal_html($result, $flag);
    } else if (strpos((string)$result, '<') !== false) {
        $resultHtml = $result;
    } else {
        $resultHtml = pcode_pdf_esc($result);
    }
    return '<tr>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:34%;">' . $analyteEsc . '</td>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:22%;">' . $resultHtml . '</td>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:16%;">' . ($unitEsc !== '' ? $unitEsc : pcode_pdf_empty()) . '</td>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:28%;">' . $refEsc . '</td>'
        . '</tr>';
}

function pcode_pdf_info_row($label, $value) {
    return '<tr>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:38%;color:#333;">' . pcode_pdf_esc($label) . '</td>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:62%;"><strong>' . (strpos((string)$value, '<') !== false ? $value : pcode_pdf_esc($value)) . '</strong></td>'
        . '</tr>';
}

function pcode_pdf_group_row($title, $cols = 4) {
    $t = pcode_pdf_esc($title);
    return '<tr class="pcode-group-row"><td colspan="' . (int)$cols . '" class="pcode-group-cell" style="padding:5px 4px;font-size:10px;font-weight:bold;border-top:0.5px solid #666;border-bottom:0.5px solid #666;border-left:none;border-right:none;background:transparent;letter-spacing:0.2px;">' . $t . '</td></tr>';
}

/**
 * Two-column screening result row (Result Item | Finding).
 */
function pcode_pdf_dx_row($label, $finding, $abnormal = false, $flag = '') {
    $labelEsc = pcode_pdf_esc($label);
    if ($abnormal) {
        $findingHtml = pcode_pdf_abnormal_html($finding, $flag);
    } else if (strpos((string)$finding, '<') !== false) {
        $findingHtml = $finding;
    } else {
        $findingHtml = pcode_pdf_esc($finding);
    }
    return '<tr>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:55%;">' . $labelEsc . '</td>'
        . '<td style="padding:3px 4px;border:none;font-size:10px;width:45%;">' . $findingHtml . '</td>'
        . '</tr>';
}

/**
 * Blank OB-GYN final-diagnosis row (manual mark after each AI likelihood score).
 */
function pcode_pdf_ob_final_dx_row($label) {
    $labelEsc = pcode_pdf_esc($label);
    $choices = '[ ] Negative    [ ] Borderline    [ ] Positive';
    return '<tr class="pcode-ob-final-row">'
        . '<td style="padding:5px 4px;border:none;border-top:0.5px solid #999;border-bottom:0.5px solid #999;font-size:10px;font-weight:bold;width:55%;background:transparent;">' . $labelEsc . '</td>'
        . '<td style="padding:5px 4px;border:none;border-top:0.5px solid #999;border-bottom:0.5px solid #999;font-size:9px;width:45%;background:transparent;">' . pcode_pdf_esc($choices) . '</td>'
        . '</tr>';
}

function pcode_pdf_pick($patient, $keys, $decimals = null, $yn = false) {
    foreach ((array)$keys as $k) {
        if (array_key_exists($k, $patient) && $patient[$k] !== null && $patient[$k] !== '') {
            return $yn ? pcode_pdf_yn($patient[$k]) : pcode_pdf_fmt($patient[$k], $decimals);
        }
    }
    return pcode_pdf_empty();
}

function pcode_pdf_img_src($raw) {
    if (!$raw || !is_string($raw)) return '';
    $raw = trim($raw);
    if ($raw === '') return '';
    if (stripos($raw, 'data:image') === 0) return $raw;
    if (preg_match('/^[A-Za-z0-9+\/=\s]+$/', substr($raw, 0, 64))) {
        return 'data:image/jpeg;base64,' . preg_replace('/\s+/', '', $raw);
    }
    return $raw;
}

/**
 * Generate comprehensive HTML report
 */
function generateComprehensiveReport($patient, $shap_data = null, $user_name = 'Healthcare Professional') {
    if (function_exists('date_default_timezone_set')) {
        date_default_timezone_set('Asia/Manila');
    }
    $pidNum = preg_replace('/\D+/', '', (string)($patient['patient_id'] ?? ''));
    if ($pidNum === '') $pidNum = '000';
    $patient_id_formatted = 'PMOS-' . str_pad($pidNum, 3, '0', STR_PAD_LEFT);

    $diagnosis = pcode_pdf_map_dx($patient['Overall_diagnosis'] ?? $patient['overall_diagnosis'] ?? 'Pending');
    $confidence = number_format((float)($patient['Overall_diagnosis_probability_percentage'] ?? $patient['overall_diagnosis_percentage'] ?? 0), 1);

    $dob_display = '—';
    if (!empty($patient['date_of_birth']) && $patient['date_of_birth'] !== '0000-00-00') {
        $dob_display = date('d M Y', strtotime($patient['date_of_birth']));
    }

    $released = date('d M Y g:i A');
    // Prefer screening TIMESTAMP (history run time) over patient row dates
    $sampleSource = $patient['screening_created_at']
        ?? $patient['created_at']
        ?? $patient['last_screened_at']
        ?? $patient['history_created_at']
        ?? $patient['updated_at']
        ?? null;
    $sample_received = !empty($sampleSource)
        ? date('d M Y g:i A', strtotime((string) $sampleSource))
        : (!empty($patient['date_added']) ? date('d M Y g:i A', strtotime($patient['date_added'])) : $released);

    $logo_dir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'resources' . DIRECTORY_SEPARATOR;
    $logo_path = is_readable($logo_dir . 'PCODE_LOGO_pdf.png')
        ? $logo_dir . 'PCODE_LOGO_pdf.png'
        : $logo_dir . 'PCODE_LOGO.png';
    $logo_html = '';
    if (is_readable($logo_path)) {
        // Prefer compact PDF asset; embed as data URI so the converter always finds it
        $logo_html = '<img class="brand-logo" src="data:image/png;base64,'
            . base64_encode((string) file_get_contents($logo_path))
            . '" alt="P-Code" width="48" height="48" />';
    }

    $patient_name = strtoupper(trim((string)($patient['patient_name'] ?? 'UNKNOWN PATIENT')));
    $patient_name_esc = pcode_pdf_esc($patient_name);
    $age = $patient['age'] ?? $patient['Age_yrs'] ?? '—';
    $age_esc = pcode_pdf_esc((string)$age);
    $gender = !empty($patient['gender']) ? strtoupper((string)$patient['gender']) : 'F';
    $gender_esc = pcode_pdf_esc($gender);
    $referring = trim((string)($patient['reffered_by'] ?? $patient['referred_by'] ?? ''));
    if ($referring === '') $referring = '—';
    $referring_esc = pcode_pdf_esc($referring);

    $recsRaw = trim((string)($patient['clinical_recommendations'] ?? $patient['recommendations'] ?? ''));
    // Ruled blank lines for wet-ink / handwritten recommendations
    $wetInkLine = '_______________________________________________________________';
    $wetInkCount = $recsRaw !== '' ? 10 : 12;
    $wetInkBlock = '<p style="font-size:10px;line-height:2.05;margin:0;">'
        . implode('<br/>', array_fill(0, $wetInkCount, $wetInkLine))
        . '</p>';
    if ($recsRaw !== '') {
        $recsLines = preg_split('/\R/u', $recsRaw) ?: [];
        $recsEscLines = array_map('pcode_pdf_esc', $recsLines);
        $recs_body_html = '<p style="font-size:10px;line-height:1.45;margin:0 0 12px 0;">'
            . implode('<br/>', $recsEscLines)
            . '</p>'
            . $wetInkBlock;
    } else {
        $recs_body_html = $wetInkBlock;
    }
    $contact = trim((string)($patient['contact_no'] ?? ''));
    if ($contact === '') $contact = '—';
    $contact_esc = pcode_pdf_esc($contact);
    $address = trim((string)($patient['address'] ?? ''));
    if ($address === '') $address = '—';
    $civilRaw = $patient['civil_status'] ?? '';
    $civilMap = [
        '0' => '—', 0 => '—',
        '1' => 'Single', 1 => 'Single',
        '2' => 'Married', 2 => 'Married',
        '3' => 'Widowed', 3 => 'Widowed',
        '4' => 'Separated', 4 => 'Separated',
        'single' => 'Single', 'married' => 'Married',
        'widowed' => 'Widowed', 'separated' => 'Separated',
    ];
    if ($civilRaw === null || $civilRaw === '') {
        $civil = '—';
    } else if (isset($civilMap[$civilRaw])) {
        $civil = $civilMap[$civilRaw];
    } else if (isset($civilMap[strtolower(trim((string)$civilRaw))])) {
        $civil = $civilMap[strtolower(trim((string)$civilRaw))];
    } else {
        $civil = trim((string)$civilRaw);
        if ($civil === '') $civil = '—';
    }
    $occupation = trim((string)($patient['occupation'] ?? ''));
    if ($occupation === '') $occupation = '—';
    $religion = trim((string)($patient['religion'] ?? ''));
    if ($religion === '') $religion = '—';
    $dob_esc = pcode_pdf_esc($dob_display);
    $sample_esc = pcode_pdf_esc($sample_received);
    $released_esc = pcode_pdf_esc($released);

    $clinical_score = $patient['XGBoost_diagnosis_probability_percentage'] ?? $patient['clinical_score_percentage'] ?? null;
    $imaging_score = $patient['CNN_diagnosis_probability_percentage'] ?? $patient['imaging_score_percentage'] ?? null;
    $final_score = $patient['Overall_diagnosis_probability_percentage'] ?? $patient['overall_diagnosis_percentage'] ?? null;
    $xgboost_dx = pcode_pdf_map_dx($patient['XGBoost_diagnosis'] ?? $patient['xgboost_diagnosis'] ?? $patient['clinical_diagnosis'] ?? '');
    $cnn_dx = pcode_pdf_map_dx($patient['CNN_diagnosis'] ?? $patient['cnn_diagnosis'] ?? $patient['imaging_diagnosis'] ?? '');
    $final_dx = pcode_pdf_map_dx($patient['Overall_diagnosis'] ?? $patient['overall_diagnosis'] ?? $diagnosis);
    $is_pos = (stripos($final_dx, 'Positive') !== false);
    $is_border = (stripos($final_dx, 'Borderline') !== false);
    $final_dx_cell = ($is_pos || $is_border)
        ? pcode_pdf_abnormal_html($final_dx, $is_pos ? '▲' : '')
        : pcode_pdf_esc($final_dx);
    $final_plain = pcode_pdf_esc(pcode_pdf_dx_plain($final_dx));

    // ---- 1. Patient information (label / value) ----
    $personal_rows = '';
    $personal_rows .= pcode_pdf_info_row('Patient ID', $patient_id_formatted);
    $personal_rows .= pcode_pdf_info_row('Full Name', $patient_name);
    $personal_rows .= pcode_pdf_info_row('Date of Birth', $dob_display);
    $personal_rows .= pcode_pdf_info_row('Age', is_numeric($age) ? $age . ' years' : (string)$age);
    $personal_rows .= pcode_pdf_info_row('Sex / Gender', $gender);
    $personal_rows .= pcode_pdf_info_row('Contact Number', $contact);
    $personal_rows .= pcode_pdf_info_row('Address', $address);
    $personal_rows .= pcode_pdf_info_row('Civil Status', $civil);
    $personal_rows .= pcode_pdf_info_row('Occupation', $occupation);
    $personal_rows .= pcode_pdf_info_row('Religion', $religion);
    $personal_rows .= pcode_pdf_info_row('Referring Physician', $referring);

    // ---- 2. Clinical findings by Detect groups ----
    $clinical_rows = '';

    $clinical_rows .= pcode_pdf_group_row('A. Vitals & Body Measurements');
    $bmi = $patient['BMI'] ?? null;
    $bmi_abn = is_numeric($bmi) && ((float)$bmi >= 25);
    $clinical_rows .= pcode_pdf_result_row('Weight', pcode_pdf_pick($patient, ['Weight_kg', 'weight_kg'], 1), 'kg', '');
    $clinical_rows .= pcode_pdf_result_row('Height', pcode_pdf_pick($patient, ['Height_cm', 'height_cm'], 1), 'cm', '');
    $clinical_rows .= pcode_pdf_result_row('Body Mass Index (BMI)', pcode_pdf_fmt($bmi, 1), 'kg/m²', '18.5 – 24.9 (normal)', $bmi_abn, $bmi_abn ? '▲' : '');
    $clinical_rows .= pcode_pdf_result_row('Blood Group', pcode_pdf_blood_group($patient['Blood_Group'] ?? $patient['blood_group'] ?? null), '', '');
    $clinical_rows .= pcode_pdf_result_row('Pulse Rate', pcode_pdf_pick($patient, ['Pulse_rate_bpm', 'Pulse_rate', 'pulse_rate']), 'bpm', '60 – 100');
    $clinical_rows .= pcode_pdf_result_row('Respiratory Rate', pcode_pdf_pick($patient, ['RR_breath_min', 'RR_breath', 'rr_breath']), 'breaths/min', '12 – 20');
    $clinical_rows .= pcode_pdf_result_row('Hemoglobin', pcode_pdf_pick($patient, ['Hb_g_dl', 'Hemoglobin', 'hemoglobin'], 1), 'g/dL', '12.0 – 15.5');
    $clinical_rows .= pcode_pdf_result_row('Waist Circumference', pcode_pdf_pick($patient, ['Waist_inch', 'waist_inch'], 1), 'in', '');
    $clinical_rows .= pcode_pdf_result_row('Hip Circumference', pcode_pdf_pick($patient, ['Hip_inch', 'hip_inch'], 1), 'in', '');
    $clinical_rows .= pcode_pdf_result_row('Waist–Hip Ratio', pcode_pdf_pick($patient, ['Waist_hip_ratio', 'waist_hip_ratio'], 2), '', '');

    $clinical_rows .= pcode_pdf_group_row('B. Hormone Levels');
    $clinical_rows .= pcode_pdf_result_row('LH (Luteinizing Hormone)', pcode_pdf_pick($patient, ['LH_mIU_mL', 'LH_level', 'lh_level'], 2), 'mIU/mL', 'Varies by cycle day');
    $clinical_rows .= pcode_pdf_result_row('FSH (Follicle-Stimulating Hormone)', pcode_pdf_pick($patient, ['FSH_mIU_mL', 'FSH_level', 'fsh_level'], 2), 'mIU/mL', 'Varies by cycle day');
    $clinical_rows .= pcode_pdf_result_row('LH/FSH Ratio', pcode_pdf_pick($patient, ['LH_FSH_Ratio', 'lh_fsh_ratio', 'FSH_LH'], 2), '', 'Often elevated in PMOS');
    $clinical_rows .= pcode_pdf_result_row('AMH (Anti-Müllerian Hormone)', pcode_pdf_pick($patient, ['AMH_ng_mL', 'AMH_level', 'amh_level'], 2), 'ng/mL', 'Age-dependent');
    $clinical_rows .= pcode_pdf_result_row('Prolactin (PRL)', pcode_pdf_pick($patient, ['PRL_ng_mL', 'PRL_level', 'prl_level'], 2), 'ng/mL', '4.8 – 23.3');
    $clinical_rows .= pcode_pdf_result_row('TSH (Thyroid-Stimulating Hormone)', pcode_pdf_pick($patient, ['TSH_mIU_L', 'TSH_level', 'tsh_level'], 2), 'mIU/L', '0.4 – 4.0');
    $clinical_rows .= pcode_pdf_result_row('Vitamin D3', pcode_pdf_pick($patient, ['Vit_D3_ng_mL', 'Vitamin_D3_level', 'vitamin_d3_level'], 2), 'ng/mL', '30 – 100');
    $clinical_rows .= pcode_pdf_result_row('β-hCG (First reading)', pcode_pdf_pick($patient, ['I_beta_HCG_mIU_mL', 'I_Beta_HCG', 'i_beta_hcg'], 2), 'mIU/mL', '');
    $clinical_rows .= pcode_pdf_result_row('β-hCG (Second reading)', pcode_pdf_pick($patient, ['II_beta_HCG_mIU_mL', 'II_Beta_HCG', 'ii_beta_hcg'], 2), 'mIU/mL', '');
    $clinical_rows .= pcode_pdf_result_row('Blood Draw Date', pcode_pdf_pick($patient, ['blood_draw_date']), '', '');
    $clinical_rows .= pcode_pdf_result_row('Last Menstrual Period (LMP)', pcode_pdf_pick($patient, ['last_menstrual_period_date', 'LMP']), '', '');

    $clinical_rows .= pcode_pdf_group_row('C. Reproductive History');
    $cycle_reg = $patient['CycleR_I'] ?? $patient['Cycle_R_I'] ?? $patient['Cycle'] ?? $patient['Cycle_regularity'] ?? $patient['cycle_regularity'] ?? null;
    $cycle_mapped = pcode_pdf_cycle_regularity($cycle_reg);
    $clinical_rows .= pcode_pdf_result_row('Menstrual Cycle Length', pcode_pdf_pick($patient, ['Cycle_length_days', 'Cycle_length', 'cycle_length']), 'days', '21 – 35');
    $clinical_rows .= pcode_pdf_result_row(
        'Cycle Regularity',
        $cycle_mapped['text'],
        '',
        '',
        $cycle_mapped['abnormal'],
        $cycle_mapped['abnormal'] ? '▲' : ''
    );
    $clinical_rows .= pcode_pdf_result_row('Years Married', pcode_pdf_pick($patient, ['Marriage_Status_years', 'Marriage_duration', 'marriage_duration']), 'years', '');
    $preg = $patient['Pregnant'] ?? $patient['Pregnant_status'] ?? null;
    $clinical_rows .= pcode_pdf_result_row('Currently Pregnant', pcode_pdf_yn($preg), '', '');
    $clinical_rows .= pcode_pdf_result_row('Number of Abortions', pcode_pdf_pick($patient, ['No_of_abortions', 'No_abortions', 'no_abortions']), '', '');

    $clinical_rows .= pcode_pdf_group_row('D. Metabolic Markers');
    $clinical_rows .= pcode_pdf_result_row('Random Blood Sugar (RBS)', pcode_pdf_pick($patient, ['RBS_mg_dl', 'RBS', 'rbs'], 1), 'mg/dL', '70 – 140');
    $clinical_rows .= pcode_pdf_result_row('Hours Fasting Before RBS', pcode_pdf_pick($patient, ['fasting_hours']), 'hours', '');
    $clinical_rows .= pcode_pdf_result_row('Progesterone', pcode_pdf_pick($patient, ['PRG_ng_mL', 'Progesterone_level', 'progesterone_level'], 2), 'ng/mL', 'Varies by cycle day');
    $clinical_rows .= pcode_pdf_result_row('Blood Pressure — Systolic', pcode_pdf_pick($patient, ['BP_Systolic_mmHg', 'BP_systolic', 'bp_systolic']), 'mmHg', '< 120');
    $clinical_rows .= pcode_pdf_result_row('Blood Pressure — Diastolic', pcode_pdf_pick($patient, ['BP_Diastolic_mmHg', 'BP_diastolic', 'bp_diastolic']), 'mmHg', '< 80');

    $clinical_rows .= pcode_pdf_group_row('E. Ultrasound Measurements');
    $clinical_rows .= pcode_pdf_result_row('Ultrasound Scan Date', pcode_pdf_pick($patient, ['ultrasound_date']), '', '');
    $clinical_rows .= pcode_pdf_result_row('Imaging Modality', pcode_pdf_pick($patient, ['ultrasound_modality', 'Ultrasound_modality']), '', 'TVUS preferred');
    $clinical_rows .= pcode_pdf_result_row('Follicle Count — Left Ovary', pcode_pdf_pick($patient, ['Follicle_no_L', 'follicle_no_L']), '', '≤ 12 typical');
    $clinical_rows .= pcode_pdf_result_row('Follicle Count — Right Ovary', pcode_pdf_pick($patient, ['Follicle_no_R', 'follicle_no_R']), '', '≤ 12 typical');
    $clinical_rows .= pcode_pdf_result_row('Average Follicle Size — Left', pcode_pdf_pick($patient, ['Avg_F_size_L_mm', 'Avg_F_size_L', 'avg_f_size_L'], 1), 'mm', '');
    $clinical_rows .= pcode_pdf_result_row('Average Follicle Size — Right', pcode_pdf_pick($patient, ['Avg_F_size_R_mm', 'Avg_F_size_R', 'avg_f_size_R'], 1), 'mm', '');
    $clinical_rows .= pcode_pdf_result_row('Endometrial Thickness', pcode_pdf_pick($patient, ['Endometrium_mm', 'endometrium_mm'], 1), 'mm', '');

    $clinical_rows .= pcode_pdf_group_row('F. Symptoms & Lifestyle');
    $clinical_rows .= pcode_pdf_result_row('Unexplained Weight Gain', pcode_pdf_yn($patient['Weight_gain'] ?? null), '', 'Yes / No');
    $clinical_rows .= pcode_pdf_result_row('Excess Hair Growth (Hirsutism)', pcode_pdf_yn($patient['Hair_growth'] ?? null), '', 'Yes / No');
    $clinical_rows .= pcode_pdf_result_row('Skin Darkening', pcode_pdf_yn($patient['Skin_darkening'] ?? null), '', 'Yes / No');
    $clinical_rows .= pcode_pdf_result_row('Hair Loss', pcode_pdf_yn($patient['Hair_loss'] ?? null), '', 'Yes / No');
    $clinical_rows .= pcode_pdf_result_row('Acne / Pimples', pcode_pdf_yn($patient['Pimples'] ?? null), '', 'Yes / No');
    $clinical_rows .= pcode_pdf_result_row('Regular Fast-Food Intake', pcode_pdf_yn($patient['Fast_food'] ?? null), '', 'Yes / No');
    $clinical_rows .= pcode_pdf_result_row('Regular Exercise', pcode_pdf_yn($patient['Reg_Exercise'] ?? null), '', 'Yes / No');

    // ---- 3. Top influencing factors (SHAP, plain language) ----
    $shap_rows = '';
    $shap_rows .= '<tr>'
        . '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;border-right:none;font-size:9px;font-weight:bold;width:8%;background:transparent;">RANK</th>'
        . '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;border-right:none;font-size:9px;font-weight:bold;width:42%;background:transparent;">CLINICAL PARAMETER</th>'
        . '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;border-right:none;font-size:9px;font-weight:bold;width:20%;background:transparent;">CONTRIBUTION</th>'
        . '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;border-right:none;font-size:9px;font-weight:bold;width:30%;background:transparent;">HOW IT AFFECTED THE RESULT</th>'
        . '</tr>';
    if (!empty($shap_data['top_contributions']) && is_array($shap_data['top_contributions'])) {
        $i = 0;
        foreach ($shap_data['top_contributions'] as $contrib) {
            if ($i >= 10) break;
            $featRaw = $contrib['feature'] ?? ('Feature ' . ($i + 1));
            $feat = pcode_pdf_feature_label($featRaw);
            $svNum = (float)($contrib['shap_value'] ?? 0);
            $sv = isset($contrib['shap_value']) ? number_format($svNum, 4) : '—';
            $pos = $svNum >= 0;
            $dir = $pos
                ? 'Increased likelihood of a positive screen'
                : 'Decreased likelihood (protective)';
            $shap_rows .= '<tr>'
                . '<td style="padding:3px 4px;border:none;font-size:10px;">' . ($i + 1) . '</td>'
                . '<td style="padding:3px 4px;border:none;font-size:10px;">' . pcode_pdf_esc($feat) . '</td>'
                . '<td style="padding:3px 4px;border:none;font-size:10px;">'
                . ($pos ? pcode_pdf_abnormal_html($sv, '▲') : ('<span style="color:#0a6;">' . pcode_pdf_esc($sv) . ' ▼</span>'))
                . '</td>'
                . '<td style="padding:3px 4px;border:none;font-size:9px;color:#333;">' . pcode_pdf_esc($dir) . '</td>'
                . '</tr>';
            $i++;
        }
    } else {
        $shap_rows .= '<tr><td colspan="4" style="padding:8px 6px;font-size:11px;color:#555;">'
            . 'Top contributing factors are not available for this report. They appear after clinical analysis is completed.'
            . '</td></tr>';
    }

    // ---- 4. Imaging ----
    $us_src = pcode_pdf_img_src($patient['Ultrasound_image'] ?? $patient['ultrasound_image'] ?? '');
    $gc_src = pcode_pdf_img_src(
        $patient['gradcam_visualization']
        ?? $patient['gradcam_image']
        ?? $patient['GradCAM_image']
        ?? ''
    );
    $imaging_html = '';
    if ($us_src !== '' || $gc_src !== '') {
        $imaging_html .= '<table style="width:100%;border-collapse:collapse;margin-top:6px;"><tr>';
        if ($us_src !== '') {
            $imaging_html .= '<td style="width:50%;padding:6px;text-align:center;vertical-align:top;">'
                . '<p style="font-size:10px;font-weight:bold;margin-bottom:6px;">ULTRASOUND IMAGE</p>'
                . '<img class="pcode-pdf-img" src="' . pcode_pdf_esc($us_src) . '" alt="Ultrasound" style="max-width:100%;max-height:280px;border:1px solid #ccc;" />'
                . '<p style="font-size:9px;color:#555;margin-top:4px;">Original scan submitted for review</p>'
                . '</td>';
        }
        if ($gc_src !== '') {
            $imaging_html .= '<td style="width:50%;padding:6px;text-align:center;vertical-align:top;">'
                . '<p style="font-size:10px;font-weight:bold;margin-bottom:6px;">AI ATTENTION MAP (EigenCAM)</p>'
                . '<img class="pcode-pdf-img" src="' . pcode_pdf_esc($gc_src) . '" alt="AI attention heatmap" style="max-width:100%;max-height:280px;border:1px solid #ccc;" />'
                . '<p style="font-size:9px;color:#555;margin-top:4px;">Warmer colors = areas the imaging model focused on</p>'
                . '</td>';
        } else if ($us_src !== '') {
            $imaging_html .= '<td style="width:50%;padding:6px;text-align:center;vertical-align:top;color:#666;font-size:10px;">'
                . '<p style="font-size:10px;font-weight:bold;margin-bottom:6px;">AI ATTENTION MAP (EigenCAM)</p>'
                . 'Heatmap was not available for this export. Complete imaging analysis in XAI Insights to include it.'
                . '</td>';
        }
        $imaging_html .= '</tr></table>';
        $imaging_html .= '<p class="note">For patients: the colored overlay does not mean disease by itself — it shows which parts of the image most influenced the AI. For clinicians: correlate with follicle morphology and clinical findings before counseling.</p>';
    } else {
        $imaging_html = '<p class="note">No ultrasound image was attached to this report.</p>';
    }

    // ---- 5. Screening results (Result Item | Finding only) ----
    $dx_rows = '';
    $clin_abn = stripos($xgboost_dx, 'Positive') !== false || stripos($xgboost_dx, 'Borderline') !== false;
    $img_abn = stripos($cnn_dx, 'Positive') !== false || stripos($cnn_dx, 'Borderline') !== false;
    $clin_pct = is_numeric($clinical_score) ? number_format((float)$clinical_score, 1) . '%' : pcode_pdf_empty();
    $img_pct = is_numeric($imaging_score) ? number_format((float)$imaging_score, 1) . '%' : pcode_pdf_empty();
    $comb_pct = is_numeric($final_score) ? number_format((float)$final_score, 1) . '%' : pcode_pdf_empty();
    $dx_rows .= pcode_pdf_dx_row(
        'Clinical Screening Result (AI)',
        $xgboost_dx,
        $clin_abn,
        stripos($xgboost_dx, 'Positive') !== false ? '▲' : ''
    );
    $dx_rows .= pcode_pdf_dx_row('Clinical Likelihood Score', $clin_pct);
    $dx_rows .= pcode_pdf_ob_final_dx_row('Clinical Final Diagnosis (OB-GYN)');
    $dx_rows .= pcode_pdf_dx_row(
        'Ultrasound / Imaging Screening Result (AI)',
        $cnn_dx,
        $img_abn,
        stripos($cnn_dx, 'Positive') !== false ? '▲' : ''
    );
    $dx_rows .= pcode_pdf_dx_row('Ultrasound / Imaging Likelihood Score', $img_pct);
    $dx_rows .= pcode_pdf_ob_final_dx_row('Ultrasound Final Diagnosis (OB-GYN)');
    $dx_rows .= pcode_pdf_dx_row(
        'Combined Screening Result (AI)',
        $final_dx_cell,
        $is_pos || $is_border,
        $is_pos ? '▲' : ''
    );
    $dx_rows .= pcode_pdf_dx_row('Combined Likelihood Score', $comb_pct);
    $dx_rows .= pcode_pdf_ob_final_dx_row('Combined Final Diagnosis (OB-GYN)');

    $html = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>PMOS Screening Report — {$patient_id_formatted}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; font-size: 10px; line-height: 1.35; }
  .container { max-width: 800px; margin: 0 auto; padding: 14px 18px 22px; background: #fff; }
  .section { margin: 0 0 12px; padding: 0; border: none; page-break-inside: avoid; }
  .section-cover { border: none; padding: 0; margin-bottom: 10px; }
  .rule { border: none; border-top: 1px solid #000; margin: 6px 0; }
  .rule-thick { border: none; border-top: 1.5px solid #000; margin: 8px 0; }
  .lab-header { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  .lab-header td { vertical-align: top; padding: 0; }
  .brand-logo { width: 48px; height: 48px; display: block; }
  .brand-name { font-size: 16px; font-weight: 700; letter-spacing: 0.3px; color: #5b2d8e; }
  .brand-sub { font-size: 10px; color: #333; margin-top: 2px; }
  .clinic-meta { text-align: right; font-size: 9px; line-height: 1.35; color: #222; }
  .clinic-meta strong { font-size: 10px; display: block; margin-bottom: 2px; }
  .patient-grid { width: 100%; border-collapse: collapse; }
  .patient-grid td { width: 50%; vertical-align: top; padding: 1px 6px 1px 0; font-size: 9px; }
  .results { width: 100%; border-collapse: collapse; border: none; }
  .results th { text-align: left; font-size: 9px; font-weight: 700; padding: 4px; border-top: 1px solid #000; border-bottom: 1px solid #000; border-left: none; border-right: none; background: transparent; text-transform: uppercase; }
  .results td { border: none; }
  .results tr.pcode-group-row td { border-top: 0.5px solid #666; border-bottom: 0.5px solid #666; border-left: none; border-right: none; background: transparent; }
  .section-title { font-size: 11px; font-weight: 700; margin: 0 0 4px; border: none; border-top: 1px solid #000; border-bottom: 1px solid #000; background: transparent; padding: 4px 0; }
  .section-help { font-size: 8.5px; color: #444; margin: 0 0 5px; line-height: 1.35; }
  .note { font-size: 8.5px; color: #333; margin: 5px 0; }
  .disclaimer { font-size: 8.5px; color: #333; margin: 6px 0; text-align: center; font-style: italic; }
  .important { font-size: 9px; margin-top: 6px; }
  .plain-box { border: none; border-top: 0.6px solid #666; border-bottom: 0.6px solid #666; background: transparent; padding: 6px 2px; margin-top: 6px; font-size: 9px; }
  .sign-table { width: 100%; border-collapse: collapse; margin-top: 8px; border: none; }
  .sign-table td { width: 100%; vertical-align: top; text-align: left; padding: 4px 2px; font-size: 9px; border: none; line-height: 1.4; }
  .sign-line { border-top: 1px solid #000; width: 80%; margin: 28px auto 6px; }
  .flags { font-size: 9px; margin-top: 10px; }
  .computer { font-size: 10px; font-weight: 700; text-align: center; margin-top: 10px; letter-spacing: 0.4px; }
  .page-no { font-size: 9px; text-align: right; margin-top: 4px; }
  @media print { body { background: #fff; } .container { box-shadow: none; max-width: none; } }
</style>
</head>
<body>
<div class="container">

<div class="section" data-section="cover">
  <table class="lab-header pcode-system-header">
    <tr>
      <td style="width:58%;">
        <table style="border-collapse:collapse;border:none;"><tr>
          <td style="vertical-align:middle;padding:0 8px 0 0;border:none;width:56px;">{$logo_html}</td>
          <td style="vertical-align:middle;padding:0;border:none;">
            <div class="brand-name">P-Code</div>
            <div class="brand-sub">PMOS Clinical Decision Support System</div>
            <div class="brand-sub">AI-assisted screening report for Polyendocrine Metabolic Ovarian Syndrome (PMOS)</div>
          </td>
        </tr></table>
      </td>
      <td class="clinic-meta" style="width:42%;">
        <strong>FOR PATIENT AND PHYSICIAN REVIEW</strong>
        Generated: {$released_esc}<br>
        Report ID: {$patient_id_formatted}
      </td>
    </tr>
  </table>
  <hr class="rule">
  <p class="disclaimer note">This report summarizes screening inputs and AI-assisted results to support clinical discussion. It is not a standalone medical diagnosis.</p>
  <hr class="rule">
</div>

<div class="section" data-section="patient">
  <h2 class="section-title">1. Patient Information</h2>
  <table class="results">
    {$personal_rows}
  </table>
</div>

<div class="section" data-section="clinical">
  <h2 class="section-title">2. Clinical Findings</h2>
  <table class="results">
    <tr><th style="width:34%;">PARAMETER</th><th style="width:22%;">RESULT</th><th style="width:16%;">UNIT</th><th style="width:28%;">REFERENCE / NOTE</th></tr>
    {$clinical_rows}
  </table>
</div>

<div class="section" data-section="shap">
  <h2 class="section-title">3. Top 10 Factors Influencing the Clinical Screening</h2>
  <p class="section-help">These are the clinical parameters that most influenced the AI clinical model for this patient (SHAP explanation). Use them to understand <em>why</em> the clinical score leaned positive or negative — not as isolated diagnoses.</p>
  <table class="results">{$shap_rows}</table>
  <p class="note"><strong>How to read this:</strong> A positive contribution (▲) pushed the result toward a positive PMOS screen. A negative contribution (▼) pushed toward a negative / protective screen. Larger absolute values had more influence.</p>
</div>

<div class="section" data-section="imaging">
  <h2 class="section-title">4. Ultrasound Image and AI Attention Map</h2>
  <p class="section-help">Side-by-side view of the submitted ultrasound and the EigenCAM heatmap showing where the imaging model focused.</p>
  {$imaging_html}
</div>

<div class="section" data-section="diagnosis">
  <h2 class="section-title">5. Screening Results and Clinical Validation</h2>
  <p class="section-help">AI screening scores are shown first. After each likelihood score, the OB-GYN marks a Final Diagnosis row. Physician validation is required before counseling or treatment planning.</p>
  <table class="results">
    <tr><th style="width:55%;">RESULT ITEM</th><th style="width:45%;">FINDING</th></tr>
    {$dx_rows}
  </table>
  <div class="plain-box" style="margin-top:8px;padding:6px 4px;">
    <p class="note" style="margin:0 0 4px 0;"><strong>In plain language:</strong> {$final_plain}</p>
    <p class="note" style="margin:0;">Discuss this report with your doctor. Lifestyle, menstrual history, and further tests may still be needed.</p>
  </div>
  <hr class="rule-thick">
  <p style="font-size:10px;padding:6px 0;margin:0;"><strong>Clinical data / sample date:</strong> {$sample_esc}</p>
  <hr class="rule-thick">
  <p class="important" style="margin:8px 0;line-height:1.35;"><strong>Important notice for patients and doctors</strong><br/>
    This is a computer-assisted screening aid for Polyendocrine Metabolic Ovarian Syndrome (PMOS). It must be interpreted by a qualified clinician together with history, examination, and other investigations. It is not a standalone diagnosis and does not replace professional medical advice.
  </p>
</div>

<div class="section" data-section="recommendations">
  <h2 class="section-title">6. Recommendations</h2>
  <table class="results" style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="padding:12px 4px 18px;border:none;border-top:0.6px solid #666;border-bottom:0.6px solid #666;vertical-align:top;">
        {$recs_body_html}
      </td>
    </tr>
  </table>
  <p class="flags" style="margin-top:10px;"><strong>Result flags:</strong> &nbsp; Lower / protective ▼ &nbsp; Higher / elevated ▲</p>
  <table class="sign-table">
    <tr>
      <td style="padding:10px 4px;line-height:1.45;text-align:left;vertical-align:top;font-size:12px;">
        <strong style="font-size:12px;">Validated by (Consulting OB-GYN)</strong><br/>
        Name: ____________________________<br/>
        Signature: _______________________<br/>
        Date: ____________________________
      </td>
    </tr>
  </table>
</div>

<!-- Footer lines are drawn on every PDF page by html_to_pdf.py -->
<p class="computer pcode-pdf-footer-computer">THIS IS A COMPUTER-GENERATED SCREENING REPORT.</p>
<p class="page-no pcode-pdf-footer-meta">Report ID: {$patient_id_formatted} &nbsp;|&nbsp; System: P-Code PMOS Decision Support</p>

</div>
</body>
</html>
HTML;

    return $html;
}
