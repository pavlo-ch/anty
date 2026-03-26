// ===== Anty Browser — Renderer UI Logic =====

let profiles = [];
let proxies = [];
let folders = [];
let groups = [];
let tags = [];
let selectedProfileId = null;
let runningProfiles = new Set();
let accountState = null;
let mandatoryUpdateRequired = false;
let mandatoryUpdateOpenInProgress = false;
let proxyLocaleBackfillRunning = false;
let profileCloudSyncRunning = false;
let autoSaveTimer = null;
let autoSaveInFlight = false;
let autoSaveQueued = false;
let suppressAutoSave = false;
let activePlatformTab = 'all';
const DEFAULT_PLATFORM_STORAGE_KEY = 'anty.defaultPlatformTab';
const SUPPORTED_PLATFORM_TABS = new Set(['all', 'instagram', 'linkedin', 'facebook']);
let mandatoryUpdateFlow = {
  version: null,
  currentVersion: null,
  downloading: false,
  downloaded: false,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  error: '',
  installerOpened: false,
};

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setActivePlatformTab(loadStoredPlatformTab(), { save: false, render: false });
  window.api.onUpdateStatus(handleUpdateStatus);
  await renderAppVersion();
  
  window.api.onProfileStatus((data) => {
    if (data.status === 'running') {
      runningProfiles.add(data.profileId);
    } else {
      runningProfiles.delete(data.profileId);
    }
    renderProfilesList();
    if (selectedProfileId === data.profileId) {
      loadProfileEditor(data.profileId);
    }
  });

  try {
    const startupUpdate = await window.api.startupUpdateCheck();
    if (startupUpdate?.required) {
      showMandatoryUpdateModal(startupUpdate);
      return;
    }
  } catch (err) {
    console.error('Startup update check failed:', err);
  }

  const isLoggedIn = await maybeShowLoginModal();
  if (!isLoggedIn) return;

  await loadData();
  renderProfilesList();
  void backfillProxyLocaleForExistingProfiles();
  void runProfileCloudSync({ silent: true });
  await refreshAccountPage();

  // Auto-refresh: reload local profiles every 15s (picks up changes from other sessions)
  setInterval(async () => {
    await loadData();
    renderProfilesList();
  }, 15000);

  // Auto cloud sync: pull from cloud every 60s
  setInterval(() => {
    void runProfileCloudSync({ silent: true });
  }, 60000);
});

async function renderAppVersion() {
  try {
    const version = await window.api.getAppVersion();
    if (!version) return;
    const normalized = String(version).startsWith('v') ? String(version) : `v${version}`;
    const navSettingsVersion = document.getElementById('nav-settings-version');
    if (navSettingsVersion) navSettingsVersion.textContent = normalized;
    const settingsVersion = document.getElementById('settings-version');
    if (settingsVersion) settingsVersion.textContent = normalized;
  } catch (err) {
    console.error('Failed to load app version:', err);
  }
}

async function loadData() {
  try {
    [profiles, proxies, folders, groups, tags] = await Promise.all([
      window.api.getProfiles(),
      window.api.getProxies(),
      window.api.getFolders(),
      window.api.getGroups(),
      window.api.getTags ? window.api.getTags() : Promise.resolve([])
    ]);
    const running = await window.api.getRunningProfiles();
    runningProfiles = new Set(running);
  } catch (err) {
    if (isLoginRequiredError(err)) {
      showLoginModal();
      return;
    }
    console.error('Failed to load data:', err);
  }
}

async function runProfileCloudSync(options = {}) {
  if (!window.api.runProfileCloudSync || profileCloudSyncRunning) return;
  profileCloudSyncRunning = true;
  try {
    const result = await window.api.runProfileCloudSync();
    const pulled = Number(result?.pull?.pulled || 0);
    if (pulled > 0) {
      await loadData();
      renderProfilesList(document.getElementById('search-input')?.value || '');
      if (selectedProfileId) {
        await loadProfileEditor(selectedProfileId);
      }
    }

    if (options.silent) return;
    if (result?.ok) {
      showToast(`Cloud sync completed${pulled > 0 ? ` (${pulled} profiles updated)` : ''}`, 'success');
      return;
    }
    if (!result?.skipped) {
      const reason = result?.pull?.reason || result?.push?.reason || result?.reason || 'sync_failed';
      showToast(`Cloud sync failed: ${reason}`, 'error');
    }
  } catch (err) {
    if (!options.silent) {
      showToast(`Cloud sync failed: ${err.message || 'unknown_error'}`, 'error');
    }
  } finally {
    profileCloudSyncRunning = false;
  }
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Sidebar navigation
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.disabled === 'true') return;
      const page = btn.dataset.page;
      if (page === 'feedback') {
        void window.api.openExternal('https://t.me/nayborovskiy');
        return;
      }
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const pageEl = document.getElementById(`page-${page}`);
      if (pageEl) pageEl.classList.add('active');
      if (page === 'account') {
        refreshAccountPage();
      }
      if (page === 'settings') {
        refreshSettingsPage();
      }
    });
  });

  // Tab bar tabs
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      setActivePlatformTab(tab.dataset.tab || 'all');
    });
  });

  // New Profile buttons
  document.getElementById('btn-new-profile').addEventListener('click', createNewProfile);
  document.getElementById('btn-empty-new-profile')?.addEventListener('click', createNewProfile);

  // Profile editor tabs
  document.querySelectorAll('.editor-tab[data-editor-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.editor-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.editor-tab-content').forEach(c => c.classList.remove('active'));
      const content = document.getElementById(`tab-${tab.dataset.editorTab}`);
      if (content) content.classList.add('active');
    });
  });

  // Info tabs
  document.querySelectorAll('.info-tab[data-info-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.info-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.info-tab-content').forEach(c => c.classList.remove('active'));
      const content = document.getElementById(`info-tab-${tab.dataset.infoTab}`);
      if (content) content.classList.add('active');
    });
  });

  // Profile actions
  document.getElementById('btn-delete-profile')?.addEventListener('click', () => {
    if (selectedProfileId) confirmDeleteProfile(selectedProfileId);
  });
  document.getElementById('btn-open-profile').addEventListener('click', () => {
    if (selectedProfileId) {
      if (runningProfiles.has(selectedProfileId)) {
        stopProfile(selectedProfileId);
      } else {
        launchProfile(selectedProfileId);
      }
    }
  });

  // Advanced tab — Parse UA button
  document.getElementById('btn-parse-ua')?.addEventListener('click', () => {
    const ua = document.getElementById('editor-useragent')?.value?.trim();
    if (!ua) return;
    // Ask main process to parse UA and return matching fingerprint fields
    window.api?.parseUA?.(ua).then(parsed => {
      if (!parsed) return;
      if (parsed.webglVendor) document.getElementById('editor-webgl-vendor').value = parsed.webglVendor;
      if (parsed.webglRenderer) document.getElementById('editor-webgl-renderer').value = parsed.webglRenderer;
      if (parsed.cpuCores) document.getElementById('editor-cpu-cores').value = parsed.cpuCores;
      if (parsed.memoryGb) document.getElementById('editor-memory-gb').value = parsed.memoryGb;
      if (parsed.screenWidth) document.getElementById('editor-screen-w').value = parsed.screenWidth;
      if (parsed.screenHeight) document.getElementById('editor-screen-h').value = parsed.screenHeight;
      scheduleAutoSave(300);
    }).catch(() => {});
  });

  // Advanced tab — Regenerate fingerprint button
  document.getElementById('btn-regen-fp')?.addEventListener('click', async () => {
    if (!selectedProfileId) return;
    const newFp = await window.api?.regenerateFingerprint?.(selectedProfileId);
    if (!newFp) return;
    // Reload editor with new fingerprint
    const profile = profiles.find(p => p.id === selectedProfileId);
    if (profile) {
      profile.fingerprint = JSON.stringify(newFp);
      loadProfileIntoEditor(profile);
      scheduleAutoSave(300);
    }
  });

  // Cookies — browse files click
  document.getElementById('cookies-browse-btn')?.addEventListener('click', () => {
    document.getElementById('cookies-file-input')?.click();
  });

  // Cookies — file input change (selected via browser dialog)
  document.getElementById('cookies-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readCookiesFile(file);
    e.target.value = '';
  });

  // Cookies — drag & drop on dropzone
  const dropzone = document.getElementById('cookies-dropzone');
  dropzone?.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dropzone?.addEventListener('dragleave', (e) => {
    if (!dropzone.contains(e.relatedTarget)) {
      dropzone.classList.remove('drag-over');
    }
  });
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    readCookiesFile(file);
  });

  // Cookies toggle text/dropzone view
  document.getElementById('cookies-text-toggle').addEventListener('click', () => {
    const textarea = document.getElementById('cookies-textarea');
    const content = document.querySelector('.cookies-dropzone-content');
    if (textarea.style.display === 'none') {
      textarea.style.display = 'block';
      content.style.display = 'none';
    } else {
      textarea.style.display = 'none';
      content.style.display = 'block';
    }
  });

  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    renderProfilesList(e.target.value);
  });

  // Platform selector → update start_page only
  document.getElementById('editor-platform')?.addEventListener('change', (e) => {
    const platform = e.target.value;
    const platformUrls = {
      instagram: 'https://www.instagram.com',
      facebook:  'https://www.facebook.com',
      linkedin:  'https://www.linkedin.com',
    };
    const url = platformUrls[platform];
    if (url) {
      const startPageEl = document.getElementById('editor-start-page');
      if (startPageEl) startPageEl.value = url;
    }
    scheduleAutoSave(120);
  });

  // Save proxy
  document.getElementById('btn-save-proxy').addEventListener('click', saveProxy);

  // Check proxy
  document.getElementById('btn-check-proxy').addEventListener('click', checkCurrentProxy);

  // Proxy select change — load proxy data into fields
  document.getElementById('editor-proxy-select').addEventListener('change', (e) => {
    const proxyId = parseInt(e.target.value);
    const proxy = proxies.find(p => p.id === proxyId);
    if (proxy) {
      document.getElementById('editor-proxy-type').value = proxy.type || 'http';
      let str = proxy.host;
      if (proxy.port) str += ':' + proxy.port;
      if (proxy.username) str += ':' + proxy.username;
      if (proxy.password) str += ':' + proxy.password;
      document.getElementById('editor-proxy-value').value = str;
      document.getElementById('editor-proxy-name').value = proxy.name || '';
      document.getElementById('editor-proxy-change-link').value = proxy.ip_change_link || '';
    } else {
      document.getElementById('editor-proxy-value').value = '';
      document.getElementById('editor-proxy-name').value = '';
      document.getElementById('editor-proxy-change-link').value = '';
    }
    scheduleAutoSave(350);
  });

  const autoSaveOnInputIds = [
    'editor-profile-name',
    'editor-start-page',
    'editor-warmup-url',
    'editor-tags',
    'profile-notes'
  ];
  autoSaveOnInputIds.forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => scheduleAutoSave(500));
    document.getElementById(id)?.addEventListener('change', () => scheduleAutoSave(120));
  });

  const autoSaveOnChangeIds = [
    'editor-folder',
    'editor-group',
    'editor-import-expired'
  ];

  document.getElementById('editor-created-by')?.addEventListener('input', () => scheduleAutoSave(600));
  autoSaveOnChangeIds.forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => scheduleAutoSave(120));
  });

  // Fingerprint mode selects — were missing, changes were silently lost
  const fpSelectIds = [
    'editor-canvas-mode',
    'editor-audio-mode',
    'editor-fonts-mode',
    'editor-webrtc-mode',
    'editor-media-mode',
    'editor-geo-mode',
    'editor-start-action',
  ];
  fpSelectIds.forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => scheduleAutoSave(120));
  });

  // Hardware / locale inputs — were missing too
  const fpInputIds = [
    'editor-cpu-cores',
    'editor-memory-gb',
    'editor-screen-w',
    'editor-screen-h',
    'editor-language',
    'editor-timezone',
    'editor-webgl-vendor',
    'editor-webgl-renderer',
  ];
  fpInputIds.forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => scheduleAutoSave(600));
    document.getElementById(id)?.addEventListener('change', () => scheduleAutoSave(150));
  });

  // UA textarea — save on change
  document.getElementById('editor-useragent')?.addEventListener('input', () => scheduleAutoSave(800));
  document.getElementById('editor-useragent')?.addEventListener('change', () => scheduleAutoSave(300));

  document.getElementById('cookies-textarea')?.addEventListener('input', () => scheduleAutoSave(800));
  document.getElementById('cookies-textarea')?.addEventListener('change', () => scheduleAutoSave(120));

  // Import proxy from clipboard
  document.getElementById('btn-import-proxy')?.addEventListener('click', importProxyFromClipboard);

  // Copy profile name to clipboard
  document.getElementById('btn-copy-profile')?.addEventListener('click', copyProfileName);

  // Copy profile info to clipboard
  document.getElementById('btn-copy-info')?.addEventListener('click', copyProfileInfo);

  // Sort / Filter
  document.getElementById('btn-sort')?.addEventListener('click', toggleSortMenu);
  document.getElementById('btn-filter')?.addEventListener('click', toggleFilterMenu);

  // IP Change Link — open in browser
  document.getElementById('btn-open-change-link')?.addEventListener('click', () => {
    const url = document.getElementById('editor-proxy-change-link')?.value?.trim();
    if (!url) { showToast('Enter an IP change link first', 'error'); return; }
    void window.api.openExternal(url.startsWith('http') ? url : 'http://' + url);
  });

  // Geo mode — show/hide manual coordinate fields
  document.getElementById('editor-geo-mode')?.addEventListener('change', (e) => {
    toggleGeoManualFields(e.target.value);
    scheduleAutoSave(120);
  });

  // Geo manual coordinate inputs auto-save
  document.getElementById('editor-geo-lat')?.addEventListener('input', () => scheduleAutoSave(600));
  document.getElementById('editor-geo-lon')?.addEventListener('input', () => scheduleAutoSave(600));

  // Settings page buttons
  document.getElementById('btn-settings-check-update')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-settings-check-update');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    try {
      await window.api.checkAppUpdates();
      showToast('Update check started', 'success');
    } catch (err) {
      showToast('Update check failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check for updates';
    }
  });
  document.getElementById('btn-settings-open-data')?.addEventListener('click', async () => {
    const result = await window.api.openUserData?.();
    if (result && !result.ok) showToast('Could not open folder: ' + result.message, 'error');
  });
  document.getElementById('btn-settings-logout')?.addEventListener('click', logoutAccount);
  document.getElementById('settings-default-platform')?.addEventListener('change', (e) => {
    setActivePlatformTab(e.target.value, { save: true, render: true });
  });

  // Account
  document.getElementById('btn-account-logout')?.addEventListener('click', logoutAccount);

  document.getElementById('btn-modal-login')?.addEventListener('click', loginFromModal);

  document.getElementById('btn-update-lock-install')?.addEventListener('click', handleMandatoryUpdatePrimaryAction);
  document.getElementById('btn-update-lock-restart')?.addEventListener('click', handleMandatoryRestartAction);
  document.getElementById('btn-update-lock-exit')?.addEventListener('click', () => {
    void window.api.quitApp();
  });
}

// ===== PROFILE CRUD =====
function clearAutoSaveTimer() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

function scheduleAutoSave(delayMs = 400) {
  if (suppressAutoSave || !selectedProfileId) return;
  clearAutoSaveTimer();
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    void persistSelectedProfile({ isAuto: true, silentSuccess: true });
  }, Math.max(80, Number(delayMs) || 400));
}

function parseTagsInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const names = text.split(',').map((part) => part.trim()).filter(Boolean);
  return Array.from(new Set(names.map((name) => name.slice(0, 64))));
}

function extractTagNames(tagsValue) {
  if (!Array.isArray(tagsValue) || !tagsValue.length) return [];
  return tagsValue.map((entry) => {
    if (entry && typeof entry === 'object') return String(entry.name || '').trim().toLowerCase();
    return String(entry || '').trim().toLowerCase();
  }).filter(Boolean);
}

function getProfilePlatform(profile) {
  const startPage = String(profile?.start_page || '').toLowerCase();
  const tagNames = extractTagNames(profile?.tags || []);

  if (startPage.includes('instagram.com') || tagNames.some((tag) => tag.includes('instagram') || tag === 'ig')) {
    return 'instagram';
  }
  if (startPage.includes('linkedin.com') || tagNames.some((tag) => tag.includes('linkedin') || tag === 'li')) {
    return 'linkedin';
  }
  if (startPage.includes('facebook.com') || tagNames.some((tag) => tag.includes('facebook') || tag === 'fb')) {
    return 'facebook';
  }
  return 'other';
}

function normalizePlatformTab(value) {
  const tab = String(value || '').trim().toLowerCase();
  return SUPPORTED_PLATFORM_TABS.has(tab) ? tab : 'all';
}

function loadStoredPlatformTab() {
  try {
    return normalizePlatformTab(localStorage.getItem(DEFAULT_PLATFORM_STORAGE_KEY));
  } catch {
    return 'all';
  }
}

function saveStoredPlatformTab(value) {
  try {
    localStorage.setItem(DEFAULT_PLATFORM_STORAGE_KEY, normalizePlatformTab(value));
  } catch {
    // Ignore storage errors
  }
}

function syncPlatformControls() {
  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    tab.classList.toggle('active', (tab.dataset.tab || 'all') === activePlatformTab);
  });

  const settingsSelect = document.getElementById('settings-default-platform');
  if (settingsSelect && settingsSelect.value !== activePlatformTab) {
    settingsSelect.value = activePlatformTab;
  }
}

function setActivePlatformTab(value, { save = true, render = true } = {}) {
  activePlatformTab = normalizePlatformTab(value);
  syncPlatformControls();
  if (save) saveStoredPlatformTab(activePlatformTab);
  if (render) {
    renderProfilesList(document.getElementById('search-input')?.value || '');
  }
}

function formatTagsInput(tagsValue) {
  if (!Array.isArray(tagsValue) || !tagsValue.length) return '';
  const names = tagsValue.map((entry) => {
    if (entry && typeof entry === 'object') return String(entry.name || '').trim();
    return String(entry || '').trim();
  }).filter(Boolean);
  return Array.from(new Set(names)).join(', ');
}

function populateTagSuggestions() {
  const list = document.getElementById('tags-suggestions');
  if (!list) return;
  list.innerHTML = (Array.isArray(tags) ? tags : [])
    .map((tag) => `<option value="${escapeHtml(tag?.name || '')}"></option>`)
    .join('');
}

function collectProfileEditorData() {
  const folderVal = document.getElementById('editor-folder').value;
  const groupVal = document.getElementById('editor-group').value;
  const proxySelectVal = document.getElementById('editor-proxy-select').value;
  const parsedFolderId = Number.parseInt(folderVal, 10);
  const parsedGroupId = Number.parseInt(groupVal, 10);
  const parsedProxyId = Number.parseInt(proxySelectVal, 10);
  const data = {
    name: document.getElementById('editor-profile-name').value,
    folder_id: Number.isFinite(parsedFolderId) ? parsedFolderId : null,
    group_id: Number.isFinite(parsedGroupId) ? parsedGroupId : null,
    start_page: document.getElementById('editor-start-page').value,
    warmup_url: document.getElementById('editor-warmup-url')?.value || '',
    notes: document.getElementById('profile-notes').value,
    proxy_id: Number.isFinite(parsedProxyId) ? parsedProxyId : null,
    tags: parseTagsInput(document.getElementById('editor-tags')?.value || ''),
    created_by: (document.getElementById('editor-created-by')?.value || '').trim()
  };

  const cookiesText = document.getElementById('cookies-textarea').value;
  const importExpired = Boolean(document.getElementById('editor-import-expired')?.checked);
  if (cookiesText) {
    const parsedCookies = parseCookiesInput(cookiesText, { importExpired });
    if (!parsedCookies.ok) {
      throw new Error(parsedCookies.error || 'Invalid cookies JSON');
    }
    data.cookies = parsedCookies.cookies;
  } else {
    data.cookies = [];
  }

  // Merge fingerprint fields from UI into current fingerprint
  const currentProfile = profiles.find((p) => p.id === selectedProfileId);
  let fp = {};
  try { fp = JSON.parse(currentProfile?.fingerprint || '{}'); } catch { fp = {}; }

  const canvasMode = document.getElementById('editor-canvas-mode')?.value;
  const audioMode = document.getElementById('editor-audio-mode')?.value;
  const fontsMode = document.getElementById('editor-fonts-mode')?.value;
  const webrtcMode = document.getElementById('editor-webrtc-mode')?.value;
  const mediaMode = document.getElementById('editor-media-mode')?.value;
  const geoMode = document.getElementById('editor-geo-mode')?.value;
  const startAction = document.getElementById('editor-start-action')?.value;
  const cpuCores = Number(document.getElementById('editor-cpu-cores')?.value);
  const memoryGb = Number(document.getElementById('editor-memory-gb')?.value);
  const screenW = Number(document.getElementById('editor-screen-w')?.value);
  const screenH = Number(document.getElementById('editor-screen-h')?.value);
  const language = document.getElementById('editor-language')?.value;
  const timezone = document.getElementById('editor-timezone')?.value;

  if (canvasMode) fp = { ...fp, canvas: { ...fp.canvas, mode: canvasMode } };
  if (audioMode) fp = { ...fp, audio: { ...fp.audio, mode: audioMode } };
  if (fontsMode) fp = { ...fp, fonts: { ...fp.fonts, mode: fontsMode } };
  if (webrtcMode) fp = { ...fp, webrtc: { ...fp.webrtc, mode: webrtcMode } };
  if (mediaMode) fp = { ...fp, mediaDevices: { ...fp.mediaDevices, mode: mediaMode } };
  if (geoMode) {
    const geoLat = parseFloat(document.getElementById('editor-geo-lat')?.value);
    const geoLon = parseFloat(document.getElementById('editor-geo-lon')?.value);
    fp = {
      ...fp,
      geo: {
        ...fp.geo,
        mode: geoMode,
        ...(geoMode === 'manual' && Number.isFinite(geoLat) && Number.isFinite(geoLon)
          ? { latitude: geoLat, longitude: geoLon }
          : {}),
      },
    };
  }
  if (startAction) fp = { ...fp, startAction };
  if (Number.isFinite(cpuCores) && cpuCores > 0) fp = { ...fp, hardware: { ...fp.hardware, cpuCores } };
  if (Number.isFinite(memoryGb) && memoryGb > 0) fp = { ...fp, hardware: { ...fp.hardware, memoryGb } };
  if (Number.isFinite(screenW) && screenW > 0) fp = { ...fp, screen: { ...fp.screen, width: screenW } };
  if (Number.isFinite(screenH) && screenH > 0) fp = { ...fp, screen: { ...fp.screen, height: screenH } };
  if (language) fp = { ...fp, locale: { ...fp.locale, language } };
  if (timezone) fp = { ...fp, locale: { ...fp.locale, timezone } };

  // UA / WebGL overrides from Advanced tab
  const customUA = document.getElementById('editor-useragent')?.value?.trim();
  const webglVendor = document.getElementById('editor-webgl-vendor')?.value?.trim();
  const webglRenderer = document.getElementById('editor-webgl-renderer')?.value?.trim();
  if (customUA) fp = { ...fp, userAgent: customUA };
  if (webglVendor) fp = { ...fp, webgl: { ...fp.webgl, vendor: webglVendor } };
  if (webglRenderer) fp = { ...fp, webgl: { ...fp.webgl, renderer: webglRenderer } };

  data.fingerprint = JSON.stringify(fp);
  return data;
}

function applyUpdatedProfileInMemory(updatedProfile) {
  if (!updatedProfile?.id) return;
  profiles = profiles.map((profile) => (profile.id === updatedProfile.id ? updatedProfile : profile));
  const currentSearch = document.getElementById('search-input')?.value || '';
  renderProfilesList(currentSearch);
  if (selectedProfileId === updatedProfile.id) {
    let fp = {};
    try {
      fp = JSON.parse(updatedProfile.fingerprint || '{}');
    } catch {
      fp = {};
    }
    renderProfileInfo(updatedProfile, fp);
  }
}

async function persistSelectedProfile(options = {}) {
  if (!selectedProfileId) return;
  if (autoSaveInFlight) {
    autoSaveQueued = true;
    return;
  }

  autoSaveInFlight = true;
  try {
    const data = collectProfileEditorData();
    const updated = await window.api.updateProfile(selectedProfileId, data);
    applyUpdatedProfileInMemory(updated);
    if (!options.silentSuccess && !options.isAuto) {
      showToast('Profile saved', 'success');
    }
  } catch (err) {
    if (isLoginRequiredError(err)) {
      showLoginModal();
      showToast('Session expired. Login again and retry.', 'error');
      return;
    }
    const message = err?.message || String(err || 'Unknown error');
    if (message.toLowerCase().includes('profile not found')) {
      selectedProfileId = null;
      clearAutoSaveTimer();
      hideEditor();
      await loadData();
      renderProfilesList(document.getElementById('search-input')?.value || '');
      showToast('Profile no longer exists. List refreshed.', 'error');
      return;
    }
    showToast(`Failed to save profile: ${message}`, 'error');
    if (!options.isAuto) throw err;
  } finally {
    autoSaveInFlight = false;
    if (autoSaveQueued) {
      autoSaveQueued = false;
      scheduleAutoSave(150);
    }
  }
}

async function createNewProfile() {
  try {
    const platformDefaults = {
      instagram: { start_page: 'https://www.instagram.com' },
      linkedin:  { start_page: 'https://www.linkedin.com' },
      facebook:  { start_page: 'https://www.facebook.com' },
    };
    const defaults = platformDefaults[activePlatformTab] || {};

    const profile = await window.api.createProfile({
      name: `Profile ${profiles.length + 1}`,
      start_page: defaults.start_page,
      tags: defaults.tags || []
    });
    await loadData();
    renderProfilesList();
    selectProfile(profile.id);
    showToast('Profile created', 'success');
  } catch (err) {
    if (isLoginRequiredError(err)) {
      showLoginModal();
      showToast('Session expired. Login again and retry.', 'error');
      return;
    }
    const message = err?.message || 'Failed to create profile';
    showToast(message, 'error');
  }
}

async function saveProfile() {
  if (!selectedProfileId) return;
  
  try {
    await persistSelectedProfile({ silentSuccess: false });
  } catch (err) {
    if (isLoginRequiredError(err)) {
      showLoginModal();
      showToast('Session expired. Login again and retry.', 'error');
      return;
    }
    const message = err?.message || String(err || 'Unknown error');
    showToast(`Failed to save profile: ${message}`, 'error');
  }
}

async function deleteProfile(id) {
  try {
    if (selectedProfileId === id) clearAutoSaveTimer();
    const result = await window.api.deleteProfile(id);
    if (!result?.success) {
      showToast(result?.error || 'Failed to delete profile', 'error');
      return;
    }
    if (selectedProfileId === id) {
      selectedProfileId = null;
      hideEditor();
    }
    await loadData();
    renderProfilesList();
    showToast('Profile deleted', 'success');
  } catch (err) {
    if (isLoginRequiredError(err)) {
      showLoginModal();
      showToast('Session expired. Login again and retry.', 'error');
      return;
    }
    const message = err?.message || 'Failed to delete profile';
    showToast(message, 'error');
  }
}

function confirmDeleteProfile(id) {
  const profile = profiles.find((p) => p.id === id);
  const isRunning = runningProfiles.has(id);
  const name = profile?.name || `Profile ${id}`;
  const warn = isRunning
    ? `Profile "${name}" is running and will be stopped. Delete permanently?`
    : `Delete profile "${name}" permanently?`;
  if (!window.confirm(warn)) return;
  void deleteProfile(id);
}

async function syncProfileLocaleFromProxy(profileId, options = {}) {
  try {
    const result = await window.api.syncProfileLocaleFromProxy(profileId);
    if (!result?.success) return result;
    if (!options.silentSuccess) {
      const c = result?.proxy?.countryCode || '';
      const l = result?.proxy?.language || '';
      const f = result?.proxy?.flag || '';
      showToast(`Locale synced from proxy: ${f} ${c} ${l}`.trim(), 'success');
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message || 'Locale sync failed' };
  }
}

// ===== PROFILE LAUNCH =====
async function launchProfile(id) {
  try {
    const result = await window.api.launchProfile(id);
    if (result.success) {
      showToast('Profile launched', 'success');
    } else {
      showToast(result.error || 'Launch failed', 'error');
    }
  } catch (err) {
    showToast('Failed to launch: ' + err.message, 'error');
  }
}

async function stopProfile(id) {
  try {
    const result = await window.api.stopProfile(id);
    if (result.success) {
      showToast('Profile stopped', 'success');
    } else {
      showToast(result.error || 'Stop failed', 'error');
    }
  } catch (err) {
    showToast('Failed to stop: ' + err.message, 'error');
  }
}

// ===== GEO HELPERS =====
function toggleGeoManualFields(mode) {
  const fields = document.getElementById('geo-manual-fields');
  if (!fields) return;
  if (mode === 'manual') {
    fields.classList.remove('hidden');
  } else {
    fields.classList.add('hidden');
  }
}

// ===== COOKIES FILE READER =====
function readCookiesFile(file) {
  if (!file) return;
  const isJson = file.name.endsWith('.json') || file.name.endsWith('.txt') || file.type === 'application/json' || file.type === 'text/plain';
  if (!isJson && file.size > 5 * 1024 * 1024) {
    showToast('File too large or unsupported format', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const textarea = document.getElementById('cookies-textarea');
    const content = document.querySelector('.cookies-dropzone-content');
    if (!textarea) return;
    textarea.value = text;
    textarea.style.display = 'block';
    if (content) content.style.display = 'none';
    // Validate immediately
    const importExpired = Boolean(document.getElementById('editor-import-expired')?.checked);
    const result = parseCookiesInput(text, { importExpired });
    if (!result.ok) {
      showToast('Invalid cookies file: ' + result.error, 'error');
    } else {
      showToast(`${result.cookies.length} cookie${result.cookies.length !== 1 ? 's' : ''} loaded from file`, 'success');
      scheduleAutoSave(300);
    }
  };
  reader.onerror = () => showToast('Failed to read file', 'error');
  reader.readAsText(file);
}

// ===== CLIPBOARD HELPERS =====
async function importProxyFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const trimmed = (text || '').trim();
    if (!trimmed) {
      showToast('Clipboard is empty', 'error');
      return;
    }
    document.getElementById('editor-proxy-value').value = trimmed;
    showToast('Proxy pasted from clipboard', 'success');
  } catch (err) {
    showToast('Could not read clipboard: ' + (err.message || 'permission denied'), 'error');
  }
}

async function copyProfileName() {
  const name = document.getElementById('editor-profile-name')?.value;
  if (!name) return;
  try {
    await navigator.clipboard.writeText(name);
    showToast('Profile name copied', 'success');
  } catch (err) {
    showToast('Could not copy: ' + err.message, 'error');
  }
}

async function copyProfileInfo() {
  if (!selectedProfileId) return;
  const profile = profiles.find((p) => p.id === selectedProfileId);
  if (!profile) return;
  let fp = {};
  try { fp = JSON.parse(profile.fingerprint || '{}'); } catch { fp = {}; }

  const lines = [
    `Profile: ${profile.name}`,
    `OS: ${fp.osName || '—'}`,
    `Browser: ${fp.browserName || '—'} ${fp.browserVersion || ''}`.trim(),
    `Language: ${fp.locale?.language || '—'}`,
    `Timezone: ${fp.locale?.timezone || '—'}`,
    `Screen: ${fp.screen?.width || '?'}×${fp.screen?.height || '?'}`,
    `CPU: ${fp.hardware?.cpuCores || '—'} cores`,
    `Memory: ${fp.hardware?.memoryGb || '—'} GB`,
    `WebRTC: ${fp.webrtc?.mode || 'disabled'}`,
    `Canvas: ${fp.canvas?.mode || 'noise'}`,
    `Audio: ${fp.audio?.mode || 'noise'}`,
    `Geolocation: ${fp.geo?.mode || 'auto'}`,
    `User-Agent: ${fp.userAgent || '—'}`,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(lines);
    showToast('Profile info copied', 'success');
  } catch (err) {
    showToast('Could not copy: ' + err.message, 'error');
  }
}

// ===== SORT & FILTER =====
let currentSortKey = 'modified_at';
let currentSortDir = 'desc';
let activeFilter = null;

const SORT_OPTIONS = [
  { key: 'modified_at', dir: 'desc', label: 'Last modified' },
  { key: 'created_at', dir: 'desc', label: 'Date created' },
  { key: 'name', dir: 'asc', label: 'Name A–Z' },
  { key: 'name', dir: 'desc', label: 'Name Z–A' },
];

const FILTER_OPTIONS = [
  { key: null, label: 'All profiles' },
  { key: 'running', label: 'Running' },
  { key: 'has_proxy', label: 'With proxy' },
  { key: 'no_proxy', label: 'Without proxy' },
];

function closeAllMenus() {
  document.getElementById('sort-menu')?.remove();
  document.getElementById('filter-menu')?.remove();
}

function toggleSortMenu() {
  if (document.getElementById('sort-menu')) { closeAllMenus(); return; }
  closeAllMenus();
  const btn = document.getElementById('btn-sort');
  const menu = document.createElement('div');
  menu.id = 'sort-menu';
  menu.className = 'dropdown-menu';
  menu.innerHTML = SORT_OPTIONS.map((opt, i) => {
    const isActive = opt.key === currentSortKey && opt.dir === currentSortDir;
    return `<button class="dropdown-item${isActive ? ' active' : ''}" data-sort-idx="${i}">${isActive ? '✓ ' : ''}${opt.label}</button>`;
  }).join('');
  menu.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const opt = SORT_OPTIONS[Number(item.dataset.sortIdx)];
      currentSortKey = opt.key;
      currentSortDir = opt.dir;
      closeAllMenus();
      renderProfilesList(document.getElementById('search-input')?.value || '');
    });
  });
  positionMenuUnderBtn(menu, btn);
  document.addEventListener('click', closeAllMenus, { once: true, capture: true });
}

function toggleFilterMenu() {
  if (document.getElementById('filter-menu')) { closeAllMenus(); return; }
  closeAllMenus();
  const btn = document.getElementById('btn-filter');
  const menu = document.createElement('div');
  menu.id = 'filter-menu';
  menu.className = 'dropdown-menu';
  menu.innerHTML = FILTER_OPTIONS.map((opt, i) => {
    const isActive = opt.key === activeFilter;
    return `<button class="dropdown-item${isActive ? ' active' : ''}" data-filter-idx="${i}">${isActive ? '✓ ' : ''}${opt.label}</button>`;
  }).join('');
  menu.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const opt = FILTER_OPTIONS[Number(item.dataset.filterIdx)];
      activeFilter = opt.key;
      closeAllMenus();
      updateFilterBtnState();
      renderProfilesList(document.getElementById('search-input')?.value || '');
    });
  });
  positionMenuUnderBtn(menu, btn);
  document.addEventListener('click', closeAllMenus, { once: true, capture: true });
}

function updateFilterBtnState() {
  const btn = document.getElementById('btn-filter');
  if (!btn) return;
  btn.classList.toggle('active', activeFilter !== null);
}

function positionMenuUnderBtn(menu, btn) {
  const rect = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${rect.left}px`;
  document.body.appendChild(menu);
}

// ===== PROXY =====
async function saveProxy() {
  const proxyValue = document.getElementById('editor-proxy-value').value;
  if (!proxyValue) {
    showToast('Enter proxy value (host:port:user:pass)', 'error');
    return;
  }

  const parts = proxyValue.split(':');
  const proxyData = {
    type: document.getElementById('editor-proxy-type').value,
    host: parts[0] || '',
    port: parseInt(parts[1]) || 0,
    username: parts[2] || '',
    password: parts[3] || '',
    name: document.getElementById('editor-proxy-name').value || parts[0],
    ip_change_link: document.getElementById('editor-proxy-change-link').value,
  };

  try {
    const proxy = await window.api.createProxy(proxyData);
    // Link to current profile
    if (selectedProfileId) {
      await window.api.updateProfile(selectedProfileId, { proxy_id: proxy.id });
    }
    await loadData();
    populateProxySelect(proxy.id);
    // Reload profile to show updated proxy
    if (selectedProfileId) {
      loadProfileEditor(selectedProfileId);
    }
    showToast('Proxy saved & linked to profile ✓', 'success');
  } catch (err) {
    showToast('Failed to save proxy: ' + err.message, 'error');
  }
}

async function checkCurrentProxy() {
  const proxyValue = document.getElementById('editor-proxy-value').value;
  if (!proxyValue) {
    showToast('Enter proxy value first', 'error');
    return;
  }

  const parts = proxyValue.split(':');
  const proxyData = {
    type: document.getElementById('editor-proxy-type').value,
    host: parts[0] || '',
    port: parseInt(parts[1]) || 0,
    username: parts[2] || '',
    password: parts[3] || '',
  };

  const checkBtn = document.getElementById('btn-check-proxy');
  checkBtn.innerHTML = '<span class="spinner"></span>';
  checkBtn.disabled = true;

  try {
    const result = await window.api.checkProxy(proxyData);
    if (result.success) {
      const countryPart = result.countryCode ? ` ${result.flag || ''} ${result.countryCode}` : '';
      const langPart = result.language ? ` ${result.language}` : '';
      showToast(`✅ Proxy OK! IP: ${result.ip}${countryPart}${langPart}`, 'success');
    } else {
      showToast(`❌ Proxy check failed: ${result.error}`, 'error');
    }
  } catch (err) {
    showToast('Proxy check error: ' + err.message, 'error');
  } finally {
    checkBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`;
    checkBtn.disabled = false;
  }
}

// ===== RENDERING =====
function renderProfilesList(searchTerm = '') {
  const list = document.getElementById('profiles-list');
  const emptyState = document.getElementById('empty-state');
  const countEl = document.getElementById('search-count');
  
  let filtered = profiles;

  // Apply search
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(term));
  }

  // Apply filter
  if (activeFilter === 'running') {
    filtered = filtered.filter((p) => runningProfiles.has(p.id));
  } else if (activeFilter === 'has_proxy') {
    filtered = filtered.filter((p) => Boolean(p.proxy_host));
  } else if (activeFilter === 'no_proxy') {
    filtered = filtered.filter((p) => !p.proxy_host);
  }

  if (activePlatformTab !== 'all') {
    filtered = filtered.filter((p) => getProfilePlatform(p) === activePlatformTab);
  }

  // Apply sort
  filtered = [...filtered].sort((a, b) => {
    let aVal = a[currentSortKey] || '';
    let bVal = b[currentSortKey] || '';
    if (currentSortKey === 'name') {
      aVal = aVal.toLowerCase();
      bVal = bVal.toLowerCase();
    }
    if (aVal < bVal) return currentSortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return currentSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  countEl.textContent = filtered.length;

  if (profiles.length === 0) {
    list.innerHTML = '';
    emptyState.classList.add('visible');
    document.querySelector('.profiles-layout').style.display = 'none';
    return;
  }

  emptyState.classList.remove('visible');
  document.querySelector('.profiles-layout').style.display = 'flex';

  list.innerHTML = filtered.map(p => {
    let fp = {};
    try { fp = JSON.parse(p.fingerprint || '{}'); } catch { fp = {}; }
    const isActive = p.id === selectedProfileId;
    const isRunning = runningProfiles.has(p.id);
    const time = formatTime(p.modified_at);
    const systemLabel = getProfileSystemLabel(fp);
    const countryFlag = fp.locale?.flag || '';
    const countryCode = fp.locale?.country || '';
    const hasProxy = !!(p.proxy_host);
    
    return `
      <div class="profile-item ${isActive ? 'active' : ''}" data-id="${p.id}" onclick="selectProfile(${p.id})">
        <div class="profile-item-header">
          <span class="profile-item-name">${escapeHtml(p.name)}</span>
          <span class="profile-item-time">${time}</span>
          <div class="profile-item-actions">
            <button class="profile-delete-btn"
                    onclick="event.stopPropagation(); confirmDeleteProfile(${p.id})"
                    title="Delete profile">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
            <button class="profile-launch-btn ${isRunning ? 'running' : ''}" 
                    onclick="event.stopPropagation(); ${isRunning ? `stopProfile(${p.id})` : `launchProfile(${p.id})`}" 
                    title="${isRunning ? 'Stop' : 'Launch'}">
              ${isRunning 
                ? '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' 
                : '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>'}
            </button>
          </div>
        </div>
        <div class="profile-item-meta">
          <div class="profile-item-badges">
            <span class="badge badge-os" title="${escapeHtml(systemLabel)}">${getOsBadgeMarkup(fp)}</span>
            ${countryFlag ? `<span class="badge badge-country" title="${countryCode}">${countryFlag}</span>` : ''}
            ${hasProxy ? `<span class="badge badge-proxy" title="Proxy active">⇄</span>` : ''}
          </div>
          <span class="profile-item-country">${p.created_by ? escapeHtml(p.created_by) : (countryCode || '')}</span>
          ${isRunning ? '<span class="badge badge-status running">Running</span>' : ''}
        </div>
        <span class="profile-item-engine">Chromium</span>
      </div>
    `;
  }).join('');
}

function selectProfile(id) {
  selectedProfileId = id;
  clearAutoSaveTimer();
  renderProfilesList();
  loadProfileEditor(id);
}

async function backfillProxyLocaleForExistingProfiles() {
  if (proxyLocaleBackfillRunning) return;
  proxyLocaleBackfillRunning = true;
  try {
    const candidates = profiles.filter((p) => {
      let fp = {};
      try {
        fp = JSON.parse(p.fingerprint || '{}');
      } catch {
        fp = {};
      }
      const hasCountry = Boolean(fp?.locale?.country);
      const hasFlag = Boolean(fp?.locale?.flag);
      const language = String(fp?.locale?.language || '').toLowerCase();
      const isEnglish = language.startsWith('en');
      return !hasCountry || !hasFlag || !isEnglish;
    });
    if (!candidates.length) return;

    let changed = false;
    for (const profile of candidates) {
      try {
        const res = await window.api.syncProfileLocaleFromProxy(profile.id);
        if (res?.success) changed = true;
      } catch {
        // Silent backfill
      }
    }

    if (changed) {
      await loadData();
      renderProfilesList(document.getElementById('search-input')?.value || '');
      if (selectedProfileId) {
        await loadProfileEditor(selectedProfileId);
      }
    }
  } finally {
    proxyLocaleBackfillRunning = false;
  }
}

async function loadProfileEditor(id) {
  let profile;
  try {
    profile = await window.api.getProfile(id);
  } catch (err) {
    if (isLoginRequiredError(err)) { showLoginModal(); return; }
    showToast('Failed to load profile: ' + (err.message || 'unknown error'), 'error');
    return;
  }
  if (!profile) {
    showToast('Profile not found', 'error');
    selectedProfileId = null;
    hideEditor();
    await loadData();
    renderProfilesList(document.getElementById('search-input')?.value || '');
    return;
  }

  let fp = {};
  try {
    fp = JSON.parse(profile.fingerprint || '{}');
  } catch {
    fp = {};
  }
  
  document.getElementById('profile-editor').style.display = '';
  document.getElementById('profile-info').style.display = '';

  suppressAutoSave = true;
  try {
    // Populate fields
    document.getElementById('editor-profile-name').value = profile.name;
    document.getElementById('editor-start-page').value = profile.start_page || 'https://whoer.net';
    const warmupEl = document.getElementById('editor-warmup-url');
    if (warmupEl) warmupEl.value = profile.warmup_url || '';
    document.getElementById('editor-tags').value = formatTagsInput(profile.tags);
    populateTagSuggestions();
    const createdByEl = document.getElementById('editor-created-by');
    if (createdByEl) createdByEl.value = profile.created_by || '';
    
    populateFolderSelect(profile.folder_id);
    populateGroupSelect(profile.group_id);
    populateProxySelect(profile.proxy_id);

    // Platform selector
    const platformEl = document.getElementById('editor-platform');
    if (platformEl) platformEl.value = getProfilePlatform(profile) === 'other' ? 'other' : getProfilePlatform(profile);

    // Proxy fields
    if (profile.proxy_host) {
      document.getElementById('editor-proxy-type').value = profile.proxy_type || 'http';
      let proxyStr = profile.proxy_host;
      if (profile.proxy_port) proxyStr += ':' + profile.proxy_port;
      if (profile.proxy_username) proxyStr += ':' + profile.proxy_username;
      if (profile.proxy_password) proxyStr += ':' + profile.proxy_password;
      document.getElementById('editor-proxy-value').value = proxyStr;
      document.getElementById('editor-proxy-name').value = profile.proxy_name || '';
    } else {
      document.getElementById('editor-proxy-value').value = '';
      document.getElementById('editor-proxy-name').value = '';
    }

    // Cookies — reset dropzone state and populate
    const cookies = profile.cookies || '[]';
    const cookiesJson = cookies !== '[]' ? cookies : '';
    const cookiesTextarea = document.getElementById('cookies-textarea');
    const cookiesDropzoneContent = document.querySelector('.cookies-dropzone-content');
    if (cookiesTextarea) cookiesTextarea.value = cookiesJson;
    if (cookiesJson) {
      if (cookiesTextarea) cookiesTextarea.style.display = 'block';
      if (cookiesDropzoneContent) cookiesDropzoneContent.style.display = 'none';
    } else {
      if (cookiesTextarea) cookiesTextarea.style.display = 'none';
      if (cookiesDropzoneContent) cookiesDropzoneContent.style.display = '';
    }

    // Advanced tab
    document.getElementById('editor-useragent').value = fp.userAgent || '';
    document.getElementById('editor-webgl-vendor').value = fp.webgl?.vendor || '';
    document.getElementById('editor-webgl-renderer').value = fp.webgl?.renderer || '';

    // Hardware tab
    document.getElementById('editor-cpu-cores').value = fp.hardware?.cpuCores || 4;
    document.getElementById('editor-memory-gb').value = fp.hardware?.memoryGb || 8;
    document.getElementById('editor-screen-w').value = fp.screen?.width || 1920;
    document.getElementById('editor-screen-h').value = fp.screen?.height || 1080;
    document.getElementById('editor-language').value = fp.locale?.language || 'en-US';
    document.getElementById('editor-timezone').value = fp.locale?.timezone || 'America/New_York';

    // Fingerprint mode selects (were never populated — changes appeared to work but reset on reopen)
    document.getElementById('editor-canvas-mode').value = fp.canvas?.mode || 'noise';
    document.getElementById('editor-audio-mode').value = fp.audio?.mode || 'noise';
    document.getElementById('editor-fonts-mode').value = fp.fonts?.mode || 'emulate';
    document.getElementById('editor-webrtc-mode').value = fp.webrtc?.mode || 'disabled';
    document.getElementById('editor-media-mode').value = fp.mediaDevices?.mode || 'emulate';
    const geoMode = fp.geo?.mode || 'auto';
    document.getElementById('editor-geo-mode').value = geoMode;
    document.getElementById('editor-geo-lat').value = fp.geo?.latitude ?? '';
    document.getElementById('editor-geo-lon').value = fp.geo?.longitude ?? '';
    toggleGeoManualFields(geoMode);
    document.getElementById('editor-start-action').value = fp.startAction || 'open-page';

    // Notes
    document.getElementById('profile-notes').value = profile.notes || '';
  } finally {
    suppressAutoSave = false;
  }

  // Update open button
  const openBtn = document.getElementById('btn-open-profile');
  if (runningProfiles.has(id)) {
    openBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> Stop`;
    openBtn.style.background = 'linear-gradient(135deg, #f44336, #d32f2f)';
    openBtn.style.boxShadow = '0 2px 12px rgba(244, 67, 54, 0.3)';
  } else {
    openBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><circle cx="12" cy="12" r="10"/></svg> Open`;
    openBtn.style.background = '';
    openBtn.style.boxShadow = '';
  }

  renderProfileInfo(profile, fp);
}

function renderProfileInfo(profile, fp) {
  const grid = document.getElementById('info-grid');
  const tagsText = formatTagsInput(profile.tags);
  const created = new Date(profile.created_at + 'Z').toLocaleString('uk-UA', { 
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  });
  const modified = new Date(profile.modified_at + 'Z').toLocaleString('uk-UA', { 
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  });

  grid.innerHTML = `
    <span class="info-label">Date Created:</span>
    <span class="info-value">${created}</span>
    
    <span class="info-label">Date Modified:</span>
    <span class="info-value">${modified}</span>
    
    <span class="info-label">Tags:</span>
    <span class="info-value">${tagsText ? escapeHtml(tagsText) : '<span class="text-muted">—</span>'}</span>
    
    <span class="info-label">OS:</span>
    <span class="info-value">${fp.osName || '—'}</span>
    
    <span class="info-label">Browser:</span>
    <span class="info-value">${fp.browserName || '—'} ${fp.browserVersion || ''}</span>
    
    <span class="info-label">CPU cores:</span>
    <span class="info-value">${fp.hardware?.cpuCores || '—'}</span>
    
    <span class="info-label">Memory GB:</span>
    <span class="info-value">${fp.hardware?.memoryGb || '—'}</span>
    
    <span class="info-label">WebRTC:</span>
    <span class="info-value">${fp.webrtc?.mode === 'disabled' ? 'Disabled' : fp.webrtc?.mode === 'fake' ? 'Fake' : 'Auto'}</span>
    
    <span class="info-label">Geolocation:</span>
    <span class="info-value">${fp.geo?.mode === 'block' ? 'Block' : fp.geo?.mode === 'manual' ? 'Manual' : 'Auto'}</span>

    <span class="info-label">TimeZone:</span>
    <span class="info-value">${fp.locale?.timezone || 'Auto'}</span>
    
    <span class="info-label">Language:</span>
    <span class="info-value">${fp.locale?.language || '—'} ${fp.locale?.flag || ''}</span>
    
    <span class="info-label">Country:</span>
    <span class="info-value">${fp.locale?.flag || ''} ${fp.locale?.country || '—'}</span>
    
    <span class="info-label">Media Devices:</span>
    <span class="info-value">${fp.mediaDevices?.mode === 'emulate' ? 'Emulate' : 'System'}</span>
    
    <span class="info-label">Window size:</span>
    <span class="info-value">${fp.windowSize?.mode === 'emulate' ? 'Emulate' : 'Real'}</span>
    
    <span class="info-label">Screen:</span>
    <span class="info-value">${fp.screen?.width || '?'}×${fp.screen?.height || '?'}</span>
    
    <span class="info-label">Fonts:</span>
    <span class="info-value">Emulate</span>
    
    <span class="info-label">Speech:</span>
    <span class="info-value">${fp.speech?.mode === 'emulate' ? 'Emulate' : 'System'}</span>
    
    <span class="info-label">Canvas:</span>
    <span class="info-value">${fp.canvas?.mode === 'noise' ? 'Noise' : 'System'}</span>
    
    <span class="info-label">Audio:</span>
    <span class="info-value">${fp.audio?.mode === 'noise' ? 'Noise' : 'System'}</span>
    
    <span class="info-label">WebGL:</span>
    <span class="info-value">${fp.webgl?.renderer ? truncate(fp.webgl.renderer, 45) : 'System'}</span>
    
    <span class="info-label">WebGL image:</span>
    <span class="info-value">${fp.webglImage?.mode === 'noise' ? 'Noise' : 'System'}</span>
    
    <span class="info-label">WebGPU:</span>
    <span class="info-value">${fp.webgpu?.mode === 'mask' ? 'Mask' : 'System'}</span>

    <span class="info-label">ClientRects:</span>
    <span class="info-value">${fp.clientRects?.mode === 'noise' ? 'Noise' : 'System'}</span>
    
    <span class="info-label">Platform:</span>
    <span class="info-value">${fp.platform || '—'}</span>
    
    <span class="info-label">User-Agent:</span>
    <span class="info-value info-value-small">${truncate(fp.userAgent || '—', 60)}</span>
    
    <span class="info-label">Start page:</span>
    <span class="info-value accent">${profile.start_page || 'https://whoer.net'}</span>
    
    <span class="info-label">At profile start:</span>
    <span class="info-value">${{ 'open-page': 'Open start page', 'continue-session': 'Continue session', 'new-tab': 'New tab' }[fp.startAction] || 'Open start page'}</span>
  `;
}

function hideEditor() {
  clearAutoSaveTimer();
  document.getElementById('profile-editor').style.display = 'none';
  document.getElementById('profile-info').style.display = 'none';
}

// ===== SELECT POPULATORS =====
function populateFolderSelect(selectedId) {
  const select = document.getElementById('editor-folder');
  select.innerHTML = folders.map(f =>
    `<option value="${f.id}" ${Number(f.id) === Number(selectedId) ? 'selected' : ''}>${escapeHtml(f.name)}</option>`
  ).join('');
}

function populateGroupSelect(selectedId) {
  const select = document.getElementById('editor-group');
  select.innerHTML = groups.map(g =>
    `<option value="${g.id}" ${Number(g.id) === Number(selectedId) ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
  ).join('');
}

function populateProxySelect(selectedId) {
  const select = document.getElementById('editor-proxy-select');
  select.innerHTML = '<option value="">New Proxy</option>' +
    proxies.map(p =>
      `<option value="${p.id}" ${Number(p.id) === Number(selectedId) ? 'selected' : ''}>${escapeHtml(p.name || p.host || 'Proxy ' + p.id)}</option>`
    ).join('');
}

// ===== ACCOUNT =====
async function refreshAccountPage() {
  try {
    await loadAccountStateUI();
  } catch (err) {
    console.error('Failed to refresh account page:', err);
  }
}

async function refreshSettingsPage() {
  try {
    const version = await window.api.getAppVersion();
    const versionEl = document.getElementById('settings-version');
    if (versionEl && version) versionEl.textContent = String(version).startsWith('v') ? version : `v${version}`;
    syncPlatformControls();
    const state = accountState || await window.api.getAccountState();
    const emailEl = document.getElementById('settings-account-email');
    if (emailEl) emailEl.textContent = state?.email || state?.displayName || 'Not logged in';
    const logoutBtn = document.getElementById('btn-settings-logout');
    if (logoutBtn) logoutBtn.disabled = !state?.isLoggedIn;
  } catch (err) {
    console.error('Failed to refresh settings page:', err);
  }
}

function setAccountBusy(isBusy) {
  const loginBtn = document.getElementById('btn-account-login');
  const logoutBtn = document.getElementById('btn-account-logout');

  if (loginBtn) loginBtn.disabled = isBusy;
  if (logoutBtn) logoutBtn.disabled = isBusy;
  const modalLoginBtn = document.getElementById('btn-modal-login');
  if (modalLoginBtn) modalLoginBtn.disabled = isBusy;
  const updateInstallBtn = document.getElementById('btn-update-lock-install');
  if (updateInstallBtn) updateInstallBtn.disabled = isBusy;
  const updateRestartBtn = document.getElementById('btn-update-lock-restart');
  if (updateRestartBtn) updateRestartBtn.disabled = isBusy;
}

function setMandatoryUpdateButtonsBusy(isBusy) {
  const updateInstallBtn = document.getElementById('btn-update-lock-install');
  if (updateInstallBtn) updateInstallBtn.disabled = isBusy;
  const updateRestartBtn = document.getElementById('btn-update-lock-restart');
  if (updateRestartBtn) updateRestartBtn.disabled = isBusy;
  const updateExitBtn = document.getElementById('btn-update-lock-exit');
  if (updateExitBtn) updateExitBtn.disabled = isBusy;
}

async function loadAccountStateUI() {
  accountState = await window.api.getAccountState();
  renderAccountState(accountState);
}

function renderAccountState(state) {
  const metaEl = document.getElementById('account-meta');
  if (!metaEl) return;

  const isLoggedIn = Boolean(state?.isLoggedIn);
  const name = state?.displayName ? escapeHtml(state.displayName) : '—';
  const email = state?.email ? escapeHtml(state.email) : '—';
  metaEl.innerHTML = `
    <div><strong>Name:</strong> ${name}</div>
    <div><strong>Email:</strong> ${email}</div>
  `;

  const logoutBtn = document.getElementById('btn-account-logout');
  if (logoutBtn) logoutBtn.disabled = !isLoggedIn;
}

async function loginAccount() {
  setLoginModalError('');
  setAccountBusy(true);
  try {
    accountState = await window.api.loginAccount({ mode: 'web' });
    renderAccountState(accountState);
    await loadData();
    renderProfilesList();
    void runProfileCloudSync({ silent: true });
    hideLoginModal();
    showToast('Login successful', 'success');
  } catch (err) {
    const msg = err.message || 'Login failed';
    setLoginModalError(msg);
    showToast(msg, 'error');
  } finally {
    setAccountBusy(false);
  }
}

async function loginFromModal() {
  setLoginModalError('');
  setAccountBusy(true);
  try {
    accountState = await window.api.loginAccount({ mode: 'web' });
    renderAccountState(accountState);
    await loadData();
    renderProfilesList();
    void runProfileCloudSync({ silent: true });
    hideLoginModal();
    showToast('Login successful', 'success');
  } catch (err) {
    const msg = err.message || 'Login failed';
    setLoginModalError(msg);
    showToast(msg, 'error');
  } finally {
    setAccountBusy(false);
  }
}

async function logoutAccount() {
  setAccountBusy(true);
  try {
    accountState = await window.api.logoutAccount({ clearSaved: false });
    renderAccountState(accountState);
    profiles = [];
    proxies = [];
    folders = [];
    groups = [];
    selectedProfileId = null;
    clearAutoSaveTimer();
    runningProfiles = new Set();
    hideEditor();
    renderProfilesList();
    showLoginModal();
    showToast('Logged out', 'success');
  } catch (err) {
    showToast(err.message || 'Logout failed', 'error');
  } finally {
    setAccountBusy(false);
  }
}

function showLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.classList.remove('hidden');
}

function hideLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.classList.add('hidden');
  setLoginModalError('');
}

function setLoginModalError(message) {
  const errorEl = document.getElementById('login-modal-error');
  if (!errorEl) return;
  const msg = String(message || '').trim();
  if (!msg) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
    return;
  }
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

async function maybeShowLoginModal() {
  if (mandatoryUpdateRequired) {
    hideLoginModal();
    return false;
  }

  try {
    const state = await window.api.getAccountState();
    if (state?.isLoggedIn) {
      hideLoginModal();
      return true;
    }
    showLoginModal();
    return false;
  } catch (err) {
    console.error('Failed to check account state for modal:', err);
    showLoginModal();
    return false;
  }
}

function handleUpdateStatus(data) {
  if (!data || !data.state) return;

  if (data.state === 'required') {
    showMandatoryUpdateModal(data);
    return;
  }

  if (data.state === 'mandatory_downloading') {
    mandatoryUpdateFlow.downloading = true;
    mandatoryUpdateFlow.downloaded = false;
    mandatoryUpdateFlow.error = '';
    mandatoryUpdateFlow.progress = Number(data.percent || 0);
    mandatoryUpdateFlow.downloadedBytes = Number(data.downloadedBytes || 0);
    mandatoryUpdateFlow.totalBytes = Number(data.totalBytes || 0);
    if (data.version) mandatoryUpdateFlow.version = data.version;
    renderMandatoryUpdateUi();
    return;
  }

  if (data.state === 'mandatory_downloaded') {
    mandatoryUpdateFlow.downloading = false;
    mandatoryUpdateFlow.downloaded = true;
    mandatoryUpdateFlow.error = '';
    mandatoryUpdateFlow.progress = 100;
    mandatoryUpdateFlow.downloadedBytes = Number(data.downloadedBytes || 0);
    mandatoryUpdateFlow.totalBytes = Number(data.totalBytes || 0);
    if (data.version) mandatoryUpdateFlow.version = data.version;
    renderMandatoryUpdateUi();
    return;
  }

  if (data.state === 'mandatory_download_error') {
    mandatoryUpdateFlow.downloading = false;
    mandatoryUpdateFlow.downloaded = false;
    mandatoryUpdateFlow.error = data.message || 'Failed to download update.';
    renderMandatoryUpdateUi();
    return;
  }

  if (data.state === 'mandatory_download_retry') {
    mandatoryUpdateFlow.downloading = true;
    mandatoryUpdateFlow.error = data.message || '';
    renderMandatoryUpdateUi();
    return;
  }

  if (data.state === 'mandatory_installer_opened') {
    mandatoryUpdateFlow.installerOpened = true;
    mandatoryUpdateFlow.error = '';
    renderMandatoryUpdateUi();
    return;
  }

  if (data.state === 'available' && data.version) {
    showMandatoryUpdateModal({
      version: data.version,
      currentVersion: null
    });
    return;
  }
}

function showMandatoryUpdateModal(data = {}) {
  mandatoryUpdateRequired = true;
  hideLoginModal();

  mandatoryUpdateFlow = {
    version: data?.version || mandatoryUpdateFlow.version || null,
    currentVersion: data?.currentVersion || mandatoryUpdateFlow.currentVersion || null,
    downloading: false,
    downloaded: Boolean(data?.downloaded || data?.localFilePath || mandatoryUpdateFlow.downloaded),
    progress: Number(data?.downloaded ? 100 : mandatoryUpdateFlow.progress || 0),
    downloadedBytes: Number(mandatoryUpdateFlow.downloadedBytes || 0),
    totalBytes: Number(mandatoryUpdateFlow.totalBytes || 0),
    error: '',
    installerOpened: false,
  };

  const modal = document.getElementById('update-lock-modal');
  const text = document.getElementById('update-lock-text');
  const versionEl = document.getElementById('update-lock-version');
  if (text) {
    text.textContent = 'A new version is available. Update to continue using Anty Browser.';
  }
  if (versionEl) {
    const nextVersion = mandatoryUpdateFlow.version ? `v${mandatoryUpdateFlow.version}` : '';
    const currentVersion = mandatoryUpdateFlow.currentVersion ? `v${mandatoryUpdateFlow.currentVersion}` : '';
    if (nextVersion) {
      versionEl.textContent = currentVersion ? `${currentVersion} → ${nextVersion}` : nextVersion;
      versionEl.classList.remove('hidden');
    } else {
      versionEl.classList.add('hidden');
    }
  }
  if (modal) modal.classList.remove('hidden');
  renderMandatoryUpdateUi();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let current = value;
  let idx = 0;
  while (current >= 1024 && idx < units.length - 1) {
    current /= 1024;
    idx += 1;
  }
  return `${current.toFixed(current >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function renderMandatoryUpdateUi() {
  const primaryBtn = document.getElementById('btn-update-lock-install');
  const restartBtn = document.getElementById('btn-update-lock-restart');
  const statusEl = document.getElementById('update-lock-substatus');
  const progressEl = document.getElementById('update-lock-progress');
  const progressFillEl = document.getElementById('update-lock-progress-fill');
  const progressPctEl = document.getElementById('update-lock-progress-pct');
  if (!primaryBtn || !restartBtn || !statusEl || !progressEl || !progressFillEl) return;

  if (mandatoryUpdateFlow.downloading) {
    const pct = Math.min(100, Math.max(0, Number(mandatoryUpdateFlow.progress || 0)));
    primaryBtn.textContent = 'Downloading...';
    primaryBtn.disabled = true;
    restartBtn.classList.add('hidden');
    if (mandatoryUpdateFlow.error) {
      statusEl.textContent = `${mandatoryUpdateFlow.error} Retrying...`;
    } else {
      const dl = formatBytes(mandatoryUpdateFlow.downloadedBytes);
      const total = formatBytes(mandatoryUpdateFlow.totalBytes);
      statusEl.textContent = mandatoryUpdateFlow.totalBytes > 0
        ? `${dl} of ${total}`
        : dl;
    }
    progressEl.classList.remove('hidden');
    progressFillEl.style.width = `${pct}%`;
    if (progressPctEl) progressPctEl.textContent = `${pct.toFixed(0)}%`;
    return;
  }

  primaryBtn.disabled = false;
  progressEl.classList.add('hidden');
  progressFillEl.style.width = `${Math.min(100, Math.max(0, Number(mandatoryUpdateFlow.progress || 0)))}%`;

  if (mandatoryUpdateFlow.error) {
    primaryBtn.textContent = 'Retry Download';
    restartBtn.classList.add('hidden');
    statusEl.textContent = mandatoryUpdateFlow.error;
    return;
  }

  if (mandatoryUpdateFlow.downloaded) {
    primaryBtn.textContent = mandatoryUpdateFlow.installerOpened ? 'Open Installer Again' : 'Install Update';
    if (mandatoryUpdateFlow.installerOpened) {
      restartBtn.textContent = 'Quit for Install';
      restartBtn.classList.remove('hidden');
      statusEl.textContent = 'DMG opened. Drag Anty Browser to Applications, then quit and reopen.';
    } else {
      restartBtn.classList.add('hidden');
      statusEl.textContent = 'Download complete. Click Install Update to open the DMG.';
    }
    return;
  }

  primaryBtn.textContent = 'Update Now';
  restartBtn.classList.add('hidden');
  statusEl.textContent = '';
}

async function triggerMandatoryUpdateDownload() {
  if (mandatoryUpdateOpenInProgress) return;
  mandatoryUpdateOpenInProgress = true;
  try {
    mandatoryUpdateFlow.error = '';
    mandatoryUpdateFlow.downloading = true;
    mandatoryUpdateFlow.progress = 0;
    renderMandatoryUpdateUi();

    const result = await window.api.downloadMandatoryUpdate({ retryCount: 3 });
    if (!result?.ok) {
      mandatoryUpdateFlow.downloading = false;
      mandatoryUpdateFlow.downloaded = false;
      mandatoryUpdateFlow.error = result?.message || 'Failed to download update';
      renderMandatoryUpdateUi();
      showToast(mandatoryUpdateFlow.error, 'error');
      return;
    }

    mandatoryUpdateFlow.downloading = false;
    mandatoryUpdateFlow.downloaded = true;
    mandatoryUpdateFlow.error = '';
    mandatoryUpdateFlow.progress = 100;
    renderMandatoryUpdateUi();
    showToast('Update downloaded', 'success');
  } catch (err) {
    mandatoryUpdateFlow.downloading = false;
    mandatoryUpdateFlow.downloaded = false;
    mandatoryUpdateFlow.error = err.message || 'Failed to download update';
    renderMandatoryUpdateUi();
    showToast('Failed to download update: ' + err.message, 'error');
  } finally {
    mandatoryUpdateOpenInProgress = false;
  }
}

async function handleMandatoryUpdatePrimaryAction() {
  if (mandatoryUpdateFlow.downloading) return;
  if (!mandatoryUpdateFlow.downloaded) {
    await triggerMandatoryUpdateDownload();
    return;
  }

  try {
    const opened = await window.api.openUpdateInstaller();
    if (!opened?.ok) {
      mandatoryUpdateFlow.error = opened?.message || 'Failed to open installer';
      renderMandatoryUpdateUi();
      showToast(mandatoryUpdateFlow.error, 'error');
      return;
    }

    if (opened?.action === 'quit_and_install' || opened?.action === 'opened_installer_and_quit') {
      showToast('Installer opened. Closing app for install...', 'success');
      setMandatoryUpdateButtonsBusy(true);
      setTimeout(() => {
        void window.api.quitApp().catch(() => {});
      }, 900);
      return;
    }

    mandatoryUpdateFlow.error = '';
    mandatoryUpdateFlow.installerOpened = true;
    renderMandatoryUpdateUi();
    showToast('Installer opened', 'success');
  } catch (err) {
    mandatoryUpdateFlow.error = err.message || 'Failed to open installer';
    renderMandatoryUpdateUi();
    showToast(mandatoryUpdateFlow.error, 'error');
  }
}

async function handleMandatoryRestartAction() {
  try {
    await window.api.quitApp();
  } catch (err) {
    showToast('Failed to quit app: ' + err.message, 'error');
  }
}

function isLoginRequiredError(err) {
  const message = err?.message || String(err || '');
  return message.includes('LOGIN_REQUIRED') || message.toLowerCase().includes('session expired');
}

// ===== HELPERS =====
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '…';
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  const now = new Date();
  const diff = now - d;
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
}

function getProfileCreatorLabel(profile) {
  if (profile?.team_id) return 'Team';
  if (profile?.remote_id) return 'Platform';
  return 'Local';
}

function getOsType(fp) {
  const source = [
    fp?.osShort,
    fp?.osName,
    fp?.platform,
    fp?.userAgent,
  ].filter(Boolean).join(' ').toLowerCase();

  if (!source) return 'unknown';
  if (source.includes('win')) return 'windows';
  if (source.includes('mac') || source.includes('darwin') || source.includes('os x') || source.includes('macintosh')) return 'apple';
  if (source.includes('iphone') || source.includes('ios')) return 'ios';
  if (source.includes('android')) return 'android';
  if (source.includes('linux')) return 'linux';
  return 'unknown';
}

function getOsBadgeMarkup(fp) {
  const type = getOsType(fp);
  if (type === 'windows') {
    return '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M0.6 2.7L6.9 1.8v5.7H0.6V2.7zm7.4-1l7-1v6.8h-7V1.7zM0.6 8.5h6.3v5.7l-6.3-.9V8.5zm7.4 0h7v6.8l-7-1V8.5z" fill="currentColor"/></svg>';
  }
  if (type === 'apple' || type === 'ios') {
    return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M11.5 8.2c0-1.6 1.3-2.4 1.3-2.4-.7-1-1.8-1.1-2.2-1.1-.9-.1-1.7.5-2.2.5-.5 0-1.1-.5-1.9-.4-1 .1-1.9.6-2.4 1.5-1.1 1.8-.3 4.5.8 6 .5.7 1.1 1.5 1.9 1.5.8 0 1.1-.5 2-.5.9 0 1.2.5 2 .5.8 0 1.4-.7 1.9-1.4.6-.8.8-1.6.8-1.7 0 0-1.5-.6-1.5-2.5zM10 3.5c.4-.5.7-1.2.6-1.9-.6 0-1.3.4-1.7.9-.4.5-.8 1.2-.7 1.9.7.1 1.4-.3 1.8-.9z" fill="currentColor"/></svg>';
  }
  if (type === 'linux') return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M8 1C5.8 1 4 3 4 5.5c0 1.2.4 2.3 1 3.1-.3.4-.5.9-.5 1.4 0 .6.2 1.1.6 1.5C4.4 12 4 12.8 4 13.5c0 .8.6 1.5 1.5 1.5h5c.9 0 1.5-.7 1.5-1.5 0-.7-.4-1.5-1.1-2C11.3 11.1 11.5 10.6 11.5 10c0-.5-.2-1-.5-1.4.6-.8 1-1.9 1-3.1C12 3 10.2 1 8 1zm0 1.5c1.4 0 2.5 1.3 2.5 3S9.4 8.5 8 8.5 5.5 7.2 5.5 5.5 6.6 2.5 8 2.5zM6.5 6c.3 0 .5.2.5.5S6.8 7 6.5 7 6 6.8 6 6.5 6.2 6 6.5 6zm3 0c.3 0 .5.2.5.5S9.8 7 9.5 7 9 6.8 9 6.5 9.2 6 9.5 6zM8 9.5c.8 0 1.5.3 1.9.8H6.1c.4-.5 1.1-.8 1.9-.8zm-2.5 2h5c.3 0 .5.2.5.5s-.2.5-.5.5h-5c-.3 0-.5-.2-.5-.5s.2-.5.5-.5z"/></svg>';
  if (type === 'android') return '🤖';
  return '💻';
}

function getProfileSystemLabel(fp) {
  const source = [
    fp?.osName,
    fp?.osShort,
    fp?.platform,
    fp?.userAgent
  ].filter(Boolean).join(' ').toLowerCase();

  if (source.includes('win')) return 'Windows';
  if (source.includes('mac') || source.includes('darwin') || source.includes('os x') || source.includes('macintosh')) return 'macOS';
  if (source.includes('iphone') || source.includes('ios')) return 'iOS';
  if (source.includes('android')) return 'Android';
  if (source.includes('linux')) return 'Linux';

  const fallback = String(fp?.osName || fp?.platform || '').trim();
  return fallback || 'Unknown';
}

function parseCookiesInput(rawText, { importExpired = true } = {}) {
  const text = String(rawText || '').trim();
  if (!text) return { ok: true, cookies: [] };

  const direct = tryParseCookiesArray(text);
  if (direct.ok) {
    const cookies = importExpired ? direct.cookies : filterExpiredCookies(direct.cookies);
    return { ok: true, cookies };
  }

  const candidates = extractJsonArrays(text);
  const collected = [];
  for (const candidate of candidates) {
    const parsed = tryParseCookiesArray(candidate);
    if (parsed.ok && parsed.cookies.length > 0) {
      collected.push(...parsed.cookies);
    }
  }

  if (!collected.length) {
    return { ok: false, error: 'Invalid cookies JSON. Paste JSON array of cookies.' };
  }

  const cookies = importExpired ? collected : filterExpiredCookies(collected);
  return { ok: true, cookies: dedupeCookies(cookies) };
}

function filterExpiredCookies(cookies) {
  const nowSec = Date.now() / 1000;
  return cookies.filter((c) => {
    if (c.expires == null) return true;
    return c.expires > nowSec;
  });
}

function tryParseCookiesArray(input) {
  try {
    const value = JSON.parse(input);
    if (!Array.isArray(value)) {
      return { ok: false, error: 'Cookies value must be an array.' };
    }
    const cookies = value.map(normalizeCookie).filter(Boolean);
    if (!cookies.length) {
      return { ok: false, error: 'No valid cookies found in JSON.' };
    }
    return { ok: true, cookies: dedupeCookies(cookies) };
  } catch {
    return { ok: false, error: 'Invalid JSON.' };
  }
}

function extractJsonArrays(text) {
  const chunks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === ']' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        chunks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return chunks;
}

function normalizeSameSite(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'unspecified' || v === 'no_restriction') return null;
  if (v === 'lax') return 'Lax';
  if (v === 'strict') return 'Strict';
  if (v === 'none') return 'None';
  return null;
}

function normalizeCookie(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name || '').trim();
  const value = raw.value == null ? '' : String(raw.value);
  if (!name) return null;

  const url = String(raw.url || '').trim();
  const domain = String(raw.domain || '').trim();
  const path = String(raw.path || '/').trim() || '/';

  const cookie = { name, value };
  if (url) {
    cookie.url = url;
  } else if (domain) {
    cookie.domain = domain;
    cookie.path = path;
  } else {
    return null;
  }

  if (typeof raw.httpOnly === 'boolean') cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === 'boolean') cookie.secure = raw.secure;

  const sameSite = normalizeSameSite(raw.sameSite);
  if (sameSite) cookie.sameSite = sameSite;
  if (cookie.sameSite === 'None' && cookie.secure !== true) cookie.secure = true;

  const expiresNum = Number(raw.expires ?? raw.expirationDate);
  if (Number.isFinite(expiresNum) && expiresNum > 0 && !raw.session) {
    cookie.expires = expiresNum;
  }

  return cookie;
}

function dedupeCookies(cookies) {
  const map = new Map();
  for (const cookie of cookies) {
    const scope = cookie.url || `${cookie.domain || ''}${cookie.path || ''}`;
    const key = `${cookie.name}::${scope}`;
    map.set(key, cookie);
  }
  return Array.from(map.values());
}

const _toastQueue = [];
let _toastVisible = 0;
const TOAST_MAX = 3;
const TOAST_DURATION = 3000;

function showToast(message, type = 'success') {
  if (_toastVisible >= TOAST_MAX) {
    // Replace oldest if queue is full
    const oldest = document.querySelector('.toast');
    if (oldest) { oldest.style.opacity = '0'; setTimeout(() => oldest.remove(), 200); _toastVisible--; }
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${type === 'success' ? '✅' : '❌'}<span>${escapeHtml(message)}</span>`;

  // Stack toasts vertically
  const offset = _toastVisible * 52;
  toast.style.setProperty('--toast-offset', `${offset}px`);

  document.body.appendChild(toast);
  _toastVisible++;

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => {
      toast.remove();
      _toastVisible = Math.max(0, _toastVisible - 1);
      // Re-stack remaining toasts
      document.querySelectorAll('.toast').forEach((t, i) => {
        t.style.setProperty('--toast-offset', `${i * 52}px`);
      });
    }, 300);
  }, TOAST_DURATION);
}

// Make functions globally accessible for onclick handlers
window.selectProfile = selectProfile;
window.launchProfile = launchProfile;
window.stopProfile = stopProfile;
window.deleteProfile = deleteProfile;
window.confirmDeleteProfile = confirmDeleteProfile;
