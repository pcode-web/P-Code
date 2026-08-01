/**
 * Prompt to save or discard unsaved diagnosis results before loading patient data
 * or refreshing the patient list.
 */
(function (global) {
  'use strict';

  function confirmBeforeAction(opts) {
    opts = opts || {};
    if (!opts.hasUnsaved || !opts.hasUnsaved()) {
      if (opts.proceed) opts.proceed();
      return;
    }

    if (!global.PcodeFormGuard || typeof global.PcodeFormGuard.confirmAction !== 'function') {
      if (global.confirm('You have unsaved diagnosis results. Discard and continue?')) {
        if (opts.discard) opts.discard();
        if (opts.proceed) opts.proceed();
      }
      return;
    }

    global.PcodeFormGuard.confirmAction({
      title: opts.title || 'Save diagnosis before continuing?',
      message: opts.message || 'You have analysis results that have not been saved. Save them to the patient record, or discard to continue without saving.',
      saveLabel: opts.saveLabel || 'Save diagnosis',
      discardLabel: opts.discardLabel || 'Discard results',
      cancelLabel: opts.cancelLabel || 'Cancel',
      onSave: function () {
        var savePromise = opts.save
          ? opts.save()
          : Promise.resolve(true);
        return Promise.resolve(savePromise)
          .then(function (ok) {
            if (ok === false) {
              // Keep dialog open; save handlers must surface the reason (patient missing, etc.).
              return false;
            }
            if (opts.discard) opts.discard();
            if (opts.proceed) opts.proceed();
            return true;
          })
          .catch(function (err) {
            console.error('[PcodeDiagnosisGuard] Save failed', err);
            var msg = (err && err.message) ? String(err.message) : 'Could not save diagnosis. Please try again.';
            if (typeof global.pcodeShowCenterAlert === 'function') {
              global.pcodeShowCenterAlert(msg, 'error');
            } else {
              global.alert(msg);
            }
            return false;
          });
      },
      onDiscard: function () {
        if (opts.discard) opts.discard();
        if (opts.proceed) opts.proceed();
      }
    });
  }

  global.PcodeDiagnosisGuard = {
    confirmBeforeAction: confirmBeforeAction
  };
})(typeof window !== 'undefined' ? window : globalThis);
