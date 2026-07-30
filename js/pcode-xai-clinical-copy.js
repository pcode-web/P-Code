/**
 * Clinical-facing labels and copy for XAI multi-modal dashboards.
 */
(function (global) {
  const LABELS = {
    chartHeading: 'Diagnostic Source Agreement',
    attributionHeading: 'Attribution split',
    clinicalSeries: 'Clinical & Lab Metrics',
    imagingSeries: 'Ultrasound Morphology',
    integratedSeries: 'Integrated Diagnostic Risk',
    axisClinical: 'Clinical & Lab Metrics',
    axisImaging: 'Ultrasound Morphology',
    axisIntegrated: 'Integrated Diagnostic Risk',
    axisClinicalShort: 'Clinical',
    axisImagingShort: 'Ultrasound',
    axisIntegratedShort: 'Integrated',
    axisClinicalMedium: 'Clinical & Labs',
    axisImagingMedium: 'Ultrasound',
    axisIntegratedMedium: 'Integrated Risk',
    weightClinical: 'Clinical Indicator Weight',
    weightImaging: 'Ultrasound Marker Weight',
    weightIntegrated: 'Integrated Diagnostic Risk',
    integratedInfo:
      'Calculated by dynamically fusing clinical indicators and ultrasound morphology patterns using our dual AI models.'
  };

  const GRADCAM_CAPTION_CORE =
    'Smooth AI attention heatmap with light grain, weighted toward peripheral follicles (string of pearls) — ' +
    '<strong>Red</strong> highest AI model attribution, <strong>Yellow/Green</strong> moderate, ' +
    '<strong>Blue/Cyan</strong> lower. 40% overlay over grayscale ultrasound (60% base).';

  function gradcamHeatmapCaptionHtml(portal) {
    if (portal === 'user') {
      return (
        '<span class="font-semibold text-violet-100">How to read this:</span> ' +
        GRADCAM_CAPTION_CORE
          .replace(/<strong>/g, '<strong class="text-white">')
      );
    }
    return '<span class="font-semibold">How to read:</span> ' + GRADCAM_CAPTION_CORE;
  }

  function gradcamUnavailableMessage(portal) {
    const msg =
      'This may occur if: no ultrasound image is available for this patient, the AI model is not accessible, or there is an issue with the imaging analysis.';
    if (portal === 'user') {
      return '<span class="text-sm text-violet-300/75">' + msg + '</span>';
    }
    return '<span class="text-sm text-gray-600">' + msg + '</span>';
  }

  function buildGradcamInterpretationHtml(imagingScore, meta, portal) {
    const scoreText = Number(imagingScore).toFixed(2);
    const isPositive = meta && meta.classification === 'Positive';
    const threshold = meta && meta.threshold != null ? meta.threshold : 75;
    const isUser = portal === 'user';

    const bandLegend = isUser
      ? `
          <ul class="text-sm text-violet-100/90 list-none space-y-2 ml-4">
            <li><span class="px-2 py-1 rounded" style="background:#eb3232;color:#fff">■</span> <span class="font-semibold text-white">Red (70–100%):</span> Peak follicle zones</li>
            <li><span class="px-2 py-1 rounded" style="background:#f5d728;color:#333">■</span> <span class="font-semibold text-white">Yellow (50–70%):</span> High-confidence bounds</li>
            <li><span class="px-2 py-1 rounded" style="background:#28c364;color:#fff">■</span> <span class="font-semibold text-white">Green (25–50%):</span> Low-relevance regions</li>
            <li><span class="px-2 py-1 rounded" style="background:#1e50dc;color:#fff">■</span> <span class="font-semibold text-white">Blue (10–25%):</span> Peripheral baseline</li>
            <li><span class="px-2 py-1 bg-white/10 rounded text-violet-100">■</span> <span class="font-semibold text-white">Grayscale base:</span> Underlying ultrasound at 60% blend weight</li>
          </ul>`
      : `
          <ul class="text-sm text-gray-700 list-none space-y-2 ml-4">
            <li><span class="px-2 py-1 rounded" style="background:#eb3232;color:#fff">■</span> <span class="font-semibold">Red (70–100%):</span> Peak follicle zones</li>
            <li><span class="px-2 py-1 rounded" style="background:#f5d728;color:#333">■</span> <span class="font-semibold">Yellow (50–70%):</span> High-confidence bounds</li>
            <li><span class="px-2 py-1 rounded" style="background:#28c364;color:#fff">■</span> <span class="font-semibold">Green (25–50%):</span> Low-relevance regions</li>
            <li><span class="px-2 py-1 rounded" style="background:#1e50dc;color:#fff">■</span> <span class="font-semibold">Blue (10–25%):</span> Peripheral baseline</li>
            <li><span class="px-2 py-1 bg-gray-200 rounded">■</span> <span class="font-semibold">Grayscale base:</span> Underlying ultrasound at 60% blend weight</li>
          </ul>`;

    const titleClass = isUser ? 'font-semibold text-white' : 'font-semibold';
    const bodyClass = isUser ? 'text-sm text-violet-100/90' : 'text-sm text-gray-700';
    const labelClass = isUser ? 'font-semibold text-white' : 'font-semibold';

    const positiveBody =
      'The AI model met the ' + threshold + '% positive imaging threshold. The four-band attention map highlights activation intensity over follicular regions.';
    const negativeBody =
      'The AI model scored below the ' + threshold + '% positive partition. The same four-band map shows relative activation tiers on this negative screening.';

    if (isPositive) {
      return (
        '<div class="space-y-3">' +
        '<p><span class="' + titleClass + '">AI Heatmap Image Interpretation (PMOS Positive):</span></p>' +
        '<p class="' + bodyClass + '">' + positiveBody + '</p>' +
        bandLegend +
        '<p class="' + bodyClass + ' mt-3"><span class="' + labelClass + '">Clinical context:</span> Imaging score ' + scoreText + '%. Warmer overlay zones should align with follicular regions of interest.</p>' +
        '</div>'
      );
    }
    return (
      '<div class="space-y-3">' +
      '<p><span class="' + titleClass + '">AI Heatmap Image Interpretation (PMOS Negative):</span></p>' +
      '<p class="' + bodyClass + '">' + negativeBody + '</p>' +
      bandLegend +
      '<p class="' + bodyClass + ' mt-3"><span class="' + labelClass + '">Clinical context:</span> Imaging score ' + scoreText + '%.</p>' +
      '</div>'
    );
  }

  /** Attribution bar tone — risk severity (rose / amber / green), distinct from nav purple. */
  function integratedRiskBarVariant(overallDiagnosis, confidencePct) {
    const neon = global.PcodeEchartNeon;
    if (neon && typeof neon.normalizeDiagnosisState === 'function') {
      const state = neon.normalizeDiagnosisState(overallDiagnosis);
      if (state === 'positive') return 'positive';
      if (state === 'negative') return 'negative';
      return 'borderline';
    }
    const pct = Number(confidencePct);
    if (pct >= 50) return 'positive';
    if (pct >= 30) return 'borderline';
    return 'negative';
  }

  function buildDiagnosticSummary(confidencePct, clinicalPct, imagingPct, hasImaging) {
    const risk = Number(confidencePct).toFixed(2);
    const clinical = Number(clinicalPct).toFixed(2);
    const imaging = Number(imagingPct).toFixed(2);

    let driverPhrase;
    if (hasImaging) {
      if (imagingPct >= clinicalPct) {
        driverPhrase =
          'driven strongly by Ultrasound Morphology (' +
          imaging +
          '% correlation with cystic follicle clusters) alongside supportive Clinical & Lab Metrics (' +
          clinical +
          '% contribution)';
      } else {
        driverPhrase =
          'driven primarily by Clinical & Lab Metrics (' +
          clinical +
          '% contribution) with corroborating Ultrasound Morphology (' +
          imaging +
          '% correlation with cystic follicle clusters)';
      }
    } else {
      driverPhrase =
        'driven by Clinical & Lab Metrics (' + clinical + '% contribution)';
    }

    return (
      '<span class="font-semibold">Diagnostic Summary:</span> The system indicates an Integrated Diagnostic Risk of ' +
      risk +
      '% for PMOS. This assessment is ' +
      driverPhrase +
      '.'
    );
  }

  function wireIntegratedRiskInfo(btnId, popoverId) {
    const btn = document.getElementById(btnId);
    const pop = document.getElementById(popoverId);
    if (!btn || !pop) return;

    const close = function () {
      pop.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    };

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const open = pop.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    document.addEventListener('click', function (e) {
      if (!pop.contains(e.target) && e.target !== btn) close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
  }

  const FEATURE_ACRONYMS = new Set([
    'BMI', 'LH', 'FSH', 'AMH', 'TSH', 'RBS', 'HCG', 'PMOS', 'HB', 'BP', 'PRL', 'PRG'
  ]);

  function normalizeFeatureKey(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  const FEATURE_UNIT_BY_KEY = {
    ageyrs: 'yrs',
    age: 'yrs',
    weightkg: 'kg',
    heightcm: 'cm',
    height: 'cm',
    pulseratebpm: 'bpm',
    pulserate: 'bpm',
    rrbreathmin: 'breaths/min',
    respiratoryrate: 'breaths/min',
    bpsystolicmmhg: 'mmHg',
    bpdiastolicmmhg: 'mmHg',
    bpsystolic: 'mmHg',
    bpdiastolic: 'mmHg',
    hbgdl: 'g/dL',
    hemoglobin: 'g/dL',
    cyclelengthdays: 'days',
    cyclelength: 'days',
    marriagestatusyears: 'yrs',
    marriagestatus: 'yrs',
    amhngml: 'ng/mL',
    amh: 'ng/mL',
    fshmiuml: 'mIU/mL',
    fsh: 'mIU/mL',
    lhmiuml: 'mIU/mL',
    lh: 'mIU/mL',
    tshmiuml: 'mIU/L',
    tsh: 'mIU/L',
    prlngml: 'ng/mL',
    prolactin: 'ng/mL',
    vitd3ngml: 'ng/mL',
    vitamind3: 'ng/mL',
    prgngml: 'ng/mL',
    progesterone: 'ng/mL',
    rbsmgdl: 'mg/dL',
    randombloodsugar: 'mg/dL',
    hipinch: 'in',
    waistinch: 'in',
    avgfsizelmm: 'mm',
    avgfsizermm: 'mm',
    avgfolliclesize: 'mm',
    endometriummm: 'mm',
    endometrium: 'mm',
    ibetahcgmiuml: 'mIU/mL',
    iibetahcgmiuml: 'mIU/mL'
  };

  function extractUnitFromFeatureName(raw) {
    const text = String(raw || '');
    const paren = text.match(/\(([^)]+)\)\s*$/);
    if (paren) {
      const inner = paren[1].trim();
      if (/^(y\/n|yes\/no|r\/i)$/i.test(inner)) return '';
      if (/^yrs?$/i.test(inner) || /^years?$/i.test(inner)) return 'yrs';
      return inner
        .replace(/^breaths\/min$/i, 'breaths/min')
        .replace(/^g\/dl$/i, 'g/dL')
        .replace(/^ng\/ml$/i, 'ng/mL')
        .replace(/^miu\/ml$/i, 'mIU/mL')
        .replace(/^miu\/l$/i, 'mIU/L')
        .replace(/^mg\/dl$/i, 'mg/dL')
        .replace(/^inches?$/i, 'in')
        .replace(/^mmhg$/i, 'mmHg');
    }

    const suffixMatch = text.match(/_(yrs?|years?|kg|cm|mm|bpm|inch|days|ng_mL|mIU_mL|mIU_L|mg_dl|g_dl)$/i);
    if (suffixMatch) {
      const s = suffixMatch[1].toLowerCase();
      if (s === 'yr' || s === 'yrs' || s === 'year' || s === 'years') return 'yrs';
      if (s === 'ng_ml') return 'ng/mL';
      if (s === 'miu_ml') return 'mIU/mL';
      if (s === 'miu_l') return 'mIU/L';
      if (s === 'mg_dl') return 'mg/dL';
      if (s === 'g_dl') return 'g/dL';
      if (s === 'inch') return 'in';
      return s;
    }

    const key = normalizeFeatureKey(text);
    if (FEATURE_UNIT_BY_KEY[key]) return FEATURE_UNIT_BY_KEY[key];
    // Prefer longer keys first so "avgfolliclesize" wins over generic matches
    const keys = Object.keys(FEATURE_UNIT_BY_KEY).sort(function (a, b) {
      return b.length - a.length;
    });
    for (let i = 0; i < keys.length; i++) {
      const pattern = keys[i];
      if (pattern.length >= 4 && key.indexOf(pattern) !== -1) {
        return FEATURE_UNIT_BY_KEY[pattern];
      }
    }
    return '';
  }

  function titleCaseFeatureLabel(text) {
    const cleaned = String(text || '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return 'Key factor';
    return cleaned
      .split(' ')
      .map(function (word) {
        const upper = word.toUpperCase();
        if (FEATURE_ACRONYMS.has(upper)) return upper;
        if (/^[A-Z]{2,}$/.test(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');
  }

  /** Strip (Y/N), (yrs), and unit parentheses from contributor labels. */
  function cleanFeatureLabel(raw) {
    let text = String(raw || '');
    text = text
      .replace(/\s*\(y\/n\)\s*/gi, ' ')
      .replace(/\s*\(yes\/no\)\s*/gi, ' ')
      .replace(/\s*\(r\/i\)\s*/gi, ' ')
      .replace(/\s*\(yrs?\)\s*/gi, ' ')
      .replace(/\s*\(years?\)\s*/gi, ' ')
      .replace(/\s*\((?:kg|cm|mm|bpm|in(?:ch(?:es)?)?|days|g\/dL|ng\/mL|mIU\/mL|mIU\/L|mg\/dL|mmHg|breaths\/min)\)\s*/gi, ' ')
      .replace(/_(yrs?|years?)\b/gi, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return titleCaseFeatureLabel(text);
  }

  function isBooleanFeatureName(name) {
    const key = normalizeFeatureKey(name);
    const booleanKeys = [
      'weightgain', 'hairgrowth', 'skindarkening', 'hairloss', 'pimples', 'acne',
      'fastfood', 'regexercise', 'regularexercise', 'pregnant', 'pregnancystatus'
    ];
    return booleanKeys.some(function (k) {
      return key === k || key.indexOf(k) !== -1;
    });
  }

  function isCycleFeatureName(name) {
    const lower = String(name || '').toLowerCase();
    const key = normalizeFeatureKey(name);
    return (
      (lower.indexOf('cycle') !== -1 && lower.indexOf('regularity') !== -1) ||
      lower.indexOf('cycle(r/i)') !== -1 ||
      key.indexOf('cycleri') !== -1 ||
      key === 'cycler'
    );
  }

  function formatNumericWithUnit(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    let rounded;
    if (Math.abs(n) >= 100) rounded = String(Math.round(n * 100) / 100).replace(/\.0+$/, '');
    else if (Number.isInteger(n)) rounded = String(n);
    else rounded = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
    return unit ? rounded + ' ' + unit : rounded;
  }

  /**
   * Format top-contributor label + observed value (units on the value, not the label).
   * @returns {{ label: string, value: string }}
   */
  function formatFeatureContributor(name, rawValue) {
    const label = cleanFeatureLabel(name);
    const unit = extractUnitFromFeatureName(name);

    if (rawValue === null || rawValue === undefined || rawValue === '' || rawValue === 'N/A') {
      return { label: label, value: '—' };
    }

    if (isCycleFeatureName(name)) {
      const val = parseFloat(rawValue);
      if (!isNaN(val)) {
        return {
          label: label || 'Cycle Regularity',
          value: val === 0 || val < 0.5 ? 'Regular' : 'Irregular'
        };
      }
      return { label: label || 'Cycle Regularity', value: String(rawValue) };
    }

    if (isBooleanFeatureName(name)) {
      if (rawValue === 'Yes' || rawValue === 'No') return { label: label, value: rawValue };
      if (rawValue === 0 || rawValue === 1 || rawValue === '0' || rawValue === '1') {
        return { label: label, value: rawValue === 1 || rawValue === '1' ? 'Yes' : 'No' };
      }
      const n = Number(rawValue);
      if (Number.isFinite(n)) {
        return { label: label, value: n > 0 ? 'Yes' : 'No' };
      }
      return { label: label, value: String(rawValue) };
    }

    if (typeof rawValue === 'string' && /[a-zA-Z]/.test(rawValue) && !/^-?\d+(\.\d+)?$/.test(String(rawValue).trim())) {
      return { label: label, value: rawValue };
    }

    return { label: label, value: formatNumericWithUnit(rawValue, unit) };
  }

  global.PcodeXaiClinical = {
    LABELS: LABELS,
    buildDiagnosticSummary: buildDiagnosticSummary,
    integratedRiskBarVariant: integratedRiskBarVariant,
    wireIntegratedRiskInfo: wireIntegratedRiskInfo,
    gradcamHeatmapCaptionHtml: gradcamHeatmapCaptionHtml,
    buildGradcamInterpretationHtml: buildGradcamInterpretationHtml,
    gradcamUnavailableMessage: gradcamUnavailableMessage,
    cleanFeatureLabel: cleanFeatureLabel,
    formatFeatureContributor: formatFeatureContributor,
    extractUnitFromFeatureName: extractUnitFromFeatureName
  };
})(typeof window !== 'undefined' ? window : globalThis);
