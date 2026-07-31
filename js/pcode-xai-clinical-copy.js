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

  function _escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _fmtPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    const pct = v >= 0 && v <= 1 ? v * 100 : v;
    return Math.max(0, Math.min(100, pct));
  }

  function _diagnosisBand(diagnosis, scorePct) {
    const d = String(diagnosis || '').toLowerCase();
    if (d === 'positive' || d === '1') return 'Positive';
    if (d === 'borderline' || d === '2') return 'Borderline';
    if (d === 'negative' || d === '0') return 'Negative';
    const p = Number(scorePct);
    if (!Number.isFinite(p)) return 'Pending';
    if (p <= 54) return 'Negative';
    if (p <= 74) return 'Borderline';
    return 'Positive';
  }

  function _riskPhrase(band, scorePct) {
    if (band === 'Positive') {
      return scorePct >= 90
        ? 'a high likelihood signal'
        : 'an elevated likelihood signal';
    }
    if (band === 'Borderline') return 'an intermediate / borderline signal';
    if (band === 'Negative') return 'a lower likelihood signal';
    return 'an incomplete signal';
  }

  function _bandGuidance(band, isUser) {
    if (band === 'Positive') {
      return isUser
        ? 'This does <strong>not</strong> confirm a diagnosis on its own. It means your entered details look more like patterns the model often sees in PCOS/PMOS-positive cases. A clinician can review labs, symptoms, and imaging with you.'
        : 'Treat as a screening flag for clinician review—not a standalone diagnosis. Correlate with Rotterdam/NIH criteria, labs, and imaging before care decisions.';
    }
    if (band === 'Borderline') {
      return isUser
        ? 'Results sit in a middle zone—some factors lean one way, others another. Bring this summary to a clinician if you have symptoms or questions; small data corrections can change the result.'
        : 'Borderline outputs warrant chart review for missing labs, cycle timing, or ultrasound quality before repeating screening.';
    }
    if (band === 'Negative') {
      return isUser
        ? 'The model did not find a strong PCOS/PMOS pattern from the details provided. If symptoms continue, still speak with a clinician—screening tools can miss cases.'
        : 'Lower-likelihood output; still reconcile with clinical presentation. Persistent symptoms may warrant further work-up regardless of model score.';
    }
    return isUser
      ? 'More complete clinical or imaging analysis is needed before interpreting this summary.'
      : 'Insufficient modality data for a confident narrative—complete clinical and/or imaging analysis.';
  }

  /**
   * Comprehensive plain-language clinical summary placed after SHAP charts.
   * @param {object} opts
   * @param {number} opts.overallScore
   * @param {string} opts.overallDiagnosis
   * @param {Array} opts.features
   * @param {string} [opts.patientName]
   * @param {'user'|'provider'} [opts.portal]
   * @param {number|null} [opts.clinicalScore]
   * @param {number|null} [opts.imagingScore]
   */
  function buildShapClinicalSummary(opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const isUser = String(options.portal || 'user').toLowerCase() !== 'provider';
    const features = Array.isArray(options.features) ? options.features.slice() : [];
    const overallPct = _fmtPct(options.overallScore);
    const clinicalPct = _fmtPct(options.clinicalScore);
    const imagingPct = _fmtPct(options.imagingScore);
    const band = _diagnosisBand(options.overallDiagnosis, overallPct);
    const riskPhrase = _riskPhrase(band, overallPct == null ? 0 : overallPct);
    const who = isUser ? 'your' : "this patient's";
    const you = isUser ? 'you' : 'the patient';

    // Both user + provider XAI pages use the dark bento canvas.
    // Light chips (bg-rose-50) + white text from dark-theme CSS = unreadable.
    const titleClass = 'font-semibold text-white';
    const bodyClass = 'text-violet-100/90';
    const mutedClass = 'text-violet-300/80';
    const chipRaise =
      'pcode-xai-shap-chip pcode-xai-shap-chip--raise bg-rose-500/20 text-rose-100 border border-rose-400/30';
    const chipLower =
      'pcode-xai-shap-chip pcode-xai-shap-chip--lower bg-emerald-500/20 text-emerald-100 border border-emerald-400/30';

    if (!features.length) {
      return (
        '<div class="space-y-3">' +
        '<p class="' + bodyClass + '">' +
        (isUser
          ? 'A clinical summary could not be built yet. Save a screening on Detect, then reopen XAI Insights.'
          : 'Feature-level detail is not available for this case yet. Re-run analysis or confirm interpretability data was generated.') +
        '</p></div>'
      );
    }

    const ranked = features
      .map(function (f) {
        return {
          name: f.name,
          value: f.value,
          contribution: Number(f.contribution),
          importance: Number(f.importance)
        };
      })
      .filter(function (f) {
        return Number.isFinite(f.contribution) || Number.isFinite(f.importance);
      })
      .sort(function (a, b) {
        const ba = Math.abs(Number.isFinite(b.contribution) ? b.contribution : b.importance || 0);
        const aa = Math.abs(Number.isFinite(a.contribution) ? a.contribution : a.importance || 0);
        return ba - aa;
      });

    const raisers = ranked.filter(function (f) {
      return Number(f.contribution) > 0;
    }).slice(0, 4);
    const lowerers = ranked.filter(function (f) {
      return Number(f.contribution) < 0;
    }).slice(0, 4);
    const top = ranked[0];

    function factorItem(f) {
      const fmt = formatFeatureContributor(f.name, f.value);
      const mag = Math.abs(Number.isFinite(f.contribution) ? f.contribution : 0);
      const magText = Number.isFinite(mag) ? mag.toFixed(1) + '% relative influence' : '';
      const valueBit =
        fmt.value && fmt.value !== '—'
          ? ' <span class="' + mutedClass + '">(recorded: ' + _escapeHtml(fmt.value) + ')</span>'
          : '';
      return (
        '<li class="leading-relaxed">' +
        '<strong class="' + titleClass + '">' +
        _escapeHtml(fmt.label || 'Key factor') +
        '</strong>' +
        valueBit +
        (magText ? ' — ' + magText : '') +
        '</li>'
      );
    }

    const scoreLine =
      overallPct == null
        ? 'Overall probability is still pending.'
        : 'Overall model probability: <strong class="' +
          titleClass +
          '">' +
          overallPct.toFixed(2) +
          '%</strong> (' +
          _escapeHtml(band) +
          ').';

    const modalityBits = [];
    if (clinicalPct != null) {
      modalityBits.push('clinical/lab pathway ~' + clinicalPct.toFixed(2) + '%');
    }
    if (imagingPct != null) {
      modalityBits.push('ultrasound pathway ~' + imagingPct.toFixed(2) + '%');
    }
    const modalityLine = modalityBits.length
      ? '<p class="' + bodyClass + '">Source mix for this case: ' + modalityBits.join('; ') + '.</p>'
      : '';

    const topName = top ? _escapeHtml(formatFeatureContributor(top.name, top.value).label) : '';
    const topDir =
      top && Number(top.contribution) >= 0
        ? 'raised'
        : 'lowered';
    const topSentence = topName
      ? '<p class="' +
        bodyClass +
        '">The single strongest local factor was <strong class="' +
        titleClass +
        '">' +
        topName +
        '</strong>, which ' +
        topDir +
        ' the model’s PCOS/PMOS likelihood for ' +
        who +
        ' case.</p>'
      : '';

    const raiseBlock = raisers.length
      ? '<div class="rounded-xl px-4 py-3 ' +
        chipRaise +
        '">' +
        '<p class="font-semibold mb-2 text-inherit">What pushed the result toward higher concern</p>' +
        '<ul class="list-disc pl-5 space-y-1.5 text-inherit">' +
        raisers.map(factorItem).join('') +
        '</ul></div>'
      : '';

    const lowerBlock = lowerers.length
      ? '<div class="rounded-xl px-4 py-3 ' +
        chipLower +
        '">' +
        '<p class="font-semibold mb-2 text-inherit">What helped lower concern</p>' +
        '<ul class="list-disc pl-5 space-y-1.5 text-inherit">' +
        lowerers.map(factorItem).join('') +
        '</ul></div>'
      : '';

    const nextSteps = isUser
      ? '<ul class="list-disc pl-5 space-y-1.5 ' +
        bodyClass +
        '">' +
        '<li>Compare the top factors above with what ' +
        you +
        ' entered on Detect—fix typos or missing labs if needed, then re-analyze.</li>' +
        '<li>If an ultrasound was used, check that the scan is clear, well lit, and fully in frame.</li>' +
        '<li>Share this page (or a PDF export) with a clinician; ask how these factors fit ' +
        who +
        ' history and exam.</li>' +
        '<li>Do not start, stop, or change medication based only on this AI summary.</li>' +
        '</ul>'
      : '<ul class="list-disc pl-5 space-y-1.5 ' +
        bodyClass +
        '">' +
        '<li>Verify top contributors against the chart, labs, and ultrasound quality.</li>' +
        '<li>If Cycle / FSH–LH / follicle counts dominate, confirm timing relative to menses and assay units.</li>' +
        '<li>Use this narrative with Grad-CAM (if present) as an audit trail for the visit note—not as diagnostic criteria.</li>' +
        '<li>Document clinical judgment when model output and bedside assessment disagree.</li>' +
        '</ul>';

    return (
      '<div class="space-y-5">' +
      '<section>' +
      '<h3 class="text-lg ' +
      titleClass +
      ' mb-2">At a glance</h3>' +
      '<p class="' +
      bodyClass +
      '">Based on ' +
      who +
      ' screening inputs, the system shows ' +
      riskPhrase +
      ' for PCOS/PMOS. ' +
      scoreLine +
      '</p>' +
      modalityLine +
      '<p class="' +
      bodyClass +
      ' mt-2">' +
      _bandGuidance(band, isUser) +
      '</p>' +
      '</section>' +
      '<section>' +
      '<h3 class="text-lg ' +
      titleClass +
      ' mb-2">How to read the charts above</h3>' +
      '<p class="' +
      bodyClass +
      '">The force / contribution chart shows which details pushed the score <strong>up</strong> (toward higher concern) or <strong>down</strong> (toward lower concern). Longer bars mean stronger influence <em>for this case</em>. The ranking chart highlights which factors matter most in magnitude overall.</p>' +
      topSentence +
      '</section>' +
      (raiseBlock || lowerBlock
        ? '<section class="space-y-3">' +
          '<h3 class="text-lg ' +
          titleClass +
          ' mb-1">Key factors in plain language</h3>' +
          raiseBlock +
          lowerBlock +
          '</section>'
        : '') +
      '<section>' +
      '<h3 class="text-lg ' +
      titleClass +
      ' mb-2">Suggested next steps</h3>' +
      nextSteps +
      '</section>' +
      '<p class="text-sm ' +
      mutedClass +
      ' italic">Educational screening aid only—not a medical diagnosis or treatment plan. Interpretability describes model behavior, not proven cause-and-effect.</p>' +
      '</div>'
    );
  }

  global.PcodeXaiClinical = {
    LABELS: LABELS,
    buildDiagnosticSummary: buildDiagnosticSummary,
    buildShapClinicalSummary: buildShapClinicalSummary,
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
