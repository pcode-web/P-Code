/**
 * P-Code — ECharts bar styling aligned with patients table neon score bars
 * (pcode-patient-score-fill--clinical / --imaging / --final-*).
 */
(function (global) {
  'use strict';

  const VARIANTS = {
    clinical: {
      stops: ['#8b5cf6', '#c4b5fd', '#e9d5ff'],
      glow: 'rgba(196, 181, 253, 0.32)'
    },
    imaging: {
      stops: ['#6366f1', '#a5b4fc', '#c7d2fe'],
      glow: 'rgba(165, 180, 252, 0.3)'
    },
    positive: {
      stops: ['#991b1b', '#dc2626', '#fca5a5'],
      glow: 'rgba(248, 113, 113, 0.48)'
    },
    negative: {
      stops: ['#14532d', '#16a34a', '#86efac'],
      glow: 'rgba(74, 222, 128, 0.45)'
    },
    muted: {
      stops: ['#7c3aed', '#a78bfa', '#ddd6fe'],
      glow: 'rgba(167, 139, 250, 0.28)'
    },
    consensus: {
      stops: ['#8b5cf6', '#c4b5fd', '#f3e8ff'],
      glow: 'rgba(196, 181, 253, 0.28)'
    }
  };

  function isBento() {
    const b = document.body;
    const html = document.documentElement;
    if (html && html.classList.contains('pcode-app-bento-root')) return true;
    return !!(
      b &&
      (b.classList.contains('pcode-app-bento') ||
        b.classList.contains('xai-bento-page') ||
        b.classList.contains('login-bento-page') ||
        b.classList.contains('pcode-admin-shell'))
    );
  }

  function isDarkTheme() {
    var html = document.documentElement;
    if (!html) return false;
    // Match Tailwind/CSS light rules (`:not(.dark)`). Class is source of truth.
    if (!html.classList.contains('dark')) return false;
    var attr = html.getAttribute('data-pcode-theme');
    if (attr === 'light') return false;
    return true;
  }

  const DARK = {
    tooltipBg: 'rgba(30, 41, 59, 0.96)',
    tooltipBorder: 'rgba(148, 163, 184, 0.35)',
    tooltipText: '#ffffff'
  };

  const LIGHT = {
    tooltipBg: '#ffffff',
    tooltipBorder: '#e2e8f0',
    tooltipText: '#1a102d'
  };

  const LIGHT_BARS = {
    clinical: '#6d28d9',
    imaging: '#4f46e5',
    positive: '#dc2626',
    negative: '#16a34a',
    muted: '#7c3aed',
    consensus: '#6d28d9'
  };

  function gradient(x0, y0, x1, y1, stops) {
    if (typeof echarts === 'undefined' || !echarts.graphic || !echarts.graphic.LinearGradient) {
      return stops[stops.length - 1] || '#c4b5fd';
    }
    const colorStops = stops.map((color, i) => ({
      offset: stops.length === 1 ? 0 : i / (stops.length - 1),
      color
    }));
    return new echarts.graphic.LinearGradient(x0, y0, x1, y1, colorStops);
  }

  function barStopsForTheme(variant, overrideStops) {
    if (overrideStops) return overrideStops;
    const key = VARIANTS[variant] ? variant : 'clinical';
    return VARIANTS[key].stops;
  }

  function itemStyle(variant, options) {
    const opts = options || {};
    const key = VARIANTS[variant] ? variant : 'clinical';
    const v = VARIANTS[key];
    const stops = barStopsForTheme(key, opts.stops);
    const horizontal = !!opts.horizontal;
    const g = gradient(
      horizontal ? 0 : 0,
      horizontal ? 0 : 0,
      horizontal ? 1 : 0,
      horizontal ? 0 : 1,
      stops
    );
    const radius = opts.borderRadius || (horizontal ? [0, 8, 8, 0] : [8, 8, 0, 0]);
    const useNeon = isBento() || opts.forceNeon;
    if (!useNeon) {
      return {
        color: stops[Math.min(1, stops.length - 1)],
        borderRadius: radius
      };
    }
    const dark = isDarkTheme();
    if (!dark && useNeon) {
      const solid = LIGHT_BARS[key] || LIGHT_BARS.clinical;
      return {
        color: solid,
        borderRadius: radius,
        shadowBlur: 0,
        shadowColor: 'transparent',
        shadowOffsetX: 0,
        shadowOffsetY: 0
      };
    }
    return {
      color: g,
      borderRadius: radius,
      shadowBlur: dark
        ? typeof opts.shadowBlur === 'number'
          ? opts.shadowBlur
          : 16
        : 0,
      shadowColor: dark ? opts.shadowColor || v.glow : 'transparent',
      shadowOffsetX: 0,
      shadowOffsetY: 0
    };
  }

  function verticalBar(variant, options) {
    return itemStyle(variant, Object.assign({ horizontal: false }, options || {}));
  }

  /** Solid swatch color for ECharts legend (matches bar fill). */
  function legendColor(variant, fallback) {
    const key = VARIANTS[variant] ? variant : 'clinical';
    if (isBento() && !isDarkTheme()) {
      return LIGHT_BARS[key] || fallback || '#6d28d9';
    }
    const stops = VARIANTS[key].stops;
    return stops[Math.min(1, stops.length - 1)] || fallback || '#c4b5fd';
  }

  function horizontalBar(variant, options) {
    return itemStyle(variant, Object.assign({ horizontal: true }, options || {}));
  }

  /**
   * ECharts bar borderRadius order: [topLeft, topRight, bottomRight, bottomLeft].
   * Bidirectional horizontal bars: round the outward tip only (pill cap toward ± value).
   */
  function horizontalBarRadiusBySign(value, radius) {
    const r = radius == null ? 8 : radius;
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) {
      return [r, r, r, r];
    }
    return n > 0 ? [0, r, r, 0] : [r, 0, 0, r];
  }

  function itemStyleBySign(value, options) {
    const opts = options || {};
    const n = Number(value);
    const radius =
      opts.borderRadius != null
        ? opts.borderRadius
        : horizontalBarRadiusBySign(n, opts.tipRadius != null ? opts.tipRadius : 8);
    return itemStyle(n > 0 ? 'positive' : 'imaging', Object.assign({}, opts, { horizontal: true, borderRadius: radius }));
  }

  function isNarrowChartViewport() {
    return (
      typeof global.matchMedia === 'function' &&
      global.matchMedia('(max-width: 639px)').matches
    );
  }

  function isCompactChartViewport() {
    return (
      typeof global.matchMedia === 'function' &&
      global.matchMedia('(max-width: 1023px)').matches
    );
  }

  /** Grid + axis label defaults for bidirectional SHAP contribution plots. */
  function shapContributionChartLayout() {
    var narrow = isNarrowChartViewport();
    var compact = isCompactChartViewport();
    var tipRadius = narrow ? 6 : compact ? 7 : 8;
    return {
      grid: narrow
        ? { left: 132, right: 24, top: 10, bottom: 30, containLabel: false }
        : compact
          ? { left: 156, right: 28, top: 16, bottom: 34, containLabel: false }
          : { left: 12, right: '12%', top: 30, bottom: 40, containLabel: true },
      yAxisLabel: {
        width: narrow ? 122 : compact ? 172 : 260,
        overflow: 'truncate',
        interval: 0,
        fontSize: narrow ? 10 : compact ? 10 : 11,
        lineHeight: narrow ? 15 : 16,
        margin: narrow ? 8 : compact ? 10 : 16,
        padding: [0, narrow ? 8 : 14, 0, 0],
        align: 'right'
      },
      xAxisLabel: narrow
        ? { fontSize: 9, hideOverlap: true, margin: 8 }
        : compact
          ? { fontSize: 10, hideOverlap: true, margin: 10 }
          : {},
      xAxisName: narrow ? '' : 'Contribution (%)',
      xAxisNameGap: narrow ? 10 : 24,
      chartMinWidth: narrow ? 540 : compact ? 480 : 0,
      barMaxWidth: narrow ? 12 : compact ? 16 : 22,
      barCategoryGap: narrow ? '50%' : compact ? '42%' : '34%',
      tipRadius: tipRadius
    };
  }

  /** Grid + axis label defaults for global SHAP importance ranking. */
  function shapImportanceChartLayout() {
    var narrow = isNarrowChartViewport();
    var compact = isCompactChartViewport();
    var tipRadius = narrow ? 6 : compact ? 7 : 8;
    return {
      grid: narrow
        ? { left: 128, right: 24, top: 10, bottom: 40, containLabel: false }
        : compact
          ? { left: 152, right: 28, top: 20, bottom: 48, containLabel: false }
          : { left: '5%', right: '15%', top: '30px', bottom: '60px', containLabel: true },
      yAxisLabel: {
        width: narrow ? 118 : compact ? 160 : 240,
        overflow: 'truncate',
        interval: 0,
        fontSize: narrow ? 10 : compact ? 10 : 11,
        lineHeight: narrow ? 15 : 16,
        margin: narrow ? 8 : compact ? 10 : 8,
        padding: [0, narrow ? 8 : 12, 0, 0],
        align: 'right'
      },
      xAxisLabel: narrow
        ? { fontSize: 9, hideOverlap: true, margin: 8 }
        : compact
          ? { fontSize: 10, hideOverlap: true, margin: 10 }
          : {},
      xAxisName: narrow ? '' : 'Overall influence (%)',
      xAxisNameGap: narrow ? 26 : compact ? 30 : 35,
      chartMinWidth: narrow ? 520 : compact ? 460 : 0,
      barMaxWidth: narrow ? 12 : compact ? 16 : 20,
      barCategoryGap: narrow ? '50%' : compact ? '42%' : '36%',
      tipRadius: tipRadius
    };
  }

  /** Consensus / comparison bar chart grid insets. */
  function consensusChartGrid() {
    var layout = consensusChartLayout([]);
    return layout.grid;
  }

  /**
   * Full layout for Diagnostic Source Agreement (short labels, legend, bar spacing).
   * @param {string[]} axisCategories full axis labels from clinical copy
   */
  function consensusChartLayout(axisCategories) {
    var narrow = isNarrowChartViewport();
    var compact = isCompactChartViewport();
    var cats = axisCategories || [];
    var L = global.PcodeXaiClinical && global.PcodeXaiClinical.LABELS;
    var shortCategories = cats;
    if (narrow && cats.length === 3) {
      shortCategories = [
        (L && L.axisClinicalShort) || 'Clinical',
        (L && L.axisImagingShort) || 'Ultrasound',
        (L && L.axisIntegratedShort) || 'Integrated'
      ];
    } else if (compact && cats.length === 3) {
      shortCategories = [
        (L && L.axisClinicalMedium) || 'Clinical & Labs',
        (L && L.axisImagingMedium) || 'Ultrasound',
        (L && L.axisIntegratedMedium) || 'Integrated Risk'
      ];
    }
    return {
      grid: narrow
        ? { left: '11%', right: '9%', top: 10, bottom: 58, containLabel: true }
        : compact
          ? { left: '12%', right: '10%', top: 44, bottom: 52, containLabel: true }
          : { left: '15%', right: '15%', top: '40px', bottom: '50px', containLabel: true },
      axisCategories: shortCategories,
      xAxisLabel: narrow
        ? { fontSize: 10, interval: 0, rotate: 0, margin: 10, lineHeight: 14 }
        : compact
          ? { fontSize: 10, interval: 0, rotate: 0, margin: 10, lineHeight: 14 }
          : { fontSize: 11, interval: 0 },
      legend: narrow
        ? responsiveLegendOption({ bottom: 2, top: undefined })
        : compact
          ? responsiveLegendOption({ top: 6, bottom: undefined, itemGap: 12 })
          : { top: 8, itemGap: 16, itemWidth: 14, itemHeight: 14 },
      barMaxWidth: narrow ? 46 : compact ? 48 : 56,
      barCategoryGap: narrow ? '48%' : '34%',
      chartHeight: narrow ? 340 : compact ? 320 : 320
    };
  }

  /** Height for horizontal bar charts from feature count (mobile gets taller scroll area). */
  function xaiHorizontalBarChartHeight(featureCount) {
    var n = Math.max(Number(featureCount) || 0, 4);
    var narrow = isNarrowChartViewport();
    var compact = isCompactChartViewport();
    var perBar = narrow ? 42 : compact ? 38 : 34;
    var chrome = narrow ? 56 : 72;
    var max = narrow ? 620 : 680;
    return Math.min(max, n * perBar + chrome);
  }

  function applyXaiChartHostSizing(chartDom, featureCount, layout) {
    if (!chartDom) return;
    layout = layout || {};
    var count = featureCount || 4;
    var height = xaiHorizontalBarChartHeight(count);
    chartDom.style.height = height + 'px';
    chartDom.style.minHeight = height + 'px';
    chartDom.style.maxHeight = 'none';
    chartDom.style.overflow = 'visible';
    var minW = layout.chartMinWidth || 0;
    var scroll = chartDom.closest('.pcode-chart-scroll') || chartDom.closest('.chart-well');
    var parentW = scroll ? scroll.clientWidth : chartDom.parentElement ? chartDom.parentElement.clientWidth : 0;
    var targetW = minW > 0 ? Math.max(parentW || 0, minW) : parentW;
    if (targetW > 0) {
      chartDom.style.width = targetW + 'px';
      chartDom.style.minWidth = targetW + 'px';
    } else {
      chartDom.style.width = '100%';
      chartDom.style.minWidth = minW > 0 ? minW + 'px' : '';
    }
    if (scroll) {
      scroll.style.webkitOverflowScrolling = 'touch';
      scroll.style.overflowX = minW > 0 ? 'auto' : '';
      scroll.style.overflowY = 'visible';
    }
  }

  function shapContributionBarFallback(value) {
    const n = Number(value);
    const radius = horizontalBarRadiusBySign(n, 8);
    return {
      color: n > 0 ? '#EF4444' : '#3B82F6',
      borderRadius: radius
    };
  }

  function normalizeDiagnosisState(diagnosis) {
    const d = String(diagnosis || '')
      .toLowerCase()
      .trim();
    if (d === 'positive' || d === '1') return 'positive';
    if (d === 'borderline' || d === '2' || d === 'pending') return 'borderline';
    if (d === 'negative' || d === '0') return 'negative';
    return 'borderline';
  }

  function consensusStopsByDiagnosis(diagnosis) {
    const state = normalizeDiagnosisState(diagnosis);
    if (state === 'positive') return ['#f43f5e', '#e11d48'];
    if (state === 'negative') return ['#10b981', '#059669'];
    return ['#f59e0b', '#d97706'];
  }

  function consensusLegendColor(diagnosis) {
    const stops = consensusStopsByDiagnosis(diagnosis);
    return stops[stops.length - 1];
  }

  function consensusBarByDiagnosis(diagnosis, options) {
    const stops = consensusStopsByDiagnosis(diagnosis);
    return verticalBarFromStops(stops[0], stops[1], Object.assign({ forceNeon: isBento() }, options || {}));
  }

  /** Legacy 2-stop vertical gradient (model-performance / dashboard). */
  function barFillVertical(c0, c1) {
    if (!isBento()) return c1 || c0;
    return gradient(0, 0, 0, 1, [c0, c1]);
  }

  /** Full vertical itemStyle with glow from two hex stops. */
  function verticalBarFromStops(c0, c1, options) {
    return itemStyle('clinical', Object.assign({ horizontal: false, stops: [c0, c1] }, options || {}));
  }

  function chartTheme() {
    const d = isBento();
    const dark = isDarkTheme();
    // Light mode: near-black ink on white paper (WCAG). Dark: soft lavender.
    const muted = dark ? 'rgba(233, 213, 254, 0.92)' : '#0f172a';
    const line = dark ? 'rgba(255, 255, 255, 0.18)' : '#94a3b8';
    const text = dark ? 'rgba(250, 247, 255, 0.96)' : '#0f172a';
    const tip = dark ? DARK : LIGHT;
    const legendOpt = d
      ? {
          textStyle: { color: muted, fontWeight: 'bold' },
          pageTextStyle: { color: muted }
        }
      : {};
    return {
      d,
      dark,
      text,
      muted,
      line,
      tooltip: d
        ? {
            backgroundColor: tip.tooltipBg,
            borderColor: tip.tooltipBorder,
            textStyle: { color: tip.tooltipText }
          }
        : {},
      legend: legendOpt,
      axisCat: function (base) {
        if (!d) return base;
        return Object.assign({}, base, {
          axisLabel: Object.assign({}, base.axisLabel, { color: muted }),
          nameTextStyle: Object.assign({}, base.nameTextStyle, { color: muted }),
          axisLine: { show: true, lineStyle: { color: line, width: dark ? 1 : 1.25 } },
          axisTick: { show: true, lineStyle: { color: line } }
        });
      },
      axisVal: function (base) {
        if (!d) return base;
        const split =
          base.splitLine !== false
            ? Object.assign({}, base.splitLine || { show: true }, {
                lineStyle: Object.assign({}, (base.splitLine && base.splitLine.lineStyle) || {}, {
                  color: dark ? line : 'rgba(15, 23, 42, 0.2)',
                  width: 1
                })
              })
            : base.splitLine;
        return Object.assign({}, base, {
          axisLabel: Object.assign({}, base.axisLabel, { color: muted }),
          nameTextStyle: Object.assign({}, base.nameTextStyle, { color: muted }),
          axisLine: { show: true, lineStyle: { color: line, width: dark ? 1 : 1.25 } },
          axisTick: { show: true, lineStyle: { color: line } },
          splitLine: split
        });
      }
    };
  }

  function mapDataWithStyle(values, variant, horizontal) {
    const style = horizontal ? horizontalBar(variant) : verticalBar(variant);
    return (values || []).map(function (val) {
      return { value: val, itemStyle: style };
    });
  }

  function noArcGlow() {
    return { textShadowBlur: 0, textShadowColor: 'transparent', arcGlowBlur: 0, arcGlowColor: 'transparent' };
  }

  /** Light mode gauges — solid orchid/royal purple, bold dark percentage, no glow. */
  function getGaugeVisualsLight(containerId, legacyColor, track) {
    const glowOff = noArcGlow();
    const c = String(legacyColor || '').trim().toUpperCase();
    const trackColor = track || '#e2e8f0';
    const detail = '#1a102d';

    if (containerId === 'clinical-gauge') {
      return Object.assign(glowOff, {
        track: trackColor,
        progress: '#6d28d9',
        detailColor: detail
      });
    }

    if (containerId === 'imaging-gauge') {
      const unreliable = c === '#6B7280' || c === '#9CA3AF' || c === '#71717A';
      return Object.assign(glowOff, {
        track: trackColor,
        progress: unreliable ? '#94a3b8' : '#4f46e5',
        detailColor: detail
      });
    }

    if (containerId === 'final-gauge') {
      const positive = c === '#EF4444' || c === '#DC2626' || c === '#F87171';
      const negative = c === '#22C55E' || c === '#16A34A' || c === '#4ADE80';
      const progress = positive ? '#dc2626' : negative ? '#16a34a' : '#d97706';
      return Object.assign(glowOff, {
        track: trackColor,
        progress: progress,
        detailColor: detail
      });
    }

    return Object.assign(glowOff, {
      track: trackColor,
      progress: '#6d28d9',
      detailColor: detail
    });
  }

  /** Semi-circular gauge palette (clinical / imaging / final diagnosis). */
  function getGaugeVisuals(containerId, legacyColor) {
    const track =
      typeof getComputedStyle !== 'undefined'
        ? getComputedStyle(document.documentElement).getPropertyValue('--pcb-gauge-track').trim() ||
          'rgba(255,255,255,0.05)'
        : 'rgba(255,255,255,0.05)';
    if (!isDarkTheme()) {
      return getGaugeVisualsLight(containerId, legacyColor, track);
    }
    const c = String(legacyColor || '').trim().toUpperCase();

    if (containerId === 'clinical-gauge') {
      return {
        track,
        progress: {
          type: 'linear',
          x: 0,
          y: 1,
          x2: 1,
          y2: 0,
          colorStops: [
            { offset: 0, color: '#1e1b4b' },
            { offset: 0.42, color: '#5b21b6' },
            { offset: 1, color: '#f0abfc' }
          ]
        },
        detailColor: '#ffffff',
        textShadowBlur: 16,
        textShadowColor: 'rgba(232, 121, 249, 0.45)',
        arcGlowBlur: 22,
        arcGlowColor: 'rgba(196, 181, 253, 0.22)'
      };
    }

    if (containerId === 'imaging-gauge') {
      const unreliable = c === '#6B7280' || c === '#9CA3AF' || c === '#71717A';
      if (unreliable) {
        return {
          track,
          progress: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 1,
            y2: 1,
            colorStops: [
              { offset: 0, color: '#18181b' },
              { offset: 1, color: '#a1a1aa' }
            ]
          },
          detailColor: '#e4e4e7',
          textShadowBlur: 12,
          textShadowColor: 'rgba(212, 212, 216, 0.5)',
          arcGlowBlur: 18,
          arcGlowColor: 'rgba(161, 161, 170, 0.4)'
        };
      }
      return {
        track,
        progress: {
          type: 'linear',
          x: 0,
          y: 1,
          x2: 1,
          y2: 0,
          colorStops: [
            { offset: 0, color: '#172554' },
            { offset: 0.48, color: '#2563eb' },
            { offset: 1, color: '#22d3ee' }
          ]
        },
        detailColor: '#a5f3fc',
        textShadowBlur: 16,
        textShadowColor: 'rgba(34, 211, 238, 0.42)',
        arcGlowBlur: 22,
        arcGlowColor: 'rgba(56, 189, 248, 0.3)'
      };
    }

    const isRed = c.includes('DC2626') || c.includes('EF4444') || c.includes('B91C1C');
    const isGray = c.includes('9CA3AF') || c.includes('6B7280');
    if (isRed) {
      return {
        track,
        progress: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 1,
          y2: 1,
          colorStops: [
            { offset: 0, color: '#4c0519' },
            { offset: 1, color: '#fb7185' }
          ]
        },
        detailColor: '#fecdd3',
        textShadowBlur: 16,
        textShadowColor: 'rgba(251, 113, 133, 0.42)',
        arcGlowBlur: 22,
        arcGlowColor: 'rgba(251, 113, 133, 0.3)'
      };
    }
    if (isGray) {
      return {
        track,
        progress: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 1,
          y2: 1,
          colorStops: [
            { offset: 0, color: '#27272a' },
            { offset: 1, color: '#a3a3a3' }
          ]
        },
        detailColor: '#f5f5f4',
        textShadowBlur: 14,
        textShadowColor: 'rgba(214, 211, 209, 0.5)',
        arcGlowBlur: 22,
        arcGlowColor: 'rgba(163, 163, 163, 0.4)'
      };
    }

    return {
      track,
      progress: {
        type: 'linear',
        x: 0,
        y: 1,
        x2: 1,
        y2: 0,
        colorStops: [
          { offset: 0, color: '#0f766e' },
          { offset: 0.5, color: '#059669' },
          { offset: 1, color: '#86efac' }
        ]
      },
      detailColor: '#ecfdf5',
      textShadowBlur: 16,
      textShadowColor: 'rgba(52, 211, 153, 0.42)',
      arcGlowBlur: 22,
      arcGlowColor: 'rgba(45, 212, 191, 0.3)'
    };
  }

  /** ECharts option for half-donut (180°) probability gauges. */
  function buildHalfGaugeOption(containerId, value, color) {
    let validValue = parseFloat(value);
    if (isNaN(validValue) || validValue < 0) validValue = 0;
    else if (validValue > 100) validValue = 100;

    const v = getGaugeVisuals(containerId, color);
    const detailColor = v.detailColor;
    // Keep the number readable with only a faint halo (avoid a heavy blurred glow).
    const textShadowBlur = Math.min(v.textShadowBlur || 0, 6);
    const textShadowColor = v.textShadowColor || 'transparent';
    const narrow = typeof global !== 'undefined' && global.innerWidth < 768;
    const arcWidth = narrow
      ? containerId === 'final-gauge'
        ? 10
        : 8
      : containerId === 'final-gauge'
        ? 16
        : 14;
    const detailFont = narrow
      ? containerId === 'final-gauge'
        ? 17
        : 14
      : containerId === 'final-gauge'
        ? 25
        : 22;
    // Soften the arc glow to a tight, subtle bloom instead of a wide fuzzy halo.
    const glowBlur = Math.min(typeof v.arcGlowBlur === 'number' ? v.arcGlowBlur : 0, 8);
    const glowColor = v.arcGlowColor || v.textShadowColor || 'transparent';

    return {
      backgroundColor: 'transparent',
      series: [
        {
          type: 'gauge',
          startAngle: 180,
          endAngle: 0,
          min: 0,
          max: 100,
          splitNumber: 5,
          radius: '70%',
          center: ['50%', '84%'],
          progress: {
            show: true,
            width: arcWidth,
            roundCap: true,
            itemStyle: {
              color: v.progress,
              shadowBlur: glowBlur,
              shadowColor: glowColor,
              shadowOffsetX: 0,
              shadowOffsetY: 0
            }
          },
          pointer: { show: false },
          axisLine: {
            roundCap: true,
            lineStyle: {
              width: arcWidth,
              color: [[1, v.track]]
            }
          },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          title: { show: false },
          detail: {
            show: true,
            valueAnimation: true,
            formatter: function (val) {
              const n = Number(val);
              if (!Number.isFinite(n)) return '--';
              return (Math.floor(n * 100) / 100).toFixed(2) + '%';
            },
            offsetCenter: [0, '-12%'],
            fontSize: detailFont,
            fontWeight: 800,
            color: detailColor,
            textStyle: {
              overflow: 'none',
              textShadowBlur: textShadowBlur,
              textShadowColor: textShadowColor
            }
          },
          data: [{ value: validValue }]
        }
      ]
    };
  }

  function applyNeonBarClasses(el, variant) {
    if (!el || !isBento()) return;
    const v = variant || 'clinical';
    ['clinical', 'imaging', 'positive', 'negative', 'borderline', 'pending', 'muted', 'consensus'].forEach(
      function (key) {
        el.classList.remove('pcode-neon-bar-fill--' + key);
      }
    );
    el.classList.add('pcode-neon-bar-fill', 'pcode-neon-bar-fill--' + v);
  }

  function variantFromSeriesName(name, index) {
    const n = String(name || '').toLowerCase();
    if (/integrated diagnostic risk|integrated risk|consensus|combined|ensemble|agreement/.test(n)) return 'consensus';
    // Class-specific before generic "cnn/imaging" — "CNN PMOS Positive" must stay red.
    if (/negative|normal/.test(n)) return 'imaging';
    if (/positive|pmos/.test(n)) return 'positive';
    if (/imaging|cnn|ultrasound|morphology/.test(n)) return 'imaging';
    if (/clinical|xgboost|xgb|biomarker/.test(n)) return 'clinical';
    if (/accuracy|precision|recall|f1|metric|train|test|split/.test(n)) return 'clinical';
    const cycle = ['clinical', 'imaging', 'positive', 'muted', 'consensus'];
    return cycle[(index || 0) % cycle.length];
  }

  function itemStyleNeedsNeon(style) {
    if (!style) return true;
    if (typeof style === 'string') return true;
    // Already themed (gradient object or solid with neon/light shadow fields).
    if (style.shadowBlur) return false;
    if (style.shadowColor !== undefined) return false;
    if (style.color && typeof style.color === 'object') return false;
    if (style.color && !isDarkTheme()) return false;
    if (style.color && !style.shadowColor) return true;
    return false;
  }

  function enhanceBarSeries(series, index) {
    if (!series || series.type !== 'bar') return;
    const variant = variantFromSeriesName(series.name, index);
    const horizontal = series.encode && series.encode.x === 0;

    // Honor an already-themed series itemStyle (e.g. explicit positive/clinical).
    if (!itemStyleNeedsNeon(series.itemStyle) && Array.isArray(series.data)) {
      return;
    }

    if (Array.isArray(series.data)) {
      series.data = series.data.map(function (point, di) {
        if (point === null || point === undefined) return point;
        if (point && typeof point === 'object' && point.itemStyle && !itemStyleNeedsNeon(point.itemStyle)) {
          return point;
        }
        const val = point && typeof point === 'object' ? point.value : point;
        const barStyle = horizontal
          ? itemStyleBySign(val, { horizontal: true })
          : verticalBar(variantFromSeriesName(series.name, index + di));
        if (point && typeof point === 'object') {
          return Object.assign({}, point, { itemStyle: barStyle });
        }
        return { value: point, itemStyle: barStyle };
      });
      return;
    }

    if (itemStyleNeedsNeon(series.itemStyle)) {
      series.itemStyle = horizontal ? horizontalBar(variant) : verticalBar(variant);
    }
  }

  function enhanceChartOption(option) {
    if (!isBento() || !option) return option;
    const list = option.series;
    if (!list) return option;
    const arr = Array.isArray(list) ? list : [list];
    arr.forEach(function (s, i) {
      enhanceBarSeries(s, i);
    });
    return option;
  }

  function patchEchartsGlobal() {
    if (typeof echarts === 'undefined' || echarts.__pcodeNeonPatched) return false;
    const origInit = echarts.init;
    echarts.init = function (dom, theme, opts) {
      const chart = origInit.call(this, dom, theme, opts);
      if (!chart || chart.__pcodeNeonSetOption) return chart;
      const origSetOption = chart.setOption.bind(chart);
      chart.setOption = function (option, notMerge, lazyUpdate) {
        if (isBento() && option) {
          try {
            enhanceChartOption(option);
          } catch (_) {}
        }
        return origSetOption(option, notMerge, lazyUpdate);
      };
      chart.__pcodeNeonSetOption = true;
      return chart;
    };
    echarts.__pcodeNeonPatched = true;
    return true;
  }

  function waitForEchartsAndPatch(attempts) {
    if (patchEchartsGlobal()) return;
    if ((attempts || 0) >= 40) return;
    setTimeout(function () {
      waitForEchartsAndPatch((attempts || 0) + 1);
    }, 50);
  }

  function bootNeonSiteWide() {
    waitForEchartsAndPatch(0);
    document.querySelectorAll('.pcode-neon-bar-fill').forEach(function (el) {
      if (!el.className.match(/pcode-neon-bar-fill--/)) applyNeonBarClasses(el, 'clinical');
    });
  }

  function rememberGaugeState(chartDom, containerId, value, color) {
    if (!chartDom) return;
    chartDom.dataset.pcodeGaugeId = containerId || chartDom.id || '';
    chartDom.dataset.pcodeGaugeValue = String(value);
    if (color) chartDom.dataset.pcodeGaugeColor = String(color);
    else delete chartDom.dataset.pcodeGaugeColor;
  }

  function refreshRegisteredGauges() {
    document.querySelectorAll('.gauge-container, .final-gauge-container').forEach(function (dom) {
      const id = dom.dataset.pcodeGaugeId || dom.id;
      const val = dom.dataset.pcodeGaugeValue;
      if (!id || val === undefined || val === '') return;
      renderHalfGauge(dom, id, parseFloat(val), dom.dataset.pcodeGaugeColor || '');
    });
  }

  function flattenOptionAxes(axes) {
    if (!axes) return [];
    const out = [];
    const list = Array.isArray(axes) ? axes : [axes];
    list.forEach(function (entry) {
      if (Array.isArray(entry)) entry.forEach(function (ax) { if (ax) out.push(ax); });
      else if (entry) out.push(entry);
    });
    return out;
  }

  function patchAxisForTheme(axis) {
    if (!axis) return axis;
    const isValue = axis.type === 'value' || axis.type === 'log';
    const th = chartTheme();
    return isValue ? th.axisVal(axis) : th.axisCat(axis);
  }

  function refreshBarSeriesOnChart(inst) {
    const opt = inst.getOption();
    if (!opt || !opt.series) return;
    const raw = opt.series;
    const groups = Array.isArray(raw) ? raw : [raw];
    const patch = [];
    let touched = false;
    groups.forEach(function (group, gi) {
      const list = Array.isArray(group) ? group : [group];
      list.forEach(function (ser, si) {
        if (!ser) return;
        if (ser.type === 'bar') {
          const copy = JSON.parse(JSON.stringify(ser));
          enhanceBarSeries(copy, gi * 10 + si);
          patch.push(copy);
          touched = true;
        } else {
          patch.push(ser);
        }
      });
    });
    if (touched && patch.length) inst.setOption({ series: patch }, false);
  }

  function refreshChartInstance(inst) {
    if (!inst || !isBento()) return;
    const th = chartTheme();
    if (!th.d) return;

    const legendPatch = Object.assign({}, th.legend || {}, {
      textStyle: Object.assign({}, (th.legend && th.legend.textStyle) || {}, {
        color: th.muted,
        fontWeight: 'bold'
      }),
      pageTextStyle: Object.assign({}, (th.legend && th.legend.pageTextStyle) || {}, {
        color: th.muted
      })
    });

    inst.setOption(
      {
        textStyle: { color: th.text },
        tooltip: th.tooltip,
        legend: legendPatch
      },
      false
    );

    const opt = inst.getOption();
    const xPatch = flattenOptionAxes(opt.xAxis).map(patchAxisForTheme);
    const yPatch = flattenOptionAxes(opt.yAxis).map(patchAxisForTheme);
    if (xPatch.length) inst.setOption({ xAxis: xPatch }, false);
    if (yPatch.length) inst.setOption({ yAxis: yPatch }, false);

    try {
      refreshBarSeriesOnChart(inst);
    } catch (_) {}
  }

  const CHART_HOST_SELECTORS = [
    '.pcb-echart-host',
    '.gauge-container',
    '.final-gauge-container',
    '[id$="-chart"]',
    '#shap-force-plot',
    '#shap-importance-chart',
    '#consensus-chart',
    '#dashboard-comparative-chart',
    '#dashboard-diagnosis-summary-chart',
    '.chart-well'
  ];

  function refreshAllChartsOnThemeChange() {
    if (typeof echarts === 'undefined') return;
    const seen = new Set();
    refreshRegisteredGauges();
    CHART_HOST_SELECTORS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (dom) {
        if (seen.has(dom)) return;
        seen.add(dom);
        if (dom.classList.contains('gauge-container') || dom.classList.contains('final-gauge-container')) {
          return;
        }
        const inst = echarts.getInstanceByDom(dom);
        if (inst) refreshChartInstance(inst);
      });
    });
  }

  function gaugeToneClass(containerId, color) {
    if (containerId === 'clinical-gauge') return 'pcode-gauge-tone--clinical';
    if (containerId === 'imaging-gauge') return 'pcode-gauge-tone--imaging';
    const c = String(color || '').trim().toUpperCase();
    if (c.includes('EF4444') || c.includes('DC2626') || c.includes('B91C1C') || c.includes('F87171')) {
      return 'pcode-gauge-tone--positive';
    }
    if (c.includes('22C55E') || c.includes('16A34A') || c.includes('4ADE80') || c.includes('10B981')) {
      return 'pcode-gauge-tone--negative';
    }
    if (c.includes('6B7280') || c.includes('9CA3AF') || c.includes('71717A')) {
      return 'pcode-gauge-tone--muted';
    }
    return 'pcode-gauge-tone--clinical';
  }

  function applyGaugeToneClass(chartDom, containerId, color) {
    if (!chartDom || !chartDom.classList) return;
    [
      'pcode-gauge-tone--clinical',
      'pcode-gauge-tone--imaging',
      'pcode-gauge-tone--positive',
      'pcode-gauge-tone--negative',
      'pcode-gauge-tone--muted'
    ].forEach(function (cls) {
      chartDom.classList.remove(cls);
    });
    chartDom.classList.add(gaugeToneClass(containerId, color));
    chartDom.style.overflow = 'visible';
  }

  function renderHalfGauge(chartDom, containerId, value, color) {
    if (!chartDom || typeof echarts === 'undefined') return null;
    let validValue = parseFloat(value);
    if (isNaN(validValue)) validValue = 0;
    applyGaugeToneClass(chartDom, containerId, color);
    rememberGaugeState(chartDom, containerId, validValue, color);
    let myChart = echarts.getInstanceByDom(chartDom);
    const hasCanvas = !!chartDom.querySelector('canvas');
    if (myChart && !hasCanvas) {
      try {
        myChart.dispose();
      } catch (_) {}
      myChart = null;
    }
    if (!myChart) myChart = echarts.init(chartDom);
    myChart.setOption(buildHalfGaugeOption(containerId, value, color), true);
    try {
      myChart.resize();
      setTimeout(function () {
        try {
          myChart.resize();
        } catch (_) {}
      }, 50);
    } catch (_) {}
    return myChart;
  }

  var gaugeResizeTimer;
  global.addEventListener('resize', function () {
    clearTimeout(gaugeResizeTimer);
    gaugeResizeTimer = setTimeout(refreshRegisteredGauges, 150);
  });

  /**
   * ECharts legend tuned for narrow viewports (bottom-centered, compact swatches).
   * Prefer renderHtmlLegend when labels are long (e.g. comparative performance).
   */
  function responsiveLegendOption(base) {
    var narrow = isNarrowChartViewport();
    var b = base || {};
    var textStyle = Object.assign(
      {
        fontSize: narrow ? 10 : 11,
        fontWeight: 'bold'
      },
      b.textStyle || {}
    );
    return Object.assign(
      {
        type: narrow ? 'scroll' : 'plain',
        orient: 'horizontal',
        left: 'center',
        right: 'center',
        bottom: narrow ? 4 : 10,
        width: narrow ? '96%' : undefined,
        itemGap: narrow ? 8 : 16,
        itemWidth: 12,
        itemHeight: 12,
        padding: narrow ? [2, 4, 2, 4] : [4, 8, 4, 8],
        pageIconSize: 10,
        pageTextStyle: { fontSize: 10 },
        textStyle: textStyle
      },
      b
    );
  }

  /**
   * Responsive grid bottom inset when legend sits inside the canvas.
   */
  function comparativeGridInsets() {
    var narrow = isNarrowChartViewport();
    return {
      left: narrow ? '12%' : '10%',
      right: narrow ? '6%' : '10%',
      top: narrow ? '12%' : '15%',
      bottom: narrow ? '16%' : '12%',
      containLabel: true
    };
  }

  /**
   * Accessible HTML legend below the chart (flex-wrap; no canvas overlap).
   * @param {string|HTMLElement} target id or element
   * @param {{ label: string, color: string }[]} items
   */
  function renderHtmlLegend(target, items) {
    var el =
      typeof target === 'string' ? document.getElementById(target) : target;
    if (!el || !items || !items.length) return;

    el.setAttribute('role', 'list');
    el.classList.add('pcode-chart-legend');
    el.innerHTML = items
      .map(function (item) {
        var label = String(item.label || '').replace(/</g, '&lt;');
        var color = String(item.color || '#c4b5fd');
        return (
          '<span class="pcode-chart-legend__item" role="listitem">' +
          '<span class="pcode-chart-legend__swatch" style="background-color:' +
          color +
          ';" aria-hidden="true"></span>' +
          '<span class="pcode-chart-legend__label">' +
          label +
          '</span></span>'
        );
      })
      .join('');
  }

  global.PcodeEchartNeon = {
    VARIANTS: VARIANTS,
    isBento: isBento,
    isDarkTheme: isDarkTheme,
    gradient: gradient,
    itemStyle: itemStyle,
    verticalBar: verticalBar,
    legendColor: legendColor,
    horizontalBar: horizontalBar,
    horizontalBarRadiusBySign: horizontalBarRadiusBySign,
    itemStyleBySign: itemStyleBySign,
    shapContributionChartLayout: shapContributionChartLayout,
    shapImportanceChartLayout: shapImportanceChartLayout,
    consensusChartGrid: consensusChartGrid,
    consensusChartLayout: consensusChartLayout,
    xaiHorizontalBarChartHeight: xaiHorizontalBarChartHeight,
    applyXaiChartHostSizing: applyXaiChartHostSizing,
    shapContributionBarFallback: shapContributionBarFallback,
    normalizeDiagnosisState: normalizeDiagnosisState,
    consensusStopsByDiagnosis: consensusStopsByDiagnosis,
    consensusLegendColor: consensusLegendColor,
    consensusBarByDiagnosis: consensusBarByDiagnosis,
    barFillVertical: barFillVertical,
    verticalBarFromStops: verticalBarFromStops,
    chartTheme: chartTheme,
    mapDataWithStyle: mapDataWithStyle,
    getGaugeVisuals: getGaugeVisuals,
    buildHalfGaugeOption: buildHalfGaugeOption,
    renderHalfGauge: renderHalfGauge,
    applyNeonBarClasses: applyNeonBarClasses,
    enhanceChartOption: enhanceChartOption,
    refreshAllChartsOnThemeChange: refreshAllChartsOnThemeChange,
    refreshChartInstance: refreshChartInstance,
    isNarrowChartViewport: isNarrowChartViewport,
    responsiveLegendOption: responsiveLegendOption,
    comparativeGridInsets: comparativeGridInsets,
    renderHtmlLegend: renderHtmlLegend
  };

  global.addEventListener('pcode-theme-change', function () {
    refreshAllChartsOnThemeChange();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootNeonSiteWide);
  } else {
    bootNeonSiteWide();
  }
})(typeof window !== 'undefined' ? window : this);
