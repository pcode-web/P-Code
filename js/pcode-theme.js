/**
 * P-Code — Light / Dark theme toggle.
 * Uses html.dark (Tailwind class strategy). Persists to localStorage.
 * Injects a glass Light/Dark pill in the sidebar (no navbar control).
 * Does not alter existing page layout structure.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'pcode-theme';
  var NAV_MOUNT_ID = 'pcode-theme-toggle-mount-nav';
  var SIDEBAR_FOOTER_CLASS = 'pcode-sidebar-theme-footer';

  var ICON_SUN =
    '<svg class="pcode-theme-pill__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  var ICON_MOON =
    '<svg class="pcode-theme-pill__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';

  function isThemedPage() {
    var html = document.documentElement;
    return (
      html.classList.contains('pcode-app-bento-root') ||
      html.classList.contains('login-bento-page')
    );
  }

  function getTheme() {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  }

  function writeStored(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {}
  }

  function dispatchThemeChange(theme, source) {
    try {
      global.dispatchEvent(
        new CustomEvent('pcode-theme-change', {
          detail: { theme: theme, source: source || 'user' }
        })
      );
    } catch (_) {}
  }

  function ensureGlassAura() {
    var id = 'pcode-glass-aura';
    var existing = document.getElementById(id);
    if (existing) return existing;

    var wrap = document.createElement('div');
    wrap.id = id;
    wrap.className =
      'pcode-glass-aura fixed inset-0 -z-50 overflow-hidden pointer-events-none';
    wrap.setAttribute('aria-hidden', 'true');

    var purple = document.createElement('div');
    purple.className =
      'pcode-glass-aura__blob pcode-glass-aura__blob--purple absolute inset-0 ' +
      'transition-all duration-700 ease-out';

    var indigo = document.createElement('div');
    indigo.className =
      'pcode-glass-aura__blob pcode-glass-aura__blob--indigo absolute inset-0 ' +
      'transition-all duration-700 ease-out';
    indigo.style.animationDelay = '0.08s';

    wrap.appendChild(purple);
    wrap.appendChild(indigo);

    var body = document.body;
    if (body && body.parentNode) {
      body.parentNode.insertBefore(wrap, body);
    } else if (body) {
      body.insertBefore(wrap, body.firstChild);
    } else {
      document.documentElement.appendChild(wrap);
    }
    return wrap;
  }

  function syncGlassAura(opts) {
    opts = opts || {};
    if (!isThemedPage()) return;
    var html = document.documentElement;
    var wrap = ensureGlassAura();
    if (!wrap) return;
    var dark = html.classList.contains('dark');
    html.classList.toggle('pcode-theme-aura-active', dark);

    /* Keep aura layer in both themes (CSS tunes blob strength per mode) */
    wrap.classList.remove('is-fading-out');
    wrap.style.display = '';
    wrap.style.opacity = '';
  }

  function prefersReducedMotion() {
    try {
      return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  }

  function themeOriginFromEl(fromEl) {
    var originX = global.innerWidth / 2;
    var originY = global.innerHeight / 2;
    if (fromEl && fromEl.getBoundingClientRect) {
      var rect = fromEl.getBoundingClientRect();
      originX = rect.left + rect.width / 2;
      originY = rect.top + rect.height / 2;
    }
    var maxDist = Math.hypot(
      Math.max(originX, global.innerWidth - originX),
      Math.max(originY, global.innerHeight - originY)
    );
    return {
      x: originX,
      y: originY,
      r: Math.ceil(maxDist * 1.15)
    };
  }

  function supportsViewTransition() {
    return typeof document.startViewTransition === 'function';
  }

  /** Fallback wipe when View Transitions API is unavailable. */
  function playThemeRipple(fromEl, nextTheme) {
    if (prefersReducedMotion()) return;

    var origin = themeOriginFromEl(fromEl);
    var size = Math.ceil(origin.r * 2);

    var ripple = document.createElement('div');
    ripple.className = 'pcode-theme-ripple';
    ripple.setAttribute('aria-hidden', 'true');
    ripple.dataset.theme = nextTheme === 'light' ? 'light' : 'dark';
    ripple.style.width = size + 'px';
    ripple.style.height = size + 'px';
    ripple.style.left = origin.x - size / 2 + 'px';
    ripple.style.top = origin.y - size / 2 + 'px';
    document.body.appendChild(ripple);

    void ripple.offsetWidth;
    ripple.classList.add('is-expanding');

    var done = function () {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    };
    ripple.addEventListener('transitionend', done, { once: true });
    global.setTimeout(done, 1100);
  }

  function pulseToggleControl(el) {
    if (!el || prefersReducedMotion()) return;
    var target = el.closest('.pcode-theme-pill') || el;
    target.classList.remove('is-theme-pulse');
    void target.offsetWidth;
    target.classList.add('is-theme-pulse');
    global.setTimeout(function () {
      target.classList.remove('is-theme-pulse');
    }, 450);
  }

  function commitTheme(theme, opts) {
    opts = opts || {};
    var html = document.documentElement;
    var dark = theme !== 'light';
    var next = dark ? 'dark' : 'light';
    var current = getTheme();
    var changed = current !== next;

    html.classList.toggle('dark', dark);
    html.style.colorScheme = dark ? 'dark' : 'light';
    html.dataset.pcodeTheme = next;
    html.dataset.pcodeThemeSource = opts.source || 'user';

    if (!opts.skipStore) {
      writeStored(next);
    }

    syncGlassAura({
      animateOut: !!opts.animate && next === 'light'
    });
    syncToggleUI();
    if (changed) {
      dispatchThemeChange(next, opts.source || 'user');
    }
    return { next: next, changed: changed };
  }

  function finishThemeAnim(html) {
    html.classList.remove('pcode-theme-animating');
    html.classList.remove('pcode-theme-vt-to-dark');
    html.classList.remove('pcode-theme-vt-to-light');
    html.style.removeProperty('--pcode-theme-x');
    html.style.removeProperty('--pcode-theme-y');
    html.style.removeProperty('--pcode-theme-r');
  }

  function applyTheme(theme, opts) {
    if (!isThemedPage()) return;
    opts = opts || {};
    var html = document.documentElement;
    var dark = theme !== 'light';
    var next = dark ? 'dark' : 'light';
    var current = getTheme();
    var changed = current !== next;
    var animate =
      changed && !opts.skipStore && opts.source !== 'default' && !opts.skipAnim && !prefersReducedMotion();

    if (!animate) {
      commitTheme(theme, opts);
      return;
    }

    html.classList.add('pcode-theme-animating');
    if (opts.fromEl) pulseToggleControl(opts.fromEl);

    var origin = themeOriginFromEl(opts.fromEl || null);
    html.style.setProperty('--pcode-theme-x', origin.x + 'px');
    html.style.setProperty('--pcode-theme-y', origin.y + 'px');
    html.style.setProperty('--pcode-theme-r', origin.r + 'px');
    html.classList.toggle('pcode-theme-vt-to-dark', next === 'dark');
    html.classList.toggle('pcode-theme-vt-to-light', next === 'light');

    var animOpts = Object.assign({}, opts, { animate: true });

    if (supportsViewTransition()) {
      try {
        var transition = document.startViewTransition(function () {
          commitTheme(theme, animOpts);
        });
        if (transition && transition.finished && typeof transition.finished.then === 'function') {
          transition.finished.then(
            function () {
              finishThemeAnim(html);
            },
            function () {
              finishThemeAnim(html);
            }
          );
        } else {
          global.setTimeout(function () {
            finishThemeAnim(html);
          }, 1000);
        }
        return;
      } catch (_) {
        /* fall through to ripple wipe */
      }
    }

    playThemeRipple(opts.fromEl || null, next);
    commitTheme(theme, animOpts);
    global.setTimeout(function () {
      finishThemeAnim(html);
    }, 1000);
  }

  function toggleTheme(fromEl) {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark', { fromEl: fromEl || null });
  }

  function sidebarPillMarkup() {
    var dark = getTheme() === 'dark';
    return (
      '<div class="pcode-theme-toggle-mount pcode-theme-toggle-mount--sidebar">' +
      '<p class="pcode-theme-pill__status" data-pcode-theme-status>' +
      (dark ? 'Dark mode' : 'Light mode') +
      '</p>' +
      '<div class="pcode-theme-glass-switch pcode-theme-pill' +
      (dark ? ' is-dark' : '') +
      '" role="group" aria-label="Color theme">' +
      '<div class="pcode-theme-glass-switch__capsule pcode-theme-pill__slider" aria-hidden="true"></div>' +
      '<button type="button" class="pcode-theme-glass-switch__segment pcode-theme-pill__segment" data-pcode-theme-set="light" aria-pressed="' +
      (dark ? 'false' : 'true') +
      '">' +
      '<span class="pcode-theme-glass-switch__segment-inner">' +
      ICON_SUN +
      '<span class="pcode-theme-glass-switch__label">Light</span>' +
      '</span></button>' +
      '<button type="button" class="pcode-theme-glass-switch__segment pcode-theme-pill__segment" data-pcode-theme-set="dark" aria-pressed="' +
      (dark ? 'true' : 'false') +
      '">' +
      '<span class="pcode-theme-glass-switch__segment-inner">' +
      ICON_MOON +
      '<span class="pcode-theme-glass-switch__label">Dark</span>' +
      '</span></button>' +
      '</div></div>'
    );
  }

  function syncToggleUI() {
    var dark = getTheme() === 'dark';
    document.querySelectorAll('[data-pcode-theme-toggle]').forEach(function (btn) {
      btn.setAttribute(
        'aria-label',
        dark ? 'Switch to light mode' : 'Switch to dark mode'
      );
      btn.setAttribute('title', dark ? 'Light mode' : 'Dark mode');
      btn.classList.toggle('is-dark', dark);
    });
    document.querySelectorAll('.pcode-theme-pill').forEach(function (pill) {
      pill.classList.toggle('is-dark', dark);
    });
    document.querySelectorAll('[data-pcode-theme-set]').forEach(function (seg) {
      var mode = seg.getAttribute('data-pcode-theme-set');
      seg.setAttribute('aria-pressed', mode === (dark ? 'dark' : 'light') ? 'true' : 'false');
    });
    document.querySelectorAll('[data-pcode-theme-status]').forEach(function (el) {
      el.textContent = dark ? 'Dark mode' : 'Light mode';
    });
  }

  function bindToggleClicks(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-pcode-theme-toggle]').forEach(function (btn) {
      if (btn.dataset.pcodeBound === '1') return;
      btn.dataset.pcodeBound = '1';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleTheme(btn);
      });
    });
    scope.querySelectorAll('[data-pcode-theme-set]').forEach(function (btn) {
      if (btn.dataset.pcodeBound === '1') return;
      btn.dataset.pcodeBound = '1';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var mode = btn.getAttribute('data-pcode-theme-set');
        if (mode === 'light' || mode === 'dark') {
          applyTheme(mode, { fromEl: btn });
        }
      });
    });
  }

  function removeNavToggle() {
    var existing = document.getElementById(NAV_MOUNT_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    document.querySelectorAll('.pcode-theme-toggle-mount--nav').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function prepareSidebarLayout(sidebar) {
    if (!sidebar) return;
    if (sidebar.dataset.pcodeSidebarPrepared !== '1') {
      sidebar.dataset.pcodeSidebarPrepared = '1';
      sidebar.classList.add('pcode-sidebar-layout');
    }

    var closeBtn = sidebar.querySelector('#mobile-menu-close-btn');
    var existingScroll = sidebar.querySelector('.pcode-sidebar-scroll');
    if (!existingScroll) {
      var scroll = document.createElement('div');
      scroll.className = 'pcode-sidebar-scroll flex-1 overflow-y-auto min-h-0 w-full';
      Array.from(sidebar.children).forEach(function (child) {
        if (child === closeBtn) return;
        if (child.classList.contains(SIDEBAR_FOOTER_CLASS)) return;
        scroll.appendChild(child);
      });
      sidebar.appendChild(scroll);
    }

    var footer = sidebar.querySelector('.' + SIDEBAR_FOOTER_CLASS);
    if (!footer) {
      footer = document.createElement('div');
      footer.className = SIDEBAR_FOOTER_CLASS;
      footer.innerHTML = sidebarPillMarkup();
      sidebar.appendChild(footer);
    } else if (!footer.querySelector('.pcode-theme-pill')) {
      footer.innerHTML = sidebarPillMarkup();
    }
    bindToggleClicks(footer);
  }

  function prepareAdminSidebar(sidebar) {
    if (!sidebar) return;
    if (sidebar.dataset.pcodeAdminSidebarPrepared !== '1') {
      sidebar.dataset.pcodeAdminSidebarPrepared = '1';
      sidebar.classList.add('pcode-sidebar-layout');
      var existingFooter = sidebar.querySelector('.sidebar-footer');
      var existingScroll = sidebar.querySelector('.pcode-sidebar-scroll');
      if (!existingScroll) {
        var scroll = document.createElement('div');
        scroll.className = 'pcode-sidebar-scroll flex-1 overflow-y-auto min-h-0 w-full';
        Array.from(sidebar.children).forEach(function (child) {
          if (child.classList.contains('sidebar-footer')) return;
          if (child.classList.contains(SIDEBAR_FOOTER_CLASS)) return;
          scroll.appendChild(child);
        });
        if (existingFooter) sidebar.insertBefore(scroll, existingFooter);
        else sidebar.appendChild(scroll);
      }
    }

    var host = sidebar.querySelector('.sidebar-footer') || sidebar;
    if (!host.querySelector('.pcode-theme-pill')) {
      var mount = document.createElement('div');
      mount.className = SIDEBAR_FOOTER_CLASS;
      mount.innerHTML = sidebarPillMarkup();
      host.appendChild(mount);
      bindToggleClicks(mount);
    }
  }

  function prepareSidebars() {
    if (!isThemedPage()) return;
    var mobileMenu = document.getElementById('mobile-menu');
    if (mobileMenu) prepareSidebarLayout(mobileMenu);
    var adminSidebar = document.querySelector('.admin-sidebar');
    if (adminSidebar) prepareAdminSidebar(adminSidebar);
  }

  function ensureChartThemeScript() {
    if (global.PcodeChartTheme) return;
    if (document.querySelector('script[src*="pcode-chart-theme.js"]')) return;
    var script = document.createElement('script');
    script.src = 'js/pcode-chart-theme.js';
    script.async = true;
    document.head.appendChild(script);
  }

  function init() {
    if (!isThemedPage()) return;

    var stored = readStored();
    if (stored === 'light' || stored === 'dark') {
      applyTheme(stored, { skipStore: true, source: 'user' });
    } else {
      applyTheme(getTheme(), { skipStore: true, source: 'default' });
    }

    removeNavToggle();
    prepareSidebars();
    ensureGlassAura();
    syncGlassAura();
    ensureChartThemeScript();
    syncToggleUI();

    global.addEventListener('pcode-theme-change', function () {
      syncGlassAura();
      syncToggleUI();
    });
  }

  global.PcodeTheme = {
    getTheme: getTheme,
    applyTheme: function (theme) {
      applyTheme(theme === 'light' ? 'light' : 'dark');
    },
    setOverride: function (theme) {
      applyTheme(theme === 'light' ? 'light' : 'dark');
    },
    clearOverride: function () {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {}
      applyTheme('dark', { source: 'default', skipAnim: true });
    },
    toggle: function () {
      toggleTheme(null);
    },
    init: init
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
