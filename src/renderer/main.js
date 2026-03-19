// ===== Anty Browser — Renderer UI Logic =====

let profiles = [];
let proxies = [];
let folders = [];
let groups = [];
let selectedProfileId = null;
let runningProfiles = new Set();
let accountState = null;
let mandatoryUpdateRequired = false;

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  window.api.onUpdateStatus(handleUpdateStatus);
  
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
  await refreshAccountPage();
});

async function loadData() {
  try {
    [profiles, proxies, folders, groups] = await Promise.all([
      window.api.getProfiles(),
      window.api.getProxies(),
      window.api.getFolders(),
      window.api.getGroups()
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

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Sidebar navigation
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const pageEl = document.getElementById(`page-${page}`);
      if (pageEl) pageEl.classList.add('active');
      if (page === 'account') {
        refreshAccountPage();
      }
    });
  });

  // Tab bar tabs
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
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

  // Save & Open profile
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
  document.getElementById('btn-open-profile').addEventListener('click', () => {
    if (selectedProfileId) {
      if (runningProfiles.has(selectedProfileId)) {
        stopProfile(selectedProfileId);
      } else {
        launchProfile(selectedProfileId);
      }
    }
  });

  // Cookies toggle
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
  });

  // Notes auto-save
  document.getElementById('profile-notes').addEventListener('change', async () => {
    if (!selectedProfileId) return;
    await window.api.updateProfile(selectedProfileId, {
      notes: document.getElementById('profile-notes').value
    });
  });

  // Account
  document.getElementById('btn-account-login')?.addEventListener('click', loginAccount);
  document.getElementById('btn-account-logout')?.addEventListener('click', logoutAccount);

  document.getElementById('btn-modal-login')?.addEventListener('click', loginFromModal);

  document.getElementById('btn-update-lock-install')?.addEventListener('click', async () => {
    await triggerMandatoryUpdateDownload(false);
  });
  document.getElementById('btn-update-lock-exit')?.addEventListener('click', () => {
    window.api.closeWindow();
  });
}

// ===== PROFILE CRUD =====
async function createNewProfile() {
  try {
    const profile = await window.api.createProfile({
      name: `Profile ${profiles.length + 1}`
    });
    await loadData();
    renderProfilesList();
    selectProfile(profile.id);
    showToast('Profile created', 'success');
  } catch (err) {
    showToast('Failed to create profile', 'error');
  }
}

async function saveProfile() {
  if (!selectedProfileId) return;
  
  try {
    const data = {
      name: document.getElementById('editor-profile-name').value,
      folder_id: document.getElementById('editor-folder').value || null,
      group_id: document.getElementById('editor-group').value || null,
      start_page: document.getElementById('editor-start-page').value,
      notes: document.getElementById('profile-notes').value,
    };

    // Also link selected proxy
    const proxySelectVal = document.getElementById('editor-proxy-select').value;
    if (proxySelectVal) {
      data.proxy_id = parseInt(proxySelectVal);
    }

    // Save cookies
    const cookiesText = document.getElementById('cookies-textarea').value;
    if (cookiesText) {
      try {
        data.cookies = JSON.parse(cookiesText);
      } catch {
        showToast('Invalid cookies JSON', 'error');
        return;
      }
    }

    await window.api.updateProfile(selectedProfileId, data);
    await loadData();
    renderProfilesList();
    loadProfileEditor(selectedProfileId);
    showToast('Profile saved', 'success');
  } catch (err) {
    showToast('Failed to save profile', 'error');
  }
}

async function deleteProfile(id) {
  try {
    await window.api.deleteProfile(id);
    if (selectedProfileId === id) {
      selectedProfileId = null;
      hideEditor();
    }
    await loadData();
    renderProfilesList();
    showToast('Profile deleted', 'success');
  } catch (err) {
    showToast('Failed to delete profile', 'error');
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
      showToast(`✅ Proxy OK! IP: ${result.ip}`, 'success');
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
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = profiles.filter(p => p.name.toLowerCase().includes(term));
  }

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
    const fp = JSON.parse(p.fingerprint || '{}');
    const isActive = p.id === selectedProfileId;
    const isRunning = runningProfiles.has(p.id);
    const time = formatTime(p.modified_at);
    const osEmoji = getOsEmoji(fp.osShort || fp.osName);
    const browserIcon = getBrowserIcon(fp.browserName);
    const countryFlag = fp.locale?.flag || '';
    const countryCode = fp.locale?.country || '';
    const hasProxy = !!(p.proxy_host);
    
    return `
      <div class="profile-item ${isActive ? 'active' : ''}" data-id="${p.id}" onclick="selectProfile(${p.id})">
        <div class="profile-item-header">
          <span class="profile-item-name">${escapeHtml(p.name)}</span>
          <span class="profile-item-time">${time}</span>
          <button class="profile-launch-btn ${isRunning ? 'running' : ''}" 
                  onclick="event.stopPropagation(); ${isRunning ? `stopProfile(${p.id})` : `launchProfile(${p.id})`}" 
                  title="${isRunning ? 'Stop' : 'Launch'}">
            ${isRunning 
              ? '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' 
              : '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>'}
          </button>
        </div>
        <div class="profile-item-meta">
          <div class="profile-item-badges">
            <span class="badge badge-os" title="${fp.osName || 'Unknown'}">${osEmoji}</span>
            <span class="badge badge-browser" title="${fp.browserName || 'Chrome'}">${browserIcon}</span>
            ${countryFlag ? `<span class="badge badge-country" title="${countryCode}">${countryFlag}</span>` : ''}
            ${hasProxy ? `<span class="badge badge-proxy" title="Proxy active">⇄</span>` : ''}
          </div>
          ${countryCode ? `<span class="profile-item-country">${countryCode}</span>` : ''}
          ${isRunning ? '<span class="badge badge-status running">Running</span>' : ''}
        </div>
        <span class="profile-item-engine">Chromium</span>
      </div>
    `;
  }).join('');
}

function selectProfile(id) {
  selectedProfileId = id;
  renderProfilesList();
  loadProfileEditor(id);
}

async function loadProfileEditor(id) {
  const profile = await window.api.getProfile(id);
  if (!profile) return;

  const fp = JSON.parse(profile.fingerprint || '{}');
  
  document.getElementById('profile-editor').style.display = '';
  document.getElementById('profile-info').style.display = '';

  // Populate fields
  document.getElementById('editor-profile-name').value = profile.name;
  document.getElementById('editor-start-page').value = profile.start_page || 'chrome://new-tab-page';
  
  populateFolderSelect(profile.folder_id);
  populateGroupSelect(profile.group_id);
  populateProxySelect(profile.proxy_id);

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

  // Cookies
  const cookies = profile.cookies || '[]';
  document.getElementById('cookies-textarea').value = cookies !== '[]' ? cookies : '';

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

  // Notes
  document.getElementById('profile-notes').value = profile.notes || '';

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
    <span class="info-value text-muted">—</span>
    
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
    <span class="info-value">Auto</span>
    
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
    <span class="info-value accent">${profile.start_page || 'chrome://new-tab-page'}</span>
    
    <span class="info-label">At profile start:</span>
    <span class="info-value">Open a start page or set of pages</span>
  `;
}

function hideEditor() {
  document.getElementById('profile-editor').style.display = 'none';
  document.getElementById('profile-info').style.display = 'none';
}

// ===== SELECT POPULATORS =====
function populateFolderSelect(selectedId) {
  const select = document.getElementById('editor-folder');
  select.innerHTML = folders.map(f => 
    `<option value="${f.id}" ${f.id == selectedId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`
  ).join('');
}

function populateGroupSelect(selectedId) {
  const select = document.getElementById('editor-group');
  select.innerHTML = groups.map(g => 
    `<option value="${g.id}" ${g.id == selectedId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
  ).join('');
}

function populateProxySelect(selectedId) {
  const select = document.getElementById('editor-proxy-select');
  select.innerHTML = '<option value="">New Proxy</option>' + 
    proxies.map(p => 
      `<option value="${p.id}" ${p.id == selectedId ? 'selected' : ''}>${escapeHtml(p.name || p.host || 'Proxy ' + p.id)}</option>`
    ).join('');
}

// ===== ACCOUNT =====
async function refreshAccountPage() {
  try {
    await Promise.all([
      loadAccountStateUI(),
      loadAccountEventsUI()
    ]);
  } catch (err) {
    console.error('Failed to refresh account page:', err);
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
}

async function loadAccountStateUI() {
  accountState = await window.api.getAccountState();
  renderAccountState(accountState);
}

async function loadAccountEventsUI() {
  const events = await window.api.getAccountEvents(40);
  renderAccountEvents(events || []);
}

function renderAccountState(state) {
  const statusBadge = document.getElementById('account-status-badge');
  const emailEl = document.getElementById('account-email');
  const passwordEl = document.getElementById('account-password');
  const rememberEl = document.getElementById('account-remember');
  const metaEl = document.getElementById('account-meta');
  if (!statusBadge || !emailEl || !passwordEl || !rememberEl || !metaEl) return;

  const isLoggedIn = Boolean(state?.isLoggedIn);
  statusBadge.textContent = isLoggedIn ? 'Logged in' : 'Logged out';
  statusBadge.classList.toggle('logged-in', isLoggedIn);

  if (document.activeElement !== emailEl) {
    emailEl.value = state?.email || '';
  }
  if (document.activeElement !== passwordEl) {
    passwordEl.value = state?.hasSavedPassword ? (state?.savedPassword || '') : '';
  }
  rememberEl.checked = Boolean(state?.rememberMe);

  syncModalCredentials({
    email: state?.email || '',
    password: state?.hasSavedPassword ? (state?.savedPassword || '') : '',
    rememberMe: Boolean(state?.rememberMe)
  });

  const metaLines = [];
  if (state?.displayName) metaLines.push(`Name: ${escapeHtml(state.displayName)}`);
  if (state?.platformUserId) metaLines.push(`User ID: ${escapeHtml(state.platformUserId)}`);
  if (state?.lastLoginAt) metaLines.push(`Last login: ${new Date(state.lastLoginAt).toLocaleString('uk-UA')}`);
  if (state?.lastLogoutAt) metaLines.push(`Last logout: ${new Date(state.lastLogoutAt).toLocaleString('uk-UA')}`);
  if (!metaLines.length) metaLines.push('No account activity yet.');
  metaEl.innerHTML = metaLines.join('<br>');
}

function renderAccountEvents(events) {
  const container = document.getElementById('account-events');
  if (!container) return;

  if (!events.length) {
    container.innerHTML = '<div class="account-event-item"><div class="account-event-message">No login/logout events yet.</div></div>';
    return;
  }

  container.innerHTML = events.map((event) => {
    const time = new Date(`${event.created_at}Z`).toLocaleString('uk-UA');
    const type = escapeHtml(event.event_type || 'event');
    const message = escapeHtml(event.message || '');
    return `
      <div class="account-event-item">
        <div class="account-event-top">
          <span class="account-event-type">${type}</span>
          <span class="account-event-time">${time}</span>
        </div>
        <div class="account-event-message">${message}</div>
      </div>
    `;
  }).join('');
}

async function loginAccount() {
  const email = document.getElementById('account-email')?.value?.trim() || '';
  const password = document.getElementById('account-password')?.value || '';
  const rememberMe = document.getElementById('account-remember')?.checked !== false;

  if (!email || !password) {
    showToast('Enter email and password', 'error');
    return;
  }

  setAccountBusy(true);
  try {
    accountState = await window.api.loginAccount({ email, password, rememberMe });
    renderAccountState(accountState);
    await loadAccountEventsUI();
    await loadData();
    renderProfilesList();
    hideLoginModal();
    showToast('Login successful', 'success');
  } catch (err) {
    showToast(err.message || 'Login failed', 'error');
    await loadAccountEventsUI();
  } finally {
    setAccountBusy(false);
  }
}

async function loginFromModal() {
  const email = document.getElementById('modal-account-email')?.value?.trim() || '';
  const password = document.getElementById('modal-account-password')?.value || '';
  const rememberMe = document.getElementById('modal-account-remember')?.checked !== false;

  if (!email || !password) {
    showToast('Enter email and password', 'error');
    return;
  }

  setAccountBusy(true);
  try {
    accountState = await window.api.loginAccount({ email, password, rememberMe });
    renderAccountState(accountState);
    await loadAccountEventsUI();
    await loadData();
    renderProfilesList();
    hideLoginModal();
    showToast('Login successful', 'success');
  } catch (err) {
    showToast(err.message || 'Login failed', 'error');
    await loadAccountEventsUI();
  } finally {
    setAccountBusy(false);
  }
}

async function logoutAccount() {
  setAccountBusy(true);
  try {
    accountState = await window.api.logoutAccount({ clearSaved: false });
    renderAccountState(accountState);
    await loadAccountEventsUI();
    profiles = [];
    proxies = [];
    folders = [];
    groups = [];
    selectedProfileId = null;
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
}

function syncModalCredentials(data) {
  const emailEl = document.getElementById('modal-account-email');
  const passwordEl = document.getElementById('modal-account-password');
  const rememberEl = document.getElementById('modal-account-remember');
  if (!emailEl || !passwordEl || !rememberEl) return;
  if (document.activeElement !== emailEl) emailEl.value = data.email || '';
  if (document.activeElement !== passwordEl) passwordEl.value = data.password || '';
  rememberEl.checked = data.rememberMe !== false;
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

    syncModalCredentials({
      email: state?.email || '',
      password: state?.hasSavedPassword ? (state?.savedPassword || '') : '',
      rememberMe: Boolean(state?.rememberMe)
    });
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

  const modal = document.getElementById('update-lock-modal');
  const text = document.getElementById('update-lock-text');
  if (text) {
    const nextVersion = data?.version ? `v${data.version}` : 'нова версія';
    const currentVersion = data?.currentVersion ? ` (поточна v${data.currentVersion})` : '';
    text.textContent = `Доступ заблоковано. Потрібно встановити ${nextVersion}${currentVersion}. Натисни "Оновити зараз", встанови додаток з DMG і перезапусти Anty Browser.`;
  }
  if (modal) modal.classList.remove('hidden');

  void triggerMandatoryUpdateDownload(true);
}

async function triggerMandatoryUpdateDownload(isAuto) {
  try {
    const result = await window.api.openUpdateInstaller();
    if (!result?.ok && !isAuto) {
      showToast(result?.message || 'Не вдалося відкрити інсталятор', 'error');
      return;
    }
    if (!isAuto) {
      showToast('Інсталятор оновлення відкрито', 'success');
    }
  } catch (err) {
    if (!isAuto) {
      showToast('Помилка відкриття інсталятора: ' + err.message, 'error');
    }
  }
}

function isLoginRequiredError(err) {
  const message = err?.message || String(err || '');
  return message.includes('LOGIN_REQUIRED');
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

function getOsEmoji(os) {
  if (!os) return '💻';
  const l = os.toLowerCase();
  if (l.includes('win')) return '🖥️';
  if (l.includes('mac') || l.includes('ios') || l.includes('iphone')) return '🍎';
  if (l.includes('android')) return '📱';
  if (l.includes('linux')) return '🐧';
  return '💻';
}

function getBrowserIcon(browser) {
  if (!browser) return '🌐';
  const l = browser.toLowerCase();
  if (l.includes('chrome')) return '🟢';
  if (l.includes('firefox')) return '🟠';
  if (l.includes('edge')) return '🔵';
  if (l.includes('safari')) return '🧭';
  return '🌐';
}

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    ${type === 'success' ? '✅' : '❌'}
    <span>${escapeHtml(message)}</span>
  `;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Make functions globally accessible for onclick handlers
window.selectProfile = selectProfile;
window.launchProfile = launchProfile;
window.stopProfile = stopProfile;
window.deleteProfile = deleteProfile;
