"""
P-Code ML REST API — Flask service for Render.com
Serves CNN + XGBoost inference for a Firebase Hosting frontend.
"""
from __future__ import annotations

import base64
import os
import re
import sys
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS

# Ensure project root is on sys.path so cnn_predict / xgboost_predict import cleanly
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import cnn_predict  # noqa: E402
import xgboost_predict  # noqa: E402

app = Flask(__name__)

# --- CORS (Firebase Hosting + optional extras via CORS_ORIGINS) ----------------
_default_origin_patterns = [
    r"^https://.*\.web\.app$",
    r"^https://.*\.firebaseapp.com$",
    r"^http://localhost(:\d+)?$",
    r"^http://127\.0\.0\.1(:\d+)?$",
]
_extra = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "").split(",")
    if o.strip()
]
# Exact origins from env + regex patterns for Firebase / local
CORS(
    app,
    resources={
        r"/*": {
            "origins": _extra + _default_origin_patterns,
            "methods": ["GET", "POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization"],
        }
    },
    supports_credentials=False,
)

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
    except Exception as exc:
        raise ValueError(f"Invalid base64 image data: {exc}") from exc


def _json_error(message: str, status: int = 400):
    return jsonify({"success": False, "error": message}), status


@app.get("/")
def health():
    return jsonify({"status": "API is running"})


@app.get("/health")
def health_alias():
    return jsonify({"status": "API is running"})


@app.post("/predict-cnn")
def predict_cnn():
    """
    Body JSON:
      {
        "image": "<base64 or data-URI>",
        "generate_gradcam": false,
        "apply_smoothing": true,
        "smoothing_factor": 0.90,
        "user_mode": ""
      }
    """
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

    result = cnn_predict.predict(
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
    """
    Body JSON: clinical feature map (same fields as api/predict_xgboost.php),
    optional "smoothing_factor" (0.50–1.0).
    """
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

    # Drop non-feature control keys if present
    for key in ("generate_gradcam", "apply_smoothing", "user_mode", "image", "image_base64"):
        clinical.pop(key, None)

    # Cycle regularity string → numeric (mirrors PHP API)
    cycle = clinical.get("Cycle_R_I")
    if isinstance(cycle, str):
        c = cycle.strip().lower()
        if c == "regular":
            clinical["Cycle_R_I"] = 1
        elif c in ("irregular", "amenorrhea"):
            clinical["Cycle_R_I"] = 0

    result = xgboost_predict.predict(
        clinical,
        str(XGB_MODEL_PATH),
        smoothing_factor=smoothing_factor,
    )
    result = xgboost_predict.convert_to_python_types(result)
    status = 200 if result.get("success") else 500
    return jsonify(result), status


@app.post("/predict-cnn-gradcam")
def predict_cnn_gradcam():
    """Convenience alias — same as /predict-cnn with generate_gradcam=true."""
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        payload = {}
    payload = dict(payload)
    payload["generate_gradcam"] = True
    # Re-use handler logic via internal call pattern
    with app.test_request_context(json=payload):
        # Fall through by mutating request — simpler to duplicate thin wrapper:
        pass
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
    result = cnn_predict.predict(
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
