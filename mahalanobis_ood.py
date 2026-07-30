"""
Mahalanobis OOD helpers for CNN imaging reliability (no TensorFlow).

Loads:
  - CNN Model/mahalanobis_mu.pkl
  - CNN Model/mahalanobis_inv_cov.pkl

Used by the hosted TFLite path (cnn_tflite) and compatible with cnn_predict payloads.
"""

from __future__ import annotations

import pickle
from io import BytesIO
from pathlib import Path
from typing import Any, Optional, Tuple

import numpy as np

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "CNN Model"

_MU_CACHE: Any = None
_INV_CACHE: Any = None
_META_CACHE: Optional[dict] = None
_LOAD_ATTEMPTED = False


def _find_ci(directory: Path, name: str) -> Optional[Path]:
    try:
        target = name.lower()
        for p in directory.iterdir():
            if p.is_file() and p.name.lower() == target:
                return p
    except Exception:
        return None
    return None


def try_load_mahalanobis_params(
    *,
    force_reload: bool = False,
) -> Tuple[Any, Any, dict]:
    """
    Load mean vector + inverse covariance for Mahalanobis distance.

    Returns (mu, inv_cov, meta). mu/inv_cov are None when unavailable.
    """
    global _MU_CACHE, _INV_CACHE, _META_CACHE, _LOAD_ATTEMPTED

    if _LOAD_ATTEMPTED and not force_reload:
        return _MU_CACHE, _INV_CACHE, dict(_META_CACHE or {})

    _LOAD_ATTEMPTED = True
    search_dirs = [BASE_DIR, MODEL_DIR]
    mu_path = _find_ci(search_dirs[0], "mahalanobis_mu.pkl") or _find_ci(
        search_dirs[1], "mahalanobis_mu.pkl"
    )
    inv_path = _find_ci(search_dirs[0], "mahalanobis_inv_cov.pkl") or _find_ci(
        search_dirs[1], "mahalanobis_inv_cov.pkl"
    )
    meta: dict = {
        "searched_dirs": [str(d) for d in search_dirs],
        "mu_found": str(mu_path) if mu_path else None,
        "inv_cov_found": str(inv_path) if inv_path else None,
    }
    if not mu_path or not inv_path:
        _MU_CACHE, _INV_CACHE, _META_CACHE = None, None, meta
        return None, None, meta

    try:
        try:
            import joblib  # type: ignore

            mu = joblib.load(mu_path)
            inv_cov = joblib.load(inv_path)
            meta["loader"] = "joblib"
        except Exception as e_joblib:
            meta["joblib_error"] = repr(e_joblib)
            with open(mu_path, "rb") as f:
                mu = pickle.load(f)
            with open(inv_path, "rb") as f:
                inv_cov = pickle.load(f)
            meta["loader"] = "pickle"

        mu = np.asarray(mu, dtype=np.float64).reshape(-1)
        inv_cov = np.asarray(inv_cov, dtype=np.float64)
        meta["loaded"] = True
        meta["feature_dim"] = int(mu.shape[0])
        _MU_CACHE, _INV_CACHE, _META_CACHE = mu, inv_cov, meta
        return mu, inv_cov, meta
    except Exception as exc:  # noqa: BLE001
        meta.update({"loaded": False, "error": repr(exc)})
        _MU_CACHE, _INV_CACHE, _META_CACHE = None, None, meta
        return None, None, meta


def mahalanobis_params_available() -> bool:
    mu, inv_cov, _ = try_load_mahalanobis_params()
    return mu is not None and inv_cov is not None


def mahalanobis_distance(x, mu, inv_cov) -> float:
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    d = x - mu
    return float(d.T @ inv_cov @ d)


def mahalanobis_reliability(dist, df, alpha: float = 0.999):
    """
    Reliable if squared Mahalanobis distance is within chi-square upper bound.
    Returns (reliable, lower_thr, upper_thr, p_value).
    """
    try:
        from scipy.stats import chi2

        dist = float(dist)
        a = float(alpha)
        a = max(0.90, min(0.9999, a))
        upper = float(chi2.ppf(a, df))
        p_value = float(1.0 - chi2.cdf(dist, df))
        return bool(dist <= upper), None, upper, p_value
    except Exception:
        dist = float(dist)
        upper = float(df * 3.0)
        return bool(dist <= upper), None, upper, None


def score_features(features, mu=None, inv_cov=None, meta=None) -> dict:
    """Build a cnn_predict-compatible ``mahalanobis`` result dict from a feature vector."""
    if mu is None or inv_cov is None:
        mu, inv_cov, meta = try_load_mahalanobis_params()
    meta = dict(meta or {})
    if mu is None or inv_cov is None:
        return {"available": False, "meta": meta}

    try:
        x = np.asarray(features, dtype=np.float64).reshape(-1)
        expected_dim = int(np.asarray(mu).reshape(-1).shape[0])
        if x.shape[0] != expected_dim:
            return {
                "distance": None,
                "feature_dim": expected_dim,
                "threshold": None,
                "p_value": None,
                "reliable": False,
                "anomaly_detected": True,
                "available": True,
                "reason": "feature_dim_mismatch",
                "meta": {
                    **meta,
                    "features_dim": int(x.shape[0]),
                    "expected_dim": expected_dim,
                },
            }

        dist = mahalanobis_distance(x, mu, inv_cov)
        reliable, _lo, upper, p_value = mahalanobis_reliability(
            dist, expected_dim, alpha=0.999
        )
        return {
            "distance": dist,
            "feature_dim": expected_dim,
            "threshold": upper,
            "p_value": p_value,
            "reliable": bool(reliable),
            "anomaly_detected": not bool(reliable),
            "available": True,
            "meta": meta,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "meta": {**meta, "score_error": repr(exc)},
        }


def _image_colorfulness_rgb(img_rgb) -> float:
    try:
        arr = np.asarray(img_rgb, dtype=np.float32)
        if arr.ndim != 3 or arr.shape[2] != 3:
            return 0.0
        r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
        rg = np.abs(r - g)
        yb = np.abs(0.5 * (r + g) - b)
        return float(
            np.sqrt(np.std(rg) ** 2 + np.std(yb) ** 2)
            + 0.3 * np.sqrt(np.mean(rg) ** 2 + np.mean(yb) ** 2)
        )
    except Exception:
        return 0.0


def ultrasound_likeness_check(image_bytes: bytes) -> dict:
    """Same heuristic gate used by cnn_predict (Pillow + numpy only)."""
    try:
        from PIL import Image

        img = Image.open(BytesIO(image_bytes))
        if img.mode != "RGB":
            img = img.convert("RGB")
        img_small = img.resize((224, 224))
        colorfulness = _image_colorfulness_rgb(img_small)
        arr = np.asarray(img_small, dtype=np.float32) / 255.0
        r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
        channel_spread = float(np.mean(np.abs(r - g) + np.abs(r - b) + np.abs(g - b)) / 3.0)
        luminance = 0.299 * r + 0.587 * g + 0.114 * b
        mean_luma = float(np.mean(luminance))
        bright_frac = float(np.mean(luminance > 0.78))
        very_bright_frac = float(np.mean(luminance > 0.90))
        dark_frac = float(np.mean(luminance < 0.25))
        gy = np.abs(np.diff(luminance, axis=0))
        gx = np.abs(np.diff(luminance, axis=1))
        edge_mean = float((np.mean(gx) + np.mean(gy)) / 2.0)
        sharp_edge_frac = float((np.mean(gx > 0.18) + np.mean(gy > 0.18)) / 2.0)

        ok = True
        reasons = []
        if colorfulness > 18.0:
            ok = False
            reasons.append("too_colorful")
        if channel_spread > 0.08:
            ok = False
            reasons.append("high_channel_spread")
        if mean_luma > 0.58:
            ok = False
            reasons.append("too_bright")
        if bright_frac > 0.42:
            ok = False
            reasons.append("large_bright_regions")
        if very_bright_frac > 0.22 and dark_frac < 0.20:
            ok = False
            reasons.append("document_like_background")
        if mean_luma > 0.45 and sharp_edge_frac > 0.08 and dark_frac < 0.25:
            ok = False
            reasons.append("document_like_edges")
        if dark_frac < 0.08 and mean_luma > 0.50:
            ok = False
            reasons.append("missing_dark_field")

        return {
            "ok": bool(ok),
            "colorfulness": float(colorfulness),
            "channel_spread": float(channel_spread),
            "mean_luminance": mean_luma,
            "bright_fraction": bright_frac,
            "very_bright_fraction": very_bright_frac,
            "dark_fraction": dark_frac,
            "edge_mean": edge_mean,
            "sharp_edge_fraction": sharp_edge_frac,
            "reasons": reasons,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "reasons": ["validation_error"],
            "error": str(exc),
        }


def _ultrasound_validation_message(us_check: dict) -> str:
    if us_check.get("ok", False):
        return "The system confirmed this image as a pelvic ultrasound scan."
    reasons = list(us_check.get("reasons") or [])
    if "too_colorful" in reasons:
        detail = "The upload appears too colorful for a typical grayscale ultrasound frame."
    elif "high_channel_spread" in reasons:
        detail = "Color variation is higher than expected for ultrasound imaging."
    elif any(
        r in reasons
        for r in (
            "too_bright",
            "large_bright_regions",
            "document_like_background",
            "document_like_edges",
            "missing_dark_field",
        )
    ):
        detail = (
            "The upload looks more like a bright document or photo of paper "
            "than a dark-field pelvic ultrasound scan."
        )
    elif "validation_error" in reasons:
        detail = "The system could not complete ultrasound-likeness checks for this file."
    else:
        detail = "The upload does not match expected pelvic ultrasound visual characteristics."
    return (
        "The system could not confirm this image as a valid pelvic ultrasound scan. "
        + detail
        + " CNN imaging results may be unreliable."
    )


def image_validation_payload(us_check: dict, maha_result=None) -> dict:
    """Combined Mahalanobis + ultrasound-likeness validation (frontend-compatible)."""
    us_ok = bool(us_check.get("ok", False))
    reasons = []
    message_parts = []
    maha_available = isinstance(maha_result, dict) and maha_result.get("available") is True
    maha_reliable = None
    mahalanobis_anomaly = False

    if maha_available:
        maha_reliable = bool(maha_result.get("reliable"))
        if not maha_reliable:
            mahalanobis_anomaly = True
            reasons.append("mahalanobis_anomaly")
            message_parts.append(
                "The system could not confirm this image as a valid pelvic ultrasound scan. "
                "CNN imaging results may be unreliable."
            )

    if not us_ok:
        reasons.extend(list(us_check.get("reasons") or []))
        if not message_parts:
            message_parts.append(_ultrasound_validation_message(us_check))

    passed = (not mahalanobis_anomaly) and us_ok
    if passed:
        message = "The system confirmed this image as a pelvic ultrasound scan."
    else:
        message = (
            " ".join(message_parts)
            if message_parts
            else "The system could not confirm this image as a valid pelvic ultrasound scan."
        )

    payload = {
        "is_ultrasound": us_ok,
        "anomaly_passed": passed,
        "passed": passed,
        "anomaly_detected": mahalanobis_anomaly or (not us_ok),
        "method": (
            "mahalanobis_and_ultrasound_likeness"
            if maha_available
            else "ultrasound_likeness_heuristic"
        ),
        "mahalanobis_reliable": maha_reliable,
        "ultrasound_likeness_ok": us_ok,
        "reasons": reasons,
        "message": message,
        "metrics": {
            "colorfulness": us_check.get("colorfulness"),
            "channel_spread": us_check.get("channel_spread"),
            "mean_luminance": us_check.get("mean_luminance"),
            "bright_fraction": us_check.get("bright_fraction"),
            "dark_fraction": us_check.get("dark_fraction"),
            "sharp_edge_fraction": us_check.get("sharp_edge_fraction"),
        },
    }
    if maha_available:
        if maha_result.get("distance") is not None:
            payload["mahalanobis_distance"] = maha_result.get("distance")
        if maha_result.get("threshold") is not None:
            payload["mahalanobis_threshold"] = maha_result.get("threshold")
        if maha_result.get("p_value") is not None:
            payload["mahalanobis_p_value"] = maha_result.get("p_value")
    return payload
