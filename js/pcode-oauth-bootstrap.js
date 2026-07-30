/**
 * Hydrate auth.js sessionStorage after PHP OAuth redirect login.
 */
(function () {
  'use strict';

  function getParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (_) {
      return null;
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
    var parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[parts.length - 2] === 'user' || parts[parts.length - 2] === 'obgyn')) {
      return '../api/' + subpath;
    }
    return 'api/' + subpath;
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
    return fetch(pcodeApiUrl('auth/bootstrap_session.php'), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.success) {
          var msg = (result.body && result.body.message) || 'bootstrap_failed';
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
          if (loginPortal) {
            sessionStorage.setItem('PMOS_login_portal', loginPortal);
          }
        }
        window.location.replace(nextUrl);
      });
  }

  window.PcodeOAuthBootstrap = {
    run: function (options) {
      options = options || {};
      var error = getParam('error');
      if (error) {
        showError(error);
        return Promise.resolve();
      }

      var nextUrl = options.next || 'index.html';
      var loginPortal = options.portal || 'community';
      var needsBootstrap =
        options.alwaysBootstrap ||
        getParam('session_ready') === '1' ||
        !sessionStorage.getItem('PMOS_auth_token');

      if (!needsBootstrap && window.auth && window.auth.isAuthenticated && window.auth.isAuthenticated()) {
        window.location.replace(nextUrl);
        return Promise.resolve();
      }

      return bootstrapFromServer(nextUrl, loginPortal).catch(function (err) {
        console.error('[PcodeOAuthBootstrap]', err);
        showError(err && err.message ? err.message : 'bootstrap_failed');
      });
    },
  };

  document.addEventListener('DOMContentLoaded', function () {
    var root = document.documentElement;
    if (!root || root.getAttribute('data-pcode-oauth-bootstrap') !== 'auto') {
      return;
    }
    window.PcodeOAuthBootstrap.run({
      next: root.getAttribute('data-pcode-oauth-next') || 'index.html',
      portal: root.getAttribute('data-pcode-oauth-portal') || 'community',
      alwaysBootstrap: true,
    });
  });
})();
