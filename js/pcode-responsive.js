/**
 * P-Code — cross-page responsive helpers (chart resize, admin nav, breakpoints).
 */
(function (global) {
  'use strict';

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      const args = arguments;
      const ctx = this;
      t = setTimeout(function () {
        fn.apply(ctx, args);
      }, ms);
    };
  }

  function resizeAllEcharts() {
    if (typeof echarts === 'undefined') return;
    const selectors = [
      '.pcb-echart-host',
      '.gauge-container',
      '.final-gauge-container',
      '[id$="-chart"]',
      '#shap-force-plot',
      '#shap-importance-chart',
      '#consensus-chart',
      '#dashboard-comparative-chart',
      '#dashboard-diagnosis-summary-chart',
      '#performance-metrics-chart',
      '#data-split-chart'
    ];
    const seen = new Set();
    selectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (seen.has(el)) return;
        seen.add(el);
        const inst = echarts.getInstanceByDom(el);
        if (inst) {
          try {
            inst.resize();
          } catch (_) {}
        }
      });
    });
  }

  function initAdminMobileNav() {
    const body = document.body;
    if (!body || !body.classList.contains('pcode-admin-shell')) return;

    let overlay = document.getElementById('admin-nav-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'admin-nav-overlay';
      overlay.className = 'pcode-admin-nav-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      body.insertBefore(overlay, body.firstChild);
    }

    let toggle = document.getElementById('admin-nav-toggle');
    if (!toggle) {
      const main = document.querySelector('.admin-main');
      if (!main) return;
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.id = 'admin-nav-toggle';
      toggle.className = 'pcode-admin-nav-toggle';
      toggle.setAttribute('aria-label', 'Open navigation menu');
      toggle.innerHTML =
        '<svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>';
      main.insertBefore(toggle, main.firstChild);
    }

    function closeNav() {
      body.classList.remove('pcode-admin-nav-open');
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
    }

    function openNav() {
      body.classList.add('pcode-admin-nav-open');
      overlay.classList.add('active');
      overlay.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
    }

    toggle.addEventListener('click', function () {
      if (body.classList.contains('pcode-admin-nav-open')) closeNav();
      else openNav();
    });
    overlay.addEventListener('click', closeNav);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNav();
    });
    global.addEventListener(
      'resize',
      debounce(function () {
        if (global.innerWidth >= 1024) closeNav();
      }, 120)
    );
  }

  /**
   * Mobile edge swipes for sidebars (system-wide).
   * Right drawer (#mobile-menu): swipe right → left from the right edge to open;
   * swipe left → right while open to close.
   * Admin left drawer: swipe left → right from the left edge to open;
   * swipe right → left while open to close.
   */
  function initSwipeSidebar() {
    if (global.__pcodeSwipeSidebarBound) return;
    global.__pcodeSwipeSidebarBound = true;

    var EDGE_PX = 48;
    var OPEN_ZONE_RATIO = 0.22;
    var OPEN_DX = 52;
    var CLOSE_DX = 48;
    var MAX_DY = 56;
    var MAX_DURATION_MS = 700;

    var tracking = null;

    function isCompactViewport() {
      try {
        return global.matchMedia('(max-width: 1023px)').matches;
      } catch (_) {
        return global.innerWidth <= 1023;
      }
    }

    function rightMenuEl() {
      return document.getElementById('mobile-menu');
    }

    function isRightMenuOpen() {
      var menu = rightMenuEl();
      return !!(menu && menu.classList.contains('active'));
    }

    function hasRightMenu() {
      return !!rightMenuEl();
    }

    function isAdminShell() {
      return !!(document.body && document.body.classList.contains('pcode-admin-shell'));
    }

    function isAdminNavOpen() {
      return !!(document.body && document.body.classList.contains('pcode-admin-nav-open'));
    }

    function openRightMenu() {
      if (isRightMenuOpen()) return;
      if (typeof global.toggleMobileMenu === 'function') {
        global.toggleMobileMenu();
        return;
      }
      var menu = rightMenuEl();
      if (!menu) return;
      menu.classList.add('active');
      var overlay =
        document.getElementById('menu-overlay') ||
        document.getElementById('mobile-menu-overlay') ||
        document.querySelector('.mobile-menu-overlay');
      if (overlay) overlay.classList.add('active');
      document.body.classList.add('pcode-mobile-nav-open');
      var btn = document.getElementById('mobile-menu-btn');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    }

    function closeRightMenu() {
      if (!isRightMenuOpen()) return;
      if (typeof global.closeMobileMenu === 'function') {
        global.closeMobileMenu();
        return;
      }
      if (typeof global.toggleMobileMenu === 'function') {
        global.toggleMobileMenu();
        return;
      }
      var menu = rightMenuEl();
      if (menu) menu.classList.remove('active');
      var overlay =
        document.getElementById('menu-overlay') ||
        document.getElementById('mobile-menu-overlay') ||
        document.querySelector('.mobile-menu-overlay');
      if (overlay) overlay.classList.remove('active');
      document.body.classList.remove('pcode-mobile-nav-open');
      var btn = document.getElementById('mobile-menu-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function openAdminNav() {
      if (!isAdminShell() || isAdminNavOpen()) return;
      var toggle = document.getElementById('admin-nav-toggle');
      if (toggle) toggle.click();
      else {
        document.body.classList.add('pcode-admin-nav-open');
        var overlay = document.getElementById('admin-nav-overlay');
        if (overlay) {
          overlay.classList.add('active');
          overlay.setAttribute('aria-hidden', 'false');
        }
      }
    }

    function closeAdminNav() {
      if (!isAdminShell() || !isAdminNavOpen()) return;
      var toggle = document.getElementById('admin-nav-toggle');
      if (toggle && document.body.classList.contains('pcode-admin-nav-open')) {
        toggle.click();
        return;
      }
      document.body.classList.remove('pcode-admin-nav-open');
      var overlay = document.getElementById('admin-nav-overlay');
      if (overlay) {
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden', 'true');
      }
    }

    function ignoreTarget(target) {
      if (!target || !target.closest) return false;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
      if (target.closest('.leaflet-container, .gm-style, canvas, [data-no-swipe-nav]')) return true;
      var scrollX = target.closest('[data-swipe-scroll], .pcb-scroll-x, .overflow-x-auto, .overflow-x-scroll');
      if (scrollX) {
        try {
          if (scrollX.scrollWidth > scrollX.clientWidth + 8) return true;
        } catch (_) {
          return true;
        }
      }
      return false;
    }

    function onTouchStart(e) {
      if (!isCompactViewport()) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (!hasRightMenu() && !isAdminShell()) return;

      var t = e.touches[0];
      var x = t.clientX;
      var y = t.clientY;
      var w = global.innerWidth || document.documentElement.clientWidth || 0;
      if (w < 1) return;

      var nearRight = x >= w - Math.max(EDGE_PX, w * OPEN_ZONE_RATIO);
      var nearLeft = x <= Math.max(EDGE_PX, w * OPEN_ZONE_RATIO);
      var mode = null;

      if (hasRightMenu()) {
        if (!isRightMenuOpen() && nearRight) mode = 'open-right';
        else if (isRightMenuOpen()) mode = 'close-right';
      } else if (isAdminShell()) {
        if (!isAdminNavOpen() && nearLeft) mode = 'open-admin';
        else if (isAdminNavOpen()) mode = 'close-admin';
      }

      if (!mode) return;
      if (mode.indexOf('open') === 0 && ignoreTarget(e.target)) return;

      tracking = {
        mode: mode,
        startX: x,
        startY: y,
        startAt: Date.now(),
        moved: false,
        locked: false
      };
    }

    function onTouchMove(e) {
      if (!tracking) return;
      if (!e.touches || e.touches.length !== 1) {
        tracking = null;
        return;
      }

      var t = e.touches[0];
      var dx = t.clientX - tracking.startX;
      var dy = t.clientY - tracking.startY;

      if (!tracking.locked) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx) || Math.abs(dy) > MAX_DY) {
          tracking = null;
          return;
        }
        tracking.locked = true;
      }

      tracking.moved = true;
      tracking.dx = dx;
      tracking.dy = dy;

      if (e.cancelable) e.preventDefault();
    }

    function onTouchEnd() {
      if (!tracking) return;
      var state = tracking;
      tracking = null;

      if (!state.moved || !state.locked) return;
      if (Date.now() - state.startAt > MAX_DURATION_MS) return;

      var dx = state.dx || 0;
      var dy = state.dy || 0;
      if (Math.abs(dy) > MAX_DY) return;

      if (state.mode === 'open-right' && dx <= -OPEN_DX) openRightMenu();
      else if (state.mode === 'close-right' && dx >= CLOSE_DX) closeRightMenu();
      else if (state.mode === 'open-admin' && dx >= OPEN_DX) openAdminNav();
      else if (state.mode === 'close-admin' && dx <= -CLOSE_DX) closeAdminNav();
    }

    function onTouchCancel() {
      tracking = null;
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });
  }

  function boot() {
    initAdminMobileNav();
    initSwipeSidebar();
    setTimeout(resizeAllEcharts, 350);
  }

  global.addEventListener('resize', debounce(resizeAllEcharts, 160));
  global.addEventListener('orientationchange', function () {
    setTimeout(resizeAllEcharts, 280);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.PcodeResponsive = {
    resizeAllEcharts: resizeAllEcharts,
    initAdminMobileNav: initAdminMobileNav,
    initSwipeSidebar: initSwipeSidebar
  };
})(typeof window !== 'undefined' ? window : this);
