/**
 * P-Code — Regular-user care helpers (kept surface only)
 * Result story + metric tooltips (Home), history score compare, Detect draft chrome.
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtPct(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return null;
    return (Math.floor(v * 100) / 100).toFixed(2) + '%';
  }

  function labelOf(diag) {
    var d = String(diag || '').toLowerCase();
    if (d === 'negative') return 'Negative';
    if (d === 'borderline') return 'Borderline';
    if (d === 'positive') return 'Positive';
    return 'Pending';
  }

  function bandExplain(label) {
    var L = String(label || '').toLowerCase();
    if (L === 'negative') {
      return {
        meaning:
          'Your latest overall screening landed in the lower band. That can be reassuring, but it is not a clean bill of health by itself.',
        notMeaning:
          'It does not rule out PMOS, and it is not a medical diagnosis. Symptoms and clinician judgment still matter.',
        questions: [
          'Do my symptoms still warrant lab work or an ultrasound review?',
          'Which lifestyle or cycle patterns should I track before our next visit?',
          'When should I re-screen if something changes?'
        ]
      };
    }
    if (L === 'borderline') {
      return {
        meaning:
          'Your overall screening sits in a middle band — more information (labs and/or ultrasound) often clarifies the picture.',
        notMeaning:
          'Borderline is not a diagnosis and not a reason to panic. It is a signal to prepare questions and fill gaps calmly.',
        questions: [
          'Which missing inputs would help most before we interpret this further?',
          'Should we repeat any labs or imaging?',
          'What symptoms should prompt me to book sooner?'
        ]
      };
    }
    if (L === 'positive') {
      return {
        meaning:
          'Your overall screening is in the higher band. Use this as preparation for a clinician conversation — bring your summary and questions.',
        notMeaning:
          'This is not a confirmed PMOS diagnosis. Only a clinician can diagnose and recommend treatment.',
        questions: [
          'What confirmatory tests would you recommend?',
          'How do my symptoms and labs fit together?',
          'What short-term next steps make sense for me?'
        ]
      };
    }
    return {
      meaning:
        'Complete a Detect run and save your record to unlock a plain-language summary here.',
      notMeaning:
        'P-Code does not diagnose. Education and screening summaries support conversations with clinicians.',
      questions: [
        'What should I bring to my first appointment about cycle or hormone concerns?',
        'Which symptoms are most important to mention?'
      ]
    };
  }

  function buildResultStory(overall, xg, cnn) {
    var label = labelOf(overall && overall.diagnosis);
    var story = bandExplain(label);
    var parts = [];
    if (xg && xg.diagnosis) {
      parts.push('Clinical model: ' + labelOf(xg.diagnosis) + (fmtPct(xg.probability) ? ' (' + fmtPct(xg.probability) + ')' : ''));
    } else {
      parts.push('Clinical model: Pending');
    }
    if (cnn && cnn.diagnosis) {
      parts.push('Imaging model: ' + labelOf(cnn.diagnosis) + (fmtPct(cnn.probability) ? ' (' + fmtPct(cnn.probability) + ')' : ''));
    } else {
      parts.push('Imaging model: Pending');
    }
    if (overall && overall.diagnosis) {
      parts.push('Overall: ' + label + (fmtPct(overall.probability) ? ' (' + fmtPct(overall.probability) + ')' : ''));
    } else {
      parts.push('Overall: Pending');
    }
    return {
      label: label,
      headline: overall && overall.diagnosis ? 'What your screening suggests' : 'Your screening story',
      summaryLine: parts.length ? parts.join(' · ') : 'No saved screening yet.',
      meaning: story.meaning,
      notMeaning: story.notMeaning,
      questions: story.questions,
      overall: overall || null,
      xg: xg || null,
      cnn: cnn || null
    };
  }

  function renderResultStory(el, story) {
    if (!el || !story) return;
    el.hidden = false;
    el.removeAttribute('hidden');
    el.classList.remove('hidden');
    el.innerHTML =
      '<div class="pcode-care-card__head">' +
        '<h3 class="pcode-care-card__title">' + esc(story.headline) + '</h3>' +
        '<p class="pcode-care-card__meta">' + esc(story.summaryLine) + '</p>' +
      '</div>' +
      '<div class="pcode-care-story-grid">' +
        '<div class="pcode-care-story-block">' +
          '<h4>What this means</h4>' +
          '<p>' + esc(story.meaning) + '</p>' +
        '</div>' +
        '<div class="pcode-care-story-block">' +
          '<h4>What this does not mean</h4>' +
          '<p>' + esc(story.notMeaning) + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="pcode-care-story-block pcode-care-story-block--questions">' +
        '<h4>Questions to bring to your clinician</h4>' +
        '<ul>' +
          story.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') +
        '</ul>' +
      '</div>';
  }

  var TOOLTIP_COPY = {
    imaging: 'Imaging uses your ultrasound (when provided) to estimate a screening band. Optional — you can still screen without it.',
    clinical: 'Clinical uses the symptoms, measurements, and lab values you entered on Detect.',
    overall: 'Overall combines available clinical and imaging signals into one plain-language screening band. Not a diagnosis.'
  };

  function applyMetricTooltips(root) {
    var scope = root || document;
    var tips = [
      { sel: '#my-screening-cnn-card .pcode-metric-label', tip: TOOLTIP_COPY.imaging },
      { sel: '#my-screening-xg-card .pcode-metric-label', tip: TOOLTIP_COPY.clinical },
      { sel: '#my-screening-overall-card .pcode-metric-label', tip: TOOLTIP_COPY.overall }
    ];
    tips.forEach(function (t) {
      var el = scope.querySelector(t.sel);
      if (!el) return;
      el.setAttribute('title', t.tip);
      el.setAttribute('aria-description', t.tip);
      if (!el.querySelector('.pcode-care-tip')) {
        var tip = document.createElement('span');
        tip.className = 'pcode-care-tip';
        tip.setAttribute('tabindex', '0');
        tip.setAttribute('role', 'img');
        tip.setAttribute('aria-label', t.tip);
        tip.textContent = '?';
        tip.title = t.tip;
        el.appendChild(tip);
      }
    });
  }

  function getDraftPeek() {
    try {
      if (global.PcodeFormAutosave && typeof global.PcodeFormAutosave.buildDraftKey === 'function') {
        var key = global.PcodeFormAutosave.buildDraftKey('clinical_user', 'self');
        var raw = localStorage.getItem(key);
        if (!raw) return null;
        var draft = JSON.parse(raw);
        if (!draft || !draft.fields) return null;
        var filled = Object.keys(draft.fields).filter(function (k) {
          var v = draft.fields[k];
          return v !== '' && v !== null && v !== undefined && v !== false;
        }).length;
        return { savedAt: draft.savedAt, filled: filled, step: draft.meta && draft.meta.step };
      }
    } catch (_) {}
    return null;
  }

  function renderDetectDraftChrome() {
    var bar = document.getElementById('pcode-detect-draft-bar');
    if (!bar) return;
    var draft = getDraftPeek();
    if (!draft || draft.filled < 1) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    var when = '';
    try {
      when = draft.savedAt ? new Date(draft.savedAt).toLocaleString() : '';
    } catch (_) {}
    bar.hidden = false;
    bar.innerHTML =
      '<p><strong>Draft autosave is on.</strong> Your clinical inputs are saved on this device' +
      (when ? ' (last: ' + esc(when) + ')' : '') +
      '. Leave and come back anytime — use Save draft if the browser asks.</p>';
  }

  function deltaText(curr, prev) {
    if (curr == null || prev == null || !Number.isFinite(Number(curr)) || !Number.isFinite(Number(prev))) {
      return '—';
    }
    var d = Number(curr) - Number(prev);
    var sign = d > 0 ? '+' : '';
    return sign + d.toFixed(1) + ' pts';
  }

  function renderHistoryCompare(el, entries) {
    if (!el) return;
    if (!entries || entries.length < 2) {
      el.hidden = true;
      el.classList.add('hidden');
      el.innerHTML = entries && entries.length === 1
        ? '<p class="pcode-care-card__meta">Save another screening to unlock last-vs-previous comparison.</p>'
        : '';
      if (entries && entries.length === 1) {
        el.hidden = false;
        el.classList.remove('hidden');
      }
      return;
    }
    var latest = entries[0];
    var prev = entries[1];
    el.hidden = false;
    el.classList.remove('hidden');
    el.innerHTML =
      '<h3 class="pcode-care-card__title">What changed</h3>' +
      '<p class="pcode-care-card__meta">Latest run vs the one before — scores only. Expand a timeline entry for input diffs.</p>' +
      '<div class="pcode-care-compare">' +
        '<div class="pcode-care-compare__col">' +
          '<span class="pcode-care-compare__label">Latest</span>' +
          '<strong>' + esc(latest.status_label || labelOf(latest.status_code)) + '</strong>' +
          '<span>' + esc(latest.confidence_percent != null ? Number(latest.confidence_percent).toFixed(1) + '%' : '—') + '</span>' +
          '<time>' + esc(latest.created_at_display || latest.created_at || '') + '</time>' +
        '</div>' +
        '<div class="pcode-care-compare__delta">' + esc(deltaText(latest.confidence_percent, prev.confidence_percent)) + '</div>' +
        '<div class="pcode-care-compare__col">' +
          '<span class="pcode-care-compare__label">Previous</span>' +
          '<strong>' + esc(prev.status_label || labelOf(prev.status_code)) + '</strong>' +
          '<span>' + esc(prev.confidence_percent != null ? Number(prev.confidence_percent).toFixed(1) + '%' : '—') + '</span>' +
          '<time>' + esc(prev.created_at_display || prev.created_at || '') + '</time>' +
        '</div>' +
      '</div>';
  }

  function markPageVisit(page) {
    try {
      localStorage.setItem('PMOS_visited_' + page, '1');
    } catch (_) {}
  }

  var lastStory = null;

  function initHomeCare(ctx) {
    ctx = ctx || {};
    lastStory = buildResultStory(ctx.overall, ctx.xg, ctx.cnn);
    renderResultStory(document.getElementById('ru-result-story'), lastStory);
    applyMetricTooltips(document.getElementById('my-screening-card'));
  }

  function initHistoryCare(entries) {
    markPageVisit('history');
    renderHistoryCompare(document.getElementById('user-history-compare'), entries || []);
  }

  function initDetectCare() {
    renderDetectDraftChrome();
  }

  function initXaiCare() {
    markPageVisit('xai');
  }

  global.PcodeUserCare = {
    buildResultStory: buildResultStory,
    initHomeCare: initHomeCare,
    initHistoryCare: initHistoryCare,
    initDetectCare: initDetectCare,
    initXaiCare: initXaiCare,
    getDraftPeek: getDraftPeek,
    applyMetricTooltips: applyMetricTooltips
  };
})(typeof window !== 'undefined' ? window : globalThis);
