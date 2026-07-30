"""
P-Code Flask API — Render.com
ML inference + Clever Cloud MySQL (providers / diagnosis parameters).
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import sys
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator, Optional

import bcrypt
import pymysql
from dbutils.pooled_db import PooledDB
from flask import Flask, jsonify, request
from flask_cors import CORS
from pymysql.cursors import DictCursor

# Ensure project root is on sys.path so cnn_predict / xgboost_predict import cleanly
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# Lazy ML imports — TensorFlow/XGBoost must NOT block auth/DB boot on Render
cnn_predict = None  # type: ignore
xgboost_predict = None  # type: ignore


def _load_cnn():
    global cnn_predict
    if cnn_predict is None:
        import cnn_predict as _cnn  # noqa: WPS433

        cnn_predict = _cnn
    return cnn_predict


def _load_xgb():
    global xgboost_predict
    if xgboost_predict is None:
        import xgboost_predict as _xgb  # noqa: WPS433

        xgboost_predict = _xgb
    return xgboost_predict


logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("pcode")

app = Flask(__name__)

# --- CORS --------------------------------------------------------------------
_default_origin_patterns = [
    r"^https://.*\.web\.app$",
    r"^https://.*\.firebaseapp.com$",
    r"^https://.*$",
    r"^http://localhost(:\d+)?$",
    r"^http://127\.0\.0\.1(:\d+)?$",
]
_extra = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
CORS(
    app,
    resources={
        r"/*": {
            "origins": _extra + _default_origin_patterns,
            "methods": ["GET", "POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization"],
            "expose_headers": ["Content-Type"],
            "max_age": 86400,
        }
    },
    supports_credentials=False,
)


@app.after_request
def _ensure_cors_headers(response):
    """Guarantee CORS on every response (including 4xx) for the Firebase frontend."""
    origin = request.headers.get("Origin", "")
    allow = False
    if origin:
        if origin in _extra:
            allow = True
        elif re.match(r"^https://.*\.web\.app$", origin):
            allow = True
        elif re.match(r"^https://.*\.firebaseapp.com$", origin):
            allow = True
        elif re.match(r"^https://", origin):
            allow = True
        elif re.match(r"^http://localhost(:\d+)?$", origin):
            allow = True
        elif re.match(r"^http://127\.0\.0\.1(:\d+)?$", origin):
            allow = True
    if allow:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.route("/api/<path:_any>", methods=["OPTIONS"])
@app.route("/<path:_any>", methods=["OPTIONS"])
def _cors_preflight(_any: str = ""):
    return ("", 204)

# --- ML model paths ----------------------------------------------------------
CNN_MODEL_PATH = Path(
    os.environ.get(
        "CNN_MODEL_PATH",
        str(BASE_DIR / "CNN Model" / "best_finetuned_model.keras"),
    )
)
XGB_MODEL_PATH = Path(
    os.environ.get(
        "XGB_MODEL_PATH",
        str(BASE_DIR / "XGBoost Model" / "xgboost_pcos_model_v5.pkl"),
    )
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
DB_POOL_SIZE = max(1, int(_env("DB_POOL_SIZE", default="5")))

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
        connect_timeout=10,
        read_timeout=30,
        write_timeout=30,
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
    "Cycle_length": "Cycle_length_days",
    "Marriage_duration": "Marriage_Status_years",
    "Pregnant_status": "Pregnant",
    "No_abortions": "No_of_abortions",
    "I_Beta_HCG": "I_beta_HCG_mIU_mL",
    "II_Beta_HCG": "II_beta_HCG_mIU_mL",
    "FSH_level": "FSH_mIU_mL",
    "LH_level": "LH_mIU_mL",
    "AMH_level": "AMH_ng_mL",
    "TSH_level": "TSH_mIU_L",
    "PRL_level": "PRL_ng_mL",
    "Vitamin_D3_level": "Vit_D3_ng_mL",
    "Progesterone_level": "PRG_ng_mL",
    "RBS": "RBS_mg_dl",
    "Hemoglobin": "Hb_g_dl",
    "Pulse_rate": "Pulse_rate_bpm",
    "RR_breath": "RR_breath_min",
    "BP_systolic": "BP_Systolic_mmHg",
    "BP_diastolic": "BP_Diastolic_mmHg",
    "Avg_F_size_L": "Avg_F_size_L_mm",
    "Avg_F_size_R": "Avg_F_size_R_mm",
    "image": "Ultrasound_image",
    "image_base64": "Ultrasound_image",
}


def _json_error(message: str, status: int = 400, **extra: Any):
    body: dict[str, Any] = {"success": False, "error": message}
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
        normalized[column] = value
    return normalized


# =============================================================================
# Health
# =============================================================================
@app.get("/")
def root():
    return jsonify({"status": "API is running", "success": True}), 200


@app.get("/health")
def health_alias():
    return jsonify({"status": "API is running", "success": True}), 200


@app.get("/api/health")
def api_health():
    """Verify Flask process + Clever Cloud MySQL connectivity."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                row = cur.fetchone()
        if not row or int(row.get("ok", 0)) != 1:
            return _json_error("Database ping failed", 500, status="degraded", database="error")
        return jsonify({"status": "online", "database": "connected", "success": True}), 200
    except Exception as exc:  # noqa: BLE001
        logger.exception("Health check DB failure")
        return (
            jsonify(
                {
                    "success": False,
                    "status": "degraded",
                    "database": "disconnected",
                    "error": str(exc),
                }
            ),
            500,
        )


# --- Auth / JWT (PHP-compatible shape) --------------------------------------
JWT_SECRET = _env("JWT_SECRET", "PCODE_JWT_SECRET", default="pcode-dev-secret-change-me")
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
        _hmac.new(JWT_SECRET.encode("utf-8"), f"{header}.{payload}".encode("utf-8"), hashlib.sha256).digest()
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
    token = generate_jwt(
        {
            "id": uid,
            "email": email,
            "name": name,
            "role": role,
            "auth_source": auth_source,
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
            "is_active": True,
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
@app.post("/api/login")
@app.post("/api/login.php")
def api_login():
    """
    POST JSON: { email, password, expectedAccess?: "provider"|"community" }
    Password may be plaintext or SHA-256 hex digest (matches PHP/JS helper).
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Request body must be JSON", 400)

    email = str(payload.get("email") or "").strip()
    password = str(payload.get("password") or "").strip()
    expected = str(payload.get("expectedAccess") or "").strip().lower()

    if not email or not password:
        return _json_error("Email and password are required", 400)

    if "@" not in email or "." not in email.split("@")[-1]:
        return _json_error("Invalid email format", 400)

    if not _password_is_sha256_digest(password) and len(password) < 8:
        return _json_error("Invalid email or password", 401)

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # Provider portal → clinical_providers
                if expected == "provider" or expected == "":
                    cur.execute(
                        """
                        SELECT id, email, password, user_name, role, institution, avatar, is_active
                        FROM clinical_providers
                        WHERE email = %s
                        LIMIT 1
                        """,
                        (email,),
                    )
                    provider = cur.fetchone()
                    if provider and int(provider.get("is_active") or 0) == 1:
                        stored = str(provider.get("password") or "")
                        if verify_provider_password(password, stored):
                            if expected in ("", "provider"):
                                return jsonify(
                                    _auth_success_payload(
                                        {
                                            "id": int(provider["id"]),
                                            "email": provider.get("email") or email,
                                            "name": provider.get("user_name") or "",
                                            "role": provider.get("role") or "Ob-Gyn",
                                            "institution": provider.get("institution") or "",
                                            "avatar": provider.get("avatar") or "",
                                        },
                                        "clinical_providers",
                                    )
                                ), 200
                    if expected == "provider":
                        return _json_error("Invalid email or password", 401)

                # Community / default → users
                cur.execute(
                    """
                    SELECT user_id, user_name, email, password, role, institution, avatar
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
        return _json_error("Invalid email or password", 401)

    stored = str(row.get("password") or "")
    if not verify_provider_password(password, stored):
        return _json_error("Invalid email or password", 401)

    role = str(row.get("role") or "Regular User")
    if expected == "community" and role.lower() not in ("regular user", "patient", "user"):
        return _json_error("This account cannot access the Regular User portal", 403)
    if expected == "provider":
        return _json_error("Invalid email or password", 401)

    return jsonify(
        _auth_success_payload(
            {
                "id": int(row["user_id"]),
                "email": row.get("email") or email,
                "name": row.get("user_name") or "",
                "role": role,
                "institution": row.get("institution") or "",
                "avatar": row.get("avatar") or "",
            },
            "users",
        )
    ), 200


@app.post("/api/auth/google")
@app.post("/api/auth/google_callback.php")
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
                    if not provider or int(provider.get("is_active") or 0) != 1:
                        return _json_error(
                            "This Google account is not authorized for the OB-GYN portal",
                            403,
                        )
                    if picture:
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

                # Community / unspecified — prefer users, else clinical_providers
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
                            bcrypt.hashpw(
                                _password_to_digest(os.urandom(16).hex()).encode("utf-8"),
                                bcrypt.gensalt(),
                            ).decode("utf-8"),
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
        JWT_SECRET.encode("utf-8"),
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


def _require_provider_auth() -> dict:
    auth_header = request.headers.get("Authorization") or ""
    token = auth_header or str(request.args.get("token") or "")
    try:
        decoded = decode_jwt(token)
    except ValueError as exc:
        raise PermissionError(str(exc)) from exc
    uid = int(decoded.get("id") or 0)
    if uid <= 0:
        raise PermissionError("Invalid auth token")
    source = str(decoded.get("auth_source") or "")
    role = str(decoded.get("role") or "").lower()
    if source == "users" and role in ("regular user", "patient", "user", "guest"):
        raise PermissionError("OB-GYN provider access required")
    if bool(decoded.get("isGuest")):
        raise PermissionError("Guest users cannot access provider patient records")
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


def _format_ultrasound(value: Any) -> Any:
    if value is None or value == "":
        return None
    if isinstance(value, str) and value.startswith("data:image"):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "data:image/jpeg;base64," + base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, str):
        return value if value.startswith("data:") else "data:image/jpeg;base64," + value
    return None


_PATIENT_PARAM_FIELDS = (
    "Age_yrs", "Weight_kg", "Height_cm", "BMI", "Blood_Group", "Pulse_rate_bpm", "RR_breath_min",
    "Hb_g_dl", "CycleR_I", "Cycle_length_days", "Marriage_Status_years", "Pregnant", "No_of_abortions",
    "I_beta_HCG_mIU_mL", "II_beta_HCG_mIU_mL", "FSH_mIU_mL", "LH_mIU_mL", "FSH_LH", "Hip_inch",
    "Waist_inch", "Waist_hip_ratio", "TSH_mIU_L", "AMH_ng_mL", "PRL_ng_mL", "Vit_D3_ng_mL",
    "PRG_ng_mL", "RBS_mg_dl", "Weight_gain", "Hair_growth", "Skin_darkening", "Hair_loss",
    "Pimples", "Fast_food", "Reg_Exercise", "Follicle_no_L", "Follicle_no_R",
    "Avg_F_size_L_mm", "Avg_F_size_R_mm", "Endometrium_mm", "Ultrasound_image",
)


@app.get("/api/patients/get_patients_list")
@app.get("/api/patients/get_patients_list.php")
def api_get_patients_list():
    """Provider patient dashboard grid — mirrors PHP get_patients_list.php shape."""
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
                cur.execute(
                    """
                    SELECT
                        p.patient_id,
                        p.patient_name,
                        p.age,
                        p.date_of_birth,
                        p.contact_no,
                        p.civil_status,
                        p.address,
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
                    last_tested_display = None
                    if isinstance(last_screened, datetime):
                        last_tested_display = last_screened.strftime("%b %d, %Y · %I:%M %p")
                    elif last_screened_iso:
                        last_tested_display = str(last_screened_iso)

                    formatted: dict[str, Any] = {
                        "id": f"PMOS-{pid:03d}",
                        "patient_id": pid,
                        "name": row.get("patient_name"),
                        "age": int(row.get("age") or 0),
                        "date_added": row.get("date_added"),
                        "address": row.get("address"),
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
                        else:
                            formatted[field] = _serialize_value(val)

                    patients.append(formatted)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Patient list failed")
        return _json_error("Failed to load patients", 500, detail=str(exc))

    return jsonify({"success": True, "data": patients, "count": len(patients)}), 200


@app.post("/api/delete_patient")
@app.post("/api/delete_patient.php")
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


@app.post("/api/save_patient")
@app.post("/api/save_patient.php")
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

    name = str(data.get("patient_name") or data.get("name") or "").strip()
    age = data.get("Age_yrs")
    try:
        age = int(age) if age not in (None, "") else None
    except (TypeError, ValueError):
        age = None
    dob = data.get("DOB") or data.get("date_of_birth") or None
    contact = data.get("contact_no")
    address = data.get("address") or ""
    civil_status = data.get("civil_status") or ""
    occupation = data.get("occupation") or ""
    religion = data.get("religion") or ""
    referred_by = data.get("referred_by") or ""
    has_recs = "clinical_recommendations" in data
    clinical_recommendations = (
        str(data.get("clinical_recommendations") or "").strip() if has_recs else ""
    )

    has_personal = bool(
        name
        or age is not None
        or dob
        or contact
        or str(address).strip()
        or str(civil_status).strip()
        or str(occupation).strip()
        or str(religion).strip()
        or str(referred_by).strip()
        or has_recs
    )

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                _ensure_owner_provider_column(cur)
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
                        if has_recs:
                            cur.execute(
                                """
                                UPDATE patient_personal_info
                                SET patient_name=%s, age=%s, date_of_birth=%s, contact_no=%s,
                                    address=%s, civil_status=%s, occupation=%s, religion=%s,
                                    reffered_by=%s, clinical_recommendations=%s
                                WHERE patient_id=%s AND owner_provider_id=%s
                                """,
                                (
                                    name, age, dob, contact, address, civil_status, occupation,
                                    religion, referred_by, clinical_recommendations,
                                    patient_id, provider_id,
                                ),
                            )
                        else:
                            cur.execute(
                                """
                                UPDATE patient_personal_info
                                SET patient_name=%s, age=%s, date_of_birth=%s, contact_no=%s,
                                    address=%s, civil_status=%s, occupation=%s, religion=%s,
                                    reffered_by=%s
                                WHERE patient_id=%s AND owner_provider_id=%s
                                """,
                                (
                                    name, age, dob, contact, address, civil_status, occupation,
                                    religion, referred_by, patient_id, provider_id,
                                ),
                            )
                    else:
                        cur.execute(
                            """
                            INSERT INTO patient_personal_info
                            (patient_name, age, date_of_birth, contact_no, address, civil_status,
                             occupation, religion, reffered_by, clinical_recommendations, owner_provider_id)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                            """,
                            (
                                name, age, dob, contact, address, civil_status, occupation,
                                religion, referred_by, clinical_recommendations, provider_id,
                            ),
                        )
                        patient_id = int(cur.lastrowid)

                # Draft clinical parameters upsert
                clinical = _normalize_diagnosis_payload(data)
                clinical.pop("patient_id", None)
                clinical.pop("screening_id", None)
                if clinical:
                    clinical["patient_id"] = patient_id
                    clinical.setdefault("created_by", "Physician")
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
                    if draft:
                        cols = [c for c in DIAGNOSIS_INSERT_COLUMNS if c in clinical and c != "patient_id"]
                        if cols:
                            sets = ", ".join(f"`{c}`=%s" for c in cols)
                            vals = [clinical[c] for c in cols] + [int(draft["parameter_id"])]
                            cur.execute(
                                f"UPDATE patient_diagnosis_parameters SET {sets} WHERE parameter_id=%s",
                                vals,
                            )
                    else:
                        cols = [c for c in DIAGNOSIS_INSERT_COLUMNS if c in clinical]
                        if "patient_id" not in cols:
                            cols = ["patient_id"] + cols
                            clinical["patient_id"] = patient_id
                        placeholders = ", ".join(["%s"] * len(cols))
                        column_sql = ", ".join(f"`{c}`" for c in cols)
                        cur.execute(
                            f"INSERT INTO patient_diagnosis_parameters ({column_sql}) VALUES ({placeholders})",
                            [clinical[c] for c in cols],
                        )
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
@app.post("/api/patients/diagnosis")
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
# ML inference (existing Render endpoints)
# =============================================================================
@app.post("/predict-cnn")
def predict_cnn():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _json_error("Request body must be JSON")

    if not CNN_MODEL_PATH.is_file():
        return _json_error(
            f"CNN model not found at {CNN_MODEL_PATH}. "
            "Upload best_finetuned_model.keras or set CNN_MODEL_PATH.",
            503,
        )

    try:
        image_bytes = _decode_image_payload(payload)
    except ValueError as exc:
        return _json_error(str(exc))

    generate_gradcam = bool(payload.get("generate_gradcam", False))
    apply_smoothing = payload.get("apply_smoothing", True)
    if isinstance(apply_smoothing, str):
        apply_smoothing = apply_smoothing.lower() not in ("false", "0", "no")
    else:
        apply_smoothing = bool(apply_smoothing)

    try:
        smoothing_factor = float(payload.get("smoothing_factor", 0.90))
    except (TypeError, ValueError):
        smoothing_factor = 0.90
    smoothing_factor = max(0.50, min(0.95, smoothing_factor))
    user_mode = str(payload.get("user_mode") or "")

    try:
        cnn = _load_cnn()
    except Exception as exc:  # noqa: BLE001
        logger.exception("CNN module failed to load")
        return _json_error(f"CNN model runtime unavailable: {exc}", 503)

    result = cnn.predict(
        image_bytes,
        str(CNN_MODEL_PATH),
        generate_gradcam=generate_gradcam,
        apply_smoothing=apply_smoothing,
        smoothing_factor=smoothing_factor,
        user_mode=user_mode,
    )
    status = 200 if result.get("success") else 500
    return jsonify(result), status


@app.post("/predict-xgboost")
def predict_xgboost():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not payload:
        return _json_error("Request body must be a non-empty JSON object of clinical fields")

    if not XGB_MODEL_PATH.is_file():
        return _json_error(
            f"XGBoost model not found at {XGB_MODEL_PATH}. "
            "Upload xgboost_pcos_model_v5.pkl or set XGB_MODEL_PATH.",
            503,
        )

    clinical = dict(payload)
    smoothing_factor = 1.0
    if "smoothing_factor" in clinical:
        try:
            smoothing_factor = float(clinical.pop("smoothing_factor"))
        except (TypeError, ValueError):
            smoothing_factor = 1.0
        smoothing_factor = max(0.50, min(1.0, smoothing_factor))

    for key in ("generate_gradcam", "apply_smoothing", "user_mode", "image", "image_base64"):
        clinical.pop(key, None)

    cycle = clinical.get("Cycle_R_I")
    if isinstance(cycle, str):
        c = cycle.strip().lower()
        if c == "regular":
            clinical["Cycle_R_I"] = 1
        elif c in ("irregular", "amenorrhea"):
            clinical["Cycle_R_I"] = 0

    try:
        xgb = _load_xgb()
    except Exception as exc:  # noqa: BLE001
        logger.exception("XGBoost module failed to load")
        return _json_error(f"XGBoost model runtime unavailable: {exc}", 503)

    result = xgb.predict(
        clinical,
        str(XGB_MODEL_PATH),
        smoothing_factor=smoothing_factor,
    )
    result = xgb.convert_to_python_types(result)
    status = 200 if result.get("success") else 500
    return jsonify(result), status


@app.post("/predict-cnn-gradcam")
def predict_cnn_gradcam():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        payload = {}
    payload = dict(payload)
    payload["generate_gradcam"] = True

    if not CNN_MODEL_PATH.is_file():
        return _json_error(f"CNN model not found at {CNN_MODEL_PATH}", 503)
    try:
        image_bytes = _decode_image_payload(payload)
    except ValueError as exc:
        return _json_error(str(exc))
    try:
        smoothing_factor = float(payload.get("smoothing_factor", 0.90))
    except (TypeError, ValueError):
        smoothing_factor = 0.90
    try:
        cnn = _load_cnn()
    except Exception as exc:  # noqa: BLE001
        logger.exception("CNN module failed to load")
        return _json_error(f"CNN model runtime unavailable: {exc}", 503)
    result = cnn.predict(
        image_bytes,
        str(CNN_MODEL_PATH),
        generate_gradcam=True,
        apply_smoothing=bool(payload.get("apply_smoothing", True)),
        smoothing_factor=max(0.50, min(0.95, smoothing_factor)),
        user_mode=str(payload.get("user_mode") or ""),
    )
    return jsonify(result), (200 if result.get("success") else 500)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
