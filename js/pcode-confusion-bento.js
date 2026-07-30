/**
 * P-Code — Confusion matrix heatmap (2×2 bento grid)
 * XGBoost: purple ramp · CNN: blue ramp (intensity ∝ cell count)
 */
(function (global) {
  'use strict';

  var CELL_META = [
    { row: 0, col: 0, type: 'TN', correct: true },
    { row: 0, col: 1, type: 'FN', correct: false },
    { row: 1, col: 0, type: 'FP', correct: false },
    { row: 1, col: 1, type: 'TP', correct: true }
  ];

  var PALETTES = {
    purple: ['#05030c', '#1a0d36', '#4c1d95', '#6d28d9', '#a855f7'],
    blue: ['#030712', '#0c1929', '#1e3a8a', '#2563eb', '#60a5fa']
  };

  var PALETTES_LIGHT = {
    purple: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9'],
    blue: ['#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8']
  };

  function isLightTheme() {
    var html = document.documentElement;
    if (!html) return false;
    if (html.getAttribute('data-pcode-theme') === 'light') return true;
    return !html.classList.contains('dark');
  }

  function matrixFromInput(cm) {
    if (!cm) return null;
    if (Array.isArray(cm) && cm.length >= 2) {
      return [
        [Number(cm[0][0]) || 0, Number(cm[0][1]) || 0],
        [Number(cm[1][0]) || 0, Number(cm[1][1]) || 0]
      ];
    }
    if (typeof cm.tn === 'number') {
      return [
        [cm.tn, cm.fp],
        [cm.fn, cm.tp]
      ];
    }
    return null;
  }

  function maxCell(matrix) {
    var max = 0;
    for (var r = 0; r < matrix.length; r++) {
      for (var c = 0; c < matrix[r].length; c++) {
        if (matrix[r][c] > max) max = matrix[r][c];
      }
    }
    return max || 1;
  }

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    function clamp(n) {
      return Math.max(0, Math.min(255, Math.round(n)));
    }
    return (
      '#' +
      [r, g, b]
        .map(function (n) {
          return clamp(n).toString(16).padStart(2, '0');
        })
        .join('')
    );
  }

  function lerpRamp(ramp, t) {
    var stops = ramp.length - 1;
    var pos = Math.max(0, Math.min(1, t)) * stops;
    var i = Math.floor(pos);
    var f = pos - i;
    if (i >= stops) {
      return ramp[ramp.length - 1];
    }
    var a = hexToRgb(ramp[i]);
    var b = hexToRgb(ramp[i + 1]);
    return rgbToHex(a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f);
  }

  function cellIntensity(value, maxVal) {
    if (maxVal <= 0 || value <= 0) return 0;
    return Math.max(0.08, Math.min(1, value / maxVal));
  }

  function inferPalette(domId) {
    var id = String(domId || '').toLowerCase();
    if (id.indexOf('cnn') !== -1) return 'blue';
    if (id.indexOf('xgboost') !== -1 || id.indexOf('xgb') !== -1) return 'purple';
    return 'purple';
  }

  function resolvePalette(opts, domId) {
    if (opts && opts.palette === 'blue') return 'blue';
    if (opts && opts.palette === 'purple') return 'purple';
    return inferPalette(domId);
  }

  function cellStyle(value, maxVal, paletteKey) {
    var light = isLightTheme();
    var ramp = (light ? PALETTES_LIGHT : PALETTES)[paletteKey] || (light ? PALETTES_LIGHT : PALETTES).purple;
    var t = cellIntensity(value, maxVal);
    var bg = lerpRamp(ramp, t);
    var border =
      paletteKey === 'blue'
        ? light
          ? 'rgba(37, 99, 235, ' + (0.25 + t * 0.4) + ')'
          : 'rgba(96, 165, 250, ' + (0.22 + t * 0.45) + ')'
        : light
          ? 'rgba(109, 40, 217, ' + (0.25 + t * 0.4) + ')'
          : 'rgba(167, 139, 250, ' + (0.22 + t * 0.45) + ')';
    var glow = light
      ? 'none'
      : paletteKey === 'blue'
        ? 'inset 0 0 24px rgba(37, 99, 235, ' + (t * 0.35) + ')'
        : 'inset 0 0 24px rgba(124, 58, 237, ' + (t * 0.35) + ')';
    return (
      'background:' +
      bg +
      ';border-color:' +
      border +
      ';box-shadow:' +
      glow
    );
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatCount(n) {
    var v = Number(n);
    if (!isFinite(v)) return '0';
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  }

  function defaultLabels() {
    return {
      actualNegative: 'Actual Negative',
      actualPositive: 'Actual Positive',
      predictedNegative: 'Pred. Negative',
      predictedPositive: 'Pred. Positive'
    };
  }

  function buildMarkup(matrix, opts, paletteKey) {
    var labels = Object.assign(defaultLabels(), opts || {});
    var maxVal = maxCell(matrix);

    var cellsHtml = CELL_META.map(function (meta) {
      var value = matrix[meta.row][meta.col];
      var style = cellStyle(value, maxVal, paletteKey);
      return (
        '<div class="pcb-cm-cell" role="gridcell" style="' +
        esc(style) +
        '" aria-label="' +
        esc(meta.type) +
        ': ' +
        esc(formatCount(value)) +
        '">' +
        '<span class="pcb-cm-cell__count">' +
        esc(formatCount(value)) +
        '</span>' +
        '<span class="pcb-cm-cell__type">' +
        esc(meta.type) +
        '</span>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="pcb-cm-bento-simple pcb-cm-bento--' +
      esc(paletteKey) +
      ' w-full max-w-lg mx-auto">' +
      '<div class="pcb-cm-labels pcb-cm-labels--actual grid grid-cols-2 gap-2 text-center text-xs font-semibold uppercase tracking-wide pcode-diagnostic-muted" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));">' +
      '<span>' +
      esc(labels.actualNegative) +
      '</span>' +
      '<span>' +
      esc(labels.actualPositive) +
      '</span>' +
      '</div>' +
      '<div class="pcb-cm-grid grid grid-cols-2 gap-2" role="grid" aria-label="Confusion matrix heatmap" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));">' +
      cellsHtml +
      '</div>' +
      '<div class="pcb-cm-labels pcb-cm-labels--predicted grid grid-cols-2 gap-2 text-center text-xs font-semibold uppercase tracking-wide pcode-diagnostic-muted" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));">' +
      '<span>' +
      esc(labels.predictedNegative) +
      '</span>' +
      '<span>' +
      esc(labels.predictedPositive) +
      '</span>' +
      '</div>' +
      '</div>'
    );
  }

  function disposeEcharts(dom) {
    if (typeof global.echarts === 'undefined' || !dom) return;
    var inst = global.echarts.getInstanceByDom(dom);
    if (inst) inst.dispose();
  }

  function render(domId, cm, opts) {
    var dom = document.getElementById(domId);
    var matrix = matrixFromInput(cm);
    if (!dom || !matrix) return false;

    var paletteKey = resolvePalette(opts, domId);

    disposeEcharts(dom);
    dom.className =
      'pcb-confusion-bento-host pcb-cm-bento--ready pcb-cm-bento-host--' +
      paletteKey +
      ' overflow-visible';
    dom.setAttribute('role', 'region');
    dom.innerHTML = buildMarkup(matrix, opts, paletteKey);
    return true;
  }

  global.PcodeConfusionBento = {
    matrixFromInput: matrixFromInput,
    palettes: PALETTES,
    render: render
  };
})(typeof window !== 'undefined' ? window : this);
