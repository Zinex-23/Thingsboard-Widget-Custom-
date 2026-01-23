self.onInit = function () {
    self.rootEl = (self.ctx && self.ctx.$container && self.ctx.$container[0]) ? self.ctx.$container[0] : document;
    self.typeSelect = self.rootEl.querySelector('#typeSelect');
    self.deviceSelect = self.rootEl.querySelector('#deviceSelect');
    self.storeDisplay = self.rootEl.querySelector('#storeDisplay');
    self.deviceDisplay = self.rootEl.querySelector('#deviceDisplay');
    self.statusEl = self.rootEl.querySelector('#status');
    self.lastSelection = restoreSelection();
    self.devicesByType = {};
    self.isLoadingOptions = false;
    self.persistTimer = null;
    self.suppressAutoPersist = false;

    self.updateLabels = function () {
        // Update Store Label
        if (self.typeSelect.options.length > 0 && self.typeSelect.selectedIndex >= 0) {
            self.storeDisplay.textContent = self.typeSelect.options[self.typeSelect.selectedIndex].text;
        } else {
            self.storeDisplay.textContent = 'Select Store';
        }

        // Update Device Label
        if (self.deviceSelect.options.length > 0 && self.deviceSelect.selectedIndex >= 0) {
            self.deviceDisplay.textContent = self.deviceSelect.options[self.deviceSelect.selectedIndex].text;
        } else {
            self.deviceDisplay.textContent = 'Select Device';
        }
    };

    self.typeChangeHandler = async () => {
        self.updateLabels();
        const type = self.typeSelect.value;
        const saved = restoreSelection();
        const preferred = saved && saved.deviceType === type ? saved.deviceId : null;
        await loadDevicesByType(type, preferred);
        self.updateLabels();
        persistSelection();
    };
    self.typeSelect.addEventListener('change', self.typeChangeHandler);

    self.deviceChangeHandler = () => {
        self.updateLabels();
        persistSelection();
    };
    self.deviceSelect.addEventListener('change', self.deviceChangeHandler);

    // Flag to prevent infinite loops when updating UI from state
    self.isUpdatingFromState = false;

    // ✅ Subscribe to dashboard state changes (e.g. back button)
    if (self.ctx.stateController) {
        self.stateSubscription = self.ctx.stateController.stateChanged().subscribe((params) => {
            // //console.log('[store_type] 📡 State changed:', params);
            updateUiFromState(params);
        });
    }

    init();
    wireCustomDropdowns();
};

self.onDestroy = function () {
    if (self.stateSubscription) {
        self.stateSubscription.unsubscribe();
    }
    if (self.typeSelect && self.typeChangeHandler) {
        self.typeSelect.removeEventListener('change', self.typeChangeHandler);
    }
    if (self.deviceSelect && self.deviceChangeHandler) {
        self.deviceSelect.removeEventListener('change', self.deviceChangeHandler);
    }
    if (self.typeAbort) {
        try { self.typeAbort.abort(); } catch (e) { }
        self.typeAbort = null;
    }
    if (self.deviceAbort) {
        try { self.deviceAbort.abort(); } catch (e) { }
        self.deviceAbort = null;
    }
    if (self.persistTimer) {
        clearTimeout(self.persistTimer);
        self.persistTimer = null;
    }
    teardownCustomDropdowns();
    try { ensureStoreDropdownManager().close(); } catch (e) { }
};

async function init() {
    setStatus('Loading device types...');
    try {
        // //console.log('[store_type] Initializing widget...');
        const types = await fetchDeviceTypes();
        // //console.log('[store_type] Fetched device types:', types);
        fillSelect(self.typeSelect, types, null);
        setStatus('');

        // ✅ PRIORITY 1: Check Dashboard State (Deep Link / Back Button)
        let stateParams = null;
        if (self.ctx.stateController) {
            stateParams = self.ctx.stateController.getStateParams();
        }

        if (stateParams && stateParams.selectedDeviceType && types.includes(stateParams.selectedDeviceType)) {
            // //console.log('[store_type] 📡 Restoring from Dashboard State:', stateParams);
            await updateUiFromState(stateParams);
        }
        // ✅ PRIORITY 2: Restore last selection from localStorage
        else {
            const savedSelection = restoreSelection();
            if (savedSelection && savedSelection.deviceType && types.includes(savedSelection.deviceType)) {
                // //console.log('[store_type] 📦 Restoring saved selection:', savedSelection);
                self.typeSelect.value = savedSelection.deviceType;
                self.updateLabels();
                self.suppressAutoPersist = true;
                await loadDevicesByType(savedSelection.deviceType, savedSelection.deviceId);
                self.suppressAutoPersist = false;

                // If last selection is a specific device, force ALL -> then switch to device
                if (savedSelection.deviceId && savedSelection.deviceId !== '__ALL__') {
                    await forceAllThenDevice(savedSelection.deviceType, savedSelection.deviceId);
                } else {
                    self.deviceSelect.value = savedSelection.deviceId || '__ALL__';
                    self.updateLabels();
                    persistSelection();
                }
            } else if (types.length) {
                // Fallback: auto-load devices for first type
                self.typeSelect.value = types[0];
                self.updateLabels();
                self.suppressAutoPersist = true;
                await loadDevicesByType(types[0], null);
                self.suppressAutoPersist = false;
                // Default first open: select ALL first, then first device if available
                await forceAllThenDevice(types[0], self.deviceSelect.value);
            } else {
                // //console.warn('[store_type] No device types found');
                setStatus('No device types available');
                self.updateLabels();
            }
        }
    } catch (error) {
        // //console.error('[store_type] Error in init():', error);
        setStatus('Error loading device types: ' + error.message);
    }
}

async function forceAllThenDevice(type, deviceId) {
    if (!type) return;
    // Warm-up with ALL internally (no state update to avoid chart flicker)
    if (self.deviceSelect.querySelector('option[value="__ALL__"]')) {
        self.deviceSelect.value = '__ALL__';
        self.updateLabels();
        self.isLoadingOptions = false;
        persistSelection({ silentState: true, skipStorage: true });
    }
    // Then switch to specific device after a short delay to let dashboard bind data
    if (deviceId && deviceId !== '__ALL__') {
        await new Promise(r => setTimeout(r, 200));
        const optionExists = Array.from(self.deviceSelect.options).some(opt => opt.value === deviceId);
        if (optionExists) {
            self.deviceSelect.value = deviceId;
            self.updateLabels();
            self.isLoadingOptions = false;
            persistSelection();
        }
    }
}

async function updateUiFromState(params) {
    if (!params) return;

    const type = params.selectedDeviceType;
    const deviceId = params.selectedDeviceId;

    // //console.log('[store_type] 🔄 updateUiFromState:', { type, deviceId });

    if (!type) return;

    self.isUpdatingFromState = true;
    self.isLoadingOptions = true;

    try {
        // 1. Sync Type
        if (self.typeSelect.value !== type) {
            self.typeSelect.value = type;
            self.updateLabels();
            self.suppressAutoPersist = true;
            await loadDevicesByType(type, deviceId);
            self.suppressAutoPersist = false;
        } else {
            // If device list is empty (race/abort), reload for current type
            if (isDeviceSelectEmpty()) {
                self.suppressAutoPersist = true;
                await loadDevicesByType(type, deviceId);
                self.suppressAutoPersist = false;
            }
        }

        // 2. Sync Device
        if (deviceId && self.deviceSelect.value !== deviceId) {
            // Check if device exists in the loaded list
            const optionExists = Array.from(self.deviceSelect.options).some(opt => opt.value === deviceId);
            if (optionExists) {
                self.deviceSelect.value = deviceId;
                self.updateLabels();
            } else if (deviceId === '__ALL__') {
                // Ensure __ALL__ option exists if it was expected but maybe not loaded yet? 
                // (loadDevicesByType should have handled it if multiple devices exist)
                if (self.deviceSelect.querySelector('option[value="__ALL__"]')) {
                    self.deviceSelect.value = '__ALL__';
                    self.updateLabels();
                }
            }
        }
    } finally {
        // Small delay to ensure UI settles before re-enabling persist
        setTimeout(() => {
            self.isUpdatingFromState = false;
            self.isLoadingOptions = false;
        }, 100);
    }
}

function isDeviceSelectEmpty() {
    if (!self.deviceSelect) return true;
    if (self.deviceSelect.options.length === 0) return true;
    if (self.deviceSelect.options.length === 1 && self.deviceSelect.options[0].value === '') return true;
    return false;
}

let devicesReqSeq = 0;
let typesReqSeq = 0;

async function loadDevicesByType(type, preferredDeviceId) {
    if (!type) {
        // No type selected - clear and return
        fillSelect(self.deviceSelect, [], null);
        self.updateLabels();
        return;
    }
    setStatus('Loading devices...');
    try {
        self.isLoadingOptions = true;
        // //console.log('[store_type] Loading devices for type:', type);
        if (self.deviceAbort) {
            try { self.deviceAbort.abort(); } catch (e) { }
        }
        const mySeq = ++devicesReqSeq;
        self.deviceAbort = new AbortController();
        const devices = await fetchDevices(type, self.deviceAbort.signal);
        if (mySeq !== devicesReqSeq) return;
        self.devicesByType[type] = devices;
        self.currentDevices = devices; // Store for multi-select
        // //console.log('[store_type] Fetched devices:', devices);

        // Determine options based on device count
        let deviceOptions = [];
        let defaultSelection = '';

        if (devices.length === 1) {
            // Single device: Remove "All devices" option, auto-select the only device
            // //console.log('[store_type] Single device detected. Removing "All devices" option.');
            deviceOptions = devices.map(d => ({ value: d.id, label: d.name }));
            defaultSelection = devices[0].id;
        } else {
            // Multiple devices (or 0): Keep "All devices" option, auto-select it
            // //console.log('[store_type] Multiple devices detected. Adding "All devices" option.');
            deviceOptions = [
                { value: '__ALL__', label: `All devices` },
                ...devices.map(d => ({ value: d.id, label: d.name }))
            ];
            defaultSelection = devices.length ? devices[0].id : '__ALL__';
        }

        // No placeholder - start directly with options
        fillSelect(self.deviceSelect, deviceOptions, null);

        if (!preferredDeviceId && self.lastSelection && self.lastSelection.deviceType === type) {
            preferredDeviceId = self.lastSelection.deviceId;
        }
        if (preferredDeviceId) {
            const exists = deviceOptions.some(opt => opt.value === preferredDeviceId);
            if (exists) defaultSelection = preferredDeviceId;
        }
        self.deviceSelect.value = defaultSelection;
        self.updateLabels();
        self.isLoadingOptions = false;
        if (!self.suppressAutoPersist && !self.isUpdatingFromState) {
            persistSelection();
        }
        setStatus('');
    } catch (error) {
        if (error && error.name === 'AbortError') {
            setStatus('');
            self.isLoadingOptions = false;
            return;
        }
        const cached = self.devicesByType[type];
        if (Array.isArray(cached) && cached.length) {
            const deviceOptions = cached.length === 1
                ? cached.map(d => ({ value: d.id, label: d.name }))
                : [{ value: '__ALL__', label: 'All devices' }, ...cached.map(d => ({ value: d.id, label: d.name }))];
            fillSelect(self.deviceSelect, deviceOptions, null);
            const preferred = preferredDeviceId || (self.lastSelection && self.lastSelection.deviceType === type ? self.lastSelection.deviceId : null);
            if (preferred && deviceOptions.some(opt => opt.value === preferred)) {
                self.deviceSelect.value = preferred;
            } else if (deviceOptions.length) {
                self.deviceSelect.value = deviceOptions[0].value;
            }
            self.updateLabels(); // Call updatedLabels after value setting
            setStatus('');
            self.isLoadingOptions = false;
            if (!self.suppressAutoPersist && !self.isUpdatingFromState) {
                persistSelection();
            }
            return;
        }
        // //console.error('[store_type] Error loading devices:', error);
        setStatus('Error loading devices: ' + error.message);
    } finally {
        setTimeout(() => { self.isLoadingOptions = false; }, 0);
    }
}

// -------- Native dropdown open helper --------
function ensureStoreDropdownManager() {
    var topWin = window.top || window;
    if (topWin.__TB_STORE_DD__) return topWin.__TB_STORE_DD__;

    function ensureStyles() {
        var topDoc = topWin.document;
        var style = topDoc.getElementById('tb-store-dd-styles');
        var css =
            '.tb-store-dd-overlay{position:fixed;inset:0;background:transparent;z-index:2147483647;}' +
            '.tb-store-dd{position:fixed;background:#fff;border-radius:6px;padding:8px;min-width:220px;' +
            'box-shadow:0 10px 24px rgba(0,0,0,.2);box-sizing:border-box;z-index:2147483648;}' +
            '.tb-store-dd-list{display:block;max-height:240px;overflow:auto;padding-right:4px;}' +
            '.tb-store-dd-item{border:1px solid transparent;border-radius:4px;padding:8px 10px;text-align:left;' +
            'font-size:12px;font-weight:500;color:#333;cursor:pointer;background:#fff;transition:all .2s ease;width:100%;}' +
            '.tb-store-dd-item:hover{background:rgba(48,86,128,.08);color:#305680;}' +
            '.tb-store-dd-item.active{background:var(--dd-active-bg, rgba(237,28,36,.1));' +
            'color:var(--dd-active-color, #ED1C24);' +
            'border-color:var(--dd-active-border, rgba(237,28,36,.3));}';
        if (!style) {
            style = topDoc.createElement('style');
            style.id = 'tb-store-dd-styles';
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
            if (!selectEl || !anchorEl) return;
            ensureStyles();
            var topDoc = topWin.document;
            var overlay = topDoc.createElement('div');
            overlay.className = 'tb-store-dd-overlay';
            topDoc.body.appendChild(overlay);
            this.overlay = overlay;

            var dropdown = topDoc.createElement('div');
            dropdown.className = 'tb-store-dd';
            if (theme === 'blue') {
                dropdown.style.setProperty('--dd-active-bg', 'rgba(59,130,246,.12)');
                dropdown.style.setProperty('--dd-active-color', '#3B82F6');
                dropdown.style.setProperty('--dd-active-border', 'rgba(59,130,246,.35)');
            } else {
                dropdown.style.setProperty('--dd-active-bg', 'rgba(237,28,36,.1)');
                dropdown.style.setProperty('--dd-active-color', '#ED1C24');
                dropdown.style.setProperty('--dd-active-border', 'rgba(237,28,36,.3)');
            }
            dropdown.innerHTML = '<div class="tb-store-dd-list"></div>';
            topDoc.body.appendChild(dropdown);
            this.dropdown = dropdown;

            var list = dropdown.querySelector('.tb-store-dd-list');
            var options = Array.from(selectEl.options || []);
            options.forEach(function (opt) {
                if (!opt || (opt.value === '' && !opt.textContent)) return;
                var btn = topDoc.createElement('button');
                btn.type = 'button';
                btn.className = 'tb-store-dd-item' + (opt.value === selectEl.value ? ' active' : '');
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
            var gap = 6;
            var left = f.left + a.left;
            var top = f.top + a.bottom + gap;
            var vw = (window.top || window).innerWidth;
            var vh = (window.top || window).innerHeight;
            var dd = this.dropdown;
            var ddW = dd.offsetWidth || 240;
            var ddH = dd.offsetHeight || 200;
            if (left + ddW + gap > vw) left = Math.max(gap, vw - ddW - gap);
            if (top + ddH + gap > vh) top = Math.max(gap, f.top + a.top - ddH - gap);
            dd.style.left = Math.max(gap, left) + 'px';
            dd.style.top = Math.max(gap, top) + 'px';
            dd.style.width = Math.max(160, a.width) + 'px';
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

    topWin.__TB_STORE_DD__ = mgr;
    return mgr;
}

function wireCustomDropdowns() {
    if (!self.rootEl || self._dropdownHandler) return;
    var mgr = ensureStoreDropdownManager();
    self._dropdownHandler = function (e) {
        var storeCard = e.target.closest('.store-card');
        var deviceCard = e.target.closest('.device-card');
        if (storeCard && self.typeSelect) {
            e.stopPropagation();
            mgr.open(self.typeSelect, storeCard, 'red');
            return;
        }
        if (deviceCard && self.deviceSelect) {
            e.stopPropagation();
            mgr.open(self.deviceSelect, deviceCard, 'blue');
        }
    };
    self.rootEl.addEventListener('click', self._dropdownHandler);
}

function teardownCustomDropdowns() {
    if (self.rootEl && self._dropdownHandler) {
        self.rootEl.removeEventListener('click', self._dropdownHandler);
        self._dropdownHandler = null;
    }
}

function fillSelect(selectEl, items, placeholder) {
    selectEl.innerHTML = '';

    // Only add placeholder if provided
    if (placeholder) {
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = placeholder;
        selectEl.appendChild(ph);
    }

    items.forEach(it => {
        const opt = document.createElement('option');
        if (typeof it === 'string') {
            opt.value = it;
            opt.textContent = it;
        } else {
            opt.value = it.value;
            opt.textContent = it.label;
        }
        selectEl.appendChild(opt);
    });
    // native select: no custom menu build
}

function setStatus(msg) {
    self.statusEl.textContent = msg || '';
}

function getToken() {
    const jwtToken = localStorage.getItem('jwt_token');
    const token = localStorage.getItem('token');
    const result = jwtToken || token || '';

    // //console.log('[store_type] Token lookup:', {
    //   jwt_token: jwtToken ? 'found' : 'not found',
    //   token: token ? 'found' : 'not found',
    //   using: result ? 'token available' : 'NO TOKEN'
    //});

    return result;
}

async function apiGet(url, signal) {
    const token = getToken();
    // //console.log('[store_type] API GET:', url);

    const res = await fetch(url, {
        method: 'GET',
        signal,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'X-Authorization': 'Bearer ' + token } : {})
        }
    });

    // //console.log('[store_type] API Response:', {
    //   url: url,
    //   status: res.status,
    //  ok: res.ok
    //});

    if (!res.ok) {
        const errorText = await res.text();
        // //console.error('[store_type] API Error:', errorText);
        throw new Error(`HTTP ${res.status} when GET ${url}: ${errorText}`);
    }

    return res.json();
}

async function fetchDeviceTypes() {
    const user = self.ctx.currentUser;
    // //console.log('[store_type] Fetching device types. User authority:', user ? user.authority : 'unknown');

    // CUSTOMER_USER: Fetch all assigned devices and extract unique types
    if (user && user.authority === 'CUSTOMER_USER') {
        const customerId = (user.customerId && user.customerId.id) ? user.customerId.id : user.customerId;
        if (!customerId) {
            // //console.error('[store_type] ❌ Customer ID missing for CUSTOMER_USER');
            return [];
        }

        const pageSize = 1000; // Fetch large batch to get all types
        const url = `/api/customer/${customerId}/deviceInfos?pageSize=${pageSize}&page=0`;
        // //console.log('[store_type] Customer User: Fetching all devices to extract types from:', url);

        try {
            if (self.typeAbort) {
                try { self.typeAbort.abort(); } catch (e) { }
            }
            const mySeq = ++typesReqSeq;
            self.typeAbort = new AbortController();
            const r = await apiGet(url, self.typeAbort.signal);
            if (mySeq !== typesReqSeq) return [];
            const data = r.data || [];
            // //console.log(`[store_type] Fetched ${data.length} devices for customer.`);

            // Extract unique types
            const uniqueTypes = [...new Set(data.map(d => d.type))].filter(Boolean).sort();
            // //console.log('[store_type] Extracted unique types from customer devices:', uniqueTypes);
            return uniqueTypes;
        } catch (e) {
            // //console.error('[store_type] Error fetching customer devices for types:', e);
            return [];
        }
    }

    // TENANT_ADMIN: Fetch all device types from system
    // //console.log('[store_type] Tenant Admin: Fetching all device types from /api/device/types');
    if (self.typeAbort) {
        try { self.typeAbort.abort(); } catch (e) { }
    }
    const mySeq = ++typesReqSeq;
    self.typeAbort = new AbortController();
    const r = await apiGet('/api/device/types', self.typeAbort.signal);
    if (mySeq !== typesReqSeq) return [];
    // //console.log('[store_type] Raw response from /api/device/types:', r);

    let types = Array.isArray(r) ? r : (r.deviceTypes || []);

    if (types.length > 0 && typeof types[0] === 'object') {
        types = types.map(t => {
            const typeName = t.type || t.name || t.deviceType || t.label || JSON.stringify(t);
            return typeName;
        });
    }

    return types;
}

async function fetchDevices(deviceType, signal) {
    const pageSize = 100;
    const page = 0;

    let url;
    const user = self.ctx.currentUser;
    // //console.log('[store_type] Current user authority:', user ? user.authority : 'unknown');

    if (user && user.authority === 'CUSTOMER_USER') {
        // Handle both object {id: '...'} and string formats
        const customerId = (user.customerId && user.customerId.id) ? user.customerId.id : user.customerId;

        if (!customerId) {
            // //console.error('[store_type] ❌ Could not find customerId for CUSTOMER_USER:', user);
            throw new Error('Customer ID not found for current user');
        }

        url = `/api/customer/${customerId}/deviceInfos?pageSize=${pageSize}&page=${page}&type=${encodeURIComponent(deviceType)}`;
        // //console.log('[store_type] Using Customer API for device fetch. CustomerId:', customerId);
    } else {
        url = `/api/tenant/deviceInfos?pageSize=${pageSize}&page=${page}&type=${encodeURIComponent(deviceType)}`;
        // //console.log('[store_type] Using Tenant API for device fetch');
    }
    // //console.log('[store_type] Fetching devices from:', url);
    // //console.log('[store_type] Filtering by device type:', deviceType);

    const r = await apiGet(url, signal);
    // //console.log('[store_type] Raw response from deviceInfos:', r);

    const data = r.data || [];
    // //console.log('[store_type] Extracted device data count:', data.length);

    if (data.length > 0) {
        const deviceTypes = data.map(d => d.type).filter((v, i, a) => a.indexOf(v) === i);
        // //console.log('[store_type] Device types in response:', deviceTypes);
        // //console.log('[store_type] Expected type:', deviceType);

        const allMatchExpected = data.every(d => d.type === deviceType);
        if (!allMatchExpected) {
            // //console.warn('[store_type] WARNING: Response contains devices of different types!');
            // //console.warn('[store_type] This means the API is not filtering by type parameter.');
            // //console.warn('[store_type] Devices will be filtered client-side.');
        }
    }

    return data
        .filter(x => x.type === deviceType)
        .map(x => ({
            id: (x.id && (x.id.id || x.id)) || x.id,
            name: x.name || x.label || x.deviceName || '(unnamed)',
            label: x.label || '',  // Note: deviceInfos API may not return label
            type: x.type
        }));
}

// Fetch device label from device detail API
async function fetchDeviceLabel(deviceId) {
    try {
        //console.log('[store_type] Fetching device label for:', deviceId);
        const device = await apiGet(`/api/device/${deviceId}`);
        //console.log('[store_type] Device API response:', device);
        //console.log('[store_type] Device label field:', device.label);
        return device.label || '';
    } catch (e) {
        //console.warn('[store_type] Failed to fetch device label:', e);
        return '';
    }
}

// ===== localStorage helpers =====
const STORAGE_KEY = 'store_type_selection';

function saveSelection(type, deviceId, deviceName, deviceLabel, mode) {
    try {
        const selection = {
            deviceType: type,
            deviceId: deviceId,
            deviceName: deviceName,
            deviceLabel: deviceLabel || deviceName,
            mode: mode,
            timestamp: Date.now()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
        self.lastSelection = selection;
        // //console.log('[store_type] 💾 Saved to localStorage:', selection);
    } catch (e) {
        // //console.warn('[store_type] Failed to save to localStorage:', e);
    }
}

function restoreSelection() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const selection = JSON.parse(saved);
            // //console.log('[store_type] 📦 Restored from localStorage:', selection);
            return selection;
        }
    } catch (e) {
        // //console.warn('[store_type] Failed to restore from localStorage:', e);
    }
    return null;
}

function persistSelection(options) {
    const opts = options || {};
    const selectedType = self.typeSelect.value;
    const selectedDeviceId = self.deviceSelect.value;
    const selectedDeviceName =
        self.deviceSelect.options[self.deviceSelect.selectedIndex]?.text || '';

    // //console.log('[store_type] 🔍 persistSelection called:', {
    //    type: selectedType,
    //   deviceId: selectedDeviceId,
    //   deviceName: selectedDeviceName
    //});

    if (opts.silentState) {
        if (!opts.skipStorage) {
            const mode = selectedDeviceId === '__ALL__' ? 'ALL' : (selectedDeviceId ? 'SINGLE' : 'NONE');
            saveSelection(selectedType, selectedDeviceId, selectedDeviceName, '', mode);
        }
        return;
    }

    if (!self.ctx || !self.ctx.stateController) {
        return;
    }

    if (self.isUpdatingFromState) {
        return;
    }
    if (self.isLoadingOptions) {
        return;
    }

    // Call async version
    if (self.persistTimer) clearTimeout(self.persistTimer);
    self.persistTimer = setTimeout(() => {
        persistSelectionAsync(selectedType, selectedDeviceId, selectedDeviceName);
    }, 150);
}

async function persistSelectionAsync(selectedType, selectedDeviceId, selectedDeviceName) {
    try {
        // Note: selectedDeviceType is already included in the 'default' state params below
        // No need to update it separately to avoid multiple state change events

        // ========= ALL DEVICES =========
        if (selectedDeviceId === '__ALL__') {
            // //console.log('[store_type] 📋 All devices selected for type:', selectedType);

            const devices = self.currentDevices || [];
            const entityList = devices.map(d => ({
                entityType: 'DEVICE',
                id: d.id
            }));

            // ✅ ALL params in ONE object for 'default' state
            // For ALL mode, we include both entity list AND custom params
            const stateParams = {
                // For timeseries widgets - multiple formats for compatibility
                entities: entityList,
                entityIds: entityList, // Array format for entity alias
                entityId: entityList.length > 0 ? { entityType: 'DEVICE', id: entityList[0].id } : null,

                // Entity info (first entity as fallback, or empty)
                entityType: 'DEVICE',
                id: entityList.length > 0 ? entityList[0].id : null,

                // Custom params (for static widgets - read via getStateParams())
                selectedDeviceMode: 'ALL',
                selectedDeviceType: selectedType,
                selectedDeviceId: '__ALL__',
                selectedDeviceName: selectedDeviceName,

                // Additional info
                name: selectedDeviceName,
                label: selectedDeviceName,
                type: selectedType,
                mode: 'ALL',
                count: entityList.length
            };

            // //console.log('[store_type] 🔄 Updating current state with ALL params (ALL mode):', stateParams);

            // ✅ Single updateState call with ALL params (null = current state)
            self.ctx.stateController.updateState(null, stateParams, true);

            self.selected = {
                deviceType: selectedType,
                deviceId: '__ALL__',
                deviceName: selectedDeviceName,
                mode: 'ALL',
                count: entityList.length
            };

            // ✅ Save to localStorage for cross-state sync
            saveSelection(selectedType, '__ALL__', selectedDeviceName, '', 'ALL');

            // //console.log('[store_type] ✅ All devices mode activated');

            return;
        }

        // ========= SINGLE DEVICE =========
        if (selectedDeviceId) {
            //console.log('[store_type] ➡️ Entering SINGLE device block, deviceId:', selectedDeviceId);

            // ✅ ALL params in ONE object for 'default' state
            // - entityType + id + entityId: Required for timeseries widgets (entity alias binding)
            // - selectedDeviceMode/Id/Name/Type: Required for static widgets (via getStateParams())
            const stateParams = {
                // Entity info (for timeseries widgets - entity alias may look for these in different formats)
                entityType: 'DEVICE',
                id: selectedDeviceId,
                entityId: { entityType: 'DEVICE', id: selectedDeviceId }, // Nested format for entity alias
                name: selectedDeviceName,
                label: selectedDeviceName,

                // Custom params (for static widgets - read via getStateParams())
                selectedDeviceMode: 'SINGLE',
                selectedDeviceType: selectedType,
                selectedDeviceId: selectedDeviceId,
                selectedDeviceName: selectedDeviceName,

                // Mode shorthand
                mode: 'SINGLE',
                type: selectedType
            };

            // //console.log('[store_type] 🔄 Updating current state with ALL params:', stateParams);

            // Fetch actual device label from API
            let selectedDeviceLabel = '';
            try {
                selectedDeviceLabel = await fetchDeviceLabel(selectedDeviceId);
                //console.log('[store_type] Fetched device label:', selectedDeviceLabel);
            } catch (e) {
                //console.warn('[store_type] Could not fetch device label');
            }

            // Update stateParams with label
            stateParams.selectedDeviceLabel = selectedDeviceLabel;

            // ✅ Single updateState call with ALL params (null = current state)
            self.ctx.stateController.updateState(null, stateParams, true);

            // Update internal state
            self.selected = {
                deviceType: selectedType,
                deviceId: selectedDeviceId,
                deviceName: selectedDeviceName,
                deviceLabel: selectedDeviceLabel,
                entity: { entityType: 'DEVICE', id: selectedDeviceId },
                mode: 'SINGLE'
            };

            // ✅ Save to localStorage for cross-state sync
            saveSelection(selectedType, selectedDeviceId, selectedDeviceName, selectedDeviceLabel, 'SINGLE');

            // //console.log('[store_type] ✅ Single device mode activated');
            return;
        } else {
            // //console.warn('[store_type] ⚠️ selectedDeviceId is empty or null');
        }



        // ========= NO SELECTION =========
        // //console.warn('[store_type] No device selected. Clearing related states.');

        // ✅ ALL params in ONE object - set to null/NONE for clearing
        const stateParams = {
            entityType: null,
            id: null,
            name: null,
            label: null,
            entities: null,

            selectedDeviceMode: 'NONE',
            selectedDeviceType: selectedType || null,
            selectedDeviceId: null,
            selectedDeviceName: null,

            mode: 'NONE',
            type: selectedType || null,
            count: 0
        };

        // //console.log('[store_type] 🔄 Updating current state with NONE params');
        self.ctx.stateController.updateState(null, stateParams, true);

        self.selected = null;

        // ✅ Clear localStorage
        localStorage.removeItem(STORAGE_KEY);
        // //console.log('[store_type] 🗑️ Cleared localStorage');

    } catch (e) {
        // //console.error('[store_type] Error updating state:', e);
    }
}



/** boilerplate */
// self.onDestroy is already defined at the top
self.onDataUpdated = function () { };
self.onResize = function () { };
