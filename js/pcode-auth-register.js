/**
 * Credential sign-in + registration for patient + provider login pages.
 * Firebase Hosting has no PHP — all auth goes through the Render Flask API.
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

  function apiUrl(path) {
    if (typeof global.pcodeApiUrl === 'function') {
      return global.pcodeApiUrl(path);
    }
    if (global.auth && typeof global.auth.resolveApiUrl === 'function') {
      return global.auth.resolveApiUrl(String(path).replace(/^api\//i, ''));
    }
    return (
      'https://p-code-nqak.onrender.com/api/' +
      String(path).replace(/^api\//i, '').replace(/\.php$/i, '')
    );
  }

  function hashPassword(password) {
    if (global.PcodePassword && typeof global.PcodePassword.sha256Hex === 'function') {
      return global.PcodePassword.sha256Hex(password);
    }
    if (global.auth && typeof global.auth.hashPasswordForApi === 'function') {
      return global.auth.hashPasswordForApi(password);
    }
    return Promise.resolve(password);
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

    // Keep Google available for both sign-in and create-account
    try {
      document.body && document.body.setAttribute('data-pcode-auth-mode', isRegister ? 'register' : 'signin');
      var divider = root.querySelector('[data-google-divider-signin]');
      if (divider) {
        divider.textContent = isRegister
          ? divider.getAttribute('data-google-divider-register') || 'or create account with Google'
          : divider.getAttribute('data-google-divider-signin') || 'or continue with Google';
      }
      var label = root.querySelector('[data-google-label-signin]');
      if (label) {
        label.textContent = isRegister
          ? label.getAttribute('data-google-label-register') || 'Sign up with Google'
          : label.getAttribute('data-google-label-signin') || 'Sign in with Google';
      }
      var mount = root.querySelector('#google-signin-mount');
      if (mount) {
        mount.setAttribute(
          'aria-label',
          isRegister ? 'Sign up with Google' : 'Sign in with Google'
        );
      }
      if (global.PcodeLoginGoogle && typeof global.PcodeLoginGoogle.render === 'function') {
        global.PcodeLoginGoogle.render();
      }
    } catch (_) {}
  }

  function afterLoginSuccess(result, portal) {
    var token = result.token;
    var user = result.user;
    var expiresIn = result.expiresIn != null ? result.expiresIn : 2592000;
    var portalKey = portal === 'provider' ? 'provider' : 'community';

    if (global.auth && typeof global.auth.setSession === 'function') {
      global.auth.setSession(token, user, expiresIn, true, portalKey);
    } else {
      try {
        var expiryMs = Date.now() + Number(expiresIn) * 1000;
        sessionStorage.setItem('PMOS_auth_token', token);
        sessionStorage.setItem('PMOS_user', JSON.stringify(user));
        sessionStorage.setItem('PMOS_token_expiry', String(expiryMs));
        sessionStorage.setItem('PMOS_login_portal', portalKey);
      } catch (_) {}
    }

    var next =
      portal === 'provider'
        ? 'provider-dashboard.html'
        : typeof global.auth !== 'undefined' &&
            global.auth &&
            typeof global.auth.getDefaultDashboardForUser === 'function'
          ? global.auth.getDefaultDashboardForUser(user)
          : 'index.html';
    global.location.replace(next);
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

    if (signinForm) {
      signinForm.removeAttribute('action');
      signinForm.setAttribute('action', '#');
      signinForm.addEventListener('submit', function (e) {
        e.preventDefault();
        setError(errorEl, '');
        setError(successEl, '');

        var emailField = signinForm.elements.email;
        var passwordField = signinForm.elements.password;
        var email = emailField ? String(emailField.value || '').trim() : '';
        var password = passwordField ? String(passwordField.value || '') : '';

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          setError(errorEl, 'Please enter a valid email address.');
          return;
        }
        if (password.length < 8) {
          setError(errorEl, 'Password must be at least 8 characters.');
          return;
        }

        var submitBtn = signinForm.querySelector('[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        hashPassword(password)
          .then(function (digest) {
            return fetch(apiUrl('api/login.php'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                email: email,
                password: digest,
                expectedAccess: portal === 'provider' ? 'provider' : 'community',
                loginContext: 'portal-pick',
              }),
            });
          })
          .then(function (res) {
            return res.text().then(function (text) {
              var data = null;
              try {
                data = text ? JSON.parse(text) : null;
              } catch (_) {
                data = null;
              }
              return { ok: res.ok, status: res.status, data: data };
            });
          })
          .then(function (result) {
            if (!result.data || result.data.success !== true || !result.data.token || !result.data.user) {
              var msg =
                (result.data && (result.data.message || result.data.error)) ||
                (result.status === 404
                  ? 'Sign-in API not found. Check that the Render API is online.'
                  : 'Invalid email or password.');
              setError(errorEl, msg);
              return;
            }
            afterLoginSuccess(result.data, portal);
          })
          .catch(function () {
            setError(errorEl, 'Cannot reach the auth API. Please try again.');
          })
          .finally(function () {
            if (submitBtn) submitBtn.disabled = false;
          });
      });
    }

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

      hashPassword(password)
        .then(function (digest) {
          return fetch(apiUrl('api/register.php'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
              (result.data && (result.data.message || result.data.error)) ||
                'Registration failed. Please try again.'
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

    var params = new URLSearchParams(global.location.search);
    if (params.get('mode') === 'register') {
      setMode(root, 'register');
    }
  }

  global.PcodeAuthRegister = { init: init, setMode: setMode };
})(typeof window !== 'undefined' ? window : this);
