/**
 * Credential registration UI for patient + provider login pages.
 */
(function (global) {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function setError(el, message) {
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function validatePasswordStrength(password) {
    return (
      password.length >= 8 &&
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /\d/.test(password) &&
      /[!@#$%^&*(),.?":{}|<>]/.test(password)
    );
  }

  function setMode(root, mode) {
    var isRegister = mode === 'register';
    root.querySelectorAll('[data-auth-mode="signin"]').forEach(function (el) {
      el.classList.toggle('hidden', isRegister);
    });
    root.querySelectorAll('[data-auth-mode="register"]').forEach(function (el) {
      el.classList.toggle('hidden', !isRegister);
    });
    var title = root.querySelector('[data-auth-title]');
    var subtitle = root.querySelector('[data-auth-subtitle]');
    if (title && title.dataset.titleSignin && title.dataset.titleRegister) {
      title.textContent = isRegister ? title.dataset.titleRegister : title.dataset.titleSignin;
    }
    if (subtitle && subtitle.dataset.subtitleSignin && subtitle.dataset.subtitleRegister) {
      subtitle.textContent = isRegister
        ? subtitle.dataset.subtitleRegister
        : subtitle.dataset.subtitleSignin;
    }
  }

  function init(options) {
    var portal = options.portal === 'provider' ? 'provider' : 'patient';
    var root = options.root || document;
    var signinForm = $(options.signinFormId);
    var registerForm = $(options.registerFormId);
    var errorEl = $(options.errorId || 'oauth-bootstrap-error');
    var successEl = $(options.successId || 'oauth-bootstrap-success');

    root.querySelectorAll('[data-auth-switch]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        setError(errorEl, '');
        setError(successEl, '');
        setMode(root, btn.getAttribute('data-auth-switch') || 'signin');
      });
    });

    if (!registerForm) return;

    registerForm.addEventListener('submit', function (e) {
      e.preventDefault();
      setError(errorEl, '');
      setError(successEl, '');

      var nameField = registerForm.elements.user_name || registerForm.elements.name;
      var emailField = registerForm.elements.email;
      var passwordField = registerForm.elements.password;
      var institutionField = registerForm.elements.institution;

      var name = nameField ? String(nameField.value || '').trim() : '';
      var email = emailField ? String(emailField.value || '').trim() : '';
      var password = passwordField ? String(passwordField.value || '') : '';
      var institution = institutionField ? String(institutionField.value || '').trim() : '';

      // Name / institution are optional at signup — derive a display name from email.
      // Users can update profile details later in Edit Profile.
      if (!name && email) {
        var local = email.split('@')[0] || '';
        name = local
          .replace(/[._+\-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\b\w/g, function (c) {
            return c.toUpperCase();
          });
      }

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setError(errorEl, 'Please enter a valid email address.');
        return;
      }
      if (!validatePasswordStrength(password)) {
        setError(
          errorEl,
          'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
        );
        return;
      }

      var submitBtn = registerForm.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      var hashPromise =
        global.PcodePassword && typeof global.PcodePassword.sha256Hex === 'function'
          ? global.PcodePassword.sha256Hex(password)
          : Promise.resolve(password);

      hashPromise
        .then(function (digest) {
          return fetch('api/register.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_name: name,
              email: email,
              password: digest,
              institution: institution,
              registration_portal: portal,
            }),
          });
        })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, status: res.status, data: data };
          });
        })
        .then(function (result) {
          if (!result.data || result.data.success !== true) {
            setError(
              errorEl,
              (result.data && result.data.message) || 'Registration failed. Please try again.'
            );
            return;
          }
          setMode(root, 'signin');
          if (signinForm && signinForm.elements.email) {
            signinForm.elements.email.value = email;
          }
          setError(
            successEl,
            (result.data && result.data.message) || 'Account created. Please sign in.'
          );
          registerForm.reset();
        })
        .catch(function () {
          setError(errorEl, 'Network error. Please try again.');
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });

    // Deep-link ?mode=register
    var params = new URLSearchParams(global.location.search);
    if (params.get('mode') === 'register') {
      setMode(root, 'register');
    }
  }

  global.PcodeAuthRegister = { init: init, setMode: setMode };
})(typeof window !== 'undefined' ? window : this);
