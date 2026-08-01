#!/C:/Users/USER/AppData/Local/Programs/Python/Python313/python.exe
"""
CNN Model Prediction
"""
import json
import sys
import numpy as np
from pathlib import Path
from io import BytesIO
import pickle
import traceback
import os

# Disable TensorFlow GPU and verbose logging BEFORE importing tensorflow
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'  # Suppress TensorFlow logging (0=all, 1=info, 2=warning, 3=error)
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'  # Force CPU only
os.environ['TF_FORCE_GPU_ALLOW_GROWTH'] = 'false'
os.environ['TF_ENABLE_ONEDNN_OPTS'] = '0'

# Suppress warnings
import warnings
warnings.filterwarnings('ignore')

try:
    import tensorflow as tf
    # Silence TensorFlow completely
    tf.compat.v1.logging.set_verbosity(tf.compat.v1.logging.ERROR)
    # Eager execution is enabled by default in TensorFlow 2.x - keep it enabled

    from tensorflow.keras.models import load_model
    from tensorflow.keras.preprocessing import image
    from PIL import Image
    import cv2  # OpenCV for colormap
except ImportError as e:
    print(json.dumps({
        'success': False,
        'error': f'Missing dependencies: {str(e)}. Please install: tensorflow pillow scipy numpy opencv-python'
    }), flush=True)
    sys.exit(1)

# Grad-CAM++ visualization — matched to js/pcode-gradcam-canvas.js (XAI Insights)
CNN_POSITIVE_THRESHOLD_PCT = 75.0
CNN_BORDERLINE_MIN_PCT = 55.0
CNN_NEGATIVE_MAX_PCT = 54.0
GRADCAM_BLEND_ALPHA = 0.4   # heatmap overlay weight
GRADCAM_BLEND_BETA = 0.6    # grayscale ultrasound base weight
GRADCAM_BACKBONE_LAYER = 'mobilenetv2_1.00_224'
GRADCAM_TARGET_LAYER = 'Conv_1_bn'
GRADCAM_ALPHA_CLIP_FLOOR = 0.03
GRADCAM_ALPHA_FADE_HI = 0.10
GRADCAM_SMOOTH_LAYER_FACTOR = 0.88
GRADCAM_CAM_BLUR_PX = 3.0        # matches CSS blur on intensity field (lower = sharper)
GRADCAM_OVERLAY_BLUR_PX = 2.0    # matches CSS blur on color overlay (lower = sharper)
GRADCAM_IMAGE_MIN_INTENSITY = 0.18
GRADCAM_IMAGE_CAM_BLEND = 0.62
GRADCAM_PEARL_CAM_BASE = 0.32
GRADCAM_PEARL_CAM_GAIN = 0.68
GRADCAM_PEARL_BOOST = 0.18
GRADCAM_PEARL_GAMMA = 0.48
GRADCAM_TISSUE_SPREAD = 0.48
GRADCAM_GRAIN_ALPHA = 0.18
GRADCAM_GRAIN_STEP = 3
# Continuous jet-like colormap (same anchors as pcode-gradcam-canvas.js)
GRADCAM_COLOR_ANCHORS = (
    (0.0, (0, 0, 130)),
    (0.11, (0, 60, 220)),
    (0.28, (0, 190, 210)),
    (0.45, (60, 210, 90)),
    (0.58, (230, 230, 40)),
    (0.72, (250, 140, 20)),
    (0.86, (220, 30, 30)),
    (1.0, (120, 0, 0)),
)

class PreprocessedImage:
    """Wrapper to store preprocessed image and original dimensions"""
    def __init__(self, array, original_size):
        self.array = array
        self.original_size = original_size
    
    def __getitem__(self, key):
        return self.array[key]
    
    def __len__(self):
        return len(self.array)
    
    def flatten(self):
        return self.array.flatten()
    
    def shape(self):
        return self.array.shape
    
    @property
    def shape(self):
        return self.array.shape

def load_cnn_model(model_path):
    """Load the CNN Keras model"""
    try:
        model = load_model(model_path)
        return model
    except Exception as e:
        raise Exception(f"Failed to load CNN model from {model_path}: {str(e)}")

def preprocess_image(image_bytes, target_size=(224, 224)):
    """Preprocess image for CNN model"""
    try:
        # Open image from bytes
        img = Image.open(BytesIO(image_bytes))
        
        # Store original dimensions before preprocessing
        original_size = img.size  # Returns (width, height)
        
        # Convert to RGB if needed
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        # Resize to target size
        img = img.resize(target_size)
        
        # Convert to numpy array and normalize
        img_array = image.img_to_array(img)
        img_array = img_array / 255.0  # Normalize to [0, 1]
        
        # Expand dims and wrap with original size
        expanded_array = np.expand_dims(img_array, axis=0)
        return PreprocessedImage(expanded_array, original_size)
    except Exception as e:
        raise Exception(f"Failed to preprocess image: {str(e)}")

def _image_colorfulness_rgb(img_rgb):
    """
    Hasler-Süsstrunk colorfulness metric.
    Higher = more colorful. Ultrasound images are typically low colorfulness.
    """
    try:
        arr = np.asarray(img_rgb, dtype=np.float32)
        if arr.ndim != 3 or arr.shape[2] != 3:
            return 0.0
        r = arr[..., 0]
        g = arr[..., 1]
        b = arr[..., 2]
        rg = np.abs(r - g)
        yb = np.abs(0.5 * (r + g) - b)
        std_rg = float(np.std(rg))
        std_yb = float(np.std(yb))
        mean_rg = float(np.mean(rg))
        mean_yb = float(np.mean(yb))
        return float(np.sqrt(std_rg ** 2 + std_yb ** 2) + 0.3 * np.sqrt(mean_rg ** 2 + mean_yb ** 2))
    except Exception:
        return 0.0

def _ultrasound_likeness_check(image_bytes):
    """Delegate to shared gate in mahalanobis_ood (keeps TFLite + Keras paths aligned)."""
    from mahalanobis_ood import ultrasound_likeness_check as _shared_us_check

    return _shared_us_check(image_bytes)

def _ultrasound_validation_message(us_check):
    """Human-readable validation summary for API / UI consumers."""
    if us_check.get('ok', False):
        return 'The system confirmed this image as an ultrasound scan.'
    reasons = us_check.get('reasons') or []
    if 'too_colorful' in reasons:
        detail = 'The upload appears too colorful for a typical grayscale ultrasound frame.'
    elif 'high_channel_spread' in reasons:
        detail = 'Color variation is higher than expected for ultrasound imaging.'
    elif any(r in reasons for r in (
        'too_bright', 'large_bright_regions', 'document_like_background',
        'document_like_edges', 'missing_dark_field', 'insufficient_dark_field',
        'missing_near_black', 'missing_black_histogram_peak', 'missing_dark_border',
        'everyday_photo_texture', 'flat_texture', 'soft_nonclinical_texture',
        'color_photo_content', 'no_ultrasound_vignette',
    )):
        detail = (
            'The upload looks more like an everyday photo or bright document '
            'than a dark-field ultrasound scan.'
        )
    elif 'validation_error' in reasons:
        detail = 'The system could not complete ultrasound-likeness checks for this file.'
    else:
        detail = 'The upload does not match expected ultrasound visual characteristics.'
    return (
        'The system could not confirm this image as a valid ultrasound scan. '
        + detail
        + ' CNN imaging results may be unreliable.'
    )

def _image_validation_payload(us_check, maha_result=None):
    """Combined Mahalanobis anomaly detection + ultrasound-likeness validation."""
    us_ok = bool(us_check.get('ok', False))
    reasons = []
    message_parts = []
    maha_available = isinstance(maha_result, dict) and maha_result.get('available') is True
    maha_reliable = None
    mahalanobis_anomaly = False

    if maha_available:
        maha_reliable = bool(maha_result.get('reliable'))
        if not maha_reliable:
            mahalanobis_anomaly = True
            reasons.append('mahalanobis_anomaly')
            message_parts.append(
                'The system could not confirm this image as a valid ultrasound scan. '
                'CNN imaging results may be unreliable.'
            )

    if not us_ok:
        reasons.extend(list(us_check.get('reasons') or []))
        if not message_parts:
            message_parts.append(_ultrasound_validation_message(us_check))

    passed = (not mahalanobis_anomaly) and us_ok
    if passed:
        if maha_available and maha_reliable and us_ok:
            message = 'The system confirmed this image as an ultrasound scan.'
        elif us_ok:
            message = 'The system confirmed this image as an ultrasound scan.'
        else:
            message = 'Image passed validation checks.'
    else:
        message = ' '.join(message_parts) if message_parts else 'The system could not confirm this image as a valid ultrasound scan.'

    payload = {
        'is_ultrasound': us_ok,
        'anomaly_passed': passed,
        'passed': passed,
        'anomaly_detected': mahalanobis_anomaly or (not us_ok),
        'method': 'mahalanobis_and_ultrasound_likeness' if maha_available else 'ultrasound_likeness_heuristic',
        'mahalanobis_reliable': maha_reliable,
        'ultrasound_likeness_ok': us_ok,
        'reasons': reasons,
        'message': message,
        'metrics': {
            'colorfulness': us_check.get('colorfulness'),
            'channel_spread': us_check.get('channel_spread'),
            'mean_luminance': us_check.get('mean_luminance'),
            'bright_fraction': us_check.get('bright_fraction'),
            'dark_fraction': us_check.get('dark_fraction'),
            'sharp_edge_fraction': us_check.get('sharp_edge_fraction'),
        },
    }
    if maha_available:
        if maha_result.get('distance') is not None:
            payload['mahalanobis_distance'] = maha_result.get('distance')
        if maha_result.get('threshold') is not None:
            payload['mahalanobis_threshold'] = maha_result.get('threshold')
        if maha_result.get('p_value') is not None:
            payload['mahalanobis_p_value'] = maha_result.get('p_value')
    return payload

def extract_features(model, preprocessed_image, target_feature_dim=1024):
    """Extract features from intermediate layers for diagnostics / Mahalanobis OOD.

    NOTE: For Mahalanobis, the target_feature_dim must match the dimension used to
    build the saved mu / inv_cov parameters.
    """
    try:
        # Try multiple layers to find one that gives us good features
        try:
            target_feature_dim = int(target_feature_dim)
        except Exception:
            target_feature_dim = 1024
        target_feature_dim = max(16, min(16384, target_feature_dim))
        
        # Prefer a layer whose flattened output exactly matches target_feature_dim.
        # This helps align with how Mahalanobis parameters were generated.
        try:
            # Scan from last to first to prefer deeper layers.
            for idx in range(len(model.layers) - 1, -1, -1):
                layer = model.layers[idx]
                shp = getattr(layer, "output_shape", None)
                if not shp:
                    continue
                # output_shape can be tuple or list of tuples
                if isinstance(shp, (list, tuple)) and shp and isinstance(shp[0], (list, tuple)):
                    shp = shp[0]
                if not isinstance(shp, (list, tuple)) or len(shp) < 2:
                    continue
                # Flattened size excluding batch dim
                dims = [d for d in shp[1:] if d is not None]
                if not dims:
                    continue
                flat = 1
                for d in dims:
                    flat *= int(d)
                if flat == target_feature_dim:
                    feature_extractor = tf.keras.Model(inputs=model.input, outputs=layer.output)
                    features = feature_extractor.predict(preprocessed_image, verbose=0)
                    features_flat = features.flatten()
                    if len(features_flat) == target_feature_dim:
                        return features_flat
        except Exception:
            # Non-fatal; fall back to heuristic layer choices below
            pass

        # Fallback heuristic: try several near-tail layers
        for layer_index in [-2, -3, -4, -5]:
            try:
                if abs(layer_index) > len(model.layers):
                    continue
                
                feature_layer = model.layers[layer_index]
                
                # Create feature extractor from this layer
                feature_extractor = tf.keras.Model(
                    inputs=model.input,
                    outputs=feature_layer.output
                )
                
                # Extract features
                features = feature_extractor.predict(preprocessed_image, verbose=0)
                features_flat = features.flatten()
                
                # If we got close to our target dimension, use this layer
                feature_count = len(features_flat)
                
                # Prefer layers with enough features to reasonably represent the model
                if feature_count >= max(128, min(500, target_feature_dim // 2)):
                    # Pad or truncate to exactly 1024 features
                    if feature_count < target_feature_dim:
                        features_flat = np.pad(features_flat, (0, target_feature_dim - feature_count))
                    else:
                        features_flat = features_flat[:target_feature_dim]
                    
                    return features_flat
            except:
                continue
        
        # Fallback: use the model's output and pad/truncate to target_feature_dim
        features = model.predict(preprocessed_image, verbose=0)
        features_flat = features.flatten()
        
        if len(features_flat) < target_feature_dim:
            features_flat = np.pad(features_flat, (0, target_feature_dim - len(features_flat)))
        else:
            features_flat = features_flat[:target_feature_dim]
        
        return features_flat
        
    except Exception as e:
        raise Exception(f"Failed to extract features: {str(e)}")

def _try_load_mahalanobis_params():
    """
    Load Mahalanobis mean vector and inverse covariance matrix.
    Expected filenames (user provided):
      - mahalanobis_mu.pkl
      - mahalanobis_inv_cov.pkl
    We search in:
      - script directory
      - 'CNN Model' subdirectory (where the .keras model lives)
    """
    base = Path(__file__).parent
    # Search in both repo root and 'CNN Model' folder (case-insensitive filename match)
    search_dirs = [base, base / 'CNN Model']
    def find_ci(d: Path, name: str):
        try:
            for p in d.iterdir():
                if p.is_file() and p.name.lower() == name.lower():
                    return p
        except Exception:
            return None
        return None

    mu_path = find_ci(search_dirs[0], 'mahalanobis_mu.pkl') or find_ci(search_dirs[1], 'mahalanobis_mu.pkl')
    inv_path = find_ci(search_dirs[0], 'mahalanobis_inv_cov.pkl') or find_ci(search_dirs[1], 'mahalanobis_inv_cov.pkl')

    meta_attempts = {
        'searched_dirs': [str(d) for d in search_dirs],
        'mu_found': str(mu_path) if mu_path else None,
        'inv_cov_found': str(inv_path) if inv_path else None,
    }
    if not mu_path or not inv_path:
        return None, None, meta_attempts
    try:
        # Prefer joblib (common for sklearn covariance artifacts); fall back to pickle.
        mu = None
        inv_cov = None
        try:
            import joblib  # type: ignore
            mu = joblib.load(mu_path)
            inv_cov = joblib.load(inv_path)
            meta_attempts.update({'loader': 'joblib'})
        except Exception as e_joblib:
            meta_attempts.update({'joblib_error': repr(e_joblib)})
            with open(mu_path, 'rb') as f:
                mu = pickle.load(f)
            with open(inv_path, 'rb') as f:
                inv_cov = pickle.load(f)
            meta_attempts.update({'loader': 'pickle'})
        mu = np.asarray(mu, dtype=np.float64).reshape(-1)
        inv_cov = np.asarray(inv_cov, dtype=np.float64)
        meta_attempts.update({'loaded': True})
        return mu, inv_cov, meta_attempts
    except Exception as e:
        meta_attempts.update({'loaded': False, 'error': repr(e)})
        return None, None, meta_attempts

def _mahalanobis_distance(x, mu, inv_cov):
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    d = x - mu
    return float(d.T @ inv_cov @ d)

def _mahalanobis_reliability(dist, df, alpha=0.999):
    """
    Classify "reliable" if the squared Mahalanobis distance is within the chi-square
    acceptance region with df degrees of freedom (one-sided upper bound).

    We intentionally use a high alpha to reduce false "anomalous" flags on real
    ultrasound images. (OOD detection should be calibrated with validation data.)
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
        # Fallback heuristic if SciPy isn't available:
        # expected mean of chi-square(df) is df, variance 2df; 3*df is a conservative cutoff.
        dist = float(dist)
        upper = float(df * 3.0)
        return bool(dist <= upper), None, upper, None

def convert_to_percentage(prediction, confidence_cap=0.98, min_floor=0.02, apply_smoothing=True, smoothing_factor=0.90):
    """Convert model output to percentage with confidence capping and optional smoothing
    
    Args:
        prediction: Model output (0-1)
        confidence_cap: Maximum allowed confidence (default 0.98 = 98%)
        min_floor: Minimum floor to avoid 0% (default 0.02 = 2%)
        apply_smoothing: Apply sigmoid compression for smooth calibration (default True)
        smoothing_factor: Compression strength (lower = stronger smoothing). Default 0.90.
    """
    # Assume prediction is between 0 and 1
    if isinstance(prediction, np.ndarray):
        prediction = float(prediction[0]) if prediction.shape[0] > 0 else prediction.item()
    
    # Apply sigmoid compression smoothing to reduce extreme predictions
    if apply_smoothing:
        try:
            smoothing_factor = float(smoothing_factor)
        except Exception:
            smoothing_factor = 0.90
        # Clamp to a safe, sensible range
        smoothing_factor = max(0.50, min(0.95, smoothing_factor))
        # Compress the full range into narrower range for aggressive smoothing
        # Formula: 0.5 + smoothing_factor * (prediction - 0.5)
        # This maps: 0% → 5%, 50% → 50%, 100% → 95%
        calibrated_prediction = 0.5 + smoothing_factor * (prediction - 0.5)
    else:
        calibrated_prediction = prediction
    
    # Apply both upper cap and lower floor to prevent extreme predictions
    calibrated_prediction = min(calibrated_prediction, confidence_cap)  # Cap at 98%
    calibrated_prediction = max(calibrated_prediction, min_floor)  # Floor at 2%
    
    percentage = float(calibrated_prediction) * 100
    return max(0, min(100, percentage))  # Clamp to [0, 100]

def classify_result(percentage):
    """Classify result based on PCOS probability percentage (three-way)."""
    p = float(percentage)
    if p <= CNN_NEGATIVE_MAX_PCT:
        classification = 'Negative'
        description = 'PCOS not detected in image'
    elif p <= 74:
        classification = 'Borderline'
        description = 'Intermediate PCOS imaging signal'
    else:
        classification = 'Positive'
        description = 'PCOS detected in image'

    return {
        'classification': classification,
        'description': description,
        'reliable': True,
        'threshold_pct': CNN_POSITIVE_THRESHOLD_PCT
    }

def resolve_gradcam_colormap_profile(probability_percentage):
    """Map CNN probability to Grad-CAM++ profile metadata (XAI canvas style)."""
    classification_result = classify_result(probability_percentage)
    classification = classification_result['classification']
    return {
        'profile': 'hot_red' if classification == 'Positive' else 'cool_blue',
        'classification': classification,
        'opencv_colormap': 'JET_SMOOTH_LERP',
        'label': 'Smooth jet attention map (matches XAI Insights)',
    }

def normalize_activation_matrix_minmax(matrix):
    """Explicit min–max: intensity = (raw - min) / (max - min); peak locked to 1.0."""
    arr = np.asarray(matrix, dtype=np.float32)
    arr = np.maximum(arr, 0.0)
    lo = float(np.min(arr))
    hi = float(np.max(arr))
    span = hi - lo
    if span < 1e-10:
        normalized = np.zeros_like(arr, dtype=np.float32)
    else:
        normalized = (arr - lo) / span
    # Match JS auto-scale if peak drifted below 1
    max_after = float(np.max(normalized)) if normalized.size else 0.0
    if 1e-10 < max_after < 0.999:
        normalized = normalized / max_after
        max_after = 1.0
    stats = {
        'min_before': lo,
        'max_before': hi,
        'range': span,
        'min_after': float(np.min(normalized)) if normalized.size else 0.0,
        'max_after': max_after,
        'shape': [int(s) for s in arr.shape],
    }
    return normalized.astype(np.float32), stats

def _smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)

def _minmax01(arr):
    a = np.asarray(arr, dtype=np.float32)
    lo = float(np.min(a))
    hi = float(np.max(a))
    if hi - lo < 1e-10:
        return np.zeros_like(a, dtype=np.float32)
    return ((a - lo) / (hi - lo)).astype(np.float32)

def _css_blur_sigma(blur_px):
    """Approximate CSS canvas blur(Npx) with OpenCV Gaussian sigma."""
    return max(0.25, float(blur_px) * 0.45)

def _prepare_smooth_intensity_field(heatmap, target_dimensions):
    """Min–max → bilinear upscale → light CSS-like blur → min–max (peak = 1.0)."""
    field, _ = normalize_activation_matrix_minmax(heatmap)
    upscaled = cv2.resize(field, target_dimensions, interpolation=cv2.INTER_LINEAR)
    upscaled = _minmax01(upscaled)
    sigma = _css_blur_sigma(GRADCAM_CAM_BLUR_PX)
    # Mild size scaling only — avoid over-smoothing large images
    w, h = target_dimensions
    scale = max(w, h) / 512.0
    if scale > 1.0:
        sigma *= min(scale, 1.35)
    blurred = cv2.GaussianBlur(upscaled, (0, 0), sigmaX=sigma, sigmaY=sigma)
    return _minmax01(blurred)

def _lerp_colormap_rgb(intensity_01):
    """Piecewise-linear RGB across continuous jet anchors (XAI Insights)."""
    i = np.clip(intensity_01.astype(np.float32), 0.0, 1.0)
    positions = np.array([a[0] for a in GRADCAM_COLOR_ANCHORS], dtype=np.float32)
    colors = np.array([a[1] for a in GRADCAM_COLOR_ANCHORS], dtype=np.float32)
    flat = i.ravel()
    channels = [np.interp(flat, positions, colors[:, ch]) for ch in range(3)]
    rgb = np.stack(channels, axis=-1).reshape((*i.shape, 3))
    return np.clip(rgb, 0, 255).astype(np.uint8)

def _activation_alpha_mask(intensity_01):
    i = np.maximum(intensity_01.astype(np.float32), GRADCAM_IMAGE_MIN_INTENSITY * 0.75)
    return (_smoothstep(GRADCAM_ALPHA_CLIP_FLOOR, GRADCAM_ALPHA_FADE_HI, i) * GRADCAM_BLEND_ALPHA).astype(np.float32)

def _map_display_intensity(intensity_01, cnn_score_pct=None):
    i = np.clip(intensity_01.astype(np.float32), 0.0, 1.0)
    try:
        score = float(cnn_score_pct) if cnn_score_pct is not None else None
    except (TypeError, ValueError):
        score = None
    if score is not None and score >= CNN_POSITIVE_THRESHOLD_PCT:
        t = min(1.0, (score - CNN_POSITIVE_THRESHOLD_PCT) / 25.0)
        gamma = 0.9 - t * 0.1
        i = np.clip(np.power(i, gamma) + t * 0.04, 0.0, 1.0)
    return i

def _flood_background_mask(gray, threshold=24):
    h, w = gray.shape
    bg = np.zeros((h, w), dtype=np.uint8)
    q = []
    def seed(x, y):
        if bg[y, x] or gray[y, x] >= threshold:
            return
        bg[y, x] = 1
        q.append((x, y))
    for x in range(w):
        seed(x, 0)
        seed(x, h - 1)
    for y in range(h):
        seed(0, y)
        seed(w - 1, y)
    while q:
        x, y = q.pop()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            if bg[ny, nx] or gray[ny, nx] >= threshold + 8:
                continue
            bg[ny, nx] = 1
            q.append((nx, ny))
    return bg

def _mean_in_ring(gray, cx, cy, inner_r, outer_r):
    h, w = gray.shape
    y0 = max(0, cy - outer_r)
    y1 = min(h, cy + outer_r + 1)
    x0 = max(0, cx - outer_r)
    x1 = min(w, cx + outer_r + 1)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    d2 = (yy - cy) ** 2 + (xx - cx) ** 2
    mask = (d2 <= outer_r * outer_r) & (d2 >= inner_r * inner_r)
    vals = gray[y0:y1, x0:x1][mask]
    return float(np.mean(vals)) if vals.size else 0.0

def _dark_fraction_in_disk(gray, cx, cy, radius, dark_cutoff):
    h, w = gray.shape
    y0 = max(0, cy - radius)
    y1 = min(h, cy + radius + 1)
    x0 = max(0, cx - radius)
    x1 = min(w, cx + radius + 1)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    mask = (yy - cy) ** 2 + (xx - cx) ** 2 <= radius * radius
    patch = gray[y0:y1, x0:x1][mask]
    if patch.size == 0:
        return 0.0
    return float(np.mean(patch < dark_cutoff))

def _build_pearl_follicle_map(gray):
    """Detect peripheral follicle lumens ('string of pearls') — matches JS canvas."""
    h, w = gray.shape
    pearl = np.zeros((h, w), dtype=np.float32)
    bg = _flood_background_mask(gray, 24)
    local_mean = cv2.blur(gray.astype(np.float32), (15, 15))

    tissue = (~bg.astype(bool)) & (gray > 12) & (gray < 228)
    ys, xs = np.where(tissue & (gray > 12))
    if ys.size < 1:
        return pearl
    cx = float(np.mean(xs))
    cy = float(np.mean(ys))

    # Sample on a stride for speed; dilate afterward (JS scans every pixel)
    step = 2 if max(w, h) >= 400 else 1
    for y in range(0, h, step):
        for x in range(0, w, step):
            if bg[y, x] or gray[y, x] >= 228:
                continue
            g = float(gray[y, x])
            lm = float(local_mean[y, x])
            halo = _mean_in_ring(gray, x, y, 3, 11)
            halo_contrast = max(0.0, (halo - g) / 42.0)
            lumen_dark = max(0.0, (lm - g) / 50.0) if g < lm * 0.9 else 0.0
            if not (g < 95 and halo_contrast > 0.12 and lumen_dark > 0.08):
                continue
            void_fill = _dark_fraction_in_disk(gray, x, y, 20, 38)
            pearl_scale = 0.12 if void_fill > 0.72 else 1.0 - max(0.0, void_fill - 0.45) * 0.9
            dx = (x - cx) / max(w, 1)
            dy = (y - cy) / max(h, 1)
            dist = (dx * dx + dy * dy) ** 0.5
            peripheral = min(1.0, (dist * 2.6) ** 0.85)
            follicle_core = min(1.0, halo_contrast * 1.15) * min(1.0, lumen_dark * 1.2)
            pearl[y, x] = follicle_core * pearl_scale * (0.2 + 0.8 * peripheral)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))
    filled = cv2.dilate(pearl, kernel)
    return _minmax01(filled)

def _build_tissue_mask(gray):
    bg = _flood_background_mask(gray, 24)
    return (((~bg.astype(bool)) & (gray > 12) & (gray < 228)).astype(np.float32))

def _modulate_cam_with_pearls(cam_buf, pearl_map, tissue_mask):
    pearl_weight = np.power(np.clip(pearl_map, 0.0, 1.0), GRADCAM_PEARL_GAMMA)
    gate = GRADCAM_PEARL_CAM_BASE + GRADCAM_PEARL_CAM_GAIN * pearl_weight
    pearl_boost = cam_buf * pearl_weight * GRADCAM_PEARL_BOOST
    tissue_wash = cam_buf * tissue_mask * GRADCAM_TISSUE_SPREAD
    out = np.maximum(cam_buf * gate + pearl_boost, tissue_wash)
    return _minmax01(out)

def _apply_positive_score_lift(buf, cnn_score_pct=None):
    try:
        score = float(cnn_score_pct) if cnn_score_pct is not None else None
    except (TypeError, ValueError):
        score = None
    if score is None or score < CNN_POSITIVE_THRESHOLD_PCT:
        return buf
    t = min(1.0, (score - CNN_POSITIVE_THRESHOLD_PCT) / 25.0)
    gamma = 0.88 - t * 0.14
    lift = 0.06 + t * 0.14
    out = buf.copy()
    mask = out > 0
    out[mask] = np.clip(np.power(out[mask], gamma) + lift * (1.0 - out[mask] * 0.45), 0.0, 1.0)
    return _minmax01(out)

def _apply_full_image_coverage(buf, cam_buf, cnn_score_pct=None):
    floor = GRADCAM_IMAGE_MIN_INTENSITY
    try:
        score = float(cnn_score_pct) if cnn_score_pct is not None else None
    except (TypeError, ValueError):
        score = None
    if score is not None and score >= CNN_POSITIVE_THRESHOLD_PCT:
        floor += min(0.1, ((score - CNN_POSITIVE_THRESHOLD_PCT) / 25.0) * 0.1)
    spread = cam_buf * GRADCAM_IMAGE_CAM_BLEND + floor
    return _minmax01(np.maximum(buf, spread))

def _composite_gradcam_overlay(ultrasound_rgb, overlay_rgba):
    """Alpha-composite RGBA overlay onto grayscale ultrasound (XAI canvas order)."""
    base = ultrasound_rgb.astype(np.float32)
    over = overlay_rgba[..., :3].astype(np.float32)
    alpha = (overlay_rgba[..., 3].astype(np.float32) / 255.0)[..., None]
    blended = base * (1.0 - alpha) + over * alpha
    return np.clip(blended, 0, 255).astype(np.uint8)

def _prepare_grayscale_ultrasound_layer(img_array, target_dimensions):
    """Grayscale ultrasound base layer for structural blending."""
    original_denorm = (img_array[0] * 255).astype(np.uint8)
    if original_denorm.ndim == 3 and original_denorm.shape[2] >= 3:
        original_gray = cv2.cvtColor(original_denorm, cv2.COLOR_RGB2GRAY)
    else:
        original_gray = original_denorm if original_denorm.ndim == 2 else original_denorm[..., 0]
    original_gray_rgb = cv2.cvtColor(original_gray, cv2.COLOR_GRAY2RGB)
    return cv2.resize(original_gray_rgb, target_dimensions, interpolation=cv2.INTER_LINEAR)

def _add_light_grain(overlay_rgba, intensity_01, cnn_score_pct=None):
    """Subtle speckled grain matching the XAI canvas look (deterministic seed)."""
    h, w = intensity_01.shape
    rng = np.random.RandomState(42)
    step = GRADCAM_GRAIN_STEP
    out = overlay_rgba.copy()
    display = _map_display_intensity(intensity_01, cnn_score_pct)
    for y in range(0, h, step):
        for x in range(0, w, step):
            intensity = max(float(intensity_01[y, x]), GRADCAM_IMAGE_MIN_INTENSITY * 0.9)
            prob = min(1.0, intensity * 0.72 + 0.12)
            if rng.rand() > prob:
                continue
            di = float(np.clip(display[y, x] + (rng.rand() - 0.5) * 0.05, 0.0, 1.0))
            rgb = _lerp_colormap_rgb(np.array([[di]], dtype=np.float32))[0, 0]
            alpha = _activation_alpha_mask(np.array([[intensity]], dtype=np.float32))[0, 0]
            a = int(round(alpha * GRADCAM_GRAIN_ALPHA * 255))
            jx = int(round((rng.rand() - 0.5) * step * 0.7))
            jy = int(round((rng.rand() - 0.5) * step * 0.7))
            xx = min(w - 1, max(0, x + jx))
            yy = min(h - 1, max(0, y + jy))
            # Soft 1px stamp
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    px, py = xx + dx, yy + dy
                    if px < 0 or py < 0 or px >= w or py >= h:
                        continue
                    aa = a if (dx == 0 and dy == 0) else a // 2
                    if aa <= 0:
                        continue
                    src_a = out[py, px, 3] / 255.0
                    dst_a = aa / 255.0
                    out_a = dst_a + src_a * (1.0 - dst_a)
                    if out_a <= 1e-6:
                        continue
                    for c in range(3):
                        out[py, px, c] = np.clip(
                            (rgb[c] * dst_a + out[py, px, c] * src_a * (1.0 - dst_a)) / out_a,
                            0, 255
                        )
                    out[py, px, 3] = np.clip(out_a * 255, 0, 255)
    return out

def _forward_to_conv_and_prediction(model, image_tensor):
    """Connected forward pass: MobileNetV2 spatial features (7×7) + classifier head."""
    backbone = model.get_layer(GRADCAM_BACKBONE_LAYER)
    spatial_features = backbone(image_tensor, training=False)
    prediction = spatial_features
    for layer in model.layers:
        if layer.name == GRADCAM_BACKBONE_LAYER:
            continue
        prediction = layer(prediction, training=False)
    return spatial_features, prediction

def generate_gradcam_plus_plus(model, image, layer_name=None):
    """Generate Grad-CAM++ saliency from MobileNetV2 spatial feature maps."""
    if layer_name and layer_name != GRADCAM_TARGET_LAYER:
        print(
            f"Grad-CAM++ note: using backbone spatial output (layer_name={layer_name} ignored)",
            file=sys.stderr,
            flush=True,
        )
    try:
        img_tensor = tf.convert_to_tensor(image, dtype=tf.float32)

        with tf.GradientTape(persistent=True) as tape:
            conv_outputs, predictions = _forward_to_conv_and_prediction(model, img_tensor)
            class_idx = tf.argmax(predictions[0])
            score = predictions[:, class_idx]

        grads = tape.gradient(score, conv_outputs)
        del tape

        if grads is None:
            return np.zeros((7, 7), dtype=np.float32)

        conv_outputs = conv_outputs[0]
        grads = grads[0]

        grads2 = grads ** 2
        grads3 = grads ** 3
        alpha_denom = 2.0 * grads2 + conv_outputs * grads3 + 1e-8
        alphas = grads2 / alpha_denom
        weights = tf.reduce_sum(alphas * tf.nn.relu(grads), axis=(0, 1))

        cam = tf.reduce_sum(tf.nn.relu(conv_outputs) * weights, axis=-1)
        cam = tf.nn.relu(cam).numpy().astype(np.float32)
        return np.maximum(cam, 0.0)
    except Exception as e:
        print(f"Grad-CAM++ error: {str(e)}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        return np.zeros((7, 7), dtype=np.float32)

def heatmap_to_base64(heatmap, original_image, probability_percentage=None, colormap_profile=None):
    """Convert Grad-CAM++ heatmap to smooth XAI Insights-style overlay PNG."""
    try:
        from PIL import Image
        import base64

        if colormap_profile is None:
            colormap_profile = resolve_gradcam_colormap_profile(probability_percentage or 0)

        if isinstance(original_image, PreprocessedImage):
            target_dimensions = original_image.original_size
            img_array = original_image.array
        else:
            target_dimensions = (224, 224)
            img_array = original_image

        w, h = int(target_dimensions[0]), int(target_dimensions[1])
        cam_buf = _prepare_smooth_intensity_field(heatmap, (w, h))

        ultrasound_gray_rgb = _prepare_grayscale_ultrasound_layer(img_array, (w, h))
        gray = cv2.cvtColor(ultrasound_gray_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)

        pearl_map = _build_pearl_follicle_map(gray)
        tissue_mask = _build_tissue_mask(gray)
        focused = _modulate_cam_with_pearls(cam_buf, pearl_map, tissue_mask)
        focused = _apply_positive_score_lift(focused, probability_percentage)
        focused = _apply_full_image_coverage(focused, cam_buf, probability_percentage)

        display_i = _map_display_intensity(
            np.maximum(focused, GRADCAM_IMAGE_MIN_INTENSITY * 0.9),
            probability_percentage,
        )
        overlay_rgb = _lerp_colormap_rgb(display_i)
        alpha = (_activation_alpha_mask(np.maximum(focused, GRADCAM_IMAGE_MIN_INTENSITY * 0.9))
                 * GRADCAM_SMOOTH_LAYER_FACTOR)
        overlay_rgba = np.dstack([
            overlay_rgb,
            np.clip(alpha * 255.0, 0, 255).astype(np.uint8),
        ])

        # Light soften on color overlay (matches reduced CSS blur)
        sigma_over = _css_blur_sigma(GRADCAM_OVERLAY_BLUR_PX)
        scale = max(w, h) / 512.0
        if scale > 1.0:
            sigma_over *= min(scale, 1.35)
        for c in range(4):
            overlay_rgba[..., c] = cv2.GaussianBlur(
                overlay_rgba[..., c].astype(np.float32),
                (0, 0),
                sigmaX=sigma_over,
                sigmaY=sigma_over,
            )
        overlay_rgba = np.clip(overlay_rgba, 0, 255).astype(np.uint8)
        overlay_rgba = _add_light_grain(overlay_rgba, focused, probability_percentage)

        superimposed_img = _composite_gradcam_overlay(ultrasound_gray_rgb, overlay_rgba)

        overlay_img = Image.fromarray(superimposed_img)
        buffer = BytesIO()
        overlay_img.save(buffer, format='PNG')
        image_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
        return f"data:image/png;base64,{image_base64}"
    except Exception as e:
        print(f"Warning: heatmap_to_base64 failed - {str(e)}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        try:
            from PIL import Image
            import base64

            heatmap_uint8 = (np.asarray(heatmap, dtype=np.float32) * 255).astype(np.uint8)
            img = Image.fromarray(heatmap_uint8, mode='L')
            img_resized = img.resize((224, 224), Image.Resampling.LANCZOS)

            buffer = BytesIO()
            img_resized.save(buffer, format='PNG')
            image_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
            return f"data:image/png;base64,{image_base64}"
        except Exception as fallback_error:
            print(f"Warning: Fallback heatmap conversion also failed - {str(fallback_error)}", file=sys.stderr, flush=True)
            return None

def predict(image_bytes, model_path, generate_gradcam=False, apply_smoothing=True, smoothing_factor=0.90, user_mode=''):
    """Main prediction function
    
    Args:
        image_bytes: Raw image bytes
        model_path: Path to the CNN model
        generate_gradcam: Whether to generate Grad-CAM++ visualization
        apply_smoothing: Whether to apply temperature smoothing (default True for guest mode)
    """
    try:
        # Load model
        cnn_model = load_cnn_model(model_path)

        # Preprocess image (returns PreprocessedImage wrapper with array and original_size)
        preprocessed_wrapper = preprocess_image(image_bytes)
        
        # Extract the numpy array for model operations
        preprocessed_array = preprocessed_wrapper.array

        # Mahalanobis OOD / anomaly detection (always enabled when params are available)
        mu, inv_cov, meta = _try_load_mahalanobis_params()
        mu_dim = None
        try:
            if mu is not None:
                mu_dim = int(np.asarray(mu, dtype=np.float64).reshape(-1).shape[0])
        except Exception:
            mu_dim = None

        # Extract features (dimension must match Mahalanobis params when enabled)
        features = extract_features(cnn_model, preprocessed_array, target_feature_dim=(mu_dim or 1024))

        # Get prediction
        prediction = cnn_model.predict(preprocessed_array, verbose=0)[0]
        probability_percentage = convert_to_percentage(
            prediction[0] if isinstance(prediction, np.ndarray) and prediction.shape[0] > 1 else prediction,
            apply_smoothing=apply_smoothing,
            smoothing_factor=smoothing_factor
        )

        # Classify result based on PCOS probability only
        classification_result = classify_result(probability_percentage)

        # Ultrasound-likeness + Mahalanobis anomaly validation
        us_check = _ultrasound_likeness_check(image_bytes)
        maha_result = {'available': False, 'meta': meta}

        if mu is not None and inv_cov is not None:
            try:
                x = np.asarray(features, dtype=np.float64).reshape(-1)
                expected_dim = int(np.asarray(mu).reshape(-1).shape[0])
                if x.shape[0] != expected_dim:
                    maha_result = {
                        'distance': None,
                        'feature_dim': expected_dim,
                        'threshold': None,
                        'p_value': None,
                        'reliable': False,
                        'anomaly_detected': True,
                        'available': True,
                        'reason': 'feature_dim_mismatch',
                        'meta': dict(meta or {}, **{
                            'features_dim': int(x.shape[0]),
                            'expected_dim': expected_dim
                        })
                    }
                else:
                    dist = _mahalanobis_distance(
                        x,
                        np.asarray(mu, dtype=np.float64).reshape(-1),
                        np.asarray(inv_cov, dtype=np.float64),
                    )
                    maha_reliable, lower_thr, upper_thr, p_value = _mahalanobis_reliability(dist, expected_dim, alpha=0.999)
                    maha_result = {
                        'distance': float(dist),
                        'feature_dim': expected_dim,
                        'threshold': float(upper_thr),
                        'lower_threshold': float(lower_thr) if lower_thr is not None else None,
                        'p_value': float(p_value) if p_value is not None else None,
                        'reliable': bool(maha_reliable),
                        'anomaly_detected': not bool(maha_reliable),
                        'available': True,
                        'meta': dict(meta or {}, **{'alpha': 0.999})
                    }
            except Exception:
                maha_result = {'available': False, 'meta': meta}

        image_validation = _image_validation_payload(us_check, maha_result)
        reliable = bool(classification_result['reliable']) and bool(image_validation.get('passed', True))

        display_classification = classification_result['classification']
        display_description = classification_result['description']
        if not reliable:
            display_classification = 'Pending'
            display_description = (
                'Imaging result withheld — upload could not be confirmed as an ultrasound scan.'
            )

        result = {
            'success': True,
            'probability_percentage': round(probability_percentage, 2),
            'classification': display_classification,
            'raw_classification': classification_result['classification'],
            'description': display_description,
            'reliable': reliable,
            'features_shape': features.shape[0],
            'smoothing_applied': apply_smoothing,
            'smoothing_factor': float(smoothing_factor) if apply_smoothing else None,
            'ultrasound_check': us_check,
            'mahalanobis': maha_result,
            'image_validation': image_validation,
        }

        # Generate Grad-CAM++ if requested
        if generate_gradcam:
            try:
                gradcam_profile = resolve_gradcam_colormap_profile(probability_percentage)
                heatmap_raw = generate_gradcam_plus_plus(cnn_model, preprocessed_array)
                heatmap, matrix_stats = normalize_activation_matrix_minmax(heatmap_raw)
                gradcam_image = heatmap_to_base64(
                    heatmap,
                    preprocessed_wrapper,
                    probability_percentage=probability_percentage,
                    colormap_profile=gradcam_profile,
                )
                if gradcam_image:
                    result['gradcam_visualization'] = gradcam_image
                    result['gradcam_activation_matrix'] = heatmap.tolist()
                    result['gradcam_matrix_stats'] = matrix_stats
                    result['gradcam_colormap_profile'] = gradcam_profile['profile']
                    result['gradcam_colormap'] = gradcam_profile['opencv_colormap']
                    result['gradcam_colormap_label'] = gradcam_profile['label']
                    result['gradcam_blend'] = {
                        'alpha': GRADCAM_BLEND_ALPHA,
                        'beta': GRADCAM_BLEND_BETA,
                    }
                    result['classification_threshold_pct'] = CNN_POSITIVE_THRESHOLD_PCT
            except Exception as gradcam_error:
                # Don't fail the whole prediction if Grad-CAM++ fails
                result['gradcam_error'] = str(gradcam_error)
        
        return result
    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': 'No image file path provided'
        }), flush=True)
        sys.exit(1)
    
    try:
        # Get image file path from command line
        image_file_path = sys.argv[1]
        
        # Check for Grad-CAM++ flag (second argument)
        generate_gradcam = len(sys.argv) > 2 and sys.argv[2].lower() in ['true', '1', 'yes']
        
        # Check for smoothing flag (third argument) - default True
        apply_smoothing = True
        if len(sys.argv) > 3:
            apply_smoothing = sys.argv[3].lower() not in ['false', '0', 'no']

        # Optional smoothing factor (fourth argument)
        smoothing_factor = 0.90
        if len(sys.argv) > 4:
            try:
                smoothing_factor = float(sys.argv[4])
            except Exception:
                smoothing_factor = 0.90

        # Optional user_mode (fifth argument) - enables Mahalanobis for Regular User flow
        user_mode = ''
        if len(sys.argv) > 5:
            user_mode = str(sys.argv[5] or '')
        
        # Read image file
        if not Path(image_file_path).exists():
            print(json.dumps({
                'success': False,
                'error': f'Image file not found: {image_file_path}'
            }), flush=True)
            sys.exit(1)
        
        with open(image_file_path, 'rb') as f:
            image_bytes = f.read()
        
        # Model paths
        model_dir = Path(__file__).parent / 'CNN Model'
        model_path = str(model_dir / 'pcos_detection_modelv4.keras')

        # Verify model path exists
        if not Path(model_path).exists():
            print(json.dumps({
                'success': False,
                'error': f'CNN model not found at: {model_path}'
            }), flush=True)
            sys.exit(1)

        # Run prediction with optional Grad-CAM++ and smoothing
        result = predict(
            image_bytes,
            model_path,
            generate_gradcam=generate_gradcam,
            apply_smoothing=apply_smoothing,
            smoothing_factor=smoothing_factor,
            user_mode=user_mode
        )
        print(json.dumps(result), flush=True)
        
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), flush=True)
        sys.exit(1)
