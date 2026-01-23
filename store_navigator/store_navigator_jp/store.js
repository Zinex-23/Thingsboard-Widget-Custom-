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
        if (self.typeSelect.options.length > 0 && self.typeSelect.selectedIndex >= 0) {
            self.storeDisplay.textContent = self.typeSelect.options[self.typeSelect.selectedIndex].text;
        } else {
            self.storeDisplay.textContent = '店舗を選択';
        }
        if (self.deviceSelect.options.length > 0 && self.deviceSelect.selectedIndex >= 0) {
            self.deviceDisplay.textContent = self.deviceSelect.options[self.deviceSelect.selectedIndex].text;
        } else {
            self.deviceDisplay.textContent = 'デバイスを選択';
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

    self.isUpdatingFromState = false;

    if (self.ctx.stateController) {
        self.stateSubscription = self.ctx.stateController.stateChanged().subscribe((params) => {
            updateUiFromState(params);
        });
    }

    init();
    wireCustomDropdowns();
};

self.onDestroy = function () {
    if (self.stateSubscription) self.stateSubscription.unsubscribe();
    if (self.typeSelect && self.typeChangeHandler) self.typeSelect.removeEventListener('change', self.typeChangeHandler);
    if (self.deviceSelect && self.deviceChangeHandler) self.deviceSelect.removeEventListener('change', self.deviceChangeHandler);
    if (self.typeAbort) { try { self.typeAbort.abort(); } catch (e) { } self.typeAbort = null; }
    if (self.deviceAbort) { try { self.deviceAbort.abort(); } catch (e) { } self.deviceAbort = null; }
    if (self.persistTimer) { clearTimeout(self.persistTimer); self.persistTimer = null; }
    teardownCustomDropdowns();
    try { ensureStoreDropdownManager().close(); } catch (e) { }
};

async function init() {
    setStatus('デバイスタイプを読み込み中…');
    try {
        const types = await fetchDeviceTypes();
        fillSelect(self.typeSelect, types, null);
        setStatus('');

        let stateParams = null;
        if (self.ctx.stateController) {
            stateParams = self.ctx.stateController.getStateParams();
        }

        if (stateParams && stateParams.selectedDeviceType && types.includes(stateParams.selectedDeviceType)) {
            await updateUiFromState(stateParams);
        } else {
            const savedSelection = restoreSelection();
            if (savedSelection && savedSelection.deviceType && types.includes(savedSelection.deviceType)) {
                self.typeSelect.value = savedSelection.deviceType;
                self.updateLabels();
                self.suppressAutoPersist = true;
                await loadDevicesByType(savedSelection.deviceType, savedSelection.deviceId);
                self.suppressAutoPersist = false;
                if (savedSelection.deviceId && savedSelection.deviceId !== '__ALL__') {
                    await forceAllThenDevice(savedSelection.deviceType, savedSelection.deviceId);
                } else {
                    self.deviceSelect.value = savedSelection.deviceId || '__ALL__';
                    self.updateLabels();
                    persistSelection();
                }
            } else if (types.length) {
                self.typeSelect.value = types[0];
                self.updateLabels();
                self.suppressAutoPersist = true;
                await loadDevicesByType(types[0], null);
                self.suppressAutoPersist = false;
                await forceAllThenDevice(types[0], self.deviceSelect.value);
            } else {
                setStatus('利用可能なデバイスタイプがありません');
                self.updateLabels();
            }
        }
    } catch (error) {
        setStatus('デバイスタイプの読み込みに失敗しました');
    }
}

async function forceAllThenDevice(type, deviceId) {
    if (!type) return;
    if (self.deviceSelect.querySelector('option[value="__ALL__"]')) {
        self.deviceSelect.value = '__ALL__';
        self.updateLabels();
        self.isLoadingOptions = false;
        persistSelection({ silentState: true, skipStorage: true });
    }
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
    if (!type) return;

    self.isUpdatingFromState = true;
    self.isLoadingOptions = true;

    try {
        if (self.typeSelect.value !== type) {
            self.typeSelect.value = type;
            self.updateLabels();
            self.suppressAutoPersist = true;
            await loadDevicesByType(type, deviceId);
            self.suppressAutoPersist = false;
        } else if (isDeviceSelectEmpty()) {
            self.suppressAutoPersist = true;
            await loadDevicesByType(type, deviceId);
            self.suppressAutoPersist = false;
        }

        if (deviceId && self.deviceSelect.value !== deviceId) {
            const optionExists = Array.from(self.deviceSelect.options).some(opt => opt.value === deviceId);
            if (optionExists) {
                self.deviceSelect.value = deviceId;
                self.updateLabels();
            } else if (deviceId === '__ALL__') {
                if (self.deviceSelect.querySelector('option[value="__ALL__"]')) {
                    self.deviceSelect.value = '__ALL__';
                    self.updateLabels();
                }
            }
        }
    } finally {
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
        fillSelect(self.deviceSelect, [], null);
        self.updateLabels();
        return;
    }
    setStatus('デバイスを読み込み中…');
    try {
        self.isLoadingOptions = true;
        if (self.deviceAbort) { try { self.deviceAbort.abort(); } catch (e) { } }
        const mySeq = ++devicesReqSeq;
        self.deviceAbort = new AbortController();
        const devices = await fetchDevices(type, self.deviceAbort.signal);
        if (mySeq !== devicesReqSeq) return;
        self.devicesByType[type] = devices;
        self.currentDevices = devices;

        let deviceOptions = [];
        let defaultSelection = '';
        if (devices.length === 1) {
            deviceOptions = devices.map(d => ({ value: d.id, label: d.name }));
            defaultSelection = devices[0].id;
        } else {
            deviceOptions = [
                { value: '__ALL__', label: '全デバイス' },
                ...devices.map(d => ({ value: d.id, label: d.name }))
            ];
            defaultSelection = devices.length ? devices[0].id : '__ALL__';
        }

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
                : [{ value: '__ALL__', label: '全デバイス' }, ...cached.map(d => ({ value: d.id, label: d.name }))];
            fillSelect(self.deviceSelect, deviceOptions, null);
            const preferred = preferredDeviceId || (self.lastSelection && self.lastSelection.deviceType === type ? self.lastSelection.deviceId : null);
            if (preferred && deviceOptions.some(opt => opt.value === preferred)) {
                self.deviceSelect.value = preferred;
            } else if (deviceOptions.length) {
                self.deviceSelect.value = deviceOptions[0].value;
            }
            self.updateLabels();
            setStatus('');
            self.isLoadingOptions = false;
            if (!self.suppressAutoPersist && !self.isUpdatingFromState) {
                persistSelection();
            }
            return;
        }
        setStatus('デバイスの読み込みに失敗しました');
    } finally {
        setTimeout(() => { self.isLoadingOptions = false; }, 0);
    }
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
        if (typeof it === 'string') {
            opt.value = it;
            opt.textContent = it;
        } else {
            opt.value = it.value;
            opt.textContent = it.label;
        }
        selectEl.appendChild(opt);
    });
}

function setStatus(msg) {
    if (!self.statusEl) return;
    self.statusEl.textContent = msg || '';
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
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'X-Authorization': 'Bearer ' + token } : {})
        }
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
            if (self.typeAbort) { try { self.typeAbort.abort(); } catch (e) { } }
            const mySeq = ++typesReqSeq;
            self.typeAbort = new AbortController();
            const r = await apiGet(url, self.typeAbort.signal);
            if (mySeq !== typesReqSeq) return [];
            const data = r.data || [];
            return [...new Set(data.map(d => d.type))].filter(Boolean).sort();
        } catch (e) { return []; }
    }

    if (self.typeAbort) { try { self.typeAbort.abort(); } catch (e) { } }
    const mySeq = ++typesReqSeq;
    self.typeAbort = new AbortController();
    const r = await apiGet('/api/device/types', self.typeAbort.signal);
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
        if (!customerId) throw new Error('顧客IDが見つかりません');
        url = `/api/customer/${customerId}/deviceInfos?pageSize=${pageSize}&page=${page}&type=${encodeURIComponent(deviceType)}`;
    } else {
        url = `/api/tenant/deviceInfos?pageSize=${pageSize}&page=${page}&type=${encodeURIComponent(deviceType)}`;
    }
    const r = await apiGet(url, signal);
    const data = r.data || [];
    return data
        .filter(x => x.type === deviceType)
        .map(x => ({
            id: (x.id && (x.id.id || x.id)) || x.id,
            name: x.name || x.label || x.deviceName || '(名称未設定)',
            label: x.label || '',
            type: x.type
        }));
}

function saveSelection(type, deviceId, deviceName, deviceLabel, mode) {
    try {
        const selection = {
            deviceType: type,
            deviceId,
            deviceName,
            deviceLabel: deviceLabel || deviceName,
            mode,
            timestamp: Date.now()
        };
        localStorage.setItem('store_type_selection', JSON.stringify(selection));
        self.lastSelection = selection;
    } catch (e) { }
}

function restoreSelection() {
    try {
        const saved = localStorage.getItem('store_type_selection');
        if (saved) return JSON.parse(saved);
    } catch (e) { }
    return null;
}

function persistSelection(options) {
    const opts = options || {};
    const selectedType = self.typeSelect.value;
    const selectedDeviceId = self.deviceSelect.value;
    const selectedDeviceName =
        self.deviceSelect.options[self.deviceSelect.selectedIndex]?.text || '';

    if (opts.silentState) {
        if (!opts.skipStorage) {
            const mode = selectedDeviceId === '__ALL__' ? 'ALL' : (selectedDeviceId ? 'SINGLE' : 'NONE');
            saveSelection(selectedType, selectedDeviceId, selectedDeviceName, '', mode);
        }
        return;
    }

    if (!self.ctx || !self.ctx.stateController) return;
    if (self.isUpdatingFromState) return;
    if (self.isLoadingOptions) return;

    if (self.persistTimer) clearTimeout(self.persistTimer);
    self.persistTimer = setTimeout(() => {
        persistSelectionAsync(selectedType, selectedDeviceId, selectedDeviceName);
    }, 150);
}

async function persistSelectionAsync(selectedType, selectedDeviceId, selectedDeviceName) {
    try {
        if (selectedDeviceId === '__ALL__') {
            const devices = self.currentDevices || [];
            const entityList = devices.map(d => ({ entityType: 'DEVICE', id: d.id }));
            const stateParams = {
                entities: entityList,
                entityIds: entityList,
                entityId: entityList.length ? { entityType: 'DEVICE', id: entityList[0].id } : null,
                entityType: 'DEVICE',
                id: entityList.length ? entityList[0].id : null,
                selectedDeviceMode: 'ALL',
                selectedDeviceType: selectedType,
                selectedDeviceId: '__ALL__',
                selectedDeviceName: selectedDeviceName,
                name: selectedDeviceName,
                label: selectedDeviceName,
                type: selectedType,
                mode: 'ALL',
                count: entityList.length
            };
            self.ctx.stateController.updateState(null, stateParams, true);
            self.selected = { deviceType: selectedType, deviceId: '__ALL__', deviceName: selectedDeviceName, mode: 'ALL', count: entityList.length };
            saveSelection(selectedType, '__ALL__', selectedDeviceName, '', 'ALL');
            return;
        }

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

            let selectedDeviceLabel = '';
            try { selectedDeviceLabel = await fetchDeviceLabel(selectedDeviceId); } catch (e) { }
            stateParams.selectedDeviceLabel = selectedDeviceLabel;

            self.ctx.stateController.updateState(null, stateParams, true);
            self.selected = {
                deviceType: selectedType,
                deviceId: selectedDeviceId,
                deviceName: selectedDeviceName,
                deviceLabel: selectedDeviceLabel,
                entity: { entityType: 'DEVICE', id: selectedDeviceId },
                mode: 'SINGLE'
            };
            saveSelection(selectedType, selectedDeviceId, selectedDeviceName, selectedDeviceLabel, 'SINGLE');
            return;
        }

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
        self.ctx.stateController.updateState(null, stateParams, true);
        self.selected = null;
        localStorage.removeItem('store_type_selection');
    } catch (e) { }
}

// -------- Custom dropdown (same as EN) --------
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
