/**
 * P-Code ML API (Render Flask backend)
 * Central base URL for CNN / XGBoost inference endpoints.
 */
(function (global) {
  'use strict';

  var BASE = 'https://p-code.onrender.com';

  global.PCODE_ML_API_BASE = BASE;

  /**
   * @param {string} path e.g. "/predict-cnn" or "predict-xgboost"
   * @returns {string}
   */
  global.pcodeMlUrl = function (path) {
    path = String(path || '');
    if (path.charAt(0) !== '/') {
      path = '/' + path;
    }
    return BASE.replace(/\/$/, '') + path;
  };
})(typeof window !== 'undefined' ? window : this);
