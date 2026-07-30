<?php
/**
 * CNN Model Prediction API - Fixed Version
 * Accepts base64 encoded image and returns PMOS prediction with anomaly detection
 */
header('Content-Type: application/json');

require_once 'config.php';
require_once __DIR__ . '/clinical_validity.php';
require_once __DIR__ . '/ultrasound_imaging.php';

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

function cleanup_temp_file($filepath) {
    if (file_exists($filepath)) {
        @unlink($filepath);
    }
}

try {
    // Check if image data is provided
    if (!isset($_POST['image']) || empty($_POST['image'])) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => 'No image data provided'
        ]);
        exit;
    }
    
    $imageBase64 = $_POST['image'];
    
    // Remove data URI prefix if present
    if (strpos($imageBase64, 'data:') === 0) {
        $imageBase64 = substr($imageBase64, strpos($imageBase64, ',') + 1);
    }
    
    // Validate and decode base64
    $imageBytes = base64_decode($imageBase64, true);
    if ($imageBytes === false) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => 'Invalid base64 image data'
        ]);
        exit;
    }
    
    // Create temp file for image instead of passing large base64 via command line
    $tempDir = sys_get_temp_dir();
    $tempImageFile = $tempDir . '/pcos_image_' . uniqid() . '.tmp';
    
    if (file_put_contents($tempImageFile, $imageBytes) === false) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Failed to create temporary image file'
        ]);
        exit;
    }

    $clinicalPayload = $_POST;
    $clinicalPayload['image'] = $_POST['image'];
    $modality = pcode_ultrasound_normalize_modality($_POST['ultrasound_modality'] ?? $_POST['Ultrasound_modality'] ?? 'TVUS');
    $clinicalPayload['ultrasound_modality'] = $modality;
    $imageAnalysis = pcode_ultrasound_analyze_image_bytes($imageBytes);

    $validityEvaluation = pcode_clinical_validity_evaluate($clinicalPayload);
    if ($validityEvaluation['inference_blocked']) {
        cleanup_temp_file($tempImageFile);
        pcode_clinical_validity_block_json($validityEvaluation);
    }

    $ultrasoundImagingContext = pcode_ultrasound_build_imaging_context(
        $clinicalPayload,
        $validityEvaluation,
        $modality,
        $imageAnalysis
    );
    $executionLog = pcode_ultrasound_execution_log($modality, $imageAnalysis, $ultrasoundImagingContext);
    
    // Get Python path and script path
    $pythonPath = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
    $scriptPath = realpath(__DIR__ . '/../cnn_predict.py');
    
    if (!file_exists($pythonPath)) {
        cleanup_temp_file($tempImageFile);
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Python executable not found'
        ]);
        exit;
    }
    
    if (!$scriptPath) {
        cleanup_temp_file($tempImageFile);
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'CNN prediction script not found'
        ]);
        exit;
    }
    
    // Optional: allow client to request stronger smoothing
    // (lower factor => stronger smoothing, e.g. 0.80 for Regular Users).
    $smoothingFactor = null;
    if (isset($_POST['smoothing_factor']) && $_POST['smoothing_factor'] !== '') {
        $sf = floatval($_POST['smoothing_factor']);
        // Clamp to safe range
        if ($sf > 0) {
            $smoothingFactor = max(0.50, min(0.95, $sf));
        }
    }

    // Optional: hint about caller context (used to enable Mahalanobis only for Regular Users)
    $userMode = '';
    if (isset($_POST['user_mode'])) {
        $userMode = strtolower(trim((string)$_POST['user_mode']));
    }

    // Build command - pass file path instead of base64 string
    // Arguments: image_file gradcam apply_smoothing [smoothing_factor] [user_mode]
    $escapedPython = escapeshellarg($pythonPath);
    $escapedScript = escapeshellarg($scriptPath);
    $escapedImageFile = escapeshellarg($tempImageFile);
    $command = "{$escapedPython} {$escapedScript} {$escapedImageFile} false true";
    if ($smoothingFactor !== null) {
        $command .= " " . escapeshellarg((string)$smoothingFactor);
    }
    if ($userMode !== '') {
        $command .= " " . escapeshellarg($userMode);
    }
    $command .= " 2>nul";
    
    // Execute with shell_exec - redirect stderr to null to avoid any debug output
    $output = shell_exec($command);
    
    // Cleanup temp file
    cleanup_temp_file($tempImageFile);
    
    // Check output
    if ($output === null || trim($output) === '') {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Python script returned no output'
        ]);
        exit;
    }
    
    // Parse JSON response
    $result = json_decode($output, true);
    
    if ($result === null) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Invalid JSON response from script',
            'raw_output' => substr($output, 0, 200)
        ]);
        exit;
    }

    $result['clinical_validity'] = $validityEvaluation;
    $result['ultrasound_imaging_context'] = $ultrasoundImagingContext;
    $result['ultrasound_execution_log'] = $executionLog;
    $result = pcode_ultrasound_append_feature_importance($result, $ultrasoundImagingContext);
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
        'error' => $e->getMessage()
    ]);
}
?>
