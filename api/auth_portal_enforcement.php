<?php
/**
 * Enforce "Continue as Regular User" vs "Continue as OB-GYN"
 * against the account role. Generic failure message (no role leak).
 */

/**
 * Normalize role from DB: trim unicode spaces, collapse whitespace, mb lower-case, underscore → space.
 * Matches the intent of the JS normalizeRoleString used after login.
 */
function pcode_normalize_db_role($role) {
    $r = (string) $role;
    $r = preg_replace('/[\x{FEFF}\x{200B}\x{00A0}]/u', ' ', $r);
    $r = str_replace(['_', "\t", "\n", "\r"], ' ', $r);
    $r = preg_replace('/\s+/u', ' ', trim($r));
    if (function_exists('mb_strtolower')) {
        $r = mb_strtolower($r, 'UTF-8');
    } else {
        $r = strtolower($r);
    }
    return $r;
}

/**
 * True when this account is the app’s regular (patient/community) user role.
 * Accepts “Regular User”, legacy one-word, and extra spacing.
 */
function pcode_role_is_regular_user($role) {
    $r = pcode_normalize_db_role($role);
    if ($r === 'regular user') {
        return true;
    }
    if ($r === 'regularuser') {
        return true;
    }
    return (bool) preg_match('/^regular[\s\-_]*user$/u', $r);
}

/**
 * @param string $expectedAccess '' | 'community' | 'provider'
 * @param string $userRole       Role from users table
 * @return bool true if the login is allowed, false to reject (same as wrong password)
 */
function pcode_portal_allows_role($expectedAccess, $userRole) {
    $e = strtolower(trim((string) $expectedAccess));
    if ($e === '') {
        return true;
    }
    if ($e !== 'community' && $e !== 'provider') {
        return false;
    }
    $r = pcode_normalize_db_role($userRole);
    if ($e === 'community') {
        return pcode_role_is_regular_user($userRole);
    }
    if ($e === 'provider') {
        if ($r === '' || pcode_role_is_regular_user($userRole)) {
            return false;
        }
        if (in_array($r, ['administrator', 'admin', 'system administrator'], true)) {
            return false;
        }
        if ($r === 'guest') {
            return false;
        }
        return true;
    }
    return false;
}
