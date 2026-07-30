/**
 * Login Google sign-in — custom dark UI + invisible GIS iframe overlay for clicks.
 */
(function () {
  'use strict';

  var renderPending = false;
  var lastWidth = 0;
  var BUTTON_HEIGHT = 48;

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

  function readOnloadConfig() {
    var onload = document.getElementById('g_id_onload');
    if (!onload) {
      return {
        clientId: '953442697406-1nisk0lf775augnlkbbftpk19g4fkgl3.apps.googleusercontent.com',
        loginUri: 'http://localhost/pcode/api/auth/google_callback.php',
        state: 'patient',
      };
    }
    return {
      clientId:
        onload.getAttribute('data-client_id') ||
        '953442697406-1nisk0lf775augnlkbbftpk19g4fkgl3.apps.googleusercontent.com',
      loginUri:
        onload.getAttribute('data-login_uri') ||
        'http://localhost/pcode/api/auth/google_callback.php',
      state: onload.getAttribute('data-state') || 'patient',
    };
  }

  function measureButtonWidth() {
    var form = document.querySelector('.oauth-credentials-form');
    if (!form) return 360;
    return Math.round(form.getBoundingClientRect().width);
  }

  function syncOverlayLayout(stack, mount, width) {
    if (!stack || !mount) return;

    stack.style.width = '100%';
    stack.style.height = BUTTON_HEIGHT + 'px';

    mount.style.width = '100%';
    mount.style.height = BUTTON_HEIGHT + 'px';

    var iframe = mount.querySelector('iframe');
    if (!iframe) return;

    iframe.setAttribute('width', String(width));
    iframe.setAttribute('height', String(BUTTON_HEIGHT));
    iframe.style.position = 'absolute';
    iframe.style.top = '0';
    iframe.style.left = '0';
    iframe.style.width = '100%';
    iframe.style.height = BUTTON_HEIGHT + 'px';
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

  function renderLoginGoogleButton(force) {
    var stack = document.getElementById('google-signin-stack');
    var mount = document.getElementById('google-signin-mount');
    if (!stack || !mount) return Promise.resolve();

    var width = measureButtonWidth();
    if (!force && lastWidth === width && mount.querySelector('iframe')) {
      syncOverlayLayout(stack, mount, width);
      return Promise.resolve();
    }
    lastWidth = width;

    if (renderPending) return Promise.resolve();
    renderPending = true;

    var onloadCfg = readOnloadConfig();
    var renderWidth = Math.min(Math.max(width, 280), 400);

    return waitForGis()
      .then(function () {
        google.accounts.id.initialize({
          client_id: onloadCfg.clientId,
          ux_mode: 'redirect',
          login_uri: onloadCfg.loginUri,
          state: onloadCfg.state,
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: false,
        });

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
