<?php
/**
 * Exports Directory
 * 
 * This directory stores generated PDF/HTML reports.
 * 
 * WARNING: Configure your web server to:
 * 1. Limit directory access (disable directory listing)
 * 2. Set appropriate file permissions
 * 3. Implement access control for sensitive reports
 * 4. Consider moving outside web root for production
 */

header('Content-Type: text/plain');
http_response_code(403);
echo "Access denied. This directory is for exported reports only.";
?>
