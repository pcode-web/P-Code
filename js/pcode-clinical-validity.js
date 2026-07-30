/**
 * P-Code — clinical validity notes, live badges, and pre-inference checks.
 */
(function (global) {
  'use strict';

  var NOTE_COPY = {
    hormone_cycle_default:
      '⚠️ Clinical Note: For accurate screening, baseline blood draws should ideally be performed between Day 2 and Day 5 of the menstrual cycle.',
    hormone_cycle_amenorrhea:
      'ℹ️ Amenorrhea detected: Baseline verification cycle window is dynamically bypassed.',
    ultrasound_follicle:
      '⚠️ Clinical Note: Transvaginal/Pelvic ultrasound metrics reflect highly dynamic follicle development cycles and remain valid for ML inference for a maximum of 60 days from the scan date.',
    ultrasound_tvus_primary:
      '⚠️ Primary Modality: Transvaginal Ultrasound (TVUS) scans are highly preferred for optimal follicle boundary detection and classification by our imaging AI model. Transabdominal/Pelvic scan inputs are permitted but may result in diminished feature extraction resolution.',
    rbs_non_fasting:
      '⚠️ Note: Non-Fasting baseline detected. System will flag this record to prevent insulin-resistance data skewing in XAI models.',
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setNoteContent(el, text, variant) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('is-hidden', 'clinical-note-badge--info', 'clinical-note-badge--warn', 'clinical-note-badge--stale', 'clinical-note-badge--primary-modality');
    el.classList.add('clinical-note-badge', 'clinical-note-badge--' + (variant || 'info'));
  }

  function isAmenorrhea() {
    var sel = $('Cycle_R_I');
    if (!sel) return false;
    return String(sel.value || '').toLowerCase() === 'amenorrhea';
  }

  function updateHormoneCycleNote() {
    var el = $('clinical-note-hormone-cycle');
    if (!el) return;
    if (isAmenorrhea()) {
      setNoteContent(el, NOTE_COPY.hormone_cycle_amenorrhea, 'info');
    } else {
      setNoteContent(el, NOTE_COPY.hormone_cycle_default, 'warn');
    }
  }

  function updateRbsNote() {
    var el = $('clinical-note-rbs-fasting');
    var hoursEl = $('fasting_hours');
    if (!el || !hoursEl) return;
    var hours = parseFloat(hoursEl.value);
    if (!isNaN(hours) && hours < 8) {
      setNoteContent(el, NOTE_COPY.rbs_non_fasting, 'warn');
    } else {
      el.classList.add('is-hidden');
    }
  }

  function getUltrasoundModality() {
    var primary = $('ultrasound_modality');
    var uploadMirror = $('ultrasound_modality_upload');
    if (primary && primary.value) return primary.value;
    if (uploadMirror && uploadMirror.value) return uploadMirror.value;
    return 'TVUS';
  }

  function syncUltrasoundModalitySelects(source) {
    var formSel = $('ultrasound_modality');
    var uploadSel = $('ultrasound_modality_upload');
    if (!formSel || !uploadSel) return;
    if (source === 'upload') {
      formSel.value = uploadSel.value;
    } else {
      uploadSel.value = formSel.value;
    }
    updateUltrasoundModalityNote();
  }

  function updateUltrasoundModalityNote() {
    var el = $('clinical-note-ultrasound-modality');
    var uploadEl = $('clinical-note-ultrasound-modality-upload');
    var modality = getUltrasoundModality();
    var variant = modality === 'Transabdominal' || modality === 'Other' ? 'warn' : 'primary-modality';
    if (el) setNoteContent(el, NOTE_COPY.ultrasound_tvus_primary, variant);
    if (uploadEl) setNoteContent(uploadEl, NOTE_COPY.ultrasound_tvus_primary, variant);
  }

  function collectValidityPayload() {
    var form = document.getElementById('clinical-form');
    if (!form) return {};
    var fd = new FormData(form);
    var payload = Object.fromEntries(fd.entries());
    payload.ultrasound_modality = getUltrasoundModality();
    ['Weight_gain', 'Hair_growth', 'Skin_darkening', 'Pimples'].forEach(function (name) {
      var cb = form.querySelector('[name="' + name + '"]');
      if (cb && cb.type === 'checkbox') {
        payload[name] = cb.checked ? 1 : 0;
      }
    });
    return payload;
  }

  function showInferenceBlockBanner(stale) {
    var host = $('clinical-validity-banner');
    if (!host || !stale) return;
    host.className = 'clinical-validity-banner clinical-validity-banner--blocked';
    host.innerHTML =
      '<strong>Inference locked:</strong> ' +
      (stale.error || 'Expired clinical parameters.') +
      '<br>' +
      (stale.action_required || '');
    host.classList.remove('is-hidden');
    host.removeAttribute('hidden');
  }

  function clearInferenceBlockBanner() {
    var host = $('clinical-validity-banner');
    if (!host) return;
    host.textContent = '';
    host.classList.add('is-hidden');
    host.setAttribute('hidden', '');
  }

  function validateBeforeInference() {
    return fetch((typeof pcodeApiUrl==='function'?pcodeApiUrl('api/validate_clinical_timing.php'):'api/validate_clinical_timing.php'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(collectValidityPayload()),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.success) {
          return { allowed: true, evaluation: null };
        }
        var evaluation = result.body.clinical_validity;
        if (evaluation && evaluation.inference_blocked) {
          showInferenceBlockBanner(evaluation.stale_response);
          return { allowed: false, evaluation: evaluation };
        }
        clearInferenceBlockBanner();
        return { allowed: true, evaluation: evaluation };
      })
      .catch(function () {
        return { allowed: true, evaluation: null };
      });
  }

  function applyFollowUpMetadata(result, confidenceScore) {
    if (!result || !result.success) return;
    if (result.follow_up_recommendation) return;
    var score = confidenceScore;
    if (score == null && result.probability_percentage != null) {
      score = parseFloat(result.probability_percentage) / 100;
    }
    if (score == null) return;
    if (score >= 0.75) {
      result.follow_up_recommendation = {
        window: '3_to_6_months',
        label: 'Recommend clinical follow-up in 3–6 months.',
      };
    } else {
      result.follow_up_recommendation = {
        window: '12_month_routine_baseline',
        label: 'Negative screening with persistent symptoms — schedule 12-month routine baseline re-screening.',
      };
    }
  }

  function resolveFollowUpRecommendation(probabilityPercent, existing) {
    if (existing && existing.label) return existing;
    var stub = { success: true, probability_percentage: probabilityPercent };
    applyFollowUpMetadata(stub);
    return stub.follow_up_recommendation || null;
  }

  function isCommunityPortal() {
    try {
      var user = window.auth && window.auth.currentUser;
      if (!user) return false;
      if (user.isGuest) return true;
      return String(user.role || '')
        .trim()
        .toLowerCase() === 'regular user';
    } catch (_) {
      return false;
    }
  }

  function formatFollowUpLabel(followUp, forCommunity) {
    if (!followUp || !followUp.label) return '';
    var label = String(followUp.label);
    if (!forCommunity) return label;
    if (followUp.window === '3_to_6_months') {
      return 'Consider follow-up with a clinician in 3–6 months.';
    }
    if (followUp.window === '12_month_routine_baseline') {
      return 'If symptoms continue, plan a routine re-screening in about 12 months and discuss results with a clinician.';
    }
    return label;
  }

  /**
   * Render clinical context under a risk category / final diagnosis.
   * variant: 'clinical' | 'imaging' | 'final'
   */
  function renderRiskClinicalContext(hostId, options) {
    var host = $(hostId);
    if (!host) return;
    var opts = options || {};
    var probability = opts.probabilityPercent;
    if (probability == null || !Number.isFinite(Number(probability))) {
      host.classList.add('is-hidden');
      host.innerHTML = '';
      return;
    }
    var followUp = resolveFollowUpRecommendation(Number(probability), opts.followUp);
    var community = opts.portal === 'community' || (opts.portal !== 'provider' && isCommunityPortal());
    var followLabel = formatFollowUpLabel(followUp, community);
    if (!followLabel) {
      host.classList.add('is-hidden');
      host.innerHTML = '';
      return;
    }

    var extra = '';
    if (opts.variant === 'final') {
      var saveLabel = community ? 'Save My Record' : 'Save to Patient Record';
      extra =
        '<p class="clinical-context-note__extra">' +
        'This is a screening summary only — XAI Insights are not included yet. ' +
        'Please use <strong>' +
        saveLabel +
        '</strong> before clicking <strong>View XAI Insights</strong>.' +
        '</p>';
    }

    host.classList.remove('is-hidden');
    host.className = 'clinical-note-badge clinical-note-badge--info clinical-context-note mt-3';
    host.setAttribute('role', 'note');
    host.innerHTML =
      '<p class="clinical-context-note__main"><span class="font-semibold">Clinical context:</span> ' +
      followLabel +
      '</p>' +
      extra;
  }

  function clearRiskClinicalContext(hostId) {
    var host = $(hostId);
    if (!host) return;
    host.classList.add('is-hidden');
    host.innerHTML = '';
  }

  function resolveImageValidation(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.image_validation && typeof result.image_validation === 'object') {
      var iv = result.image_validation;
      var hasPassFlag = typeof iv.anomaly_passed === 'boolean' || typeof iv.passed === 'boolean';
      var passed = hasPassFlag
        ? iv.anomaly_passed !== false && iv.passed !== false
        : false;
      var hasUsFlag =
        typeof iv.is_ultrasound === 'boolean' || typeof iv.ultrasound_likeness_ok === 'boolean';
      var isUs = hasUsFlag
        ? iv.is_ultrasound !== false && iv.ultrasound_likeness_ok !== false
        : false;
      return {
        is_ultrasound: isUs,
        anomaly_passed: passed,
        passed: passed,
        anomaly_detected: iv.anomaly_detected === true || passed === false,
        method: iv.method || 'mahalanobis_and_ultrasound_likeness',
        mahalanobis_reliable: iv.mahalanobis_reliable,
        reasons: iv.reasons || [],
        message: iv.message || '',
        mahalanobis_distance: iv.mahalanobis_distance,
        mahalanobis_threshold: iv.mahalanobis_threshold,
        mahalanobis_p_value: iv.mahalanobis_p_value,
      };
    }
    var maha = result.mahalanobis;
    var us = result.ultrasound_check;
    var mahaAvailable = maha && maha.available === true;
    var mahaReliable = mahaAvailable && typeof maha.reliable === 'boolean' ? maha.reliable : null;
    // Missing ultrasound_check must NOT default to confirmed
    var usOk = us && typeof us.ok === 'boolean' ? us.ok : false;
    var passed = usOk && (mahaReliable === null || mahaReliable);
    var message = passed
      ? 'The system confirmed this image as a pelvic ultrasound scan.'
      : 'The system could not confirm this image as a valid pelvic ultrasound scan.';
    if (mahaAvailable && mahaReliable === false) {
      message = 'The system could not confirm this image as a valid pelvic ultrasound scan. Imaging AI results may be unreliable.';
    } else if (!usOk) {
      message =
        (us && us.message) ||
        'The system could not confirm this image as a valid pelvic ultrasound scan.';
    }
    return {
      is_ultrasound: usOk,
      anomaly_passed: passed,
      passed: passed,
      anomaly_detected: !passed,
      method: mahaAvailable ? 'mahalanobis_and_ultrasound_likeness' : 'ultrasound_likeness_heuristic',
      mahalanobis_reliable: mahaReliable,
      reasons: [].concat(
        mahaReliable === false ? ['mahalanobis_anomaly'] : [],
        us && us.reasons ? us.reasons : !usOk ? ['ultrasound_likeness_failed'] : []
      ),
      message: message,
      mahalanobis_distance: maha && maha.distance,
      mahalanobis_threshold: maha && maha.threshold,
      mahalanobis_p_value: maha && maha.p_value,
    };
  }

  function resolveImagingReliability(result) {
    var validation = resolveImageValidation(result);
    if (validation) {
      return validation.anomaly_passed !== false;
    }
    return Boolean(result && result.reliable);
  }

  function imagingNeedsSaveConfirmation(imagingData) {
    return imagingIsUnreliable(imagingData);
  }

  /** True when imaging results must not be saved (unconfirmed / unreliable ultrasound). */
  function imagingIsUnreliable(imagingData) {
    if (!imagingData) return false;
    if (imagingData.reliable === false) return true;
    if (imagingData.anomaly_passed === false) return true;
    if (imagingData.is_ultrasound === false) return true;
    var validation = imagingData.ultrasound_validation || {};
    if (validation.anomaly_passed === false || validation.passed === false) return true;
    if (validation.is_ultrasound === false) return true;
    var maha = imagingData.mahalanobis;
    if (maha && maha.available === true && maha.reliable === false) return true;
    return false;
  }

  function getUnreliableImagingSaveMessage(imagingData) {
    var validation = (imagingData && imagingData.ultrasound_validation) || {};
    return (
      validation.message ||
      'The system could not confirm this upload as a valid pelvic ultrasound scan. Diagnosis results cannot be saved while the image is unreliable. Please upload a valid pelvic ultrasound image and re-run imaging analysis.'
    );
  }

  /**
   * Hard-block save when imaging is unreliable.
   * @returns {boolean} true if save may proceed
   */
  function assertImagingReliableForSave(imagingData, options) {
    var opts = options || {};
    if (!imagingIsUnreliable(imagingData)) return true;
    if (!opts.quiet) {
      window.alert(
        'Save blocked — unreliable ultrasound image\n\n' + getUnreliableImagingSaveMessage(imagingData)
      );
    }
    return false;
  }

  function buildImagingDataSnapshot(result) {
    var validation = resolveImageValidation(result);
    return {
      probability: result.probability_percentage,
      classification: result.classification,
      reliable: resolveImagingReliability(result),
      description: result.description,
      is_ultrasound: validation.is_ultrasound,
      anomaly_passed: validation.anomaly_passed,
      ultrasound_validation: validation,
      mahalanobis: result.mahalanobis || null,
      ultrasound_check: result.ultrasound_check || null,
      gradcam_visualization: result.gradcam_visualization || null
    };
  }

  function renderMahalanobisStatus(result) {
    var host = $('image-mahalanobis-reliability');
    if (!host) return;
    var validation = resolveImageValidation(result);
    if (!validation) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.classList.remove('hidden');
    host.className = '';
    if (validation.anomaly_passed !== false) {
      host.innerHTML =
        '<div class="pcode-system-review pcode-system-review--confirmed" role="status" aria-live="polite">' +
        '<span class="pcode-system-review__icon" aria-hidden="true">✓</span>' +
        '<div class="pcode-system-review__copy">' +
        '<span class="pcode-system-review__label">System review</span>' +
        '<span class="pcode-system-review__message">Confirmed as a pelvic ultrasound image.</span>' +
        '</div></div>';
      return;
    }
    host.innerHTML =
      '<div class="pcode-system-review pcode-system-review--failed" role="status" aria-live="polite">' +
      '<span class="pcode-system-review__icon" aria-hidden="true">!</span>' +
      '<div class="pcode-system-review__copy">' +
      '<span class="pcode-system-review__label">System review</span>' +
      '<span class="pcode-system-review__message">Could not confirm this image as a pelvic ultrasound scan.</span>' +
      '</div></div>';
  }

  function renderUltrasoundValidationWarning(result) {
    var host = $('image-ultrasound-validation-warning');
    if (!host) return;
    var validation = resolveImageValidation(result);
    if (!validation || validation.anomaly_passed !== false) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.classList.remove('hidden');
    host.innerHTML =
      '<p class="text-sm text-amber-100 leading-relaxed">' +
      '<span class="font-semibold">Ultrasound image not confirmed:</span> ' +
      (validation.message ||
        'The system could not confirm this upload as a valid pelvic ultrasound scan.') +
      ' Imaging AI confidence may be unreliable. Diagnosis results cannot be saved until a valid pelvic ultrasound image is uploaded and re-analyzed.' +
      '</p>';
  }

  /** @deprecated Prefer assertImagingReliableForSave — save is now hard-blocked. */
  function confirmSaveIfNonUltrasoundSync(imagingData) {
    return assertImagingReliableForSave(imagingData, { quiet: false });
  }

  function handleStalePredictionResponse(result) {
    if (result && result.status === 'stale_clinical_data') {
      showInferenceBlockBanner(result);
      alert(
        (result.error || 'Inference locked due to expired parameters.') +
          '\n\n' +
          (result.action_required || 'Please update clinical data and try again.')
      );
      return true;
    }
    return false;
  }

  function renderImagingModalityContext(result) {
    var host = $('image-modality-context');
    if (!host || !result) return;
    var ctx = result.ultrasound_imaging_context;
    if (!ctx) {
      host.classList.add('is-hidden');
      return;
    }
    var token = ctx.diagnostic_token || {};
    var expiry = ctx.expiration_status || 'Valid';
    var modality = ctx.ultrasound_modality || 'TVUS';
    var resolution = ctx.image_resolution || {};
    host.classList.remove('is-hidden', 'image-modality-context--fallback');
    if (modality !== 'TVUS') {
      host.classList.add('image-modality-context--fallback');
    }
    host.innerHTML =
      '<strong>Imaging context:</strong> ' +
      modality +
      ' · Validity: ' +
      expiry +
      (resolution.width && resolution.height
        ? ' · Resolution: ' + resolution.width + '×' + resolution.height + 'px'
        : '') +
      '<br>' +
      (token.label || '');
  }

  function init() {
    var hormoneNote = $('clinical-note-hormone-cycle');
    if (hormoneNote) {
      setNoteContent(hormoneNote, NOTE_COPY.hormone_cycle_default, 'warn');
    }
    var usNote = $('clinical-note-ultrasound-follicle');
    if (usNote) {
      setNoteContent(usNote, NOTE_COPY.ultrasound_follicle, 'info');
    }
    var usModalityNote = $('clinical-note-ultrasound-modality');
    if (usModalityNote) {
      setNoteContent(usModalityNote, NOTE_COPY.ultrasound_tvus_primary, 'primary-modality');
    }

    var modalityForm = $('ultrasound_modality');
    var modalityUpload = $('ultrasound_modality_upload');
    if (modalityForm) {
      modalityForm.addEventListener('change', function () {
        syncUltrasoundModalitySelects('form');
      });
    }
    if (modalityUpload) {
      modalityUpload.addEventListener('change', function () {
        syncUltrasoundModalitySelects('upload');
      });
    }
    syncUltrasoundModalitySelects('form');

    var cycleSel = $('Cycle_R_I');
    if (cycleSel) {
      cycleSel.addEventListener('change', updateHormoneCycleNote);
    }
    var fasting = $('fasting_hours');
    if (fasting) {
      fasting.addEventListener('input', updateRbsNote);
      fasting.addEventListener('change', updateRbsNote);
    }
    updateHormoneCycleNote();
    updateRbsNote();
    updateUltrasoundModalityNote();
  }

  global.PcodeClinicalValidity = {
    init: init,
    validateBeforeInference: validateBeforeInference,
    handleStalePredictionResponse: handleStalePredictionResponse,
    applyFollowUpMetadata: applyFollowUpMetadata,
    resolveFollowUpRecommendation: resolveFollowUpRecommendation,
    renderRiskClinicalContext: renderRiskClinicalContext,
    clearRiskClinicalContext: clearRiskClinicalContext,
    collectValidityPayload: collectValidityPayload,
    getUltrasoundModality: getUltrasoundModality,
    renderImagingModalityContext: renderImagingModalityContext,
    resolveImageValidation: resolveImageValidation,
    resolveImagingReliability: resolveImagingReliability,
    imagingNeedsSaveConfirmation: imagingNeedsSaveConfirmation,
    imagingIsUnreliable: imagingIsUnreliable,
    getUnreliableImagingSaveMessage: getUnreliableImagingSaveMessage,
    assertImagingReliableForSave: assertImagingReliableForSave,
    buildImagingDataSnapshot: buildImagingDataSnapshot,
    renderMahalanobisStatus: renderMahalanobisStatus,
    renderUltrasoundValidationWarning: renderUltrasoundValidationWarning,
    confirmSaveIfNonUltrasoundSync: confirmSaveIfNonUltrasoundSync,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
