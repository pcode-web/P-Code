/**
 * P-Code API base helper — Firebase Hosting has no PHP.
 * Always prefer Render when on *.web.app / *.firebaseapp.com.
 *
 * Also patches window.fetch on Firebase so relative /api/*.php calls
 * (including forgotten hardcodes) are rewritten to the Render Flask API.
 */
(function (global) {
  "use strict";

  var RENDER_API = "https://p-code-nqak.onrender.com/api/";
  var RENDER_ML = "https://p-code-nqak.onrender.com";
  var nativeFetch = typeof global.fetch === "function" ? global.fetch.bind(global) : null;

  function isFirebaseHost() {
    try {
      var host = String(global.location && global.location.hostname || "");
      return /\.web\.app$/i.test(host) || /\.firebaseapp\.com$/i.test(host);
    } catch (_) {
      return false;
    }
  }

  function isLocalHost() {
    try {
      var host = String(global.location && global.location.hostname || "");
      return host === "localhost" || host === "127.0.0.1" || host === "";
    } catch (_) {
      return false;
    }
  }

  function stripApiPrefix(path) {
    return String(path || "")
      .replace(/^\.?\/?api\//i, "")
      .replace(/^\//, "");
  }

  var FLASK_MAP = {
    "login.php": "login",
    "register.php": "register",
    "verify.php": "verify",
    "guest_login.php": "guest-login",
    "auth/google_callback.php": "auth/google",
    "auth/firebase_callback.php": "auth/firebase",
    "auth/bootstrap_session.php": "auth/bootstrap_session",
    "auth/refresh.php": "auth/refresh",
    "sync_session.php": "sync_session",
    "update_profile.php": "update-profile",
    "patients/get_patients_list.php": "patients/get_patients_list",
    "get_patients.php": "get_patients",
    "get_patients_xai.php": "get_patients",
    "get_patients_simple.php": "get_patients",
    "get_patient.php": "get_patient",
    "delete_patient.php": "delete_patient",
    "save_patient.php": "save_patient",
    "save_diagnosis_results.php": "save_diagnosis_results",
    "diagnostics/get_patient_history.php": "diagnostics/get_patient_history",
    "diagnostics/get_user_history.php": "diagnostics/get_user_history",
    "get_user_diagnosis.php": "get_user_diagnosis",
    "save_user_diagnosis.php": "save_user_diagnosis",
    "predict.php": "predict",
    "validate_clinical_timing.php": "validate_clinical_timing",
    "export_xai_pdf.php": "export_xai_pdf",
    "get_users.php": "get_users",
    "save_user.php": "save_user",
    "delete_user.php": "delete_user"
  };

  function toFlaskPath(path) {
    var p = stripApiPrefix(path);
    var q = "";
    var qi = p.indexOf("?");
    if (qi >= 0) {
      q = p.slice(qi);
      p = p.slice(0, qi);
    }
    if (FLASK_MAP[p]) {
      p = FLASK_MAP[p];
    } else {
      p = p.replace(/\.php$/i, "");
    }
    return p + q;
  }

  function resolveBase() {
    if (global.auth && typeof global.auth.resolveApiUrl === "function") {
      var base = String(global.auth.apiBaseUrl || "");
      if (/onrender\.com/i.test(base)) {
        return base.replace(/\/?$/, "/");
      }
    }
    if (isFirebaseHost()) {
      return RENDER_API;
    }
    try {
      if (global.auth && /onrender\.com/i.test(String(global.auth.apiBaseUrl || ""))) {
        return String(global.auth.apiBaseUrl).replace(/\/?$/, "/");
      }
    } catch (_) {}
    return isFirebaseHost() ? RENDER_API : "./api/";
  }

  /**
   * @param {string} path e.g. "diagnostics/get_patient_history.php?patient_id=1"
   * @returns {string} absolute or relative API URL
   */
  function pcodeApiUrl(path) {
    var base = resolveBase();
    if (/onrender\.com/i.test(base) || isFirebaseHost()) {
      base = (/onrender\.com/i.test(base) ? base : RENDER_API).replace(/\/?$/, "/");
      return base + toFlaskPath(path);
    }
    var p = stripApiPrefix(path);
    return "./api/" + p;
  }

  /** True when a URL targets the site's /api/ tree (relative or Firebase absolute). */
  function isSiteApiUrl(url) {
    if (typeof url !== "string" || !url) return false;
    if (/^https?:\/\/p-code-nqak\.onrender\.com/i.test(url)) return false;
    if (/^https?:\/\//i.test(url)) {
      try {
        var u = new URL(url);
        if (!isFirebaseHost()) return false;
        if (!/(web\.app|firebaseapp\.com)$/i.test(u.hostname)) return false;
        return /\/api(\/|$)/i.test(u.pathname);
      } catch (_) {
        return false;
      }
    }
    return /(^|\.?\/)api\//i.test(url);
  }

  function rewriteSiteApiUrl(url) {
    if (!isSiteApiUrl(url)) return url;
    try {
      if (/^https?:\/\//i.test(url)) {
        var abs = new URL(url);
        var path = abs.pathname.replace(/^\/+/, "");
        if (/^api\//i.test(path)) path = path.slice(4);
        return pcodeApiUrl(path + (abs.search || ""));
      }
    } catch (_) {}
    return pcodeApiUrl(url);
  }

  /**
   * fetch() wrapper that rewrites relative / Firebase api/ URLs to Render.
   */
  function pcodeFetch(input, init) {
    if (!nativeFetch) {
      throw new Error("fetch is not available");
    }
    if (typeof input === "string") {
      return nativeFetch(rewriteSiteApiUrl(input), init);
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      var rewritten = rewriteSiteApiUrl(input.url);
      if (rewritten !== input.url) {
        return nativeFetch(new Request(rewritten, input), init);
      }
    }
    return nativeFetch(input, init);
  }

  // On Firebase, patch global fetch so forgotten hardcodes still hit Render.
  if (nativeFetch && isFirebaseHost() && !global.__pcodeFetchPatched) {
    global.fetch = pcodeFetch;
    global.__pcodeFetchPatched = true;
  }

  /**
   * ML inference endpoints (CNN / XGBoost).
   * - Local XAMPP: PHP wrappers (Keras CNN + XGBoost)
   * - Firebase / production: Render Flask (TFLite CNN + XGBoost)
   */
  function pcodeMlUrl(kind) {
    var k = String(kind || "").toLowerCase();
    if (isFirebaseHost() || (!isLocalHost() && /onrender\.com/i.test(String(resolveBase())))) {
      if (k === "cnn" || k === "predict-cnn") return RENDER_ML + "/predict-cnn";
      if (k === "xgboost" || k === "xgb" || k === "predict-xgboost") return RENDER_ML + "/predict-xgboost";
      if (k === "gradcam" || k === "predict-cnn-gradcam") return RENDER_ML + "/predict-cnn-gradcam";
    }
    if (k === "cnn" || k === "predict-cnn") return "./api/predict_cnn.php";
    if (k === "xgboost" || k === "xgb" || k === "predict-xgboost") return "./api/predict_xgboost.php";
    if (k === "gradcam" || k === "predict-cnn-gradcam") return "./api/predict_cnn_gradcam.php";
    return RENDER_ML + "/predict-cnn";
  }

  /** Match local Keras cnn_predict defaults (no extra community compression). */
  function pcodeCnnSmoothingFactor() {
    return 0.90;
  }

  /** Match local XGBoost default (no threshold-aware community pull). */
  function pcodeXgbSmoothingFactor() {
    return 1.0;
  }

  global.PCODE_API_BASE = RENDER_API;
  global.pcodeApiUrl = pcodeApiUrl;
  global.pcodeFetch = pcodeFetch;
  global.pcodeMlUrl = pcodeMlUrl;
  global.pcodeCnnSmoothingFactor = pcodeCnnSmoothingFactor;
  global.pcodeXgbSmoothingFactor = pcodeXgbSmoothingFactor;
})(typeof window !== "undefined" ? window : this);
