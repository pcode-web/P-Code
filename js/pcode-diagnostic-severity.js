/**
 * P-Code — shared diagnostic severity classification & text-only DOM styling
 */
(function (global) {
  'use strict';

  var SEVERITY_KEYS = ['positive', 'borderline', 'negative', 'pending'];
  var SEVERITY_TEXT_PREFIX = 'pcode-severity-text--';
  var SEVERITY_PILL_PREFIX = 'pcode-severity-pill--';
  var THRESHOLD_NEGATIVE_MAX = 54;
  var THRESHOLD_BORDERLINE_MAX = 74;
  var THRESHOLD_POSITIVE_MIN = 75;

  function normalizeSeverityLabel(label) {
    var s = String(label || '').trim().toLowerCase().replace(/\.\.\./g, '');
    if (s === 'positive') return 'positive';
    if (s === 'borderline') return 'borderline';
    if (s === 'negative') return 'negative';
    if (s === 'analyzing') return 'pending';
    return 'pending';
  }

  function classifyProbThreeWay(p) {
    var n = Number(p);
    if (!Number.isFinite(n)) return { label: 'Pending', severity: 'pending' };
    if (n <= THRESHOLD_NEGATIVE_MAX) return { label: 'Negative', severity: 'negative' };
    if (n <= THRESHOLD_BORDERLINE_MAX) return { label: 'Borderline', severity: 'borderline' };
    return { label: 'Positive', severity: 'positive' };
  }

  function classifyProbUser(p) {
    return classifyProbThreeWay(p);
  }

  function severityFromProvider(probability, threshold) {
    return classifyProbThreeWay(probability);
  }

  function probabilityToDiagnosisCode(p) {
    var result = classifyProbThreeWay(p);
    if (result.severity === 'positive') return 1;
    if (result.severity === 'borderline') return 2;
    if (result.severity === 'negative') return 0;
    return null;
  }

  function stripSeverityClasses(el, prefix, keys) {
    if (!el) return;
    keys.forEach(function (k) {
      el.classList.remove(prefix + k);
    });
  }

  function clearParentPillTint(el) {
    if (!el || !el.parentElement) return;
    if (el.parentElement.classList.contains('pcode-kv-pill')) {
      stripSeverityClasses(el.parentElement, SEVERITY_PILL_PREFIX, SEVERITY_KEYS);
    }
  }

  /** Apply semantic text color only — never tint parent container backgrounds. */
  function applyDiagnosticSeverity(el, labelOrSeverity, options) {
    if (!el) return;
    var severity = SEVERITY_KEYS.indexOf(labelOrSeverity) >= 0
      ? labelOrSeverity
      : normalizeSeverityLabel(labelOrSeverity);

    stripSeverityClasses(el, SEVERITY_TEXT_PREFIX, SEVERITY_KEYS);
    el.classList.remove(
      'text-green-600', 'text-red-600', 'text-yellow-600', 'text-gray-600',
      'text-rose-400', 'text-amber-400', 'text-emerald-400', 'text-slate-400'
    );
    el.style.color = '';
    clearParentPillTint(el);

    el.classList.add(SEVERITY_TEXT_PREFIX + severity);
    // XAI prediction summary values use their own typography; never attach
    // .pcode-kv-value (that class forces detect-page sizes/weights).
    if (el.classList.contains('pcode-xai-summary-value')) {
      el.classList.remove('pcode-kv-value');
    } else if (!el.classList.contains('pcode-kv-value') && el.tagName !== 'SPAN') {
      el.classList.add('pcode-kv-value');
    }
  }

  function setFinalDiagnosisBadge(el, text) {
    if (!el) return;
    var label = String(text || '').trim() || 'Pending';
    var severity = normalizeSeverityLabel(label);
    var base = 'mt-3 block text-sm sm:text-base font-black uppercase tracking-widest';
    if (label.toLowerCase().indexOf('analyzing') === 0) {
      base += ' normal-case tracking-normal font-semibold';
    }
    el.textContent = label;
    el.className = base + ' ' + SEVERITY_TEXT_PREFIX + severity;
    el.setAttribute('role', 'status');
  }

  function applyNeonProgressVariant(barEl, variant) {
    if (!barEl) return;
    ['clinical', 'imaging', 'positive', 'negative', 'borderline', 'pending'].forEach(function (v) {
      barEl.classList.remove('pcode-neon-bar-fill--' + v);
    });
    barEl.classList.add('pcode-neon-bar-fill', 'pcode-neon-bar-fill--' + (variant || 'clinical'));
  }

  function resolveSeverityForResult(probability, options) {
    var opts = options || {};
    if (opts.isRegularUser) {
      return classifyProbUser(probability);
    }
    if (opts.unreliable) {
      return { label: 'Pending', severity: 'pending' };
    }
    return severityFromProvider(probability, opts.threshold);
  }

  global.PcodeDiagnosticSeverity = {
    SEVERITY_KEYS: SEVERITY_KEYS,
    THRESHOLD_NEGATIVE_MAX: THRESHOLD_NEGATIVE_MAX,
    THRESHOLD_BORDERLINE_MAX: THRESHOLD_BORDERLINE_MAX,
    THRESHOLD_POSITIVE_MIN: THRESHOLD_POSITIVE_MIN,
    normalizeSeverityLabel: normalizeSeverityLabel,
    classifyProbThreeWay: classifyProbThreeWay,
    classifyProbUser: classifyProbUser,
    severityFromProvider: severityFromProvider,
    probabilityToDiagnosisCode: probabilityToDiagnosisCode,
    resolveSeverityForResult: resolveSeverityForResult,
    applyDiagnosticSeverity: applyDiagnosticSeverity,
    setFinalDiagnosisBadge: setFinalDiagnosisBadge,
    applyNeonProgressVariant: applyNeonProgressVariant
  };
})(typeof window !== 'undefined' ? window : global);
