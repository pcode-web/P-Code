<?php
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);
ob_start();

header('Content-Type: application/json');
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth_helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

try {
    $decoded = requireRegularUser();
    $user_id = requireUserId($decoded);

    $conn = pcode_users_db();

    $stmt = $conn->prepare("
        SELECT
            p.*,
            r.diagnosis_id,
            r.XGBoost_diagnosis,
            r.XGBoost_diagnosis_probability_percentage,
            r.CNN_diagnosis,
            r.CNN_diagnosis_probability_percentage,
            r.Overall_diagnosis,
            r.Overall_diagnosis_probability_percentage,
            r.screening_id,
            r.created_at AS screening_created_at
        FROM user_diagnosis_parameters p
        LEFT JOIN user_diagnosis_results r
          ON r.user_id = p.user_id
         AND r.diagnosis_id = (
              SELECT r2.diagnosis_id
              FROM user_diagnosis_results r2
              WHERE r2.user_id = p.user_id
              ORDER BY r2.created_at DESC, r2.diagnosis_id DESC
              LIMIT 1
         )
        WHERE p.user_id = ?
        LIMIT 1
    ");
    if (!$stmt) {
        // Read-only endpoint: if tables are missing (not set up yet), just return null.
        $err = (string)$conn->error;
        $conn->close();
        @ob_end_clean();
        echo json_encode(['success' => true, 'data' => null, 'message' => 'User tables not initialized']);
        exit;
    }
    $stmt->bind_param("i", $user_id);
    if (!$stmt->execute()) {
        throw new Exception("Execute failed: " . $stmt->error);
    }

    $res = $stmt->get_result();
    $row = ($res && $res->num_rows > 0) ? $res->fetch_assoc() : null;
    $stmt->close();
    $conn->close();

    // Normalize ultrasound image to data URL for the frontend (match patient APIs behavior)
    if ($row && isset($row['Ultrasound_image']) && !empty($row['Ultrasound_image'])) {
        $val = $row['Ultrasound_image'];
        // If already a data URL string, keep it; otherwise treat as raw bytes and base64 encode
        if (is_string($val) && strpos($val, 'data:image') === 0) {
            // keep as-is
        } else {
            // $val may be binary bytes; base64 encode and prefix
            $row['Ultrasound_image'] = 'data:image/jpeg;base64,' . base64_encode($val);
        }
    }

    @ob_end_clean();
    echo json_encode([
        'success' => true,
        'data' => $row
    ]);
} catch (Exception $e) {
    http_response_code(500);
    @ob_end_clean();
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}

