/**
 * P-Code — Google Identity Services (GIS) helper for OAuth-only authentication.
 */
(function (global) {
  'use strict';

  const DISCLAIMERS = {
    community:
      'Registration is instant and handled securely via your Google account. No separate password required.',
    provider:
      'Access restricted to authorized institutional email accounts linked with Google Authentication.',
  };

  let _initialized = false;
  let _clientId = '';

  function getClientId() {
    if (_clientId) return _clientId;
    if (global.PCODE_GOOGLE_CLIENT_ID) return global.PCODE_GOOGLE_CLIENT_ID;
    const meta = document.querySelector('meta[name="google-signin-client_id"]');
    if (meta && meta.content) return meta.content;
    return '953442697406-1nisk0lf775augnlkbbftpk19g4fkgl3.apps.googleusercontent.com';
  }

  function normalizePortal(portal) {
    return portal === 'provider' ? 'provider' : 'community';
  }

  function updateDisclaimer(portal, el) {
    const target = el || document.getElementById('pcode-oauth-disclaimer');
    if (!target) return;
    target.textContent = DISCLAIMERS[normalizePortal(portal)];
    target.setAttribute('data-portal', normalizePortal(portal));
  }

  function onCredential(response) {
    if (!response || !response.credential) {
      console.error('[PcodeGoogleAuth] Missing credential');
      return;
    }
    if (global.auth && typeof global.auth.handleGoogleAuth === 'function') {
      global.auth.handleGoogleAuth(response.credential);
      return;
    }
    console.error('[PcodeGoogleAuth] auth.handleGoogleAuth is not available');
  }

  function waitForGis(maxAttempts, attempt) {
    attempt = attempt || 0;
    return new Promise((resolve, reject) => {
      if (global.google && global.google.accounts && global.google.accounts.id) {
        resolve();
        return;
      }
      if (attempt >= (maxAttempts || 40)) {
        reject(new Error('Google Identity Services failed to load'));
        return;
      }
      setTimeout(() => {
        waitForGis(maxAttempts, attempt + 1).then(resolve).catch(reject);
      }, 150);
    });
  }

  function clearMount(mountEl) {
    if (!mountEl) return;
    mountEl.innerHTML = '';
  }

  function renderButton(options) {
    options = options || {};
    const mountEl =
      (options.mountId && document.getElementById(options.mountId)) ||
      document.getElementById('google-signin-mount') ||
      document.getElementById('google-login-btn');
    const fallbackBtn = options.fallbackButtonId
      ? document.getElementById(options.fallbackButtonId)
      : null;

    if (!mountEl && !fallbackBtn) {
      console.warn('[PcodeGoogleAuth] No mount element found');
      return Promise.resolve();
    }

    const portal = normalizePortal(
      options.portal ||
        (global.auth && global.auth.selectedPortalType) ||
        document.body.getAttribute('data-pcode-auth-portal') ||
        'community'
    );

    updateDisclaimer(portal, options.disclaimerEl);

    return waitForGis()
      .then(() => {
        _clientId = getClientId();
        if (!_initialized) {
          global.google.accounts.id.initialize({
            client_id: _clientId,
            callback: onCredential,
            auto_select: false,
            cancel_on_tap_outside: true,
          });
          _initialized = true;
        }

        const target = mountEl || fallbackBtn;
        clearMount(target);
        if (fallbackBtn) fallbackBtn.classList.add('hidden');

        const isDarkLogin =
          document.documentElement.classList.contains('login-bento-page') ||
          document.body.classList.contains('login-bento-page') ||
          document.body.classList.contains('pcode-detect-user-page') ||
          document.body.classList.contains('pcode-detect-provider-page');

        // Prefer a compact standard button so the G isn't pinned to the far edge
        // of a stretched "Sign in as…" chip.
        var mountW = target.clientWidth || target.offsetWidth || 320;
        var btnWidth = Math.min(280, Math.max(240, Math.round(mountW * 0.85)));

        global.google.accounts.id.renderButton(target, {
          type: 'standard',
          theme: isDarkLogin ? 'filled_black' : 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: btnWidth,
          locale: 'en',
        });

        requestAnimationFrame(function () {
          var iframe = target.querySelector('iframe');
          if (!iframe) return;
          var h = iframe.offsetHeight || parseInt(iframe.getAttribute('height'), 10) || 44;
          target.style.minHeight = Math.max(48, h + 6) + 'px';
        });
      })
      .catch((err) => {
        console.warn('[PcodeGoogleAuth]', err);
        if (fallbackBtn) {
          fallbackBtn.classList.remove('hidden');
          fallbackBtn.textContent = 'Log in with Google';
          fallbackBtn.onclick = function (e) {
            e.preventDefault();
            if (global.google && global.google.accounts && global.google.accounts.id) {
              global.google.accounts.id.prompt();
            }
          };
        }
      });
  }

  function init(options) {
    return renderButton(options);
  }

  function reinitForPortal(portal, options) {
    options = Object.assign({}, options || {}, { portal: portal });
    return renderButton(options);
  }

  global.PcodeGoogleAuth = {
    DISCLAIMERS,
    getClientId,
    updateDisclaimer,
    init,
    reinitForPortal,
    renderButton,
    onCredential,
  };
})(typeof window !== 'undefined' ? window : globalThis);
