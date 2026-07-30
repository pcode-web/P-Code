/**
 * P-Code Decision Support System - Authentication Module
 * Handles login, registration, and session management
 */

function ensurePcodeDualRingSpinnerStylesheet() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-dual-ring-spinner-css')) return;
    const link = document.createElement('link');
    link.id = 'pcode-dual-ring-spinner-css';
    link.rel = 'stylesheet';
    link.href = 'css/pcode-dual-ring-spinner.css';
    document.head.appendChild(link);
  } catch (_) {
    /* ignore */
  }
}

/** Inline dual-ring SVG (avoids broken image if asset path or file encoding fails). */
function pcodeDualRingSpinnerMarkup(sizePx) {
  const n = Number(sizePx) || 48;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="' +
    n +
    '" height="' +
    n +
    '" aria-hidden="true">' +
    '<circle class="pcode-drs-outer" cx="32" cy="32" r="23" fill="none" stroke="#7c3aed" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="44 100"/>' +
    '<circle class="pcode-drs-inner" cx="32" cy="32" r="14.5" fill="none" stroke="#ce93d8" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="30 62"/>' +
    '</svg>'
  );
}

/** Client session TTL â€” matches api/config.php JWT_EXPIRY (30 days). */
const AUTH_SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const AUTH_SESSION_TTL_MS = AUTH_SESSION_TTL_SEC * 1000;

class AuthManager {
  constructor() {
    ensurePcodeDualRingSpinnerStylesheet();
    this.currentUser = null;
    this.token = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.apiBaseUrl = './api/';  // Default relative path
    this.apiStyle = 'php';
    this.selectedPortalType = null;
    this._tokenRefreshTimeoutId = null;
    /** Reserved for optional session polling (auto-logout disabled). */
    this._sessionWatchdogId = null;
    this._handlingSessionExpired = false;
    this._sessionChecked = false;
    this._loginModalErrorDismissTimer = null;
    /** Preserves login-new credential error copy if the modal DOM is reset before the dismiss timer runs */
    this._loginNewPendingCredentialMessage = null;

    // Load config
    this.loadConfig();
    
    // Check for existing session
    this.checkSession();
    
    // Setup event listeners
    this.setupEventListeners();
    this.setupSessionVisibilitySync();
    this.ensureAuthFloatModal();
    this.syncGuestMarketingChrome();
  }

  /** Shared Google auth stylesheet for the floating portal chooser modal. */
  ensureGoogleAuthStylesheet() {
    try {
      if (typeof document === 'undefined') return;
      if (document.getElementById('pcode-google-auth-css')) return;
      const existing = document.querySelector('link[href*="pcode-google-auth.css"]');
      if (existing) {
        existing.id = existing.id || 'pcode-google-auth-css';
        return;
      }
      const link = document.createElement('link');
      link.id = 'pcode-google-auth-css';
      link.rel = 'stylesheet';
      link.href = 'css/pcode-google-auth.css?v=20260725-backleft';
      document.head.appendChild(link);
    } catch (_) {
      /* ignore */
    }
  }

  /** Canonical floating auth modal markup (chooser + email/password + Google). */
  getAuthFloatModalHtml() {
    return (
      '<div id="auth-modal" class="auth-modal hidden" aria-hidden="true">' +
      '<div class="auth-modal-overlay" onclick="auth.closeAuthModal()"></div>' +
      '<div class="auth-modal-content pcode-auth-float-card" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">' +
      '<button type="button" class="pcode-auth-float-close" onclick="auth.closeAuthModal()" aria-label="Close">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>' +
      '</svg></button>' +
      '<div id="auth-entry-chooser" class="pcode-auth-float-chooser">' +
      '<div class="pcode-auth-float-brand" aria-label="P-Code, PMOS Detection System">' +
      '<img src="resources/PCODE_LOGO.png" alt="" class="pcode-auth-float-logo" width="72" height="72" decoding="async">' +
      '<p class="pcode-auth-float-tagline">P-Code: PMOS Detection System</p></div>' +
      '<div class="pcode-auth-float-hint">' +
      '<h3 id="auth-modal-title">Choose How to Continue</h3>' +
      '<p>Select your access type before logging in or registering.</p></div>' +
      '<div class="pcode-auth-float-grid">' +
      '<button type="button" id="auth-entry-community" class="pcode-auth-float-option">' +
      '<span class="pcode-auth-float-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="32" cy="32" r="26" stroke="currentColor" stroke-width="3"/>' +
      '<circle cx="32" cy="24" r="7" stroke="currentColor" stroke-width="3"/>' +
      '<path d="M19 45C21.5 38.5 27 35 32 35C37 35 42.5 38.5 45 45" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
      '</svg></span>' +
      '<p class="pcode-auth-float-option-title">Continue as <span class="pcode-regular-user-label">Regular User</span></p>' +
      '<p class="pcode-auth-float-option-desc">For personal early detection, promoting timely clinical intervention and awareness.</p>' +
      '</button>' +
      '<button type="button" id="auth-entry-provider" class="pcode-auth-float-option">' +
      '<span class="pcode-auth-float-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="11" y="10" width="42" height="44" rx="8" stroke="currentColor" stroke-width="3"/>' +
      '<path d="M32 20V40" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M22 30H42" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M22 50H42" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
      '</svg></span>' +
      '<p class="pcode-auth-float-option-title">Continue as<br>OB-GYN</p>' +
      '<p class="pcode-auth-float-option-desc">For OB-GYN specialists using decision support tools with patient management, improving clinical efficiency and patient care.</p>' +
      '</button></div></div>' +
      '<div id="auth-tabs-section" class="hidden pcode-auth-float-signin">' +
      '<button type="button" id="auth-back-to-entry" class="pcode-auth-float-back">&larr; Change access type</button>' +
      '<div class="pcode-auth-float-signin-body">' +
      '<img src="resources/PCODE_LOGO.png" alt="" class="pcode-auth-float-logo pcode-auth-float-logo--sm" width="48" height="48" decoding="async">' +
      '<h3 id="auth-float-mode-title" class="pcode-auth-float-signin-title" data-title-signin="Sign in" data-title-register="Create an account">Sign in</h3>' +
      '<p id="auth-float-mode-sub" class="pcode-auth-float-signin-sub" data-subtitle-signin="Use Google or your email and password." data-subtitle-register="Create an account with email and password, or use Google.">Use Google or your email and password.</p>' +
      '<p id="login-general-error" class="hidden text-sm text-red-600 text-center mt-2" role="alert"></p>' +
      '<p id="auth-float-success" class="hidden text-sm text-green-600 text-center mt-2" role="status"></p>' +
      '<div id="login-form-container" data-auth-mode="signin">' +
      '<form id="login-form" class="pcode-auth-float-cred-form" novalidate>' +
      '<div class="pcode-auth-float-field"><label for="login-email">Email</label>' +
      '<input type="email" id="login-email" name="email" autocomplete="email" placeholder="Enter your email" required>' +
      '<p id="login-email-error" class="pcode-auth-float-field-error hidden"></p></div>' +
      '<div class="pcode-auth-float-field"><label for="login-password">Password</label>' +
      '<input type="password" id="login-password" name="password" autocomplete="current-password" placeholder="Enter your password" required>' +
      '<p id="login-password-error" class="pcode-auth-float-field-error hidden"></p></div>' +
      '<label class="pcode-auth-float-remember"><input type="checkbox" id="remember-me"> Remember me</label>' +
      '<button type="submit" id="login-btn" class="pcode-auth-float-submit">Sign in</button>' +
      '<button type="button" class="pcode-auth-float-switch" data-auth-switch="register">New here? Create an account</button>' +
      '</form></div>' +
      '<div id="register-form-container" class="hidden" data-auth-mode="register" data-pcode-register-minimal="1" hidden>' +
      '<form id="register-form" class="pcode-auth-float-cred-form" novalidate>' +
      '<input type="hidden" id="register-role" value="Regular User">' +
      '<div class="pcode-auth-float-field"><label for="register-email">Email</label>' +
      '<input type="email" id="register-email" name="email" autocomplete="email" placeholder="Enter your email" required>' +
      '<p id="register-email-error" class="pcode-auth-float-field-error hidden"></p></div>' +
      '<div class="pcode-auth-float-field"><label for="register-password">Password</label>' +
      '<input type="password" id="register-password" name="password" autocomplete="new-password" placeholder="Create a password" required>' +
      '<p id="register-password-error" class="pcode-auth-float-field-error hidden"></p></div>' +
      '<p id="register-general-error" class="pcode-auth-float-field-error hidden"></p>' +
      '<button type="submit" id="register-btn" class="pcode-auth-float-submit">Create account</button>' +
      '<button type="button" class="pcode-auth-float-switch" data-auth-switch="signin">Already have an account? Sign in</button>' +
      '</form></div>' +
      '<div class="pcode-auth-float-divider" data-auth-mode="signin" aria-hidden="true">or continue with Google</div>' +
      '<div class="pcode-google-oauth-panel" data-auth-mode="signin">' +
      '<div id="google-signin-mount" class="pcode-google-signin-mount" aria-label="Sign in with Google"></div>' +
      '<button type="button" id="google-login-btn" class="social-btn social-btn-google pcode-google-btn-fallback hidden w-full" aria-label="Log in with Google">Log in with Google</button>' +
      '<p id="pcode-oauth-disclaimer" class="pcode-oauth-disclaimer" data-portal="community">You can also sign in or register securely with Google.</p>' +
      '</div></div></div></div></div>'
    );
  }

  /**
   * Ensure every guest-facing page has the same floating auth chooser modal.
   * Upgrades older markup and injects the modal when missing (e.g. XAI Insights).
   */
  ensureAuthFloatModal() {
    try {
      if (typeof document === 'undefined') return null;
      this.ensureGoogleAuthStylesheet();
      const existing = document.getElementById('auth-modal');
      const isFloat =
        existing &&
        existing.querySelector('.pcode-auth-float-card') &&
        existing.querySelector('#auth-entry-chooser') &&
        existing.querySelector('#auth-entry-community') &&
        existing.querySelector('#auth-entry-provider') &&
        existing.querySelector('#auth-tabs-section') &&
        existing.querySelector('#google-signin-mount') &&
        existing.querySelector('#login-form') &&
        existing.querySelector('#register-form') &&
        existing.querySelector('[data-pcode-register-minimal="1"]');
      if (!isFloat) {
        if (existing) existing.remove();
        const wrap = document.createElement('div');
        wrap.innerHTML = this.getAuthFloatModalHtml().trim();
        const modal = wrap.firstElementChild;
        if (modal) document.body.appendChild(modal);
      }
      this.bindAuthFloatControls();
      return document.getElementById('auth-modal');
    } catch (_) {
      return document.getElementById('auth-modal');
    }
  }

  setAuthFloatMode(mode) {
    const isRegister = mode === 'register';
    const loginWrap = document.getElementById('login-form-container');
    const registerWrap = document.getElementById('register-form-container');
    const title = document.getElementById('auth-float-mode-title');
    const sub = document.getElementById('auth-float-mode-sub');
    const modal = document.getElementById('auth-modal');

    if (loginWrap) {
      loginWrap.classList.toggle('hidden', isRegister);
      if (isRegister) loginWrap.setAttribute('hidden', '');
      else loginWrap.removeAttribute('hidden');
    }
    if (registerWrap) {
      registerWrap.classList.toggle('hidden', !isRegister);
      if (!isRegister) registerWrap.setAttribute('hidden', '');
      else registerWrap.removeAttribute('hidden');
    }
    if (modal) {
      modal.querySelectorAll('[data-auth-mode="signin"]').forEach((el) => {
        el.classList.toggle('hidden', isRegister);
      });
      modal.querySelectorAll('[data-auth-mode="register"]').forEach((el) => {
        el.classList.toggle('hidden', !isRegister);
      });
    }
    if (title) {
      title.textContent = isRegister
        ? title.getAttribute('data-title-register') || 'Create an account'
        : title.getAttribute('data-title-signin') || 'Sign in';
    }
    if (sub) {
      sub.textContent = isRegister
        ? sub.getAttribute('data-subtitle-register') ||
          'Create an account with email and password, or use Google.'
        : sub.getAttribute('data-subtitle-signin') ||
          'Use Google or your email and password.';
    }
    this.hideError('login-general-error');
    this.hideError('register-general-error');
    const success = document.getElementById('auth-float-success');
    if (success) {
      success.classList.add('hidden');
      success.textContent = '';
    }
    if (isRegister) {
      this.applyPortalTypeToRegisterForm();
    }
  }

  /** Bind portal-chooser controls once (safe after modal inject/upgrade). */
  bindAuthFloatControls() {
    const entryProvider = document.getElementById('auth-entry-provider');
    const entryCommunity = document.getElementById('auth-entry-community');
    const backToEntry = document.getElementById('auth-back-to-entry');
    const googleBtn = document.getElementById('google-login-btn');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const modal = document.getElementById('auth-modal');

    if (entryProvider && entryProvider.dataset.pcodeAuthBound !== '1') {
      entryProvider.dataset.pcodeAuthBound = '1';
      entryProvider.addEventListener('click', () => this.enterAuthFlow('provider'));
    }
    if (entryCommunity && entryCommunity.dataset.pcodeAuthBound !== '1') {
      entryCommunity.dataset.pcodeAuthBound = '1';
      entryCommunity.addEventListener('click', () => this.enterAuthFlow('community'));
    }
    if (backToEntry && backToEntry.dataset.pcodeAuthBound !== '1') {
      backToEntry.dataset.pcodeAuthBound = '1';
      backToEntry.addEventListener('click', (e) => {
        e.preventDefault();
        this.showAuthEntryChooser();
      });
    }
    if (googleBtn && googleBtn.dataset.pcodeAuthBound !== '1') {
      googleBtn.dataset.pcodeAuthBound = '1';
      googleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleGoogleLogin();
      });
    }
    if (loginForm && loginForm.dataset.pcodeAuthBound !== '1') {
      loginForm.dataset.pcodeAuthBound = '1';
      loginForm.addEventListener('submit', (e) => this.handleLogin(e));
    }
    if (registerForm && registerForm.dataset.pcodeAuthBound !== '1') {
      registerForm.dataset.pcodeAuthBound = '1';
      registerForm.addEventListener('submit', (e) => this.handleRegister(e));
    }
    if (modal && modal.dataset.pcodeSwitchBound !== '1') {
      modal.dataset.pcodeSwitchBound = '1';
      modal.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-auth-switch]') : null;
        if (!btn) return;
        e.preventDefault();
        const mode = btn.getAttribute('data-auth-switch') || 'signin';
        this.setAuthFloatMode(mode === 'register' ? 'register' : 'signin');
      });
    }
  }

  /** Parse API JSON even if PHP warnings were prepended as HTML. */
  parseApiJsonResponse(responseText) {
    const text = String(responseText || '').trim();
    if (!text) {
      throw new SyntaxError('Empty response');
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(text.slice(start, end + 1));
      }
      throw new SyntaxError('Invalid JSON response');
    }
  }

  /** Normalized role string â€” matches pcode_normalize_db_role + admin short list */
  isAdminRoleString(role) {
    const r = this.normalizeRoleString(role);
    return r === 'administrator' || r === 'admin' || r === 'system administrator';
  }

  isProviderUser(user) {
    if (user?.isGuest) return false;
    if (this.roleStringIsAppRegularUser(user?.role)) return false;
    const role = this.normalizeRoleString(user?.role);
    if (!role) return false;
    if (this.isAdminRoleString(user?.role)) return false;
    return true;
  }

  /** community vs provider on login-new â€” reads memory + sessionStorage */
  normalizeSelectedPortalType() {
    let p = this.selectedPortalType;
    try {
      p = p || sessionStorage.getItem('PMOS_selected_portal_type');
    } catch (_) {
      /* ignore */
    }
    return String(p || '')
      .trim()
      .toLowerCase();
  }

  /**
   * login-new.html: "Continue as Regular User" or "Continue as Healthcare Provider", user (non-admin) sign-in.
   * Same #login-loading-modal error state for both portals â€” not admin login tab on other pages.
   */
  isLoginNewPortalUserContext() {
    if (typeof window === 'undefined' || !/login-new\.html/i.test(String(window.location.pathname || ''))) {
      return false;
    }
    if ((document.getElementById('login-mode')?.value || 'user') !== 'user') {
      return false;
    }
    const p = this.normalizeSelectedPortalType();
    return p === 'community' || p === 'provider';
  }

  /**
   * login-new.html schedules a 200ms "already logged in" redirect. Cancel it as soon as the
   * user starts any auth action so a failed attempt cannot race and flash the landing page.
   */
  cancelLoginNewAutoredirectIfAny() {
    try {
      if (typeof window !== 'undefined' && typeof window.pcodeCancelLoginNewAutoredirect === 'function') {
        window.pcodeCancelLoginNewAutoredirect();
      }
    } catch (_) {
      /* ignore */
    }
  }

  /** Same rules as api/auth_portal_enforcement.php pcode_normalize_db_role. */
  normalizeRoleString(role) {
    return String(role || '')
      .replace(/[\uFEFF\u200B\u00A0]/g, ' ')
      .replace(/_/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  /** Aligned with pcode_role_is_regular_user in auth_portal_enforcement.php */
  roleStringIsAppRegularUser(role) {
    const r = this.normalizeRoleString(role);
    if (r === 'regular user' || r === 'regularuser') {
      return true;
    }
    return /^regular[\s\-_]*user$/.test(r);
  }

  /**
   * Mirrors pcode_portal_allows_role (community = patient; provider = clinical, not RU/admin).
   */
  portalAllowsRole(expectedAccess, role) {
    const e = String(expectedAccess || '')
      .trim()
      .toLowerCase();
    const r = this.normalizeRoleString(role);
    if (e === 'community') {
      return this.roleStringIsAppRegularUser(role);
    }
    if (e === 'provider') {
      if (!r) {
        return false;
      }
      if (this.roleStringIsAppRegularUser(role)) {
        return false;
      }
      if (this.isAdminRoleString(role)) {
        return false;
      }
      if (r === 'guest') {
        return false;
      }
      return true;
    }
    return false;
  }

  isRegularUserRoleString(role) {
    return this.roleStringIsAppRegularUser(role);
  }

  isHealthcareProviderRoleString(role) {
    return this.portalAllowsRole('provider', role);
  }

  applyProviderOnlyUI(user) {
    const isProvider = this.isProviderUser(user);
    const providerOnlySelectors = [
      'a[href="patients.html"]',
      'a[href="./patients.html"]',
      'button[onclick*="patients.html"]',
      'button[onclick*="`patients.html`"]',
    ];
    const nodes = document.querySelectorAll(providerOnlySelectors.join(','));
    nodes.forEach((el) => {
      // Hide patients link/actions for non-providers
      el.style.display = isProvider ? '' : 'none';
    });
  }

  /**
   * Model Performance nav link is for providers and admins, not the regular user portal.
   * Logged-out visitors still see the link (e.g. marketing / About) unless the page targets logged-in RU only.
   */
  applyModelPerformanceNavVisibility(user) {
    const isGuest = !!user?.isGuest;
    const isRegularUser = user && this.roleStringIsAppRegularUser(user?.role) && !isGuest;
    const hide = isGuest || isRegularUser;
    document
      .querySelectorAll('a[href="model-performance.html"], a[href="./model-performance.html"]')
      .forEach((el) => {
        el.style.display = hide ? 'none' : '';
      });
  }

  /**
   * Guests should not access XAI Insights (no persisted records).
   * Hide XAI nav links for guest sessions.
   */
  applyGuestXaiNavVisibility(user) {
    const isGuest = !!user?.isGuest;
    document
      .querySelectorAll(
        [
          'a[href="xai-user.html"]',
          'a[href="./xai-user.html"]',
          'button[onclick*="xai-user.html"]',
        ].join(','),
      )
      .forEach((el) => {
        el.style.display = isGuest ? 'none' : '';
      });
  }

  /** Current page filename for nav active-state matching. */
  getCurrentPageName() {
    try {
      const parts = String(window.location.pathname || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean);
      return (parts[parts.length - 1] || 'index.html').toLowerCase();
    } catch (_) {
      return 'index.html';
    }
  }

  /**
   * Decide community vs clinical nav for shared pages (About, Model Performance).
   * Ensures portal-specific links are never missing when moving between pages.
   */
  resolvePortalNavMode(user) {
    const page = this.getCurrentPageName();
    const providerPages = new Set([
      'provider-dashboard.html',
      'patients.html',
      'detect-provider.html',
      'xai-provider.html',
      'model-performance.html',
    ]);
    const communityPages = new Set([
      'index.html',
      'detect-user.html',
      'history-user.html',
      'xai-user.html',
    ]);

    if (user && this.isProviderUser(user)) {
      return 'provider';
    }
    if (user && (user.isGuest || this.roleStringIsAppRegularUser(user.role))) {
      return 'community';
    }
    if (providerPages.has(page)) {
      return 'provider';
    }
    if (communityPages.has(page) || page === 'about.html') {
      return 'community';
    }
    return 'community';
  }

  getPortalNavItems(mode, user) {
    const isGuest = !!user?.isGuest;
    if (mode === 'provider') {
      return [
        {
          href: 'provider-dashboard.html',
          label: 'Dashboard',
          match: ['provider-dashboard.html'],
        },
        { href: 'patients.html', label: 'Patients', match: ['patients.html'] },
        {
          href: 'detect-provider.html',
          label: 'Detect',
          match: ['detect-provider.html'],
        },
        {
          href: 'xai-provider.html',
          label: 'XAI Insights',
          match: ['xai-provider.html'],
        },
        {
          href: 'model-performance.html',
          label: 'Model Performance',
          match: ['model-performance.html'],
        },
        { href: 'about.html', label: 'About', match: ['about.html'] },
      ];
    }
    return [
      { href: 'index.html', label: 'Dashboard', match: ['index.html', ''] },
      {
        href: 'detect-user.html',
        label: 'Detect',
        match: ['detect-user.html'],
        requireAuth: true,
      },
      {
        href: 'history-user.html',
        label: 'History',
        match: ['history-user.html'],
        hide: isGuest,
        requireAuth: true,
      },
      {
        href: 'xai-user.html',
        label: 'XAI Insights',
        match: ['xai-user.html'],
        hide: isGuest,
        requireAuth: true,
      },
      { href: 'about.html', label: 'About', match: ['about.html'] },
    ].filter((item) => !item.hide);
  }

  isNavItemActive(item, page) {
    const matches = item.match || [item.href];
    return matches.some((m) => String(m).toLowerCase() === page);
  }

  ensureMobileNavLinksHost() {
    const menu = document.getElementById('mobile-menu');
    if (!menu) {
      return null;
    }
    let host = menu.querySelector('.mobile-nav-links');
    if (host) {
      return host;
    }
    const shell = menu.querySelector('.h-full, .px-4, .px-6') || menu;
    host = document.createElement('div');
    host.className = 'mobile-nav-links pt-2';
    host.innerHTML =
      '<p class="text-xs uppercase tracking-wider text-white/70 mb-2">Menu</p><div class="space-y-1" data-pcode-mobile-nav></div>';
    shell.appendChild(host);
    return host;
  }

  /**
   * Rebuild desktop + mobile topnav links for the active portal so shared pages
   * (About, Model Performance) never drop Patients / Detect / XAI / MP links.
   */
  syncPortalNavigation(user) {
    const topNav = document.querySelector('nav.pcode-topnav, nav.xai-topnav, body > nav, nav.sticky');
    if (!topNav) {
      return;
    }

    const mode = this.resolvePortalNavMode(user);
    const items = this.getPortalNavItems(mode, user);
    const page = this.getCurrentPageName();
    const useModern = topNav.classList.contains('pcode-topnav') || topNav.classList.contains('xai-topnav');
    // Guest / unregistered sessions still need the auth modal for gated tools.
    const loggedIn = !!(
      user &&
      this.isAuthenticated() &&
      !user.isGuest
    );

    const desktop = topNav.querySelector('.nav-desktop');
    if (desktop) {
      desktop.innerHTML = items
        .map((item) => {
          const active = this.isNavItemActive(item, page);
          const gate =
            !loggedIn && item.requireAuth
              ? ' onclick="return auth.requireAuth(this.href)"'
              : '';
          if (useModern) {
            return (
              '<a href="' +
              item.href +
              '" class="pcode-nav-link' +
              (active ? ' is-active' : '') +
              '"' +
              (active ? ' aria-current="page"' : '') +
              gate +
              '>' +
              item.label +
              '</a>'
            );
          }
          if (active) {
            return (
              '<a href="' +
              item.href +
              '" class="text-purple-800 dark:text-purple-300 font-semibold border-b-2 border-purple-800 dark:border-purple-400 pb-1 text-sm" aria-current="page"' +
              gate +
              '>' +
              item.label +
              '</a>'
            );
          }
          return (
            '<a href="' +
            item.href +
            '" class="text-gray-600 dark:text-slate-300 hover:text-purple-800 dark:hover:text-purple-300 transition-colors text-sm"' +
            gate +
            '>' +
            item.label +
            '</a>'
          );
        })
        .join('');
    }

    const mobileHost = this.ensureMobileNavLinksHost();
    if (mobileHost) {
      let list = mobileHost.querySelector('[data-pcode-mobile-nav], .space-y-1');
      if (!list) {
        list = document.createElement('div');
        list.className = 'space-y-1';
        list.setAttribute('data-pcode-mobile-nav', '');
        mobileHost.appendChild(list);
      }
      list.innerHTML = items
        .map((item) => {
          const active = this.isNavItemActive(item, page);
          const gate =
            !loggedIn && item.requireAuth
              ? 'closeMobileMenu(); return auth.requireAuth(this.href)'
              : "typeof closeMobileMenu==='function'&&closeMobileMenu()";
          return (
            '<a href="' +
            item.href +
            '" onclick="' +
            gate +
            '" class="block px-4 py-3 rounded-lg ' +
            (active ? 'bg-white/10 hover:bg-white/15' : 'hover:bg-white/10') +
            ' transition-colors font-medium">' +
            item.label +
            '</a>'
          );
        })
        .join('');
    }

    // Keep bar class consistent so dark theme never drops topnav chrome.
    if (!topNav.classList.contains('pcode-topnav') && !topNav.classList.contains('xai-topnav')) {
      topNav.classList.add('pcode-topnav');
    }
  }

  async loadConfig() {
    try {
      const response = await fetch('config.json?v=' + Date.now());
      const config = await response.json();
      this.apiBaseUrl = config.app.apiBaseUrl || './api/';
      this.apiStyle = /onrender\.com/i.test(this.apiBaseUrl) ? 'flask' : 'php';
    } catch (error) {
      console.warn('Config not loaded, using default API URL');
      this.apiBaseUrl = './api/';
      this.apiStyle = 'php';
    }
  }

  /**
   * Map PHP-style paths to Flask routes when apiBaseUrl points at Render.
   * @param {string} path e.g. "login.php" or "auth/google_callback.php"
   */
  resolveApiUrl(path) {
    const base = String(this.apiBaseUrl || './api/').replace(/\/?$/, '/');
    let p = String(path || '').replace(/^\//, '');
    const flask = this.apiStyle === 'flask' || /onrender\.com/i.test(base);
    if (flask) {
      const map = {
        'login.php': 'login',
        'register.php': 'register',
        'verify.php': 'verify',
        'guest_login.php': 'guest-login',
        'auth/google_callback.php': 'auth/google',
        'auth/firebase_callback.php': 'auth/firebase',
        'sync_session.php': 'sync-session',
        'update_profile.php': 'update-profile',
      };
      p = map[p] || p.replace(/\.php$/i, '');
    }
    return base + p;
  }

  setupEventListeners() {
    // Close modal on overlay click
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('auth-modal-overlay')) {
        this.closeAuthModal();
      }
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeAuthModal();
      }
    });

    // Credential forms are bound in bindAuthFloatControls (modal inject/upgrade safe)

    // Tab switching
    const loginTab = document.getElementById('login-tab-btn');
    const registerTab = document.getElementById('register-tab-btn');

    if (loginTab) {
      loginTab.addEventListener('click', () => this.switchAuthTab('login'));
    }

    if (registerTab) {
      registerTab.addEventListener('click', () => this.switchAuthTab('register'));
    }

    this.bindAuthFloatControls();

    const authButton = document.getElementById('auth-button');
    if (authButton) {
      authButton.addEventListener('click', (e) => {
        e.preventDefault();
        this.openAuthModal();
      });
    }
    const mobileAuthButton = document.getElementById('mobile-auth-button');
    if (mobileAuthButton) {
      mobileAuthButton.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof closeMobileMenu === 'function') {
          closeMobileMenu();
        }
        this.openAuthModal();
      });
    }

  }

  resetLoginLoadingModal() {
    const loadContent = document.getElementById('login-loading-content');
    const errAlert = document.getElementById('login-modal-error-alert');
    const errText = document.getElementById('login-modal-error-text');
    const ttl = document.getElementById('login-loading-title');
    const sub = document.getElementById('login-loading-message');
    if (loadContent) {
      loadContent.classList.remove('hidden');
      loadContent.removeAttribute('aria-hidden');
    }
    if (errText) {
      errText.textContent = '';
    }
    if (errAlert) {
      errAlert.classList.add('hidden');
      errAlert.setAttribute('aria-hidden', 'true');
    }
    if (ttl) ttl.textContent = 'Logging inâ€¦';
    if (sub) {
      sub.textContent = '';
      sub.classList.add('hidden');
      sub.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * @param {string} message - Subtitle (detail line under the title)
   * @param {string} [title] - Main line (e.g. "Logging inâ€¦" on login-new after portal + fields are valid)
   */
  clearLoginModalErrorDismissTimer() {
    if (this._loginModalErrorDismissTimer != null) {
      try {
        clearTimeout(this._loginModalErrorDismissTimer);
      } catch (_) {}
      this._loginModalErrorDismissTimer = null;
    }
  }

  /**
   * @param {string} [message] - Optional subtitle; omit or pass '' for spinner + title only.
   * @param {string} [title] - Main line (default "Logging inâ€¦").
   */
  showLoginLoadingModal(message, title) {
    this.clearLoginModalErrorDismissTimer();
    this._loginNewPendingCredentialMessage = null;
    this.resetLoginLoadingModal();
    this.hideError('login-general-error');
    const modal = document.getElementById('login-loading-modal');
    const msg = document.getElementById('login-loading-message');
    const ttl = document.getElementById('login-loading-title');
    if (!modal) return;
    const hasSub = message != null && String(message).trim() !== '';
    if (msg) {
      if (hasSub) {
        msg.textContent = String(message).trim();
        msg.classList.remove('hidden');
        msg.removeAttribute('aria-hidden');
      } else {
        msg.textContent = '';
        msg.classList.add('hidden');
        msg.setAttribute('aria-hidden', 'true');
      }
    }
    if (ttl) ttl.textContent = title != null && String(title).trim() !== '' ? String(title).trim() : 'Logging inâ€¦';
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }

  /**
   * login-new: close overlay, sign out, show Regular User / Healthcare Provider chooser with a hint.
   * Used when the wrong "Continue as" was used (role does not match access type).
   */
  returnLoginNewToAccessChooser(message) {
    this.setLoading('login-btn', false);
    this.hideLoginLoadingModal();
    this.invalidateSessionOnAuthFailure();
    const gBtn = document.getElementById('google-login-btn');
    if (gBtn) {
      gBtn.disabled = false;
      gBtn.style.opacity = '1';
    }
    const isLoginNew =
      typeof window !== 'undefined' &&
      /login-new\.html/i.test(String(window.location.pathname || ''));
    if (isLoginNew && typeof window.pcodeLoginNewReturnToAccessChooser === 'function') {
      window.pcodeLoginNewReturnToAccessChooser(message);
    } else {
      this.showErrorInline('login-general-error', message);
    }
  }

  /**
   * login-new: wrong password or portal/role not allowed â€” hide spinner, show only the error
   * in the same overlay (or inline if modal missing); auto-closes in 1s and copies to the form.
   * @param {string} [message] - shown in the center modal (default wrong password copy).
   */
  showLoginNewCredentialsRejectedInline(message = 'Wrong credentials') {
    this.cancelLoginNewAutoredirectIfAny();
    this.setLoading('login-btn', false);
    this.invalidateSessionOnAuthFailure();
    const gBtn = document.getElementById('google-login-btn');
    if (gBtn) {
      gBtn.disabled = false;
      gBtn.style.opacity = '1';
    }
    this.showLoginLoadingModalError(message);
  }

  /**
   * login-new.html: replace spinner block with the error alert (never show both at once).
   * Falls back to inline error if the modal is missing.
   */
  showLoginLoadingModalError(message) {
    this.clearLoginModalErrorDismissTimer();
    const text = String(message || 'Wrong credentials').trim() || 'Wrong credentials';
    this._loginNewPendingCredentialMessage = text;
    this.setLoading('login-btn', false);
    const modal = document.getElementById('login-loading-modal');
    const errAlert = document.getElementById('login-modal-error-alert');
    const errText = document.getElementById('login-modal-error-text');
    const loadContent = document.getElementById('login-loading-content');
    if (!modal || !errAlert || !errText) {
      this.hideLoginLoadingModal();
      this.showErrorInline('login-general-error', text);
      return;
    }
    if (loadContent) {
      loadContent.classList.add('hidden');
      loadContent.setAttribute('aria-hidden', 'true');
    }
    if (errText) errText.textContent = text;
    errAlert.classList.remove('hidden');
    errAlert.setAttribute('aria-hidden', 'false');
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    this._loginModalErrorDismissTimer = setTimeout(() => {
      this._loginModalErrorDismissTimer = null;
      this.dismissLoginModalError();
    }, 1000);
  }

  dismissLoginModalError() {
    this.clearLoginModalErrorDismissTimer();
    const errText = document.getElementById('login-modal-error-text');
    const fromDom = errText && errText.textContent != null ? errText.textContent.trim() : '';
    const message =
      fromDom || this._loginNewPendingCredentialMessage || 'Wrong credentials';
    this._loginNewPendingCredentialMessage = null;
    this.showErrorInline('login-general-error', message);
    // Paint inline error first, then remove the overlay in the next frame to avoid a flash of the full landing layout
    const self = this;
    requestAnimationFrame(() => {
      self.hideLoginLoadingModal();
    });
  }

  hideLoginLoadingModal() {
    this.clearLoginModalErrorDismissTimer();
    this._loginNewPendingCredentialMessage = null;
    const modal = document.getElementById('login-loading-modal');
    if (!modal) return;
    // Hide first so the user never sees a flash of the loading state after an error
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    this.resetLoginLoadingModal();
  }

  ensureMobileEditProfileButton() {
    const mobileProfile = document.getElementById('mobile-profile');
    const logoutBtn = document.getElementById('mobile-logout-btn');
    if (!mobileProfile || !logoutBtn) return;

    // Avoid duplicates
    if (document.getElementById('mobile-edit-profile-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'mobile-edit-profile-btn';
    btn.className = 'w-full px-4 py-3 mb-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors font-medium text-sm active:bg-purple-800 flex items-center justify-center gap-2';
    btn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4h2M12 20h.01M4 20h16M6 16l9.5-9.5a2.121 2.121 0 113 3L9 19l-4 1 1-4z"></path>
      </svg>
      <span>Edit Profile</span>
    `;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Drawer locks pointer-events on body children — close it before the modal opens
      if (typeof closeMobileMenu === 'function') closeMobileMenu();
      this.openEditProfileModal();
    });

    // Insert above logout
    mobileProfile.insertBefore(btn, logoutBtn);
  }

  ensureEditProfileStyles() {
    const hrefBase = /\/(obgyn|user)\//i.test(window.location.pathname || '') ? '../' : '';
    const href = hrefBase + 'css/pcode-edit-profile-modal.css?v=20260723-eppad';
    let link = document.getElementById('pcode-edit-profile-modal-css');
    if (link) {
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
      return;
    }
    link = document.createElement('link');
    link.id = 'pcode-edit-profile-modal-css';
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  ensureEditProfileModal() {
    this.ensureEditProfileStyles();
    const EP_MODAL_VERSION = '20260723-eppad';
    const existing = document.getElementById('edit-profile-modal');
    if (existing && existing.getAttribute('data-ep-version') === EP_MODAL_VERSION) {
      return;
    }
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'edit-profile-modal';
    modal.className = 'edit-profile-modal';
    modal.setAttribute('data-ep-version', EP_MODAL_VERSION);
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'edit-profile-modal-title');
    modal.innerHTML = `
      <div class="edit-profile-modal__backdrop" data-ep-close="1" aria-hidden="true"></div>
      <div class="edit-profile-modal__dialog">
        <header class="edit-profile-modal__header">
          <div class="edit-profile-modal__header-copy">
            <h2 id="edit-profile-modal-title" class="edit-profile-modal__title">Edit Profile</h2>
          </div>
          <button type="button" class="edit-profile-modal__close" aria-label="Close" data-ep-close="1">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </header>

        <div class="edit-profile-modal__body">
          <h3 class="edit-profile-modal__section-title">Account information</h3>
          <p class="edit-profile-modal__section-sub">Update your profile details and password</p>
          <div class="edit-profile-modal__form">
            <div class="edit-profile-modal__field">
              <label class="edit-profile-modal__label" for="ep-name">Full name</label>
              <input id="ep-name" type="text" class="edit-profile-modal__input" placeholder="Enter your full name" autocomplete="name">
              <p id="ep-name-error" class="edit-profile-modal__error" role="alert"></p>
            </div>

            <div class="edit-profile-modal__field-row">
              <div class="edit-profile-modal__field">
                <label class="edit-profile-modal__label" for="ep-email">Email</label>
                <input id="ep-email" type="email" class="edit-profile-modal__input" disabled autocomplete="email">
              </div>
              <div class="edit-profile-modal__field">
                <label class="edit-profile-modal__label" for="ep-role">Role</label>
                <input id="ep-role" type="text" class="edit-profile-modal__input" disabled>
              </div>
            </div>

            <div class="edit-profile-modal__field">
              <label class="edit-profile-modal__label" for="ep-institution">Institution</label>
              <input id="ep-institution" type="text" class="edit-profile-modal__input" placeholder="Hospital / Clinic (optional)" autocomplete="organization">
            </div>

            <section class="edit-profile-modal__password-panel" aria-labelledby="ep-password-section-title">
              <h3 id="ep-password-section-title" class="edit-profile-modal__password-title">Change password (optional)</h3>
              <p class="edit-profile-modal__hint" style="margin-bottom:0.65rem;">
                For security, you can email yourself a Firebase password-reset link, or set a new password below after recent sign-in.
              </p>
              <button type="button" id="ep-send-password-reset-btn" class="edit-profile-modal__btn edit-profile-modal__btn--cancel" style="width:100%;margin-bottom:0.75rem;">
                Email me a password reset link
              </button>
              <p id="ep-password-reset-status" class="edit-profile-modal__hint" role="status"></p>
              <div class="edit-profile-modal__password-fields">
                <div class="edit-profile-modal__field">
                  <label class="edit-profile-modal__label" for="ep-password">New password</label>
                  <input id="ep-password" type="password" class="edit-profile-modal__input" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" autocomplete="new-password">
                </div>
                <div class="edit-profile-modal__field">
                  <label class="edit-profile-modal__label" for="ep-password-confirm">Confirm new password</label>
                  <input id="ep-password-confirm" type="password" class="edit-profile-modal__input" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" autocomplete="new-password">
                  <p class="edit-profile-modal__hint">Must contain uppercase, lowercase, number, and special character.</p>
                  <p id="ep-password-error" class="edit-profile-modal__error" role="alert"></p>
                </div>
              </div>
            </section>

            <p id="ep-general-error" class="edit-profile-modal__error" role="alert"></p>
          </div>
        </div>

        <footer class="edit-profile-modal__footer">
          <button type="button" class="edit-profile-modal__btn edit-profile-modal__btn--cancel" data-ep-close="1">Cancel</button>
          <button type="button" id="ep-save-btn" class="edit-profile-modal__btn edit-profile-modal__btn--save">Save changes</button>
        </footer>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      const closeEl = e.target.closest('[data-ep-close="1"]');
      if (closeEl) this.closeEditProfileModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeEditProfileModal();
    });

    const saveBtn = modal.querySelector('#ep-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.saveProfileChanges());
    }
    const resetLinkBtn = modal.querySelector('#ep-send-password-reset-btn');
    if (resetLinkBtn) {
      resetLinkBtn.addEventListener('click', () => this.sendFirebasePasswordResetFromProfile());
    }
  }

  async sendFirebasePasswordResetFromProfile() {
    const status = document.getElementById('ep-password-reset-status');
    const email = (this.currentUser && this.currentUser.email) || '';
    if (!email) {
      if (status) status.textContent = 'No email on this account.';
      return;
    }
    if (status) status.textContent = 'Sending reset email…';
    try {
      // Load Firebase module on demand if not present (Home / dashboard pages)
      if (!window.PcodeFirebase) {
        await import('./firebase-config.js');
      }
      let tries = 0;
      while (!window.PcodeFirebase && tries < 40) {
        await new Promise((r) => setTimeout(r, 50));
        tries += 1;
      }
      if (!window.PcodeFirebase || typeof window.PcodeFirebase.sendPasswordReset !== 'function') {
        throw new Error('Firebase Auth is not available on this page.');
      }
      const continueUrl =
        window.location.origin + (window.location.pathname || '/pcode/index.html');
      await window.PcodeFirebase.sendPasswordReset(email, continueUrl);
      if (status) {
        status.textContent = 'Password reset link sent to ' + email + '. Check your inbox.';
      }
      this.showNotification('Password reset email sent.', 'success');
    } catch (err) {
      const msg = (err && err.message) || 'Could not send password reset email.';
      if (status) status.textContent = msg;
      this.showNotification(msg, 'error');
    }
  }

  openEditProfileModal() {
    if (!this.currentUser) {
      this.showNotification('Please log in to edit your profile.', 'info');
      return;
    }
    if (this.currentUser.isGuest) {
      this.showNotification('Guest users cannot edit profiles. Please create an account.', 'info');
      return;
    }

    this.ensureEditProfileModal();
    const modal = document.getElementById('edit-profile-modal');
    if (!modal) return;

    // Safety: if opened while the drawer is still marked open, unlock interactions
    if (typeof closeMobileMenu === 'function') closeMobileMenu();

    const nameEl = document.getElementById('ep-name');
    const emailEl = document.getElementById('ep-email');
    const roleEl = document.getElementById('ep-role');
    const instEl = document.getElementById('ep-institution');
    const pwdEl = document.getElementById('ep-password');
    const pwd2El = document.getElementById('ep-password-confirm');

    if (nameEl) nameEl.value = this.currentUser.name || '';
    if (emailEl) emailEl.value = this.currentUser.email || '';
    if (roleEl) roleEl.value = this.currentUser.role || '';
    if (instEl) instEl.value = this.currentUser.institution || '';
    if (pwdEl) pwdEl.value = '';
    if (pwd2El) pwd2El.value = '';

    this.hideError('ep-general-error');
    this.hideError('ep-name-error');
    this.hideError('ep-password-error');

    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  closeEditProfileModal() {
    const modal = document.getElementById('edit-profile-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  async saveProfileChanges() {
    const nameEl = document.getElementById('ep-name');
    const instEl = document.getElementById('ep-institution');
    const pwdEl = document.getElementById('ep-password');
    const pwd2El = document.getElementById('ep-password-confirm');

    const name = nameEl ? nameEl.value.trim() : '';
    const institution = instEl ? instEl.value.trim() : '';
    const password = pwdEl ? pwdEl.value : '';
    const password2 = pwd2El ? pwd2El.value : '';

    this.hideError('ep-general-error');
    this.hideError('ep-name-error');
    this.hideError('ep-password-error');

    if (name.length < 2) {
      this.showErrorInline('ep-name-error', 'Name must be at least 2 characters.');
      return;
    }

    if (password || password2) {
      if (password !== password2) {
        this.showErrorInline('ep-password-error', 'Passwords do not match.');
        return;
      }
      if (!this.validatePassword(password)) {
        this.showErrorInline('ep-password-error', 'Password must contain uppercase, lowercase, number, and special character.');
        return;
      }
    }

    const saveBtn = document.getElementById('ep-save-btn');
    const originalBtnHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = 'Saving...';
    }

    try {
      const payload = { name, institution };
      if (password) payload.password = await this.hashPasswordForApi(password);

      const res = await fetch(this.apiBaseUrl + 'update_profile.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.success !== true) {
        const msg = data?.message || data?.error || 'Failed to update profile. Please try again.';
        this.showErrorInline('ep-general-error', msg);
        return;
      }

      // Mirror password to Firebase when the user is signed into Firebase Auth
      if (password && window.PcodeFirebase && typeof window.PcodeFirebase.setFirebasePassword === 'function') {
        try {
          await window.PcodeFirebase.setFirebasePassword(password);
        } catch (fbErr) {
          console.warn('Firebase password sync skipped:', fbErr);
        }
      }

      const updatedUser = data.user || null;
      if (updatedUser) {
        this.currentUser = { ...this.currentUser, ...updatedUser };
        sessionStorage.setItem('PMOS_user', JSON.stringify(this.currentUser));
        this.updateUIForLoggedInUser();
      }

      this.closeEditProfileModal();
      this.showNotification('Profile updated successfully.', 'success');
    } catch (e) {
      console.error('Profile update error:', e);
      this.showErrorInline('ep-general-error', 'Network error. Please try again.');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalBtnHtml || 'Save changes';
      }
    }
  }

  /**
   * Normalize token expiry to epoch milliseconds (TTL seconds, epoch seconds, or epoch ms).
   */
  normalizeTokenExpiryMs(rawExpiry) {
    let expiry = parseInt(String(rawExpiry ?? '0'), 10);
    if (!Number.isFinite(expiry) || expiry <= 0) {
      return 0;
    }
    if (expiry < 1e12) {
      if (expiry < 60 * 60 * 24 * 365 * 5) {
        expiry = Date.now() + expiry * 1000;
      } else {
        expiry = expiry * 1000;
      }
    }
    return expiry;
  }

  /**
   * Resolve API expiresIn (TTL seconds) or legacy absolute timestamps to epoch ms.
   */
  resolveTokenExpiryMs(expiresIn) {
    let n = Number(expiresIn);
    if (!Number.isFinite(n) || n <= 0) {
      n = AUTH_SESSION_TTL_SEC;
    }
    if (n >= 1e12) {
      return n;
    }
    if (n >= 1e9) {
      return n * 1000;
    }
    return Date.now() + n * 1000;
  }

  /** JWT `exp` claim as epoch ms, or null if missing/unreadable. */
  getTokenExpiryFromJwt(token) {
    if (!token || typeof token !== 'string') {
      return null;
    }
    try {
      const part = token.split('.')[1];
      if (!part) {
        return null;
      }
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(atob(b64));
      const exp = Number(decoded.exp);
      return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
    } catch (_) {
      return null;
    }
  }

  /** Effective session end â€” earliest of stored expiry and JWT exp. */
  resolveSessionExpiryMs(token, storedExpiry) {
    let expiresAt = storedExpiry
      ? this.normalizeTokenExpiryMs(storedExpiry)
      : 0;
    const jwtExp = this.getTokenExpiryFromJwt(token);
    if (jwtExp) {
      expiresAt = expiresAt > 0 ? Math.min(expiresAt, jwtExp) : jwtExp;
    }
    return expiresAt;
  }

  isSessionStillValid(token, storedExpiry) {
    if (!token) {
      return false;
    }
    const expiresAt = this.resolveSessionExpiryMs(token, storedExpiry);
    return expiresAt > Date.now();
  }

  clearStoredAuth(store) {
    if (!store) {
      return;
    }
    try {
      store.removeItem('PMOS_auth_token');
      store.removeItem('PMOS_user');
      store.removeItem('PMOS_token_expiry');
      if (store === localStorage) {
        store.removeItem('PMOS_remember_session');
      }
    } catch (_) {}
  }

  getDefaultDashboardForUser(user) {
    if (!user) {
      return 'login-new.html';
    }
    if (user.isGuest) {
      return 'index.html';
    }
    if (this.isAdminRoleString(user.role)) {
      return 'admin-dashboard.html';
    }
    if (this.roleStringIsAppRegularUser(user.role)) {
      return 'index.html';
    }
    return 'provider-dashboard.html';
  }

  /**
   * Gate a page by portal without wiping a valid session (fixes post-login auto-logout).
   * @param {'community'|'provider'|'admin'|'any'} expectedPage
   * @returns {boolean} false if a redirect was triggered
   */
  enforcePageAccess(expectedPage) {
    if (!this.isAuthenticated()) {
      const path = String(window.location.pathname || '');
      const loginUrl = /admin-dashboard|admin-login/i.test(path) ? 'admin-login.html' : 'login-new.html';
      window.location.replace(loginUrl);
      return false;
    }

    const user = this.currentUser;
    if (!user) {
      window.location.replace('login-new.html');
      return false;
    }

    const home = this.getDefaultDashboardForUser(user);
    const path = String(window.location.pathname || '').split('/').pop() || '';

    if (user.isGuest) {
      if (expectedPage === 'provider' || expectedPage === 'admin') {
        window.location.replace('index.html');
        return false;
      }
      return true;
    }

    if (this.isAdminRoleString(user.role)) {
      try {
        sessionStorage.removeItem('PMOS_login_portal');
      } catch (_) {}
      if (expectedPage !== 'admin' && expectedPage !== 'any') {
        window.location.replace('admin-dashboard.html');
        return false;
      }
      return true;
    }

    const isRegular = this.roleStringIsAppRegularUser(user.role);
    try {
      sessionStorage.setItem('PMOS_login_portal', isRegular ? 'community' : 'provider');
    } catch (_) {}

    if (expectedPage === 'community' && !isRegular) {
      if (!/provider-dashboard\.html$/i.test(path)) {
        window.location.replace('provider-dashboard.html');
        return false;
      }
      return true;
    }

    if (expectedPage === 'provider' && isRegular) {
      if (!/index\.html$/i.test(path)) {
        window.location.replace('index.html');
        return false;
      }
      return true;
    }

    if (expectedPage === 'admin') {
      window.location.replace(home);
      return false;
    }

    return true;
  }

  whenAuthReady(callback) {
    if (typeof callback !== 'function') {
      return;
    }
    // Fire at most once per subscription (auth-ready + timeout used to double-call).
    let done = false;
    const run = () => {
      if (done) return;
      if (!this.isAuthenticated() && !this._sessionChecked) return;
      done = true;
      try {
        callback(this.currentUser);
      } catch (err) {
        console.warn('[Auth] whenAuthReady callback failed:', err);
      }
    };
    if (this.isAuthenticated() || this._sessionChecked) {
      run();
      return;
    }
    window.addEventListener('pcode-auth-ready', run, { once: true });
    window.addEventListener('pcode-auth-settled', run, { once: true });
    setTimeout(run, 500);
  }

  checkSession() {
    const tryRestoreFrom = (store, label) => {
      const savedToken = store.getItem('PMOS_auth_token');
      const savedUser = store.getItem('PMOS_user');
      const savedExpiry = store.getItem('PMOS_token_expiry');
      if (!savedToken || !savedUser) {
        return false;
      }

      // Only restore cross-visit sessions when the user opted into Remember me.
      if (store === localStorage && store.getItem('PMOS_remember_session') !== '1') {
        this.clearStoredAuth(store);
        return false;
      }

      if (!this.isSessionStillValid(savedToken, savedExpiry)) {
        this.clearStoredAuth(store);
        return false;
      }

      const effectiveExpiry = this.resolveSessionExpiryMs(savedToken, savedExpiry);
      try {
        if (effectiveExpiry > 0) {
          store.setItem('PMOS_token_expiry', String(effectiveExpiry));
        }
      } catch (_) {}

      this.token = savedToken;
      let parsedUser = null;
      try {
        parsedUser = JSON.parse(savedUser);
      } catch (e) {
        console.warn('Invalid stored user session:', e);
        this.clearStoredAuth(store);
        return false;
      }
      if (parsedUser) {
        const avatar = String(parsedUser.avatar || parsedUser.picture || '').trim();
        if (avatar) {
          parsedUser.avatar = avatar;
          parsedUser.picture = avatar;
        }
      }
      this.currentUser = parsedUser;
      this.tokenExpiry = effectiveExpiry;
      console.log(`Session restored from ${label}:`, this.currentUser);

      this._sessionChecked = true;
      const emitAuthReady = () => {
        try {
          window.dispatchEvent(
            new CustomEvent('pcode-auth-ready', { detail: { user: this.currentUser } })
          );
          window.dispatchEvent(
            new CustomEvent('pcode-auth-settled', { detail: { user: this.currentUser } })
          );
        } catch (_) {}
      };
      if (document.readyState === 'loading') {
        document.addEventListener(
          'DOMContentLoaded',
          () => setTimeout(emitAuthReady, 0),
          { once: true }
        );
      } else {
        setTimeout(emitAuthReady, 0);
      }

      // Ensure sessionStorage is hydrated even when "Remember me" used localStorage
      try {
        sessionStorage.setItem('PMOS_auth_token', savedToken);
        sessionStorage.setItem('PMOS_user', savedUser);
        sessionStorage.setItem('PMOS_token_expiry', String(effectiveExpiry));
      } catch (_) {}

      // Delay UI update to ensure DOM is ready
      setTimeout(() => this.updateUIForLoggedInUser(), 100);
      this.startSessionWatchdog();
      setTimeout(() => {
        if (typeof this.syncServerSession === 'function') {
          this.syncServerSession();
        }
      }, 0);
      return true;
    };

    // Prefer current-tab storage, fall back to persisted "Remember me"
    if (tryRestoreFrom(sessionStorage, 'sessionStorage')) return;
    if (tryRestoreFrom(localStorage, 'localStorage')) return;
    
    // If no valid session, clear any remaining auth data and show auth button
    this.clearAuthData();
    this._sessionChecked = true;
    const showLoggedOut = () => {
      this.updateUIForLoggedOutUser();
      try {
        window.dispatchEvent(
          new CustomEvent('pcode-auth-settled', { detail: { user: null } })
        );
      } catch (_) {}
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showLoggedOut, { once: true });
    } else {
      showLoggedOut();
    }
    
    // Load and display saved email if on login page
    this.loadSavedEmail();
  }

  stopSessionWatchdog() {
    if (this._sessionWatchdogId != null) {
      try {
        clearInterval(this._sessionWatchdogId);
      } catch (_) {}
      this._sessionWatchdogId = null;
    }
  }

  /**
   * Session watchdog disabled â€” users are not auto-logged out on a timer.
   */
  startSessionWatchdog() {
    this.stopSessionWatchdog();
  }

  handleSessionExpired() {
    if (this._handlingSessionExpired) return;
    const tok = sessionStorage.getItem('PMOS_auth_token') || this.token;
    if (!tok) return;
    const exp = parseInt(sessionStorage.getItem('PMOS_token_expiry') || '0', 10);
    if (exp > Date.now()) return;

    this._handlingSessionExpired = true;
    this.stopSessionWatchdog();

    try {
      const path = typeof window !== 'undefined' ? String(window.location.pathname || '') : '';
      const isAdmin = this.isAdminRoleString(this.currentUser?.role);

      this.clearAuthData();
      this.updateUIForLoggedOutUser();

      const isLoginPage = /login-new\.html|admin-login\.html/i.test(path);
      if (!isLoginPage) {
        window.location.replace(isAdmin ? 'admin-login.html' : 'login-new.html');
      } else if (typeof this.showNotification === 'function') {
        this.showNotification('Your session has expired. Please sign in again.', 'info');
      }
    } finally {
      setTimeout(() => {
        this._handlingSessionExpired = false;
      }, 2000);
    }
  }

  setupSessionVisibilitySync() {
    /* No auto-logout when the tab becomes visible again. */
  }

  clearAuthData(options) {
    const explicitLogout = !!(options && options.explicitLogout);
    this.stopSessionWatchdog();
    // Clear all auth-related storage
    localStorage.removeItem('PMOS_auth_token');
    localStorage.removeItem('PMOS_user');
    localStorage.removeItem('PMOS_token_expiry');
    localStorage.removeItem('PMOS_remember_session');
    sessionStorage.removeItem('PMOS_auth_token');
    sessionStorage.removeItem('PMOS_user');
    sessionStorage.removeItem('PMOS_token_expiry');
    try {
      sessionStorage.removeItem('PMOS_login_portal');
    } catch (_) {}
    
    // **CRITICAL**: Clear guest patient data on logout for privacy/security
    sessionStorage.removeItem('guest_detected_patients');
    sessionStorage.removeItem('guest_added_patients');
    if (explicitLogout) {
      console.log('âœ… Cleared guest patient data from sessionStorage on logout');
    }
    
    this.token = null;
    this.currentUser = null;
    this.tokenExpiry = null;
    if (this._tokenRefreshTimeoutId != null) {
      try {
        clearTimeout(this._tokenRefreshTimeoutId);
      } catch (_) {}
      this._tokenRefreshTimeoutId = null;
    }
    // Do not keep legacy plaintext passwords in storage (see setSession â€” remember me is email only)
    try {
      localStorage.removeItem('PMOS_remembered_password');
    } catch (_) {}
  }

  /**
   * After a failed sign-in or a role/portal rejection, clear any prior session and refresh UI.
   * Avoids a previous user staying "logged in" in memory/storage while a new attempt fails.
   */
  invalidateSessionOnAuthFailure() {
    this.clearAuthData();
    this.updateUIForLoggedOutUser();
  }

  loadSavedCredentials() {
    const loginEmailField = document.getElementById('login-email');
    const rememberCheckbox = document.getElementById('remember-me');
    
    const savedEmail = localStorage.getItem('PMOS_remembered_email');
    
    if (savedEmail && loginEmailField) {
      loginEmailField.value = savedEmail;
    }
    
    if (savedEmail && rememberCheckbox) {
      rememberCheckbox.checked = true;
    }
  }

  loadSavedEmail() {
    const loginEmailField = document.getElementById('login-email');
    if (loginEmailField) {
      const savedEmail = localStorage.getItem('PMOS_remembered_email');
      if (savedEmail) {
        loginEmailField.value = savedEmail;
        const rememberCheckbox = document.getElementById('remember-me');
        if (rememberCheckbox) {
          rememberCheckbox.checked = true;
        }
      }
    }
  }

  openAuthModal(defaultTab = 'login', options = {}) {
    const modal = this.ensureAuthFloatModal() || document.getElementById('auth-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      const forceChooser = !!(options && options.forceChooser);
      const bodyPortal = document.body.getAttribute('data-pcode-auth-portal');
      if (
        !forceChooser &&
        (bodyPortal === 'provider' || bodyPortal === 'community')
      ) {
        this.selectedPortalType = bodyPortal;
        try {
          sessionStorage.setItem('PMOS_selected_portal_type', bodyPortal);
        } catch (_) {}
        this.enterAuthFlow(bodyPortal);
      } else {
        this.selectedPortalType = null;
        this.showAuthEntryChooser();
      }
      if (typeof window.PcodeGoogleAuth !== 'undefined' && this.selectedPortalType) {
        window.PcodeGoogleAuth.reinitForPortal(this.selectedPortalType, { mountId: 'google-signin-mount' });
      }
      
      // Animate modal
      if (typeof anime !== 'undefined') {
        anime({
          targets: modal.querySelector('.auth-modal-content'),
          scale: [0.94, 1],
          opacity: [0, 1],
          duration: 280,
          easing: 'easeOutQuad'
        });
      }
    } else {
      window.location.href = 'login-new.html';
    }
  }

  /**
   * Gate a navigation/CTA behind sign-in. Returns true to allow default link navigation.
   * When logged out, opens the auth modal (or falls back to login-new.html).
   */
  requireAuth(href) {
    if (this.isAuthenticated() && this.currentUser && !this.currentUser.isGuest) {
      return true;
    }
    let target = '';
    try {
      if (href) {
        const url = new URL(href, window.location.href);
        target = (url.pathname.split('/').pop() || '') + (url.hash || '');
      }
    } catch (_) {
      target = String(href || '').split('/').pop() || '';
    }
    if (target && target !== 'index.html' && target !== 'login-new.html') {
      try {
        sessionStorage.setItem('PMOS_post_login_redirect', target);
      } catch (_) {}
    }
    this.ensureAuthFloatModal();
    if (document.getElementById('auth-modal')) {
      // Always show the portal chooser when gating guest access.
      this.openAuthModal('login', { forceChooser: true });
      return false;
    }
    const q = target ? `?next=${encodeURIComponent(target)}` : '';
    window.location.href = 'login-new.html' + q;
    return false;
  }

  closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) {
      const finish = () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        this.showAuthEntryChooser();
      };
      if (typeof anime !== 'undefined') {
        anime({
          targets: modal.querySelector('.auth-modal-content'),
          scale: [1, 0.94],
          opacity: [1, 0],
          duration: 180,
          easing: 'easeInQuad',
          complete: finish
        });
      } else {
        finish();
      }
    }
  }

  showAuthEntryChooser() {
    const chooser = document.getElementById('auth-entry-chooser');
    const tabsSection = document.getElementById('auth-tabs-section');
    const loginForm = document.getElementById('login-form-container');
    const registerForm = document.getElementById('register-form-container');
    const loginTabBtn = document.getElementById('login-tab-btn');
    const registerTabBtn = document.getElementById('register-tab-btn');

    if (chooser) chooser.classList.remove('hidden');
    if (tabsSection) tabsSection.classList.add('hidden');
    if (loginForm) loginForm.classList.remove('hidden');
    if (registerForm) registerForm.classList.add('hidden');
    if (loginTabBtn) loginTabBtn.classList.add('active');
    if (registerTabBtn) registerTabBtn.classList.remove('active');
  }

  enterAuthFlow(portalType) {
    this.selectedPortalType = portalType;
    try {
      const p = portalType === 'community' ? 'community' : 'provider';
      sessionStorage.setItem('PMOS_selected_portal_type', p);
    } catch (_) {
      /* ignore */
    }
    const chooser = document.getElementById('auth-entry-chooser');
    const tabsSection = document.getElementById('auth-tabs-section');
    if (chooser) chooser.classList.add('hidden');
    if (tabsSection) tabsSection.classList.remove('hidden');
    this.switchAuthTab('login');
    this.setAuthFloatMode('signin');
    if (typeof window.PcodeGoogleAuth !== 'undefined') {
      window.PcodeGoogleAuth.reinitForPortal(portalType === 'community' ? 'community' : 'provider', {
        mountId: 'google-signin-mount',
      });
    }
  }

  switchAuthTab(tab) {
    const chooser = document.getElementById('auth-entry-chooser');
    const tabsSection = document.getElementById('auth-tabs-section');
    const loginForm = document.getElementById('login-form-container');
    const registerForm = document.getElementById('register-form-container');
    const loginTabBtn = document.getElementById('login-tab-btn');
    const registerTabBtn = document.getElementById('register-tab-btn');

    if (chooser) chooser.classList.add('hidden');
    if (tabsSection) tabsSection.classList.remove('hidden');

    if (tab === 'login') {
      if (loginForm) loginForm.classList.remove('hidden');
      if (registerForm) registerForm.classList.add('hidden');
      if (loginTabBtn) loginTabBtn.classList.add('active');
      if (registerTabBtn) registerTabBtn.classList.remove('active');
    } else if (registerForm) {
      if (loginForm) loginForm.classList.add('hidden');
      registerForm.classList.remove('hidden');
      if (loginTabBtn) loginTabBtn.classList.remove('active');
      if (registerTabBtn) registerTabBtn.classList.add('active');
      this.applyPortalTypeToRegisterForm();
    }
  }

  applyPortalTypeToRegisterForm() {
    const registerForm = document.getElementById('register-form-container');
    const registerRole = document.getElementById('register-role');
    const institutionField = document.getElementById('register-institution-field');
    const institutionInput = document.getElementById('register-institution');

    if (!registerForm) return;

    if (this.selectedPortalType === 'provider') {
      if (registerRole) registerRole.value = 'Other';
      if (institutionField) institutionField.classList.add('hidden');
      if (institutionInput) institutionInput.value = '';
    } else if (this.selectedPortalType === 'community') {
      if (registerRole) registerRole.value = 'Regular User';
      if (institutionField) institutionField.classList.add('hidden');
      if (institutionInput) institutionInput.value = '';
    } else {
      if (institutionField) institutionField.classList.remove('hidden');
    }
  }

  getRegistrationPortal() {
    try {
      return this.selectedPortalType || sessionStorage.getItem('PMOS_selected_portal_type') || '';
    } catch (_) {
      return this.selectedPortalType || '';
    }
  }

  isProviderRegistrationPortal() {
    return this.getRegistrationPortal() === 'provider';
  }

  /**
   * Display name for provider accounts when full name is not collected.
   */
  deriveProviderDisplayName(email) {
    const raw = String(email || '').split('@')[0] || '';
    const cleaned = raw.replace(/[._+-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 2) {
      return cleaned
        .split(' ')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
    }
    return 'OB-GYN';
  }

  /**
   * Registration role from portal choice (community = Regular User; provider = Other).
   */
  resolveRegistrationRole() {
    try {
      if (typeof window !== 'undefined' && /detect-user\.html/i.test(String(window.location.pathname || ''))) {
        return 'Regular User';
      }
    } catch (_) {
      /* ignore */
    }
    try {
      const portal = this.getRegistrationPortal();
      if (portal === 'community') {
        return 'Regular User';
      }
      if (portal === 'provider') {
        return 'Other';
      }
    } catch (_) {
      /* ignore */
    }
    const fromField = document.getElementById('register-role')?.value?.trim() || '';
    if (fromField) return fromField;
    return 'Other';
  }

  async handleLogin(e) {
    e.preventDefault();

    this.hideError('login-email-error');
    this.hideError('login-password-error');
    this.hideError('login-general-error');

    const email = document.getElementById('login-email')?.value || '';
    const password = document.getElementById('login-password')?.value || '';
    const rememberMe = document.getElementById('remember-me')?.checked || false;
    const portal =
      this.normalizeSelectedPortalType() ||
      document.body.getAttribute('data-pcode-auth-portal') ||
      'community';
    const expectedAccess = portal === 'provider' ? 'provider' : 'community';

    if (!this.validateEmail(email)) {
      this.showError('login-email-error', 'Please enter a valid email address');
      return;
    }

    if (password.length < 8) {
      this.showError('login-password-error', 'Password must be at least 8 characters');
      return;
    }

    this.setLoading('login-btn', true);

    try {
      const response = await this.simulateAuthRequest('login', {
        email,
        password: await this.hashPasswordForApi(password),
        expectedAccess,
        loginContext: 'portal-pick',
      });

      if (response.success && response.token && response.user) {
        this.clearLoginModalErrorDismissTimer();
        this.resetLoginLoadingModal();
        this.hideError('login-general-error');
        this.setSession(response.token, response.user, response.expiresIn, rememberMe, expectedAccess);
        this.closeAuthModal();

        let pendingRedirect = '';
        try {
          pendingRedirect = sessionStorage.getItem('PMOS_post_login_redirect') || '';
          sessionStorage.removeItem('PMOS_post_login_redirect');
        } catch (_) {}

        let redirectUrl = expectedAccess === 'provider' ? 'provider-dashboard.html' : 'index.html';
        if (pendingRedirect && expectedAccess !== 'provider') {
          redirectUrl = pendingRedirect;
        } else if (expectedAccess === 'provider' && pendingRedirect && /provider|patients|detect-provider|xai-provider|model-performance/i.test(pendingRedirect)) {
          redirectUrl = pendingRedirect;
        }
        window.location.replace(redirectUrl);
      } else {
        this.invalidateSessionOnAuthFailure();
        this.showErrorInline(
          'login-general-error',
          response.message || 'Invalid email or password'
        );
      }
    } catch (error) {
      this.invalidateSessionOnAuthFailure();
      this.showErrorInline('login-general-error', 'Network error. Please try again.');
      console.error('Login error:', error);
    } finally {
      this.setLoading('login-btn', false);
    }
  }

  async handleRegister(e) {
    e.preventDefault();

    this.hideError('register-email-error');
    this.hideError('register-password-error');
    this.hideError('register-general-error');
    this.hideError('login-general-error');

    const email = document.getElementById('register-email')?.value || '';
    const password = document.getElementById('register-password')?.value || '';
    const role = this.resolveRegistrationRole();
    const portal = this.getRegistrationPortal() || 'community';
    const isProvider = portal === 'provider';
    const registrationPortal = isProvider ? 'provider' : 'patient';
    // Display name is derived from email; users can edit it later in Edit Profile.
    const name = this.deriveProviderDisplayName(email);

    if (!this.validateEmail(email)) {
      this.showError('register-email-error', 'Please enter a valid email address');
      return;
    }

    if (password.length < 8) {
      this.showError('register-password-error', 'Password must be at least 8 characters');
      return;
    }

    if (!this.validatePassword(password)) {
      this.showError(
        'register-password-error',
        'Password must contain uppercase, lowercase, number, and special character'
      );
      return;
    }

    this.setLoading('register-btn', true);

    try {
      const response = await this.simulateAuthRequest('register', {
        user_name: name,
        email,
        password: await this.hashPasswordForApi(password),
        role,
        institution: '',
        registration_portal: registrationPortal,
      });

      if (response.success) {
        this.setAuthFloatMode('signin');
        const loginEmail = document.getElementById('login-email');
        if (loginEmail) loginEmail.value = email;
        const success = document.getElementById('auth-float-success');
        if (success) {
          success.textContent =
            response.message || 'Account created. Please sign in.';
          success.classList.remove('hidden');
        }
        const registerForm = document.getElementById('register-form');
        if (registerForm) registerForm.reset();
      } else {
        this.showError(
          'register-general-error',
          response.message || 'Registration failed'
        );
        this.showErrorInline(
          'login-general-error',
          response.message || 'Registration failed'
        );
      }
    } catch (error) {
      this.showError('register-general-error', 'Network error. Please try again.');
      console.error('Register error:', error);
    } finally {
      this.setLoading('register-btn', false);
    }
  }

  handleDeprecatedPasswordAuth(e, mode) {
    // Kept for compatibility — credential forms now use handleLogin / handleRegister.
    if (mode === 'register') {
      return this.handleRegister(e);
    }
    return this.handleLogin(e);
  }

  async handleLoginAuth(e) {
    return this.handleLogin(e);
  }

  async handleRegisterAuth(e) {
    return this.handleRegister(e);
  }

  async handleAdminLoginAuth(e) {
    e.preventDefault();
    
    const email = document.getElementById('admin-email').value;
    const password = document.getElementById('admin-password').value;
    const rememberMe = document.getElementById('admin-remember-me')?.checked || false;

    if (!this.validateEmail(email)) {
      this.showErrorInline('admin-email-error', 'Please enter a valid email address');
      return;
    }

    if (password.length < 8) {
      this.showErrorInline('admin-password-error', 'Password must be at least 8 characters');
      return;
    }

    this.setLoading('admin-login-btn', true);
    this.hideError('admin-login-general-error');

    try {
      // Authenticate against database with admin flag
      console.log('Attempting admin API login to:', this.apiBaseUrl + 'login.php');
      const response = await this.simulateAuthRequest('login', { 
        email, 
        password: await this.hashPasswordForApi(password),
        isAdminLogin: true 
      });
      
      console.log('API Response:', response);
      console.log('Response success:', response?.success);
      console.log('Response token:', response?.token ? 'present' : 'missing');
      console.log('Response user:', response?.user ? 'present' : 'missing');
      
      if (response && response.success === true) {
        // Verify all required fields are present
        if (response.token && response.user && response.expiresIn !== undefined) {
          // Verify user is actually an admin
          const userRole = response.user.role || '';
          if (!this.isAdminRoleString(userRole)) {
            console.error('Non-admin trying to log in via admin portal');
            this.invalidateSessionOnAuthFailure();
            this.showErrorInline('admin-login-general-error', 'Only administrator accounts can access this portal.');
            this.setLoading('admin-login-btn', false);
            return;
          }
          
          this.setSession(response.token, response.user, response.expiresIn, rememberMe);
          console.log('Admin session set successfully');
          console.log('User role:', response.user.role);
          
          console.log('Redirecting to admin-dashboard.html');
          window.location.replace('admin-dashboard.html');
        } else {
          console.error('Response missing required fields:', { token: !!response.token, user: !!response.user, expiresIn: response.expiresIn });
          this.invalidateSessionOnAuthFailure();
          this.showErrorInline('admin-login-general-error', 'Server returned incomplete response. Please try again.');
          this.setLoading('admin-login-btn', false);
        }
      } else {
        // Show error message from server
        const errorMsg = response?.message || 'Invalid email or password';
        console.error('Admin login failed:', errorMsg);
        this.invalidateSessionOnAuthFailure();
        this.showErrorInline('admin-login-general-error', errorMsg);
        this.setLoading('admin-login-btn', false);
      }
    } catch (error) {
      console.error('Admin login error:', error);
      this.invalidateSessionOnAuthFailure();
      this.showErrorInline('admin-login-general-error', 'Network error. Please try again.');
      this.setLoading('admin-login-btn', false);
    }
  }


  async handleGoogleLogin() {
    const googleLoginBtn = document.getElementById('google-login-btn');
    const googleRegisterBtn = document.getElementById('google-register-btn');
    
    const btnToLoad = googleLoginBtn || googleRegisterBtn;
    if (btnToLoad) {
      this.setLoading(btnToLoad.id, true);
    }

    try {
      // Initialize Google Sign-In
      const googleUser = await this.initiateGoogleSignIn();
      
      // Send token to backend
      const response = await this.simulateAuthRequest('google', { 
        token: googleUser.getAuthResponse().id_token 
      });

      if (response.success) {
        this.setSession(response.token, response.user, response.expiresIn, false);
        
        // Check if we're on auth page or index page
        if (window.location.pathname.includes('login-new.html')) {
          window.location.replace('index.html');
        } else {
          this.closeAuthModal();
          this.showNotification('Google login successful!', 'success');
          this.updateUIForLoggedInUser();
        }
      } else {
        this.invalidateSessionOnAuthFailure();
        this.showError('login-general-error', response.message || 'Google login failed');
      }
    } catch (error) {
      this.invalidateSessionOnAuthFailure();
      this.showError('login-general-error', 'Google sign-in failed. Please try again.');
      console.error('Google login error:', error);
    } finally {
      if (btnToLoad) {
        this.setLoading(btnToLoad.id, false);
      }
    }
  }

  initiateGoogleSignIn() {
    return new Promise((resolve, reject) => {
      // Check if Google API is loaded
      if (typeof gapi === 'undefined') {
        // Simulate Google login for demo
        setTimeout(() => {
          resolve({
            getAuthResponse: () => ({ id_token: 'mock_google_token' }),
            getBasicProfile: () => ({
              getName: () => 'Demo User',
              getEmail: () => 'demo@example.com',
              getImageUrl: () => ''
            })
          });
        }, 1000);
        return;
      }

      const auth2 = gapi.auth2.getAuthInstance();
      auth2.signIn().then(resolve).catch(reject);
    });
  }

  async simulateAuthRequest(type, data) {
    try {
      let endpoint = '';
      let payload = data;

      switch(type) {
        case 'login':
          endpoint = this.resolveApiUrl('login.php');
          break;
        case 'register':
          endpoint = this.resolveApiUrl('register.php');
          break;
        case 'verify':
          endpoint = this.resolveApiUrl('verify.php');
          break;
        default:
          return { success: false, message: 'Invalid request type' };
      }

      const headers = {
        'Content-Type': 'application/json'
      };

      // Add authorization token if available
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      console.log('Request URL:', endpoint);
      console.log('Request payload:', payload);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      console.log('Response status:', response.status);
      const responseText = await response.text();
      console.log('Response body:', responseText);

      try {
        const result = this.parseApiJsonResponse(responseText);
        return result;
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        const snippet = String(responseText || '').substring(0, 120);
        const looksHtml = /<!doctype|<html/i.test(snippet);
        return {
          success: false,
          message: looksHtml
            ? 'Auth API is unreachable from this site. Check config.json apiBaseUrl (Render/Hostinger).'
            : 'Server returned invalid response: ' + snippet,
        };
      }
    } catch (error) {
      console.error('API Error:', error);
      return { success: false, message: 'Network error: ' + error.message };
    }
  }

  /**
   * @param {string} [loginPortal] - 'community' | 'provider' from login-new (enforces role vs page); omit for legacy / admin / guest
   */
  setSession(token, user, expiresIn, rememberMe, loginPortal) {
    this.token = token;
    const normalizedUser = user ? { ...user } : user;
    if (normalizedUser) {
      const avatar = String(normalizedUser.avatar || normalizedUser.picture || '').trim();
      if (avatar) {
        normalizedUser.avatar = avatar;
        normalizedUser.picture = avatar;
      }
    }
    this.currentUser = normalizedUser;
    this.tokenExpiry = this.resolveTokenExpiryMs(expiresIn);

    // Always hydrate sessionStorage for current-tab auth state
    sessionStorage.setItem('PMOS_auth_token', token);
    sessionStorage.setItem('PMOS_user', JSON.stringify(normalizedUser));
    sessionStorage.setItem('PMOS_token_expiry', this.tokenExpiry.toString());
    try {
      if (loginPortal === 'community' || loginPortal === 'provider') {
        sessionStorage.setItem('PMOS_login_portal', loginPortal);
      } else {
        sessionStorage.removeItem('PMOS_login_portal');
      }
    } catch (_) {}

    // Remember me: persist session in localStorage so new tabs / restarts don't look "logged out"
    if (rememberMe) {
      const loginEmailField = document.getElementById('login-email');
      if (loginEmailField) {
        localStorage.setItem('PMOS_remembered_email', loginEmailField.value);
      }
      try {
        localStorage.setItem('PMOS_auth_token', token);
        localStorage.setItem('PMOS_user', JSON.stringify(normalizedUser));
        localStorage.setItem('PMOS_token_expiry', this.tokenExpiry.toString());
        localStorage.setItem('PMOS_remember_session', '1');
        if (loginPortal === 'community' || loginPortal === 'provider') {
          localStorage.setItem('PMOS_login_portal', loginPortal);
        } else {
          localStorage.removeItem('PMOS_login_portal');
        }
      } catch (_) {}
    } else {
      localStorage.removeItem('PMOS_remembered_email');
      // If the user did not opt into "Remember me", ensure no persisted auth remains
      localStorage.removeItem('PMOS_auth_token');
      localStorage.removeItem('PMOS_user');
      localStorage.removeItem('PMOS_token_expiry');
      localStorage.removeItem('PMOS_remember_session');
      try {
        localStorage.removeItem('PMOS_login_portal');
      } catch (_) {}
    }
    try {
      localStorage.removeItem('PMOS_remembered_password');
    } catch (_) {}

    // Start token refresh timer
    this.startTokenRefreshTimer();
    this.startSessionWatchdog();

    try {
      window.dispatchEvent(
        new CustomEvent('pcode-auth-ready', { detail: { user: this.currentUser } })
      );
    } catch (_) {}

    if (typeof this.syncServerSession === 'function') {
      this.syncServerSession();
    }
  }

  startTokenRefreshTimer() {
    if (this._tokenRefreshTimeoutId != null) {
      try {
        clearTimeout(this._tokenRefreshTimeoutId);
      } catch (_) {}
      this._tokenRefreshTimeoutId = null;
    }
    const refreshInterval = (this.tokenExpiry - Date.now()) - 60000; // Refresh 1 min before expiry
    
    if (refreshInterval > 0) {
      this._tokenRefreshTimeoutId = setTimeout(() => {
        this._tokenRefreshTimeoutId = null;
        this.refreshToken();
      }, refreshInterval);
    }
  }

  async refreshToken() {
    if (!this.token) return;
    const exp = this.normalizeTokenExpiryMs(sessionStorage.getItem('PMOS_token_expiry') || this.tokenExpiry);
    if (exp > Date.now() + 120000) {
      return;
    }
    try {
      const response = await fetch(`${this.apiBaseUrl}auth/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.token) {
          this.token = data.token;
        }
        if (data.expiresIn !== undefined) {
          this.tokenExpiry = this.resolveTokenExpiryMs(data.expiresIn);
        } else {
          this.tokenExpiry = Date.now() + AUTH_SESSION_TTL_MS;
        }

        sessionStorage.setItem('PMOS_auth_token', this.token);
        sessionStorage.setItem('PMOS_token_expiry', String(this.tokenExpiry));
        try {
          if (localStorage.getItem('PMOS_auth_token')) {
            localStorage.setItem('PMOS_auth_token', this.token);
            localStorage.setItem('PMOS_token_expiry', String(this.tokenExpiry));
          }
        } catch (_) {}

        this.startTokenRefreshTimer();
        this.startSessionWatchdog();
      } else if (response.status === 401) {
        this.handleSessionExpired();
      }
    } catch (error) {
      console.warn('Token refresh skipped (endpoint unavailable or network error):', error.message || error);
    }
  }

  logout(clearRememberedEmail = false) {
    const isAdmin = this.isAdminRoleString(this.currentUser?.role);
    const redirectUrl = isAdmin ? 'admin-login.html' : 'login-new.html';

    this.clearAuthData({ explicitLogout: true });
    
    // Clear remembered email if requested
    if (clearRememberedEmail) {
      localStorage.removeItem('PMOS_remembered_email');
    }

    this.updateUIForLoggedOutUser();
    this.showNotification('You have been logged out.', 'info');
    
    // Redirect to login page after a short delay
    setTimeout(() => {
      window.location.href = redirectUrl;
    }, 1500);
  }

  resolveProfileAvatarUrl(user) {
    if (!user) {
      return '';
    }
    const direct = String(user.avatar || user.picture || '').trim();
    if (direct) {
      return direct;
    }
    const displayName = user.name || user.user_name || user.email || 'User';
    return (
      'https://ui-avatars.com/api/?name=' +
      encodeURIComponent(displayName) +
      '&background=6B46C1&color=fff'
    );
  }

  applyProfileAvatarImage(imgEl, user) {
    if (!imgEl || !user) {
      return;
    }
    const fallback = this.resolveProfileAvatarUrl({
      ...user,
      avatar: '',
      picture: '',
    });
    const primary = String(user.avatar || user.picture || '').trim();
    imgEl.referrerPolicy = 'no-referrer';
    imgEl.onerror = () => {
      imgEl.onerror = null;
      if (imgEl.src !== fallback) {
        imgEl.src = fallback;
      }
    };
    imgEl.src = primary || fallback;
  }

  updateUIForLoggedInUser() {
    const authButton = document.getElementById('auth-button');
    const mobileAuthButton = document.getElementById('mobile-auth-button');
    const mobileAuthPanel = document.getElementById('mobile-auth-panel');
    const profileNavbar = document.getElementById('profile-navbar');
    const profileName = document.getElementById('profile-name');
    const profileRole = document.getElementById('profile-role');
    const profileAvatar = document.getElementById('profile-avatar');
    
    // Mobile profile elements
    const mobileProfile = document.getElementById('mobile-profile');
    const mobileProfileName = document.getElementById('mobile-profile-name');
    const mobileProfileRole = document.getElementById('mobile-profile-role');
    const mobileProfileAvatar = document.getElementById('mobile-profile-avatar');

    if (authButton) {
      authButton.classList.add('hidden');
    }

    if (mobileAuthPanel) {
      mobileAuthPanel.classList.add('hidden');
    }
    
    if (mobileAuthButton) {
      mobileAuthButton.classList.add('hidden');
    }

    if (profileNavbar && this.currentUser) {
      profileNavbar.classList.remove('hidden');
    }

    if (profileName && this.currentUser) {
      profileName.textContent = this.currentUser.name;
    }

    if (profileRole && this.currentUser) {
      profileRole.textContent = this.currentUser.role || 'Radiologist';
    }

    if (profileAvatar && this.currentUser) {
      this.applyProfileAvatarImage(profileAvatar, this.currentUser);
    }
    
    // Update mobile profile (community pages use hamburger drawer profile)
    if (mobileProfile && this.currentUser) {
      mobileProfile.classList.remove('hidden');
      // Add "Edit Profile" button above logout
      this.ensureMobileEditProfileButton();
    }
    
    if (mobileProfileName && this.currentUser) {
      mobileProfileName.textContent = this.currentUser.name;
    }
    
    if (mobileProfileRole && this.currentUser) {
      mobileProfileRole.textContent = this.currentUser.role || 'Radiologist';
    }
    
    if (mobileProfileAvatar && this.currentUser) {
      this.applyProfileAvatarImage(mobileProfileAvatar, this.currentUser);
    }

    // Role-based visibility: patients page is for healthcare providers only
    this.syncPortalNavigation(this.currentUser);
    this.applyProviderOnlyUI(this.currentUser);
    this.applyModelPerformanceNavVisibility(this.currentUser);
    this.applyGuestXaiNavVisibility(this.currentUser);
    this.syncGuestMarketingChrome();

    // Animate UI update
    if (profileNavbar && typeof anime !== 'undefined') {
      anime({
        targets: profileNavbar,
        opacity: [0, 1],
        translateX: [-20, 0],
        duration: 300,
        easing: 'easeOutQuad'
      });
    }

  }

  /**
   * Show/hide guest marketing chrome on Home / About.
   * [data-pcode-guest-only] — banner, why-sign-in, end CTA
   * [data-pcode-signed-in-only] — account widgets (history, screening results)
   */
  syncGuestMarketingChrome() {
    try {
      if (typeof document === 'undefined') return;
      const registered =
        !!(this.isAuthenticated() && this.currentUser && !this.currentUser.isGuest);
      document.querySelectorAll('[data-pcode-guest-only]').forEach((el) => {
        el.classList.toggle('hidden', registered);
        if (registered) {
          el.setAttribute('hidden', '');
          el.setAttribute('aria-hidden', 'true');
          el.style.display = 'none';
        } else {
          el.removeAttribute('hidden');
          el.setAttribute('aria-hidden', 'false');
          el.style.display = '';
        }
      });
      document.querySelectorAll('[data-pcode-signed-in-only]').forEach((el) => {
        el.classList.toggle('hidden', !registered);
        if (!registered) {
          el.setAttribute('hidden', '');
          el.setAttribute('aria-hidden', 'true');
          el.style.display = 'none';
        } else {
          el.removeAttribute('hidden');
          el.setAttribute('aria-hidden', 'false');
          el.style.display = '';
        }
      });
    } catch (_) {
      /* ignore */
    }
  }

  updateUIForLoggedOutUser() {
    const authButton = document.getElementById('auth-button');
    const mobileAuthButton = document.getElementById('mobile-auth-button');
    const mobileAuthPanel = document.getElementById('mobile-auth-panel');
    const profileNavbar = document.getElementById('profile-navbar');
    const mobileProfile = document.getElementById('mobile-profile');

    if (authButton) {
      authButton.classList.add('hidden');
    }

    if (mobileAuthPanel) {
      mobileAuthPanel.classList.remove('hidden');
    }
    
    if (mobileAuthButton) {
      mobileAuthButton.classList.remove('hidden');
    }

    if (profileNavbar) {
      profileNavbar.classList.add('hidden');
    }
    
    if (mobileProfile) {
      mobileProfile.classList.add('hidden');
    }

    // Keep portal nav complete on shared pages even when logged out
    this.syncPortalNavigation(null);
    this.applyProviderOnlyUI(null);
    this.applyModelPerformanceNavVisibility(null);
    this.applyGuestXaiNavVisibility(null);
    this.syncGuestMarketingChrome();

  }

  validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  validatePassword(password) {
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /\d/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    return hasUpper && hasLower && hasNumber && hasSpecial;
  }

  /**
   * SHA-256 hex digest before API send. Server stores bcrypt(digest).
   * Falls back to plaintext if Web Crypto is unavailable (server still digests).
   */
  async hashPasswordForApi(plaintext) {
    const text = String(plaintext || '');
    if (!text) return text;
    if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
    try {
      if (window.PcodePassword && typeof window.PcodePassword.sha256Hex === 'function') {
        return await window.PcodePassword.sha256Hex(text);
      }
      if (!window.crypto || !window.crypto.subtle) return text;
      const data = new TextEncoder().encode(text);
      const buf = await window.crypto.subtle.digest('SHA-256', data);
      const bytes = new Uint8Array(buf);
      let hex = '';
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return hex;
    } catch (_) {
      return text;
    }
  }

  showError(elementId, message) {
    const element = document.getElementById(elementId);
    if (element) {
      element.textContent = message;
      element.classList.remove('hidden');
      
      if (typeof anime !== 'undefined') {
        anime({
          targets: element,
          translateX: [-10, 0, 10, 0],
          duration: 400,
          easing: 'easeInOutQuad'
        });
      }
    }
  }

  showErrorInline(elementId, message) {
    const element = document.getElementById(elementId);
    if (element) {
      element.innerHTML = message;
      if (element.classList.contains('edit-profile-modal__error')) {
        element.classList.add('is-visible');
      } else {
        element.classList.add('show');
        element.classList.remove('hidden');
      }

      // Animate the error
      if (typeof anime !== 'undefined') {
        anime({
          targets: element,
          opacity: [0, 1],
          translateY: [-5, 0],
          duration: 300,
          easing: 'easeOutQuad'
        });
      }
    }
  }

  hideError(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
      element.classList.remove('show', 'is-visible', 'hidden');
      element.textContent = '';
      element.removeAttribute('style');
    }
  }

  setLoading(buttonId, isLoading) {
    const button = document.getElementById(buttonId);
    if (!button) {
      return;
    }
    if (isLoading) {
      if (button.dataset.originalText === undefined) {
        button.dataset.originalText = (button.textContent || '').trim();
      }
      button.disabled = true;
      // login-new.html: full-screen loading modal already indicates progress â€” plain label, no ellipsis, no duplicate spinner
      if (
        buttonId === 'login-btn' &&
        typeof document !== 'undefined' &&
        document.getElementById('login-loading-modal')
      ) {
        button.textContent = 'Signing in';
        return;
      }
      if (buttonId === 'login-btn') {
        button.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
          <span class="pcode-dual-ring-spinner pcode-dual-ring-spinner--xs" aria-hidden="true">${pcodeDualRingSpinnerMarkup(20)}</span>
          <span>Signing in</span>
        </div>
        `;
        return;
      }
      const loadingLabelById = {
        'register-btn': 'Creating account',
        'admin-login-btn': 'Signing in',
        'guest-login-btn': 'Continuing'
      };
      const loadingLabel = loadingLabelById[buttonId] || 'Please wait';
      button.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
          <span class="pcode-dual-ring-spinner pcode-dual-ring-spinner--xs" aria-hidden="true">${pcodeDualRingSpinnerMarkup(20)}</span>
          <span>${loadingLabel}</span>
        </div>
        `;
    } else {
      button.disabled = false;
      if (button.dataset.originalText !== undefined) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  }

  showNotification(message, type = 'info') {
    if (typeof window.pcodeShowCenterAlert === 'function') {
      window.pcodeShowCenterAlert(message, type);
    }
  }

  async handleGuestLogin() {
    this.cancelLoginNewAutoredirectIfAny();
    this.setLoading('guest-login-btn', true);
    this.hideError('login-general-error');

    try {
      // Call guest login API endpoint
      console.log('Attempting guest login to:', this.apiBaseUrl + 'guest_login.php');
      const response = await fetch(this.apiBaseUrl + 'guest_login.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      console.log('Guest login response status:', response.status);
      const responseText = await response.text();
      console.log('Guest login response body:', responseText);

      try {
        const result = JSON.parse(responseText);
        
        if (result && result.success === true) {
          if (result.token && result.user && result.expiresIn !== undefined) {
            this.setSession(result.token, result.user, result.expiresIn, false);
            console.log('Guest session set successfully');
            
            // Redirect to index immediately
            console.log('Redirecting to index.html as guest');
            window.location.replace('index.html');
          } else {
            console.error('Guest login response missing required fields');
            this.invalidateSessionOnAuthFailure();
            this.showErrorInline('login-general-error', 'Server error. Please try again.');
            this.setLoading('guest-login-btn', false);
          }
        } else {
          const errorMsg = result?.message || 'Guest login failed';
          console.error('Guest login failed:', errorMsg);
          this.invalidateSessionOnAuthFailure();
          this.showErrorInline('login-general-error', errorMsg);
          this.setLoading('guest-login-btn', false);
        }
      } catch (parseError) {
        console.error('Guest login response parse error:', parseError);
        this.invalidateSessionOnAuthFailure();
        this.showErrorInline('login-general-error', 'Server error. Please try again.');
        this.setLoading('guest-login-btn', false);
      }
    } catch (error) {
      console.error('Guest login error:', error);
      this.invalidateSessionOnAuthFailure();
      this.showErrorInline('login-general-error', 'Network error. Please try again.');
      this.setLoading('guest-login-btn', false);
    }
  }

  async handleGoogleAuth(idToken) {
    this.cancelLoginNewAutoredirectIfAny();
    const googleLoginBtn = document.getElementById('google-login-btn');
    if (googleLoginBtn) {
      googleLoginBtn.disabled = true;
      googleLoginBtn.style.opacity = '0.5';
    }
    this.hideError('login-general-error');

    try {
      console.log('Attempting Google login to:', this.resolveApiUrl('auth/google_callback.php'));

      const isLoginNew =
        typeof window !== 'undefined' &&
        /login-new\.html/i.test(String(window.location.pathname || ''));
      const portalForGoogle =
        this.normalizeSelectedPortalType() ||
        document.body.getAttribute('data-pcode-auth-portal') ||
        '';
      if (this.isLoginNewPortalUserContext()) {
        this.showLoginLoadingModal('', 'Signing in with Google…');
      }
      const googleBody = { id_token: idToken };
      if (portalForGoogle === 'community' || portalForGoogle === 'provider') {
        googleBody.expectedAccess = portalForGoogle;
        googleBody.loginContext = 'portal-pick';
      }
      const response = await fetch(this.resolveApiUrl('auth/google_callback.php'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(googleBody)
      });

      console.log('Google login response status:', response.status);
      const responseText = await response.text();
      console.log('Google login response body:', responseText);

      try {
        const result = this.parseApiJsonResponse(responseText);
        
        if (result && result.success === true) {
          if (result.token && result.user && result.expiresIn !== undefined) {
            const isLoginNew =
              typeof window !== 'undefined' &&
              /login-new\.html/i.test(String(window.location.pathname || ''));
            const u = result.user;
            const role = u && u.role != null ? u.role : '';
            const isAdmin = this.isAdminRoleString(role);

            if (!isAdmin && isLoginNew) {
              const p = this.normalizeSelectedPortalType();
              if (p !== 'community' && p !== 'provider') {
                this.returnLoginNewToAccessChooser(
                  'Choose Regular User or OB-GYN first, then use Google sign-in.'
                );
                return;
              }
              if (!this.portalAllowsRole(p, role)) {
                this.showLoginNewCredentialsRejectedInline();
                return;
              }
            }

            const pForSession = (() => {
              if (isAdmin) {
                return undefined;
              }
              if (!isLoginNew) {
                return undefined;
              }
              const p2 = this.normalizeSelectedPortalType();
              return p2 === 'community' || p2 === 'provider' ? p2 : undefined;
            })();
            this.clearLoginModalErrorDismissTimer();
            this.resetLoginLoadingModal();
            this.hideError('login-general-error');
            this.setSession(result.token, result.user, result.expiresIn, true, pForSession);
            console.log('Google session set successfully');

            let pendingRedirect = '';
            try {
              pendingRedirect = sessionStorage.getItem('PMOS_post_login_redirect') || '';
              sessionStorage.removeItem('PMOS_post_login_redirect');
            } catch (_) {}

            let redirectUrl = 'index.html';
            if (isAdmin) {
              redirectUrl = 'admin-dashboard.html';
            } else if (isLoginNew) {
              const p = this.normalizeSelectedPortalType();
              redirectUrl = p === 'provider' ? 'provider-dashboard.html' : 'index.html';
            } else {
              const p = this.normalizeSelectedPortalType();
              if (p === 'provider' || this.isProviderUser(result.user)) {
                redirectUrl = 'provider-dashboard.html';
              } else if (pendingRedirect) {
                redirectUrl = pendingRedirect;
              } else {
                const current = this.getCurrentPageName() || 'index.html';
                redirectUrl = current === 'login-new.html' ? 'index.html' : current;
              }
            }

            console.log('Redirecting to:', redirectUrl);
            window.location.replace(redirectUrl);
          } else {
            console.error('Google login response missing required fields');
            this.invalidateSessionOnAuthFailure();
            if (this.isLoginNewPortalUserContext()) {
              this.showLoginNewCredentialsRejectedInline('Server error. Please try again.');
            } else {
              this.showErrorInline('login-general-error', 'Server error. Please try again.');
            }
            if (googleLoginBtn) {
              googleLoginBtn.disabled = false;
              googleLoginBtn.style.opacity = '1';
            }
          }
        } else {
          const errorMsg = result?.message || 'Google sign-in failed';
          console.error('Google login failed:', errorMsg);
          this.invalidateSessionOnAuthFailure();
          if (this.isLoginNewPortalUserContext()) {
            if (response.status === 403) {
              this.showLoginNewCredentialsRejectedInline(errorMsg);
            } else {
              this.showLoginNewCredentialsRejectedInline(errorMsg);
            }
          } else {
            this.showErrorInline('login-general-error', errorMsg);
          }
          if (googleLoginBtn) {
            googleLoginBtn.disabled = false;
            googleLoginBtn.style.opacity = '1';
          }
        }
      } catch (parseError) {
        console.error('Google login response parse error:', parseError);
        this.invalidateSessionOnAuthFailure();
        if (this.isLoginNewPortalUserContext()) {
          this.showLoginNewCredentialsRejectedInline('Server error. Please try again.');
        } else {
          this.showErrorInline('login-general-error', 'Server error. Please try again.');
        }
        if (googleLoginBtn) {
          googleLoginBtn.disabled = false;
          googleLoginBtn.style.opacity = '1';
        }
      }
    } catch (error) {
      console.error('Google login error:', error);
      this.invalidateSessionOnAuthFailure();
      if (this.isLoginNewPortalUserContext()) {
        this.showLoginNewCredentialsRejectedInline('Network error. Please try again.');
      } else {
        this.showErrorInline('login-general-error', 'Network error. Please try again.');
      }
      if (googleLoginBtn) {
        googleLoginBtn.disabled = false;
        googleLoginBtn.style.opacity = '1';
      }
    }
  }

  /**
   * Bridge a Firebase ID token (email link / passwordless) into a P-Code session.
   * Mirrors handleGoogleAuth against api/auth/firebase_callback.php.
   */
  async handleFirebaseAuth(idToken, opts) {
    opts = opts || {};
    this.cancelLoginNewAutoredirectIfAny();
    this.hideError('login-general-error');

    try {
      const isLoginNew =
        typeof window !== 'undefined' &&
        /login-new\.html/i.test(String(window.location.pathname || ''));
      const portalForAuth =
        this.normalizeSelectedPortalType() ||
        document.body.getAttribute('data-pcode-auth-portal') ||
        '';
      if (this.isLoginNewPortalUserContext()) {
        this.showLoginLoadingModal('', 'Signing in with email link…');
      }
      const body = { id_token: idToken, mode: opts.mode || 'signin' };
      if (portalForAuth === 'community' || portalForAuth === 'provider') {
        body.expectedAccess = portalForAuth;
        body.loginContext = 'portal-pick';
      }
      const response = await fetch(this.apiBaseUrl + 'auth/firebase_callback.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const responseText = await response.text();
      const result = this.parseApiJsonResponse(responseText);

      if (result && result.success === true && result.token && result.user) {
        const u = result.user;
        const role = u && u.role != null ? u.role : '';
        const isAdmin = this.isAdminRoleString(role);

        if (!isAdmin && isLoginNew) {
          const p = this.normalizeSelectedPortalType();
          if (p !== 'community' && p !== 'provider') {
            this.returnLoginNewToAccessChooser(
              'Choose Regular User or OB-GYN first, then use the email link.'
            );
            return;
          }
          if (!this.portalAllowsRole(p, role)) {
            this.showLoginNewCredentialsRejectedInline();
            return;
          }
        }

        const pForSession = (() => {
          if (isAdmin) return undefined;
          if (!isLoginNew) return undefined;
          const p2 = this.normalizeSelectedPortalType();
          return p2 === 'community' || p2 === 'provider' ? p2 : undefined;
        })();

        this.clearLoginModalErrorDismissTimer();
        this.resetLoginLoadingModal();
        this.hideError('login-general-error');
        this.setSession(result.token, result.user, result.expiresIn, true, pForSession);

        // After passwordless sign-in, offer optional password set on login-new
        try {
          const wrap = document.getElementById('firebase-set-password-wrap');
          if (wrap && opts.mode === 'signup') {
            wrap.classList.remove('hidden');
          }
        } catch (_) {}

        let pendingRedirect = '';
        try {
          pendingRedirect = sessionStorage.getItem('PMOS_post_login_redirect') || '';
          sessionStorage.removeItem('PMOS_post_login_redirect');
        } catch (_) {}

        let redirectUrl = 'index.html';
        if (isAdmin) {
          redirectUrl = 'admin-dashboard.html';
        } else if (isLoginNew) {
          const p = this.normalizeSelectedPortalType();
          redirectUrl = p === 'provider' ? 'provider-dashboard.html' : 'index.html';
        } else {
          const p = this.normalizeSelectedPortalType();
          if (p === 'provider' || this.isProviderUser(result.user)) {
            redirectUrl = 'provider-dashboard.html';
          } else if (pendingRedirect) {
            redirectUrl = pendingRedirect;
          } else {
            const current = this.getCurrentPageName() || 'index.html';
            redirectUrl = current === 'login-new.html' ? 'index.html' : current;
          }
        }

        // For signup, briefly allow setting a password before redirect
        if (opts.mode === 'signup' && document.getElementById('firebase-set-password-wrap')) {
          const status = document.getElementById('firebase-email-status');
          if (status) {
            status.hidden = false;
            status.classList.remove('is-error');
            status.textContent =
              'Signed in. Optional: set a password below, or continue — redirecting in a few seconds…';
          }
          setTimeout(() => window.location.replace(redirectUrl), 4500);
          return;
        }

        window.location.replace(redirectUrl);
        return;
      }

      const errorMsg = (result && result.message) || 'Email link sign-in failed';
      this.invalidateSessionOnAuthFailure();
      if (this.isLoginNewPortalUserContext()) {
        this.showLoginNewCredentialsRejectedInline(errorMsg);
      } else {
        this.showErrorInline('login-general-error', errorMsg);
      }
    } catch (error) {
      console.error('Firebase email-link login error:', error);
      this.invalidateSessionOnAuthFailure();
      if (this.isLoginNewPortalUserContext()) {
        this.showLoginNewCredentialsRejectedInline('Network error. Please try again.');
      } else {
        this.showErrorInline('login-general-error', 'Network error. Please try again.');
      }
    }
  }

  getAuthHeaders() {
    if (!this.token) {
      this.isAuthenticated();
    }
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Fetch with Bearer token + session cookies (credentials: 'include').
   * Retries once after syncing/renewing the server session on 401.
   */
  async authenticatedFetch(url, options = {}) {
    if (!this.isAuthenticated()) {
      return Promise.reject(new Error('Not authenticated'));
    }
    const doFetch = () => {
      const headers = Object.assign({}, this.getAuthHeaders(), options.headers || {});
      return fetch(url, Object.assign({}, options, {
        credentials: 'include',
        headers,
      }));
    };
    let resp = await doFetch();
    if (resp.status === 401 && await this.syncServerSession()) {
      resp = await doFetch();
    }
    return resp;
  }

  /** Mirror JWT identity into PHP $_SESSION; renew expired tokens within server grace. */
  async syncServerSession() {
    if (!this.isAuthenticated()) {
      return false;
    }
    try {
      const resp = await fetch(this.apiBaseUrl + 'sync_session.php', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ token: this.token }),
      });
      if (!resp.ok) {
        if (resp.status === 401) {
          console.warn('[Auth] Session sync rejected â€” sign in again if API calls keep failing');
        }
        return false;
      }
      let data = null;
      try {
        data = await resp.json();
      } catch (_) {}
      if (data && data.token) {
        this.token = data.token;
        if (data.expiresIn != null) {
          this.tokenExpiry = this.resolveTokenExpiryMs(data.expiresIn);
        }
        sessionStorage.setItem('PMOS_auth_token', this.token);
        sessionStorage.setItem('PMOS_token_expiry', String(this.tokenExpiry));
        try {
          if (localStorage.getItem('PMOS_auth_token')) {
            localStorage.setItem('PMOS_auth_token', this.token);
            localStorage.setItem('PMOS_token_expiry', String(this.tokenExpiry));
          }
        } catch (_) {}
        this.startTokenRefreshTimer();
      }
      return true;
    } catch (err) {
      console.warn('[Auth] Session sync failed:', err);
      return false;
    }
  }

  isAuthenticated() {
    if (!this.token) {
      try {
        const sessionToken = sessionStorage.getItem('PMOS_auth_token');
        const localToken = localStorage.getItem('PMOS_auth_token');
        const rememberSession = localStorage.getItem('PMOS_remember_session') === '1';
        const savedToken = sessionToken || (rememberSession ? localToken : null);
        const savedUser = sessionStorage.getItem('PMOS_user')
          || (rememberSession ? localStorage.getItem('PMOS_user') : null);
        const savedExpiry = sessionStorage.getItem('PMOS_token_expiry')
          || (rememberSession ? localStorage.getItem('PMOS_token_expiry') : null);
        if (savedToken && savedUser && this.isSessionStillValid(savedToken, savedExpiry)) {
          this.token = savedToken;
          this.tokenExpiry = this.resolveSessionExpiryMs(savedToken, savedExpiry);
          try {
            this.currentUser = JSON.parse(savedUser);
          } catch (_) {
            return false;
          }
        }
      } catch (_) {}
    }
    if (!this.token || !this.currentUser) {
      return false;
    }
    return this.isSessionStillValid(this.token, this.tokenExpiry);
  }

  getCurrentUser() {
    return this.currentUser;
  }
}

/**
 * Toggle mobile menu visibility
 */
function toggleMobileMenu() {
  const mobileMenu = document.getElementById('mobile-menu');
  const menuOverlay = document.getElementById('menu-overlay');
  const menuIcon = document.getElementById('menu-icon');
  const closeIcon = document.getElementById('close-icon');
  
  if (!mobileMenu) {
    console.error('Mobile menu element not found');
    return;
  }
  
  // Check if menu is currently open
  const isOpen = mobileMenu.classList.contains('active');
  
  // Toggle menu
  mobileMenu.classList.toggle('active');
  const nowOpen = mobileMenu.classList.contains('active');
  document.body.classList.toggle('pcode-mobile-nav-open', nowOpen);

  const menuBtn = document.getElementById('mobile-menu-btn');
  if (menuBtn) menuBtn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
  
  // Toggle overlay
  if (menuOverlay) {
    menuOverlay.classList.toggle('active');
  }
  
  // Toggle icons
  if (menuIcon && closeIcon) {
    menuIcon.classList.toggle('hidden');
    closeIcon.classList.toggle('hidden');
  }
  
  // Prevent body scroll when menu is open
  if (!isOpen) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
  
  console.log('Mobile menu toggled:', mobileMenu.classList.contains('active'));
}

/**
 * Close mobile menu
 */
function closeMobileMenu() {
  const mobileMenu = document.getElementById('mobile-menu');
  const menuOverlay = document.getElementById('menu-overlay');
  const menuIcon = document.getElementById('menu-icon');
  const closeIcon = document.getElementById('close-icon');
  
  if (!mobileMenu) return;
  
  mobileMenu.classList.remove('active');
  document.body.classList.remove('pcode-mobile-nav-open');

  const menuBtn = document.getElementById('mobile-menu-btn');
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
  
  if (menuOverlay) {
    menuOverlay.classList.remove('active');
  }
  
  if (menuIcon && closeIcon) {
    menuIcon.classList.remove('hidden');
    closeIcon.classList.add('hidden');
  }
  
  // Restore body scroll
  document.body.style.overflow = '';
  
  console.log('Mobile menu closed');
}

// Close mobile menu when a link is clicked or ESC is pressed
document.addEventListener('DOMContentLoaded', function() {
  // Rebuild portal nav once DOM is ready (shared pages + role-specific links)
  try {
    if (window.auth && typeof window.auth.syncPortalNavigation === 'function') {
      window.auth.syncPortalNavigation(window.auth.currentUser || null);
    }
  } catch (_) {}

  const mobileMenu = document.getElementById('mobile-menu');
  const mobileLinks = document.querySelectorAll('#mobile-menu a, #mobile-logout-btn');
  
  // Close menu when clicking links
  mobileLinks.forEach(link => {
    link.addEventListener('click', function(e) {
      // Don't prevent default for links that navigate
      closeMobileMenu();
    });
  });
  
  // Close menu with ESC key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && mobileMenu) {
      if (mobileMenu.classList.contains('active')) {
        closeMobileMenu();
      }
    }
  });
  
  // Close menu on window resize (orientation change)
  window.addEventListener('resize', function() {
    if (mobileMenu && mobileMenu.classList.contains('active')) {
      // Check if screen is now larger - close menu on desktop view
      if (window.innerWidth > 768) {
        closeMobileMenu();
      }
    }
  });
  
  // Close menu on orientation change
  window.addEventListener('orientationchange', function() {
    if (mobileMenu && mobileMenu.classList.contains('active')) {
      setTimeout(closeMobileMenu, 100);
    }
  });
  
  console.log('Mobile menu event listeners attached');
});

function pcodeIsBentoUI() {
  const html = document.documentElement;
  if (html && html.classList.contains('pcode-app-bento-root')) return true;
  const b = document.body;
  return !!(b && (b.classList.contains('pcode-app-bento') || b.classList.contains('xai-bento-page') || b.classList.contains('login-bento-page')));
}

/** True when the app is in light theme (not html.dark). */
function pcodeIsLightTheme() {
  const html = document.documentElement;
  if (!html) return false;
  if (html.classList.contains('dark')) return false;
  const theme = html.getAttribute('data-pcode-theme');
  if (theme === 'dark') return false;
  if (theme === 'light') return true;
  return true;
}

/**
 * Structural shell only — colors come from CSS (light/dark).
 * Clears legacy inline dark glass so light mode is not stuck.
 */
function pcodeApplyCenterAlertBentoShell(overlay) {
  if (!overlay) return;
  overlay.classList.add('pcode-center-alert-overlay');
  overlay.style.zIndex = '9999';
  overlay.style.removeProperty('background-color');
  overlay.style.removeProperty('background');
  overlay.style.removeProperty('-webkit-backdrop-filter');
  overlay.style.removeProperty('backdrop-filter');
}

function pcodeApplyCenterAlertBentoCard(card) {
  if (!card) return;
  card.classList.add('pcode-center-alert-card');
  card.style.removeProperty('background');
  card.style.removeProperty('background-color');
  card.style.removeProperty('border');
  card.style.removeProperty('border-radius');
  card.style.removeProperty('box-shadow');
  card.style.removeProperty('color');
}

/**
 * Center-screen message modal (loading / success / error).
 * Stacks multiple modals; removes overlay when empty.
 *
 * @param {string} message
 * @param {'info'|'success'|'error'|'loading'} [type='info']
 * @param {{ persist?: boolean, dismissMs?: number|null, replaceLoading?: boolean }} [options]
 *   - type 'loading' (or persist:true) stays until pcodeDismissCenterAlert()
 *   - info toasts never clear sticky loading (prevents PDF export loader vanishing early)
 */
function pcodeShowCenterAlert(message, type = 'info', options = {}) {
  const raw = String(message ?? '');
  const isBento = pcodeIsBentoUI();
  const opts = options && typeof options === 'object' ? options : {};
  const isLoading = type === 'loading' || opts.persist === true;
  // Only loading/success/error clear sticky loaders — never plain info
  const clearPersist =
    opts.replaceLoading === true ||
    (opts.replaceLoading !== false && (isLoading || type === 'success' || type === 'error'));

  const sub =
    type === 'success'
      ? 'This window will close in a few seconds.'
      : type === 'error'
        ? 'Please check the message above and try again if needed.'
        : isLoading
          ? 'Please wait — PDF export can take up to a minute.'
          : 'This will close in a few seconds.';

  const rootId = 'pcode-center-alert-overlay';
  const innerId = 'pcode-center-alert-inner';
  let overlay = document.getElementById(rootId);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = rootId;
    overlay.className = isBento
      ? 'pcode-center-alert-overlay fixed inset-0 flex items-center justify-center p-4'
      : 'fixed inset-0 flex items-center justify-center p-4';
    if (!isBento) {
      overlay.style.cssText =
        'z-index:9999;background-color:rgba(0,0,0,0.5);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);';
    }
    overlay.setAttribute('aria-modal', 'true');
    const inner = document.createElement('div');
    inner.id = innerId;
    inner.className = 'flex flex-col gap-4 items-stretch w-full max-w-md';
    inner.setAttribute('role', 'list');
    overlay.appendChild(inner);
    document.body.appendChild(overlay);
    if (isBento) pcodeApplyCenterAlertBentoShell(overlay);
  } else if (isBento) {
    pcodeApplyCenterAlertBentoShell(overlay);
  }
  const inner = document.getElementById(innerId);
  if (!inner) return;

  if (clearPersist) {
    inner.querySelectorAll('[data-pcode-alert-persist="1"]').forEach((el) => el.remove());
  }

  const card = document.createElement('div');
  card.setAttribute('role', 'status');
  if (isLoading) card.setAttribute('data-pcode-alert-persist', '1');
  card.className = isBento
    ? 'pcode-center-alert-card rounded-lg p-8 flex flex-col items-center gap-4 w-full max-w-md'
    : 'bg-white rounded-lg shadow-2xl p-8 flex flex-col items-center gap-4 w-full max-w-md';
  if (isBento) pcodeApplyCenterAlertBentoCard(card);

  const spinner = document.createElement('div');
  spinner.className = 'pcode-dual-ring-spinner pcode-dual-ring-spinner--lg';
  spinner.setAttribute('aria-hidden', 'true');
  spinner.innerHTML = pcodeDualRingSpinnerMarkup(48);

  const p1 = document.createElement('p');
  p1.className = isBento
    ? 'pcode-center-alert-title text-center text-sm sm:text-base leading-relaxed break-words'
    : 'text-gray-700 font-semibold text-center text-sm sm:text-base leading-relaxed break-words';
  p1.textContent = raw;

  const p2 = document.createElement('p');
  p2.className = isBento
    ? 'pcode-center-alert-sub text-sm text-center'
    : 'text-sm text-gray-500 text-center';
  p2.textContent = sub;

  card.appendChild(spinner);
  card.appendChild(p1);
  card.appendChild(p2);
  inner.appendChild(card);

  if (typeof anime !== 'undefined') {
    anime({ targets: card, scale: [0.95, 1], opacity: [0, 1], duration: 220, easing: 'easeOutQuad' });
  }

  // Sticky loading stays until dismissed; other types auto-close
  if (isLoading) return card;

  const ms =
    typeof opts.dismissMs === 'number'
      ? opts.dismissMs
      : type === 'error'
        ? 4500
        : 4000;
  if (ms === null || ms < 0) return card;

  const cardToken = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  card.setAttribute('data-pcode-alert-token', cardToken);

  setTimeout(() => {
    // Do not remove if this card was already replaced / is no longer in the DOM
    if (!card.isConnected || card.getAttribute('data-pcode-alert-token') !== cardToken) return;
    // Never auto-remove if it was upgraded to sticky loading
    if (card.getAttribute('data-pcode-alert-persist') === '1') return;
    const finishRemove = () => {
      if (!card.isConnected) return;
      card.remove();
      if (inner.children.length === 0) {
        const o = document.getElementById(rootId);
        if (o) o.remove();
      }
    };
    if (typeof anime !== 'undefined') {
      anime({
        targets: card,
        opacity: 0,
        scale: 0.98,
        duration: 200,
        easing: 'easeInQuad',
        complete: finishRemove
      });
    } else {
      finishRemove();
    }
  }, ms);

  return card;
}

/** Dismiss sticky/loading center alerts (and empty overlay). */
function pcodeDismissCenterAlert(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const onlyPersist = opts.onlyPersist !== false;
  const rootId = 'pcode-center-alert-overlay';
  const innerId = 'pcode-center-alert-inner';
  const overlay = document.getElementById(rootId);
  const inner = document.getElementById(innerId);
  if (!inner) {
    if (overlay) overlay.remove();
    return;
  }
  if (onlyPersist) {
    inner.querySelectorAll('[data-pcode-alert-persist="1"]').forEach((el) => el.remove());
  } else {
    inner.innerHTML = '';
  }
  if (inner.children.length === 0 && overlay) overlay.remove();
}

/**
 * Dedicated PDF-export blocking loader.
 * Separate from center alerts so autosave/info toasts cannot dismiss it.
 */
function pcodeShowExportLoading(message) {
  const rootId = 'pcode-export-loading-overlay';
  const isBento = pcodeIsBentoUI();
  let overlay = document.getElementById(rootId);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = rootId;
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-busy', 'true');
    overlay.className = isBento
      ? 'pcode-center-alert-overlay fixed inset-0 flex items-center justify-center p-4'
      : 'fixed inset-0 flex items-center justify-center p-4';
    overlay.style.cssText =
      'z-index:10050;';
    document.body.appendChild(overlay);
  }
  if (isBento) pcodeApplyCenterAlertBentoShell(overlay);
  overlay.style.zIndex = '10050';
  overlay.style.removeProperty('background-color');
  overlay.style.removeProperty('-webkit-backdrop-filter');
  overlay.style.removeProperty('backdrop-filter');

  const title = String(message || 'Generating PDF report…');
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = isBento
    ? 'pcode-center-alert-card rounded-lg p-8 flex flex-col items-center gap-4 w-full max-w-md'
    : 'bg-white rounded-lg shadow-2xl p-8 flex flex-col items-center gap-4 w-full max-w-md';
  if (isBento) pcodeApplyCenterAlertBentoCard(card);

  const spinner = document.createElement('div');
  spinner.className = 'pcode-dual-ring-spinner pcode-dual-ring-spinner--lg';
  spinner.setAttribute('aria-hidden', 'true');
  spinner.innerHTML = pcodeDualRingSpinnerMarkup(48);

  const p1 = document.createElement('p');
  p1.className = isBento
    ? 'pcode-center-alert-title text-center text-sm sm:text-base leading-relaxed break-words'
    : 'text-gray-700 font-semibold text-center text-sm sm:text-base leading-relaxed break-words';
  p1.textContent = title;

  const p2 = document.createElement('p');
  p2.className = isBento
    ? 'pcode-center-alert-sub text-sm text-center'
    : 'text-sm text-gray-500 text-center';
  p2.textContent = 'Please wait — this can take up to a minute. Do not close this tab.';

  card.appendChild(spinner);
  card.appendChild(p1);
  card.appendChild(p2);
  overlay.appendChild(card);
  document.body.style.overflow = 'hidden';
  return overlay;
}

function pcodeHideExportLoading() {
  const overlay = document.getElementById('pcode-export-loading-overlay');
  if (overlay) overlay.remove();
  // Restore scroll only if no other center overlay is open
  if (!document.getElementById('pcode-center-alert-overlay')) {
    document.body.style.overflow = '';
  }
}

window.pcodeShowCenterAlert = pcodeShowCenterAlert;
window.pcodeDismissCenterAlert = pcodeDismissCenterAlert;
window.pcodeShowExportLoading = pcodeShowExportLoading;
window.pcodeHideExportLoading = pcodeHideExportLoading;

// Initialize Auth Manager
const auth = new AuthManager();

// Export for global access
window.auth = auth;

// If this script runs after DOMContentLoaded (common for end-of-body tags),
// rebuild portal nav immediately so shared pages never miss links.
if (document.readyState !== 'loading') {
  try {
    auth.syncPortalNavigation(auth.currentUser || null);
  } catch (_) {}
}

(function ensurePcodeResponsiveGlobalCss() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-responsive-global-css')) return;
    const link = document.createElement('link');
    link.id = 'pcode-responsive-global-css';
    link.rel = 'stylesheet';
    link.href = 'css/pcode-responsive-global.css';
    document.head.appendChild(link);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeGlassButtonsCss() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-glass-buttons-css')) return;
    const link = document.createElement('link');
    link.id = 'pcode-glass-buttons-css';
    link.rel = 'stylesheet';
    link.href = 'css/pcode-glass-buttons.css';
    document.head.appendChild(link);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeMetricStealthCss() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-metric-stealth-css')) return;
    const link = document.createElement('link');
    link.id = 'pcode-metric-stealth-css';
    link.rel = 'stylesheet';
    link.href = 'css/pcode-metric-stealth.css';
    document.head.appendChild(link);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeMetricStealthJs() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-metric-stealth-js')) return;
    const script = document.createElement('script');
    script.id = 'pcode-metric-stealth-js';
    script.src = 'js/pcode-metric-stealth.js';
    script.defer = true;
    document.head.appendChild(script);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeDesignSystemCss() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-design-system-css')) return;
    const link = document.createElement('link');
    link.id = 'pcode-design-system-css';
    link.rel = 'stylesheet';
    link.href = 'css/pcode-design-system.css';
    document.head.appendChild(link);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeAppBentoDarkCss() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-app-bento-dark-css')) return;
    const link = document.createElement('link');
    link.id = 'pcode-app-bento-dark-css';
    link.rel = 'stylesheet';
    link.href = 'css/pcode-app-bento-dark.css';
    document.head.appendChild(link);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeThemeScript() {
  try {
    if (typeof document === 'undefined') return;
    function bootTheme() {
      if (typeof globalThis.PcodeTheme !== 'undefined' && typeof globalThis.PcodeTheme.init === 'function') {
        globalThis.PcodeTheme.init();
      }
    }
    if (typeof globalThis.PcodeTheme !== 'undefined') {
      bootTheme();
      return;
    }
    if (document.querySelector('script[src*="pcode-theme.js"]')) return;
    const script = document.createElement('script');
    script.src = 'js/pcode-theme.js';
    script.onload = bootTheme;
    document.head.appendChild(script);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeEchartNeonScript() {
  try {
    if (typeof document === 'undefined') return;
    if (
      document.getElementById('pcode-echart-neon-js') ||
      document.querySelector('script[src*="pcode-echart-neon-bars"]')
    ) {
      return;
    }
    const script = document.createElement('script');
    script.id = 'pcode-echart-neon-js';
    script.src = 'js/pcode-echart-neon-bars.js';
    document.head.appendChild(script);
  } catch (_) {
    /* ignore */
  }
})();

(function ensurePcodeResponsiveScript() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pcode-responsive-js')) return;
    const script = document.createElement('script');
    script.id = 'pcode-responsive-js';
    script.src = 'js/pcode-responsive.js';
    script.defer = true;
    document.head.appendChild(script);
  } catch (_) {
    /* ignore */
  }
})();
