<?php
/**
 * P-Code ultrasound imaging modality validation and CNN context bundling.
 */
declare(strict_types=1);

const PCODE_TVUS_MIN_WIDTH = 384;
const PCODE_TVUS_MIN_HEIGHT = 384;
const PCODE_ULTRASOUND_MODALITIES = ['TVUS', 'Transabdominal', 'Other'];

function pcode_ultrasound_normalize_modality(?string $raw): string
{
    $raw = strtolower(trim((string) $raw));
    if (in_array($raw, ['tvus', 'transvaginal', 'trans-vaginal', 'vaginal', 'transvaginal ultrasound'], true)) {
        return 'TVUS';
    }
    if (in_array($raw, ['transabdominal', 'taus', 'pelvic', 'abdominal', 'transabdominal/pelvic'], true)) {
        return 'Transabdominal';
    }
    if ($raw === 'other' || $raw === 'alternate') {
        return 'Other';
    }
    return 'TVUS';
}

function pcode_ultrasound_analyze_image_bytes(string $imageBytes): array
{
    $info = @getimagesizefromstring($imageBytes);
    if ($info === false) {
        return [
            'valid' => false,
            'width' => null,
            'height' => null,
            'megapixels' => null,
            'meets_tvus_resolution' => false,
            'resolution_tier' => 'unknown',
            'message' => 'Unable to read image dimensions from uploaded scan.',
        ];
    }

    $width = (int) $info[0];
    $height = (int) $info[1];
    $megapixels = round(($width * $height) / 1_000_000, 2);
    $meetsTvus = $width >= PCODE_TVUS_MIN_WIDTH && $height >= PCODE_TVUS_MIN_HEIGHT;

    $tier = 'low';
    if ($meetsTvus) {
        $tier = 'high';
    } elseif ($width >= 256 && $height >= 256) {
        $tier = 'moderate';
    }

    return [
        'valid' => true,
        'width' => $width,
        'height' => $height,
        'megapixels' => $megapixels,
        'meets_tvus_resolution' => $meetsTvus,
        'resolution_tier' => $tier,
        'message' => $meetsTvus
            ? 'Image resolution meets TVUS-oriented CNN input requirements.'
            : 'Image resolution is below TVUS-oriented thresholds; follicle boundary extraction may be diminished.',
    ];
}

function pcode_ultrasound_extract_follicle_metrics(array $payload): array
{
    $pick = static function (array $keys) use ($payload): ?string {
        return pcode_clinical_validity_pick($payload, $keys);
    };

    return array_filter([
        'Follicle_no_L' => $pick(['Follicle_no_L']),
        'Follicle_no_R' => $pick(['Follicle_no_R']),
        'Avg_F_size_L_mm' => $pick(['Avg_F_size_L', 'Avg_F_size_L_mm']),
        'Avg_F_size_R_mm' => $pick(['Avg_F_size_R', 'Avg_F_size_R_mm']),
    ], static fn($v) => $v !== null && $v !== '');
}

function pcode_ultrasound_modality_diagnostic_token(string $modality, ?array $imageAnalysis = null): array
{
    $meetsResolution = $imageAnalysis['meets_tvus_resolution'] ?? null;

    if ($modality === 'TVUS' && $meetsResolution === true) {
        return [
            'token' => 'TVUS_OPTIMAL_FEATURE_EXTRACTION',
            'impact' => 'baseline_cnn_resolution',
            'label' => 'Transvaginal ultrasound (TVUS) — optimal modality for follicle boundary detection.',
            'weight_adjustment' => 0.0,
        ];
    }

    if ($modality === 'Transabdominal') {
        return [
            'token' => 'TRANSABDOMINAL_DIMINISHED_RESOLUTION',
            'impact' => 'reduced_cnn_feature_extraction_confidence',
            'label' => 'Transabdominal/Pelvic scan — permitted fallback; diminished follicle boundary resolution vs TVUS baseline.',
            'weight_adjustment' => -0.08,
        ];
    }

    if ($modality === 'Other') {
        return [
            'token' => 'ALTERNATE_MODALITY_UNVERIFIED',
            'impact' => 'unverified_modality_feature_extraction',
            'label' => 'Alternate pelvic imaging modality — CNN feature extraction confidence may vary.',
            'weight_adjustment' => -0.05,
        ];
    }

    if ($meetsResolution === false) {
        return [
            'token' => 'SUBOPTIMAL_IMAGE_RESOLUTION',
            'impact' => 'reduced_cnn_feature_extraction_confidence',
            'label' => 'Scan resolution below TVUS-oriented thresholds; feature extraction may be diminished.',
            'weight_adjustment' => -0.06,
        ];
    }

    return [
        'token' => 'TVUS_OPTIMAL_FEATURE_EXTRACTION',
        'impact' => 'baseline_cnn_resolution',
        'label' => 'Transvaginal ultrasound (TVUS) — preferred imaging modality.',
        'weight_adjustment' => 0.0,
    ];
}

function pcode_ultrasound_build_imaging_context(
    array $payload,
    array $validityEvaluation,
    string $modality,
    ?array $imageAnalysis = null
): array {
    $ultrasoundDate = pcode_clinical_validity_pick($payload, ['ultrasound_date', 'scan_date', 'us_date']);
    $expiration = $validityEvaluation['expired_fields']['ultrasound'] ?? 'Valid';
    $diagnosticToken = pcode_ultrasound_modality_diagnostic_token($modality, $imageAnalysis);

    return [
        'ultrasound_modality' => $modality,
        'ultrasound_date' => $ultrasoundDate,
        'expiration_status' => $expiration,
        'follicle_metrics' => pcode_ultrasound_extract_follicle_metrics($payload),
        'image_resolution' => $imageAnalysis,
        'diagnostic_token' => $diagnosticToken,
        'cnn_payload_ready' => $expiration === 'Valid',
    ];
}

function pcode_ultrasound_append_feature_importance(array $result, array $imagingContext): array
{
    $token = $imagingContext['diagnostic_token'] ?? null;
    if (!$token) {
        return $result;
    }

    if (!isset($result['feature_importance']) || !is_array($result['feature_importance'])) {
        $result['feature_importance'] = [];
    }

    $result['feature_importance'][] = [
        'factor' => 'ultrasound_modality',
        'token' => $token['token'],
        'impact' => $token['impact'],
        'label' => $token['label'],
        'weight_adjustment' => $token['weight_adjustment'],
        'modality' => $imagingContext['ultrasound_modality'] ?? 'TVUS',
        'expiration_status' => $imagingContext['expiration_status'] ?? 'Valid',
    ];

    return $result;
}

function pcode_ultrasound_execution_log(string $modality, ?array $imageAnalysis, array $imagingContext): array
{
    $log = [
        'ultrasound_modality' => $modality,
        'processing_continued' => true,
        'expiration_gate' => $imagingContext['expiration_status'] ?? 'Valid',
    ];

    if ($modality === 'Transabdominal') {
        $log['modality_note'] = 'Transabdominal scan registered; CNN inference proceeding with diminished-resolution diagnostic token.';
    } elseif ($modality === 'Other') {
        $log['modality_note'] = 'Alternate pelvic modality registered; transparency token attached for clinician review.';
    } else {
        $log['modality_note'] = 'TVUS modality — primary preferred imaging path.';
    }

    if ($imageAnalysis) {
        $log['image_resolution'] = [
            'width' => $imageAnalysis['width'] ?? null,
            'height' => $imageAnalysis['height'] ?? null,
            'meets_tvus_resolution' => $imageAnalysis['meets_tvus_resolution'] ?? null,
            'resolution_tier' => $imageAnalysis['resolution_tier'] ?? null,
        ];
    }

    return $log;
}
