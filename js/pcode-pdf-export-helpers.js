/**
 * Shared helpers for Detect/XAI PDF export: SHAP + Grad-CAM++ capture.
 */
(function (global) {
  'use strict';

  function collectFormClinicalData() {
    var form = document.getElementById('clinical-form');
    var out = {};
    if (!form) return out;
    var fd = new FormData(form);
    fd.forEach(function (value, key) {
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        out[key] = value;
      }
    });
    return out;
  }

  function pickShapExplanation(clinicalData) {
    var guests = [];
    try {
      guests = JSON.parse(sessionStorage.getItem('guest_detected_patients') || '[]');
    } catch (e) {
      guests = [];
    }
    var lastGuest = guests.length ? guests[guests.length - 1] : null;

    var candidates = [
      global.lastClinicalResult && global.lastClinicalResult.shap_explanation,
      clinicalData && clinicalData.shap_explanation,
      lastGuest && lastGuest.api_response && lastGuest.api_response.shap_explanation,
      lastGuest && lastGuest.shap_explanation,
      global.lastShapExplanation,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var shap = candidates[i];
      if (shap && Array.isArray(shap.top_contributions) && shap.top_contributions.length) {
        return shap;
      }
    }
    return candidates.find(Boolean) || null;
  }

  function canvasToDataUrl(el) {
    if (!el) return null;
    try {
      if (el.tagName === 'CANVAS' && typeof el.toDataURL === 'function') {
        return el.toDataURL('image/png');
      }
      if (el.tagName === 'IMG' && el.src && el.src.indexOf('data:image') === 0) {
        return el.src;
      }
    } catch (e) {
      console.warn('[PDF export] canvas/img capture failed', e);
    }
    return null;
  }

  function findGradcamFromDom() {
    var selectors = [
      '#gradcam-heatmap-container canvas',
      '#gradcam-heatmap-container img',
      '#gradcam-heatmap-img',
      '#gradcam-image',
      '#gradcam-results-card canvas',
      '#gradcam-results-card img',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      var url = canvasToDataUrl(el);
      if (url) return url;
    }
    return null;
  }

  function pickRawGradcamSrc(imagingData) {
    var fromData =
      (imagingData && imagingData.gradcam_visualization) ||
      (global.lastImagingResult && global.lastImagingResult.gradcam_visualization) ||
      (global.lastImagingResult && global.lastImagingResult.gradcam_image) ||
      null;
    if (fromData && String(fromData).indexOf('data:image') === 0) return fromData;
    if (fromData && String(fromData).length > 64) {
      return String(fromData).indexOf('data:') === 0 ? fromData : 'data:image/png;base64,' + fromData;
    }
    return null;
  }

  function pickCnnScorePct(imagingData) {
    var candidates = [
      imagingData && imagingData.probability_percentage,
      imagingData && imagingData.imaging_score_percentage,
      global.lastImagingResult && global.lastImagingResult.probability_percentage,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var n = Number(candidates[i]);
      if (Number.isFinite(n)) return n;
    }
    return NaN;
  }

  function pickActivationMatrix(imagingData) {
    return (
      (global.lastImagingResult && global.lastImagingResult.gradcam_activation_matrix) ||
      (imagingData && imagingData.gradcam_activation_matrix) ||
      null
    );
  }

  function renderCanvasGradcam(matrix, ultrasoundImage, imagingData) {
    if (
      !matrix ||
      !ultrasoundImage ||
      !global.PcodeGradcamCanvas ||
      typeof global.PcodeGradcamCanvas.renderGradcamCanvasOverlay !== 'function'
    ) {
      return Promise.resolve(null);
    }
    return global.PcodeGradcamCanvas.renderGradcamCanvasOverlay(matrix, ultrasoundImage, {
      cnnScorePct: pickCnnScorePct(imagingData),
    })
      .then(function (canvas) {
        return canvasToDataUrl(canvas);
      })
      .catch(function (err) {
        console.warn('[PDF export] Canvas Grad-CAM++ render failed', err);
        return null;
      });
  }

  function fetchGradcamFromApi(ultrasoundImage) {
    if (!ultrasoundImage) return Promise.resolve(null);
    return fetch('/api/detect-ultrasound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: ultrasoundImage, generate_gradcam: true }),
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result) return null;
        // Prefer server Grad-CAM++ overlay from Cloud Functions
        var viz = result.gradcam_pp || result.gradcam_visualization || null;
        if (viz) {
          if (String(viz).indexOf('data:image') === 0) return viz;
          return 'data:image/png;base64,' + String(viz).replace(/\s+/g, '');
        }
        // Legacy fallback: client canvas if only an activation matrix is present
        if (
          result.gradcam_activation_matrix &&
          global.PcodeGradcamCanvas &&
          typeof global.PcodeGradcamCanvas.renderGradcamCanvasOverlay === 'function'
        ) {
          return renderCanvasGradcam(result.gradcam_activation_matrix, ultrasoundImage, result);
        }
        return null;
      })
      .catch(function (err) {
        console.warn('[PDF export] Grad-CAM++ API failed', err);
        return null;
      });
  }

  /**
   * Resolve Grad-CAM++ for export: same visual as the lab PDF / XAI Insights.
   * Prefer the live DOM overlay, then the stored/server PNG, then API, then canvas.
   */
  function resolveGradcamForExport(imagingData, ultrasoundImage) {
    var fromDom = findGradcamFromDom();
    if (fromDom) return Promise.resolve(fromDom);

    var fromSaved = pickRawGradcamSrc(imagingData);
    if (fromSaved) return Promise.resolve(fromSaved);

    return fetchGradcamFromApi(ultrasoundImage).then(function (apiUrl) {
      if (apiUrl) return apiUrl;
      return renderCanvasGradcam(pickActivationMatrix(imagingData), ultrasoundImage, imagingData);
    });
  }

  function pickPersonalDemographics() {
    var keys = [
      'first_name', 'middle_name', 'surname', 'last_name', 'patient_name', 'name',
      'address_street', 'address_barangay', 'address_town', 'address_municipality', 'address_city', 'address_province', 'address',
      'contact_no', 'civil_status', 'occupation', 'religion', 'referred_by', 'reffered_by',
      'date_of_birth', 'DOB'
    ];
    var out = {};
    var sources = Array.prototype.slice.call(arguments);
    sources.forEach(function (src) {
      if (!src || typeof src !== 'object') return;
      keys.forEach(function (key) {
        if (out[key] != null && String(out[key]).trim() !== '') return;
        var value = src[key];
        if (value == null || String(value).trim() === '') return;
        out[key] = value;
      });
    });
    if ((!out.first_name && !out.middle_name && !out.surname) && (out.name || out.patient_name)) {
      var legacy = String(out.first_name ? '' : (out.name || out.patient_name || ''))
        .replace(/^(?:PMOS|PCOS)-\d+\s*[:\-–]\s*/i, '')
        .trim();
      var parts = legacy.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        out.first_name = parts[0];
      } else if (parts.length === 2) {
        out.first_name = parts[0];
        out.surname = parts[1];
      } else if (parts.length >= 3) {
        out.first_name = parts[0];
        out.surname = parts[parts.length - 1];
        out.middle_name = parts.slice(1, -1).join(' ');
      }
    }
    if (out.first_name || out.middle_name || out.surname) {
      out.patient_name = [out.first_name, out.middle_name, out.surname].filter(Boolean).join(' ');
      out.name = out.patient_name;
    }
    if (!out.address_barangay && out.address_town) {
      out.address_barangay = out.address_town;
    }
    if (!out.address_town && out.address_barangay) {
      out.address_town = out.address_barangay;
    }
    return out;
  }

  global.PcodePdfExportHelpers = {
    collectFormClinicalData: collectFormClinicalData,
    pickShapExplanation: pickShapExplanation,
    pickGradcamSrc: pickRawGradcamSrc,
    resolveGradcamForExport: resolveGradcamForExport,
    pickPersonalDemographics: pickPersonalDemographics,
  };
})(typeof window !== 'undefined' ? window : globalThis);
