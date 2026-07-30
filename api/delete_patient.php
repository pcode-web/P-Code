<?php
header('Content-Type: application/json');
require_once 'config.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/patient_schema_helpers.php';

try {
    // Providers only — may delete only their own charts
    $providerAuth = requireProvider();

    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    
    if ($conn->connect_error) {
        throw new Exception("Connection failed: " . $conn->connect_error);
    }

    pcode_ensure_owner_provider_id_column($conn);
    
    // Get patient ID from POST JSON body or GET parameter
    $patient_id = null;
    
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true);
        $patient_id = isset($input['patient_id']) ? intval($input['patient_id']) : null;
    } elseif (isset($_GET['id'])) {
        $patient_id = intval($_GET['id']);
    }
    
    if (!$patient_id) {
        throw new Exception("Patient ID is required");
    }

    $providerId = pcode_require_provider_owns_patient($conn, $patient_id, $providerAuth);
    
    // Delete from diagnosis results first (if any)
    $delete_results = "DELETE FROM patient_diagnosis_results WHERE patient_id = ?";
    $stmt = $conn->prepare($delete_results);
    $stmt->bind_param("i", $patient_id);
    if (!$stmt->execute()) {
        throw new Exception("Error deleting diagnosis results: " . $stmt->error);
    }
    $stmt->close();

    // Delete from clinical parameters first (foreign key constraint)
    $delete_clinical = "DELETE FROM patient_diagnosis_parameters WHERE patient_id = ?";
    $stmt = $conn->prepare($delete_clinical);
    $stmt->bind_param("i", $patient_id);
    if (!$stmt->execute()) {
        throw new Exception("Error deleting clinical parameters: " . $stmt->error);
    }
    $stmt->close();
    
    // Delete from personal info — ownership enforced again in WHERE
    $delete_personal = "DELETE FROM patient_personal_info WHERE patient_id = ? AND owner_provider_id = ?";
    $stmt = $conn->prepare($delete_personal);
    $stmt->bind_param("ii", $patient_id, $providerId);
    if (!$stmt->execute()) {
        throw new Exception("Error deleting patient: " . $stmt->error);
    }
    if ($stmt->affected_rows === 0) {
        $stmt->close();
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'error' => 'You can only delete patients in your own care'
        ]);
        $conn->close();
        exit;
    }
    $stmt->close();
    
    echo json_encode([
        'success' => true,
        'message' => 'Patient deleted successfully'
    ]);
    
    $conn->close();
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}
?>
