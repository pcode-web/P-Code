/**
 * Shared helpers for Detect/XAI PDF export: SHAP + Grad-CAM capture.
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
        console.warn('[PDF export] Canvas Grad-CAM render failed', err);
        return null;
      });
  }

  function fetchGradcamFromApi(ultrasoundImage) {
    if (!ultrasoundImage) return Promise.resolve(null);
    return fetch('api/predict_cnn_gradcam.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: ultrasoundImage }),
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result) return null;
        // Prefer re-rendering with the same canvas pipeline as XAI Insights
        if (
          result.gradcam_activation_matrix &&
          global.PcodeGradcamCanvas &&
          typeof global.PcodeGradcamCanvas.renderGradcamCanvasOverlay === 'function'
        ) {
          return renderCanvasGradcam(result.gradcam_activation_matrix, ultrasoundImage, result).then(
            function (canvasUrl) {
              if (canvasUrl) return canvasUrl;
              var viz = result.gradcam_visualization || null;
              if (!viz) return null;
              if (String(viz).indexOf('data:image') === 0) return viz;
              return 'data:image/png;base64,' + String(viz).replace(/\s+/g, '');
            }
          );
        }
        var viz = result.gradcam_visualization || null;
        if (!viz) return null;
        if (String(viz).indexOf('data:image') === 0) return viz;
        return 'data:image/png;base64,' + String(viz).replace(/\s+/g, '');
      })
      .catch(function (err) {
        console.warn('[PDF export] Grad-CAM API failed', err);
        return null;
      });
  }

  /**
   * Resolve Grad-CAM for export — same visual as XAI Insights:
   * DOM canvas → canvas re-render from activation matrix → API (+ canvas) → raw PNG.
   */
  function resolveGradcamForExport(imagingData, ultrasoundImage) {
    var fromDom = findGradcamFromDom();
    if (fromDom) return Promise.resolve(fromDom);

    var matrix = pickActivationMatrix(imagingData);
    return renderCanvasGradcam(matrix, ultrasoundImage, imagingData).then(function (canvasUrl) {
      if (canvasUrl) return canvasUrl;
      return fetchGradcamFromApi(ultrasoundImage).then(function (apiUrl) {
        if (apiUrl) return apiUrl;
        return pickRawGradcamSrc(imagingData);
      });
    });
  }

  global.PcodePdfExportHelpers = {
    collectFormClinicalData: collectFormClinicalData,
    pickShapExplanation: pickShapExplanation,
    pickGradcamSrc: pickRawGradcamSrc,
    resolveGradcamForExport: resolveGradcamForExport,
  };
})(typeof window !== 'undefined' ? window : globalThis);
