/**
 * P-Code — Chart.js theme sync (dark mode + pcode-theme-change).
 * ECharts are handled by pcode-echart-neon-bars.js.
 */
(function (global) {
  'use strict';

  var registry = new Set();

  var PALETTE = {
    dark: {
      grid: 'rgba(255, 255, 255, 0.08)',
      tick: 'rgba(158, 154, 169, 0.95)',
      text: 'rgba(237, 233, 254, 0.92)',
      tooltipBg: 'rgba(30, 41, 59, 0.96)',
      tooltipText: '#ffffff'
    },
    light: {
      grid: 'rgba(0, 0, 0, 0.28)',
      tick: '#000000',
      text: '#000000',
      tooltipBg: '#ffffff',
      tooltipText: '#000000'
    }
  };

  function isDark() {
    return document.documentElement.classList.contains('dark');
  }

  function palette() {
    return isDark() ? PALETTE.dark : PALETTE.light;
  }

  function applyToChart(chart) {
    if (!chart || typeof chart.update !== 'function') return;
    var pal = palette();
    var opts = chart.options || chart.config?.options;
    if (!opts) return;

    if (opts.scales) {
      Object.keys(opts.scales).forEach(function (key) {
        var scale = opts.scales[key];
        if (!scale) return;
        scale.grid = Object.assign({}, scale.grid, { color: pal.grid });
        scale.ticks = Object.assign({}, scale.ticks, { color: pal.tick });
        if (scale.title) {
          scale.title = Object.assign({}, scale.title, { color: pal.text });
        }
      });
    }

    opts.plugins = opts.plugins || {};
    if (opts.plugins.legend && opts.plugins.legend.labels) {
      opts.plugins.legend.labels.color = pal.text;
    }
    if (opts.plugins.title) {
      opts.plugins.title.color = pal.text;
    }
    if (opts.plugins.tooltip) {
      opts.plugins.tooltip.backgroundColor = pal.tooltipBg;
      opts.plugins.tooltip.titleColor = pal.tooltipText;
      opts.plugins.tooltip.bodyColor = pal.tooltipText;
      opts.plugins.tooltip.borderColor = isDark() ? 'rgba(148, 163, 184, 0.35)' : '#e2e8f0';
    }

    try {
      chart.update('none');
    } catch (_) {
      try {
        chart.update();
      } catch (e2) {}
    }
  }

  function refreshAll() {
    registry.forEach(applyToChart);
    if (global.Chart && global.Chart.instances) {
      Object.keys(global.Chart.instances).forEach(function (id) {
        applyToChart(global.Chart.instances[id]);
      });
    }
  }

  function register(chart) {
    if (chart) registry.add(chart);
  }

  function unregister(chart) {
    registry.delete(chart);
  }

  global.addEventListener('pcode-theme-change', refreshAll);

  global.PcodeChartTheme = {
    register: register,
    unregister: unregister,
    refreshAll: refreshAll,
    palette: palette
  };
})(typeof window !== 'undefined' ? window : this);
