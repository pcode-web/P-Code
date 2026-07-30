/**
 * P-Code — Form Dirty-State Guard & Navigation Intercept Layer
 *
 * Gates the autosave/persistence pipeline behind an explicit confirmation state.
 * Responsibilities:
 *   1. Track a dirty-state boolean per form (input / select / checkbox / file).
 *   2. Intercept modal close controls + backdrop clicks with a "Save changes
 *      before leaving?" dialog exposing SAVE / DISCARD paths.
 *   3. Guard full-page traversal (sidebar links) and browser/tab closure
 *      (beforeunload) while changes are pending.
 *   4. Run the real persistence fetch() only on an explicit SAVE, and surface
 *      a temporary green success badge on a 200 JSON response.
 *
 * Framework-free. Exposes window.PcodeFormGuard.
 */
(function (global) {
  'use strict';

  var MAX_FIELD_CHARS = 50000;
  var BADGE_VISIBLE_MS = 2600;

  /* ----------------------------- helpers ----------------------------- */

  function serializeForm(form) {
    var fields = {};
    if (!form) return fields;
    var elements = form.querySelectorAll('input, select, textarea');
    elements.forEach(function (el) {
      if (el.type === 'file' || el.type === 'password') return;
      if (el.dataset && el.dataset.guardSkip === 'true') return;
      var key = el.id || el.name;
      if (!key) return;
      if (el.type === 'checkbox') {
        fields['chk::' + key] = !!el.checked;
        return;
      }
      if (el.type === 'radio') {
        if (el.checked) fields['rad::' + el.name] = el.value;
        return;
      }
      var value = el.value;
      if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) return;
      fields['val::' + key] = value;
    });
    return fields;
  }

  function applySnapshot(form, snapshot, suppressDispatch) {
    if (!form || !snapshot) return;
    Object.keys(snapshot).forEach(function (composite) {
      var sep = composite.indexOf('::');
      var kind = composite.slice(0, sep);
      var key = composite.slice(sep + 2);
      var value = snapshot[composite];

      if (kind === 'chk') {
        var chk = document.getElementById(key) || form.querySelector('[name="' + cssEscape(key) + '"]');
        if (chk && chk.type === 'checkbox') {
          chk.checked = !!value;
          if (!suppressDispatch) fireChange(chk);
        }
        return;
      }
      if (kind === 'rad') {
        var radio = form.querySelector('[name="' + cssEscape(key) + '"][value="' + cssEscape(String(value)) + '"]');
        if (radio) {
          radio.checked = true;
          if (!suppressDispatch) fireChange(radio);
        }
        return;
      }
      var el = document.getElementById(key) || form.querySelector('[name="' + cssEscape(key) + '"]');
      if (!el) return;
      el.value = value == null ? '' : value;
      if (!suppressDispatch) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    var ak = Object.keys(a);
    var bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var i = 0; i < ak.length; i++) {
      var k = ak[i];
      if (String(a[k]) !== String(b[k])) return false;
    }
    return true;
  }

  function cssEscape(str) {
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(str);
    return String(str).replace(/["\\\]]/g, '\\$&');
  }

  function fireChange(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ------------------------ confirmation dialog ---------------------- */

  var CHECK_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
  var WARN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

  function buildConfirmDialog(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'pcode-guard-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'pcode-guard-title');

    var card = document.createElement('div');
    card.className = 'pcode-guard-card';

    var icon = document.createElement('div');
    icon.className = 'pcode-guard-card__icon';
    icon.innerHTML = WARN_ICON;

    var title = document.createElement('h3');
    title.className = 'pcode-guard-card__title';
    title.id = 'pcode-guard-title';
    title.textContent = opts.title || 'Save changes before leaving?';

    var message = document.createElement('p');
    message.className = 'pcode-guard-card__message';
    message.textContent = opts.message || 'You have unsaved changes that will be lost.';

    var actions = document.createElement('div');
    actions.className = 'pcode-guard-card__actions';

    var discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pcode-guard-btn pcode-guard-btn--discard';
    discardBtn.textContent = opts.discardLabel || 'Discard';

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'pcode-guard-btn pcode-guard-btn--save';
    saveBtn.innerHTML = '<span class="pcode-guard-btn__label">' + (opts.saveLabel || 'Save & close') + '</span>';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'pcode-guard-card__cancel';
    cancelBtn.textContent = opts.cancelLabel || 'Keep editing';

    actions.appendChild(discardBtn);
    actions.appendChild(saveBtn);

    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(actions);
    card.appendChild(cancelBtn);
    overlay.appendChild(card);

    var closed = false;
    var previouslyFocused = document.activeElement;

    function cleanup() {
      if (closed) return;
      closed = true;
      overlay.classList.remove('is-visible');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          try { previouslyFocused.focus(); } catch (_) {}
        }
      }, 180);
    }

    function setBusy(busy) {
      saveBtn.disabled = busy;
      discardBtn.disabled = busy;
      cancelBtn.disabled = busy;
      saveBtn.classList.toggle('is-loading', busy);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
    }

    function handleSave() {
      if (closed) return;
      var result = opts.onSave ? opts.onSave({ setBusy: setBusy, close: cleanup }) : true;
      if (result && typeof result.then === 'function') {
        setBusy(true);
        result.then(function (ok) {
          setBusy(false);
          if (ok !== false) cleanup();
        }).catch(function () {
          setBusy(false);
        });
      } else if (result !== false) {
        cleanup();
      }
    }

    function handleDiscard() {
      if (closed) return;
      cleanup();
      if (opts.onDiscard) opts.onDiscard();
    }

    function handleCancel() {
      if (closed) return;
      cleanup();
      if (opts.onCancel) opts.onCancel();
    }

    saveBtn.addEventListener('click', handleSave);
    discardBtn.addEventListener('click', handleDiscard);
    cancelBtn.addEventListener('click', handleCancel);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) handleCancel();
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    requestAnimationFrame(function () {
      overlay.classList.add('is-visible');
      saveBtn.focus();
    });

    return { close: cleanup };
  }

  /* --------------------------- success badge ------------------------- */

  function showSuccessBadge(text) {
    var badge = document.createElement('div');
    badge.className = 'pcode-guard-success-badge';
    badge.setAttribute('role', 'status');
    badge.innerHTML =
      '<span class="pcode-guard-success-badge__icon">' + CHECK_ICON + '</span>' +
      '<span class="pcode-guard-success-badge__text"></span>';
    badge.querySelector('.pcode-guard-success-badge__text').textContent = text || 'Saved to database';
    document.body.appendChild(badge);
    requestAnimationFrame(function () {
      badge.classList.add('is-visible');
    });
    setTimeout(function () {
      badge.classList.remove('is-visible');
      setTimeout(function () {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }, 260);
    }, BADGE_VISIBLE_MS);
  }

  /* ----------------------------- guard core -------------------------- */

  function FormGuard(options) {
    this.form = options.form || null;
    this.statusEl = options.statusEl || null;
    this.title = options.title || 'Save changes before leaving?';
    this.message = options.message || 'You have unsaved changes that will be lost if you leave now.';
    this.saveLabel = options.saveLabel || 'Save & close';
    this.discardLabel = options.discardLabel || 'Discard';
    this.cancelLabel = options.cancelLabel || 'Keep editing';
    this.saveFn = typeof options.saveFn === 'function' ? options.saveFn : null;
    this.discardFn = typeof options.discardFn === 'function' ? options.discardFn : null;
    this.closeFn = typeof options.closeFn === 'function' ? options.closeFn : null;
    this.successText = options.successText || 'Changes saved to database';
    this.navGuard = options.navGuard !== false;
    this.isActive = typeof options.isActive === 'function' ? options.isActive : null;
    this.shouldIgnore = typeof options.shouldIgnore === 'function' ? options.shouldIgnore : null;
    this.successBadge = options.successBadge !== false;

    this._dirty = false;
    this._suppressDepth = 0;
    this._baseline = null;
    this._activeDialog = null;
    this._bypassUnload = false;

    this._onFormEvent = this._onFormEvent.bind(this);
    this._onBeforeUnload = this._onBeforeUnload.bind(this);
    this._onDocClick = this._onDocClick.bind(this);
  }

  FormGuard.prototype.attach = function () {
    if (this.form && this.form.dataset.pcodeGuardBound !== 'true') {
      this.form.dataset.pcodeGuardBound = 'true';
      this.form.addEventListener('input', this._onFormEvent, true);
      this.form.addEventListener('change', this._onFormEvent, true);
    }
    if (this.navGuard) {
      global.addEventListener('beforeunload', this._onBeforeUnload);
      document.addEventListener('click', this._onDocClick, true);
    }
    this.captureBaseline();
    return this;
  };

  FormGuard.prototype.detach = function () {
    if (this.form) {
      this.form.removeEventListener('input', this._onFormEvent, true);
      this.form.removeEventListener('change', this._onFormEvent, true);
      delete this.form.dataset.pcodeGuardBound;
    }
    global.removeEventListener('beforeunload', this._onBeforeUnload);
    document.removeEventListener('click', this._onDocClick, true);
  };

  FormGuard.prototype._onFormEvent = function () {
    if (this._suppressDepth > 0) return;
    if (this.shouldIgnore && this.shouldIgnore()) return;
    this.markDirty();
  };

  FormGuard.prototype.markDirty = function () {
    this._dirty = true;
  };

  FormGuard.prototype.markClean = function () {
    this._dirty = false;
    this.captureBaseline();
  };

  FormGuard.prototype.isDirty = function () {
    if (this._dirty && this._baseline && snapshotsEqual(this._baseline, serializeForm(this.form))) {
      this._dirty = false;
    }
    return this._dirty;
  };

  FormGuard.prototype.captureBaseline = function () {
    this._baseline = serializeForm(this.form);
    this._dirty = false;
  };

  FormGuard.prototype.revert = function () {
    if (this._baseline) {
      this.suppress(function () {
        applySnapshot(this.form, this._baseline, false);
      }.bind(this));
    }
    if (this.discardFn) this.discardFn();
    this._dirty = false;
  };

  FormGuard.prototype.suppress = function (fn) {
    this._suppressDepth++;
    try {
      return fn();
    } finally {
      var self = this;
      requestAnimationFrame(function () {
        self._suppressDepth = Math.max(0, self._suppressDepth - 1);
      });
    }
  };

  FormGuard.prototype.beginSuppress = function () {
    this._suppressDepth++;
  };

  FormGuard.prototype.endSuppress = function () {
    this._suppressDepth = Math.max(0, this._suppressDepth - 1);
  };

  FormGuard.prototype._runSave = function () {
    var self = this;
    if (!this.saveFn) {
      this.markClean();
      return Promise.resolve(true);
    }
    // Success reporting (badge) is owned by the page's own save handler via
    // notifySaved(); here we only clear the dirty state so the guard stands down.
    return Promise.resolve()
      .then(function () { return self.saveFn(); })
      .then(function (ok) {
        if (ok === false) return false;
        self.markClean();
        return true;
      });
  };

  FormGuard.prototype.notifySaved = function (text) {
    this.markClean();
    if (this.successBadge) showSuccessBadge(text || this.successText);
  };

  FormGuard.prototype.confirm = function (handlers) {
    var self = this;
    handlers = handlers || {};
    if (this._activeDialog) return;
    this._activeDialog = buildConfirmDialog({
      title: this.title,
      message: this.message,
      saveLabel: handlers.saveLabel || this.saveLabel,
      discardLabel: this.discardLabel,
      cancelLabel: this.cancelLabel,
      onSave: function (ctx) {
        return self._runSave().then(function (ok) {
          self._activeDialog = null;
          if (ok !== false && handlers.onSave) handlers.onSave();
          return ok;
        }).catch(function (err) {
          self._activeDialog = null;
          console.error('[PcodeFormGuard] Save failed', err);
          if (global.pcodeShowCenterAlert) {
            global.pcodeShowCenterAlert('Could not save changes. Please try again.', 'error');
          }
          return false;
        });
      },
      onDiscard: function () {
        self._activeDialog = null;
        self.revert();
        if (handlers.onDiscard) handlers.onDiscard();
      },
      onCancel: function () {
        self._activeDialog = null;
        if (handlers.onCancel) handlers.onCancel();
      }
    });
  };

  // Guard-aware close for modal contexts.
  FormGuard.prototype.attemptClose = function () {
    var self = this;
    if (!this.isDirty()) {
      if (this.closeFn) this.closeFn();
      return;
    }
    this.confirm({
      onSave: function () { if (self.closeFn) self.closeFn(); },
      onDiscard: function () { if (self.closeFn) self.closeFn(); }
    });
  };

  FormGuard.prototype._isGuardArmed = function () {
    if (this.isActive && !this.isActive()) return false;
    return this.isDirty();
  };

  FormGuard.prototype._onBeforeUnload = function (e) {
    if (this._bypassUnload) return;
    if (!this._isGuardArmed()) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  };

  FormGuard.prototype._onDocClick = function (e) {
    if (!this._isGuardArmed()) return;
    var anchor = e.target.closest ? e.target.closest('a[href]') : null;
    if (!anchor) return;
    var href = anchor.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) return;
    if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    if (anchor.dataset && anchor.dataset.guardIgnore === 'true') return;

    var url;
    try {
      url = new URL(anchor.href, global.location.href);
    } catch (_) {
      return;
    }
    if (url.origin !== global.location.origin) return; // external → native beforeunload covers it

    var self = this;
    e.preventDefault();
    e.stopPropagation();
    this.confirm({
      onSave: function () { self._bypassAndGo(url.href); },
      onDiscard: function () { self._bypassAndGo(url.href); }
    });
  };

  FormGuard.prototype._bypassAndGo = function (href) {
    this._bypassUnload = true;
    this._dirty = false;
    global.location.href = href;
  };

  /* ----------------------------- exports ----------------------------- */

  global.PcodeFormGuard = {
    serializeForm: serializeForm,
    showSuccessBadge: showSuccessBadge,
    confirmAction: buildConfirmDialog,
    create: function (options) {
      var guard = new FormGuard(options || {});
      guard.attach();
      return guard;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
