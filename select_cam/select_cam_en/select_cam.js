(function ensureCamBus() {
  var topWin = window.top || window;
  if (topWin.__TB_CAM_BUS__) return;
  topWin.__TB_CAM_BUS__ = {
    last: null,
    _listeners: [],
    emit: function (camName) {
      this.last = camName;
      var payload = { cam: camName, ts: Date.now() };
      this._listeners.forEach(function (fn) { try { fn(payload); } catch (e) {} });
    },
    on: function (fn) { if (typeof fn === "function") this._listeners.push(fn); },
    off: function (fn) { this._listeners = this._listeners.filter(function (x) { return x !== fn; }); }
  };
})();

const STORAGE_KEY = 'store_type_selection';
let watchTimer = null;
let activeDeviceId = null;
let seq = 0;
let lastCamReloadAt = 0;
let lastCamDeviceId = null;
let lastCamOptionsSig = null;
let typesReqSeq = 0;
let devicesReqSeq = 0;
let typeAbort = null;
let deviceAbort = null;

self.onInit = function () {
  self.rootEl = self.ctx?.$container?.[0] || document.getElementById('storeCamWidgetRoot') || document;
  self.typeSelect = self.rootEl.querySelector('#typeSelect');
  self.deviceSelect = self.rootEl.querySelector('#deviceSelect');
  self.camSelect = self.rootEl.querySelector('#camSelect');
  self.storeDisplay = self.rootEl.querySelector('#storeDisplay');
  self.deviceDisplay = self.rootEl.querySelector('#deviceDisplay');
  self.camDisplay = self.rootEl.querySelector('#camDisplay');
  self.camBanner = self.rootEl.querySelector('#camBanner');
  self.camLabelEl = self.rootEl.querySelector('#camCard .card-label');
  self.statusEl = self.rootEl.querySelector('#status');
  self.btnEditRoi = self.rootEl.querySelector('#btnEditRoi');
  self.camCard = self.rootEl.querySelector('#camCard');

  initServices();
  bindUiEvents();
  initStoreDevice().then(() => {
    startWatchDevice();
    reloadCamForCurrentDevice(true);
  });
};

self.onDestroy = function () {
  try { watchTimer && clearInterval(watchTimer); } catch (e) {}
};

self.onDataUpdated = function () { };

/* ---------- Services ---------- */
function initServices() {
  const inj = self.ctx.$scope?.$injector;
  if (!inj) return;
  self.attributeService = inj.get(self.ctx.servicesMap.get("attributeService"));
  try {
    const token = self.ctx.servicesMap.get("telemetryService") || self.ctx.servicesMap.get("telemetry");
    self.telemetryService = token ? inj.get(token) : null;
  } catch (e) { self.telemetryService = null; }
  self.telemetryKey = (self.ctx.settings && self.ctx.settings.telemetryKey) || "pass_cam";
  self.serverAttrKey = "current_cam";
  self.deviceLabelKey = "deviceLabel";
}

/* ---------- UI helpers ---------- */
function setStatus(msg) { if (self.statusEl) self.statusEl.textContent = msg || ''; }

function updateLabels() {
  if (self.typeSelect?.options.length) {
    self.storeDisplay.textContent = self.typeSelect.options[self.typeSelect.selectedIndex]?.text || 'Select store';
  }
  if (self.deviceSelect?.options.length) {
    self.deviceDisplay.textContent = self.deviceSelect.options[self.deviceSelect.selectedIndex]?.text || 'Select device';
  }
  if (self.camSelect?.options.length && !(self.camCard && self.camCard.classList.contains('cam-tablet'))) {
    var camText = self.camSelect.options[self.camSelect.selectedIndex]?.text || 'Select camera';
    self.camDisplay.textContent = camText;
  }
  if (self.camLabelEl) {
    self.camLabelEl.textContent = (self.camCard && self.camCard.classList.contains('cam-tablet')) ? 'Tablet Camera' : 'Edge Camera';
  }
}

function clearCamDropdown() {
  if (!self.camSelect) return;
  self.camSelect.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = 'Loading cameras...';
  self.camSelect.appendChild(opt);
  self.camSelect.value = '';
  self.camSelect.disabled = true;
  updateLabels();
}

function fillSelect(selectEl, items, placeholder) {
  selectEl.innerHTML = '';
  if (placeholder) {
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholder;
    selectEl.appendChild(ph);
  }
  items.forEach(it => {
    const opt = document.createElement('option');
    if (typeof it === 'string') { opt.value = it; opt.textContent = it; }
    else { opt.value = it.value; opt.textContent = it.label; }
    selectEl.appendChild(opt);
  });
}

function emitBus(camName) {
  try { (window.top || window).__TB_CAM_BUS__?.emit(camName); } catch (e) {}
}

/* ---------- Bind UI ---------- */
function bindUiEvents() {
  wireStoreDropdown(self.rootEl, '.store-card', self.typeSelect);
  wireDeviceDropdown(self.rootEl, '.device-card', self.deviceSelect);
  wireCamDropdown(self.rootEl, '.cam-card', self.camSelect);

  self.typeSelect?.addEventListener('change', async () => {
    updateLabels();
    const type = self.typeSelect.value;
    await loadDevicesByType(type);
    persistSelection();
    reloadCamForCurrentDevice(true);
  });

  self.deviceSelect?.addEventListener('change', () => {
    updateLabels();
    persistSelection();
    reloadCamForCurrentDevice(true);
  });

  self.camSelect?.addEventListener('change', () => {
    updateLabels();
    const cam = self.camSelect.value;
    if (cam) saveServerCamForSelectedDevice(cam, true);
  });

  self.btnEditRoi?.addEventListener('click', () => {
    try {
      if (!self.ctx?.stateController) return;
      const currentParams = self.ctx.stateController.getStateParams?.() || {};
      const cam = self.camSelect ? self.camSelect.value || null : null;
      const nextParams = Object.assign({}, currentParams, { selectedCam: cam });
      self.ctx.stateController.updateState('edit_roi', nextParams, true);
    } catch (e) { }
  });
}

function wireNativeDropdown(root, cardSelector, selectEl) {
  if (!root || !cardSelector || !selectEl) return;
  const handler = function (e) {
    const card = e.target.closest(cardSelector);
    if (!card) return;
    e.stopPropagation();
    selectEl.focus();
    selectEl.click();
  };
  root.addEventListener('click', handler);
}

/* ---------- Shared custom dropdown (UTC-style) ---------- */
function ensureSharedDropdownManager() {
  var topWin = window.top || window;
  if (topWin.__TB_SHARED_DD__) return topWin.__TB_SHARED_DD__;

  function ensureStyles() {
    var topDoc = topWin.document;
    var style = topDoc.getElementById('tb-shared-dd-styles');
    var css =
      '.tb-dd-overlay{position:fixed;inset:0;background:transparent;z-index:2147483647;}' +
      '.tb-dd{position:fixed;background:#fff;border-radius:6px;padding:8px;min-width:220px;' +
      'box-shadow:0 10px 24px rgba(0,0,0,.2);box-sizing:border-box;z-index:2147483648;}' +
      '.tb-dd-list{display:block;max-height:240px;overflow:auto;padding-right:4px;}' +
      '.tb-dd-item{border:1px solid transparent;border-radius:4px;padding:8px 10px;text-align:left;' +
      'font-size:12px;font-weight:500;color:#333;cursor:pointer;background:#fff;transition:all .2s ease;width:100%;}' +
      '.tb-dd-item:hover{background:rgba(48,86,128,.08);color:#305680;}' +
      '.tb-dd-item.active{background:var(--dd-active-bg, rgba(237,28,36,.1));' +
      'color:var(--dd-active-color, #ED1C24);' +
      'border-color:var(--dd-active-border, rgba(237,28,36,.3));}';
    if (!style) {
      style = topDoc.createElement('style');
      style.id = 'tb-shared-dd-styles';
      style.textContent = css;
      topDoc.head.appendChild(style);
    } else {
      style.textContent = css;
    }
  }

  var mgr = {
    overlay: null,
    dropdown: null,
    _listeners: [],
    open: function (selectEl, anchorEl, theme) {
      this.close();
      if (!selectEl || !anchorEl || selectEl.disabled) return;
      ensureStyles();
      var topDoc = topWin.document;
      var overlay = topDoc.createElement('div');
      overlay.className = 'tb-dd-overlay';
      topDoc.body.appendChild(overlay);
      this.overlay = overlay;

      var dropdown = topDoc.createElement('div');
      dropdown.className = 'tb-dd';
      if (theme === 'purple') {
        dropdown.style.setProperty('--dd-active-bg', 'rgba(168,85,247,.14)');
        dropdown.style.setProperty('--dd-active-color', '#7C3AED');
        dropdown.style.setProperty('--dd-active-border', 'rgba(168,85,247,.35)');
      } else if (theme === 'blue') {
        dropdown.style.setProperty('--dd-active-bg', 'rgba(59,130,246,.12)');
        dropdown.style.setProperty('--dd-active-color', '#3B82F6');
        dropdown.style.setProperty('--dd-active-border', 'rgba(59,130,246,.35)');
      } else {
        dropdown.style.setProperty('--dd-active-bg', 'rgba(237,28,36,.1)');
        dropdown.style.setProperty('--dd-active-color', '#ED1C24');
        dropdown.style.setProperty('--dd-active-border', 'rgba(237,28,36,.3)');
      }
      dropdown.innerHTML = '<div class="tb-dd-list"></div>';
      topDoc.body.appendChild(dropdown);
      this.dropdown = dropdown;

      var list = dropdown.querySelector('.tb-dd-list');
      var options = Array.from(selectEl.options || []);
      options.forEach(function (opt) {
        if (!opt || (opt.value === '' && !opt.textContent)) return;
        var btn = topDoc.createElement('button');
        btn.type = 'button';
        btn.className = 'tb-dd-item' + (opt.value === selectEl.value ? ' active' : '');
        btn.textContent = opt.textContent;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (selectEl.value !== opt.value) {
            selectEl.value = opt.value;
            selectEl.dispatchEvent(new Event('change'));
          }
          mgr.close();
        });
        list.appendChild(btn);
      });

      this.position(anchorEl);

      var selfMgr = this;
      var onEsc = function (e) { if (e.key === 'Escape') selfMgr.close(); };
      var onOutside = function (e) { if (e.target === overlay) selfMgr.close(); };
      var onResize = function () { selfMgr.close(); };
      (window.top || window).addEventListener('keydown', onEsc, true);
      (window.top || window).addEventListener('resize', onResize);
      overlay.addEventListener('click', onOutside);
      this._listeners = [
        [window.top || window, 'keydown', onEsc, true],
        [window.top || window, 'resize', onResize, false],
        [overlay, 'click', onOutside, false]
      ];
    },
    position: function (anchorEl) {
      if (!this.dropdown || !anchorEl) return;
      var a = anchorEl.getBoundingClientRect();
      var fe = window.frameElement;
      var f = fe ? fe.getBoundingClientRect() : { left: 0, top: 0 };
      var scaleX = 1;
      var scaleY = 1;
      if (fe) {
        var feW = fe.clientWidth || fe.offsetWidth || f.width || 0;
        var feH = fe.clientHeight || fe.offsetHeight || f.height || 0;
        if (feW && f.width) scaleX = f.width / feW;
        if (feH && f.height) scaleY = f.height / feH;
      }
      var vv = (window.top || window).visualViewport;
      var vvLeft = vv && typeof vv.offsetLeft === 'number' ? vv.offsetLeft : 0;
      var vvTop = vv && typeof vv.offsetTop === 'number' ? vv.offsetTop : 0;
      var gap = 6;
      var left = f.left + (a.left * scaleX) + vvLeft;
      var top = f.top + (a.bottom * scaleY) + vvTop + gap;
      var vw = (window.top || window).innerWidth;
      var vh = (window.top || window).innerHeight;
      var dd = this.dropdown;
      var ddW = dd.offsetWidth || 240;
      var ddH = dd.offsetHeight || 200;
      if (left + ddW + gap > vw) left = Math.max(gap, vw - ddW - gap);
      if (top + ddH + gap > vh) top = Math.max(gap, f.top + a.top - ddH - gap);
      dd.style.left = Math.max(gap, left) + 'px';
      dd.style.top = Math.max(gap, top) + 'px';
      dd.style.width = Math.max(160, a.width * scaleX) + 'px';
    },
    close: function () {
      if (!this.overlay) return;
      try {
        if (this._listeners && this._listeners.forEach) {
          this._listeners.forEach(function (arr) {
            try { arr[0].removeEventListener(arr[1], arr[2], arr[3]); } catch (e) { }
          });
        }
      } catch (e) { }
      try { this.overlay.remove(); } catch (e) { }
      try { if (this.dropdown) this.dropdown.remove(); } catch (e) { }
      this.overlay = null;
      this.dropdown = null;
      this._listeners = [];
    }
  };

  topWin.__TB_SHARED_DD__ = mgr;
  return mgr;
}

function wireStoreDropdown(root, cardSelector, selectEl) {
  if (!root || !cardSelector || !selectEl) return;
  var mgr = ensureSharedDropdownManager();
  root.addEventListener('click', function (e) {
    var card = e.target.closest(cardSelector);
    if (!card) return;
    e.stopPropagation();
    mgr.open(selectEl, card, 'red');
  });
}

function wireDeviceDropdown(root, cardSelector, selectEl) {
  if (!root || !cardSelector || !selectEl) return;
  var mgr = ensureSharedDropdownManager();
  root.addEventListener('click', function (e) {
    var card = e.target.closest(cardSelector);
    if (!card) return;
    e.stopPropagation();
    mgr.open(selectEl, card, 'blue');
  });
}

function wireCamDropdown(root, cardSelector, selectEl) {
  if (!root || !cardSelector || !selectEl) return;
  var mgr = ensureSharedDropdownManager();
  root.addEventListener('click', function (e) {
    var card = e.target.closest(cardSelector);
    if (!card) return;
    e.stopPropagation();
    mgr.open(selectEl, card, 'purple');
  });
}

/* ---------- Store / Device ---------- */
async function initStoreDevice() {
  setStatus('Loading device types...');
  try {
    const types = await fetchDeviceTypes();
    fillSelect(self.typeSelect, types, null);
    setStatus('');

    const saved = restoreSelection();
    if (saved && saved.deviceType && types.includes(saved.deviceType)) {
      self.typeSelect.value = saved.deviceType;
      await loadDevicesByType(saved.deviceType);
      if (saved.deviceId) self.deviceSelect.value = saved.deviceId;
      persistSelection();
      updateLabels();
      return;
    }

    if (types.length) {
      self.typeSelect.value = types[0];
      await loadDevicesByType(types[0]);
      persistSelection();
      updateLabels();
    } else {
      setStatus('No device types available');
      updateLabels();
    }
  } catch (e) {
    setStatus('Error loading device types: ' + (e.message || e));
  }
}

async function loadDevicesByType(type) {
  if (!type) {
    fillSelect(self.deviceSelect, [], 'Select device');
    updateLabels();
    return;
  }
  setStatus('Loading devices...');
  try {
    if (deviceAbort) { try { deviceAbort.abort(); } catch (e) {} }
    const mySeq = ++devicesReqSeq;
    deviceAbort = new AbortController();
    const devices = await fetchDevices(type, deviceAbort.signal);
    if (mySeq !== devicesReqSeq) return;
    self.currentDevices = devices;
    const opts = devices.map(d => ({ value: d.id, label: d.name }));
    fillSelect(self.deviceSelect, opts, null);
    const saved = restoreSelection();
    const savedId = saved && saved.deviceId && devices.some(d => d.id === saved.deviceId) ? saved.deviceId : null;
    self.deviceSelect.value = savedId || (devices[0] ? devices[0].id : '');
    updateLabels();
    persistSelection();
    setStatus('');
  } catch (e) {
    setStatus('Error loading devices: ' + (e.message || e));
  }
}

function getToken() {
  const jwtToken = localStorage.getItem('jwt_token');
  const token = localStorage.getItem('token');
  return jwtToken || token || '';
}

async function apiGet(url, signal) {
  const token = getToken();
  const res = await fetch(url, {
    method: 'GET',
    signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Authorization': 'Bearer ' + token } : {}) }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchDeviceTypes() {
  const user = self.ctx.currentUser;
  if (user && user.authority === 'CUSTOMER_USER') {
    const customerId = (user.customerId && user.customerId.id) ? user.customerId.id : user.customerId;
    if (!customerId) return [];
    const url = `/api/customer/${customerId}/deviceInfos?pageSize=1000&page=0`;
    try {
      if (typeAbort) { try { typeAbort.abort(); } catch (e) {} }
      const mySeq = ++typesReqSeq;
      typeAbort = new AbortController();
      const r = await apiGet(url, typeAbort.signal);
      if (mySeq !== typesReqSeq) return [];
      const data = r.data || [];
      return [...new Set(data.map(d => d.type))].filter(Boolean).sort();
    } catch (e) { return []; }
  }

  if (typeAbort) { try { typeAbort.abort(); } catch (e) {} }
  const mySeq = ++typesReqSeq;
  typeAbort = new AbortController();
  const r = await apiGet('/api/device/types', typeAbort.signal);
  if (mySeq !== typesReqSeq) return [];
  let types = Array.isArray(r) ? r : (r.deviceTypes || []);
  if (types.length && typeof types[0] === 'object') {
    types = types.map(t => t.type || t.name || t.deviceType || t.label || JSON.stringify(t));
  }
  return types;
}

async function fetchDevices(deviceType, signal) {
  const pageSize = 100;
  const page = 0;
  let url;
  const user = self.ctx.currentUser;
  if (user && user.authority === 'CUSTOMER_USER') {
    const customerId = (user.customerId && user.customerId.id) ? user.customerId.id : user.customerId;
    if (!customerId) throw new Error('Customer ID not found');
    url = `/api/customer/${customerId}/deviceInfos?pageSize=${pageSize}&page=${page}&type=${encodeURIComponent(deviceType)}`;
  } else {
    url = `/api/tenant/deviceInfos?pageSize=${pageSize}&page=${page}&type=${encodeURIComponent(deviceType)}`;
  }
  const r = await apiGet(url, signal);
  const data = r.data || [];
  return data.filter(x => x.type === deviceType).map(x => ({
    id: (x.id && (x.id.id || x.id)) || x.id,
    name: x.name || x.label || x.deviceName || '(unnamed)',
    type: x.type
  }));
}

/* ---------- Selection persistence ---------- */
function saveSelection(type, deviceId, deviceName, mode) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ deviceType: type, deviceId, deviceName, mode, ts: Date.now() })); } catch (e) {}
}
function restoreSelection() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return null;
}

function persistSelection() {
  if (!self.ctx?.stateController) return;
  const selectedType = self.typeSelect?.value;
  const selectedDeviceId = self.deviceSelect?.value;
  const selectedDeviceName = self.deviceSelect?.options[self.deviceSelect.selectedIndex]?.text || '';
  if (selectedDeviceId) {
    const stateParams = {
      entityType: 'DEVICE',
      id: selectedDeviceId,
      entityId: { entityType: 'DEVICE', id: selectedDeviceId },
      name: selectedDeviceName,
      label: selectedDeviceName,
      selectedDeviceMode: 'SINGLE',
      selectedDeviceType: selectedType,
      selectedDeviceId: selectedDeviceId,
      selectedDeviceName: selectedDeviceName,
      mode: 'SINGLE',
      type: selectedType
    };
    self.ctx.stateController.updateState(null, stateParams, true);
    saveSelection(selectedType, selectedDeviceId, selectedDeviceName, 'SINGLE');
  } else {
    const stateParams = {
      entityType: null,
      id: null,
      name: null,
      label: null,
      selectedDeviceMode: 'NONE',
      selectedDeviceType: selectedType || null,
      selectedDeviceId: null,
      selectedDeviceName: null,
      mode: 'NONE',
      type: selectedType || null,
      count: 0
    };
    self.ctx.stateController.updateState(null, stateParams, true);
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
}

/* ---------- Cam part ---------- */
function resolveEntityIdObj() {
  const sub = self.ctx.defaultSubscription;
  const id =
    sub?.entityId?.id ||
    sub?.entityId ||
    (self.deviceSelect && self.deviceSelect.value) ||
    self.ctx.datasources?.[0]?.entityId?.id ||
    self.ctx.datasources?.[0]?.entityId;
  return id ? { entityType: "DEVICE", id: id } : null;
}

function startWatchDevice() {
  try { if (watchTimer) clearInterval(watchTimer); } catch (e) {}
  watchTimer = setInterval(function () {
    try {
      const e = resolveEntityIdObj();
      const id = e?.id || null;
      if (id && id !== activeDeviceId) {
        activeDeviceId = id;
        reloadCamForCurrentDevice(true);
      }
    } catch (e) {}
  }, 600);
}

function reloadCamForCurrentDevice(force) {
  const entityId = resolveEntityIdObj();
  if (!entityId) return;
  if (!force && lastCamDeviceId === entityId.id) return;
  const now = Date.now();
  if (!force && (now - lastCamReloadAt) < 500) return;
  lastCamReloadAt = now;
  lastCamDeviceId = entityId.id;
  const curSeq = ++seq;
  clearCamDropdown();
  self.attributeService
    .getEntityAttributes(entityId, "SERVER_SCOPE", [self.deviceLabelKey, self.serverAttrKey])
    .subscribe(
      function (attrs) {
        if (curSeq !== seq) return;
        const map = {};
        (attrs || []).forEach(a => { if (a && a.key != null) map[a.key] = a.value; });
        const label = map[self.deviceLabelKey] != null ? String(map[self.deviceLabelKey]) : null;
        const currentCam = map[self.serverAttrKey] != null ? String(map[self.serverAttrKey]) : null;
        const isTablet = (label === 'tablet-type' || label === 'tablet');

        if (self.camCard) self.camCard.classList.toggle('cam-tablet', isTablet);
        if (self.camLabelEl) self.camLabelEl.textContent = isTablet ? 'Tablet Camera' : 'Edge Camera';

        if (isTablet) {
          // Tablet: only one camera
          if (self.camSelect) {
            self.camSelect.innerHTML = '';
            const o = document.createElement('option');
            o.value = '';
            o.textContent = 'Only 1 camera';
            self.camSelect.appendChild(o);
            self.camSelect.value = '';
            self.camSelect.disabled = true;
          }
          if (self.camBanner) {
            self.camBanner.textContent = 'Only 1 camera';
          }
          return;
        }

        fetchLatestPassCam(entityId, curSeq, function (options) {
          if (curSeq !== seq) return;
          buildCamOptionsAndSelect(entityId, options, currentCam, label);
        });
      },
      function () {
        fetchLatestPassCam(entityId, curSeq, function (options) {
          if (curSeq !== seq) return;
          buildCamOptionsAndSelect(entityId, options, null, null);
        });
      }
    );
}

function buildCamOptionsAndSelect(entityId, options, currentCam, deviceLabel) {
  if (!self.camSelect) return;
  const opts = Array.isArray(options) ? options : [];
  self.camSelect.innerHTML = '';

  if (!opts.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No camera';
    self.camSelect.appendChild(o);
    self.camSelect.value = '';
    self.camSelect.disabled = true;
    updateLabels();
    return;
  }

  if (self.camCard) self.camCard.classList.remove('cam-tablet');

  opts.forEach(v => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    self.camSelect.appendChild(o);
  });
  self.camSelect.disabled = false;

  const optionsSig = opts.join('|');
  if (lastCamOptionsSig === optionsSig && self.camSelect.value === currentCam) {
    updateLabels();
    return;
  }
  lastCamOptionsSig = optionsSig;

  let sel = (currentCam && opts.includes(currentCam)) ? currentCam : opts[0];
  self.camSelect.value = sel;
  updateLabels();

  if (!currentCam || currentCam !== sel) {
    saveServerCam(entityId, sel, true);
  } else {
    emitBus(sel);
  }
}

function fetchLatestPassCam(entityId, curSeq, cb) {
  if (self.telemetryService?.getLatestTimeseries) {
    self.telemetryService.getLatestTimeseries(entityId, [self.telemetryKey]).subscribe(
      function (data) {
        if (curSeq !== seq) return;
        const arr = data && data[self.telemetryKey];
        const raw = (arr && arr.length) ? arr[0].value : null;
        cb(parseCamOptions(raw));
      },
      function () { cb([]); }
    );
    return;
  }
  const key = encodeURIComponent(self.telemetryKey);
  const url = `/api/plugins/telemetry/DEVICE/${entityId.id}/values/timeseries?keys=${key}&limit=1`;
  self.ctx.http.get(url).subscribe(
    function (res) {
      if (curSeq !== seq) return;
      const data = res?.data || res;
      const arr = data && data[self.telemetryKey];
      const raw = (arr && arr.length) ? arr[0].value : null;
      cb(parseCamOptions(raw));
    },
    function () { cb([]); }
  );
}

function parseCamOptions(raw) {
  if (raw == null) return [];
  let obj;
  try { obj = (typeof raw === "string") ? JSON.parse(raw) : raw; }
  catch (e) { return []; }
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj)
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
    .map(k => `CAM_${k}`);
}

function saveServerCam(entityId, camName, shouldEmit) {
  if (!entityId || !camName) return;
  self.attributeService
    .saveEntityAttributes(entityId, "SERVER_SCOPE", [{ key: self.serverAttrKey, value: camName }])
    .subscribe(
      function () { if (shouldEmit) emitBus(camName); },
      function () { if (shouldEmit) emitBus(camName); }
    );
}

function saveServerCamForSelectedDevice(camName, shouldEmit) {
  const entityId = resolveEntityIdObj();
  if (!entityId) return;
  saveServerCam(entityId, camName, shouldEmit);
}
