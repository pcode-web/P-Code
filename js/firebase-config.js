/**
 * P-Code — Firebase web app + Auth (Email Link / passwordless)
 * Load with: <script type="module" src="js/firebase-config.js"></script>
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  sendPasswordResetEmail,
  updatePassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCQo5PMVcPN-49y3onIyoy3yzoDZNn3ab0',
  authDomain: 'project-a3473fa6-d957-4693-96a.firebaseapp.com',
  projectId: 'project-a3473fa6-d957-4693-96a',
  storageBucket: 'project-a3473fa6-d957-4693-96a.firebasestorage.app',
  messagingSenderId: '866130017925',
  appId: '1:866130017925:web:ee07bd313751587443b3ec'
};

const EMAIL_LINK_STORAGE_KEY = 'PCODE_firebase_email_for_link';
const EMAIL_LINK_MODE_KEY = 'PCODE_firebase_email_link_mode';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function buildActionCodeSettings(continueUrl) {
  const url =
    continueUrl ||
    (typeof window !== 'undefined'
      ? window.location.origin + window.location.pathname + window.location.search
      : '');
  return {
    url: url.split('#')[0],
    handleCodeInApp: true
  };
}

/**
 * Send a passwordless email sign-in / sign-up link.
 * @param {string} email
 * @param {{ mode?: 'signin'|'signup'|'password', continueUrl?: string }} [opts]
 */
async function sendEmailSignInLink(email, opts) {
  const cleaned = normalizeEmail(email);
  if (!cleaned || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    throw new Error('Enter a valid email address.');
  }
  const mode = (opts && opts.mode) || 'signin';
  const settings = buildActionCodeSettings(opts && opts.continueUrl);
  await sendSignInLinkToEmail(auth, cleaned, settings);
  try {
    window.localStorage.setItem(EMAIL_LINK_STORAGE_KEY, cleaned);
    window.localStorage.setItem(EMAIL_LINK_MODE_KEY, mode);
  } catch (_) {}
  return { email: cleaned, mode };
}

/**
 * Send Firebase password-reset email (change / forgot password).
 */
async function sendPasswordReset(email, continueUrl) {
  const cleaned = normalizeEmail(email);
  if (!cleaned || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    throw new Error('Enter a valid email address.');
  }
  const settings = continueUrl ? buildActionCodeSettings(continueUrl) : undefined;
  await sendPasswordResetEmail(auth, cleaned, settings);
  return { email: cleaned };
}

function getStoredEmailForLink() {
  try {
    return normalizeEmail(window.localStorage.getItem(EMAIL_LINK_STORAGE_KEY) || '');
  } catch (_) {
    return '';
  }
}

function getStoredLinkMode() {
  try {
    return String(window.localStorage.getItem(EMAIL_LINK_MODE_KEY) || 'signin');
  } catch (_) {
    return 'signin';
  }
}

function clearStoredEmailLink() {
  try {
    window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
    window.localStorage.removeItem(EMAIL_LINK_MODE_KEY);
  } catch (_) {}
}

function pageIsEmailSignInLink(url) {
  return isSignInWithEmailLink(auth, url || (typeof window !== 'undefined' ? window.location.href : ''));
}

/**
 * Complete email-link sign-in when the user opens the link from their inbox.
 * @returns {Promise<{ user: import('firebase/auth').User, idToken: string, mode: string }|null>}
 */
async function completeEmailLinkSignIn(emailHint) {
  if (!pageIsEmailSignInLink()) {
    return null;
  }
  let email = normalizeEmail(emailHint) || getStoredEmailForLink();
  if (!email && typeof window !== 'undefined') {
    email = normalizeEmail(window.prompt('Confirm your email to finish signing in:') || '');
  }
  if (!email) {
    throw new Error('Email is required to complete the sign-in link.');
  }
  const mode = getStoredLinkMode();
  const cred = await signInWithEmailLink(auth, email, window.location.href);
  clearStoredEmailLink();
  const idToken = await cred.user.getIdToken(true);
  return { user: cred.user, idToken, mode, email };
}

async function getIdToken(forceRefresh) {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken(!!forceRefresh);
}

async function setFirebasePassword(newPassword) {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in with your email link first, then set a password.');
  }
  if (!newPassword || String(newPassword).length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  await updatePassword(user, String(newPassword));
}

async function firebaseSignOut() {
  await signOut(auth);
}

const api = {
  app,
  auth,
  firebaseConfig,
  sendEmailSignInLink,
  sendPasswordReset,
  completeEmailLinkSignIn,
  pageIsEmailSignInLink,
  getStoredEmailForLink,
  getStoredLinkMode,
  clearStoredEmailLink,
  getIdToken,
  setFirebasePassword,
  firebaseSignOut,
  onAuthStateChanged: (cb) => onAuthStateChanged(auth, cb)
};

if (typeof window !== 'undefined') {
  window.PcodeFirebase = api;
}

export {
  app,
  auth,
  firebaseConfig,
  sendEmailSignInLink,
  sendPasswordReset,
  completeEmailLinkSignIn,
  pageIsEmailSignInLink,
  getStoredEmailForLink,
  getIdToken,
  setFirebasePassword,
  firebaseSignOut
};
export default api;
