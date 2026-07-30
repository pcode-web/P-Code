/**
 * P-Code API base helper — Firebase Hosting has no PHP.
 * Always prefer Render when on *.web.app / *.firebaseapp.com.
 */
(function (global) {
  "use strict";

  var RENDER_API = "https://p-code-nqak.onrender.com/api/";

  function isFirebaseHost() {
    try {
      var host = String(global.location && global.location.hostname || "");
      return /\.web\.app$/i.test(host) || /\.firebaseapp\.com$/i.test(host);
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
    "sync_session.php": "sync_session",
    "update_profile.php": "update-profile",
    "patients/get_patients_list.php": "patients/get_patients_list",
    "get_patients.php": "get_patients",
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
    "delete_user.php": "delete_user",
    "get_patients_xai.php": "get_patients",
    "update_profile.php": "update-profile"
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
      // config may already be cached on auth
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

  /**
   * fetch() wrapper that rewrites relative api/ URLs on Firebase.
   */
  function pcodeFetch(input, init) {
    var url = input;
    if (typeof input === "string" && /(^|\/)api\//i.test(input) && input.indexOf("http") !== 0) {
      url = pcodeApiUrl(input);
    }
    return global.fetch(url, init);
  }

  global.PCODE_API_BASE = RENDER_API;
  global.pcodeApiUrl = pcodeApiUrl;
  global.pcodeFetch = pcodeFetch;
})(typeof window !== "undefined" ? window : this);
