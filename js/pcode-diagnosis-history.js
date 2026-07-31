/**
 * P-Code — Diagnosis / Screening History loader
 * - OB-GYN patient workspace (step 4 panel)
 * - Regular User dashboard screening history
 */
(function (global) {
  'use strict';

  var THRESHOLD = 0.75;
  var activePatientId = null;
  var activeUserMode = false;
  var expandedDiagnosisId = null;
  var cachedEntries = [];
  var cachedMeta = null;

  var SELECTORS = {
    patient: {
      root: 'patient-diagnosis-history-root',
      count: 'patient-diagnosis-history-count',
      emptyDefault: 'No diagnostic runs recorded yet. History is captured automatically after each screening save.',
      loading: 'Loading diagnosis history…',
      error: 'Unable to load diagnosis history.',
      listLabel: 'Diagnosis history timeline',
      scoreLabel: 'Final Diagnosis Score'
    },
    user: {
      root: 'user-screening-history-root',
      count: 'user-screening-history-count',
      emptyDefault: 'No screening history yet. Complete a Detect run and tap Save Record to start your timeline.',
      loading: 'Loading screening history…',
      error: 'Unable to load screening history.',
      listLabel: 'Your screening history timeline',
      scoreLabel: 'Overall screening score'
    }
  };

  function currentMode() {
    return activeUserMode ? SELECTORS.user : SELECTORS.patient;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMetricValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    return escapeHtml(value);
  }

  function getRoot() {
    return document.getElementById(currentMode().root);
  }

  function getCountEl() {
    return document.getElementById(currentMode().count);
  }

  function renderLoading() {
    var root = getRoot();
    if (!root) return;
    root.innerHTML =
      '<div class="pcode-history-state pcode-history-state--loading" role="status">' +
        '<span class="pcode-history-state__spinner" aria-hidden="true"></span>' +
        '<span>' + escapeHtml(currentMode().loading) + '</span>' +
      '</div>';
  }

  function renderEmpty(message) {
    var root = getRoot();
    if (!root) return;
    root.innerHTML =
      '<div class="pcode-history-state" role="status">' +
        escapeHtml(message || currentMode().emptyDefault) +
      '</div>';
  }

  function renderError(message) {
    var root = getRoot();
    if (!root) return;
    root.innerHTML =
      '<div class="pcode-history-state pcode-history-state--error" role="alert">' +
        escapeHtml(message || currentMode().error) +
      '</div>';
  }

  function hasMeaningfulValue(value) {
    return value !== null && value !== undefined && value !== '';
  }

  var SNAPSHOT_SKIP_KEYS = {
    parameter_id: true,
    patient_id: true,
    user_id: true,
    screening_id: true,
    created_by: true,
    created_at: true,
    Ultrasound_image: true
  };

  var SNAPSHOT_KEY_TO_CANONICAL = {
    age: 'Age_yrs', Age_yrs: 'Age_yrs',
    weight: 'Weight_kg', Weight_kg: 'Weight_kg',
    height: 'Height_cm', Height_cm: 'Height_cm',
    bmi: 'BMI', BMI: 'BMI',
    blood_group: 'Blood_Group', Blood_Group: 'Blood_Group',
    pulse_rate: 'Pulse_rate_bpm', Pulse_rate_bpm: 'Pulse_rate_bpm',
    rr_breath: 'RR_breath_min', RR_breath_min: 'RR_breath_min',
    bp_systolic: 'BP_Systolic_mmHg', BP_Systolic_mmHg: 'BP_Systolic_mmHg',
    bp_diastolic: 'BP_Diastolic_mmHg', BP_Diastolic_mmHg: 'BP_Diastolic_mmHg',
    hb: 'Hb_g_dl', Hb_g_dl: 'Hb_g_dl',
    cycle_regularity: 'CycleR_I', CycleR_I: 'CycleR_I', Cycle_R_I: 'CycleR_I',
    cycle_length: 'Cycle_length_days', Cycle_length_days: 'Cycle_length_days',
    marriage_years: 'Marriage_Status_years', Marriage_Status_years: 'Marriage_Status_years',
    pregnant: 'Pregnant', Pregnant: 'Pregnant',
    no_abortions: 'No_of_abortions', No_of_abortions: 'No_of_abortions',
    lh: 'LH_mIU_mL', LH_mIU_mL: 'LH_mIU_mL', LH_level: 'LH_mIU_mL',
    fsh: 'FSH_mIU_mL', FSH_mIU_mL: 'FSH_mIU_mL', FSH_level: 'FSH_mIU_mL',
    lh_fsh_ratio: 'FSH_LH', FSH_LH: 'FSH_LH', LH_FSH_Ratio: 'FSH_LH',
    amh: 'AMH_ng_mL', AMH_ng_mL: 'AMH_ng_mL', AMH_level: 'AMH_ng_mL',
    prl: 'PRL_ng_mL', PRL_ng_mL: 'PRL_ng_mL',
    vit_d3: 'Vit_D3_ng_mL', Vit_D3_ng_mL: 'Vit_D3_ng_mL',
    prg: 'PRG_ng_mL', PRG_ng_mL: 'PRG_ng_mL',
    tsh: 'TSH_mIU_L', TSH_mIU_L: 'TSH_mIU_L', TSH_level: 'TSH_mIU_L',
    rbs: 'RBS_mg_dl', RBS_mg_dl: 'RBS_mg_dl', RBS: 'RBS_mg_dl',
    hip_inch: 'Hip_inch', Hip_inch: 'Hip_inch',
    waist_inch: 'Waist_inch', Waist_inch: 'Waist_inch',
    waist_hip_ratio: 'Waist_hip_ratio', Waist_hip_ratio: 'Waist_hip_ratio',
    follicle_left: 'Follicle_no_L', Follicle_no_L: 'Follicle_no_L',
    follicle_right: 'Follicle_no_R', Follicle_no_R: 'Follicle_no_R',
    follicle_size_left: 'Avg_F_size_L_mm', Avg_F_size_L_mm: 'Avg_F_size_L_mm',
    follicle_size_right: 'Avg_F_size_R_mm', Avg_F_size_R_mm: 'Avg_F_size_R_mm',
    endometrium_thickness: 'Endometrium_mm', Endometrium_mm: 'Endometrium_mm',
    ultrasound_modality: 'ultrasound_modality',
    weight_gain: 'Weight_gain', Weight_gain: 'Weight_gain',
    hair_growth: 'Hair_growth', Hair_growth: 'Hair_growth',
    skin_darkening: 'Skin_darkening', Skin_darkening: 'Skin_darkening',
    hair_loss: 'Hair_loss', Hair_loss: 'Hair_loss',
    pimples: 'Pimples', Pimples: 'Pimples',
    fast_food: 'Fast_food', Fast_food: 'Fast_food',
    reg_exercise: 'Reg_Exercise', Reg_Exercise: 'Reg_Exercise'
  };

  var CLINICAL_FIELD_LABELS = {
    Age_yrs: 'Age (yrs)',
    Weight_kg: 'Weight (kg)',
    Height_cm: 'Height (cm)',
    BMI: 'BMI',
    Blood_Group: 'Blood Group',
    Pulse_rate_bpm: 'Pulse Rate (bpm)',
    RR_breath_min: 'Respiratory Rate',
    BP_Systolic_mmHg: 'BP Systolic (mmHg)',
    BP_Diastolic_mmHg: 'BP Diastolic (mmHg)',
    Hb_g_dl: 'Hb (g/dL)',
    CycleR_I: 'Cycle Regularity',
    Cycle_length_days: 'Cycle Length (days)',
    Marriage_Status_years: 'Marriage Status (yrs)',
    Pregnant: 'Pregnant',
    No_of_abortions: 'No. of Abortions',
    LH_mIU_mL: 'LH (mIU/mL)',
    FSH_mIU_mL: 'FSH (mIU/mL)',
    FSH_LH: 'LH / FSH Ratio',
    AMH_ng_mL: 'AMH (ng/mL)',
    PRL_ng_mL: 'PRL (ng/mL)',
    Vit_D3_ng_mL: 'Vitamin D3 (ng/mL)',
    PRG_ng_mL: 'Progesterone (ng/mL)',
    TSH_mIU_L: 'TSH (mIU/L)',
    RBS_mg_dl: 'RBS (mg/dL)',
    Hip_inch: 'Hip (in)',
    Waist_inch: 'Waist (in)',
    Waist_hip_ratio: 'Waist-Hip Ratio',
    Follicle_no_L: 'Follicles Left',
    Follicle_no_R: 'Follicles Right',
    Avg_F_size_L_mm: 'Avg Follicle L (mm)',
    Avg_F_size_R_mm: 'Avg Follicle R (mm)',
    Endometrium_mm: 'Endometrium (mm)',
    ultrasound_modality: 'Ultrasound Modality',
    Weight_gain: 'Weight Gain',
    Hair_growth: 'Hair Growth',
    Skin_darkening: 'Skin Darkening',
    Hair_loss: 'Hair Loss',
    Pimples: 'Pimples',
    Fast_food: 'Fast Food',
    Reg_Exercise: 'Regular Exercise'
  };

  var CLINICAL_FIELD_ORDER = [
    'Age_yrs', 'Weight_kg', 'Height_cm', 'BMI', 'Blood_Group', 'Pulse_rate_bpm', 'RR_breath_min',
    'BP_Systolic_mmHg', 'BP_Diastolic_mmHg', 'Hb_g_dl', 'CycleR_I', 'Cycle_length_days',
    'Marriage_Status_years', 'Pregnant', 'No_of_abortions', 'AMH_ng_mL', 'LH_mIU_mL', 'FSH_mIU_mL',
    'FSH_LH', 'PRL_ng_mL', 'Vit_D3_ng_mL', 'PRG_ng_mL', 'TSH_mIU_L', 'RBS_mg_dl', 'Hip_inch',
    'Waist_inch', 'Waist_hip_ratio', 'Follicle_no_L', 'Follicle_no_R', 'Avg_F_size_L_mm',
    'Avg_F_size_R_mm', 'Endometrium_mm', 'ultrasound_modality', 'Weight_gain', 'Hair_growth',
    'Skin_darkening', 'Hair_loss', 'Pimples', 'Fast_food', 'Reg_Exercise'
  ];

  function valuesEqual(a, b) {
    if (a === b) return true;
    var na = Number(a);
    var nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return String(a).trim() === String(b).trim();
  }

  function formatFieldLabel(key) {
    if (CLINICAL_FIELD_LABELS[key]) return CLINICAL_FIELD_LABELS[key];
    return String(key)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (ch) { return ch.toUpperCase(); });
  }

  function getEntrySnapshot(entry) {
    return entry && (entry.frozen_parameters || entry.clinical_inputs) ? (entry.frozen_parameters || entry.clinical_inputs) : {};
  }

  function normalizeSnapshot(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (key) {
      var canonical = SNAPSHOT_KEY_TO_CANONICAL[key] || key;
      if (SNAPSHOT_SKIP_KEYS[canonical]) return;
      var value = raw[key];
      if (!hasMeaningfulValue(value)) return;
      out[canonical] = value;
    });
    return out;
  }

  function snapshotToItems(snapshot) {
    var keys = Object.keys(snapshot);
    keys.sort(function (a, b) {
      var ai = CLINICAL_FIELD_ORDER.indexOf(a);
      var bi = CLINICAL_FIELD_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return keys.map(function (key) {
      return { label: formatFieldLabel(key), value: snapshot[key] };
    });
  }

  function buildModifiedSnapshotItems(currentSnapshot, previousSnapshot) {
    var current = normalizeSnapshot(currentSnapshot);
    var previous = previousSnapshot ? normalizeSnapshot(previousSnapshot) : {};
    var keys = Object.keys(current);
    var changedKeys = keys.filter(function (key) {
      if (!hasMeaningfulValue(current[key])) return false;
      if (!Object.prototype.hasOwnProperty.call(previous, key)) return true;
      return !valuesEqual(current[key], previous[key]);
    });
    changedKeys.sort(function (a, b) {
      var ai = CLINICAL_FIELD_ORDER.indexOf(a);
      var bi = CLINICAL_FIELD_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return changedKeys.map(function (key) {
      return { label: formatFieldLabel(key), value: current[key] };
    });
  }

  function hasSnapshotData(snapshot) {
    return Object.keys(normalizeSnapshot(snapshot)).length > 0;
  }

  function buildSnapshotDetail(entry, previousEntry) {
    var currentSnapshot = getEntrySnapshot(entry);
    var previousSnapshot = previousEntry ? getEntrySnapshot(previousEntry) : null;
    var currentHasData = hasSnapshotData(currentSnapshot);
    var previousHasData = previousSnapshot && hasSnapshotData(previousSnapshot);
    var title = 'Inputs recorded in this screening';

    if (!currentHasData) {
      return {
        title: title,
        html:
          '<p class="pcode-history-detail__empty">No clinical inputs were captured for this screening run. Re-save from Detect after filling clinical fields (or symptoms) so this timeline can show what changed.</p>'
      };
    }

    var allItems = snapshotToItems(normalizeSnapshot(currentSnapshot));
    var changedItems = previousHasData
      ? buildModifiedSnapshotItems(currentSnapshot, previousSnapshot)
      : [];
    var changedKeys = {};
    changedItems.forEach(function (item) {
      changedKeys[item.label] = true;
    });

    var html = '';
    if (previousHasData) {
      title = 'Recorded inputs for this screening';
      if (changedItems.length === 0) {
        html +=
          '<p class="pcode-history-detail__note">No input values changed from the previous run — showing everything recorded below.</p>';
      } else {
        html +=
          '<p class="pcode-history-detail__note"><strong>' +
          changedItems.length +
          '</strong> input' +
          (changedItems.length === 1 ? '' : 's') +
          ' updated vs the previous run (highlighted).</p>';
        html += '<div class="pcode-history-metrics pcode-history-metrics--changed mb-3">';
        changedItems.forEach(function (item) {
          html +=
            '<div class="pcode-history-metric pcode-history-metric--updated">' +
              '<span class="pcode-history-metric__label">' + escapeHtml(item.label) + '</span>' +
              '<span class="pcode-history-metric__value">' + formatMetricValue(item.value) + '</span>' +
            '</div>';
        });
        html += '</div>';
        html += '<p class="pcode-history-detail__subtitle">All recorded inputs</p>';
      }
    }

    html += '<div class="pcode-history-metrics pcode-history-metrics--key">';
    allItems.forEach(function (item) {
      var updated = !!changedKeys[item.label];
      html +=
        '<div class="pcode-history-metric' + (updated ? ' pcode-history-metric--updated' : '') + '">' +
          '<span class="pcode-history-metric__label">' + escapeHtml(item.label) + '</span>' +
          '<span class="pcode-history-metric__value">' + formatMetricValue(item.value) + '</span>' +
        '</div>';
    });
    html += '</div>';
    return { title: title, html: html };
  }

  function buildScoreBar(entry) {
    var pct = entry.confidence_percent;
    var width = pct !== null && pct !== undefined ? Math.max(0, Math.min(100, pct)) : 0;
    var variant = entry.status_code === 'positive' ? 'positive' : (entry.status_code === 'negative' ? 'negative' : 'pending');
    var label = pct !== null && pct !== undefined ? Number(pct).toFixed(1) + '%' : 'N/A';

    return (
      '<div class="pcode-history-score">' +
        '<div class="pcode-history-score__track" role="presentation">' +
          '<div class="pcode-history-score__fill pcode-history-score__fill--' + escapeHtml(variant) + '" style="width:' + width + '%"></div>' +
        '</div>' +
        '<span class="pcode-history-score__value">' + escapeHtml(label) + '</span>' +
      '</div>'
    );
  }

  function buildHistoryEntry(entry, previousEntry) {
    var dateParts = String(entry.created_at_display || entry.created_at || '').split('·');
    var dateMain = (dateParts[0] || '').trim();
    var dateTime = (dateParts[1] || '').trim();
    var entryId = Number(entry.diagnosis_id);
    var isExpanded = Number(expandedDiagnosisId) === entryId && Number.isFinite(entryId) && entryId > 0;
    var snapshotDetail = buildSnapshotDetail(entry, previousEntry);
    var mode = currentMode();

    return (
      '<article class="pcode-history-entry" data-diagnosis-id="' + escapeHtml(entryId) + '">' +
        '<div class="pcode-history-entry__rail" aria-hidden="true"><span class="pcode-history-entry__dot"></span></div>' +
        '<div class="pcode-history-entry__body">' +
          '<div class="pcode-history-entry__head">' +
            '<div class="pcode-history-entry__datetime">' +
              '<span class="pcode-history-date">' + escapeHtml(dateMain || entry.created_at) + '</span>' +
              (dateTime ? '<span class="pcode-history-date__time">' + escapeHtml(dateTime) + '</span>' : '') +
            '</div>' +
            '<div class="pcode-history-entry__badges">' +
              '<span class="pcode-history-badge ' + escapeHtml(entry.status_badge_class) + '">' + escapeHtml(entry.status_label) + '</span>' +
              '<span class="pcode-history-badge ' + escapeHtml(entry.origin_badge_class) + '">' + escapeHtml(entry.origin_label) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="pcode-history-entry__score-row">' +
            '<span class="pcode-history-entry__score-label">' + escapeHtml(mode.scoreLabel) + '</span>' +
            buildScoreBar(entry) +
          '</div>' +
          '<button type="button" class="pcode-history-snapshot-toggle" data-history-toggle="' + escapeHtml(entryId) + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '">' +
            '<span>' + (isExpanded ? 'Hide recorded inputs' : 'View recorded inputs') + '</span>' +
            '<svg class="pcode-history-snapshot-toggle__chevron' + (isExpanded ? ' is-open' : '') + '" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">' +
              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>' +
            '</svg>' +
          '</button>' +
          (isExpanded
            ? '<div class="pcode-history-detail" id="history-detail-' + escapeHtml(entryId) + '">' +
                '<p class="pcode-history-detail__title">' + escapeHtml(snapshotDetail.title) + '</p>' +
                snapshotDetail.html +
              '</div>'
            : '') +
        '</div>' +
      '</article>'
    );
  }

  function renderHistory(entries, meta) {
    var root = getRoot();
    var countEl = getCountEl();
    if (!root) return;

    cachedEntries = entries || [];
    cachedMeta = meta || null;

    if (!entries || entries.length === 0) {
      if (countEl) countEl.textContent = '0 runs';
      renderEmpty(meta && meta.message ? meta.message : null);
      if (activeUserMode && global.PcodeUserCare && typeof global.PcodeUserCare.initHistoryCare === 'function') {
        try { global.PcodeUserCare.initHistoryCare([]); } catch (_) {}
      }
      return;
    }

    if (countEl) countEl.textContent = entries.length + (entries.length === 1 ? ' run' : ' runs');

    if (activeUserMode && global.PcodeUserCare && typeof global.PcodeUserCare.initHistoryCare === 'function') {
      try {
        global.PcodeUserCare.initHistoryCare(entries);
      } catch (careErr) {
        console.warn('[PcodeDiagnosisHistory] care compare', careErr);
      }
    }

    root.innerHTML =
      '<div class="pcode-history-timeline" role="list" aria-label="' + escapeHtml(currentMode().listLabel) + '">' +
        entries.map(function (entry, index) {
          return buildHistoryEntry(entry, entries[index + 1] || null);
        }).join('') +
      '</div>';

    root.querySelectorAll('[data-history-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-history-toggle'));
        if (!Number.isFinite(id) || id <= 0) return;
        expandedDiagnosisId = Number(expandedDiagnosisId) === id ? null : id;
        renderHistory(cachedEntries, cachedMeta);
      });
    });
  }

  function authHeaders() {
    var token =
      sessionStorage.getItem('PMOS_auth_token') ||
      localStorage.getItem('PMOS_auth_token') ||
      localStorage.getItem('token') ||
      '';
    var headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function parsePatientNumericId(patientId) {
    if (patientId == null || patientId === '') return null;
    if (typeof patientId === 'number' && patientId > 0) return patientId;
    var raw = String(patientId);
    if (/^(?:PCOS|PMOS)-\d+$/i.test(raw)) {
      return parseInt(raw.replace(/^(?:PCOS|PMOS)-/i, ''), 10);
    }
    var n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function loadPatientHistory(patientId) {
    activeUserMode = false;
    var numericId = parsePatientNumericId(patientId);
    activePatientId = numericId;
    expandedDiagnosisId = null;

    if (!numericId) {
      renderEmpty('Save this patient profile first. Diagnosis history is recorded automatically after each screening run.');
      var countEl = getCountEl();
      if (countEl) countEl.textContent = '';
      return Promise.resolve();
    }

    renderLoading();

    return fetch(
      (typeof global.pcodeApiUrl === 'function'
        ? global.pcodeApiUrl('diagnostics/get_patient_history.php?patient_id=' + encodeURIComponent(numericId))
        : 'https://p-code-nqak.onrender.com/api/diagnostics/get_patient_history?patient_id=' + encodeURIComponent(numericId)),
      {
      method: 'GET',
      headers: authHeaders(),
      credentials: 'include'
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        }).catch(function () {
          return { ok: false, data: { success: false, message: 'Invalid server response' } };
        });
      })
      .then(function (result) {
        if (activePatientId !== numericId || activeUserMode) return;
        if (!result.ok || !result.data || !result.data.success) {
          renderError((result.data && result.data.message) || 'Failed to load diagnosis history.');
          return;
        }
        renderHistory(result.data.history || [], result.data);
      })
      .catch(function (err) {
        console.error('[PcodeDiagnosisHistory]', err);
        if (activePatientId === numericId && !activeUserMode) {
          renderError('Network error while loading diagnosis history.');
        }
      });
  }

  function loadUserHistory() {
    activeUserMode = true;
    activePatientId = null;
    expandedDiagnosisId = null;

    var root = getRoot();
    if (!root) return Promise.resolve();

    renderLoading();

    return fetch(
      (typeof global.pcodeApiUrl === 'function'
        ? global.pcodeApiUrl('diagnostics/get_user_history.php')
        : 'https://p-code-nqak.onrender.com/api/diagnostics/get_user_history'),
      {
      method: 'GET',
      headers: authHeaders(),
      credentials: 'include'
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, status: response.status, data: data };
        }).catch(function () {
          return { ok: false, status: 0, data: { success: false, message: 'Invalid server response' } };
        });
      })
      .then(function (result) {
        if (!activeUserMode) return;
        if (result.status === 401 || result.status === 403) {
          renderEmpty((result.data && result.data.message) || 'Sign in to view your screening history.');
          var countEl = getCountEl();
          if (countEl) countEl.textContent = '';
          return;
        }
        if (!result.ok || !result.data || !result.data.success) {
          renderError((result.data && result.data.message) || 'Failed to load screening history.');
          return;
        }
        renderHistory(result.data.history || [], result.data);
      })
      .catch(function (err) {
        console.error('[PcodeDiagnosisHistory] user', err);
        if (activeUserMode) {
          renderError('Network error while loading screening history.');
        }
      });
  }

  function clearPatientHistory() {
    activePatientId = null;
    activeUserMode = false;
    expandedDiagnosisId = null;
    cachedEntries = [];
    cachedMeta = null;
    var root = document.getElementById(SELECTORS.patient.root);
    if (root) root.innerHTML = '';
    var countEl = document.getElementById(SELECTORS.patient.count);
    if (countEl) countEl.textContent = '';
  }

  function clearUserHistory() {
    activeUserMode = false;
    expandedDiagnosisId = null;
    cachedEntries = [];
    cachedMeta = null;
    var root = document.getElementById(SELECTORS.user.root);
    if (root) root.innerHTML = '';
    var countEl = document.getElementById(SELECTORS.user.count);
    if (countEl) countEl.textContent = '';
  }

  function refreshPatientHistory() {
    if (!activePatientId) return Promise.resolve();
    return loadPatientHistory(activePatientId);
  }

  function refreshUserHistory() {
    return loadUserHistory();
  }

  global.PcodeDiagnosisHistory = {
    THRESHOLD: THRESHOLD,
    loadPatientHistory: loadPatientHistory,
    clearPatientHistory: clearPatientHistory,
    refreshPatientHistory: refreshPatientHistory,
    loadUserHistory: loadUserHistory,
    clearUserHistory: clearUserHistory,
    refreshUserHistory: refreshUserHistory,
    parsePatientNumericId: parsePatientNumericId
  };
})(typeof window !== 'undefined' ? window : globalThis);
