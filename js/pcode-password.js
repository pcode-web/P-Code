/**
 * Password helpers for login / register / profile.
 * Never writes a hash into a visible password input (that caused the hex flash on Sign in).
 * SHA-256 digests are only computed in memory for API/register payloads.
 */
(function (global) {
  'use strict';

  var SHA256_HEX = /^[a-f0-9]{64}$/i;

  function bytesToHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function sha256Hex(plaintext) {
    var text = String(plaintext || '');
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error('Web Crypto is not available for password hashing'));
    }
    var data = new TextEncoder().encode(text);
    return global.crypto.subtle.digest('SHA-256', data).then(bytesToHex);
  }

  function isSha256Digest(value) {
    return SHA256_HEX.test(String(value || '').trim());
  }

  function findSubmitControl(form) {
    return (
      form.querySelector('button[type="submit"], input[type="submit"]') ||
      form.querySelector('button:not([type]), input[type="image"]')
    );
  }

  function requestFormSubmit(form) {
    if (!form) return;
    var btn = findSubmitControl(form);
    if (typeof form.requestSubmit === 'function') {
      try {
        if (btn) form.requestSubmit(btn);
        else form.requestSubmit();
        return;
      } catch (_) {
        /* fall through */
      }
    }
    if (btn && typeof btn.click === 'function') {
      btn.click();
      return;
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }

  /**
   * If a password manager restored a previous SHA-256 digest into the field,
   * clear it so the user types the real password again.
   */
  function clearStaleDigest(field) {
    if (!field) return false;
    if (!isSha256Digest(field.value)) return false;
    field.value = '';
    return true;
  }

  function clearStaleDigestsIn(root) {
    root = root || document;
    var inputs = root.querySelectorAll('input[type="password"], input[type="text"][name="password"]');
    for (var i = 0; i < inputs.length; i++) {
      clearStaleDigest(inputs[i]);
    }
  }

  /**
   * Bind login (or any credential) form:
   * - Enter submits Sign in
   * - Never mutates the password field into a hash
   * - Blocks submit if the field still contains a leftover digest
   */
  function bindForm(form) {
    if (!form || form.dataset.pcodePwdBound === '1') return;
    form.dataset.pcodePwdBound = '1';

    clearStaleDigestsIn(form);

    form.addEventListener('submit', function (e) {
      var field =
        form.querySelector('input[name="password"]:not([type="hidden"])') ||
        form.elements.password;
      if (field && field.length !== undefined && !field.tagName) {
        for (var i = 0; i < field.length; i++) {
          if (field[i].type !== 'hidden') {
            field = field[i];
            break;
          }
        }
      }
      if (field && isSha256Digest(field.value)) {
        e.preventDefault();
        field.value = '';
        field.focus();
        var err = document.getElementById('oauth-bootstrap-error');
        if (err) {
          err.textContent = 'Please re-enter your password and try again.';
          err.classList.remove('hidden');
        }
      }
      // Submit plaintext as typed — server verifies + upgrades storage format.
    });

    form.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      if (e.isComposing || e.repeat) return;

      var target = e.target;
      if (!target || !form.contains(target)) return;
      if (target.tagName === 'TEXTAREA') return;
      if (target.closest && target.closest('[data-auth-switch]')) return;

      var isField =
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        (target.classList && target.classList.contains('oauth-password-toggle'));

      if (!isField) return;

      e.preventDefault();
      requestFormSubmit(form);
    });
  }

  function bindPasswordToggles(root) {
    root = root || document;
    var wraps = root.querySelectorAll('.oauth-password-field');
    for (var i = 0; i < wraps.length; i++) {
      (function (wrap) {
        if (wrap.dataset.pcodePwdToggleBound === '1') return;
        var field = wrap.querySelector('input:not([type="hidden"])');
        var toggle = wrap.querySelector('.oauth-password-toggle');
        if (!field || !toggle) return;
        wrap.dataset.pcodePwdToggleBound = '1';

        toggle.addEventListener('click', function () {
          clearStaleDigest(field);
          var show = field.type === 'password';
          field.type = show ? 'text' : 'password';
          toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
          toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
          toggle.title = show ? 'Hide password' : 'Show password';
          var eye = toggle.querySelector('.oauth-password-icon--hidden');
          var eyeOff = toggle.querySelector('.oauth-password-icon--visible');
          if (eye) eye.classList.toggle('hidden', show);
          if (eyeOff) eyeOff.classList.toggle('hidden', !show);
        });
      })(wraps[i]);
    }
  }

  // Clear leftover digests if the browser restores a cached login page
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', function () {
      clearStaleDigestsIn(document);
    });
  }

  global.PcodePassword = {
    sha256Hex: sha256Hex,
    isSha256Digest: isSha256Digest,
    clearStaleDigestsIn: clearStaleDigestsIn,
    bindForm: bindForm,
    requestFormSubmit: requestFormSubmit,
    bindPasswordToggles: bindPasswordToggles,
  };
})(typeof window !== 'undefined' ? window : this);
