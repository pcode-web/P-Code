<?php
// Load production/local env before constants (Hostinger KVM2: config/.env)
require_once dirname(__DIR__) . '/config/env_loader.php';

// CORS headers - MUST BE FIRST (skipped for HTML redirect OAuth handlers)
if (!defined('PCODE_SKIP_API_HEADERS')) {
    $corsOrigins = pcode_env('PCODE_CORS_ORIGINS', '');
    $requestOrigin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    $allowOrigin = '*';
    if (is_string($corsOrigins) && trim($corsOrigins) !== '' && trim($corsOrigins) !== '*') {
        $allowed = array_filter(array_map('trim', explode(',', $corsOrigins)));
        if ($requestOrigin !== '' && in_array($requestOrigin, $allowed, true)) {
            $allowOrigin = $requestOrigin;
            header('Vary: Origin');
        } elseif (!empty($allowed)) {
            $allowOrigin = $allowed[0];
            header('Vary: Origin');
        } else {
            $allowOrigin = 'null';
        }
    }
    header('Access-Control-Allow-Origin: ' . $allowOrigin);
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Content-Type: application/json');
}

// Handle preflight requests
if (!defined('PCODE_SKIP_API_HEADERS') && (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS')) {
    http_response_code(200);
    exit();
}

// Database Configuration (Hostinger: set PCODE_DB_* in config/.env)
if (!defined('DB_HOST')) {
    define('DB_HOST', pcode_env('PCODE_DB_HOST', 'localhost') ?: 'localhost');
}
if (!defined('DB_USER')) {
    define('DB_USER', pcode_env('PCODE_DB_USER', 'root') ?: 'root');
}
if (!defined('DB_PASS')) {
    define('DB_PASS', pcode_env('PCODE_DB_PASS', '') ?? '');
}
if (!defined('DB_NAME')) {
    define('DB_NAME', pcode_env('PCODE_DB_NAME', 'pcode') ?: 'pcode');
}
// Single-DB mode: Regular User tables live inside DB_NAME.
// Keep this constant for backward compatibility with code that used DB_NAME_USERS.
if (!defined('DB_NAME_USERS')) {
    define('DB_NAME_USERS', DB_NAME);
}

// API / frontend URLs
$__pcodeBase = pcode_detect_public_base_url();
if (!defined('API_BASE_URL')) {
    $apiFromEnv = pcode_env('API_BASE_URL');
    define('API_BASE_URL', $apiFromEnv !== null && $apiFromEnv !== '' ? rtrim($apiFromEnv, '/') . '/' : $__pcodeBase . 'api/');
}
if (!defined('FRONTEND_URL')) {
    $feFromEnv = pcode_env('FRONTEND_URL', pcode_env('PCODE_BASE_URL'));
    define('FRONTEND_URL', $feFromEnv !== null && $feFromEnv !== '' ? rtrim($feFromEnv, '/') . '/' : $__pcodeBase);
}
if (!defined('PCODE_BASE_URL')) {
    define('PCODE_BASE_URL', FRONTEND_URL);
}

/**
 * Resolve JWT signing secret.
 * Prefer PCODE_JWT_SECRET env (>= 32 chars). Otherwise load/create
 * config/jwt_secret.key (not the weak placeholder).
 */
function pcode_resolve_jwt_secret(): string
{
    static $resolved = null;
    if (is_string($resolved) && $resolved !== '') {
        return $resolved;
    }

    $weak = [
        'your-secret-key-change-this-in-production',
        'secret',
        'changeme',
    ];

    $env = getenv('PCODE_JWT_SECRET');
    if (is_string($env)) {
        $env = trim($env);
        if ($env !== '' && strlen($env) >= 32 && !in_array($env, $weak, true)) {
            $resolved = $env;
            return $resolved;
        }
    }

    $secretFile = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'jwt_secret.key';
    if (is_readable($secretFile)) {
        $fromFile = trim((string) file_get_contents($secretFile));
        if ($fromFile !== '' && strlen($fromFile) >= 32 && !in_array($fromFile, $weak, true)) {
            $resolved = $fromFile;
            return $resolved;
        }
    }

    $generated = bin2hex(random_bytes(32));
    $dir = dirname($secretFile);
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    @file_put_contents($secretFile, $generated);
    @chmod($secretFile, 0600);
    $resolved = $generated;
    return $resolved;
}

if (!defined('JWT_SECRET')) {
    define('JWT_SECRET', pcode_resolve_jwt_secret());
}
if (!defined('JWT_EXPIRY')) {
    define('JWT_EXPIRY', 2592000); // 30 days — no 1-hour auto logout
}

// Google OAuth 2.0 — set PCODE_GOOGLE_CLIENT_ID in config/.env for production
if (!defined('GOOGLE_CLIENT_ID')) {
    $envGoogleId = pcode_env('PCODE_GOOGLE_CLIENT_ID');
    define('GOOGLE_CLIENT_ID', $envGoogleId !== null && $envGoogleId !== '' ? $envGoogleId : '953442697406-1nisk0lf775augnlkbbftpk19g4fkgl3.apps.googleusercontent.com');
}

// Google Maps JavaScript API — set PCODE_GOOGLE_MAPS_API_KEY in config/.env for production
if (!defined('GOOGLE_MAPS_API_KEY')) {
    $envMapsKey = pcode_env('PCODE_GOOGLE_MAPS_API_KEY');
    define(
        'GOOGLE_MAPS_API_KEY',
        $envMapsKey !== null && $envMapsKey !== ''
            ? $envMapsKey
            : 'AIzaSyCIl3LDXufPtpKn7sxZMTN6DywQJokMpA0'
    );
}

// Report timestamps / clinical dates use Philippine local time
if (function_exists('date_default_timezone_set')) {
    date_default_timezone_set('Asia/Manila');
}

// Debug/production switch — always false on Hostinger unless explicitly enabled
if (!defined('PCODE_DEBUG')) {
    define('PCODE_DEBUG', filter_var(pcode_env('PCODE_DEBUG', 'false') ?: 'false', FILTER_VALIDATE_BOOLEAN));
}

function pcode_log($message) {
    if (PCODE_DEBUG) {
        error_log($message);
    }
}

// Block direct web access to dangerous dev endpoints unless debug is enabled.
function pcode_block_dev_endpoints() {
    if (PCODE_DEBUG) return;
    $script = basename($_SERVER['SCRIPT_NAME'] ?? '');
    // Allow local-only maintenance when explicitly confirmed
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    $isLocal = ($remote === '127.0.0.1' || $remote === '::1');
    $confirm = (string)($_GET['confirm'] ?? '');

    if (preg_match('/^(test_|debug_|migrate_|setup_).+\\.php$/i', $script)) {
        if ($isLocal && $confirm === 'RUN') {
            return;
        }
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Not found']);
        exit();
    }
}
pcode_block_dev_endpoints();

// Create database connection
try {
    $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    
    if ($conn->connect_error) {
        throw new Exception('Database connection failed: ' . $conn->connect_error);
    }
    
    $conn->set_charset("utf8");

    // TIMESTAMP / CURRENT_TIMESTAMP in Philippine local time (match date_default_timezone)
    @$conn->query("SET time_zone = '+08:00'");
    
    // Enable strict mysqli exceptions only in debug mode
    if (PCODE_DEBUG) {
        mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
    } else {
        mysqli_report(MYSQLI_REPORT_OFF);
    }
} catch (Exception $e) {
    http_response_code(500);
    die(json_encode(['success' => false, 'message' => 'Database connection error: ' . $e->getMessage()]));
}

function pcode_users_db() {
    // Backward-compatibility helper. In single-DB mode, this is the same as the main DB.
    $c = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if ($c->connect_error) {
        throw new Exception('DB connection failed: ' . $c->connect_error);
    }
    $c->set_charset("utf8");
    @$c->query("SET time_zone = '+08:00'");
    return $c;
}

/**
 * Open a mysqli connection with utf8 + Asia/Manila session time_zone.
 * Prefer this for ad-hoc connections outside the shared $conn from config.php.
 */
function pcode_mysqli(): mysqli
{
    $c = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if ($c->connect_error) {
        throw new Exception('DB connection failed: ' . $c->connect_error);
    }
    $c->set_charset('utf8');
    @$c->query("SET time_zone = '+08:00'");
    return $c;
}

// JWT Helper Functions
function generateJWT($data) {
    $header = base64_encode(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $payload = base64_encode(json_encode(array_merge($data, ['iat' => time(), 'exp' => time() + JWT_EXPIRY])));
    $signature = base64_encode(hash_hmac('sha256', "$header.$payload", JWT_SECRET, true));
    return "$header.$payload.$signature";
}

// Cache Helper Functions
function getCacheKey($prefix, $value) {
    return $prefix . ':' . md5($value);
}

function getCache($key) {
    // Try APCu first (fastest)
    if (extension_loaded('apcu')) {
        return apcu_fetch($key);
    }
    
    // Fallback to file-based cache
    $cache_dir = sys_get_temp_dir() . '/pcode_cache';
    if (!is_dir($cache_dir)) {
        @mkdir($cache_dir, 0755, true);
    }
    
    $cache_file = $cache_dir . '/' . md5($key) . '.cache';
    if (file_exists($cache_file)) {
        $data = json_decode(file_get_contents($cache_file), true);
        if ($data['expires'] > time()) {
            return $data['value'];
        }
        @unlink($cache_file);
    }
    return false;
}

function setCache($key, $value, $ttl = 300) {
    // Try APCu first
    if (extension_loaded('apcu')) {
        apcu_store($key, $value, $ttl);
        return;
    }
    
    // Fallback to file-based cache
    $cache_dir = sys_get_temp_dir() . '/pcode_cache';
    if (!is_dir($cache_dir)) {
        @mkdir($cache_dir, 0755, true);
    }
    
    $cache_file = $cache_dir . '/' . md5($key) . '.cache';
    $data = [
        'value' => $value,
        'expires' => time() + $ttl
    ];
    @file_put_contents($cache_file, json_encode($data));
}

function verifyJWT($token, $expGraceSeconds = 0) {
    $parts = explode('.', $token);
    if (count($parts) !== 3) {
        return null;
    }
    
    $header = $parts[0];
    $payload = $parts[1];
    $signature = $parts[2];
    
    $expected_signature = base64_encode(hash_hmac('sha256', "$header.$payload", JWT_SECRET, true));
    
    if ($signature !== $expected_signature) {
        return null;
    }
    
    $decoded = json_decode(base64_decode($payload), true);
    if (!is_array($decoded)) {
        return null;
    }
    
    if (!empty($decoded['exp']) && $decoded['exp'] < time()) {
        $grace = max(0, (int)$expGraceSeconds);
        if ($grace > 0 && time() <= ((int)$decoded['exp'] + $grace)) {
            return $decoded;
        }
        return null;
    }
    
    return $decoded;
}

function getAuthToken() {
    $auth = null;
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        if (is_array($headers)) {
            $auth = $headers['Authorization'] ?? $headers['authorization'] ?? null;
        }
    }
    // Apache/CGI often strips Authorization unless rewritten — check server vars
    if (!$auth && !empty($_SERVER['HTTP_AUTHORIZATION'])) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'];
    }
    if (!$auth && !empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $auth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }
    if (!$auth && !empty($_SERVER['Authorization'])) {
        $auth = $_SERVER['Authorization'];
    }
    if ($auth && preg_match('/Bearer\s+(.+)/i', $auth, $matches)) {
        return trim($matches[1]);
    }
    return null;
}

/**
 * Bearer token from Authorization header, JSON body, or query (Apache-safe fallbacks).
 */
function pcode_request_bearer_token($jsonBody = null) {
    $token = getAuthToken();
    if ($token) {
        return $token;
    }
    if (is_array($jsonBody) && !empty($jsonBody['token'])) {
        return trim((string)$jsonBody['token']);
    }
    if (!empty($_GET['access_token'])) {
        return trim((string)$_GET['access_token']);
    }
    return null;
}

function isGuestUser() {
    $token = getAuthToken();
    if (!$token) {
        return false;
    }
    
    $decoded = verifyJWT($token);
    if (!$decoded) {
        return false;
    }
    
    return isset($decoded['isGuest']) && $decoded['isGuest'] === true;
}

function getGuestSamplePatients() {
    // Return sample patient data for guest users
    return [
        [
            'id' => 'PMOS-001',
            'name' => 'Sarah Johnson',
            'patient_id' => 1,
            'age' => 28,
            'date_added' => '2024-04-05',
            'address' => '123 Medical Street, City, State',
            'contact_no' => '+1-555-0123',
            'DOB' => '1996-04-15',
            'civil_status' => 'Single',
            'occupation' => 'Software Engineer',
            'religion' => 'Christian',
            'referred_by' => 'Dr. Emily Brown',
            
            'clinical_score_percentage' => 78.5,
            'imaging_score_percentage' => 82.3,
            'overall_diagnosis_percentage' => 80.4,
            
            'xgboost_diagnosis' => 'positive',
            'cnn_diagnosis' => 'positive',
            'overall_diagnosis' => 'positive',
            'diagnosis_id' => 1,
            
            'Age_yrs' => 28,
            'Weight_kg' => 68.5,
            'Height_cm' => 165,
            'Blood_Group' => 3,
            'Pulse_rate_bpm' => 78,
            'RR_breath_min' => 18,
            'BP_Systolic_mmHg' => 125,
            'BP_Diastolic_mmHg' => 82,
            'Hb_g_dl' => 13.2,
            'BMI' => 25.2,
            
            'Hip_inch' => 40.5,
            'Waist_inch' => 32.5,
            'Waist_hip_ratio' => 0.80,
            
            'CycleR_I' => 1.5,
            'Cycle_length_days' => 45,
            'Marriage_Status_years' => 0,
            'Pregnant' => 0,
            'No_of_abortions' => 0,
            
            'AMH_ng_mL' => 5.2,
            'LH_mIU_mL' => 12.8,
            'FSH_mIU_mL' => 6.5,
            'FSH_LH' => 0.51,
            'TSH_mIU_L' => 2.1,
            'PRL_ng_mL' => 8.5,
            'Vit_D3_ng_mL' => 28.5,
            'I_beta_HCG_mIU_mL' => 0,
            'II_beta_HCG_mIU_mL' => 0,
            'PRG_ng_mL' => 0.5,
            'RBS_mg_dl' => 105,
            
            'Follicle_no_L' => 18,
            'Follicle_no_R' => 16,
            'Avg_F_size_L_mm' => 8.5,
            'Avg_F_size_R_mm' => 9.2,
            'Endometrium_mm' => 8.5,
            
            'Weight_gain' => 1,
            'Hair_growth' => 1,
            'Skin_darkening' => 0,
            'Hair_loss' => 1,
            'Pimples' => 1,
            'Fast_food' => 1,
            'Reg_Exercise' => 0,
            'Ultrasound_image' => null
        ]
    ];
}

function sendResponse($success, $message, $data = null, $statusCode = 200) {
    http_response_code($statusCode);
    $response = ['success' => $success, 'message' => $message];
    if ($data !== null) {
        $response = array_merge($response, $data);
    }
    echo json_encode($response);
    exit();
}
?>
