<?php
/**
 * CNN Grad-CAM++ Visualization API
 * Generates Grad-CAM++ explanations for CNN predictions on ultrasound images
 */
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

header('Content-Type: application/json');

try {
    // Check if config file exists and load it
    $configPath = __DIR__ . '/config.php';
    if (!file_exists($configPath)) {
        throw new Exception('Database config not found');
    }
    require_once $configPath;
    require_once __DIR__ . '/auth_helpers.php';
    require_once __DIR__ . '/patient_schema_helpers.php';
    
    // Get JSON POST data
    $inputData = file_get_contents('php://input');
    $clinicalData = json_decode($inputData, true);
    
    if (!$clinicalData || empty($clinicalData)) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => 'No request data provided'
        ]);
        exit;
    }
    
    // Extract patient ID and get associated ultrasound image
    $patientId = isset($clinicalData['patient_id']) ? intval($clinicalData['patient_id']) : null;
    $imageBase64 = isset($clinicalData['image']) ? $clinicalData['image'] : null;
    
    if (!$patientId && !$imageBase64) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => 'Either patient_id or image data must be provided'
        ]);
        exit;
    }
    
    // If we have a patient ID but no image, try to fetch from database (owner-scoped)
    if ($patientId && !$imageBase64) {
        $providerAuth = requireProvider();
        $mysql = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
        if ($mysql->connect_error) {
            // Fall back gracefully - return success without gradcam
            http_response_code(200);
            echo json_encode([
                'success' => true,
                'probability_percentage' => 0,
                'classification' => 'Unknown',
                'error' => 'Database connection failed'
            ]);
            exit;
        }

        $providerId = pcode_require_provider_owns_patient($mysql, $patientId, $providerAuth);
        
        // Query patient_diagnosis_parameters where Ultrasound_image is stored
        $stmt = $mysql->prepare(
            "SELECT c.Ultrasound_image as ultrasound_image
             FROM patient_diagnosis_parameters c
             INNER JOIN patient_personal_info p ON p.patient_id = c.patient_id
             WHERE c.patient_id = ? AND p.owner_provider_id = ?
             LIMIT 1"
        );
        if ($stmt) {
            $stmt->bind_param("ii", $patientId, $providerId);
            if ($stmt->execute()) {
                $result = $stmt->get_result();
                if ($result && $result->num_rows > 0) {
                    $row = $result->fetch_assoc();
                    if (!empty($row['ultrasound_image'])) {
                        $imageBase64 = $row['ultrasound_image'];
                    }
                }
            }
            $stmt->close();
        }
        
        $mysql->close();
    }
    
    if (!$imageBase64) {
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'probability_percentage' => 0,
            'classification' => 'Unknown',
            'error' => 'No ultrasound image available'
        ]);
        exit;
    }
    
    // Remove data URI prefix if present
    if (strpos($imageBase64, 'data:') === 0) {
        $imageBase64 = substr($imageBase64, strpos($imageBase64, ',') + 1);
    }
    
    // Validate and decode base64
    $imageBytes = base64_decode($imageBase64, true);
    if ($imageBytes === false) {
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'probability_percentage' => 0,
            'classification' => 'Unknown',
            'error' => 'Invalid base64 image data'
        ]);
        exit;
    }
    
    // Create temp file for image
    $tempDir = sys_get_temp_dir();
    $tempImageFile = $tempDir . '/pcos_gradcam_' . uniqid() . '.tmp';
    
    if (file_put_contents($tempImageFile, $imageBytes) === false) {
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'probability_percentage' => 0,
            'classification' => 'Unknown',
            'error' => 'Failed to create temporary image file'
        ]);
        exit;
    }
    
    // Get Python path and script path
    $pythonPath = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
    $scriptPath = realpath(__DIR__ . '/../cnn_predict.py');
    
    if (!file_exists($pythonPath)) {
        @unlink($tempImageFile);
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'probability_percentage' => 0,
            'classification' => 'Unknown',
            'error' => 'Python not found, Grad-CAM++ skipped'
        ]);
        exit;
    }
    
    if (!$scriptPath) {
        @unlink($tempImageFile);
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'probability_percentage' => 0,
            'classification' => 'Unknown',
            'error' => 'CNN prediction script not found'
        ]);
        exit;
    }
    
    // Build command with gradcam flag set to true and smoothing enabled.
    // Arguments: image_file gradcam apply_smoothing smoothing_factor user_mode
    $escapedPython = escapeshellarg($pythonPath);
    $escapedScript = escapeshellarg($scriptPath);
    $escapedImageFile = escapeshellarg($tempImageFile);
    $errorLog = sys_get_temp_dir() . '/pcos_gradcam_error_' . uniqid() . '.log';
    $command = "{$escapedPython} {$escapedScript} {$escapedImageFile} true true 0.90 regular_user 2>" . escapeshellarg($errorLog);
    
    // Execute with shell_exec
    $output = shell_exec($command);
    
    // Cleanup temp file
    @unlink($tempImageFile);
    
    // Check output
    if ($output === null || trim($output) === '') {
        $errorContent = file_exists($errorLog) ? file_get_contents($errorLog) : 'Unknown error';
        @unlink($errorLog);
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'probability_percentage' => 0,
            'classification' => 'Unknown',
            'error' => 'CNN processing returned no output',
            'stderr' => substr($errorContent, 0, 500)
        ]);
        exit;
    }
    
    // Parse JSON response from Python script
    $result = json_decode($output, true);
    
    if (!is_array($result)) {
        @unlink($errorLog);
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'probability_percentage' => 0,
            'classification' => 'Unknown',
            'error' => 'Invalid CNN response',
            'output_sample' => substr($output, 0, 200)
        ]);
        exit;
    }
    
    @unlink($errorLog);
    
    // Return the result with Grad-CAM visualization
    http_response_code(200);
    echo json_encode($result);
    exit;
    
} catch (Exception $e) {
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'probability_percentage' => 0,
        'classification' => 'Unknown',
        'error' => $e->getMessage()
    ]);
    exit;
}
?>
