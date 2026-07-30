<?php
/**
 * Password digest + bcrypt helpers.
 *
 * Client sends SHA-256 hex of the plaintext password (never store/transit raw
 * when the new JS helper is used). Server stores password_hash(digest, BCRYPT).
 * Legacy rows (bcrypt of plaintext, or rare plaintext) are still verified and
 * upgraded on successful login.
 */
declare(strict_types=1);

function pcode_password_is_sha256_digest(string $value): bool
{
    return (bool) preg_match('/^[a-f0-9]{64}$/i', $value);
}

/**
 * Normalize a client password field to a SHA-256 hex digest.
 * If the client already sent a digest, use it; otherwise hash plaintext (legacy clients).
 */
function pcode_password_to_digest(string $password): string
{
    $password = trim($password);
    if ($password === '') {
        return '';
    }
    if (pcode_password_is_sha256_digest($password)) {
        return strtolower($password);
    }
    return hash('sha256', $password);
}

function pcode_password_looks_bcrypt_or_argon(string $stored): bool
{
    $stored = trim($stored);
    if ($stored === '') {
        return false;
    }
    return str_starts_with($stored, '$2y$')
        || str_starts_with($stored, '$2a$')
        || str_starts_with($stored, '$2b$')
        || str_starts_with($stored, '$argon2id$')
        || str_starts_with($stored, '$argon2i$')
        || str_starts_with($stored, '$argon2$');
}

function pcode_hash_password_for_storage(string $password): string
{
    $digest = pcode_password_to_digest($password);
    if ($digest === '') {
        throw new InvalidArgumentException('Password required');
    }
    $hash = password_hash($digest, PASSWORD_BCRYPT);
    if (!is_string($hash) || $hash === '') {
        throw new RuntimeException('Failed to hash password');
    }
    return $hash;
}

/**
 * Verify a login password and upgrade legacy storage formats to bcrypt(digest).
 */
function pcode_verify_and_upgrade_password(
    PDO $pdo,
    string $table,
    string $idColumn,
    int $id,
    string $password,
    string $stored
): bool {
    $stored = (string) $stored;
    $password = (string) $password;
    if ($stored === '' || $password === '') {
        return false;
    }

    $isDigest = pcode_password_is_sha256_digest($password);
    $digest = pcode_password_to_digest($password);

    $upgrade = static function (string $newHash) use ($pdo, $table, $idColumn, $id): void {
        if ($newHash === '') {
            return;
        }
        $allowed = ['users' => 'user_id', 'clinical_providers' => 'id'];
        if (!isset($allowed[$table]) || $allowed[$table] !== $idColumn) {
            return;
        }
        $stmt = $pdo->prepare("UPDATE {$table} SET password = :pwd WHERE {$idColumn} = :id");
        $stmt->execute(['pwd' => $newHash, 'id' => $id]);
    };

    if (pcode_password_looks_bcrypt_or_argon($stored)) {
        if (password_verify($digest, $stored)) {
            return true;
        }
        // Legacy: bcrypt(plaintext) while an old client still posts plaintext
        if (!$isDigest && password_verify($password, $stored)) {
            try {
                $upgrade(pcode_hash_password_for_storage($password));
            } catch (Throwable $e) {
                // still allow login
            }
            return true;
        }
        return false;
    }

    // Legacy plaintext row
    $plainMatch = (!$isDigest && hash_equals($stored, $password))
        || ($isDigest && hash_equals(hash('sha256', $stored), $digest));
    if (!$plainMatch) {
        return false;
    }
    try {
        $upgrade(pcode_hash_password_for_storage($isDigest ? $digest : $password));
    } catch (Throwable $e) {
        // allow login even if upgrade fails
    }
    return true;
}
