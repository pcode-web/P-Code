/**
 * Login Google sign-in — custom dark UI + invisible GIS iframe overlay for clicks.
 * Uses popup + auth.handleGoogleAuth (Firebase-safe; no localhost PHP redirect).
 */
(function () {
  'use strict';

  var renderPending = false;
  var lastWidth = 0;
  var BUTTON_HEIGHT = 48;
  var _initialized = false;

  function waitForGis() {
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      (function tick() {
        if (window.google && google.accounts && google.accounts.id) {
          resolve();
          return;
        }
        if (++attempts > 50) {
          reject(new Error('Google Identity Services failed to load'));
          return;
        }
        setTimeout(tick, 120);
      })();
    });
  }

  function readClientId() {
    var onload = document.getElementById('g_id_onload');
    var meta = document.querySelector('meta[name="google-signin-client_id"]');
    return (
      (onload && onload.getAttribute('data-client_id')) ||
      (meta && meta.content) ||
      '953442697406-1nisk0lf775augnlkbbftpk19g4fkgl3.apps.googleusercontent.com'
    );
  }

  function resolveMount() {
    return (
      document.getElementById('google-signin-mount-login') ||
      document.querySelector('#google-signin-stack .google-signin-mount') ||
      document.getElementById('google-signin-mount')
    );
  }

  function measureButtonWidth() {
    var form = document.querySelector('.oauth-credentials-form:not(.hidden)');
    if (!form) form = document.querySelector('.oauth-credentials-form');
    if (!form) return 360;
    return Math.round(form.getBoundingClientRect().width);
  }

  function syncOverlayLayout(stack, mount, width) {
    if (!stack || !mount) return;

    stack.style.width = '100%';
    stack.style.height = BUTTON_HEIGHT + 'px';
    stack.style.maxHeight = BUTTON_HEIGHT + 'px';
    stack.style.overflow = 'hidden';
    stack.style.position = 'relative';

    mount.style.position = 'absolute';
    mount.style.inset = '0';
    mount.style.width = '100%';
    mount.style.height = BUTTON_HEIGHT + 'px';
    mount.style.maxHeight = BUTTON_HEIGHT + 'px';
    mount.style.overflow = 'hidden';

    var iframe = mount.querySelector('iframe');
    if (!iframe) return;

    iframe.setAttribute('width', String(width));
    iframe.setAttribute('height', String(BUTTON_HEIGHT));
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = BUTTON_HEIGHT + 'px';
    iframe.style.maxHeight = BUTTON_HEIGHT + 'px';
    iframe.style.margin = '0';
    iframe.style.padding = '0';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.cursor = 'pointer';

    var inner = mount.firstElementChild;
    if (inner) {
      inner.style.position = 'absolute';
      inner.style.inset = '0';
      inner.style.width = '100%';
      inner.style.height = BUTTON_HEIGHT + 'px';
      inner.style.margin = '0';
      inner.style.overflow = 'hidden';
    }
  }

  function resolvePortalType() {
    try {
      var bodyPortal = document.body && document.body.getAttribute('data-pcode-auth-portal');
      if (bodyPortal === 'provider' || bodyPortal === 'community') return bodyPortal;
    } catch (_) {}
    try {
      if (/provider-login\.html/i.test(String(window.location.pathname || ''))) return 'provider';
    } catch (_) {}
    try {
      if (window.auth && typeof window.auth.normalizeSelectedPortalType === 'function') {
        var selected = window.auth.normalizeSelectedPortalType();
        if (selected === 'provider' || selected === 'community') return selected;
      }
    } catch (_) {}
    return 'community';
  }

  function onCredential(response) {
    if (!response || !response.credential) return;
    if (window.auth && typeof window.auth.handleGoogleAuth === 'function') {
      var portal = resolvePortalType();
      try {
        if (typeof window.auth.setSelectedPortalType === 'function') {
          window.auth.setSelectedPortalType(portal);
        } else {
          window.auth.selectedPortalType = portal;
          try {
            sessionStorage.setItem('PMOS_selected_portal_type', portal);
          } catch (_) {}
        }
      } catch (_) {}
      window.auth.handleGoogleAuth(response.credential);
      return;
    }
    console.error('[PcodeLoginGoogle] auth.handleGoogleAuth is not available');
  }

  function renderLoginGoogleButton(force) {
    var stack = document.getElementById('google-signin-stack');
    var mount = resolveMount();
    if (!stack || !mount) return Promise.resolve();

    var width = measureButtonWidth();
    if (!force && lastWidth === width && mount.querySelector('iframe')) {
      syncOverlayLayout(stack, mount, width);
      return Promise.resolve();
    }
    lastWidth = width;

    if (renderPending) return Promise.resolve();
    renderPending = true;

    var renderWidth = Math.min(Math.max(width, 240), 400);

    return waitForGis()
      .then(function () {
        if (!_initialized) {
          google.accounts.id.initialize({
            client_id: readClientId(),
            callback: onCredential,
            auto_select: false,
            cancel_on_tap_outside: true,
            use_fedcm_for_prompt: false,
          });
          _initialized = true;
        }

        mount.innerHTML = '';
        google.accounts.id.renderButton(mount, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: renderWidth,
          locale: 'en',
        });

        requestAnimationFrame(function () {
          syncOverlayLayout(stack, mount, renderWidth);
          setTimeout(function () {
            syncOverlayLayout(stack, mount, renderWidth);
          }, 150);
        });
      })
      .finally(function () {
        renderPending = false;
      });
  }

  function boot() {
    // Tear down any stray full-screen auth modal left by auth.js on this page.
    try {
      var stray = document.getElementById('auth-modal');
      if (stray) {
        stray.classList.add('hidden');
        stray.setAttribute('aria-hidden', 'true');
        stray.style.display = 'none';
        stray.style.pointerEvents = 'none';
      }
    } catch (_) {}

    renderLoginGoogleButton(true).catch(function (err) {
      console.warn('[PcodeLoginGoogle]', err);
    });
  }

  window.PcodeLoginGoogle = {
    render: function () {
      return renderLoginGoogleButton(true);
    },
  };

  window.addEventListener('load', boot);

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      renderLoginGoogleButton(true);
    }, 250);
  });
})();
