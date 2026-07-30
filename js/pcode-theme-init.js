/**
 * P-Code theme — apply before first paint (blocking script in <head>).
 * Reads localStorage('pcode-theme') → 'light' | 'dark' (default dark).
 */
(function () {
  'use strict';
  var STORAGE_KEY = 'pcode-theme';
  var html = document.documentElement;

  if (
    !html.classList.contains('pcode-app-bento-root') &&
    !html.classList.contains('login-bento-page')
  ) {
    return;
  }

  var stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (_) {}

  var light = stored === 'light';
  if (light) {
    html.classList.remove('dark');
    html.style.colorScheme = 'light';
    html.dataset.pcodeTheme = 'light';
  } else {
    html.classList.add('dark');
    html.style.colorScheme = 'dark';
    html.dataset.pcodeTheme = 'dark';
  }
  html.dataset.pcodeThemeSource = stored ? 'user' : 'default';

  if (!html.classList.contains('pcode-app-bento-root')) {
    html.classList.add('pcode-app-bento-root');
  }
})();
