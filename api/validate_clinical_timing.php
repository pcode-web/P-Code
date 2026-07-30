<?php
/**
 * Pre-inference clinical timing + freshness validation (JSON API).
 */
declare(strict_types=1);

header('Content-Type: application/json');
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/clinical_validity.php';

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'message' => 'Method not allowed']);
        exit;
    }

    $raw = file_get_contents('php://input');
    $payload = json_decode($raw ?: '{}', true);
    if (!is_array($payload)) {
        $payload = $_POST;
    }

    $evaluation = pcode_clinical_validity_evaluate($payload);

    echo json_encode([
        'success' => true,
        'clinical_validity' => $evaluation,
        'inference_allowed' => $evaluation['valid'],
    ], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Clinical validation failed']);
}
