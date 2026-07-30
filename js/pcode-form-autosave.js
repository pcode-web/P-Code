/**
 * P-Code — debounced form autosave (localStorage only)
 */
(function (global) {
  'use strict';

  const DEBOUNCE_MS = 3000;
  /* Keep “Draft saved / restored” readable — was 2s and vanished too fast */
  const SAVED_FADE_MS = 10000;
  const RESTORE_ALERT_MS = 10000;
  const MAX_FIELD_CHARS = 50000;

  function getUserScope() {
    try {
      const token =
        sessionStorage.getItem('PMOS_auth_token') ||
        localStorage.getItem('PMOS_auth_token') ||
        localStorage.getItem('token') ||
        '';
      if (!token) return 'anon';
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.isGuest) return 'guest_' + (payload.id || payload.sub || '0');
      return String(payload.id || payload.sub || payload.user_id || '0');
    } catch (_) {
      return 'anon';
    }
  }

  function buildDraftKey(formType, entityId) {
    const scope = getUserScope();
    const entity = entityId == null || entityId === '' ? 'new' : String(entityId);
    return 'pcode_draft_' + formType + '_' + scope + '_' + entity;
  }

  function debounce(fn, wait) {
    let timer = null;
    const wrapped = function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
    wrapped.cancel = function () {
      clearTimeout(timer);
      timer = null;
    };
    return wrapped;
  }

  function serializeForm(form, getMeta) {
    const fields = {};
    const elements = form.querySelectorAll('input, select, textarea');
    elements.forEach((el) => {
      if (el.disabled || el.readOnly) return;
      if (el.type === 'file' || el.type === 'password') return;
      if (el.dataset && el.dataset.autosaveSkip === 'true') return;

      const key = el.id || el.name;
      if (!key) return;

      if (el.type === 'checkbox') {
        fields[key] = !!el.checked;
        return;
      }
      if (el.type === 'radio') {
        if (el.checked) fields[el.name] = el.value;
        return;
      }
      const value = el.value;
      if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) return;
      fields[key] = value;
    });

    return {
      savedAt: new Date().toISOString(),
      meta: typeof getMeta === 'function' ? getMeta() : {},
      fields
    };
  }

  function applyFormPayload(form, payload, onFieldApplied) {
    if (!payload || !payload.fields) return false;
    const fields = payload.fields;
    Object.keys(fields).forEach((key) => {
      const value = fields[key];
      let el = document.getElementById(key);
      if (!el && form) {
        el = form.querySelector('[name="' + CSS.escape(key) + '"]');
      }
      if (!el) return;

      if (el.type === 'checkbox') {
        el.checked = value === true || value === 1 || value === '1' || value === 'on';
      } else if (el.type === 'radio') {
        const radio = form.querySelector('[name="' + CSS.escape(key) + '"][value="' + CSS.escape(String(value)) + '"]');
        if (radio) radio.checked = true;
      } else {
        el.value = value == null ? '' : value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (typeof onFieldApplied === 'function') onFieldApplied(key, value, el);
    });
    return true;
  }

  function createStatusController(statusEl) {
    if (!statusEl) {
      return {
        setPending() {},
        setSaving() {},
        setSaved() {},
        setIdle() {}
      };
    }

    let fadeTimer = null;

    function setState(state, text, pulse) {
      clearTimeout(fadeTimer);
      statusEl.dataset.state = state;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('pcode-autosave-status--pulse', !!pulse);
      if (state === 'saved') {
        fadeTimer = setTimeout(() => {
          statusEl.dataset.state = 'idle';
          statusEl.textContent = '';
          statusEl.classList.remove('pcode-autosave-status--pulse');
        }, SAVED_FADE_MS);
      }
    }

    return {
      setPending() {
        setState('pending', 'Changes made…', false);
      },
      setSaving() {
        setState('saving', 'Saving…', true);
      },
      setSaved(label) {
        setState('saved', label || 'Draft saved locally', false);
      },
      setIdle() {
        setState('idle', '', false);
      }
    };
  }

  function FormAutosave(options) {
    this.form = options.form;
    this.formType = options.formType || 'form';
    this.entityId = options.entityId != null ? String(options.entityId) : 'new';
    this.statusEl = options.statusEl || null;
    this.getMeta = options.getMeta || (() => ({}));
    this.onRestore = options.onRestore || null;
    this.onAfterRestore = options.onAfterRestore || null;
    this.onFieldApplied = options.onFieldApplied || null;
    this.suppressEvents = false;
    this.status = createStatusController(this.statusEl);
    this._debouncedSave = debounce(() => this.executeSave(), DEBOUNCE_MS);
    this._onFormEvent = this._onFormEvent.bind(this);
  }

  FormAutosave.prototype.getDraftKey = function () {
    return buildDraftKey(this.formType, this.entityId);
  };

  FormAutosave.prototype.readDraft = function () {
    try {
      const raw = localStorage.getItem(this.getDraftKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('[PcodeAutosave] Failed to read draft', e);
      return null;
    }
  };

  FormAutosave.prototype.attach = function () {
    if (!this.form || this.form.dataset.pcodeAutosaveBound === 'true') return this;
    this.form.dataset.pcodeAutosaveBound = 'true';
    this.form.addEventListener('input', this._onFormEvent);
    this.form.addEventListener('change', this._onFormEvent);
    return this;
  };

  FormAutosave.prototype.detach = function () {
    if (!this.form) return;
    this.form.removeEventListener('input', this._onFormEvent);
    this.form.removeEventListener('change', this._onFormEvent);
    delete this.form.dataset.pcodeAutosaveBound;
    this._debouncedSave.cancel();
  };

  FormAutosave.prototype._onFormEvent = function () {
    if (this.suppressEvents) return;
    this.status.setPending();
    this._debouncedSave();
  };

  FormAutosave.prototype.executeSave = function () {
    if (!this.form) return false;
    const payload = serializeForm(this.form, this.getMeta);
    const key = this.getDraftKey();

    try {
      localStorage.setItem(key, JSON.stringify(payload));
      this.status.setSaved('Draft saved locally');
      return true;
    } catch (e) {
      console.warn('[PcodeAutosave] localStorage write failed', e);
      this.status.setSaved('Could not save draft');
      return false;
    }
  };

  // Immediate local persist (used by the unsaved-changes guard).
  // Keeps the old name so existing callers continue to work.
  FormAutosave.prototype.forceServerSave = function () {
    return Promise.resolve(this.executeSave());
  };

  FormAutosave.prototype.forceLocalSave = function () {
    return this.executeSave();
  };

  FormAutosave.prototype.tryRestoreDraft = function (options) {
    options = options || {};
    const draft = this.readDraft();
    if (!draft || !draft.fields || Object.keys(draft.fields).length === 0) {
      return false;
    }

    this.suppressEvents = true;
    applyFormPayload(this.form, draft, this.onFieldApplied);
    if (typeof this.onAfterRestore === 'function') {
      this.onAfterRestore(draft);
    }
    if (typeof this.onRestore === 'function') {
      this.onRestore(draft);
    }
    this.suppressEvents = false;

    if (options.notify !== false) {
      const restoredAt = draft.savedAt
        ? new Date(draft.savedAt).toLocaleString()
        : 'earlier';
      if (typeof global.pcodeShowCenterAlert === 'function') {
        global.pcodeShowCenterAlert('Unsaved draft restored from ' + restoredAt, 'info', {
          dismissMs: RESTORE_ALERT_MS
        });
      } else if (typeof global.showPatientsToast === 'function') {
        global.showPatientsToast('Unsaved draft restored', 'info');
      }
    }
    this.status.setSaved('Draft restored');
    return true;
  };

  FormAutosave.prototype.setEntityId = function (entityId) {
    this.entityId = entityId == null || entityId === '' ? 'new' : String(entityId);
    return this;
  };

  FormAutosave.prototype.onContextChange = function (entityId, restoreOptions) {
    this._debouncedSave.cancel();
    this.setEntityId(entityId);
    return this.tryRestoreDraft(restoreOptions);
  };

  FormAutosave.prototype.clearDraft = function () {
    this._debouncedSave.cancel();
    try {
      localStorage.removeItem(this.getDraftKey());
    } catch (_) {}
    this.status.setIdle();
  };

  global.PcodeFormAutosave = {
    DEBOUNCE_MS,
    buildDraftKey,
    serializeForm,
    applyFormPayload,
    create(options) {
      const instance = new FormAutosave(options);
      instance.attach();
      return instance;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
