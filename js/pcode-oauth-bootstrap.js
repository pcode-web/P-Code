/**
 * Hydrate auth.js sessionStorage after OAuth redirect login.
 * On Firebase Hosting this talks to Render (never localhost PHP).
 */
(function () {
  'use strict';

  var RENDER_API = 'https://p-code-nqak.onrender.com/api/';

  function getParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (_) {
      return null;
    }
  }

  function isFirebaseHost() {
    try {
      var host = String(window.location.hostname || '');
      return /\.web\.app$/i.test(host) || /\.firebaseapp\.com$/i.test(host);
    } catch (_) {
      return false;
    }
  }

  function showError(code) {
    var el = document.getElementById('oauth-bootstrap-error');
    if (!el) return;
    var messages = {
      invalid_token: 'Google sign-in could not be verified. Please try again.',
      unauthorized_provider:
        'This Google account is not authorized for the healthcare provider portal.',
      bootstrap_failed: 'We could not complete sign-in. Please try again.',
      'No active OAuth session': 'Your sign-in session expired. Please sign in with Google again.',
    };
    el.textContent = messages[code] || code || messages.bootstrap_failed;
    el.classList.remove('hidden');
  }

  function pcodeApiUrl(subpath) {
    var path = String(subpath || '').replace(/^\.?\/?api\//i, '');
    if (typeof window.pcodeApiUrl === 'function') {
      return window.pcodeApiUrl(path.indexOf('api/') === 0 ? path : 'api/' + path);
    }
    if (isFirebaseHost()) {
      return RENDER_API + path.replace(/\.php$/i, '');
    }
    var parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[parts.length - 2] === 'user' || parts[parts.length - 2] === 'obgyn')) {
      return '../api/' + path;
    }
    return 'api/' + path;
  }

  function resolveNextUrl(next) {
    if (!next) {
      return 'index.html';
    }
    if (/^https?:\/\//i.test(next) || next.charAt(0) === '/') {
      return next;
    }
    var parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[parts.length - 2] === 'user' || parts[parts.length - 2] === 'obgyn')) {
      if (next.indexOf('../') === 0) {
        return next;
      }
      return '../' + next.replace(/^\.\//, '');
    }
    return next;
  }

  function bootstrapFromServer(nextUrl, loginPortal) {
    nextUrl = resolveNextUrl(nextUrl);
    var headers = { Accept: 'application/json' };
    try {
      var existing =
        sessionStorage.getItem('PMOS_auth_token') ||
        localStorage.getItem('PMOS_auth_token') ||
        '';
      if (existing) headers.Authorization = 'Bearer ' + existing;
    } catch (_) {}

    return fetch(pcodeApiUrl('auth/bootstrap_session.php'), {
      method: 'GET',
      credentials: isFirebaseHost() ? 'omit' : 'same-origin',
      headers: headers,
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.success) {
          var msg = (result.body && (result.body.message || result.body.error)) || 'bootstrap_failed';
          throw new Error(msg);
        }
        var token = result.body.token;
        var user = result.body.user;
        var expiresIn = result.body.expiresIn || 2592000;
        if (window.auth && typeof window.auth.setSession === 'function') {
          window.auth.setSession(token, user, expiresIn, false, loginPortal);
        } else {
          var expiryMs = Date.now() + expiresIn * 1000;
          sessionStorage.setItem('PMOS_auth_token', token);
          sessionStorage.setItem('PMOS_user', JSON.stringify(user));
          sessionStorage.setItem('PMOS_token_expiry', String(expiryMs));
        }
        window.location.replace(nextUrl);
      });
  }

  function boot() {
    var err = getParam('error');
    if (err) {
      showError(err);
      return;
    }
    var oauth = getParam('oauth');
    if (oauth !== '1' && oauth !== 'success') {
      return;
    }
    var next = getParam('next') || getParam('redirect') || '';
    var portal =
      (document.body && document.body.getAttribute('data-pcode-auth-portal')) ||
      getParam('portal') ||
      'community';
    bootstrapFromServer(next, portal === 'provider' ? 'provider' : 'community').catch(function (e) {
      showError((e && e.message) || 'bootstrap_failed');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
