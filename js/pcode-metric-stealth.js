/**
 * P-Code Stealth Metric Conversion Engine
 * Display units (ft/in, lbs, mm/cm) sync to hidden canonical fields for PHP/ML APIs.
 * Canonical: height cm, weight kg, waist/hip inch, ultrasound lengths mm (API column suffix _mm).
 */
(function (global) {
  'use strict';

  function fixed3(n) {
    if (n === null || n === undefined || n === '') return '';
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return v.toFixed(3);
  }

  function parseNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }

  function unitToggleHtml(units, activeId) {
    const buttons = units
      .map(function (u) {
        const on = u.id === activeId;
        return (
          '<button type="button" class="pcode-unit-pill__btn' +
          (on ? ' is-active' : '') +
          '" data-unit="' +
          u.id +
          '" aria-pressed="' +
          (on ? 'true' : 'false') +
          '">' +
          u.label +
          '</button>'
        );
      })
      .join('');
    return '<div class="pcode-unit-pill" role="group" aria-label="Unit">' + buttons + '</div>';
  }

  function bindUnitToggle(container, onChange) {
    const wrap = container.querySelector('.pcode-unit-pill');
    if (!wrap) return;
    wrap.querySelectorAll('.pcode-unit-pill__btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const unit = btn.getAttribute('data-unit');
        wrap.querySelectorAll('.pcode-unit-pill__btn').forEach(function (b) {
          const isOn = b === btn;
          b.classList.toggle('is-active', isOn);
          b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        });
        onChange(unit);
      });
    });
  }

  function activeUnit(host) {
    const active = host.querySelector('.pcode-unit-pill__btn.is-active');
    return active ? active.getAttribute('data-unit') : null;
  }

  function initHeightGroup(opts) {
    const hidden = document.getElementById(opts.hiddenId);
    const host = document.getElementById(opts.hostId);
    if (!hidden || !host) return;

    hidden.type = 'hidden';

    host.innerHTML =
      '<div class="flex justify-between items-center mb-1">' +
      '<label class="block text-sm font-medium pcode-diagnostic-title">' +
      (opts.label || 'Height') +
      '</label>' +
      unitToggleHtml(
        [
          { id: 'ftin', label: 'ft/in' },
          { id: 'cm', label: 'cm' },
        ],
        'cm'
      ) +
      '</div>' +
      '<div data-panel="cm"><input type="number" data-display-cm step="0.1" min="0" class="input-medical w-full" placeholder="cm"></div>' +
      '<div data-panel="ftin" class="hidden flex items-center gap-2 mt-1">' +
      '<input type="number" data-ft min="0" step="1" class="input-medical w-full" placeholder="ft" aria-label="Feet">' +
      '<input type="number" data-in min="0" max="11.99" step="0.1" class="input-medical w-full" placeholder="in" aria-label="Inches">' +
      '</div>';

    const panelCm = host.querySelector('[data-panel="cm"]');
    const panelFt = host.querySelector('[data-panel="ftin"]');
    const inputCm = host.querySelector('[data-display-cm]');
    const inputFt = host.querySelector('[data-ft]');
    const inputIn = host.querySelector('[data-in]');

    function cmToFtIn(cm) {
      const totalIn = cm / 2.54;
      const ft = Math.floor(totalIn / 12);
      const inches = totalIn - ft * 12;
      return { ft: ft, in: inches };
    }

    function syncHiddenFromCm(cm) {
      hidden.value = cm === null ? '' : fixed3(cm);
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function readCmFromPanels(unit) {
      if (unit === 'ftin') {
        const ft = parseNum(inputFt.value);
        const inches = parseNum(inputIn.value);
        if (ft === null && inches === null) return null;
        return (ft || 0) * 30.48 + (inches || 0) * 2.54;
      }
      return parseNum(inputCm.value);
    }

    function pushDisplayFromHidden(unit) {
      const cm = parseNum(hidden.value);
      panelCm.classList.toggle('hidden', unit === 'ftin');
      panelFt.classList.toggle('hidden', unit !== 'ftin');
      if (cm === null) {
        inputCm.value = '';
        inputFt.value = '';
        inputIn.value = '';
        return;
      }
      inputCm.value = fixed3(cm);
      const fi = cmToFtIn(cm);
      inputFt.value = String(fi.ft);
      inputIn.value = fixed3(fi.in);
    }

    function setUnit(unit) {
      syncHiddenFromCm(readCmFromPanels(unit));
      pushDisplayFromHidden(unit);
    }

    bindUnitToggle(host, setUnit);

    [inputCm, inputFt, inputIn].forEach(function (el) {
      el.addEventListener('input', function () {
        syncHiddenFromCm(readCmFromPanels(activeUnit(host) || 'cm'));
      });
    });

    host._pcodeSetHeightCm = function (cm) {
      hidden.value = cm === null || cm === '' ? '' : fixed3(cm);
      pushDisplayFromHidden(activeUnit(host) || 'cm');
    };

    hidden._pcodeApplyValue = function (cm) {
      host._pcodeSetHeightCm(cm);
    };

    pushDisplayFromHidden('cm');
  }

  function initWeightGroup(opts) {
    const hidden = document.getElementById(opts.hiddenId);
    const host = document.getElementById(opts.hostId);
    if (!hidden || !host) return;

    hidden.type = 'hidden';

    host.innerHTML =
      '<div class="flex justify-between items-center mb-1">' +
      '<label class="block text-sm font-medium pcode-diagnostic-title">' +
      (opts.label || 'Weight') +
      '</label>' +
      unitToggleHtml(
        [
          { id: 'lbs', label: 'lbs' },
          { id: 'kg', label: 'kg' },
        ],
        'kg'
      ) +
      '</div>' +
      '<div data-panel="kg"><input type="number" data-display-kg step="0.1" min="0" class="input-medical w-full" placeholder="kg"></div>' +
      '<div data-panel="lbs" class="hidden flex items-center gap-2 mt-1"><input type="number" data-display-lbs step="0.1" min="0" class="input-medical w-full" placeholder="lbs"></div>';

    const panelKg = host.querySelector('[data-panel="kg"]');
    const panelLbs = host.querySelector('[data-panel="lbs"]');
    const inputKg = host.querySelector('[data-display-kg]');
    const inputLbs = host.querySelector('[data-display-lbs]');

    function syncHidden(kg) {
      hidden.value = kg === null ? '' : fixed3(kg);
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function readKg(unit) {
      if (unit === 'lbs') {
        const lbs = parseNum(inputLbs.value);
        return lbs === null ? null : lbs * 0.453592;
      }
      return parseNum(inputKg.value);
    }

    function pushDisplay(unit) {
      const kg = parseNum(hidden.value);
      panelKg.classList.toggle('hidden', unit === 'lbs');
      panelLbs.classList.toggle('hidden', unit !== 'lbs');
      if (kg === null) {
        inputKg.value = '';
        inputLbs.value = '';
        return;
      }
      inputKg.value = fixed3(kg);
      inputLbs.value = fixed3(kg / 0.453592);
    }

    function setUnit(unit) {
      syncHidden(readKg(unit));
      pushDisplay(unit);
    }

    bindUnitToggle(host, setUnit);
    inputKg.addEventListener('input', function () {
      syncHidden(readKg('kg'));
    });
    inputLbs.addEventListener('input', function () {
      syncHidden(readKg('lbs'));
    });

    host._pcodeSetWeightKg = function (kg) {
      hidden.value = kg === null || kg === '' ? '' : fixed3(kg);
      pushDisplay(activeUnit(host) || 'kg');
    };

    hidden._pcodeApplyValue = function (kg) {
      host._pcodeSetWeightKg(kg);
    };

    pushDisplay('kg');
  }

  function initLengthMmGroup(opts) {
    const hidden = document.getElementById(opts.hiddenId);
    const host = document.getElementById(opts.hostId);
    if (!hidden || !host) return;

    hidden.type = 'hidden';

    host.innerHTML =
      '<div class="flex justify-between items-center gap-2 mb-1">' +
      '<label class="block text-sm font-medium text-gray-700 flex-1">' +
      (opts.label || 'Measurement') +
      '</label>' +
      unitToggleHtml(
        [
          { id: 'mm', label: 'mm' },
          { id: 'cm', label: 'cm' },
        ],
        'mm'
      ) +
      '</div>' +
      '<input type="number" data-display step="0.001" min="0" class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm focus:ring-purple-500 focus:border-purple-500 px-3 py-2">';

    const display = host.querySelector('[data-display]');

    function mmToDisplay(mm, unit) {
      if (mm === null) return '';
      return unit === 'cm' ? fixed3(mm / 10) : fixed3(mm);
    }

    function displayToMm(val, unit) {
      if (val === null) return null;
      return unit === 'cm' ? val * 10 : val;
    }

    function sync() {
      const unit = activeUnit(host) || 'mm';
      const mm = displayToMm(parseNum(display.value), unit);
      hidden.value = mm === null ? '' : fixed3(mm);
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
    }

    bindUnitToggle(host, function (unit) {
      display.value = mmToDisplay(parseNum(hidden.value), unit);
    });

    display.addEventListener('input', sync);

    host._pcodeSetLengthMm = function (mm) {
      hidden.value = mm === null || mm === '' ? '' : fixed3(mm);
      display.value = mmToDisplay(parseNum(hidden.value), activeUnit(host) || 'mm');
    };

    hidden._pcodeApplyValue = function (mm) {
      host._pcodeSetLengthMm(mm);
    };

    display.value = mmToDisplay(parseNum(hidden.value), 'mm');
  }

  function initLengthInchGroup(opts) {
    const hidden = document.getElementById(opts.hiddenId);
    const host = document.getElementById(opts.hostId);
    if (!hidden || !host) return;

    hidden.type = 'hidden';

    const inputClass =
      opts.inputClass ||
      'mt-1 block w-full border border-gray-300 rounded-md shadow-sm focus:ring-purple-500 focus:border-purple-500 px-3 py-2';
    const labelClass = opts.labelClass || 'block text-sm font-medium text-gray-700 flex-1';

    host.innerHTML =
      '<div class="flex justify-between items-center gap-2 mb-1">' +
      '<label class="' +
      labelClass +
      '">' +
      (opts.label || 'Measurement') +
      '</label>' +
      unitToggleHtml(
        [
          { id: 'inch', label: 'in' },
          { id: 'cm', label: 'cm' },
        ],
        'inch'
      ) +
      '</div>' +
      '<input type="number" data-display step="0.1" min="0" class="' +
      inputClass +
      '">';

    const display = host.querySelector('[data-display]');

    function inchToDisplay(inch, unit) {
      if (inch === null) return '';
      return unit === 'cm' ? fixed3(inch * 2.54) : fixed3(inch);
    }

    function displayToInch(val, unit) {
      if (val === null) return null;
      return unit === 'cm' ? val / 2.54 : val;
    }

    function sync() {
      const unit = activeUnit(host) || 'inch';
      const inch = displayToInch(parseNum(display.value), unit);
      hidden.value = inch === null ? '' : fixed3(inch);
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
    }

    bindUnitToggle(host, function (unit) {
      display.value = inchToDisplay(parseNum(hidden.value), unit);
    });

    display.addEventListener('input', sync);

    host._pcodeSetLengthInch = function (inch) {
      hidden.value = inch === null || inch === '' ? '' : fixed3(inch);
      display.value = inchToDisplay(parseNum(hidden.value), activeUnit(host) || 'inch');
    };

    hidden._pcodeApplyValue = function (inch) {
      host._pcodeSetLengthInch(inch);
    };

    display.value = inchToDisplay(parseNum(hidden.value), 'inch');
  }

  function initPatientModal() {
    if (document.getElementById('patient-height-host')) {
      initHeightGroup({ hiddenId: 'patient-height', hostId: 'patient-height-host', label: 'Height' });
    }
    if (document.getElementById('patient-weight-host')) {
      initWeightGroup({ hiddenId: 'patient-weight', hostId: 'patient-weight-host', label: 'Weight' });
    }
    if (document.getElementById('patient-waist-host')) {
      initLengthInchGroup({
        hiddenId: 'waist-inch',
        hostId: 'patient-waist-host',
        label: 'Waist',
        inputClass:
          'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-sm',
        labelClass: 'block text-sm font-medium text-gray-700',
      });
    }
    if (document.getElementById('patient-hip-host')) {
      initLengthInchGroup({
        hiddenId: 'hip-inch',
        hostId: 'patient-hip-host',
        label: 'Hip',
        inputClass:
          'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-sm',
        labelClass: 'block text-sm font-medium text-gray-700',
      });
    }
  }

  function initClinicalForm() {
    const clinical = [
      { hiddenId: 'Height_cm', hostId: 'pcode-height-cm-host', label: 'Height', kind: 'height' },
      { hiddenId: 'Weight_kg', hostId: 'pcode-weight-kg-host', label: 'Weight', kind: 'weight' },
      { hiddenId: 'Waist_inch', hostId: 'pcode-waist-inch-host', label: 'Waist', kind: 'inch' },
      { hiddenId: 'Hip_inch', hostId: 'pcode-hip-inch-host', label: 'Hip', kind: 'inch' },
      { hiddenId: 'Avg_F_size_L', hostId: 'pcode-avg-f-l-host', label: 'Avg Follicle Size L (mm, TVUS)', kind: 'length' },
      { hiddenId: 'Avg_F_size_R', hostId: 'pcode-avg-f-r-host', label: 'Avg Follicle Size R (mm, TVUS)', kind: 'length' },
      { hiddenId: 'Endometrium_mm', hostId: 'pcode-endometrium-host', label: 'Endometrium', kind: 'length' },
    ];
    clinical.forEach(function (m) {
      if (!document.getElementById(m.hostId)) return;
      if (m.kind === 'height') initHeightGroup(m);
      else if (m.kind === 'weight') initWeightGroup(m);
      else if (m.kind === 'inch') initLengthInchGroup(m);
      else initLengthMmGroup(m);
    });
  }

  function boot() {
    initPatientModal();
    initClinicalForm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.PcodeMetricStealth = {
    fixed3: fixed3,
    initHeightGroup: initHeightGroup,
    initWeightGroup: initWeightGroup,
    initLengthMmGroup: initLengthMmGroup,
    initLengthInchGroup: initLengthInchGroup,
    initPatientModal: initPatientModal,
    initClinicalForm: initClinicalForm,
    boot: boot,
  };
})(typeof window !== 'undefined' ? window : globalThis);

