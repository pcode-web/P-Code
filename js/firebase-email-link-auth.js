/**
 * P-Code — Email link / passwordless UI for login-new.html
 * Depends on js/firebase-config.js (module) exposing window.PcodeFirebase
 * and js/auth.js for session bridge.
 */
(function (global) {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    var el = $('firebase-email-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
    el.hidden = !msg;
  }

  function setBusy(busy) {
    ['firebase-email-send-btn', 'firebase-password-reset-btn', 'firebase-set-password-btn'].forEach(function (id) {
      var btn = $(id);
      if (btn) btn.disabled = !!busy;
    });
  }

  function currentMode() {
    var active = document.querySelector('[data-firebase-mode].is-active');
    return active ? active.getAttribute('data-firebase-mode') : 'signin';
  }

  function setMode(mode) {
    document.querySelectorAll('[data-firebase-mode]').forEach(function (btn) {
      var on = btn.getAttribute('data-firebase-mode') === mode;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var sendBtn = $('firebase-email-send-btn');
    var resetBtn = $('firebase-password-reset-btn');
    var setPwdWrap = $('firebase-set-password-wrap');
    if (mode === 'password') {
      if (sendBtn) sendBtn.classList.add('hidden');
      if (resetBtn) resetBtn.classList.remove('hidden');
      if (setPwdWrap) setPwdWrap.classList.add('hidden');
    } else {
      if (sendBtn) {
        sendBtn.classList.remove('hidden');
        sendBtn.textContent = mode === 'signup' ? 'Send sign-up link' : 'Send sign-in link';
      }
      if (resetBtn) resetBtn.classList.add('hidden');
      if (setPwdWrap) setPwdWrap.classList.add('hidden');
    }
    setStatus('');
  }

  function portalType() {
    if (global.auth && typeof global.auth.normalizeSelectedPortalType === 'function') {
      return global.auth.normalizeSelectedPortalType() || '';
    }
    return document.body.getAttribute('data-pcode-auth-portal') || '';
  }

  function waitForFirebase(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function tick() {
        if (global.PcodeFirebase && typeof global.PcodeFirebase.sendEmailSignInLink === 'function') {
          resolve(global.PcodeFirebase);
          return;
        }
        if (Date.now() - start > (timeoutMs || 8000)) {
          reject(new Error('Firebase Auth is still loading. Refresh and try again.'));
          return;
        }
        setTimeout(tick, 50);
      })();
    });
  }

  async function bridgeToPcode(idToken, mode) {
    if (!global.auth || typeof global.auth.handleFirebaseAuth !== 'function') {
      throw new Error('Auth bridge is not ready.');
    }
    return global.auth.handleFirebaseAuth(idToken, { mode: mode || 'signin' });
  }

  async function handleSendLink() {
    var emailInput = $('firebase-email-input');
    var email = emailInput ? emailInput.value.trim() : '';
    var mode = currentMode();
    setStatus('');
    setBusy(true);
    try {
      var fb = await waitForFirebase();
      var portal = portalType();
      if (portal !== 'community' && portal !== 'provider') {
        setStatus('Choose Regular User or OB-GYN first.', true);
        return;
      }
      var continueUrl =
        window.location.origin +
        window.location.pathname +
        '?firebaseEmailLink=1&portal=' +
        encodeURIComponent(portal);
      await fb.sendEmailSignInLink(email, { mode: mode, continueUrl: continueUrl });
      setStatus(
        'Check your inbox for a sign-in link for ' +
          email +
          '. Open it on this device to finish ' +
          (mode === 'signup' ? 'creating your account' : 'signing in') +
          '.'
      );
    } catch (err) {
      var msg = (err && err.message) || 'Could not send email link.';
      if (String(msg).indexOf('auth/unauthorized-continue-uri') >= 0) {
        msg = 'Add this site to Firebase Auth authorized domains (Authentication → Settings).';
      }
      setStatus(msg, true);
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordReset() {
    var emailInput = $('firebase-email-input');
    var email = emailInput ? emailInput.value.trim() : '';
    setStatus('');
    setBusy(true);
    try {
      var fb = await waitForFirebase();
      var continueUrl =
        window.location.origin + window.location.pathname + '?firebasePasswordReset=1';
      await fb.sendPasswordReset(email, continueUrl);
      setStatus('Password reset email sent to ' + email + '. Follow the link to choose a new password.');
    } catch (err) {
      setStatus((err && err.message) || 'Could not send password reset email.', true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetPassword() {
    var p1 = $('firebase-new-password');
    var p2 = $('firebase-new-password-confirm');
    var a = p1 ? p1.value : '';
    var b = p2 ? p2.value : '';
    if (a !== b) {
      setStatus('Passwords do not match.', true);
      return;
    }
    if (global.auth && typeof global.auth.validatePassword === 'function' && !global.auth.validatePassword(a)) {
      setStatus('Password must contain uppercase, lowercase, number, and special character.', true);
      return;
    }
    setBusy(true);
    try {
      var fb = await waitForFirebase();
      await fb.setFirebasePassword(a);
      // Also sync to P-Code profile password when a session exists
      if (global.auth && global.auth.token && a) {
        var hashed =
          typeof global.auth.hashPasswordForApi === 'function'
            ? await global.auth.hashPasswordForApi(a)
            : a;
        await fetch((typeof pcodeApiUrl==='function'?pcodeApiUrl('./api/update_profile.php'):'./api/update_profile.php'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + global.auth.token
          },
          body: JSON.stringify({ password: hashed })
        });
      }
      setStatus('Password updated. You can use it next time alongside email link sign-in.');
      if (p1) p1.value = '';
      if (p2) p2.value = '';
    } catch (err) {
      setStatus((err && err.message) || 'Could not update password.', true);
    } finally {
      setBusy(false);
    }
  }

  async function tryCompleteEmailLink() {
    try {
      var fb = await waitForFirebase(12000);
      if (!fb.pageIsEmailSignInLink()) return;
      setStatus('Completing email link sign-in…');
      setBusy(true);
      var result = await fb.completeEmailLinkSignIn();
      if (!result || !result.idToken) {
        setStatus('Could not complete email link sign-in.', true);
        return;
      }
      // Prefer portal from query string when returning from email
      try {
        var params = new URLSearchParams(window.location.search);
        var portalQ = params.get('portal');
        if (portalQ === 'community' || portalQ === 'provider') {
          if (global.auth) {
            global.auth.selectedPortalType = portalQ;
          }
          document.body.setAttribute('data-pcode-auth-portal', portalQ);
          try {
            sessionStorage.setItem('PMOS_selected_portal_type', portalQ);
          } catch (_) {}
        }
      } catch (_) {}

      await bridgeToPcode(result.idToken, result.mode);
      // Clean URL
      try {
        var clean = window.location.pathname;
        window.history.replaceState({}, document.title, clean);
      } catch (_) {}
    } catch (err) {
      setStatus((err && err.message) || 'Email link verification failed.', true);
    } finally {
      setBusy(false);
    }
  }

  function bindUi() {
    document.querySelectorAll('[data-firebase-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-firebase-mode'));
      });
    });
    var sendBtn = $('firebase-email-send-btn');
    if (sendBtn) sendBtn.addEventListener('click', handleSendLink);
    var resetBtn = $('firebase-password-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', handlePasswordReset);
    var setPwdBtn = $('firebase-set-password-btn');
    if (setPwdBtn) setPwdBtn.addEventListener('click', handleSetPassword);
    var form = $('firebase-email-link-form');
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (currentMode() === 'password') handlePasswordReset();
        else handleSendLink();
      });
    }
    setMode('signin');
  }

  function init() {
    if (!$('firebase-email-link-panel')) return;
    bindUi();
    tryCompleteEmailLink();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.PcodeFirebaseEmailLinkUI = {
    tryCompleteEmailLink: tryCompleteEmailLink,
    setMode: setMode
  };
})(typeof window !== 'undefined' ? window : globalThis);
