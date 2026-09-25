"""
P-Code CRUD Blueprint: Firebase Cloud Functions + Clever Cloud MySQL.
Auth, patients, diagnosis history (ML lives in functions/main.py).
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import sys
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator, Optional

try:
    from zoneinfo import ZoneInfo

    PCODE_TZ = ZoneInfo("Asia/Manila")
except Exception:  # noqa: BLE001
    from datetime import timedelta

    PCODE_TZ = timezone(timedelta(hours=8))

# Philippine local time for history cards, last-tested labels, and PDF stamps.
# MySQL TIMESTAMP is stored UTC; session +08:00 returns Manila wall-clock.
PCODE_TZ_NAME = "Asia/Manila"
PCODE_MYSQL_TZ = "+08:00"

import bcrypt
import pymysql
from dbutils.pooled_db import PooledDB
from flask import Blueprint, jsonify, request
from pymysql.cursors import DictCursor

# Ensure project root is on sys.path so cnn_predict / xgboost_predict import cleanly
BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent
for _p in (str(BASE_DIR), str(REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Lazy ML imports: TensorFlow/XGBoost must NOT block auth/DB boot on Render
cnn_predict = None  # type: ignore
cnn_tflite = None  # type: ignore
xgboost_predict = None  # type: ignore

def _load_xgb():
    raise RuntimeError(
        "Combined /api/predict XGBoost path is retired on Firebase. "
        "Use POST /api/detect-clinical instead."
    )


def _load_cnn_tflite():
    raise RuntimeError(
        "Combined /api/predict CNN path is retired on Firebase. "
        "Use POST /api/detect-ultrasound instead."
    )


def _load_cnn():
    return _load_cnn_tflite()





logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("pcode_crud")

bp = Blueprint('pcode_crud', __name__)

# --- ML model paths ----------------------------------------------------------
_tflite_default = BASE_DIR / "CNN Model" / "pcos_detection_modelv4.tflite"
_raw_cnn = (os.getenv("CNN_TFLITE_PATH") or os.getenv("CNN_MODEL_PATH") or "").strip()
if _raw_cnn.lower().endswith(".tflite"):
    CNN_TFLITE_PATH = Path(_raw_cnn)
else:
    # Ignore legacy .keras CNN_MODEL_PATH so hosted always prefers TFLite weights.
    CNN_TFLITE_PATH = _tflite_default

CNN_KERAS_PATH = Path(
    (os.getenv("CNN_KERAS_PATH") or "").strip()
    or str(BASE_DIR / "CNN Model" / "pcos_detection_modelv4.keras")
)
# Alias kept for older logging / health checks
CNN_MODEL_PATH = CNN_TFLITE_PATH
XGB_MODEL_PATH = Path(
    (os.getenv("XGB_MODEL_PATH") or "").strip()
    or str(BASE_DIR / "XGBoost Model" / "xgboost_pcos_model_v5.pkl")
)

# --- Database config (Render + Clever Cloud add-on fallbacks) ----------------
def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return default


DB_HOST = _env("DB_HOST", "MYSQL_ADDON_HOST", "PCODE_DB_HOST", default="localhost")
DB_USER = _env("DB_USER", "MYSQL_ADDON_USER", "PCODE_DB_USER", default="root")
DB_PASSWORD = _env("DB_PASSWORD", "MYSQL_ADDON_PASSWORD", "PCODE_DB_PASS", default="")
DB_NAME = _env("DB_NAME", "MYSQL_ADDON_DB", "PCODE_DB_NAME", default="pcode")
DB_PORT = int(_env("DB_PORT", "MYSQL_ADDON_PORT", "PCODE_DB_PORT", default="3306"))
DB_POOL_SIZE = max(1, int(_env("DB_POOL_SIZE", default="8")))

_pool: Optional[PooledDB] = None


def _build_pool() -> PooledDB:
    return PooledDB(
        creator=pymysql,
        maxconnections=DB_POOL_SIZE,
        mincached=1,
        maxcached=DB_POOL_SIZE,
        blocking=True,
        ping=1,  # reconnect stale connections on checkout
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        port=DB_PORT,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=False,
        connect_timeout=8,
        read_timeout=25,
        write_timeout=25,
    )


def get_pool() -> PooledDB:
    """Lazy-init connection pool; recreate if the pool was reset after errors."""
    global _pool
    if _pool is None:
        _pool = _build_pool()
    return _pool


def reset_pool() -> None:
    global _pool
    if _pool is not None:
        try:
            _pool.close()
        except Exception:  # noqa: BLE001
            pass
    _pool = None


def _apply_mysql_session_timezone(conn: pymysql.connections.Connection) -> None:
    """Align TIMESTAMP read/write with Asia/Manila (matches PHP date_default_timezone)."""
    try:
        with conn.cursor() as cur:
            cur.execute("SET time_zone = %s", (PCODE_MYSQL_TZ,))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not set MySQL time_zone=%s: %s", PCODE_MYSQL_TZ, exc)


@contextmanager
def get_db_connection() -> Iterator[pymysql.connections.Connection]:
    """
    Checkout a pooled connection with one automatic reconnect on failure.
    Commits on clean exit; rolls back on exception.
    """
    conn = None
    try:
        try:
            conn = get_pool().connection()
            conn.ping(reconnect=True)
        except Exception as first_err:  # noqa: BLE001
            logger.warning("DB checkout failed (%s); resetting pool", first_err)
            reset_pool()
            conn = get_pool().connection()
            conn.ping(reconnect=True)

        _apply_mysql_session_timezone(conn)
        yield conn
        conn.commit()
    except Exception:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
        raise
    finally:
        if conn is not None:
            try:
                conn.close()  # returns connection to pool
            except Exception:  # noqa: BLE001
                pass


def _parse_datetime_value(value: Any) -> Optional[datetime]:
    """Coerce DB/ISO values into datetime; None if unparseable."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date) and not isinstance(value, datetime):
        return datetime(value.year, value.month, value.day)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # Support "Z" and common MySQL "YYYY-MM-DD HH:MM:SS"
        text = text.replace("Z", "+00:00")
        if " " in text and "T" not in text:
            text = text.replace(" ", "T", 1)
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d"):
                try:
                    return datetime.strptime(value.strip(), fmt)
                except ValueError:
                    continue
    return None


def _to_manila(dt: datetime) -> datetime:
    """
    Normalize to Asia/Manila.
    Naive values are treated as Manila wall-clock (MySQL session time_zone = +08:00).
    If a naive value arrives without a Manila session (e.g. cached UTC), callers that
    still see ~8h drift should verify SET time_zone ran on the connection.
    """
    if dt.tzinfo is None:
        return dt.replace(tzinfo=PCODE_TZ)
    return dt.astimezone(PCODE_TZ)


def _format_manila_display(value: Any) -> Optional[str]:
    """Human history/list stamp: 'Jul 30, 2026 · 12:51 PM' in Asia/Manila."""
    dt = _parse_datetime_value(value)
    if dt is None:
        return None
    local = _to_manila(dt)
    # Match PHP: M j, Y · g:i A (no leading zeros on day/hour)
    hour12 = local.hour % 12 or 12
    ampm = "AM" if local.hour < 12 else "PM"
    return f"{local.strftime('%b')} {local.day}, {local.year} · {hour12}:{local.strftime('%M')} {ampm}"


def _now_manila() -> datetime:
    return datetime.now(PCODE_TZ)


# Columns allowed on INSERT into patient_diagnosis_parameters (excludes PK/auto fields)
DIAGNOSIS_INSERT_COLUMNS: tuple[str, ...] = (
    "patient_id",
    "Age_yrs",
    "Weight_kg",
    "Height_cm",
    "BMI",
    "Blood_Group",
    "Pulse_rate_bpm",
    "RR_breath_min",
    "Hb_g_dl",
    "CycleR_I",
    "Cycle_length_days",
    "Marriage_Status_years",
    "Pregnant",
    "No_of_abortions",
    "I_beta_HCG_mIU_mL",
    "II_beta_HCG_mIU_mL",
    "FSH_mIU_mL",
    "LH_mIU_mL",
    "FSH_LH",
    "Hip_inch",
    "Waist_inch",
    "Waist_hip_ratio",
    "TSH_mIU_L",
    "AMH_ng_mL",
    "PRL_ng_mL",
    "Vit_D3_ng_mL",
    "PRG_ng_mL",
    "RBS_mg_dl",
    "Weight_gain",
    "Hair_growth",
    "Skin_darkening",
    "Hair_loss",
    "Pimples",
    "Fast_food",
    "Reg_Exercise",
    "BP_Systolic_mmHg",
    "BP_Diastolic_mmHg",
    "Follicle_no_L",
    "Follicle_no_R",
    "Avg_F_size_L_mm",
    "Avg_F_size_R_mm",
    "Endometrium_mm",
    "Ultrasound_image",
    "last_menstrual_period_date",
    "blood_draw_date",
    "ultrasound_date",
    "symptom_evaluation_date",
    "fasting_hours",
    "ultrasound_modality",
    "screening_id",
    "created_by",
)

# Common aliases from frontend / PHP form field names → DB columns
_DIAGNOSIS_ALIASES: dict[str, str] = {
    "age": "Age_yrs",
    "Age": "Age_yrs",
    "Cycle_R_I": "CycleR_I",
    "cycle_regularity": "CycleR_I",
    "cycle_r_i": "CycleR_I",
    "Cycle_length": "Cycle_length_days",
    "cycle_length": "Cycle_length_days",
    "Marriage_duration": "Marriage_Status_years",
    "marriage_years": "Marriage_Status_years",
    "Pregnant_status": "Pregnant",
    "pregnant": "Pregnant",
    "No_abortions": "No_of_abortions",
    "no_abortions": "No_of_abortions",
    "I_Beta_HCG": "I_beta_HCG_mIU_mL",
    "II_Beta_HCG": "II_beta_HCG_mIU_mL",
    "beta_hcg_i": "I_beta_HCG_mIU_mL",
    "beta_hcg_ii": "II_beta_HCG_mIU_mL",
    "FSH_level": "FSH_mIU_mL",
    "fsh": "FSH_mIU_mL",
    "LH_level": "LH_mIU_mL",
    "lh": "LH_mIU_mL",
    "AMH_level": "AMH_ng_mL",
    "amh": "AMH_ng_mL",
    "TSH_level": "TSH_mIU_L",
    "tsh": "TSH_mIU_L",
    "PRL_level": "PRL_ng_mL",
    "prl": "PRL_ng_mL",
    "Vitamin_D3_level": "Vit_D3_ng_mL",
    "vit_d3": "Vit_D3_ng_mL",
    "Progesterone_level": "PRG_ng_mL",
    "prg": "PRG_ng_mL",
    "RBS": "RBS_mg_dl",
    "rbs": "RBS_mg_dl",
    "Hemoglobin": "Hb_g_dl",
    "hb": "Hb_g_dl",
    "Pulse_rate": "Pulse_rate_bpm",
    "pulse_rate": "Pulse_rate_bpm",
    "RR_breath": "RR_breath_min",
    "rr_breath": "RR_breath_min",
    "BP_systolic": "BP_Systolic_mmHg",
    "bp_systolic": "BP_Systolic_mmHg",
    "BP_diastolic": "BP_Diastolic_mmHg",
    "bp_diastolic": "BP_Diastolic_mmHg",
    "Avg_F_size_L": "Avg_F_size_L_mm",
    "Avg_F_size_R": "Avg_F_size_R_mm",
    "follicle_left": "Follicle_no_L",
    "follicle_right": "Follicle_no_R",
    "follicle_size_left": "Avg_F_size_L_mm",
    "follicle_size_right": "Avg_F_size_R_mm",
    "endometrium_thickness": "Endometrium_mm",
    "hip_inch": "Hip_inch",
    "waist_inch": "Waist_inch",
    "waist_hip_ratio": "Waist_hip_ratio",
    "LH_FSH_Ratio": "FSH_LH",
    "lh_fsh_ratio": "FSH_LH",
    "blood_group": "Blood_Group",
    "height": "Height_cm",
    "weight": "Weight_kg",
    "bmi": "BMI",
    "weight_gain": "Weight_gain",
    "hair_growth": "Hair_growth",
    "skin_darkening": "Skin_darkening",
    "hair_loss": "Hair_loss",
    "pimples": "Pimples",
    "fast_food": "Fast_food",
    "Regular_exercise": "Reg_Exercise",
    "reg_exercise": "Reg_Exercise",
    "image": "Ultrasound_image",
    "image_base64": "Ultrasound_image",
    "LMP": "last_menstrual_period_date",
    "lmp_date": "last_menstrual_period_date",
    "LMP_date": "last_menstrual_period_date",
    "lab_draw_date": "blood_draw_date",
    "hormone_panel_date": "blood_draw_date",
    "Blood_draw_date": "blood_draw_date",
    "Fasting_hours": "fasting_hours",
    "fasting_hours_before_draw": "fasting_hours",
    "referred_by": "reffered_by",
    # XGBoost / dataset column labels that sometimes appear in snapshots
    "LH(mIU/mL)": "LH_mIU_mL",
    "FSH(mIU/mL)": "FSH_mIU_mL",
    "Hb(g/dl)": "Hb_g_dl",
    "AMH(ng/mL)": "AMH_ng_mL",
    "PRL(ng/mL)": "PRL_ng_mL",
    "TSH (mIU/L)": "TSH_mIU_L",
    "PRG(ng/mL)": "PRG_ng_mL",
    "Vit D3 (ng/mL)": "Vit_D3_ng_mL",
    "RBS(mg/dl)": "RBS_mg_dl",
    "Cycle length(days)": "Cycle_length_days",
    "Follicle No. (L)": "Follicle_no_L",
    "Follicle No. (R)": "Follicle_no_R",
}


def _is_db_connectivity_error(exc: BaseException) -> bool:
    msg = str(exc or "").lower()
    needles = (
        "can't connect",
        "connection refused",
        "timed out",
        "timeout",
        "server has gone away",
        "lost connection",
        "operationalerror",
        "(2003,",
        "(2006,",
        "(2013,",
    )
    return any(n in msg for n in needles)


def _db_failure_response(exc: BaseException, fallback_message: str = "Database error"):
    """Prefer HTTP 503 when Clever Cloud / MySQL is unreachable."""
    if _is_db_connectivity_error(exc):
        return _json_error(
            "Database temporarily unavailable. Saved screenings and history cannot load until MySQL is online.",
            503,
            detail=str(exc),
            code="db_unavailable",
        )
    return _json_error(fallback_message, 500, detail=str(exc))


def _json_error(message: str, status: int = 400, **extra: Any):
    body: dict[str, Any] = {"success": False, "error": message, "message": message}
    body.update(extra)
    return jsonify(body), status


def _json_ok(data: Any = None, message: str = "OK", status: int = 200, **extra: Any):
    body: dict[str, Any] = {"success": True, "message": message}
    if data is not None:
        body["data"] = data
    body.update(extra)
    return jsonify(body), status


def _serialize_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    return value


def _password_is_sha256_digest(value: str) -> bool:
    return bool(re.fullmatch(r"[a-f0-9]{64}", value.strip(), flags=re.IGNORECASE))


def _password_to_digest(password: str) -> str:
    password = password.strip()
    if not password:
        return ""
    if _password_is_sha256_digest(password):
        return password.lower()
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def _normalize_bcrypt_hash(stored: str) -> bytes:
    """PHP password_hash uses $2y$; the bcrypt package expects $2b$."""
    h = stored.strip()
    if h.startswith("$2y$"):
        h = "$2b$" + h[4:]
    return h.encode("utf-8")


def verify_provider_password(password: str, stored: str) -> bool:
    """
    Match PHP login semantics:
    - preferred: bcrypt(SHA-256 hex digest)
    - legacy: bcrypt(plaintext)
    - rare: plaintext equality
    """
    if not stored or not password:
        return False
    if stored.startswith("$google$"):
        return False
    digest = _password_to_digest(password)
    looks_bcrypt = stored.startswith(("$2y$", "$2a$", "$2b$"))

    if looks_bcrypt:
        try:
            hashed = _normalize_bcrypt_hash(stored)
            if bcrypt.checkpw(digest.encode("utf-8"), hashed):
                return True
            if not _password_is_sha256_digest(password) and bcrypt.checkpw(
                password.encode("utf-8"), hashed
            ):
                return True
        except (ValueError, TypeError) as exc:
            logger.warning("bcrypt verify failed: %s", exc)
            return False
        return False

    # Non-bcrypt legacy storage
    return stored == password or hashlib.sha256(stored.encode("utf-8")).hexdigest() == digest


def _decode_image_payload(payload: dict) -> bytes:
    """Accept base64 (raw or data-URI) under image / image_base64 / Ultrasound_image."""
    raw = (
        payload.get("image")
        or payload.get("image_base64")
        or payload.get("Ultrasound_image")
        or ""
    )
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Missing image: provide JSON field 'image' (base64 or data URI)")
    raw = raw.strip()
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        return base64.b64decode(raw, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Invalid base64 image data: {exc}") from exc


def _coerce_ultrasound_blob(value: Any) -> Any:
    if value is None or value == "":
        return None
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        if raw.startswith("data:") and "," in raw:
            raw = raw.split(",", 1)[1]
        try:
            return base64.b64decode(raw, validate=False)
        except Exception:  # noqa: BLE001
            return value.encode("utf-8")
    return value


def _normalize_diagnosis_payload(payload: dict) -> dict[str, Any]:
    """Map aliases → DB columns and keep only whitelisted fields."""
    normalized: dict[str, Any] = {}
    for key, value in payload.items():
        if key in ("success", "error", "message"):
            continue
        column = _DIAGNOSIS_ALIASES.get(key, key)
        if column not in DIAGNOSIS_INSERT_COLUMNS:
            continue
        if column == "Ultrasound_image":
            value = _coerce_ultrasound_blob(value)
            if value is None:
                continue
        else:
            value = _coerce_user_param_value(column, value)
            # Skip failed coercions so we don't wipe existing values with NULL
            if value is None:
                continue
        normalized[column] = value
    return normalized


# =============================================================================
# Health
# =============================================================================
@bp.get("/crud-root")
def root():
    return jsonify({"status": "API is running", "success": True}), 200


# Auth / JWT (PHP-compatible shape): always resolve secret at call time
def _jwt_secret() -> str:
    """Read JWT secret at call time (Firebase Secret Manager injects env at runtime)."""
    return _env("JWT_SECRET", "PCODE_JWT_SECRET", default="pcode-dev-secret-change-me")


class _JwtSecretProxy:
    """Backward-compatible JWT_SECRET name that always tracks live env/secret."""

    def __str__(self) -> str:
        return _jwt_secret()

    def __repr__(self) -> str:
        return f"<JWT_SECRET live len={len(_jwt_secret())}>"

    def encode(self, encoding: str = "utf-8", errors: str = "strict") -> bytes:
        return _jwt_secret().encode(encoding, errors)


JWT_SECRET = _JwtSecretProxy()
JWT_EXPIRY = int(_env("JWT_EXPIRY", default="2592000"))  # 30 days
GOOGLE_CLIENT_ID = _env(
    "GOOGLE_CLIENT_ID",
    "PCODE_GOOGLE_CLIENT_ID",
    default="953442697406-1nisk0lf775augnlkbbftpk19g4fkgl3.apps.googleusercontent.com",
)


def _b64url_nopad(raw: bytes) -> str:
    """Match PHP base64_encode used in generateJWT (standard base64, not url-safe)."""
    import base64 as _b64

    return _b64.b64encode(raw).decode("ascii")


def generate_jwt(data: dict) -> str:
    import json as _json
    import time as _time

    header = _b64url_nopad(_json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload_obj = dict(data)
    payload_obj["iat"] = int(_time.time())
    payload_obj["exp"] = int(_time.time()) + JWT_EXPIRY
    payload = _b64url_nopad(_json.dumps(payload_obj, separators=(",", ":")).encode())
    import hmac as _hmac

    sig = _b64url_nopad(
        _hmac.new(_jwt_secret().encode("utf-8"), f"{header}.{payload}".encode("utf-8"), hashlib.sha256).digest()
    )
    return f"{header}.{payload}.{sig}"


def _default_avatar(name: str) -> str:
    label = (name or "User").replace(" ", "+")
    return f"https://ui-avatars.com/api/?name={label}&background=6B46C1&color=fff"


def _auth_success_payload(user: dict, auth_source: str) -> dict:
    uid = int(user["id"])
    name = str(user.get("name") or user.get("user_name") or "")
    email = str(user.get("email") or "")
    role = str(user.get("role") or "")
    avatar = str(user.get("avatar") or user.get("picture") or "") or _default_avatar(name)
    try:
        token_version = int(user.get("token_version") or 0)
    except (TypeError, ValueError):
        token_version = 0
    is_active = user.get("is_active")
    if is_active is None:
        is_active = True
    token = generate_jwt(
        {
            "id": uid,
            "email": email,
            "name": name,
            "role": role,
            "auth_source": auth_source,
            "tv": token_version,
        }
    )
    return {
        "success": True,
        "message": "Login successful",
        "token": token,
        "expiresIn": JWT_EXPIRY,
        "user": {
            "id": uid,
            "name": name,
            "user_name": name,
            "email": email,
            "role": role,
            "institution": str(user.get("institution") or ""),
            "avatar": avatar,
            "picture": avatar,
            "authSource": auth_source,
            "is_active": bool(int(is_active)) if not isinstance(is_active, bool) else is_active,
        },
    }


def _verify_google_id_token(id_token: str) -> dict:
    import json as _json
    import urllib.error
    import urllib.parse
    import urllib.request

    if not id_token:
        raise ValueError("Missing Google id_token")
    url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + urllib.parse.quote(id_token)
    try:
        with urllib.request.urlopen(url, timeout=12) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ValueError("Invalid Google token") from exc
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Google token verification failed: {exc}") from exc

    aud = str(data.get("aud") or "")
    if GOOGLE_CLIENT_ID and aud and aud != GOOGLE_CLIENT_ID:
        raise ValueError("Google token audience mismatch")
    email = str(data.get("email") or "").strip().lower()
    if not email:
        raise ValueError("Google token missing email")
    if str(data.get("email_verified") or "").lower() in ("false", "0"):
        raise ValueError("Google email is not verified")
    return data


# =============================================================================
# Provider / community authentication
# =============================================================================
@bp.post("/api/login")
@bp.post("/api/login.php")
def api_login():
    """
    POST JSON: { email, password, expectedAccess?: "provider"|"community" }
    Password may be plaintext or SHA-256 hex digest (matches PHP/JS helper).
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Request body must be JSON", 400)

    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "").strip()
    expected = str(payload.get("expectedAccess") or "").strip().lower()
    is_admin_login = bool(payload.get("isAdminLogin")) is True

    if not email or not password:
        return _json_error("Email and password are required", 400)

    if "@" not in email or "." not in email.split("@")[-1]:
        return _json_error("Invalid email format", 400)

    if not _password_is_sha256_digest(password) and len(password) < 8:
        return _json_error("Invalid email or password", 401)

    GOOGLE_PW_MARKER = "$google$no-local-password"
    row = None

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_admin_account_schema(cur)
                # Provider portal → clinical_providers (skip for dedicated admin login)
                if not is_admin_login and (expected == "provider" or expected == ""):
                    cur.execute(
                        """
                        SELECT id, email, password, user_name, role, institution, avatar,
                               is_active, token_version
                        FROM clinical_providers
                        WHERE email = %s
                        LIMIT 1
                        """,
                        (email,),
                    )
                    provider = cur.fetchone()
                    if provider:
                        if int(provider.get("is_active") or 0) != 1:
                            if expected == "provider":
                                return _json_error(
                                    "This provider account is deactivated. Contact an administrator.",
                                    403,
                                    code="ACCOUNT_INACTIVE",
                                )
                        else:
                            stored = str(provider.get("password") or "")
                            if stored.startswith(GOOGLE_PW_MARKER):
                                if expected == "provider":
                                    return _json_error(
                                        "This account uses Google Sign-In. Use Sign in with Google instead of email/password.",
                                        401,
                                        code="USE_GOOGLE",
                                    )
                            elif verify_provider_password(password, stored):
                                if expected in ("", "provider"):
                                    pid = int(provider["id"])
                                    cur.execute(
                                        "UPDATE clinical_providers SET last_login = NOW() WHERE id = %s LIMIT 1",
                                        (pid,),
                                    )
                                    conn.commit()
                                    return jsonify(
                                        _auth_success_payload(
                                            {
                                                "id": pid,
                                                "email": provider.get("email") or email,
                                                "name": provider.get("user_name") or "",
                                                "role": provider.get("role") or "Ob-Gyn",
                                                "institution": provider.get("institution") or "",
                                                "avatar": provider.get("avatar") or "",
                                                "token_version": int(provider.get("token_version") or 0),
                                                "is_active": True,
                                            },
                                            "clinical_providers",
                                        )
                                    ), 200
                    if expected == "provider":
                        return _json_error(
                            "Invalid email or password. If you signed in with Google before, use Sign in with Google.",
                            401,
                        )

                # Community / admin / default → users
                cur.execute(
                    """
                    SELECT user_id, user_name, email, password, role, institution, avatar,
                           is_active, token_version
                    FROM users
                    WHERE email = %s
                    LIMIT 1
                    """,
                    (email,),
                )
                row = cur.fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.exception("Login DB error")
        return _json_error("Database error", 500, detail=str(exc))

    if not row:
        return _json_error(
            "Invalid email or password. If you previously used Google on this email, tap Sign in with Google.",
            401,
        )

    stored = str(row.get("password") or "")
    if stored.startswith(GOOGLE_PW_MARKER):
        return _json_error(
            "This account uses Google Sign-In. Tap Sign in with Google below: email/password is not set for this account.",
            401,
            code="USE_GOOGLE",
        )
    if not verify_provider_password(password, stored):
        return _json_error(
            "Incorrect password. If you created this account with Google, use Sign in with Google instead.",
            401,
        )

    # Upgrade legacy bcrypt(plaintext) → bcrypt(sha256 digest) when client sent plaintext
    if (
        stored.startswith(("$2y$", "$2a$", "$2b$"))
        and not _password_is_sha256_digest(password)
    ):
        digest = _password_to_digest(password)
        try:
            hashed = _normalize_bcrypt_hash(stored)
            digest_ok = bcrypt.checkpw(digest.encode("utf-8"), hashed)
            plain_ok = bcrypt.checkpw(password.encode("utf-8"), hashed)
            if plain_ok and not digest_ok:
                new_hash = _hash_password_for_storage(password)
                with get_db_connection() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE users SET password = %s WHERE user_id = %s LIMIT 1",
                            (new_hash, int(row["user_id"])),
                        )
                    conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Password upgrade skipped: %s", exc)

    role = str(row.get("role") or "Regular User")
    role_l = role.lower().strip()
    is_admin_role = role_l in ("administrator", "admin", "system administrator")

    if not is_admin_login and is_admin_role:
        return _json_error(
            'Admin accounts cannot log in through this portal. Please use the "Continue as Administrator" option.',
            403,
        )
    if is_admin_login and not is_admin_role:
        return _json_error(
            "Only administrator accounts can log in here. Please use the regular login option.",
            403,
        )

    if expected == "community" and role_l not in ("regular user", "patient", "user"):
        return _json_error("This account cannot access the Regular User portal", 403)
    if expected == "provider":
        return _json_error("Invalid email or password", 401)

    if int(row.get("is_active") if row.get("is_active") is not None else 1) != 1:
        return _json_error(
            "This account is deactivated. Contact an administrator.",
            403,
            code="ACCOUNT_INACTIVE",
        )

    uid = int(row["user_id"])
    _touch_last_login("users", uid)
    if is_admin_login and is_admin_role:
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    _admin_audit(
                        cur,
                        {"id": uid, "email": row.get("email") or email, "role": role},
                        action="admin_login",
                        target_type="users",
                        target_id=uid,
                        target_email=str(row.get("email") or email),
                        detail={"portal": "admin"},
                    )
                    conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("admin login audit skipped: %s", exc)

    return jsonify(
        _auth_success_payload(
            {
                "id": uid,
                "email": row.get("email") or email,
                "name": row.get("user_name") or "",
                "role": role,
                "institution": row.get("institution") or "",
                "avatar": row.get("avatar") or "",
                "token_version": int(row.get("token_version") or 0),
                "is_active": True,
            },
            "users",
        )
    ), 200


@bp.get("/api/sync_session")
@bp.post("/api/sync_session")
@bp.get("/api/sync_session.php")
@bp.post("/api/sync_session.php")
@bp.get("/api/sync-session")
@bp.post("/api/sync-session")
def api_sync_session():
    """
    Validate the provider JWT and optionally renew it.
    Replaces PHP api/sync_session.php for Firebase → Render.
    Accepts GET or POST with Authorization: Bearer <token>.
    """
    payload = request.get_json(silent=True) if request.method == "POST" else None
    if not isinstance(payload, dict):
        payload = {}

    auth_header = request.headers.get("Authorization") or ""
    token = auth_header
    if not token:
        token = str(payload.get("token") or request.args.get("token") or "")

    try:
        decoded = decode_jwt(token)
    except ValueError as exc:
        # Grace renew: accept recently-expired tokens and issue a fresh JWT
        try:
            raw = (token or "").strip()
            if raw.lower().startswith("bearer "):
                raw = raw[7:].strip()
            parts = raw.split(".")
            if len(parts) != 3:
                raise ValueError(str(exc))
            import json as _json

            soft = _json.loads(_b64decode_pad(parts[1]))
            if not isinstance(soft, dict) or not soft.get("id"):
                raise ValueError(str(exc))
            # Verify signature even if expired
            import hmac as _hmac

            expected = _hmac.new(
                _jwt_secret().encode("utf-8"),
                f"{parts[0]}.{parts[1]}".encode("utf-8"),
                hashlib.sha256,
            ).digest()
            if not _hmac.compare_digest(expected, _b64decode_pad(parts[2])):
                raise ValueError("Invalid token signature")
            decoded = soft
            renewed = True
        except Exception:  # noqa: BLE001
            return _json_error(str(exc), 401)
    else:
        renewed = False

    uid = int(decoded.get("id") or 0)
    if uid <= 0:
        return _json_error("Unauthorized: invalid token payload", 401)

    role = str(decoded.get("role") or "")
    source = str(decoded.get("auth_source") or "")
    is_provider = source == "clinical_providers" or role.lower() not in (
        "regular user",
        "patient",
        "user",
        "guest",
    )

    body: dict[str, Any] = {
        "success": True,
        "message": "Session synchronized",
        "provider_id": uid if is_provider else None,
        "user_id": uid if not is_provider else None,
        "role": role,
        "auth_source": source,
    }
    if renewed or request.args.get("renew") == "1":
        body["token"] = generate_jwt(
            {
                "id": uid,
                "email": str(decoded.get("email") or ""),
                "name": str(decoded.get("name") or ""),
                "role": role,
                "auth_source": source,
                "tv": int(decoded.get("tv") or 0),
                **({"isGuest": True} if decoded.get("isGuest") else {}),
            }
        )
        body["expiresIn"] = JWT_EXPIRY
        body["renewed"] = True

    return jsonify(body), 200


@bp.post("/api/auth/google")
@bp.post("/api/auth/google_callback.php")
def api_google_auth():
    """
    POST JSON: { id_token, expectedAccess?: "provider"|"community" }
    Verifies Google ID token, then resolves clinical_providers / users like PHP.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Request body must be JSON", 400)

    id_token = str(payload.get("id_token") or payload.get("credential") or "").strip()
    expected = str(payload.get("expectedAccess") or "").strip().lower()
    allow_register = bool(payload.get("allowRegister")) or str(
        payload.get("mode") or ""
    ).strip().lower() in ("signup", "register", "create")

    try:
        token_data = _verify_google_id_token(id_token)
    except ValueError as exc:
        return _json_error(str(exc), 401)

    email = str(token_data.get("email") or "").strip().lower()
    name = (
        str(token_data.get("name") or "").strip()
        or (
            f"{token_data.get('given_name') or ''} {token_data.get('family_name') or ''}".strip()
        )
        or email.split("@")[0]
    )
    picture = str(token_data.get("picture") or "").strip()

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                if expected == "provider":
                    cur.execute(
                        """
                        SELECT id, email, user_name, role, institution, avatar, is_active
                        FROM clinical_providers
                        WHERE email = %s
                        LIMIT 1
                        """,
                        (email,),
                    )
                    provider = cur.fetchone()
                    if provider and int(provider.get("is_active") or 0) != 1:
                        return _json_error(
                            "This provider account is inactive. Contact an administrator.",
                            403,
                        )
                    if not provider:
                        if not allow_register:
                            return _json_error(
                                "This Google account is not authorized for the OB-GYN portal. "
                                "Use Create account (or Sign up with Google) first.",
                                403,
                            )
                        # Self-serve provider signup via Google
                        cur.execute(
                            "SELECT 1 FROM users WHERE email = %s LIMIT 1",
                            (email,),
                        )
                        if cur.fetchone():
                            return _json_error(
                                "This email is already registered as a regular user account.",
                                409,
                            )
                        random_pw = "$google$no-local-password"
                        cur.execute(
                            """
                            INSERT INTO clinical_providers
                              (email, password, user_name, role, institution, avatar, is_active)
                            VALUES (%s, %s, %s, %s, %s, %s, 1)
                            """,
                            (
                                email,
                                random_pw,
                                name or _derive_display_name(email, "Provider"),
                                "Ob-Gyn",
                                "",
                                picture or None,
                            ),
                        )
                        new_id = int(cur.lastrowid)
                        provider = {
                            "id": new_id,
                            "email": email,
                            "user_name": name or _derive_display_name(email, "Provider"),
                            "role": "Ob-Gyn",
                            "institution": "",
                            "avatar": picture,
                            "is_active": 1,
                        }
                    elif picture:
                        cur.execute(
                            "UPDATE clinical_providers SET avatar = %s WHERE id = %s",
                            (picture, int(provider["id"])),
                        )
                    return jsonify(
                        _auth_success_payload(
                            {
                                "id": int(provider["id"]),
                                "email": provider.get("email") or email,
                                "name": provider.get("user_name") or name,
                                "role": provider.get("role") or "Ob-Gyn",
                                "institution": provider.get("institution") or "",
                                "avatar": picture or provider.get("avatar") or "",
                            },
                            "clinical_providers",
                        )
                    ), 200

                # Community / unspecified: prefer users, else clinical_providers
                cur.execute(
                    """
                    SELECT user_id, user_name, email, role, institution, avatar
                    FROM users
                    WHERE email = %s
                    LIMIT 1
                    """,
                    (email,),
                )
                user_row = cur.fetchone()
                if not user_row:
                    cur.execute(
                        """
                        INSERT INTO users (user_name, email, password, role, institution, avatar)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            name,
                            email,
                            "$google$no-local-password",
                            "Regular User",
                            "",
                            picture or None,
                        ),
                    )
                    new_id = int(cur.lastrowid)
                    user_row = {
                        "user_id": new_id,
                        "user_name": name,
                        "email": email,
                        "role": "Regular User",
                        "institution": "",
                        "avatar": picture,
                    }
                elif picture:
                    cur.execute(
                        "UPDATE users SET avatar = %s WHERE user_id = %s",
                        (picture, int(user_row["user_id"])),
                    )

                role = str(user_row.get("role") or "Regular User")
                if expected == "community" and role.lower() not in (
                    "regular user",
                    "patient",
                    "user",
                ):
                    return _json_error(
                        "This account cannot access the Regular User portal",
                        403,
                    )

                return jsonify(
                    _auth_success_payload(
                        {
                            "id": int(user_row["user_id"]),
                            "email": user_row.get("email") or email,
                            "name": user_row.get("user_name") or name,
                            "role": role,
                            "institution": user_row.get("institution") or "",
                            "avatar": picture or user_row.get("avatar") or "",
                        },
                        "users",
                    )
                ), 200
    except Exception as exc:  # noqa: BLE001
        logger.exception("Google auth DB error")
        return _json_error("Database error", 500, detail=str(exc))


FIREBASE_WEB_API_KEY = _env(
    "FIREBASE_WEB_API_KEY",
    "PCODE_FIREBASE_WEB_API_KEY",
    default="AIzaSyCQo5PMVcPN-49y3onIyoy3yzoDZNn3ab0",
)
FIREBASE_PROJECT_ID = _env(
    "FIREBASE_PROJECT_ID",
    "PCODE_FIREBASE_PROJECT_ID",
    default="project-a3473fa6-d957-4693-96a",
)


def _verify_firebase_id_token(id_token: str) -> dict:
    """Verify Firebase ID token via Identity Toolkit accounts:lookup."""
    import json as _json
    import urllib.error
    import urllib.parse
    import urllib.request

    if not id_token:
        raise ValueError("Missing Firebase ID token")
    if not FIREBASE_WEB_API_KEY:
        raise ValueError("Firebase is not configured on the server")

    url = (
        "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="
        + urllib.parse.quote(FIREBASE_WEB_API_KEY)
    )
    req = urllib.request.Request(
        url,
        data=_json.dumps({"idToken": id_token}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ValueError("invalid_token") from exc
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Firebase token verification failed: {exc}") from exc

    users = data.get("users") if isinstance(data, dict) else None
    if not isinstance(users, list) or not users or not isinstance(users[0], dict):
        raise ValueError("invalid_token")
    user = users[0]
    email = str(user.get("email") or "").strip().lower()
    if not email:
        raise ValueError("invalid_token")
    if "emailVerified" in user and not bool(user.get("emailVerified")):
        raise ValueError("Email is not verified")
    return {
        "email": email,
        "email_verified": bool(user.get("emailVerified")),
        "local_id": str(user.get("localId") or ""),
        "name": str(user.get("displayName") or ""),
    }


def _derive_display_name(email: str, fallback: str = "") -> str:
    if fallback and len(fallback.strip()) >= 2:
        return fallback.strip()
    local = (email or "").split("@", 1)[0].strip()
    cleaned = re.sub(r"[._+\-]+", " ", local)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) < 2:
        return "P-Code User"
    return " ".join(part.capitalize() for part in cleaned.split(" "))


@bp.post("/api/auth/refresh")
@bp.post("/api/auth/refresh.php")
def api_auth_refresh():
    """Renew a valid (or recently expired) JWT: used by auth.js session timer."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}

    auth_header = request.headers.get("Authorization") or ""
    token = auth_header
    if not token:
        token = str(payload.get("token") or "")

    try:
        decoded = decode_jwt(token)
        soft_ok = True
    except ValueError as exc:
        soft_ok = False
        try:
            raw = (token or "").strip()
            if raw.lower().startswith("bearer "):
                raw = raw[7:].strip()
            parts = raw.split(".")
            if len(parts) != 3:
                raise ValueError(str(exc))
            import json as _json
            import hmac as _hmac

            soft = _json.loads(_b64decode_pad(parts[1]))
            if not isinstance(soft, dict) or not soft.get("id"):
                raise ValueError(str(exc))
            expected = _hmac.new(
                _jwt_secret().encode("utf-8"),
                f"{parts[0]}.{parts[1]}".encode("utf-8"),
                hashlib.sha256,
            ).digest()
            if not _hmac.compare_digest(expected, _b64decode_pad(parts[2])):
                raise ValueError("Invalid token signature")
            decoded = soft
        except Exception:  # noqa: BLE001
            return _json_error(str(exc), 401)

    uid = int(decoded.get("id") or 0)
    if uid <= 0:
        return _json_error("Unauthorized: invalid token payload", 401)

    new_token = generate_jwt(
        {
            "id": uid,
            "email": str(decoded.get("email") or ""),
            "name": str(decoded.get("name") or ""),
            "role": str(decoded.get("role") or ""),
            "auth_source": str(decoded.get("auth_source") or ""),
            "tv": int(decoded.get("tv") or 0),
            **({"isGuest": True} if decoded.get("isGuest") else {}),
        }
    )
    return jsonify(
        {
            "success": True,
            "message": "Token refreshed",
            "token": new_token,
            "expiresIn": JWT_EXPIRY,
            "renewed": True,
            "was_expired": not soft_ok,
        }
    ), 200


@bp.get("/api/auth/bootstrap_session")
@bp.get("/api/auth/bootstrap_session.php")
def api_bootstrap_session():
    """
    PHP OAuth redirect used server sessions; on Render/Firebase we hydrate from
    Authorization Bearer (popup Google flow) or return a clear 401.
    """
    auth_header = request.headers.get("Authorization") or ""
    token = auth_header or str(request.args.get("token") or "")
    if not token:
        return _json_error("No active OAuth session", 401)
    try:
        decoded = decode_jwt(token)
    except ValueError as exc:
        return _json_error(str(exc) or "No active OAuth session", 401)

    uid = int(decoded.get("id") or 0)
    if uid <= 0:
        return _json_error("No active OAuth session", 401)

    name = str(decoded.get("name") or "")
    email = str(decoded.get("email") or "")
    role = str(decoded.get("role") or "")
    source = str(decoded.get("auth_source") or "")
    portal = "provider" if source == "clinical_providers" or role.lower() not in (
        "regular user",
        "patient",
        "user",
        "guest",
        "",
    ) else "patient"

    return jsonify(
        {
            "success": True,
            "token": token[7:].strip() if token.lower().startswith("bearer ") else token,
            "user": {
                "id": uid,
                "email": email,
                "name": name,
                "role": role,
                "institution": "",
                "avatar": _default_avatar(name),
                "picture": _default_avatar(name),
                "authSource": source,
            },
            "expiresIn": JWT_EXPIRY,
            "portal": portal,
        }
    ), 200


@bp.post("/api/auth/firebase")
@bp.post("/api/auth/firebase_callback.php")
def api_firebase_auth():
    """
    Bridge a Firebase ID token (email link) into a P-Code JWT.
    POST JSON: { id_token, expectedAccess?: "provider"|"community" }
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Request body must be JSON", 400)

    id_token = str(payload.get("id_token") or payload.get("credential") or "").strip()
    expected = str(payload.get("expectedAccess") or "").strip().lower()
    login_context = str(payload.get("loginContext") or "").strip().lower()

    try:
        token_data = _verify_firebase_id_token(id_token)
    except ValueError as exc:
        return _json_error(str(exc), 401)

    email = str(token_data.get("email") or "").strip().lower()
    name = _derive_display_name(email, str(token_data.get("name") or ""))

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                if expected == "provider":
                    cur.execute(
                        """
                        SELECT id, email, user_name, role, institution, avatar, is_active
                        FROM clinical_providers
                        WHERE email = %s
                        LIMIT 1
                        """,
                        (email,),
                    )
                    provider = cur.fetchone()
                    if not provider or int(provider.get("is_active") or 0) != 1:
                        return _json_error(
                            "This email is not on the authorized clinical provider roster. Ask an administrator to add you.",
                            403,
                            code="provider_not_authorized",
                        )
                    return jsonify(
                        _auth_success_payload(
                            {
                                "id": int(provider["id"]),
                                "email": provider.get("email") or email,
                                "name": provider.get("user_name") or name,
                                "role": provider.get("role") or "Ob-Gyn",
                                "institution": provider.get("institution") or "",
                                "avatar": provider.get("avatar") or "",
                            },
                            "clinical_providers",
                        )
                    ), 200

                cur.execute(
                    """
                    SELECT user_id, user_name, email, role, institution, avatar
                    FROM users
                    WHERE email = %s
                    LIMIT 1
                    """,
                    (email,),
                )
                user_row = cur.fetchone()
                if not user_row:
                    cur.execute(
                        """
                        INSERT INTO users (user_name, email, password, role, institution, avatar)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            name,
                            email,
                            "$google$no-local-password",
                            "Regular User",
                            "",
                            None,
                        ),
                    )
                    new_id = int(cur.lastrowid)
                    user_row = {
                        "user_id": new_id,
                        "user_name": name,
                        "email": email,
                        "role": "Regular User",
                        "institution": "",
                        "avatar": "",
                    }

                role = str(user_row.get("role") or "Regular User")
                if login_context == "portal-pick" and expected == "community":
                    if role.lower() not in ("regular user", "patient", "user"):
                        return _json_error(
                            "This account cannot access the regular user portal.",
                            403,
                            code="portal_role_mismatch",
                        )
                elif expected == "community" and role.lower() not in (
                    "regular user",
                    "patient",
                    "user",
                ):
                    return _json_error(
                        "This account cannot access the Regular User portal",
                        403,
                    )

                return jsonify(
                    _auth_success_payload(
                        {
                            "id": int(user_row["user_id"]),
                            "email": user_row.get("email") or email,
                            "name": user_row.get("user_name") or name,
                            "role": role,
                            "institution": user_row.get("institution") or "",
                            "avatar": user_row.get("avatar") or "",
                        },
                        "users",
                    )
                ), 200
    except Exception as exc:  # noqa: BLE001
        logger.exception("Firebase auth DB error")
        return _json_error("Firebase authentication failed", 500, detail=str(exc))


# --- JWT helpers / provider-scoped patient APIs -----------------------------
def _b64decode_pad(value: str) -> bytes:
    pad = "=" * (-len(value) % 4)
    return base64.b64decode(value + pad)


def decode_jwt(token: str) -> dict:
    import hmac as _hmac
    import json as _json
    import time as _time

    raw = (token or "").strip()
    if raw.lower().startswith("bearer "):
        raw = raw[7:].strip()
    parts = raw.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid token format")
    header_b64, payload_b64, sig_b64 = parts
    expected = _hmac.new(
        _jwt_secret().encode("utf-8"),
        f"{header_b64}.{payload_b64}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    try:
        got = _b64decode_pad(sig_b64)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid token signature encoding") from exc
    if not _hmac.compare_digest(expected, got):
        raise ValueError("Invalid token signature")
    try:
        payload = _json.loads(_b64decode_pad(payload_b64))
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid token payload") from exc
    if not isinstance(payload, dict):
        raise ValueError("Invalid token payload")
    exp = int(payload.get("exp") or 0)
    if exp and exp < int(_time.time()):
        raise ValueError("Token expired")
    return payload


def _safe_int_id(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _require_provider_auth() -> dict:
    auth_header = request.headers.get("Authorization") or ""
    token = auth_header or str(request.args.get("token") or "")
    try:
        decoded = decode_jwt(token)
    except ValueError as exc:
        raise PermissionError(str(exc)) from exc
    if bool(decoded.get("isGuest")) or str(decoded.get("role") or "").lower() == "guest":
        raise PermissionError("Guest users cannot access provider patient records")
    uid = _safe_int_id(decoded.get("id"))
    if uid <= 0:
        raise PermissionError("Invalid auth token")
    source = str(decoded.get("auth_source") or "")
    role = str(decoded.get("role") or "").lower()
    if source == "users" and role in ("regular user", "patient", "user", "guest"):
        raise PermissionError("OB-GYN provider access required")
    return decoded


def _diagnosis_label(code: Any) -> str:
    if code is None or code == "":
        return "pending"
    try:
        n = int(code)
    except (TypeError, ValueError):
        return "pending"
    return {0: "negative", 1: "positive", 2: "borderline"}.get(n, "pending")


def _norm_prob_percent(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n <= 1.0:
        n *= 100.0
    return round(n, 2)


def _ensure_owner_provider_column(cur) -> None:
    try:
        cur.execute(
            """
            ALTER TABLE patient_personal_info
            ADD COLUMN owner_provider_id INT NULL
            """
        )
    except Exception:  # noqa: BLE001
        pass


def _ensure_clinical_recommendations_column(cur) -> None:
    """Match PHP pcode_ensure_clinical_recommendations_column()."""
    try:
        cur.execute(
            """
            ALTER TABLE patient_personal_info
            ADD COLUMN clinical_recommendations TEXT NULL DEFAULT NULL
            """
        )
    except Exception:  # noqa: BLE001
        pass


def _coerce_contact_no(value: Any) -> Any:
    """patient_personal_info.contact_no is BIGINT: empty strings 500 in strict mode."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw or raw.lower() in {"null", "undefined", "nan", "n/a"}:
        return None
    digits = re.sub(r"\D+", "", raw)
    if not digits:
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def _ensure_patient_name_columns(cur) -> None:
    """Split patient_name into first / middle / surname on patient_personal_info."""
    existing = _table_columns(cur, "patient_personal_info")
    if not existing:
        return
    ddl = {
        "first_name": "VARCHAR(128) DEFAULT NULL",
        "middle_name": "VARCHAR(128) DEFAULT NULL",
        "surname": "VARCHAR(128) DEFAULT NULL",
    }
    for name, definition in ddl.items():
        if name in existing:
            continue
        try:
            cur.execute(
                f"ALTER TABLE patient_personal_info ADD COLUMN `{name}` {definition}"
            )
            existing.add(name)
        except Exception:  # noqa: BLE001
            pass


def _compose_patient_name(
    first: Optional[str],
    middle: Optional[str],
    surname: Optional[str],
) -> str:
    parts = [str(p).strip() for p in (first, middle, surname) if p and str(p).strip()]
    return " ".join(parts)


def _split_legacy_patient_name(legacy: Optional[str]) -> tuple[str, str, str]:
    text = str(legacy or "").strip()
    text = re.sub(r"^(?:PMOS|PCOS)-\d+\s*[:\-–]\s*", "", text, flags=re.I).strip()
    parts = [p for p in text.split() if p]
    if not parts:
        return "", "", ""
    if len(parts) == 1:
        return parts[0], "", ""
    if len(parts) == 2:
        return parts[0], "", parts[1]
    return parts[0], " ".join(parts[1:-1]), parts[-1]


def _patient_name_from_payload(data: dict) -> dict[str, Optional[str]]:
    first = str(data.get("first_name") or data.get("first") or "").strip()
    middle = str(data.get("middle_name") or data.get("middle") or "").strip()
    surname = str(
        data.get("surname") or data.get("last_name") or data.get("last") or ""
    ).strip()
    legacy = str(data.get("patient_name") or data.get("name") or "").strip()
    if re.search(r"(?:PMOS|PCOS)-\d+", legacy, flags=re.I):
        legacy = ""
    if not any((first, middle, surname)) and legacy:
        first, middle, surname = _split_legacy_patient_name(legacy)
    composed = _compose_patient_name(first, middle, surname) or legacy or None
    return {
        "first_name": first or None,
        "middle_name": middle or None,
        "surname": surname or None,
        "patient_name": composed,
        "name": composed,
    }


def _patient_name_response(row: dict) -> dict[str, Any]:
    """Return split name fields; legacy patient_name is parsed when splits are empty."""
    first = row.get("first_name")
    middle = row.get("middle_name")
    surname = row.get("surname") or row.get("last_name")
    legacy = row.get("patient_name") or row.get("name")
    if not any((first, middle, surname)) and legacy:
        first, middle, surname = _split_legacy_patient_name(str(legacy))
    composed = _compose_patient_name(first, middle, surname) or legacy
    return {
        "first_name": first or None,
        "middle_name": middle or None,
        "surname": surname or None,
        "patient_name": composed,
        "name": composed,
    }


def _ensure_patient_address_columns(cur) -> None:
    """Split address into street / barangay / municipality / city on patient_personal_info."""
    existing = _table_columns(cur, "patient_personal_info")
    if not existing:
        return
    if "address_barangay" not in existing and "address_town" in existing:
        try:
            cur.execute(
                "ALTER TABLE patient_personal_info "
                "CHANGE COLUMN `address_town` `address_barangay` VARCHAR(128) DEFAULT NULL"
            )
            existing.discard("address_town")
            existing.add("address_barangay")
        except Exception:  # noqa: BLE001
            pass
    ddl = {
        "address_street": "VARCHAR(255) DEFAULT NULL",
        "address_barangay": "VARCHAR(128) DEFAULT NULL",
        "address_municipality": "VARCHAR(128) DEFAULT NULL",
        "address_city": "VARCHAR(128) DEFAULT NULL",
        "address_province": "VARCHAR(128) DEFAULT NULL",
    }
    for name, definition in ddl.items():
        if name in existing:
            continue
        try:
            cur.execute(
                f"ALTER TABLE patient_personal_info ADD COLUMN `{name}` {definition}"
            )
            existing.add(name)
        except Exception:  # noqa: BLE001
            pass
    existing = _table_columns(cur, "patient_personal_info")
    if "address_barangay" in existing and "address_town" in existing:
        try:
            cur.execute(
                "UPDATE patient_personal_info "
                "SET address_barangay = address_town "
                "WHERE (address_barangay IS NULL OR address_barangay = '') "
                "AND address_town IS NOT NULL AND address_town <> ''"
            )
        except Exception:  # noqa: BLE001
            pass
        try:
            cur.execute("ALTER TABLE patient_personal_info DROP COLUMN `address_town`")
            existing.discard("address_town")
        except Exception:  # noqa: BLE001
            pass


def _compose_patient_address(
    street: Optional[str],
    barangay: Optional[str],
    municipality: Optional[str],
    city: Optional[str],
    province: Optional[str] = None,
) -> str:
    parts = [str(p).strip() for p in (street, barangay, municipality, city, province) if p and str(p).strip()]
    return ", ".join(parts)


def _pick_address_barangay(data: dict) -> str:
    for key in ("address_barangay", "barangay", "address_town", "town"):
        value = str(data.get(key) or "").strip()
        if value:
            return value
    return ""


def _patient_address_from_payload(data: dict) -> dict[str, Optional[str]]:
    street = str(data.get("address_street") or data.get("street") or "").strip()
    barangay = _pick_address_barangay(data)
    municipality = str(
        data.get("address_municipality") or data.get("municipality") or ""
    ).strip()
    city = str(data.get("address_city") or data.get("city") or "").strip()
    province = str(data.get("address_province") or data.get("province") or "").strip()
    legacy = str(data.get("address") or "").strip()
    if not any((street, barangay, municipality, city, province)) and legacy:
        street = legacy
    composed = _compose_patient_address(street, barangay, municipality, city, province) or legacy or None
    return {
        "address_street": street or None,
        "address_barangay": barangay or None,
        "address_town": barangay or None,
        "address_municipality": municipality or None,
        "address_city": city or None,
        "address_province": province or None,
        "address": composed,
    }


def _patient_address_response(row: dict) -> dict[str, Any]:
    """Return split address fields; legacy `address` fills street when splits are empty."""
    street = row.get("address_street")
    barangay = row.get("address_barangay") if row.get("address_barangay") not in (None, "") else row.get("address_town")
    municipality = row.get("address_municipality")
    city = row.get("address_city")
    legacy = row.get("address")
    if not any((street, barangay, municipality, city)) and legacy:
        street = legacy
    composed = _compose_patient_address(street, barangay, municipality, city) or legacy
    return {
        "address_street": street,
        "address_barangay": barangay,
        "address_town": barangay,
        "address_municipality": municipality,
        "address_city": city,
        "address": composed,
    }


def _coerce_sql_date(value: Any) -> Any:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw or raw.lower() in {"null", "undefined", "nan"}:
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", raw)
    return m.group(1) if m else None


def _ensure_user_diagnosis_schema(cur) -> None:
    """Best-effort schema fixes so community saves don't 500 on older Clever Cloud DBs."""
    alters = (
        "ALTER TABLE user_diagnosis_results ADD COLUMN screening_id VARCHAR(36) NULL DEFAULT NULL",
        "ALTER TABLE user_diagnosis_results ADD COLUMN created_by VARCHAR(32) NOT NULL DEFAULT 'Patient'",
        "ALTER TABLE user_diagnosis_results ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE user_diagnosis_results ADD COLUMN clinical_inputs_snapshot LONGTEXT NULL",
        "ALTER TABLE user_diagnosis_results ADD KEY idx_udr_screening_id (screening_id)",
        "ALTER TABLE user_diagnosis_results ADD KEY idx_udr_user_created (user_id, created_at)",
        "ALTER TABLE user_diagnosis_results DROP INDEX uniq_user",
        "ALTER TABLE user_diagnosis_results DROP INDEX uq_results_user_id",
        "ALTER TABLE user_diagnosis_parameters ADD UNIQUE KEY uq_user_id (user_id)",
    )
    for sql in alters:
        try:
            cur.execute(sql)
        except Exception:  # noqa: BLE001
            pass
    _ensure_user_clinical_timing_columns(cur)


def _ensure_user_clinical_timing_columns(cur) -> None:
    """Add LMP / draw / ultrasound timing columns on community user parameter rows."""
    existing = _table_columns(cur, "user_diagnosis_parameters")
    if not existing:
        return
    ddl = {
        "last_menstrual_period_date": "DATE DEFAULT NULL",
        "blood_draw_date": "DATE DEFAULT NULL",
        "ultrasound_date": "DATE DEFAULT NULL",
        "symptom_evaluation_date": "DATE DEFAULT NULL",
        "fasting_hours": "DECIMAL(4,1) DEFAULT NULL",
        "ultrasound_modality": "VARCHAR(32) DEFAULT 'TVUS'",
    }
    for name, definition in ddl.items():
        if name in existing:
            continue
        try:
            cur.execute(
                f"ALTER TABLE user_diagnosis_parameters ADD COLUMN `{name}` {definition}"
            )
            existing.add(name)
        except Exception:  # noqa: BLE001
            pass


def _table_columns(cur, table: str) -> set[str]:
    try:
        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        rows = cur.fetchall() or []
        cols: set[str] = set()
        for row in rows:
            if isinstance(row, dict):
                name = row.get("Field") or row.get("field")
            else:
                name = row[0] if row else None
            if name:
                cols.add(str(name))
        return cols
    except Exception:  # noqa: BLE001
        return set()


def _ensure_clinical_timing_columns(cur) -> None:
    """Add LMP / draw / ultrasound / fasting columns on older Clever Cloud schemas."""
    existing = _table_columns(cur, "patient_diagnosis_parameters")
    if not existing:
        return
    ddl = {
        "last_menstrual_period_date": "DATE DEFAULT NULL",
        "blood_draw_date": "DATE DEFAULT NULL",
        "ultrasound_date": "DATE DEFAULT NULL",
        "symptom_evaluation_date": "DATE DEFAULT NULL",
        "fasting_hours": "DECIMAL(4,1) DEFAULT NULL",
        "ultrasound_modality": "VARCHAR(32) DEFAULT 'TVUS'",
    }
    for name, definition in ddl.items():
        if name in existing:
            continue
        try:
            cur.execute(
                f"ALTER TABLE patient_diagnosis_parameters ADD COLUMN `{name}` {definition}"
            )
            existing.add(name)
        except Exception:  # noqa: BLE001
            pass


def _ensure_admin_account_schema(cur) -> None:
    """Idempotent columns/tables for admin roster, sessions, and audit."""
    alters = (
        "ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1",
        "ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN last_login DATETIME NULL DEFAULT NULL",
        "ALTER TABLE clinical_providers ADD COLUMN token_version INT NOT NULL DEFAULT 0",
        "ALTER TABLE clinical_providers ADD COLUMN last_login DATETIME NULL DEFAULT NULL",
        """
        CREATE TABLE IF NOT EXISTS admin_audit_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            actor_id INT NULL,
            actor_email VARCHAR(255) NULL,
            actor_role VARCHAR(64) NULL,
            action VARCHAR(64) NOT NULL,
            target_type VARCHAR(64) NULL,
            target_id INT NULL,
            target_email VARCHAR(255) NULL,
            detail JSON NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_admin_audit_created (created_at),
            KEY idx_admin_audit_action (action)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
    )
    for sql in alters:
        try:
            cur.execute(sql)
        except Exception:  # noqa: BLE001
            pass


def _admin_audit(
    cur,
    actor: dict,
    *,
    action: str,
    target_type: str = "",
    target_id: Optional[int] = None,
    target_email: str = "",
    detail: Optional[dict] = None,
) -> None:
    try:
        import json as _json

        _ensure_admin_account_schema(cur)
        cur.execute(
            """
            INSERT INTO admin_audit_log
                (actor_id, actor_email, actor_role, action, target_type, target_id, target_email, detail)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                int(actor.get("id") or 0) or None,
                str(actor.get("email") or "") or None,
                str(actor.get("role") or "") or None,
                str(action or "")[:64],
                str(target_type or "")[:64] or None,
                int(target_id) if target_id else None,
                str(target_email or "") or None,
                _json.dumps(detail or {}, default=str),
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("admin audit write skipped: %s", exc)


def _fetch_token_version(auth_source: str, uid: int) -> Optional[int]:
    if uid <= 0:
        return None
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_admin_account_schema(cur)
                if auth_source == "clinical_providers":
                    cur.execute(
                        "SELECT token_version, is_active FROM clinical_providers WHERE id = %s LIMIT 1",
                        (uid,),
                    )
                else:
                    cur.execute(
                        "SELECT token_version, is_active FROM users WHERE user_id = %s LIMIT 1",
                        (uid,),
                    )
                row = cur.fetchone()
                if not row:
                    return None
                if int(row.get("is_active") if row.get("is_active") is not None else 1) != 1:
                    raise PermissionError("Account is deactivated")
                return int(row.get("token_version") or 0)
    except PermissionError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("token version lookup failed: %s", exc)
        return 0


def _assert_token_still_valid(decoded: dict) -> None:
    """Reject JWTs after force-logout / password reset (token_version bump)."""
    uid = int(decoded.get("id") or 0)
    source = str(decoded.get("auth_source") or "users")
    try:
        claim_tv = int(decoded.get("tv") or 0)
    except (TypeError, ValueError):
        claim_tv = 0
    current = _fetch_token_version(source, uid)
    if current is None:
        raise PermissionError("Account not found or session invalid")
    if claim_tv != current:
        raise PermissionError("Session invalidated. Please sign in again.")


def _touch_last_login(auth_source: str, uid: int) -> None:
    if uid <= 0:
        return
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_admin_account_schema(cur)
                if auth_source == "clinical_providers":
                    cur.execute(
                        "UPDATE clinical_providers SET last_login = NOW() WHERE id = %s LIMIT 1",
                        (uid,),
                    )
                else:
                    cur.execute(
                        "UPDATE users SET last_login = NOW() WHERE user_id = %s LIMIT 1",
                        (uid,),
                    )
                conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("last_login update skipped: %s", exc)


def _normalize_ultrasound_modality(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if text in {"tvus", "transvaginal", "trans-vaginal", "vaginal", "transvaginal ultrasound"}:
        return "TVUS"
    if text in {"transabdominal", "taus", "pelvic", "abdominal", "transabdominal/pelvic"}:
        return "Transabdominal"
    if text in {"other", "alternate"}:
        return "Other"
    return "TVUS"


def _coerce_yes_no(raw: str) -> Optional[int]:
    low = raw.strip().lower()
    if low in {"yes", "y", "1", "true", "on"}:
        return 1
    if low in {"no", "n", "0", "false", "off"}:
        return 0
    return None


def _coerce_user_param_value(column: str, value: Any) -> Any:
    """Coerce clinical form values into DB-safe types (CycleR_I: Regular=0, Irregular=1)."""
    if value is None:
        return None
    if isinstance(value, str):
        raw = value.strip()
        if raw == "" or raw.lower() in {"null", "undefined", "nan"}:
            return None
        if column == "CycleR_I":
            low = raw.lower()
            if low in {"regular", "0"}:
                return 0
            if low in {"irregular", "amenorrhea", "amenorrhoea", "1"}:
                return 1
            try:
                return float(raw)
            except ValueError:
                return None
        if column == "Pregnant":
            yn = _coerce_yes_no(raw)
            if yn is not None:
                return yn
            if raw.lower() in {"pregnant"}:
                return 1
            if raw.lower() in {"not pregnant"}:
                return 0
            try:
                return 1 if int(float(raw)) else 0
            except ValueError:
                return None
        if column in {
            "Weight_gain", "Hair_growth", "Skin_darkening", "Hair_loss",
            "Pimples", "Fast_food", "Reg_Exercise",
        }:
            yn = _coerce_yes_no(raw)
            if yn is not None:
                return yn
            try:
                return int(float(raw))
            except ValueError:
                return None
        if column == "ultrasound_modality":
            return _normalize_ultrasound_modality(raw)
        if column in {
            "Blood_Group",
            "Age_yrs", "Pulse_rate_bpm", "RR_breath_min", "Cycle_length_days",
            "Marriage_Status_years", "No_of_abortions", "Follicle_no_L", "Follicle_no_R",
            "BP_Systolic_mmHg", "BP_Diastolic_mmHg", "fasting_hours",
        }:
            try:
                if "." in raw:
                    return float(raw)
                return int(raw)
            except ValueError:
                return None
        if column in {
            "last_menstrual_period_date", "blood_draw_date", "ultrasound_date",
            "symptom_evaluation_date",
        }:
            # Match PHP save_patient: keep YYYY-MM-DD prefix
            m = re.match(r"^(\d{4}-\d{2}-\d{2})", raw)
            if m:
                return m.group(1)
            return None
        try:
            if re.fullmatch(r"-?\d+(\.\d+)?", raw):
                return float(raw) if "." in raw else int(raw)
        except Exception:  # noqa: BLE001
            pass
        return raw
    if column == "CycleR_I":
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    if column == "Pregnant":
        try:
            return 1 if int(value) else 0
        except (TypeError, ValueError):
            return None
    if column == "ultrasound_modality":
        return _normalize_ultrasound_modality(value)
    return value


def _looks_like_base64_text(text: str) -> bool:
    """True when text is printable base64 (optionally a data-URI payload)."""
    if not text:
        return False
    sample = re.sub(r"\s+", "", text.strip())
    if sample.startswith("data:") and "," in sample:
        sample = sample.split(",", 1)[1]
    if len(sample) < 32:
        return False
    # Allow standard and URL-safe base64
    return bool(re.fullmatch(r"[A-Za-z0-9+/_\-]+=*", sample))


def _ultrasound_mime_from_magic(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _format_ultrasound(value: Any) -> Any:
    """
    Normalize DB ultrasound blobs to a browser-safe data URI.

    Storage is mixed across eras of the app:
      - raw JPEG/PNG bytes in LONGBLOB
      - ASCII base64 text in BLOB/TEXT
      - full data:image/...;base64,... strings
      - latin-1 "binary strings" from some drivers
    Never base64-encode text that is already base64, and never prepend a data-
    URI header onto raw binary without encoding first.
    """
    if value is None or value == "":
        return None

    if isinstance(value, memoryview):
        value = value.tobytes()

    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        if not raw:
            return None
        # Data-URI / base64 text stored inside a BLOB
        if raw.startswith(b"data:image") or raw.startswith(b"data:application"):
            try:
                return _format_ultrasound(raw.decode("ascii"))
            except UnicodeDecodeError:
                pass
        try:
            as_ascii = raw.decode("ascii")
        except UnicodeDecodeError:
            as_ascii = None
        if as_ascii is not None and _looks_like_base64_text(as_ascii):
            return _format_ultrasound(as_ascii)
        mime = _ultrasound_mime_from_magic(raw)
        return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # Binary masquerading as a Python str (latin-1 / cp1252 from drivers)
        head = text[:16]
        if (
            text.startswith("\xff\xd8\xff")
            or text.startswith("\x89PNG\r\n\x1a\n")
            or any(ord(ch) > 127 for ch in head)
        ):
            raw = text.encode("latin-1", errors="ignore")
            mime = _ultrasound_mime_from_magic(raw)
            return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")

        if text.startswith("data:"):
            comma = text.find(",")
            if comma < 0:
                return None
            header = text[: comma + 1]
            payload = re.sub(r"\s+", "", text[comma + 1 :])
            # Unwrap accidental nested data URIs
            while payload.startswith("data:") and "," in payload:
                payload = re.sub(r"\s+", "", payload.split(",", 1)[1])
            if not payload:
                return None
            return header + payload

        # Raw base64 text (no data-URI header)
        payload = re.sub(r"\s+", "", text)
        if not _looks_like_base64_text(payload):
            # Last resort: treat as latin-1 binary
            raw = text.encode("latin-1", errors="ignore")
            if not raw:
                return None
            mime = _ultrasound_mime_from_magic(raw)
            return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
        # Sniff decoded magic when cheap
        mime = "image/jpeg"
        try:
            decoded = base64.b64decode(payload[:64] + "==", validate=False)
            mime = _ultrasound_mime_from_magic(decoded)
        except Exception:  # noqa: BLE001
            pass
        return f"data:{mime};base64," + payload

    return None


_PATIENT_PARAM_FIELDS = (
    "Age_yrs", "Weight_kg", "Height_cm", "BMI", "Blood_Group", "Pulse_rate_bpm", "RR_breath_min",
    "Hb_g_dl", "CycleR_I", "Cycle_length_days", "Marriage_Status_years", "Pregnant", "No_of_abortions",
    "I_beta_HCG_mIU_mL", "II_beta_HCG_mIU_mL", "FSH_mIU_mL", "LH_mIU_mL", "FSH_LH", "Hip_inch",
    "Waist_inch", "Waist_hip_ratio", "TSH_mIU_L", "AMH_ng_mL", "PRL_ng_mL", "Vit_D3_ng_mL",
    "PRG_ng_mL", "RBS_mg_dl", "Weight_gain", "Hair_growth", "Skin_darkening", "Hair_loss",
    "Pimples", "Fast_food", "Reg_Exercise", "BP_Systolic_mmHg", "BP_Diastolic_mmHg",
    "Follicle_no_L", "Follicle_no_R", "Avg_F_size_L_mm", "Avg_F_size_R_mm", "Endometrium_mm",
    "Ultrasound_image",
    "last_menstrual_period_date", "blood_draw_date", "ultrasound_date",
    "symptom_evaluation_date", "fasting_hours", "ultrasound_modality",
)


@bp.get("/api/patients/get_patients_list")
@bp.get("/api/patients/get_patients_list.php")
def api_get_patients_list():
    """Provider patient dashboard grid: mirrors PHP get_patients_list.php shape."""
    try:
        decoded = _require_provider_auth()
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    provider_id = int(decoded.get("id") or 0)
    patients: list[dict[str, Any]] = []

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_owner_provider_column(cur)
                _ensure_patient_address_columns(cur)
                _ensure_patient_name_columns(cur)
                cur.execute(
                    """
                    SELECT
                        p.patient_id,
                        p.patient_name,
                        p.first_name,
                        p.middle_name,
                        p.surname,
                        p.age,
                        p.date_of_birth,
                        p.contact_no,
                        p.civil_status,
                        p.address,
                        p.address_street,
                        p.address_barangay,
                        p.address_municipality,
                        p.address_city,
                        p.occupation,
                        p.religion,
                        p.reffered_by AS referred_by,
                        p.clinical_recommendations,
                        p.linked_user_id,
                        p.owner_provider_id,
                        DATE_FORMAT(p.date_added, '%%Y-%%m-%%d') AS date_added,
                        r.diagnosis_id,
                        r.screening_id,
                        r.XGBoost_diagnosis,
                        r.XGBoost_diagnosis_probability_percentage,
                        r.CNN_diagnosis,
                        r.CNN_diagnosis_probability_percentage,
                        r.Overall_diagnosis,
                        r.Overall_diagnosis_probability_percentage,
                        r.created_by AS result_created_by,
                        r.created_at AS last_screened_at
                    FROM patient_personal_info p
                    LEFT JOIN patient_diagnosis_results r
                        ON r.patient_id = p.patient_id
                       AND r.diagnosis_id = (
                            SELECT r2.diagnosis_id
                            FROM patient_diagnosis_results r2
                            WHERE r2.patient_id = p.patient_id
                            ORDER BY r2.created_at DESC, r2.diagnosis_id DESC
                            LIMIT 1
                       )
                    WHERE p.owner_provider_id = %s
                    ORDER BY COALESCE(r.created_at, p.date_added) DESC, p.patient_id DESC
                    """,
                    (provider_id,),
                )
                rows = cur.fetchall() or []

                for row in rows:
                    pid = int(row["patient_id"])
                    cur.execute(
                        """
                        SELECT *
                        FROM patient_diagnosis_parameters
                        WHERE patient_id = %s
                          AND (screening_id IS NULL OR screening_id = '')
                        ORDER BY parameter_id DESC
                        LIMIT 1
                        """,
                        (pid,),
                    )
                    params = cur.fetchone() or {}

                    xg_label = _diagnosis_label(row.get("XGBoost_diagnosis"))
                    cnn_label = _diagnosis_label(row.get("CNN_diagnosis"))
                    overall_label = _diagnosis_label(row.get("Overall_diagnosis"))
                    if overall_label == "pending" and (xg_label != "pending" or cnn_label != "pending"):
                        overall_label = xg_label if xg_label != "pending" else cnn_label

                    last_screened = row.get("last_screened_at")
                    last_screened_iso = _serialize_value(last_screened)
                    last_tested_display = _format_manila_display(last_screened)
                    if not last_tested_display and last_screened_iso:
                        last_tested_display = str(last_screened_iso)

                    formatted: dict[str, Any] = {
                        "id": f"PMOS-{pid:03d}",
                        "patient_id": pid,
                        **_patient_name_response(row),
                        "age": int(row.get("age") or 0),
                        "date_added": row.get("date_added"),
                        **_patient_address_response(row),
                        "contact_no": row.get("contact_no"),
                        "DOB": _serialize_value(row.get("date_of_birth")),
                        "civil_status": row.get("civil_status"),
                        "occupation": row.get("occupation"),
                        "religion": row.get("religion"),
                        "referred_by": row.get("referred_by"),
                        "clinical_recommendations": row.get("clinical_recommendations"),
                        "clinical_score_percentage": _norm_prob_percent(
                            row.get("XGBoost_diagnosis_probability_percentage")
                        ),
                        "imaging_score_percentage": _norm_prob_percent(
                            row.get("CNN_diagnosis_probability_percentage")
                        ),
                        "overall_diagnosis_percentage": _norm_prob_percent(
                            row.get("Overall_diagnosis_probability_percentage")
                        ),
                        "xgboost_diagnosis": xg_label,
                        "cnn_diagnosis": cnn_label,
                        "overall_diagnosis": overall_label,
                        "diagnosis_id": int(row["diagnosis_id"]) if row.get("diagnosis_id") else None,
                        "screening_id": row.get("screening_id"),
                        "last_screened_at": last_screened_iso,
                        "last_tested_display": last_tested_display,
                        "latest_screening_at": last_screened_iso,
                        "latest_screening_display": last_tested_display,
                        "latest_screening_origin": (
                            "User App Self-Screening"
                            if str(row.get("result_created_by") or "") == "Patient"
                            else "Clinician Upload"
                        ),
                        "latest_screening_origin_code": row.get("result_created_by") or "Physician",
                        "latest_screening_status": (
                            "Positive"
                            if overall_label == "positive"
                            else ("Negative" if overall_label == "negative" else "Pending")
                        ),
                        "latest_screening_status_code": overall_label,
                        "history_run_count": 0,
                    }

                    for field in _PATIENT_PARAM_FIELDS:
                        if field not in params:
                            continue
                        val = params.get(field)
                        if field == "Ultrasound_image":
                            formatted[field] = _format_ultrasound(val)
                            # Frontend XAI checks both casings
                            formatted["ultrasound_image"] = formatted[field]
                            formatted["medical_image"] = formatted[field]
                        else:
                            formatted[field] = _serialize_value(val)

                    patients.append(formatted)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Patient list failed")
        return _json_error("Failed to load patients", 500, detail=str(exc))

    return jsonify({"success": True, "data": patients, "count": len(patients)}), 200


@bp.get("/api/get_patients")
@bp.get("/api/get_patients.php")
def api_get_patients():
    """
    Dashboard-friendly patient list (alias of get_patients_list).
    Replaces PHP api/get_patients.php for Firebase → Render.
    """
    return api_get_patients_list()


@bp.get("/api/get_patients_xai")
@bp.get("/api/get_patients_xai.php")
@bp.get("/api/get_patients_simple")
@bp.get("/api/get_patients_simple.php")
def api_get_patients_xai():
    """
    XAI / Detect patient list alias.
    PHP get_patients_xai.php is a scoped list; on Render we reuse the
    provider-owned get_patients_list payload (same fields Detect/XAI need).
    """
    return api_get_patients_list()


def _norm_history_entry(row: dict, source: str = "patient_diagnosis_results") -> dict:
    """Shape expected by js/pcode-diagnosis-history.js."""
    overall_code = row.get("Overall_diagnosis")
    try:
        overall_code = int(overall_code) if overall_code is not None else None
    except (TypeError, ValueError):
        overall_code = None
    overall_pct = _norm_prob_percent(row.get("Overall_diagnosis_probability_percentage"))
    xgb_pct = _norm_prob_percent(row.get("XGBoost_diagnosis_probability_percentage"))
    cnn_pct = _norm_prob_percent(row.get("CNN_diagnosis_probability_percentage"))
    if overall_pct is None:
        probs = [p for p in (xgb_pct, cnn_pct) if p is not None]
        overall_pct = round(sum(probs) / len(probs), 1) if probs else None
    if overall_code is None:
        if overall_pct is not None:
            overall_code = 1 if overall_pct >= 75 else (2 if overall_pct >= 55 else 0)
        else:
            overall_code = None

    status_map = {
        1: ("positive", "Positive", "pcode-history-status--detected"),
        0: ("negative", "Negative", "pcode-history-status--clear"),
        2: ("borderline", "Borderline", "pcode-history-status--borderline"),
    }
    status_code, status_label, status_badge = status_map.get(
        overall_code if overall_code is not None else -1,
        ("pending", "Pending", "pcode-history-status--detected"),
    )
    created_by = str(row.get("created_by") or "Physician")
    if created_by.lower() in ("patient", "user", "regular user"):
        origin_label, origin_badge, origin_code = (
            "User App Self-Screening",
            "pcode-history-origin--patient",
            "Patient",
        )
    else:
        origin_label, origin_badge, origin_code = (
            "Clinician Upload",
            "pcode-history-origin--clinician",
            "Physician",
        )

    created_at = row.get("created_at")
    created_iso = _serialize_value(created_at)
    created_display = _format_manila_display(created_at)
    if not created_display and created_iso:
        created_display = str(created_iso)

    clinical = {}
    snap = row.get("clinical_inputs_snapshot")
    if isinstance(snap, (bytes, bytearray)):
        try:
            snap = snap.decode("utf-8", errors="ignore")
        except Exception:  # noqa: BLE001
            snap = None
    if isinstance(snap, str) and snap.strip():
        try:
            import json as _json

            decoded = _json.loads(snap)
            if isinstance(decoded, dict):
                clinical = decoded
        except Exception:  # noqa: BLE001
            clinical = {}
    elif isinstance(snap, dict):
        clinical = snap

    # Merge parameter_row fallback when snapshot is empty (parity with PHP history helper)
    if (not clinical) and isinstance(row.get("parameter_row"), dict):
        clinical = {
            k: v
            for k, v in row["parameter_row"].items()
            if k
            not in (
                "parameter_id",
                "patient_id",
                "user_id",
                "screening_id",
                "created_by",
                "created_at",
                "Ultrasound_image",
                "ultrasound_image",
            )
            and v is not None
            and v != ""
        }

    # Drop empty nested noise but keep numeric zeros / boolean-like flags
    if clinical:
        clinical = {
            k: v
            for k, v in clinical.items()
            if v is not None and v != "" and str(k) not in ("Ultrasound_image", "ultrasound_image")
        }

    return {
        "diagnosis_id": int(row.get("diagnosis_id") or 0),
        "screening_id": row.get("screening_id"),
        "parameter_id": int(row["parameter_id"]) if row.get("parameter_id") else None,
        "source": source,
        "created_at": created_iso,
        "created_at_display": created_display or created_iso,
        "created_by": origin_code,
        "origin_label": origin_label,
        "origin_badge_class": origin_badge,
        "status_code": status_code,
        "status_label": status_label,
        "status_badge_class": status_badge,
        "confidence_fraction": (overall_pct / 100.0) if overall_pct is not None else None,
        "confidence_percent": overall_pct,
        "confidence_display": f"{overall_pct:.1f}% Confidence" if overall_pct is not None else "N/A",
        "threshold": 0.75,
        "xgboost_diagnosis": int(row["XGBoost_diagnosis"]) if row.get("XGBoost_diagnosis") is not None else None,
        "xgboost_probability_percent": xgb_pct,
        "cnn_diagnosis": int(row["CNN_diagnosis"]) if row.get("CNN_diagnosis") is not None else None,
        "cnn_probability_percent": cnn_pct,
        "overall_diagnosis": overall_code,
        "clinical_inputs": clinical,
        "metrics_summary": {},
        "frozen_parameters": clinical,
        "ultrasound_image": _format_ultrasound(row.get("ultrasound_image") or row.get("Ultrasound_image")),
    }


@bp.get("/api/diagnostics/get_patient_history")
@bp.get("/api/diagnostics/get_patient_history.php")
def api_get_patient_history():
    """Provider diagnosis timeline for one patient (Firebase → Render)."""
    try:
        decoded = _require_provider_auth()
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    provider_id = int(decoded.get("id") or 0)
    try:
        patient_id = int(request.args.get("patient_id") or 0)
    except (TypeError, ValueError):
        patient_id = 0
    if patient_id <= 0:
        return _json_error("A valid patient_id query parameter is required", 400)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_owner_provider_column(cur)
                cur.execute(
                    """
                    SELECT patient_id, patient_name, linked_user_id
                    FROM patient_personal_info
                    WHERE patient_id = %s AND owner_provider_id = %s
                    LIMIT 1
                    """,
                    (patient_id, provider_id),
                )
                patient = cur.fetchone()
                if not patient:
                    return _json_error("Patient not found", 404)

                cur.execute(
                    """
                    SELECT
                        diagnosis_id, screening_id, patient_id,
                        XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
                        CNN_diagnosis, CNN_diagnosis_probability_percentage,
                        Overall_diagnosis, Overall_diagnosis_probability_percentage,
                        created_by, created_at, clinical_inputs_snapshot
                    FROM patient_diagnosis_results
                    WHERE patient_id = %s
                    ORDER BY created_at DESC, diagnosis_id DESC
                    """,
                    (patient_id,),
                )
                rows = cur.fetchall() or []
                entries = [_norm_history_entry(dict(r), "patient_diagnosis_results") for r in rows]

                linked_user_id = int(patient.get("linked_user_id") or 0)
                if linked_user_id > 0:
                    try:
                        cur.execute(
                            """
                            SELECT
                                diagnosis_id, screening_id, user_id,
                                XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
                                CNN_diagnosis, CNN_diagnosis_probability_percentage,
                                Overall_diagnosis, Overall_diagnosis_probability_percentage,
                                created_by, created_at, clinical_inputs_snapshot
                            FROM user_diagnosis_results
                            WHERE user_id = %s
                            ORDER BY created_at DESC, diagnosis_id DESC
                            """,
                            (linked_user_id,),
                        )
                        for r in cur.fetchall() or []:
                            row = dict(r)
                            row.setdefault("created_by", "Patient")
                            entries.append(_norm_history_entry(row, "user_diagnosis_results"))
                    except Exception:  # noqa: BLE001
                        pass

                entries.sort(key=lambda e: str(e.get("created_at") or ""), reverse=True)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Patient history failed")
        return _json_error("Failed to load patient history", 500, detail=str(exc))

    return jsonify(
        {
            "success": True,
            "patient_id": patient_id,
            "patient_name": patient.get("patient_name"),
            "linked_user_id": linked_user_id if linked_user_id > 0 else None,
            "threshold": 0.75,
            "is_baseline": len(entries) == 0,
            "message": (
                "No prior diagnostic runs recorded. Baseline history is ready for the first screening."
                if not entries
                else "Patient diagnosis history loaded successfully"
            ),
            "count": len(entries),
            "history": entries,
        }
    ), 200


@bp.get("/api/diagnostics/get_user_history")
@bp.get("/api/diagnostics/get_user_history.php")
def api_get_user_history():
    """Regular-user self-screening timeline."""
    try:
        decoded = decode_jwt(request.headers.get("Authorization") or request.args.get("token") or "")
    except ValueError as exc:
        return _json_error(str(exc), 401)
    if bool(decoded.get("isGuest")):
        return _json_error("Guest users cannot access screening history", 403)
    user_id = int(decoded.get("id") or 0)
    if user_id <= 0:
        return _json_error("Invalid user session", 401)

    entries: list[dict] = []
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                try:
                    cur.execute(
                        """
                        SELECT
                            diagnosis_id, screening_id, user_id,
                            XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
                            CNN_diagnosis, CNN_diagnosis_probability_percentage,
                            Overall_diagnosis, Overall_diagnosis_probability_percentage,
                            created_by, created_at, clinical_inputs_snapshot
                        FROM user_diagnosis_results
                        WHERE user_id = %s
                        ORDER BY created_at DESC, diagnosis_id DESC
                        """,
                        (user_id,),
                    )
                    rows = [dict(r) for r in (cur.fetchall() or [])]
                    # Prefer frozen snapshot; only fall back to parameter ledger for THIS screening_id.
                    param_cols = _table_columns(cur, "user_diagnosis_parameters")
                    has_screening_on_params = bool(param_cols) and "screening_id" in param_cols
                    for row in rows:
                        row.setdefault("created_by", "Patient")
                        snap = row.get("clinical_inputs_snapshot")
                        snap_empty = False
                        if snap is None or snap == "":
                            snap_empty = True
                        elif isinstance(snap, str):
                            try:
                                import json as _json

                                decoded = _json.loads(snap)
                                snap_empty = not isinstance(decoded, dict) or len(decoded) == 0
                            except Exception:  # noqa: BLE001
                                snap_empty = True
                        elif isinstance(snap, dict):
                            snap_empty = len(snap) == 0
                        if snap_empty and has_screening_on_params and row.get("screening_id"):
                            try:
                                cur.execute(
                                    """
                                    SELECT * FROM user_diagnosis_parameters
                                    WHERE user_id = %s AND screening_id = %s
                                    LIMIT 1
                                    """,
                                    (user_id, str(row.get("screening_id"))),
                                )
                                param_row = cur.fetchone()
                                if param_row:
                                    row["parameter_row"] = dict(param_row)
                                    if param_row.get("Ultrasound_image"):
                                        row["ultrasound_image"] = param_row.get("Ultrasound_image")
                            except Exception:  # noqa: BLE001
                                pass
                        entries.append(_norm_history_entry(row, "user_diagnosis_results"))
                except Exception:  # noqa: BLE001
                    entries = []
    except Exception as exc:  # noqa: BLE001
        logger.exception("User history failed")
        return _db_failure_response(exc, "Failed to load screening history")

    return jsonify(
        {
            "success": True,
            "user_id": user_id,
            "threshold": 0.75,
            "is_baseline": len(entries) == 0,
            "message": (
                "No screening history yet. Complete a Detect run and tap Save Record to start your timeline."
                if not entries
                else "Screening history loaded successfully"
            ),
            "count": len(entries),
            "history": entries,
        }
    ), 200


@bp.get("/api/get_patient")
@bp.get("/api/get_patient.php")
def api_get_patient():
    """Single patient + draft clinical parameters for Detect forms."""
    try:
        decoded = _require_provider_auth()
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    provider_id = int(decoded.get("id") or 0)
    raw_id = request.args.get("id") or ""
    try:
        patient_id = int(re.sub(r"^(?:PCOS|PMOS)-", "", str(raw_id), flags=re.I))
    except (TypeError, ValueError):
        patient_id = 0
    if patient_id <= 0:
        return _json_error("Patient ID is required", 400)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_owner_provider_column(cur)
                _ensure_clinical_timing_columns(cur)
                _ensure_patient_address_columns(cur)
                _ensure_patient_name_columns(cur)
                cur.execute(
                    """
                    SELECT patient_id, patient_name, first_name, middle_name, surname,
                           age, date_of_birth, contact_no, address,
                           address_street, address_barangay, address_municipality, address_city,
                           civil_status, occupation, religion, reffered_by, clinical_recommendations
                    FROM patient_personal_info
                    WHERE patient_id = %s AND owner_provider_id = %s
                    LIMIT 1
                    """,
                    (patient_id, provider_id),
                )
                personal = cur.fetchone()
                if not personal:
                    return _json_error("Patient not found", 404)
                params: dict[str, Any] = {}
                _coalesce_parameter_rows(cur, patient_id, params)
                # Draft rows may omit the image; fall back to the newest params row that has one
                if not (params.get("Ultrasound_image") if isinstance(params, dict) else None):
                    try:
                        cur.execute(
                            """
                            SELECT Ultrasound_image
                            FROM patient_diagnosis_parameters
                            WHERE patient_id = %s
                              AND Ultrasound_image IS NOT NULL
                              AND OCTET_LENGTH(Ultrasound_image) > 32
                            ORDER BY parameter_id DESC
                            LIMIT 1
                            """,
                            (patient_id,),
                        )
                        us_row = cur.fetchone()
                        if us_row and us_row.get("Ultrasound_image"):
                            params = dict(params) if params else {}
                            params["Ultrasound_image"] = us_row["Ultrasound_image"]
                    except Exception:  # noqa: BLE001
                        pass
    except Exception as exc:  # noqa: BLE001
        logger.exception("Get patient failed")
        return _json_error("Failed to load patient", 500, detail=str(exc))

    data: dict[str, Any] = {
        "id": f"PMOS-{patient_id:03d}",
        "patient_id": patient_id,
        **_patient_name_response(personal),
        "Age_yrs": personal.get("age"),
        "DOB": _serialize_value(personal.get("date_of_birth")),
        "contact_no": personal.get("contact_no"),
        **_patient_address_response(personal),
        "civil_status": personal.get("civil_status"),
        "occupation": personal.get("occupation"),
        "religion": personal.get("religion"),
        "referred_by": personal.get("reffered_by"),
        "clinical_recommendations": personal.get("clinical_recommendations"),
    }
    for k, v in dict(params).items():
        if k in ("parameter_id", "patient_id", "screening_id", "created_at", "created_by"):
            continue
        data[k] = _format_ultrasound(v) if k == "Ultrasound_image" else _serialize_value(v)

    # Normalize form-facing binaries (parity with PHP get_patient.php)
    for flag in (
        "Weight_gain", "Hair_growth", "Skin_darkening", "Hair_loss",
        "Pimples", "Fast_food", "Reg_Exercise", "Pregnant",
    ):
        if flag not in data or data[flag] in (None, ""):
            data[flag] = 0
        else:
            coerced = _coerce_user_param_value(flag, data[flag])
            data[flag] = 0 if coerced is None else int(coerced)

    if "CycleR_I" in data and data["CycleR_I"] is not None:
        cyc = _coerce_user_param_value("CycleR_I", data["CycleR_I"])
        if cyc is not None:
            data["CycleR_I"] = cyc

    if data.get("Ultrasound_image"):
        data["medical_image"] = data["Ultrasound_image"]
    else:
        data["medical_image"] = None

    return _json_ok(data, message="Patient loaded")


@bp.post("/api/save_diagnosis_results")
@bp.post("/api/save_diagnosis_results.php")
def api_save_diagnosis_results():
    """Persist a screening result row (Detect save flow)."""
    import json as _json
    import uuid as _uuid

    try:
        decoded = decode_jwt(request.headers.get("Authorization") or "")
    except ValueError as exc:
        return _json_error(str(exc), 401)

    if bool(decoded.get("isGuest")) or str(decoded.get("role") or "").lower() == "guest":
        return _json_error("Guest users cannot save diagnosis results", 403)

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not payload:
        return _json_error("No data provided", 400)

    try:
        patient_id = int(payload.get("patient_id") or 0)
    except (TypeError, ValueError):
        patient_id = 0
    if patient_id <= 0:
        return _json_error("patient_id is required", 400)

    def _code(v):
        if v is None or v == "":
            return None
        if isinstance(v, (int, float)):
            return int(v)
        s = str(v).strip().lower()
        if s in ("positive", "1", "pmos", "pcos"):
            return 1
        if s in ("negative", "0", "normal"):
            return 0
        if s in ("borderline", "2"):
            return 2
        try:
            return int(float(s))
        except (TypeError, ValueError):
            return None

    def _pct(v):
        return _norm_prob_percent(v)

    screening_id = str(payload.get("screening_id") or _uuid.uuid4())
    created_by = "Physician"
    role = str(decoded.get("role") or "").lower()
    if role in ("regular user", "patient", "user"):
        created_by = "Patient"

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO patient_diagnosis_results
                    (patient_id, XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
                     CNN_diagnosis, CNN_diagnosis_probability_percentage,
                     Overall_diagnosis, Overall_diagnosis_probability_percentage,
                     created_by, clinical_inputs_snapshot, screening_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        patient_id,
                        _code(payload.get("XGBoost_diagnosis") or payload.get("xgboost_diagnosis")),
                        _pct(payload.get("XGBoost_diagnosis_probability_percentage") or payload.get("xgboost_probability")),
                        _code(payload.get("CNN_diagnosis") or payload.get("cnn_diagnosis")),
                        _pct(payload.get("CNN_diagnosis_probability_percentage") or payload.get("cnn_probability")),
                        _code(payload.get("Overall_diagnosis") or payload.get("overall_diagnosis")),
                        _pct(payload.get("Overall_diagnosis_probability_percentage") or payload.get("overall_probability")),
                        created_by,
                        _json.dumps(
                            payload.get("clinical_inputs_snapshot")
                            or payload.get("clinical_inputs")
                            or payload.get("clinical")
                            or {},
                            default=str,
                        ),
                        screening_id,
                    ),
                )
                diagnosis_id = int(cur.lastrowid)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Save diagnosis results failed")
        return _json_error("Failed to save diagnosis results", 500, detail=str(exc))

    return _json_ok(
        {"diagnosis_id": diagnosis_id, "screening_id": screening_id, "patient_id": patient_id},
        message="Diagnosis results saved",
        diagnosis_id=diagnosis_id,
        screening_id=screening_id,
    )


# --- Auth extras / user diagnosis / clinical validity / admin / export ------
def _hash_password_for_storage(password: str) -> str:
    digest = _password_to_digest(password)
    hashed = bcrypt.hashpw(digest.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    if hashed.startswith("$2b$"):
        hashed = "$2y$" + hashed[4:]
    return hashed


def _require_regular_user_auth() -> dict:
    decoded = decode_jwt(request.headers.get("Authorization") or request.args.get("token") or "")
    if bool(decoded.get("isGuest")):
        raise PermissionError("Guest users cannot access this resource")
    uid = decoded.get("id")
    try:
        uid_i = int(uid)
    except (TypeError, ValueError):
        uid_i = 0
    if uid_i <= 0:
        raise PermissionError("Invalid user session")
    role = str(decoded.get("role") or "").lower()
    if role in ("administrator", "admin", "system administrator"):
        return decoded
    source = str(decoded.get("auth_source") or "")
    if source == "clinical_providers" or role in (
        "ob-gyn",
        "obgyn",
        "physician",
        "provider",
        "specialist",
        "clinician",
        "radiologist",
        "ob-sonologist",
        "health expert",
        "other",
    ):
        # Providers may still call some shared endpoints; allow.
        return decoded
    return decoded


def _require_admin_auth() -> dict:
    decoded = decode_jwt(request.headers.get("Authorization") or "")
    role = str(decoded.get("role") or "").lower()
    if role not in ("administrator", "admin", "system administrator"):
        raise PermissionError("Administrator access required")
    _assert_token_still_valid(decoded)
    return decoded


def _derive_display_name(email: str, fallback: str = "Patient") -> str:
    local = (email or "").split("@", 1)[0].strip()
    cleaned = re.sub(r"[._+\-]+", " ", local)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) >= 2:
        return " ".join(p.capitalize() for p in cleaned.split())
    return fallback


def _pick_payload(payload: dict, keys: list[str]) -> Optional[str]:
    for key in keys:
        if key not in payload:
            continue
        val = payload.get(key)
        if val is None or val == "":
            continue
        return str(val).strip()
    return None


def _parse_clinical_date(raw: Optional[str]) -> Optional[date]:
    if not raw:
        return None
    raw = str(raw).strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _clinical_validity_evaluate(payload: dict) -> dict[str, Any]:
    """Port of api/clinical_validity.php evaluate() (cloud-safe subset)."""
    today = date.today()
    warnings: list[dict[str, Any]] = []
    notes: dict[str, Any] = {}
    lab_max, us_max, symptom_max = 90, 60, 180
    follicular_min, follicular_max = 2, 5

    lmp = _parse_clinical_date(_pick_payload(payload, ["last_menstrual_period_date", "lmp_date", "LMP_date"]))
    blood_draw = _parse_clinical_date(
        _pick_payload(payload, ["blood_draw_date", "lab_draw_date", "hormone_panel_date"])
    )
    ultrasound_date = _parse_clinical_date(
        _pick_payload(payload, ["ultrasound_date", "scan_date", "us_date"])
    )
    symptom_date = _parse_clinical_date(
        _pick_payload(payload, ["symptom_evaluation_date", "symptom_date", "clinical_symptom_date"])
    )

    cycle_raw = _pick_payload(payload, ["Cycle_length", "Cycle_length_days"])
    try:
        cycle_length = int(float(cycle_raw)) if cycle_raw else 28
    except (TypeError, ValueError):
        cycle_length = 28
    if cycle_length < 21:
        cycle_length = 28

    cycle_ri = str(
        _pick_payload(payload, ["Cycle_R_I", "CycleR_I", "cycle_regularity", "cycle_r_i"]) or ""
    ).lower()
    amenorrhea = cycle_ri in ("amenorrhea", "amenorrhoea", "no_period", "absent")

    def _days_between(a: Optional[date], b: Optional[date]) -> Optional[int]:
        if not a or not b:
            return None
        return (b - a).days

    if amenorrhea:
        notes["hormone_cycle"] = "amenorrhea_bypass"
    elif lmp and blood_draw:
        cycle_day = int(_days_between(lmp, blood_draw) or 0) + 1
        if cycle_day < follicular_min or cycle_day > follicular_max:
            warnings.append(
                {
                    "code": "follicular_window_mismatch",
                    "message": (
                        f"Blood draw appears to be on cycle day {cycle_day}; "
                        f"ideal baseline window is days {follicular_min}: {follicular_max}."
                    ),
                    "cycle_day": cycle_day,
                }
            )
    elif blood_draw and not lmp:
        warnings.append(
            {
                "code": "missing_lmp",
                "message": "Last menstrual period date is missing; cycle-day alignment could not be verified.",
            }
        )

    fasting = _pick_payload(payload, ["fasting_hours", "Fasting_hours", "fasting_hours_before_draw"])
    try:
        if fasting is not None and float(fasting) < 8:
            warnings.append(
                {
                    "code": "non_fasting_rbs",
                    "message": (
                        "Non-fasting baseline detected. System will flag this record to prevent "
                        "insulin-resistance data skewing in XAI models."
                    ),
                }
            )
    except (TypeError, ValueError):
        pass

    lab_keys = (
        "LH_level", "LH_mIU_mL", "FSH_level", "FSH_mIU_mL", "TSH_level", "TSH_mIU_L",
        "AMH_level", "AMH_ng_mL", "PRL_level", "PRL_ng_mL", "RBS", "RBS_mg_dl",
        "Progesterone_level", "PRG_ng_mL", "Vitamin_D3_level", "Vit_D3_ng_mL",
    )
    us_keys = (
        "Follicle_no_L", "Follicle_no_R", "Avg_F_size_L", "Avg_F_size_L_mm",
        "Avg_F_size_R", "Avg_F_size_R_mm",
    )
    symptom_keys = ("Weight_gain", "Hair_growth", "Skin_darkening", "Pimples")
    has_lab = any(payload.get(k) not in (None, "") for k in lab_keys)
    has_us = any(payload.get(k) not in (None, "") for k in us_keys)
    has_symptom = any(payload.get(k) not in (None, "") for k in symptom_keys)

    def _age_label(days: Optional[int], max_days: int) -> str:
        if days is None:
            return "Valid"
        if days > max_days:
            return f"Age is {days} days (Max: {max_days})"
        return "Valid"

    lab_age = _days_between(blood_draw, today) if blood_draw else None
    us_age = _days_between(ultrasound_date, today) if ultrasound_date else None
    symptom_age = _days_between(symptom_date, today) if symptom_date else None
    expired_fields = {"hormone_panel": "Valid", "ultrasound": "Valid", "symptom_markers": "Valid"}

    if has_lab:
        expired_fields["hormone_panel"] = _age_label(lab_age, lab_max)
        if lab_age is not None and lab_age > lab_max:
            warnings.append(
                {"code": "lab_expired", "message": f"Hormone/metabolic panel exceeds {lab_max}-day validity."}
            )
    if has_us:
        expired_fields["ultrasound"] = _age_label(us_age, us_max)
        if us_age is not None and us_age > us_max:
            warnings.append(
                {
                    "code": "ultrasound_expired",
                    "message": f"Ultrasound follicle metrics exceed {us_max}-day validity.",
                }
            )
    if has_symptom:
        expired_fields["symptom_markers"] = _age_label(symptom_age, symptom_max)
        if symptom_age is not None and symptom_age > symptom_max:
            warnings.append(
                {
                    "code": "symptom_expired",
                    "message": f"Hyperandrogenism symptom markers exceed {symptom_max}-day validity.",
                }
            )

    reference_dates = {
        "blood_draw_date": blood_draw.isoformat() if blood_draw else None,
        "ultrasound_date": ultrasound_date.isoformat() if ultrasound_date else None,
        "symptom_evaluation_date": symptom_date.isoformat() if symptom_date else None,
        "lab_age_days": lab_age,
        "ultrasound_age_days": us_age,
        "symptom_age_days": symptom_age,
        "lab_max_days": lab_max,
        "ultrasound_max_days": us_max,
    }

    scope = str(_pick_payload(payload, ["inference_scope", "validity_scope"]) or "").lower()
    clinical_only = scope in ("clinical", "clinical_only", "xgboost")

    modality = (_pick_payload(payload, ["ultrasound_modality", "Ultrasound_modality", "us_modality"]) or "TVUS")
    modality_norm = "TVUS"
    ml = modality.lower()
    if "transabdominal" in ml or "pelvic" in ml:
        modality_norm = "Transabdominal"
    elif ml not in ("tvus", "transvaginal", ""):
        modality_norm = "Other"
    notes["ultrasound_modality"] = modality_norm
    if modality_norm == "Transabdominal":
        warnings.append(
            {
                "code": "transabdominal_modality",
                "message": (
                    "Transabdominal/Pelvic scan selected: CNN will proceed with diminished "
                    "follicle boundary resolution vs TVUS baseline."
                ),
            }
        )
    elif modality_norm == "Other":
        warnings.append(
            {
                "code": "alternate_modality",
                "message": "Alternate pelvic imaging modality selected: feature extraction confidence may vary.",
            }
        )

    hormone_blocked = expired_fields["hormone_panel"] != "Valid" and has_lab
    ultrasound_blocked = expired_fields["ultrasound"] != "Valid" and has_us and not clinical_only
    data_stale = hormone_blocked or ultrasound_blocked
    inference_blocked = False
    action_required = None
    if ultrasound_blocked:
        action_required = "Consider updating or re-ordering the pelvic ultrasound scan for the most reliable imaging result."
    elif hormone_blocked:
        action_required = (
            "Consider updating or re-ordering baseline hormone and metabolic labs for the most reliable clinical result."
        )

    stale = None
    if data_stale:
        stale = {
            "status": "stale_clinical_data",
            "error": "Some clinical inputs are past their recommended validity window.",
            "expired_fields": expired_fields,
            "reference_dates": reference_dates,
            "action_required": action_required,
            "warnings": warnings,
            "ultrasound_imaging": None,
        }

    return {
        "valid": True,
        "warnings": warnings,
        "notes": notes,
        "expired_fields": expired_fields,
        "reference_dates": reference_dates,
        "inference_blocked": inference_blocked,
        "stale_response": stale,
        "ultrasound_imaging": None,
        "ultrasound_modality": modality_norm,
    }


def _minimal_pdf_bytes(title: str, lines: list[str]) -> bytes:
    """Tiny single-page PDF without external deps (Report export fallback)."""
    # Process string replacements BEFORE inserting into f-string
    clean_title = title.replace('(', '\\(').replace(')', '\\)')
    content_lines = [f"BT /F1 12 Tf 50 750 Td ({clean_title}) Tj"]
    y = 720
    for line in lines[:40]:
        safe = re.sub(r"[^\x20-\x7E]", "?", str(line))[:90].replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        content_lines.append(f"0 -16 Td ({safe}) Tj")
        y -= 16
    content_lines.append("ET")
    stream = "\n".join(content_lines).encode("latin-1", errors="replace")
    objs = []
    objs.append(b"1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n")
    objs.append(b"2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n")
    objs.append(
        b"3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n"
    )
    objs.append(f"4 0 obj<< /Length {len(stream)} >>stream\n".encode() + stream + b"\nendstream\nendobj\n")
    objs.append(b"5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n")
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objs:
        offsets.append(len(out))
        out.extend(obj)
    xref = len(out)
    out.extend(f"xref\n0 {len(offsets)}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode())
    out.extend(
        f"trailer<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(out)


@bp.post("/api/register")
@bp.post("/api/register.php")
def api_register():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Invalid JSON format", 400)

    portal = str(payload.get("registration_portal") or "patient").strip().lower()
    if portal in ("community", "user"):
        portal = "patient"
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "").strip()
    name = str(payload.get("user_name") or "").strip()
    institution = str(payload.get("institution") or "").strip()

    if not email or not password:
        return _json_error("Email and password are required", 400)
    if "@" not in email or "." not in email.split("@")[-1]:
        return _json_error("Invalid email format", 400)
    if portal == "provider":
        # Self-serve OB-GYN registration (email/password): mirrors Google allowRegister
        if not _password_is_sha256_digest(password) and len(password) < 8:
            return _json_error("Password must be at least 8 characters", 400)
        try:
            hashed = _hash_password_for_storage(password)
        except Exception as exc:  # noqa: BLE001
            return _json_error("Failed to secure password", 500, detail=str(exc))
        if len(name) < 2:
            name = _derive_display_name(email, "Provider")
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1 FROM users WHERE email = %s LIMIT 1", (email,))
                    if cur.fetchone():
                        return _json_error("Email already registered", 409)
                    cur.execute(
                        "SELECT 1 FROM clinical_providers WHERE email = %s LIMIT 1",
                        (email,),
                    )
                    if cur.fetchone():
                        return _json_error("Email already registered", 409)
                    cur.execute(
                        """
                        INSERT INTO clinical_providers
                          (email, password, user_name, role, institution, avatar, is_active)
                        VALUES (%s, %s, %s, %s, %s, %s, 1)
                        """,
                        (email, hashed, name, "Ob-Gyn", institution, None),
                    )
                    new_id = int(cur.lastrowid)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Provider registration failed")
            return _json_error("Registration failed", 500, detail=str(exc))

        token = generate_jwt(
            {
                "id": new_id,
                "email": email,
                "user_name": name,
                "name": name,
                "role": "Ob-Gyn",
                "auth_source": "clinical_providers",
            }
        )
        return (
            jsonify(
                {
                    "success": True,
                    "message": "Provider account created. You can sign in now.",
                    "portal": "provider",
                    "token": token,
                    "expiresIn": JWT_EXPIRY,
                    "user": {
                        "id": new_id,
                        "name": name,
                        "email": email,
                        "role": "Ob-Gyn",
                        "institution": institution,
                        "avatar": _default_avatar(name),
                    },
                }
            ),
            201,
        )
    if len(name) < 2:
        name = _derive_display_name(email, "Patient")
    if not _password_is_sha256_digest(password) and len(password) < 8:
        return _json_error("Password must be at least 8 characters", 400)
    if not _password_is_sha256_digest(password):
        if not (
            re.search(r"[A-Z]", password)
            and re.search(r"[a-z]", password)
            and re.search(r"[0-9]", password)
            and re.search(r'[!@#$%^&*(),.?":{}|<>]', password)
        ):
            return _json_error(
                "Password must contain uppercase, lowercase, number, and special character",
                400,
            )

    try:
        hashed = _hash_password_for_storage(password)
    except Exception as exc:  # noqa: BLE001
        return _json_error("Failed to secure password", 500, detail=str(exc))

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM users WHERE email = %s LIMIT 1", (email,))
                if cur.fetchone():
                    return _json_error("Email already registered", 409)
                cur.execute(
                    "SELECT 1 FROM clinical_providers WHERE email = %s LIMIT 1",
                    (email,),
                )
                if cur.fetchone():
                    return _json_error("Email already registered", 409)
                role = "Regular User"
                cur.execute(
                    """
                    INSERT INTO users (user_name, email, password, role, institution)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (name, email, hashed, role, institution),
                )
                new_id = int(cur.lastrowid)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Registration failed")
        return _json_error("Registration failed", 500, detail=str(exc))

    token = generate_jwt(
        {"id": new_id, "email": email, "user_name": name, "name": name, "role": role, "auth_source": "users"}
    )
    return (
        jsonify(
            {
                "success": True,
                "message": "Patient account created. You can sign in now.",
                "portal": "patient",
                "token": token,
                "expiresIn": JWT_EXPIRY,
                "user": {
                    "id": new_id,
                    "name": name,
                    "email": email,
                    "role": role,
                    "institution": institution,
                    "avatar": _default_avatar(name),
                },
            }
        ),
        201,
    )


@bp.post("/api/guest-login")
@bp.post("/api/guest_login")
@bp.post("/api/guest_login.php")
def api_guest_login():
    guest_id = f"guest_{uuid.uuid4().hex[:12]}"
    name = "Guest User"
    email = "guest@pcode.local"
    token = generate_jwt(
        {
            "id": guest_id,
            "email": email,
            "name": name,
            "role": "Guest",
            "isGuest": True,
            "auth_source": "guest",
        }
    )
    return jsonify(
        {
            "success": True,
            "message": "Guest login successful",
            "token": token,
            "expiresIn": JWT_EXPIRY,
            "user": {
                "id": guest_id,
                "name": name,
                "email": email,
                "role": "Guest",
                "isGuest": True,
                "avatar": "https://ui-avatars.com/api/?name=Guest+User&background=9CA3AF&color=fff",
            },
        }
    ), 200


@bp.post("/api/verify")
@bp.post("/api/verify.php")
def api_verify():
    try:
        decoded = decode_jwt(request.headers.get("Authorization") or "")
    except ValueError as exc:
        return _json_error(str(exc), 401)

    if bool(decoded.get("isGuest")):
        return jsonify(
            {
                "success": True,
                "message": "Token is valid",
                "user": {
                    "id": decoded.get("id"),
                    "name": decoded.get("name") or "Guest User",
                    "email": decoded.get("email") or "guest@pcode.local",
                    "role": "Guest",
                    "isGuest": True,
                    "avatar": "https://ui-avatars.com/api/?name=Guest+User&background=9CA3AF&color=fff",
                },
            }
        ), 200

    uid = int(decoded.get("id") or 0)
    if uid <= 0:
        return _json_error("Invalid token", 401)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT user_id, user_name, email, role, institution, avatar
                    FROM users WHERE user_id = %s LIMIT 1
                    """,
                    (uid,),
                )
                user = cur.fetchone()
                if not user:
                    cur.execute(
                        """
                        SELECT id AS user_id, user_name, email, role, institution, avatar
                        FROM clinical_providers WHERE id = %s LIMIT 1
                        """,
                        (uid,),
                    )
                    user = cur.fetchone()
                if not user:
                    return _json_error("User not found", 404)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Verify failed")
        return _json_error("Database error", 500, detail=str(exc))

    name = str(user.get("user_name") or "")
    return jsonify(
        {
            "success": True,
            "message": "Token is valid",
            "user": {
                "id": int(user["user_id"]),
                "name": name,
                "email": user.get("email"),
                "role": user.get("role"),
                "institution": user.get("institution") or "",
                "avatar": user.get("avatar") or _default_avatar(name),
            },
        }
    ), 200


@bp.post("/api/update-profile")
@bp.post("/api/update_profile")
@bp.post("/api/update_profile.php")
def api_update_profile():
    try:
        decoded = decode_jwt(request.headers.get("Authorization") or "")
    except ValueError as exc:
        return _json_error(str(exc), 401)
    if bool(decoded.get("isGuest")):
        return _json_error("Guests cannot update profiles", 403)

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("user_name") or payload.get("name") or "").strip()
    institution = payload.get("institution")
    avatar = payload.get("avatar")
    password = str(payload.get("password") or "").strip()
    uid = int(decoded.get("id") or 0)
    source = str(decoded.get("auth_source") or "")
    role = str(decoded.get("role") or "").lower()
    is_provider = source == "clinical_providers" or role in (
        "ob-gyn", "obgyn", "physician", "provider", "specialist", "clinician",
    )
    if uid <= 0:
        return _json_error("Invalid session", 401)
    if name and len(name) < 2:
        return _json_error("Name must be at least 2 characters", 400)
    if password and not _password_is_sha256_digest(password) and len(password) < 8:
        return _json_error("Password must be at least 8 characters", 400)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                table = "clinical_providers" if is_provider else "users"
                id_col = "id" if is_provider else "user_id"
                auth_source = "clinical_providers" if is_provider else "users"
                sets = []
                vals: list[Any] = []
                if name:
                    sets.append("user_name = %s")
                    vals.append(name)
                if institution is not None:
                    sets.append("institution = %s")
                    vals.append(str(institution))
                if avatar is not None:
                    sets.append("avatar = %s")
                    vals.append(str(avatar))
                if password:
                    sets.append("password = %s")
                    vals.append(_hash_password_for_storage(password))
                if not sets:
                    return _json_error("No profile fields to update", 400)
                vals.append(uid)
                cur.execute(
                    f"UPDATE {table} SET {', '.join(sets)} WHERE {id_col} = %s",
                    tuple(vals),
                )
                if is_provider:
                    cur.execute(
                        "SELECT id, user_name, email, role, institution, avatar "
                        f"FROM {table} WHERE {id_col} = %s LIMIT 1",
                        (uid,),
                    )
                else:
                    cur.execute(
                        "SELECT user_id, user_name, email, role, institution, avatar "
                        f"FROM {table} WHERE {id_col} = %s LIMIT 1",
                        (uid,),
                    )
                row = cur.fetchone() or {}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Update profile failed")
        return _json_error("Failed to update profile", 500, detail=str(exc))

    display_name = str(row.get("user_name") or name or "").strip()
    avatar_url = str(row.get("avatar") or "").strip() or _default_avatar(display_name)
    user_payload = {
        "id": int(row.get("id") or row.get("user_id") or uid),
        "name": display_name,
        "email": str(row.get("email") or decoded.get("email") or ""),
        "role": str(row.get("role") or decoded.get("role") or ""),
        "institution": str(row.get("institution") or ""),
        "avatar": avatar_url,
        "picture": avatar_url,
        "auth_source": auth_source,
    }
    return _json_ok(message="Profile updated", user=user_payload)


@bp.post("/api/validate_clinical_timing")
@bp.post("/api/validate_clinical_timing.php")
def api_validate_clinical_timing():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    evaluation = _clinical_validity_evaluate(payload)
    return jsonify(
        {
            "success": True,
            "clinical_validity": evaluation,
            "inference_allowed": True,
        }
    ), 200


@bp.get("/api/get_user_diagnosis")
@bp.get("/api/get_user_diagnosis.php")
def api_get_user_diagnosis():
    try:
        decoded = _require_regular_user_auth()
    except (PermissionError, ValueError) as exc:
        return _json_error(str(exc), 401)
    user_id = int(decoded.get("id") or 0)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                try:
                    _ensure_user_diagnosis_schema(cur)
                    cur.execute(
                        """
                        SELECT p.*,
                               r.diagnosis_id,
                               r.XGBoost_diagnosis,
                               r.XGBoost_diagnosis_probability_percentage,
                               r.CNN_diagnosis,
                               r.CNN_diagnosis_probability_percentage,
                               r.Overall_diagnosis,
                               r.Overall_diagnosis_probability_percentage,
                               r.clinical_inputs_snapshot,
                               r.screening_id,
                               r.created_at AS screening_created_at
                        FROM user_diagnosis_parameters p
                        LEFT JOIN user_diagnosis_results r
                          ON r.user_id = p.user_id
                         AND r.diagnosis_id = (
                              SELECT r2.diagnosis_id FROM user_diagnosis_results r2
                              WHERE r2.user_id = p.user_id
                              ORDER BY r2.created_at DESC, r2.diagnosis_id DESC
                              LIMIT 1
                         )
                        WHERE p.user_id = %s
                        LIMIT 1
                        """,
                        (user_id,),
                    )
                    row = cur.fetchone()
                except Exception:  # noqa: BLE001
                    return jsonify(
                        {"success": True, "data": None, "message": "User tables not initialized"}
                    ), 200
    except Exception as exc:  # noqa: BLE001
        logger.exception("Get user diagnosis failed")
        return _db_failure_response(exc, "Failed to load user diagnosis")

    if not row:
        return jsonify({"success": True, "data": None, "message": "No saved diagnosis"}), 200
    data = {k: _serialize_value(v) for k, v in dict(row).items()}
    if data.get("Ultrasound_image"):
        data["Ultrasound_image"] = _format_ultrasound(row.get("Ultrasound_image"))
    # Prefer structured clinical snapshot for XAI when present
    snap = data.get("clinical_inputs_snapshot")
    if isinstance(snap, str) and snap.strip():
        try:
            import json as _json

            parsed = _json.loads(snap)
            if isinstance(parsed, dict):
                data["clinical_inputs"] = parsed
        except Exception:  # noqa: BLE001
            pass
    elif isinstance(snap, dict):
        data["clinical_inputs"] = snap
    return jsonify({"success": True, "data": data, "message": "OK"}), 200


@bp.post("/api/save_user_diagnosis")
@bp.post("/api/save_user_diagnosis.php")
def api_save_user_diagnosis():
    import json as _json
    import uuid as _uuid

    try:
        decoded = _require_regular_user_auth()
    except (PermissionError, ValueError) as exc:
        return _json_error(str(exc), 401)
    user_id = int(decoded.get("id") or 0)
    if user_id <= 0:
        return _json_error("Invalid user session", 401)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("No valid JSON data provided", 400)

    clinical = payload.get("clinical_inputs") or {}
    if not isinstance(clinical, dict):
        clinical = {}
    alias_map = {
        "age": "Age_yrs", "Pulse_rate": "Pulse_rate_bpm", "RR_breath": "RR_breath_min",
        "BP_systolic": "BP_Systolic_mmHg", "BP_diastolic": "BP_Diastolic_mmHg",
        "Hemoglobin": "Hb_g_dl", "Cycle_R_I": "CycleR_I", "Cycle_length": "Cycle_length_days",
        "Marriage_duration": "Marriage_Status_years", "Pregnant_status": "Pregnant",
        "No_abortions": "No_of_abortions", "I_Beta_HCG": "I_beta_HCG_mIU_mL",
        "II_Beta_HCG": "II_beta_HCG_mIU_mL", "LH_level": "LH_mIU_mL", "FSH_level": "FSH_mIU_mL",
        "AMH_level": "AMH_ng_mL", "PRL_level": "PRL_ng_mL", "TSH_level": "TSH_mIU_L",
        "Vitamin_D3_level": "Vit_D3_ng_mL", "Progesterone_level": "PRG_ng_mL", "RBS": "RBS_mg_dl",
        "Avg_F_size_L": "Avg_F_size_L_mm", "Avg_F_size_R": "Avg_F_size_R_mm",
    }
    params: dict[str, Any] = {}
    for k, v in clinical.items():
        col = alias_map.get(k, k)
        params[col] = _coerce_user_param_value(col, v)

    if payload.get("clear_ultrasound_image") is True:
        params["Ultrasound_image"] = None
    elif isinstance(payload.get("ultrasound_image"), str) and payload.get("ultrasound_image").strip():
        params["Ultrasound_image"] = _coerce_ultrasound_blob(payload["ultrasound_image"])

    allowed = (
        "Age_yrs", "Weight_kg", "Height_cm", "BMI", "Blood_Group", "Pulse_rate_bpm", "RR_breath_min",
        "BP_Systolic_mmHg", "BP_Diastolic_mmHg", "Hb_g_dl", "CycleR_I", "Cycle_length_days",
        "Marriage_Status_years", "Pregnant", "No_of_abortions", "I_beta_HCG_mIU_mL", "II_beta_HCG_mIU_mL",
        "FSH_mIU_mL", "LH_mIU_mL", "FSH_LH", "Hip_inch", "Waist_inch", "Waist_hip_ratio", "TSH_mIU_L",
        "AMH_ng_mL", "PRL_ng_mL", "Vit_D3_ng_mL", "PRG_ng_mL", "RBS_mg_dl", "Weight_gain", "Hair_growth",
        "Skin_darkening", "Hair_loss", "Pimples", "Fast_food", "Reg_Exercise", "Follicle_no_L",
        "Follicle_no_R", "Avg_F_size_L_mm", "Avg_F_size_R_mm", "Endometrium_mm", "Ultrasound_image",
        "last_menstrual_period_date", "blood_draw_date", "ultrasound_date", "symptom_evaluation_date",
        "fasting_hours", "ultrasound_modality",
    )
    res = payload.get("results") if isinstance(payload.get("results"), dict) else {}
    screening_id = str(_uuid.uuid4())

    def _as_int(value: Any) -> Optional[int]:
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    xg_d = _as_int(res.get("xgboost_diagnosis"))
    cnn_d = _as_int(res.get("cnn_diagnosis"))
    ov_d = _as_int(res.get("overall_diagnosis"))
    xg_p = _norm_prob_percent(res.get("xgboost_probability"))
    cnn_p = _norm_prob_percent(res.get("cnn_probability"))
    ov_p = _norm_prob_percent(res.get("overall_probability"))
    # Persist only meaningful clinical fields so History can show recorded inputs / diffs.
    # Keep numeric zeros and Yes/No flags; drop blank/null noise.
    snap_obj = {
        k: v
        for k, v in clinical.items()
        if v is not None and v != "" and str(k) not in ("Ultrasound_image", "ultrasound_image")
    }
    snap = _json.dumps(snap_obj, default=str)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_user_diagnosis_schema(cur)
                param_cols_existing = _table_columns(cur, "user_diagnosis_parameters")
                cols = [c for c in allowed if c in params and (not param_cols_existing or c in param_cols_existing)]

                if cols:
                    placeholders = ", ".join(["%s"] * (len(cols) + 1))
                    col_sql = ", ".join(["user_id"] + cols)
                    updates = ", ".join([f"`{c}`=VALUES(`{c}`)" for c in cols])
                    cur.execute(
                        f"INSERT INTO user_diagnosis_parameters ({col_sql}) VALUES ({placeholders}) "
                        f"ON DUPLICATE KEY UPDATE {updates}",
                        tuple([user_id] + [params[c] for c in cols]),
                    )
                else:
                    cur.execute(
                        "INSERT IGNORE INTO user_diagnosis_parameters (user_id) VALUES (%s)",
                        (user_id,),
                    )

                result_cols_existing = _table_columns(cur, "user_diagnosis_results")
                # Build insert dynamically so missing screening_id / snapshot columns don't 500
                insert_cols = ["user_id"]
                insert_vals: list[Any] = [user_id]
                if not result_cols_existing or "screening_id" in result_cols_existing:
                    insert_cols.append("screening_id")
                    insert_vals.append(screening_id)
                insert_cols.extend(
                    [
                        "XGBoost_diagnosis",
                        "XGBoost_diagnosis_probability_percentage",
                        "CNN_diagnosis",
                        "CNN_diagnosis_probability_percentage",
                        "Overall_diagnosis",
                        "Overall_diagnosis_probability_percentage",
                    ]
                )
                insert_vals.extend([xg_d, xg_p, cnn_d, cnn_p, ov_d, ov_p])
                if not result_cols_existing or "created_by" in result_cols_existing:
                    insert_cols.append("created_by")
                    insert_vals.append("Patient")
                if not result_cols_existing or "clinical_inputs_snapshot" in result_cols_existing:
                    insert_cols.append("clinical_inputs_snapshot")
                    insert_vals.append(snap)

                col_sql = ", ".join(f"`{c}`" for c in insert_cols)
                ph = ", ".join(["%s"] * len(insert_vals))
                try:
                    cur.execute(
                        f"INSERT INTO user_diagnosis_results ({col_sql}) VALUES ({ph})",
                        tuple(insert_vals),
                    )
                    diagnosis_id = int(cur.lastrowid)
                except Exception as insert_exc:  # noqa: BLE001
                    # Fallback: unique(user_id) still present: update latest row
                    logger.warning("Append user diagnosis failed (%s); upserting latest row", insert_exc)
                    cur.execute(
                        """
                        UPDATE user_diagnosis_results
                        SET XGBoost_diagnosis=%s,
                            XGBoost_diagnosis_probability_percentage=%s,
                            CNN_diagnosis=%s,
                            CNN_diagnosis_probability_percentage=%s,
                            Overall_diagnosis=%s,
                            Overall_diagnosis_probability_percentage=%s,
                            clinical_inputs_snapshot=%s
                        WHERE diagnosis_id = (
                            SELECT diagnosis_id FROM (
                                SELECT diagnosis_id FROM user_diagnosis_results
                                WHERE user_id=%s
                                ORDER BY created_at DESC, diagnosis_id DESC
                                LIMIT 1
                            ) latest
                        )
                        """,
                        (xg_d, xg_p, cnn_d, cnn_p, ov_d, ov_p, snap, user_id),
                    )
                    if cur.rowcount == 0:
                        raise insert_exc
                    cur.execute(
                        """
                        SELECT diagnosis_id, screening_id FROM user_diagnosis_results
                        WHERE user_id=%s
                        ORDER BY created_at DESC, diagnosis_id DESC
                        LIMIT 1
                        """,
                        (user_id,),
                    )
                    row = cur.fetchone() or {}
                    diagnosis_id = int(row.get("diagnosis_id") or 0)
                    if row.get("screening_id"):
                        screening_id = str(row.get("screening_id"))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Save user diagnosis failed")
        return _json_error("Failed to save user diagnosis", 500, detail=str(exc))

    return jsonify(
        {
            "success": True,
            "message": "User diagnosis saved",
            "diagnosis_id": diagnosis_id,
            "screening_id": screening_id,
        }
    ), 200


@bp.get("/api/get_users")
@bp.get("/api/get_users.php")
def api_get_users():
    try:
        _require_admin_auth()
    except (PermissionError, ValueError) as exc:
        return _json_error(str(exc), 401)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_admin_account_schema(cur)
                users = []
                user_cols = _table_columns(cur, "users")
                select_bits = [
                    "user_id",
                    "user_name",
                    "email",
                    "role",
                    "institution",
                    "password",
                ]
                if "is_active" in user_cols:
                    select_bits.append("is_active")
                else:
                    select_bits.append("1 AS is_active")
                if "last_login" in user_cols:
                    select_bits.append("last_login")
                else:
                    select_bits.append("NULL AS last_login")
                if "created_at" in user_cols:
                    select_bits.append("created_at")
                else:
                    select_bits.append("NULL AS created_at")
                if "updated_at" in user_cols:
                    select_bits.append("updated_at")
                else:
                    select_bits.append("NULL AS updated_at")

                GOOGLE_MARKER = "$google$no-local-password"
                cur.execute(
                    f"""
                    SELECT {", ".join(select_bits)}
                    FROM users
                    WHERE role NOT IN ('Administrator', 'System Administrator', 'admin')
                    ORDER BY user_id DESC
                    """
                )
                for row in cur.fetchall() or []:
                    r = dict(row)
                    stored = str(r.pop("password", "") or "")
                    item = {k: _serialize_value(v) for k, v in r.items()}
                    item["auth_source"] = "users"
                    item["is_active"] = 1 if int(item.get("is_active") or 0) == 1 else 0
                    item["auth_type"] = "google" if stored.startswith(GOOGLE_MARKER) else "password"
                    item["pending_approval"] = 0
                    users.append(item)

                # OB-GYN specialists register into clinical_providers, not users
                try:
                    prov_cols = _table_columns(cur, "clinical_providers")
                    p_bits = [
                        "id",
                        "user_name",
                        "email",
                        "role",
                        "institution",
                        "is_active",
                        "password",
                    ]
                    if "last_login" in prov_cols:
                        p_bits.append("last_login")
                    else:
                        p_bits.append("NULL AS last_login")
                    if "created_at" in prov_cols:
                        p_bits.append("created_at")
                    else:
                        p_bits.append("NULL AS created_at")
                    cur.execute(
                        f"""
                        SELECT {", ".join(p_bits)}
                        FROM clinical_providers
                        ORDER BY id DESC
                        """
                    )
                    for row in cur.fetchall() or []:
                        r = dict(row)
                        stored = str(r.pop("password", "") or "")
                        active = 1 if int(r.get("is_active") or 0) == 1 else 0
                        users.append(
                            {
                                "user_id": int(r.get("id") or 0),
                                "user_name": r.get("user_name") or "",
                                "email": r.get("email") or "",
                                "role": r.get("role") or "Ob-Gyn",
                                "institution": r.get("institution") or "",
                                "is_active": active,
                                "last_login": _serialize_value(r.get("last_login")),
                                "created_at": _serialize_value(r.get("created_at")),
                                "updated_at": None,
                                "auth_source": "clinical_providers",
                                "auth_type": "google" if stored.startswith(GOOGLE_MARKER) else "password",
                                "pending_approval": 0 if active else 1,
                            }
                        )
                except Exception as prov_exc:  # noqa: BLE001
                    logger.warning("clinical_providers listing skipped: %s", prov_exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Get users failed")
        return _json_error("Error retrieving users", 500, detail=str(exc))
    return jsonify(
        {
            "success": True,
            "message": "Users retrieved successfully",
            "users": users,
            "total": len(users),
        }
    ), 200


@bp.post("/api/save_user")
@bp.post("/api/save_user.php")
def api_save_user():
    try:
        _require_admin_auth()
    except (PermissionError, ValueError) as exc:
        return _json_error(str(exc), 401)
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    role = str(payload.get("role") or "").strip()
    institution = str(payload.get("institution") or "").strip()
    password = str(payload.get("password") or "").strip() or None
    allowed_roles = {
        "Radiologist", "Ob-Gyn", "OB-Sonologist", "Other", "Health Expert", "Physician", "Regular User",
    }
    if not name or not email or not role:
        return _json_error("Name, email, and role are required", 400)
    if role not in allowed_roles:
        return _json_error("Role is not allowed", 400)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT user_id FROM users WHERE email = %s LIMIT 1", (email,))
                if cur.fetchone():
                    return _json_error("Email already exists in the system", 409)
                hashed = _hash_password_for_storage(password or os.urandom(8).hex())
                cur.execute(
                    """
                    INSERT INTO users (user_name, email, password, role, institution)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (name, email, hashed, role, institution),
                )
                new_id = int(cur.lastrowid)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Save user failed")
        return _json_error("Failed to save user", 500, detail=str(exc))
    return jsonify({"success": True, "message": "User created", "user_id": new_id}), 201


@bp.post("/api/delete_user")
@bp.post("/api/delete_user.php")
def api_delete_user():
    try:
        admin = _require_admin_auth()
    except (PermissionError, ValueError) as exc:
        return _json_error(str(exc), 401)
    payload = request.get_json(silent=True) or {}
    try:
        user_id = int(payload.get("user_id") or 0)
    except (TypeError, ValueError):
        user_id = 0
    if user_id <= 0:
        return _json_error("User ID is required", 400)
    auth_source = str(payload.get("auth_source") or "users").strip().lower()
    if auth_source not in ("users", "clinical_providers"):
        auth_source = "users"
    if auth_source == "users" and user_id == int(admin.get("id") or 0):
        return _json_error("Cannot delete your own account", 400)
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_admin_account_schema(cur)
                if auth_source == "clinical_providers":
                    cur.execute(
                        "SELECT id, email, role FROM clinical_providers WHERE id = %s LIMIT 1",
                        (user_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return _json_error("Provider not found", 404)
                    email = str(row.get("email") or "")
                    cur.execute("DELETE FROM clinical_providers WHERE id = %s LIMIT 1", (user_id,))
                    _admin_audit(
                        cur,
                        admin,
                        action="delete_user",
                        target_type="clinical_providers",
                        target_id=user_id,
                        target_email=email,
                        detail={"role": row.get("role")},
                    )
                    conn.commit()
                    return jsonify({"success": True, "message": "Provider deleted"}), 200

                cur.execute(
                    "SELECT role, email, is_active FROM users WHERE user_id = %s LIMIT 1",
                    (user_id,),
                )
                row = cur.fetchone()
                if not row:
                    return _json_error("User not found", 404)
                role = str(row.get("role") or "").lower()
                if role in ("administrator", "admin", "system administrator"):
                    cur.execute(
                        """
                        SELECT COUNT(*) AS c FROM users
                        WHERE LOWER(role) IN ('administrator', 'admin', 'system administrator')
                          AND COALESCE(is_active, 1) = 1
                        """
                    )
                    active_admins = int((cur.fetchone() or {}).get("c") or 0)
                    if active_admins <= 1:
                        return _json_error(
                            "Cannot delete the last System Administrator",
                            403,
                            code="LAST_ADMIN",
                        )
                    return _json_error("Cannot delete administrator accounts from User Management", 403)
                email = str(row.get("email") or "")
                cur.execute("DELETE FROM users WHERE user_id = %s LIMIT 1", (user_id,))
                _admin_audit(
                    cur,
                    admin,
                    action="delete_user",
                    target_type="users",
                    target_id=user_id,
                    target_email=email,
                    detail={"role": row.get("role")},
                )
                conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.exception("Delete user failed")
        return _json_error("Failed to delete user", 500, detail=str(exc))
    return jsonify({"success": True, "message": "User deleted"}), 200


def _pdf_value_empty(value: Any) -> bool:
    """True when a DB/payload value should not overwrite a PDF field."""
    if value is None:
        return True
    if isinstance(value, (dict, list)):
        return True
    if isinstance(value, str) and value.strip() in (
        "",
        ":",
        "-",
        "—",
        "N/A",
        "null",
        "None",
        "0000-00-00",
        "0000-00-00 00:00:00",
    ):
        return True
    if isinstance(value, (bytes, bytearray, memoryview)) and len(bytes(value)) == 0:
        return True
    return False


def _pdf_parse_snapshot(raw: Any) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    if isinstance(raw, dict):
        parsed = raw
    elif isinstance(raw, (bytes, bytearray, memoryview)):
        try:
            raw = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            return {}
        return _pdf_parse_snapshot(raw)
    elif isinstance(raw, str) and raw.strip():
        try:
            import json as _json

            loaded = _json.loads(raw)
            parsed = loaded if isinstance(loaded, dict) else {}
        except Exception:  # noqa: BLE001
            return {}
    return _flatten_clinical_map(parsed)


_CLINICAL_NESTED_KEYS = (
    "clinical_data",
    "clinical_inputs",
    "clinical_form_data",
    "clinical",
    "parameters",
    "form",
    "data",
)


def _flatten_clinical_map(row: Any) -> dict[str, Any]:
    """Unwrap nested clinical blobs so LH_level etc. are visible to _pick."""
    if not isinstance(row, dict):
        return {}
    out: dict[str, Any] = {}
    nested: list[dict[str, Any]] = []
    for key, value in row.items():
        if str(key) in _CLINICAL_NESTED_KEYS and isinstance(value, dict):
            nested.append(value)
            continue
        out[key] = value
    for blob in nested:
        for key, value in _flatten_clinical_map(blob).items():
            if key not in out or _pdf_value_empty(out.get(key)):
                out[key] = value
            elif not _pdf_value_empty(value):
                out[key] = value
    return out


def _apply_parameter_row_to_pdf(
    patient: dict[str, Any],
    row: Any,
    *,
    only_if_empty: bool = False,
) -> None:
    """Copy non-empty clinical columns onto the PDF patient dict.

    Form aliases (Pulse_rate, LH_level, …) are written to canonical DB names.
    Later rows win unless only_if_empty is set (used for frontend fallbacks).
    """
    if not row:
        return
    row = _flatten_clinical_map(dict(row))
    skip = {
        "parameter_id",
        "patient_id",
        "screening_id",
        "created_at",
        "created_by",
        "user_id",
        "clinical_inputs_snapshot",
        "diagnosis_id",
        "shap_explanation",
        "top_contributions",
        "missing_values",
        "description",
        "classification",
        "probability",
        "first_name",
        "middle_name",
        "surname",
        "patient_name",
        "name",
        "address",
        "address_street",
        "address_barangay",
        "address_town",
        "address_municipality",
        "address_city",
        "contact_no",
        "civil_status",
        "occupation",
        "religion",
        "reffered_by",
        "referred_by",
        "date_of_birth",
        "DOB",
    }
    for k, v in dict(row).items():
        if k in skip or _pdf_value_empty(v):
            continue
        dest = _DIAGNOSIS_ALIASES.get(k, k)
        if k in ("Ultrasound_image", "ultrasound_image") or dest == "Ultrasound_image":
            formatted = _format_ultrasound(v)
            if not formatted:
                continue
            if only_if_empty and not _pdf_value_empty(patient.get("Ultrasound_image")):
                continue
            patient["Ultrasound_image"] = formatted
            patient["ultrasound_image"] = formatted
            continue
        if only_if_empty and not _pdf_value_empty(patient.get(dest)):
            continue
        val = _serialize_value(v)
        patient[dest] = val
        if dest != k:
            patient[k] = val


def _apply_pdf_aliases(patient: dict[str, Any]) -> None:
    for alias, dest in _DIAGNOSIS_ALIASES.items():
        if _pdf_value_empty(patient.get(dest)) and not _pdf_value_empty(patient.get(alias)):
            patient[dest] = patient[alias]
    if _pdf_value_empty(patient.get("reffered_by")) and not _pdf_value_empty(patient.get("referred_by")):
        patient["reffered_by"] = patient["referred_by"]
    if _pdf_value_empty(patient.get("referred_by")) and not _pdf_value_empty(patient.get("reffered_by")):
        patient["referred_by"] = patient["reffered_by"]


def _apply_pdf_computed_fields(patient: dict[str, Any]) -> None:
    """Fill display-only fields from canonical DB values (LH/FSH, date aliases)."""

    def _num(*keys: str) -> Optional[float]:
        for key in keys:
            val = patient.get(key)
            if _pdf_value_empty(val):
                continue
            try:
                return float(val)
            except (TypeError, ValueError):
                continue
        return None

    lh = _num("LH_mIU_mL", "LH_level")
    fsh = _num("FSH_mIU_mL", "FSH_level")
    if lh is not None and fsh not in (None, 0.0):
        ratio = round(lh / fsh, 2)
        patient["LH_FSH_Ratio"] = ratio
        patient["FSH_LH"] = ratio


def _coalesce_parameter_rows(cur, patient_id: int, dest: dict[str, Any]) -> None:
    """Merge all diagnosis-parameter rows: oldest ledger → newest, chart last."""
    _ensure_clinical_timing_columns(cur)
    param_cols = _table_columns(cur, "patient_diagnosis_parameters")
    has_screening = (not param_cols) or ("screening_id" in param_cols)
    cur.execute(
        """
        SELECT * FROM patient_diagnosis_parameters
        WHERE patient_id = %s
        ORDER BY parameter_id ASC
        """,
        (patient_id,),
    )
    param_rows = list(cur.fetchall() or [])
    ledger_rows = []
    chart_rows = []
    for row in param_rows:
        sid = row.get("screening_id") if has_screening else None
        if sid not in (None, ""):
            ledger_rows.append(row)
        else:
            chart_rows.append(row)
    for row in ledger_rows + chart_rows:
        _apply_parameter_row_to_pdf(dest, row)


def _load_patient_for_pdf(patient_id: int) -> Optional[dict[str, Any]]:
    """Load personal + canonical clinical chart + latest diagnosis for lab PDF export.

    Screening snapshot rows (screening_id set) are sparse ledgers. Prefer the
    editable chart row (screening_id IS NULL), then overlay non-empty snapshot
    and clinical_inputs_snapshot values so the PDF matches what is saved.
    """
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_owner_provider_column(cur)
                _ensure_clinical_timing_columns(cur)
                _ensure_patient_address_columns(cur)
                _ensure_patient_name_columns(cur)
                existing_personal = _table_columns(cur, "patient_personal_info")
                wanted_personal = [
                    "patient_id", "patient_name", "first_name", "middle_name", "surname",
                    "age", "date_of_birth", "date_added", "contact_no",
                    "address", "address_street", "address_barangay", "address_municipality", "address_city",
                    "reffered_by", "civil_status", "occupation", "religion",
                    "clinical_recommendations", "owner_provider_id", "linked_user_id",
                ]
                select_cols = [
                    f"p.`{col}`"
                    for col in wanted_personal
                    if (not existing_personal) or col in existing_personal
                ]
                if not select_cols:
                    select_cols = ["p.`patient_id`", "p.`patient_name`"]
                cur.execute(
                    f"""
                    SELECT {", ".join(select_cols)}
                    FROM patient_personal_info p
                    WHERE p.patient_id = %s
                    LIMIT 1
                    """,
                    (patient_id,),
                )
                personal = cur.fetchone()
                if not personal:
                    return None
                patient: dict[str, Any] = {
                    k: _serialize_value(v) for k, v in dict(personal).items()
                }
                patient.update(_patient_address_response(personal))
                patient.update(_patient_name_response(personal))

                _coalesce_parameter_rows(cur, patient_id, patient)

                result_cols = _table_columns(cur, "patient_diagnosis_results")
                snap_sql = (
                    ", clinical_inputs_snapshot"
                    if (not result_cols or "clinical_inputs_snapshot" in result_cols)
                    else ""
                )
                cur.execute(
                    f"""
                    SELECT
                        diagnosis_id,
                        XGBoost_diagnosis,
                        XGBoost_diagnosis_probability_percentage,
                        CNN_diagnosis,
                        CNN_diagnosis_probability_percentage,
                        Overall_diagnosis,
                        Overall_diagnosis_probability_percentage,
                        created_at AS screening_created_at
                        {snap_sql}
                    FROM patient_diagnosis_results
                    WHERE patient_id = %s
                    ORDER BY diagnosis_id DESC
                    LIMIT 1
                    """,
                    (patient_id,),
                )
                dx = cur.fetchone()
                if dx:
                    dx_map = dict(dx)
                    snap_raw = dx_map.pop("clinical_inputs_snapshot", None)
                    for k, v in dx_map.items():
                        if not _pdf_value_empty(v):
                            patient[k] = _serialize_value(v)
                    _apply_parameter_row_to_pdf(
                        patient,
                        _pdf_parse_snapshot(snap_raw),
                        only_if_empty=True,
                    )

                if _pdf_value_empty(patient.get("Ultrasound_image")):
                    try:
                        cur.execute(
                            """
                            SELECT Ultrasound_image
                            FROM patient_diagnosis_parameters
                            WHERE patient_id = %s
                              AND Ultrasound_image IS NOT NULL
                              AND OCTET_LENGTH(Ultrasound_image) > 32
                            ORDER BY parameter_id DESC
                            LIMIT 1
                            """,
                            (patient_id,),
                        )
                        us_row = cur.fetchone()
                        if us_row:
                            _apply_parameter_row_to_pdf(patient, us_row)
                    except Exception:  # noqa: BLE001
                        pass

                _apply_pdf_aliases(patient)
                _apply_pdf_computed_fields(patient)
                _normalize_pdf_personal_fields(patient)
                return patient
    except Exception:  # noqa: BLE001
        logger.exception("PDF patient load failed for id=%s", patient_id)
        return None


def _merge_personal_pdf_fields(out: dict[str, Any], src: Any) -> None:
    """Copy split name/address demographics when the destination field is empty."""
    if not isinstance(src, dict):
        return
    keys = (
        "first_name",
        "middle_name",
        "surname",
        "patient_name",
        "name",
        "address_street",
        "address_barangay",
        "address_town",
        "address_municipality",
        "address_city",
        "address",
        "contact_no",
        "civil_status",
        "occupation",
        "religion",
        "referred_by",
        "reffered_by",
        "date_of_birth",
        "DOB",
    )
    for key in keys:
        if not _pdf_value_empty(out.get(key)):
            continue
        val = src.get(key)
        if _pdf_value_empty(val):
            continue
        if key in ("patient_name", "name"):
            text = re.sub(
                r"^(?:PMOS|PCOS)-\d+\s*[:\-–]\s*",
                "",
                str(val).strip(),
                flags=re.I,
            ).strip()
            if not text:
                continue
            val = text
        out[key] = val


def _normalize_pdf_personal_fields(out: dict[str, Any]) -> None:
    out.update(_patient_address_response(out))
    out.update(_patient_name_response(out))


def _merge_pdf_payload(patient: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Merge slim frontend export fields into DB patient dict (DB wins when present)."""
    out = dict(patient)
    aliases = {
        "patient_name": ("patient_name", "name"),
        "age": ("age",),
        "clinical_score_percentage": ("clinical_score_percentage", "xgboost_probability"),
        "imaging_score_percentage": ("imaging_score_percentage", "cnn_probability"),
        "overall_diagnosis_percentage": ("overall_diagnosis_percentage", "overall_probability"),
        "overall_diagnosis": ("overall_diagnosis",),
        "clinical_diagnosis": ("clinical_diagnosis", "xgboost_diagnosis"),
        "imaging_diagnosis": ("imaging_diagnosis", "cnn_diagnosis"),
        "date_added": ("date_added",),
        "last_screened_at": ("last_screened_at", "screening_created_at"),
        "screening_created_at": ("screening_created_at", "last_screened_at"),
    }
    for dest, sources in aliases.items():
        if out.get(dest) not in (None, ""):
            continue
        for src in sources:
            if payload.get(src) not in (None, ""):
                out[dest] = payload[src]
                break

    # Map frontend diagnosis fallbacks into DB column names when empty
    if out.get("XGBoost_diagnosis") in (None, "") and out.get("clinical_diagnosis") not in (None, ""):
        out["XGBoost_diagnosis"] = out["clinical_diagnosis"]
    if out.get("XGBoost_diagnosis_probability_percentage") in (None, "") and out.get(
        "clinical_score_percentage"
    ) not in (None, ""):
        out["XGBoost_diagnosis_probability_percentage"] = out["clinical_score_percentage"]
    if out.get("CNN_diagnosis") in (None, "") and out.get("imaging_diagnosis") not in (None, ""):
        out["CNN_diagnosis"] = out["imaging_diagnosis"]
    if out.get("CNN_diagnosis_probability_percentage") in (None, "") and out.get(
        "imaging_score_percentage"
    ) not in (None, ""):
        out["CNN_diagnosis_probability_percentage"] = out["imaging_score_percentage"]
    if out.get("Overall_diagnosis") in (None, "") and out.get("overall_diagnosis") not in (None, ""):
        out["Overall_diagnosis"] = out["overall_diagnosis"]
    if out.get("Overall_diagnosis_probability_percentage") in (None, "") and out.get(
        "overall_diagnosis_percentage"
    ) not in (None, ""):
        out["Overall_diagnosis_probability_percentage"] = out["overall_diagnosis_percentage"]

    _merge_personal_pdf_fields(out, payload)
    clinical = payload.get("clinical_data") if isinstance(payload.get("clinical_data"), dict) else {}
    _apply_parameter_row_to_pdf(out, clinical, only_if_empty=True)
    form_clinical = payload.get("clinical_form_data") if isinstance(payload.get("clinical_form_data"), dict) else {}
    _apply_parameter_row_to_pdf(out, form_clinical, only_if_empty=True)
    frontend_full = payload.get("full_patient_data") if isinstance(payload.get("full_patient_data"), dict) else {}
    _merge_personal_pdf_fields(out, frontend_full)
    _apply_parameter_row_to_pdf(out, frontend_full, only_if_empty=True)
    if isinstance(frontend_full.get("clinical_data"), dict):
        _merge_personal_pdf_fields(out, frontend_full["clinical_data"])
        _apply_parameter_row_to_pdf(out, frontend_full["clinical_data"], only_if_empty=True)

    imaging = payload.get("imaging_data") if isinstance(payload.get("imaging_data"), dict) else {}
    for k, v in imaging.items():
        if k == "gradcam_visualization" and v:
            out["gradcam_visualization"] = v
        elif out.get(k) in (None, "") and v not in (None, ""):
            dest = _DIAGNOSIS_ALIASES.get(k, k)
            if out.get(dest) in (None, ""):
                out[dest] = v

    if payload.get("ultrasound_image") and not out.get("Ultrasound_image"):
        out["Ultrasound_image"] = payload["ultrasound_image"]
    if payload.get("gradcam_visualization"):
        out["gradcam_visualization"] = payload["gradcam_visualization"]
    elif payload.get("gradcam_image"):
        out["gradcam_visualization"] = payload["gradcam_image"]

    _apply_pdf_aliases(out)
    _apply_pdf_computed_fields(out)
    _normalize_pdf_personal_fields(out)
    return out


def _normalize_shap_rows(rows: Any) -> list[dict[str, Any]]:
    """Normalize SHAP contribution rows from API / DB / frontend shapes."""
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        feature = row.get("feature") or row.get("feature_name") or row.get("name")
        if feature is None or feature == "":
            continue
        if row.get("was_missing"):
            continue
        try:
            shap_val = float(row.get("shap_value", row.get("shap", 0)) or 0)
        except (TypeError, ValueError):
            shap_val = 0.0
        out.append(
            {
                "feature": str(feature),
                "value": row.get("value", row.get("feature_value")),
                "shap_value": shap_val,
            }
        )
        if len(out) >= 10:
            break
    return out


def _extract_shap_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = [
        ((payload.get("shap_explanation") or {}) if isinstance(payload.get("shap_explanation"), dict) else {}).get(
            "top_contributions"
        ),
        payload.get("top_contributions"),
        (
            ((payload.get("clinical_data") or {}).get("shap_explanation") or {}).get("top_contributions")
            if isinstance(payload.get("clinical_data"), dict)
            else None
        ),
        (
            ((payload.get("clinical_data") or {}).get("top_contributions"))
            if isinstance(payload.get("clinical_data"), dict)
            else None
        ),
        (
            (
                ((payload.get("full_patient_data") or {}).get("api_response") or {}).get("shap_explanation") or {}
            ).get("top_contributions")
            if isinstance(payload.get("full_patient_data"), dict)
            else None
        ),
        (
            ((payload.get("full_patient_data") or {}).get("shap_explanation") or {}).get("top_contributions")
            if isinstance(payload.get("full_patient_data"), dict)
            else None
        ),
    ]
    for rows in candidates:
        normalized = _normalize_shap_rows(rows)
        if normalized:
            return normalized
    return []


def _load_shap_from_db(patient_id: int, diagnosis_id: Any = None) -> list[dict[str, Any]]:
    """Load stored XAI feature contributions when available."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                if diagnosis_id not in (None, "", 0, "0"):
                    cur.execute(
                        """
                        SELECT insight_id, base_value, interpretation_text
                        FROM xai_insights
                        WHERE patient_id = %s AND model_type = 'xgboost' AND diagnosis_id = %s
                        ORDER BY created_at DESC
                        LIMIT 1
                        """,
                        (patient_id, int(diagnosis_id)),
                    )
                else:
                    cur.execute(
                        """
                        SELECT insight_id, base_value, interpretation_text
                        FROM xai_insights
                        WHERE patient_id = %s AND model_type = 'xgboost'
                        ORDER BY created_at DESC
                        LIMIT 1
                        """,
                        (patient_id,),
                    )
                insight = cur.fetchone()
                if not insight:
                    return []
                insight_id = insight.get("insight_id")
                cur.execute(
                    """
                    SELECT feature_name, feature_value, shap_value
                    FROM xai_feature_contributions
                    WHERE insight_id = %s
                    ORDER BY ABS(shap_value) DESC
                    LIMIT 10
                    """,
                    (insight_id,),
                )
                rows = cur.fetchall() or []
                return _normalize_shap_rows(
                    [
                        {
                            "feature": r.get("feature_name"),
                            "value": r.get("feature_value"),
                            "shap_value": r.get("shap_value"),
                        }
                        for r in rows
                    ]
                )
    except Exception:  # noqa: BLE001
        logger.warning("PDF SHAP DB load failed for patient_id=%s", patient_id, exc_info=True)
        return []


def _clinical_dict_for_shap(patient: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Collect clinical keys for TreeSHAP: mirrors PHP pcode_export_recompute_shap."""
    keys = (
        "age", "Age_yrs", "Weight_kg", "Height_cm", "BMI", "Blood_Group",
        "Pulse_rate", "Pulse_rate_bpm", "RR_breath", "RR_breath_min",
        "BP_systolic", "BP_Systolic_mmHg", "BP_diastolic", "BP_Diastolic_mmHg",
        "Hemoglobin", "Hb_g_dl", "Cycle_R_I", "CycleR_I", "Cycle_length", "Cycle_length_days",
        "Marriage_duration", "Marriage_Status_years", "Pregnant", "Pregnant_status",
        "No_abortions", "No_of_abortions", "LH_level", "LH_mIU_mL", "FSH_level", "FSH_mIU_mL",
        "AMH_level", "AMH_ng_mL", "PRL_level", "PRL_ng_mL", "TSH_level", "TSH_mIU_L",
        "Progesterone_level", "PRG_ng_mL", "Vitamin_D3_level", "Vit_D3_ng_mL",
        "RBS", "RBS_mg_dl", "Waist_inch", "Hip_inch", "Waist_hip_ratio",
        "Follicle_no_L", "Follicle_no_R", "Avg_F_size_L", "Avg_F_size_L_mm",
        "Avg_F_size_R", "Avg_F_size_R_mm", "Endometrium_mm",
        "Weight_gain", "Hair_growth", "Skin_darkening", "Hair_loss", "Pimples",
        "Fast_food", "Reg_Exercise", "I_Beta_HCG", "I_beta_HCG_mIU_mL",
        "II_Beta_HCG", "II_beta_HCG_mIU_mL", "LH_FSH_Ratio", "FSH_LH",
    )
    drop = {
        "probability", "classification", "description", "missingValues",
        "shap_explanation", "reliable", "gradcam_visualization", "Ultrasound_image",
        "ultrasound_image",
    }
    clinical: dict[str, Any] = {}
    sources: list[dict[str, Any]] = []
    for key in ("clinical_form_data", "clinical_data", "clinical_inputs", "full_patient_data"):
        blob = payload.get(key)
        if isinstance(blob, dict):
            nested = blob.get("clinical_data") if key == "full_patient_data" else None
            sources.append(blob)
            if isinstance(nested, dict):
                sources.append(nested)
    sources.append(patient)
    for src in sources:
        for k in keys:
            if k in clinical:
                continue
            if k in src and src[k] not in (None, ""):
                clinical[k] = src[k]
    for k in list(clinical.keys()):
        if k in drop:
            clinical.pop(k, None)
    return clinical


def _recompute_shap_for_pdf(patient: dict[str, Any], payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Re-run TreeSHAP from saved clinical parameters (Patients slim export has no SHAP)."""
    clinical = _clinical_dict_for_shap(patient, payload)
    if len(clinical) < 3:
        logger.info("PDF SHAP recompute skipped: insufficient clinical fields (%s)", len(clinical))
        return []
    try:
        # Lazy import avoids circular import with main.register_crud_blueprint
        import main as ml_main  # noqa: WPS433
        from utils import shap_explain  # noqa: WPS433

        cycle = clinical.get("Cycle_R_I") or clinical.get("CycleR_I")
        if isinstance(cycle, str):
            c = cycle.strip().lower()
            if c == "regular":
                clinical["Cycle_R_I"] = 0
            elif c in ("irregular", "amenorrhea", "amenorrhoea"):
                clinical["Cycle_R_I"] = 1

        model = ml_main.get_xgb_model()
        df, feature_names = ml_main.prepare_clinical_frame(clinical, model)
        shap_payload = shap_explain.explain_instance(
            model,
            df,
            feature_names=feature_names,
            cache_key=str(ml_main.XGB_MODEL_PATH),
        )
        explanation = ml_main.build_shap_explanation(shap_payload)
        return _normalize_shap_rows(explanation.get("top_contributions"))
    except Exception:  # noqa: BLE001
        logger.exception("PDF SHAP recompute failed")
        return []


def _decode_image_data_uri(value: Any) -> Optional[bytes]:
    if value is None or value == "":
        return None
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        if raw.startswith(b"data:"):
            try:
                text = raw.decode("ascii", errors="ignore")
            except Exception:  # noqa: BLE001
                return raw
            return _decode_image_data_uri(text)
        # Already binary image bytes
        if len(raw) > 32 and not _looks_like_base64_text(raw.decode("ascii", errors="ignore")[:200]):
            return raw
        try:
            import base64 as _b64

            return _b64.b64decode(raw, validate=False)
        except Exception:  # noqa: BLE001
            return raw
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if s.startswith("data:"):
        comma = s.find(",")
        if comma < 0:
            return None
        s = s[comma + 1 :]
    s = re.sub(r"\s+", "", s)
    try:
        import base64 as _b64

        return _b64.b64decode(s, validate=False)
    except Exception:  # noqa: BLE001
        return None


def _generate_gradcam_for_pdf(ultrasound: Any) -> str:
    """Build Grad-CAM++ overlay data-URI from the saved ultrasound frame."""
    image_bytes = _decode_image_data_uri(ultrasound)
    if not image_bytes or len(image_bytes) < 32:
        return ""
    try:
        import main as ml_main  # noqa: WPS433
        from utils import gradcam_pp  # noqa: WPS433

        model = ml_main.get_cnn_model()
        batch, original_rgb, original_size = ml_main.preprocess_ultrasound(image_bytes)
        raw_p = ml_main.predict_proba_cnn(model, batch)
        smoothed = ml_main.apply_temperature_scaling(raw_p)
        pct = round(smoothed * 100.0, 2)
        _cam, uri = gradcam_pp.generate_gradcam_pp_overlay(
            model,
            batch,
            original_rgb,
            class_index=None,
            original_size=original_size,
            probability_percentage=pct,
        )
        if isinstance(uri, str) and uri.strip():
            if uri.strip().lower().startswith("data:image"):
                return uri.strip()
            return "data:image/png;base64," + re.sub(r"\s+", "", uri.strip())
        return ""
    except Exception:  # noqa: BLE001
        logger.exception("PDF Grad-CAM++ generation failed")
        return ""


@bp.post("/api/export_xai_pdf")
@bp.post("/api/export_xai_pdf.php")
def api_export_xai_pdf():
    """
    Lab-style PMOS clinical PDF (matches PHP _lab_report_template + html_to_pdf).
    Returns a data: URL so Firebase Hosting clients can download without /exports/.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Invalid JSON export payload", 400)

    raw_id = str(payload.get("patient_id") or "").strip()
    if not raw_id:
        return _json_error("Patient ID is required", 400)
    m = re.search(r"(\d+)", raw_id)
    try:
        patient_id = int(m.group(1)) if m else 0
    except (TypeError, ValueError):
        patient_id = 0
    if patient_id <= 0:
        return _json_error("Invalid patient ID format", 400)

    try:
        decoded = decode_jwt(request.headers.get("Authorization") or "")
    except ValueError as exc:
        return _json_error(str(exc) or "Sign in required to export a report", 401)

    is_guest = bool(decoded.get("isGuest")) or str(decoded.get("role") or "").lower() == "guest"
    uid = _safe_int_id(decoded.get("id"))
    role = str(decoded.get("role") or "").lower()

    patient = None if is_guest else _load_patient_for_pdf(patient_id)
    if patient:
        if role in ("provider", "healthcare provider", "ob-gyn", "obgyn") and uid > 0:
            owner = _safe_int_id(patient.get("owner_provider_id"))
            if owner > 0 and owner != uid and role not in ("administrator", "admin", "system administrator"):
                return _json_error("You do not have access to this patient record", 403)
        if role in ("user", "patient", "community", "regular user") and uid > 0:
            linked = _safe_int_id(patient.get("linked_user_id"))
            if linked > 0 and linked != uid and role not in ("administrator", "admin"):
                return _json_error("You do not have access to this patient record", 403)
    else:
        # Guest / slim payload-only export
        frontend = payload.get("full_patient_data") if isinstance(payload.get("full_patient_data"), dict) else {}
        if is_guest and not frontend and not payload.get("overall_diagnosis") and not payload.get("clinical_diagnosis"):
            return _json_error("No screening results to export for this guest session", 400)
        patient = {
            "patient_id": patient_id,
            "patient_name": frontend.get("name")
            or payload.get("patient_name")
            or "Guest Patient",
            "first_name": frontend.get("first_name") or payload.get("first_name"),
            "middle_name": frontend.get("middle_name") or payload.get("middle_name"),
            "surname": frontend.get("surname") or payload.get("surname"),
            "address_street": frontend.get("address_street") or payload.get("address_street"),
            "address_barangay": frontend.get("address_barangay")
            or frontend.get("address_town")
            or payload.get("address_barangay")
            or payload.get("address_town"),
            "address_town": frontend.get("address_barangay")
            or frontend.get("address_town")
            or payload.get("address_barangay")
            or payload.get("address_town"),
            "address_municipality": frontend.get("address_municipality")
            or payload.get("address_municipality"),
            "address_city": frontend.get("address_city") or payload.get("address_city"),
            "address": frontend.get("address") or payload.get("address"),
            "age": frontend.get("age") or payload.get("age"),
            "Overall_diagnosis": payload.get("overall_diagnosis") or "pending",
            "Overall_diagnosis_probability_percentage": payload.get("overall_diagnosis_percentage") or 0,
            "XGBoost_diagnosis": payload.get("clinical_diagnosis") or "pending",
            "XGBoost_diagnosis_probability_percentage": payload.get("clinical_score_percentage") or 0,
            "CNN_diagnosis": payload.get("imaging_diagnosis") or "pending",
            "CNN_diagnosis_probability_percentage": payload.get("imaging_score_percentage") or 0,
        }
        if isinstance(frontend.get("clinical_data"), dict):
            patient.update(frontend["clinical_data"])

    patient = _merge_pdf_payload(patient, payload)

    # SHAP: payload → DB insights → recompute from clinical parameters
    shap_data: dict[str, Any] = {"top_contributions": []}
    live_shap = _extract_shap_from_payload(payload)
    if live_shap:
        shap_data["top_contributions"] = live_shap
    if not shap_data["top_contributions"]:
        db_shap = _load_shap_from_db(patient_id, patient.get("diagnosis_id"))
        if db_shap:
            shap_data["top_contributions"] = db_shap
    if not shap_data["top_contributions"]:
        recomputed = _recompute_shap_for_pdf(patient, payload)
        if recomputed:
            shap_data["top_contributions"] = recomputed
            logger.info("PDF export: recomputed %s SHAP factors", len(recomputed))

    # Grad-CAM++: payload/patient → generate from saved ultrasound if missing
    if not patient.get("gradcam_visualization") and not patient.get("gradcam_image"):
        us_for_cam = (
            patient.get("Ultrasound_image")
            or patient.get("ultrasound_image")
            or payload.get("ultrasound_image")
            or ""
        )
        generated = _generate_gradcam_for_pdf(us_for_cam)
        if generated:
            patient["gradcam_visualization"] = generated
            logger.info("PDF export: generated Grad-CAM++ overlay")

    user_name = "Healthcare Professional"
    try:
        uid = int(payload.get("user_id") or decoded.get("id") or 0)
        if uid > 0:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT user_name FROM users WHERE user_id = %s LIMIT 1",
                        (uid,),
                    )
                    row = cur.fetchone()
                    if row and row.get("user_name"):
                        user_name = str(row["user_name"])
    except Exception:  # noqa: BLE001
        pass

    try:
        # lab_report_pdf + html_to_pdf ship inside the functions package
        if str(BASE_DIR) not in sys.path:
            sys.path.insert(0, str(BASE_DIR))
        from lab_report_pdf import generate_lab_pdf_bytes  # noqa: WPS433

        pdf_bytes = generate_lab_pdf_bytes(patient, shap_data, user_name)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Lab PDF generation failed")
        return _json_error("PDF generation failed", 500, detail=str(exc))

    if not pdf_bytes or len(pdf_bytes) < 100:
        return _json_error("PDF generation produced an empty file", 500)

    b64 = base64.b64encode(pdf_bytes).decode("ascii")
    stamp = _now_manila().strftime("%Y%m%d_%H%M%S")
    filename = f"PMOS_Report_{patient_id:03d}_{stamp}.pdf"
    if decoded.get("id"):
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    _admin_audit(
                        cur,
                        decoded,
                        action="pdf_export",
                        target_type="patient",
                        target_id=patient_id,
                        target_email="",
                        detail={"filename": filename},
                    )
                    conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("pdf_export audit skipped: %s", exc)
    return jsonify(
        {
            "success": True,
            "message": "Report generated successfully",
            "filename": filename,
            "file_url": f"data:application/pdf;base64,{b64}",
            "xai": {
                "shap_count": len(shap_data.get("top_contributions") or []),
                "has_gradcam": bool(patient.get("gradcam_visualization") or patient.get("gradcam_image")),
            },
        }
    ), 200


@bp.post("/api/delete_patient")
@bp.post("/api/delete_patient.php")
def api_delete_patient():
    try:
        decoded = _require_provider_auth()
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    provider_id = int(decoded.get("id") or 0)
    payload = request.get_json(silent=True) or {}
    patient_id = payload.get("patient_id") or request.args.get("id")
    try:
        patient_id = int(patient_id)
    except (TypeError, ValueError):
        patient_id = 0
    if patient_id <= 0:
        return _json_error("Patient ID is required", 400)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_owner_provider_column(cur)
                cur.execute(
                    "DELETE FROM patient_diagnosis_results WHERE patient_id = %s",
                    (patient_id,),
                )
                cur.execute(
                    "DELETE FROM patient_diagnosis_parameters WHERE patient_id = %s",
                    (patient_id,),
                )
                cur.execute(
                    """
                    DELETE FROM patient_personal_info
                    WHERE patient_id = %s AND owner_provider_id = %s
                    """,
                    (patient_id, provider_id),
                )
                if cur.rowcount == 0:
                    return _json_error("You can only delete patients in your own care", 403)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Delete patient failed")
        return _json_error("Failed to delete patient", 500, detail=str(exc))

    return _json_ok(message="Patient deleted successfully")


@bp.post("/api/save_patient")
@bp.post("/api/save_patient.php")
def api_save_patient():
    """Create/update personal info + draft clinical parameters for a provider."""
    try:
        decoded = _require_provider_auth()
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    provider_id = int(decoded.get("id") or 0)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not payload:
        return _json_error("No data provided", 400)

    # Remap common form aliases
    data = dict(payload)
    alias_map = {
        "name": "patient_name",
        "age": "Age_yrs",
        "date_of_birth": "DOB",
        "referred_by": "referred_by",
        "height": "Height_cm",
        "weight": "Weight_kg",
        "bmi": "BMI",
        "recommendations": "clinical_recommendations",
    }
    for src, dst in alias_map.items():
        if src in data and dst not in data:
            data[dst] = data[src]

    patient_id = data.get("patient_id")
    if (not patient_id) and data.get("id"):
        try:
            patient_id = int(re.sub(r"^(?:PCOS|PMOS)-", "", str(data.get("id")), flags=re.I))
        except (TypeError, ValueError):
            patient_id = 0
    try:
        patient_id = int(patient_id) if patient_id not in (None, "") else 0
    except (TypeError, ValueError):
        patient_id = 0

    name_parts = _patient_name_from_payload(data)
    name = str(name_parts.get("patient_name") or "").strip()
    first_name = name_parts.get("first_name")
    middle_name = name_parts.get("middle_name")
    surname = name_parts.get("surname")
    # Detect save often sends the <select> option label (e.g. "PMOS-039: Alice") as patient_name.
    # That is not a personal-info edit: ignore it so clinical-only saves don't rewrite demographics.
    if re.search(r"(?:PMOS|PCOS)-\d+", name, flags=re.I):
        name = ""
        first_name = None
        middle_name = None
        surname = None
    age = data.get("Age_yrs")
    try:
        age = int(age) if age not in (None, "") else None
    except (TypeError, ValueError):
        age = None
    # Prefer explicit personal age fields over clinical Age_yrs when both present
    if "age" in data and data.get("age") not in (None, ""):
        try:
            age = int(data.get("age"))
        except (TypeError, ValueError):
            pass
    dob = data.get("DOB") or data.get("date_of_birth") or None
    dob = _coerce_sql_date(dob)
    contact = _coerce_contact_no(data.get("contact_no"))
    addr = _patient_address_from_payload(data)
    address = addr.get("address") or ""
    address_street = addr.get("address_street")
    address_barangay = addr.get("address_barangay") or addr.get("address_town")
    address_municipality = addr.get("address_municipality")
    address_city = addr.get("address_city")
    civil_status = data.get("civil_status") or ""
    occupation = data.get("occupation") or ""
    religion = data.get("religion") or ""
    referred_by = data.get("referred_by") or ""
    has_recs = "clinical_recommendations" in data
    clinical_recommendations = (
        str(data.get("clinical_recommendations") or "").strip() if has_recs else ""
    )

    # Clinical-only Detect saves should not rewrite personal info from Age_yrs alone
    explicit_personal = any(
        k in data and data.get(k) not in (None, "")
        for k in (
            "patient_name",
            "name",
            "first_name",
            "middle_name",
            "surname",
            "DOB",
            "date_of_birth",
            "contact_no",
            "address",
            "address_street",
            "address_barangay",
            "address_town",
            "address_municipality",
            "address_city",
            "civil_status",
            "occupation",
            "religion",
            "referred_by",
            "clinical_recommendations",
        )
    ) and bool(
        name
        or dob
        or contact
        or str(first_name or "").strip()
        or str(middle_name or "").strip()
        or str(surname or "").strip()
        or str(address).strip()
        or str(address_street or "").strip()
        or str(address_barangay or "").strip()
        or str(address_municipality or "").strip()
        or str(address_city or "").strip()
        or str(civil_status).strip()
        or str(occupation).strip()
        or str(religion).strip()
        or str(referred_by).strip()
        or has_recs
    )

    has_personal = explicit_personal

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_owner_provider_column(cur)
                _ensure_clinical_recommendations_column(cur)
                _ensure_patient_address_columns(cur)
                _ensure_patient_name_columns(cur)
                personal_cols = _table_columns(cur, "patient_personal_info")
                exists = False
                if patient_id > 0:
                    cur.execute(
                        """
                        SELECT patient_id FROM patient_personal_info
                        WHERE patient_id = %s AND owner_provider_id = %s
                        LIMIT 1
                        """,
                        (patient_id, provider_id),
                    )
                    exists = cur.fetchone() is not None
                    if not exists and not has_personal:
                        return _json_error("Patient not found in your care", 404)

                if not exists or has_personal:
                    if exists:
                        if has_recs and (
                            not personal_cols or "clinical_recommendations" in personal_cols
                        ):
                            cur.execute(
                                """
                                UPDATE patient_personal_info
                                SET patient_name=%s, first_name=%s, middle_name=%s, surname=%s,
                                    age=%s, date_of_birth=%s, contact_no=%s,
                                    address=%s, address_street=%s, address_barangay=%s,
                                    address_municipality=%s, address_city=%s,
                                    civil_status=%s, occupation=%s, religion=%s,
                                    reffered_by=%s, clinical_recommendations=%s
                                WHERE patient_id=%s AND owner_provider_id=%s
                                """,
                                (
                                    name, first_name, middle_name, surname, age, dob, contact, address, address_street, address_barangay,
                                    address_municipality, address_city, civil_status, occupation,
                                    religion, referred_by, clinical_recommendations,
                                    patient_id, provider_id,
                                ),
                            )
                        else:
                            cur.execute(
                                """
                                UPDATE patient_personal_info
                                SET patient_name=%s, first_name=%s, middle_name=%s, surname=%s,
                                    age=%s, date_of_birth=%s, contact_no=%s,
                                    address=%s, address_street=%s, address_barangay=%s,
                                    address_municipality=%s, address_city=%s,
                                    civil_status=%s, occupation=%s, religion=%s,
                                    reffered_by=%s
                                WHERE patient_id=%s AND owner_provider_id=%s
                                """,
                                (
                                    name, first_name, middle_name, surname, age, dob, contact, address, address_street, address_barangay,
                                    address_municipality, address_city, civil_status, occupation,
                                    religion, referred_by, patient_id, provider_id,
                                ),
                            )
                    else:
                        insert_cols = [
                            "patient_name",
                            "first_name",
                            "middle_name",
                            "surname",
                            "age",
                            "date_of_birth",
                            "contact_no",
                            "address",
                            "address_street",
                            "address_barangay",
                            "address_municipality",
                            "address_city",
                            "civil_status",
                            "occupation",
                            "religion",
                            "reffered_by",
                        ]
                        insert_vals: list[Any] = [
                            name,
                            first_name,
                            middle_name,
                            surname,
                            age,
                            dob,
                            contact,
                            address,
                            address_street,
                            address_barangay,
                            address_municipality,
                            address_city,
                            civil_status,
                            occupation,
                            religion,
                            referred_by,
                        ]
                        if not personal_cols or "clinical_recommendations" in personal_cols:
                            insert_cols.append("clinical_recommendations")
                            insert_vals.append(clinical_recommendations)
                        if not personal_cols or "owner_provider_id" in personal_cols:
                            insert_cols.append("owner_provider_id")
                            insert_vals.append(provider_id)
                        col_sql = ", ".join(insert_cols)
                        placeholders = ", ".join(["%s"] * len(insert_cols))
                        cur.execute(
                            f"INSERT INTO patient_personal_info ({col_sql}) VALUES ({placeholders})",
                            insert_vals,
                        )
                        patient_id = int(cur.lastrowid)

                # Draft clinical parameters upsert
                clinical = _normalize_diagnosis_payload(data)
                clinical.pop("patient_id", None)
                clinical.pop("screening_id", None)
                if clinical:
                    clinical["patient_id"] = patient_id
                    clinical.setdefault("created_by", "Physician")
                    _ensure_clinical_timing_columns(cur)
                    param_cols = _table_columns(cur, "patient_diagnosis_parameters")
                    cur.execute(
                        """
                        SELECT parameter_id FROM patient_diagnosis_parameters
                        WHERE patient_id = %s
                          AND (screening_id IS NULL OR screening_id = '')
                        ORDER BY parameter_id DESC LIMIT 1
                        """,
                        (patient_id,),
                    )
                    draft = cur.fetchone()

                    def _run_param_write(include_ultrasound: bool = True) -> None:
                        payload_cols = dict(clinical)
                        if not include_ultrasound:
                            payload_cols.pop("Ultrasound_image", None)
                        if draft:
                            cols = [
                                c
                                for c in DIAGNOSIS_INSERT_COLUMNS
                                if c in payload_cols
                                and c != "patient_id"
                                and (not param_cols or c in param_cols)
                            ]
                            if not cols:
                                return
                            sets = ", ".join(f"`{c}`=%s" for c in cols)
                            vals = [payload_cols[c] for c in cols] + [int(draft["parameter_id"])]
                            cur.execute(
                                f"UPDATE patient_diagnosis_parameters SET {sets} WHERE parameter_id=%s",
                                vals,
                            )
                        else:
                            cols = [
                                c
                                for c in DIAGNOSIS_INSERT_COLUMNS
                                if c in payload_cols and (not param_cols or c in param_cols)
                            ]
                            if "patient_id" not in cols:
                                cols = ["patient_id"] + cols
                                payload_cols["patient_id"] = patient_id
                            if not cols:
                                return
                            placeholders = ", ".join(["%s"] * len(cols))
                            column_sql = ", ".join(f"`{c}`" for c in cols)
                            cur.execute(
                                f"INSERT INTO patient_diagnosis_parameters ({column_sql}) VALUES ({placeholders})",
                                [payload_cols[c] for c in cols],
                            )

                    try:
                        if "Ultrasound_image" in clinical:
                            cur.execute("SAVEPOINT sp_save_patient_us")
                            try:
                                _run_param_write(include_ultrasound=True)
                                cur.execute("RELEASE SAVEPOINT sp_save_patient_us")
                            except Exception as us_exc:  # noqa: BLE001
                                try:
                                    cur.execute("ROLLBACK TO SAVEPOINT sp_save_patient_us")
                                except Exception:  # noqa: BLE001
                                    pass
                                logger.warning(
                                    "Save patient ultrasound failed (%s); retrying without image",
                                    us_exc,
                                )
                                _run_param_write(include_ultrasound=False)
                        else:
                            _run_param_write(include_ultrasound=False)
                    except Exception:
                        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Save patient failed")
        return _json_error("Failed to save patient", 500, detail=str(exc))

    return _json_ok(
        {
            "patient_id": patient_id,
            "id": f"PMOS-{int(patient_id):03d}",
        },
        message="Patient saved successfully",
        patient_id=patient_id,
    )


# =============================================================================
# Diagnostic parameters insert
# =============================================================================
@bp.post("/api/patients/diagnosis")
def api_create_diagnosis():
    """
    Insert a row into patient_diagnosis_parameters.
    Requires patient_id; remaining clinical/ultrasound fields are optional.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not payload:
        return _json_error("Request body must be a non-empty JSON object", 400)

    row = _normalize_diagnosis_payload(payload)
    patient_id = row.get("patient_id")
    try:
        patient_id = int(patient_id)
    except (TypeError, ValueError):
        patient_id = 0

    if patient_id <= 0:
        return _json_error("patient_id is required and must be a positive integer", 400)

    row["patient_id"] = patient_id
    if not row.get("created_by"):
        row["created_by"] = "Physician"
    if not row.get("ultrasound_modality"):
        row["ultrasound_modality"] = "TVUS"

    columns = [c for c in DIAGNOSIS_INSERT_COLUMNS if c in row]
    if "patient_id" not in columns:
        return _json_error("patient_id is required", 400)

    placeholders = ", ".join(["%s"] * len(columns))
    column_sql = ", ".join(f"`{c}`" for c in columns)
    values = [row[c] for c in columns]
    sql = f"INSERT INTO patient_diagnosis_parameters ({column_sql}) VALUES ({placeholders})"

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, values)
                parameter_id = int(cur.lastrowid)
                cur.execute(
                    """
                    SELECT parameter_id, patient_id, created_by, created_at, screening_id
                    FROM patient_diagnosis_parameters
                    WHERE parameter_id = %s
                    LIMIT 1
                    """,
                    (parameter_id,),
                )
                created = cur.fetchone() or {"parameter_id": parameter_id, "patient_id": patient_id}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Diagnosis insert failed")
        return _json_error("Failed to insert diagnosis parameters", 500, detail=str(exc))

    safe = {k: _serialize_value(v) for k, v in dict(created).items()}
    return _json_ok(
        {
            "parameter_id": parameter_id,
            "record": safe,
        },
        message="Diagnosis parameters saved",
        parameter_id=parameter_id,
    )


# =============================================================================
# Combined predict + persist (Firebase-friendly single endpoint)
# =============================================================================
@bp.post("/api/predict")
@bp.post("/api/predict.php")
def api_predict():
    """
    Run server-side XGBoost + CNN inference, optionally persist to
    patient_diagnosis_results, and return prediction metrics.

    JSON body:
      {
        "patient_id": 123,                 # optional: saves when present
        "clinical": { ... },               # XGBoost features (or top-level fields)
        "image" | "image_base64": "...",   # ultrasound for CNN (optional)
        "smoothing_factor": 0.80,
        "save": true
      }
    """
    import json as _json
    import uuid as _uuid

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not payload:
        return _json_error("Request body must be a non-empty JSON object", 400)

    # Auth is recommended for save; allow anonymous inference without save
    decoded = None
    try:
        auth_header = request.headers.get("Authorization") or ""
        if auth_header:
            decoded = decode_jwt(auth_header)
    except ValueError:
        decoded = None

    clinical_in = payload.get("clinical") if isinstance(payload.get("clinical"), dict) else dict(payload)
    for drop in (
        "patient_id",
        "image",
        "image_base64",
        "Ultrasound_image",
        "save",
        "clinical",
        "generate_gradcam",
        "apply_smoothing",
        "user_mode",
        "smoothing_factor",
        "success",
        "error",
        "message",
    ):
        clinical_in.pop(drop, None)

    try:
        smoothing_factor = float(payload.get("smoothing_factor", 0.80))
    except (TypeError, ValueError):
        smoothing_factor = 0.80
    smoothing_factor = max(0.50, min(1.0, smoothing_factor))

    xgb_result: dict[str, Any] = {"success": False, "skipped": True}
    cnn_result: dict[str, Any] = {"success": False, "skipped": True}

    # --- XGBoost ---
    if clinical_in and XGB_MODEL_PATH.is_file():
        cycle = clinical_in.get("Cycle_R_I") or clinical_in.get("CycleR_I")
        if isinstance(cycle, str):
            c = cycle.strip().lower()
            if c == "regular":
                clinical_in["Cycle_R_I"] = 0
            elif c in ("irregular", "amenorrhea", "amenorrhoea"):
                clinical_in["Cycle_R_I"] = 1
        try:
            xgb = _load_xgb()
            xgb_result = xgb.convert_to_python_types(
                xgb.predict(clinical_in, str(XGB_MODEL_PATH), smoothing_factor=smoothing_factor)
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Predict XGBoost failed")
            xgb_result = {"success": False, "error": str(exc)}
    elif clinical_in and not XGB_MODEL_PATH.is_file():
        xgb_result = {"success": False, "error": f"XGBoost model missing at {XGB_MODEL_PATH}"}

    # --- CNN ---
    has_image = bool(
        payload.get("image") or payload.get("image_base64") or payload.get("Ultrasound_image")
    )
    if has_image and CNN_TFLITE_PATH.is_file():
        try:
            image_bytes = _decode_image_payload(payload)
            cnn_result = _run_cnn_inference(
                image_bytes,
                generate_gradcam=bool(payload.get("generate_gradcam", False)),
                apply_smoothing=bool(payload.get("apply_smoothing", True)),
                smoothing_factor=max(0.50, min(1.0, smoothing_factor)),
                user_mode=str(payload.get("user_mode") or ""),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Predict CNN failed")
            cnn_result = {"success": False, "error": str(exc)}
    elif has_image and not CNN_TFLITE_PATH.is_file():
        cnn_result = {"success": False, "error": f"CNN TFLite model missing at {CNN_TFLITE_PATH}"}

    def _label_to_code(label: Any, probability: Any = None) -> Optional[int]:
        if label is None:
            return None
        if isinstance(label, (int, float)) and not isinstance(label, bool):
            return int(label)
        s = str(label).strip().lower()
        if s in ("1", "positive", "pmos", "pcos"):
            return 1
        if s in ("0", "negative", "normal"):
            return 0
        if s in ("2", "borderline"):
            return 2
        try:
            p = float(probability)
            return 1 if p >= 0.5 else 0
        except (TypeError, ValueError):
            return None

    def _prob_percent(result: dict) -> Optional[float]:
        for key in (
            "probability_percentage",
            "probability_percent",
            "PMOS_probability_percentage",
            "positive_probability_percentage",
            "confidence_percentage",
            "probability",
            "confidence",
        ):
            if key in result and result[key] is not None:
                try:
                    n = float(result[key])
                except (TypeError, ValueError):
                    continue
                if n <= 1.0:
                    n *= 100.0
                return round(n, 2)
        return None

    xgb_code = _label_to_code(
        xgb_result.get("diagnosis") or xgb_result.get("prediction") or xgb_result.get("label"),
        xgb_result.get("probability"),
    )
    cnn_code = _label_to_code(
        cnn_result.get("diagnosis") or cnn_result.get("prediction") or cnn_result.get("label"),
        cnn_result.get("probability"),
    )
    xgb_pct = _prob_percent(xgb_result) if xgb_result.get("success") else None
    cnn_pct = _prob_percent(cnn_result) if cnn_result.get("success") else None

    # Overall: average available model probabilities; label by majority / threshold
    probs = [p for p in (xgb_pct, cnn_pct) if p is not None]
    overall_pct = round(sum(probs) / len(probs), 2) if probs else None
    codes = [c for c in (xgb_code, cnn_code) if c is not None]
    if len(codes) == 2 and codes[0] == codes[1]:
        overall_code = codes[0]
    elif overall_pct is not None:
        overall_code = 1 if overall_pct >= 50.0 else 0
    elif codes:
        overall_code = codes[0]
    else:
        overall_code = None

    patient_id = payload.get("patient_id")
    try:
        patient_id = int(patient_id) if patient_id not in (None, "") else 0
    except (TypeError, ValueError):
        patient_id = 0

    should_save = bool(payload.get("save", True)) and patient_id > 0
    diagnosis_id = None
    screening_id = str(payload.get("screening_id") or _uuid.uuid4())

    if should_save:
        if not decoded:
            return _json_error("Authorization required to save diagnosis results", 401)
        created_by = "Physician"
        role = str(decoded.get("role") or "").lower()
        if role in ("regular user", "patient", "user"):
            created_by = "Patient"
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO patient_diagnosis_results
                        (patient_id, XGBoost_diagnosis, XGBoost_diagnosis_probability_percentage,
                         CNN_diagnosis, CNN_diagnosis_probability_percentage,
                         Overall_diagnosis, Overall_diagnosis_probability_percentage,
                         created_by, clinical_inputs_snapshot, screening_id)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            patient_id,
                            xgb_code,
                            xgb_pct,
                            cnn_code,
                            cnn_pct,
                            overall_code,
                            overall_pct,
                            created_by,
                            _json.dumps(clinical_in, default=str),
                            screening_id,
                        ),
                    )
                    diagnosis_id = int(cur.lastrowid)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Predict save failed")
            return _json_error("Inference succeeded but saving diagnosis failed", 500, detail=str(exc))

    return jsonify(
        {
            "success": bool(xgb_result.get("success") or cnn_result.get("success")),
            "message": "Prediction complete",
            "patient_id": patient_id or None,
            "diagnosis_id": diagnosis_id,
            "screening_id": screening_id if should_save else None,
            "xgboost": xgb_result,
            "cnn": cnn_result,
            "metrics": {
                "xgboost_diagnosis": _diagnosis_label(xgb_code),
                "xgboost_probability_percentage": xgb_pct,
                "cnn_diagnosis": _diagnosis_label(cnn_code),
                "cnn_probability_percentage": cnn_pct,
                "overall_diagnosis": _diagnosis_label(overall_code),
                "overall_probability_percentage": overall_pct,
            },
        }
    ), 200


def _run_cnn_inference(
    image_bytes: bytes,
    *,
    generate_gradcam: bool = False,
    apply_smoothing: bool = True,
    smoothing_factor: float = 0.80,
    user_mode: str = "",
) -> dict[str, Any]:
    """Hosted CNN path: TFLite inference with Keras-parity postprocess (bands + smoothing)."""
    if not CNN_TFLITE_PATH.is_file():
        return {
            "success": False,
            "error": (
                f"CNN TFLite model not found at {CNN_TFLITE_PATH}. "
                "Upload pcos_detection_modelv4.tflite or set CNN_TFLITE_PATH."
            ),
        }
    try:
        tfl = _load_cnn_tflite()
    except Exception as exc:  # noqa: BLE001
        logger.exception("CNN TFLite module failed to load")
        return {"success": False, "error": f"CNN TFLite runtime unavailable: {exc}"}

    # Default smoothing = 0.96 (0.80 glued every confident scan to 90%)
    try:
        sf = float(smoothing_factor)
    except (TypeError, ValueError):
        sf = 0.96
    sf = max(0.50, min(1.0, sf))

    return tfl.predict_pcos_bytes(
        image_bytes,
        tflite_path=str(CNN_TFLITE_PATH),
        apply_smoothing=apply_smoothing,
        smoothing_factor=sf,
        generate_gradcam=generate_gradcam,
        user_mode=user_mode,
    )

# ML routes live in functions/main.py (not this blueprint).


def register_crud_blueprint(flask_app):
    """Attach Clever Cloud MySQL auth/patients routes onto the Firebase Flask app."""
    try:
        from admin_console import attach_admin_console

        attach_admin_console(bp)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to attach admin console routes: %s", exc)
    flask_app.register_blueprint(bp)
    return bp
