<?php
header('Content-Type: application/json');
require_once 'config.php';
require_once __DIR__ . '/auth_helpers.php';
require_once __DIR__ . '/patient_schema_helpers.php';

try {
    // Providers only — list only their own patients
    $providerAuth = requireProvider();

    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    
    if ($conn->connect_error) {
        throw new Exception("Connection failed: " . $conn->connect_error);
    }

    pcode_ensure_owner_provider_id_column($conn);
    pcode_backfill_unscoped_patients_to_first_provider($conn);

    $providerId = pcode_current_provider_id_from_auth($providerAuth);
    if ($providerId <= 0 && session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['provider_id'])) {
        $providerId = (int) $_SESSION['provider_id'];
    }

    if ($providerId <= 0) {
        http_response_code(401);
        echo json_encode([
            'success' => false,
            'error' => 'Provider session required'
        ]);
        exit;
    }
    
    $query = "SELECT patient_id, patient_name
              FROM patient_personal_info
              WHERE owner_provider_id = ?
              ORDER BY patient_id DESC";
    $stmt = $conn->prepare($query);
    if (!$stmt) {
        throw new Exception("Query failed: " . $conn->error);
    }
    $stmt->bind_param('i', $providerId);
    $stmt->execute();
    $result = $stmt->get_result();
    
    $patients = [];
    
    while ($row = $result->fetch_assoc()) {
        $pcos_id = 'PMOS-' . str_pad($row['patient_id'], 3, '0', STR_PAD_LEFT);
        $patients[] = [
            'id' => $pcos_id,
            'name' => $row['patient_name'],
            'patient_id' => $row['patient_id']
        ];
    }
    $stmt->close();
    
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'data' => $patients,
        'count' => count($patients)
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
