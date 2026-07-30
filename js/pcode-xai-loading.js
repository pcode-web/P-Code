/**
 * P-Code — XAI interpretability loading overlay (race-safe show/hide)
 */
(function (global) {
  'use strict';

  var visibleAt = 0;
  var hideTimer = null;
  var MIN_MS = 300;

  function getEl() {
    return document.getElementById('xai-loading-spinner');
  }

  function show(el) {
    el.classList.remove('hidden');
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('opacity');
    void el.offsetWidth;
    el.classList.remove('opacity-0', 'pointer-events-none');
    el.classList.add('pointer-events-auto');
    el.setAttribute('aria-hidden', 'false');
    el.setAttribute('aria-busy', 'true');
    visibleAt = Date.now();
  }

  function hide(el) {
    var elapsed = Date.now() - visibleAt;
    var waitMs = Math.max(0, MIN_MS - elapsed);

    function finishHide() {
      el.classList.remove('pointer-events-auto');
      el.classList.add('opacity-0', 'pointer-events-none');
      void el.offsetWidth;

      function onDone() {
        el.classList.add('hidden');
        el.setAttribute('aria-hidden', 'true');
        el.removeAttribute('aria-busy');
      }

      function onTransition(e) {
        if (e.target !== el || e.propertyName !== 'opacity') return;
        el.removeEventListener('transitionend', onTransition);
        onDone();
      }

      el.addEventListener('transitionend', onTransition);
      hideTimer = setTimeout(function () {
        el.removeEventListener('transitionend', onTransition);
        onDone();
        hideTimer = null;
      }, 320);
    }

    if (waitMs > 0) {
      hideTimer = setTimeout(finishHide, waitMs);
    } else {
      finishHide();
    }
  }

  function setXaiLoading(isLoading) {
    var el = getEl();
    if (!el) return;

    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }

    if (isLoading) {
      show(el);
    } else {
      hide(el);
    }
  }

  function paintBeforeWork() {
    setXaiLoading(true);
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(resolve);
      });
    });
  }

  global.setXaiLoading = setXaiLoading;
  global.paintXaiLoadingBeforeWork = paintBeforeWork;
})(typeof window !== 'undefined' ? window : global);
