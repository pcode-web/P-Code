"""
P-Code CNN → TFLite conversion + low-RAM inference
==================================================
Converts ``pcos_detection_modelv4.keras`` (MobileNetV2) to an optimized
``.tflite`` artifact for constrained hosts (e.g. ≤512 MB RAM).

Production inference dependencies (install only these on the server):
  - ai-edge-litert   # required on Render; supports FULLY_CONNECTED v12+
  - pillow
  - numpy

Do not install legacy ``tflite-runtime`` on the server — it fails on models
converted with TensorFlow ≥ 2.16 (FULLY_CONNECTED opcode v12).

Conversion (dev machine only) still needs full TensorFlow:
  - tensorflow
  - pillow / numpy (optional for smoke tests)

Note: converting with TensorFlow ≥ 2.16 often emits FULLY_CONNECTED v12.
Match the server interpreter (ai-edge-litert) or convert with TF ≤ 2.15.
Render should use Python 3.12 (see runtime.txt).

Usage
-----
  # Convert if .tflite is missing, then optionally smoke-test an image:
  python cnn_tflite.py
  python cnn_tflite.py --image path/to/ultrasound.jpg
  python cnn_tflite.py --convert-only
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Optional, Tuple, Union

# ---------------------------------------------------------------------------
# Paths (project-root / CNN Model / …)
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "CNN Model"
KERAS_MODEL_PATH = MODEL_DIR / "pcos_detection_modelv4.keras"
TFLITE_MODEL_PATH = MODEL_DIR / "pcos_detection_modelv4.tflite"

INPUT_SIZE = (224, 224)  # MobileNetV2 / P-Code CNN training size


# =============================================================================
# 1) CONVERSION LOGIC — development environment (full TensorFlow required)
# =============================================================================
def convert_keras_to_tflite(
    keras_path: Union[str, Path] = KERAS_MODEL_PATH,
    tflite_path: Union[str, Path] = TFLITE_MODEL_PATH,
    *,
    optimize: bool = True,
) -> Path:
    """
    Load a Keras ``.keras`` model and export an optimized TFLite flatbuffer.

    Uses ``tf.lite.Optimize.DEFAULT`` plus ``TFLITE_BUILTINS`` so the graph
    stays on standard Lite ops (no SELECT_TF_OPS).

    Important: op *versions* still follow the TensorFlow used to convert.
    TF 2.16+ often emits FULLY_CONNECTED v12. Match the server interpreter
    (``ai-edge-litert`` / recent TFLite) or convert with TensorFlow ≤ 2.15
    if you must stay on older ``tflite-runtime``.

    Returns
    -------
    Path
        Absolute path of the written ``.tflite`` file.
    """
    try:
        import tensorflow as tf  # heavy — only needed for conversion
    except ImportError as exc:
        raise ImportError(
            "Conversion requires full TensorFlow. "
            "Install with: pip install tensorflow"
        ) from exc

    keras_path = Path(keras_path).resolve()
    tflite_path = Path(tflite_path).resolve()

    if not keras_path.is_file():
        raise FileNotFoundError(f"Keras model not found: {keras_path}")

    tflite_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"[convert] Loading Keras model: {keras_path}")
    print(f"[convert] TensorFlow {tf.__version__}")
    model = tf.keras.models.load_model(keras_path, compile=False)

    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    # Restrict to widely supported standard TFLite ops (no Flex / SELECT_TF_OPS).
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS]
    converter.allow_custom_ops = False
    if optimize:
        # DEFAULT ≈ weight quantization (dynamic range / FP16-friendly path).
        # Keeps float I/O so preprocess stays simple (0–1 float32).
        converter.optimizations = [tf.lite.Optimize.DEFAULT]

    print("[convert] Converting with TFLITE_BUILTINS + Optimize.DEFAULT …")
    tflite_bytes = converter.convert()

    tflite_path.write_bytes(tflite_bytes)

    keras_size = keras_path.stat().st_size
    tflite_size = tflite_path.stat().st_size
    ratio = (100.0 * tflite_size / keras_size) if keras_size else 0.0

    def _mb(n: int) -> str:
        return f"{n / (1024 * 1024):.2f} MB"

    print("[convert] Done.")
    print(f"  Keras  : {_mb(keras_size)}  ({keras_path.name})")
    print(f"  TFLite : {_mb(tflite_size)}  ({tflite_path.name})")
    print(f"  Ratio  : {ratio:.1f}% of original size")
    if tuple(int(x) for x in tf.__version__.split(".")[:2]) >= (2, 16):
        print(
            "[convert] Note: TF ≥ 2.16 may emit FULLY_CONNECTED v12. "
            "Use ai-edge-litert (or TF ≥ 2.17 Lite) on the server, "
            "or reconvert with TensorFlow 2.15 for older tflite-runtime."
        )

    # Free Keras graph ASAP so conversion doesn't leave a large footprint.
    del model
    try:
        tf.keras.backend.clear_session()
    except Exception:  # noqa: BLE001
        pass

    return tflite_path


# =============================================================================
# 2) LIGHTWEIGHT INFERENCE — production (prefer LiteRT)
# =============================================================================
def _interpreter_candidates():
    """
    Yield (name, Interpreter) backends in preference order.
    Legacy ``tflite_runtime`` is last — it often lacks FULLY_CONNECTED v12.
    """
    tried = []

    try:
        from ai_edge_litert.interpreter import Interpreter  # type: ignore

        yield "ai_edge_litert", Interpreter
        tried.append("ai_edge_litert")
    except ImportError:
        pass

    try:
        from tensorflow.lite import Interpreter  # type: ignore

        yield "tensorflow.lite", Interpreter
        tried.append("tensorflow.lite")
    except ImportError:
        pass

    try:
        from tensorflow.lite.python.interpreter import Interpreter  # type: ignore

        yield "tensorflow.lite.python", Interpreter
        tried.append("tensorflow.lite.python")
    except ImportError:
        pass

    try:
        from tflite_runtime.interpreter import Interpreter  # type: ignore

        yield "tflite_runtime", Interpreter
        tried.append("tflite_runtime")
    except ImportError:
        pass

    if not tried:
        raise ImportError(
            "No TFLite/LiteRT Interpreter found. On the production server install:\n"
            "  pip install 'ai-edge-litert>=1.2.0' pillow numpy\n"
            "(Render must use Python 3.9–3.12; see runtime.txt)"
        )


def _load_interpreter_api():
    """Return the first available Interpreter class (prefer LiteRT)."""
    for _name, Interpreter in _interpreter_candidates():
        return Interpreter
    raise ImportError("No TFLite Interpreter available")


_INTERPRETER: Any = None
_INPUT_DETAILS: Any = None
_OUTPUT_DETAILS: Any = None
_INTERPRETER_BACKEND: str = ""
_INTERPRETER_PRESERVE_TENSORS: bool = False
_GAP_FEATURE_INDEX: Optional[int] = None


def load_tflite_interpreter(
    tflite_path: Union[str, Path] = TFLITE_MODEL_PATH,
    *,
    num_threads: int = 1,
    preserve_all_tensors: Optional[bool] = None,
) -> Any:
    """
    Create (or reuse) a single TFLite Interpreter.

    Tries LiteRT first, then TensorFlow Lite, then legacy tflite-runtime.
    ``num_threads=1`` keeps RAM/CPU predictable on small VMs.

    When Mahalanobis params are present, ``preserve_all_tensors=True`` so the
    MobileNetV2 global-average-pooling (1280-d) activations can be read for OOD.
    """
    global _INTERPRETER, _INPUT_DETAILS, _OUTPUT_DETAILS, _INTERPRETER_BACKEND
    global _INTERPRETER_PRESERVE_TENSORS, _GAP_FEATURE_INDEX

    tflite_path = Path(tflite_path).resolve()
    if not tflite_path.is_file():
        raise FileNotFoundError(
            f"TFLite model not found: {tflite_path}. "
            "Run conversion first (python cnn_tflite.py)."
        )

    if preserve_all_tensors is None:
        try:
            from mahalanobis_ood import mahalanobis_params_available

            preserve_all_tensors = bool(mahalanobis_params_available())
        except Exception:
            preserve_all_tensors = False

    if _INTERPRETER is not None and bool(preserve_all_tensors) == bool(
        _INTERPRETER_PRESERVE_TENSORS
    ):
        return _INTERPRETER

    # Reload if preserve flag changed (needed to expose GAP features).
    _INTERPRETER = None
    _INPUT_DETAILS = None
    _OUTPUT_DETAILS = None
    _GAP_FEATURE_INDEX = None

    errors: list[str] = []
    for name, Interpreter in _interpreter_candidates():
        try:
            kwargs: dict = {
                "model_path": str(tflite_path),
                "num_threads": max(1, int(num_threads)),
            }
            if preserve_all_tensors:
                kwargs["experimental_preserve_all_tensors"] = True
            try:
                interpreter = Interpreter(**kwargs)
            except TypeError:
                # Older Interpreter APIs may not accept num_threads / preserve flag.
                try:
                    interpreter = Interpreter(
                        model_path=str(tflite_path),
                        experimental_preserve_all_tensors=bool(preserve_all_tensors),
                    )
                except TypeError:
                    interpreter = Interpreter(model_path=str(tflite_path))
                    preserve_all_tensors = False
            interpreter.allocate_tensors()
            _INTERPRETER = interpreter
            _INPUT_DETAILS = interpreter.get_input_details()
            _OUTPUT_DETAILS = interpreter.get_output_details()
            _INTERPRETER_BACKEND = name
            _INTERPRETER_PRESERVE_TENSORS = bool(preserve_all_tensors)
            _GAP_FEATURE_INDEX = _find_gap_feature_index(interpreter)
            print(
                f"[cnn_tflite] Using interpreter backend: {name}"
                f" (preserve_all_tensors={_INTERPRETER_PRESERVE_TENSORS},"
                f" gap_index={_GAP_FEATURE_INDEX})"
            )
            return interpreter
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {type(exc).__name__}: {exc}")

    raise RuntimeError(
        "Failed to load CNN TFLite model with any interpreter backend. "
        "Install ai-edge-litert on the server (Python 3.9–3.12). Details: "
        + " | ".join(errors)
    )


def _find_gap_feature_index(interpreter: Any) -> Optional[int]:
    """Locate MobileNetV2 GlobalAveragePooling2D tensor (prefer name match)."""
    import numpy as np

    preferred = None
    fallback = None
    for d in interpreter.get_tensor_details():
        name = str(d.get("name") or "").lower()
        shape = d.get("shape")
        try:
            dims = [int(x) for x in np.asarray(shape).tolist()] if shape is not None else []
        except Exception:
            dims = []
        looks_gap = (
            "global_average_pooling" in name
            or name.endswith("/mean")
            or "globalaveragepooling" in name.replace("_", "")
        )
        if looks_gap and dims in ([1, 1280], [1280]):
            preferred = int(d["index"])
            break
        if dims in ([1, 1280], [1280]) and fallback is None:
            # Skip obvious weight tensors (no batch dim and non-activation-looking names)
            if dims == [1280] and "convolution" in name:
                continue
            fallback = int(d["index"])
    return preferred if preferred is not None else fallback


def extract_gap_features(interpreter: Any, expected_dim: int = 1280) -> Optional[Any]:
    """
    Read 1280-d GAP features after ``interpreter.invoke()``.
    Requires ``experimental_preserve_all_tensors=True`` on LiteRT/TFLite.
    """
    import numpy as np

    global _GAP_FEATURE_INDEX
    expected_dim = int(expected_dim) if expected_dim else 1280

    indices: list[int] = []
    if _GAP_FEATURE_INDEX is not None:
        indices.append(int(_GAP_FEATURE_INDEX))
    else:
        found = _find_gap_feature_index(interpreter)
        if found is not None:
            _GAP_FEATURE_INDEX = found
            indices.append(found)

    # Last-resort scan for any live tensor of the expected feature size.
    for d in interpreter.get_tensor_details():
        try:
            indices.append(int(d["index"]))
        except Exception:
            continue

    seen = set()
    for idx in indices:
        if idx in seen:
            continue
        seen.add(idx)
        try:
            tensor = np.asarray(interpreter.get_tensor(idx), dtype=np.float64).reshape(-1)
        except Exception:
            continue
        if tensor.size == expected_dim:
            _GAP_FEATURE_INDEX = idx
            return tensor
    return None

def preprocess_image(
    image_path: Union[str, Path],
    *,
    target_size: Tuple[int, int] = INPUT_SIZE,
) -> "Any":
    """
    Load image → RGB → resize → float32 in [0, 1] → shape (1, H, W, 3).

    Production deps: pillow, numpy
    """
    from pathlib import Path as _Path

    image_path = _Path(image_path)
    if not image_path.is_file():
        raise FileNotFoundError(f"Image not found: {image_path}")
    with open(image_path, "rb") as fh:
        return preprocess_image_bytes(fh.read(), target_size=target_size)


def preprocess_image_bytes(
    image_bytes: bytes,
    *,
    target_size: Tuple[int, int] = INPUT_SIZE,
) -> "Any":
    """Decode raw image bytes → (1, H, W, 3) float32 in [0, 1]."""
    import numpy as np
    from io import BytesIO
    from PIL import Image

    if not image_bytes:
        raise ValueError("Empty image bytes")
    with Image.open(BytesIO(image_bytes)) as img:
        img = img.convert("RGB")
        img = img.resize(target_size, Image.Resampling.BILINEAR)
        arr = np.asarray(img, dtype=np.float32) / 255.0
    return np.expand_dims(arr, axis=0)


def _raw_positive_probability(
    x: "Any",
    tflite_path: Union[str, Path],
    *,
    return_features: bool = False,
    feature_dim: int = 1280,
) -> Tuple[float, list, Optional[Any]]:
    """Run interpreter; return (P(positive), raw_output_list, optional GAP features)."""
    import numpy as np

    interpreter = load_tflite_interpreter(
        tflite_path,
        preserve_all_tensors=True if return_features else None,
    )
    input_details = _INPUT_DETAILS
    output_details = _OUTPUT_DETAILS

    inp = input_details[0]
    expected_dtype = inp["dtype"]
    if x.dtype != expected_dtype:
        x = x.astype(expected_dtype)

    if expected_dtype in (np.uint8, np.int8):
        scale, zero_point = inp.get("quantization", (0.0, 0))
        if scale and scale > 0:
            x = (x / scale + zero_point).astype(expected_dtype)

    interpreter.set_tensor(inp["index"], x)
    interpreter.invoke()

    raw = interpreter.get_tensor(output_details[0]["index"])
    out = np.array(raw).reshape(-1).astype(np.float64)

    out_scale, out_zp = output_details[0].get("quantization", (0.0, 0))
    if out_scale and out_scale > 0 and output_details[0]["dtype"] in (np.uint8, np.int8):
        out = (out.astype(np.float64) - float(out_zp)) * float(out_scale)

    if out.size == 1:
        score = float(out[0])
        if score < 0.0 or score > 1.0:
            score = float(1.0 / (1.0 + np.exp(-score)))
        positive_prob = score
    else:
        if out.min() < 0 or out.max() > 1.0 or abs(out.sum() - 1.0) > 1e-3:
            e = np.exp(out - out.max())
            out = e / e.sum()
        positive_prob = float(out[-1])

    features = None
    if return_features:
        features = extract_gap_features(interpreter, expected_dim=feature_dim)

    return positive_prob, out.tolist(), features


def _to_percentage(
    prediction: float,
    *,
    apply_smoothing: bool = True,
    smoothing_factor: float = 0.90,
    confidence_cap: float = 0.98,
    min_floor: float = 0.02,
) -> float:
    """Match cnn_predict.convert_to_percentage calibration."""
    p = float(prediction)
    if apply_smoothing:
        try:
            sf = float(smoothing_factor)
        except (TypeError, ValueError):
            sf = 0.90
        sf = max(0.50, min(0.95, sf))
        p = 0.5 + sf * (p - 0.5)
    p = min(max(p, min_floor), confidence_cap)
    return max(0.0, min(100.0, p * 100.0))


def _classify(percentage: float) -> dict:
    p = float(percentage)
    if p <= 49:
        return {
            "classification": "Negative",
            "description": "PCOS not detected in image",
            "reliable": True,
            "threshold_pct": 75.0,
        }
    if p <= 74:
        return {
            "classification": "Borderline",
            "description": "Intermediate PCOS imaging signal",
            "reliable": True,
            "threshold_pct": 75.0,
        }
    return {
        "classification": "Positive",
        "description": "PCOS detected in image",
        "reliable": True,
        "threshold_pct": 75.0,
    }


def build_api_result(
    positive_prob: float,
    *,
    raw_output: Optional[list] = None,
    apply_smoothing: bool = True,
    smoothing_factor: float = 0.90,
    model_name: str = "pcos_detection_modelv4.tflite",
    generate_gradcam: bool = False,
    mahalanobis: Optional[dict] = None,
    image_validation: Optional[dict] = None,
    ultrasound_check: Optional[dict] = None,
    features_shape: Optional[int] = None,
) -> dict:
    """Shape compatible with cnn_predict.predict() for Detect / XAI frontends."""
    pct = _to_percentage(
        positive_prob,
        apply_smoothing=apply_smoothing,
        smoothing_factor=smoothing_factor,
    )
    classification = _classify(pct)
    # diagnosis code used by some clients: 0 neg / 1 pos / 2 borderline
    label = classification["classification"]
    if label == "Positive":
        diagnosis = 1
    elif label == "Borderline":
        diagnosis = 2
    else:
        diagnosis = 0

    reliable = bool(classification["reliable"])
    if isinstance(image_validation, dict) and "passed" in image_validation:
        reliable = reliable and bool(image_validation.get("passed", True))

    result = {
        "success": True,
        "probability_percentage": round(pct, 2),
        "positive_probability": float(positive_prob),
        "positive_percent": round(pct, 2),
        "classification": label,
        "description": classification["description"],
        "diagnosis": diagnosis,
        "prediction": diagnosis,
        "label": label,
        "reliable": reliable,
        "smoothing_applied": bool(apply_smoothing),
        "smoothing_factor": float(smoothing_factor) if apply_smoothing else None,
        "model": model_name,
        "backend": "tflite",
        "raw_output": raw_output or [],
        "classification_threshold_pct": 75.0,
    }
    if features_shape is not None:
        result["features_shape"] = int(features_shape)
    if ultrasound_check is not None:
        result["ultrasound_check"] = ultrasound_check
    if mahalanobis is not None:
        result["mahalanobis"] = mahalanobis
    if image_validation is not None:
        result["image_validation"] = image_validation
    if generate_gradcam:
        # Grad-CAM needs intermediate Keras layers — not available under TFLite.
        result["gradcam_error"] = (
            "Grad-CAM heatmap is unavailable in TFLite mode. "
            "Probability score still uses pcos_detection_modelv4.tflite."
        )
    return result


def _attach_mahalanobis_validation(
    image_bytes: bytes,
    features: Optional[Any],
) -> Tuple[dict, dict, dict]:
    """Score GAP features with mahalanobis_inv_cov.pkl / mahalanobis_mu.pkl."""
    from mahalanobis_ood import (
        image_validation_payload,
        score_features,
        try_load_mahalanobis_params,
        ultrasound_likeness_check,
    )

    us_check = ultrasound_likeness_check(image_bytes)
    mu, inv_cov, meta = try_load_mahalanobis_params()
    if features is None:
        maha_result = {
            "available": False,
            "meta": {
                **dict(meta or {}),
                "feature_extract_error": "gap_features_unavailable",
            },
        }
    else:
        maha_result = score_features(features, mu=mu, inv_cov=inv_cov, meta=meta)
    image_validation = image_validation_payload(us_check, maha_result)
    return us_check, maha_result, image_validation


def predict_pcos(
    image_path: Union[str, Path],
    *,
    tflite_path: Union[str, Path] = TFLITE_MODEL_PATH,
    apply_smoothing: bool = True,
    smoothing_factor: float = 0.90,
    generate_gradcam: bool = False,
) -> dict:
    """
    Run PCOS / PMOS ultrasound classification with the TFLite model.

    Returns an API-shaped dict (probability_percentage, classification, …).
    """
    try:
        from pathlib import Path as _Path

        image_path = _Path(image_path)
        with open(image_path, "rb") as fh:
            image_bytes = fh.read()
        return predict_pcos_bytes(
            image_bytes,
            tflite_path=tflite_path,
            apply_smoothing=apply_smoothing,
            smoothing_factor=smoothing_factor,
            generate_gradcam=generate_gradcam,
        )
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc), "backend": "tflite"}


def predict_pcos_bytes(
    image_bytes: bytes,
    *,
    tflite_path: Union[str, Path] = TFLITE_MODEL_PATH,
    apply_smoothing: bool = True,
    smoothing_factor: float = 0.90,
    generate_gradcam: bool = False,
    user_mode: str = "",
) -> dict:
    """Flask / Render entry: classify from raw upload bytes (no full TensorFlow)."""
    del user_mode  # reserved for parity with cnn_predict.predict signature
    try:
        from mahalanobis_ood import try_load_mahalanobis_params

        mu, _inv, _meta = try_load_mahalanobis_params()
        feature_dim = int(mu.shape[0]) if mu is not None else 1280
        want_maha = mu is not None

        x = preprocess_image_bytes(image_bytes)
        prob, raw, features = _raw_positive_probability(
            x,
            tflite_path,
            return_features=want_maha,
            feature_dim=feature_dim,
        )
        us_check, maha_result, image_validation = _attach_mahalanobis_validation(
            image_bytes, features if want_maha else None
        )
        return build_api_result(
            prob,
            raw_output=raw,
            apply_smoothing=apply_smoothing,
            smoothing_factor=smoothing_factor,
            model_name=str(Path(tflite_path).name),
            generate_gradcam=generate_gradcam,
            mahalanobis=maha_result,
            image_validation=image_validation,
            ultrasound_check=us_check,
            features_shape=(int(features.size) if features is not None else None),
        )
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc), "backend": "tflite"}


def ensure_tflite(
    keras_path: Union[str, Path] = KERAS_MODEL_PATH,
    tflite_path: Union[str, Path] = TFLITE_MODEL_PATH,
    *,
    force: bool = False,
) -> Path:
    """Convert when the ``.tflite`` file is missing (or ``force=True``)."""
    tflite_path = Path(tflite_path)
    if tflite_path.is_file() and not force:
        print(f"[ensure] Using existing TFLite model: {tflite_path}")
        return tflite_path.resolve()
    return convert_keras_to_tflite(keras_path, tflite_path)


# =============================================================================
# 3) CLI / main workflow
# =============================================================================
def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert P-Code CNN Keras → TFLite and/or run lightweight inference."
    )
    parser.add_argument(
        "--convert-only",
        action="store_true",
        help="Only convert Keras → TFLite (requires TensorFlow).",
    )
    parser.add_argument(
        "--force-convert",
        action="store_true",
        help="Re-convert even if .tflite already exists.",
    )
    parser.add_argument(
        "--image",
        type=str,
        default="",
        help="Optional image path for a smoke-test prediction after ensure/convert.",
    )
    parser.add_argument(
        "--keras",
        type=str,
        default=str(KERAS_MODEL_PATH),
        help="Path to pcos_detection_modelv4.keras",
    )
    parser.add_argument(
        "--tflite",
        type=str,
        default=str(TFLITE_MODEL_PATH),
        help="Path to output / input .tflite model",
    )
    args = parser.parse_args(argv)

    keras_path = Path(args.keras)
    tflite_path = Path(args.tflite)

    # Auto-convert when .tflite is missing (or forced).
    try:
        ensure_tflite(keras_path, tflite_path, force=args.force_convert)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] Conversion/ensure failed: {exc}", file=sys.stderr)
        return 1

    if args.convert_only:
        return 0

    if args.image:
        try:
            result = predict_pcos(args.image, tflite_path=tflite_path)
            print("[predict]", result)
        except Exception as exc:  # noqa: BLE001
            print(f"[error] Inference failed: {exc}", file=sys.stderr)
            return 1
    else:
        print(
            "[ready] TFLite model is available. "
            "Pass --image path.jpg to run predict_pcos()."
        )

    return 0


if __name__ == "__main__":
    # On first run in a checkout without .tflite, conversion runs automatically.
    # Production containers should ship the prebuilt .tflite and only install:
    #   tflite-runtime, pillow, numpy
    raise SystemExit(main())
