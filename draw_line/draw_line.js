self.onInit = function () {
    const $injector = self.ctx.$scope.$injector;
    const attributeService = $injector.get(self.ctx.servicesMap.get('attributeService'));

    // AngularJS i18n services (robust)
    let $translate = null;
    let $rootScope = null;
    try { $translate = $injector.get('$translate'); } catch (e) { }
    try { $rootScope = $injector.get('$rootScope'); } catch (e) { }

    const ds = self.ctx.datasources?.[0];
    self._entityId = ds?.entity?.id;
    if (!self._entityId) {
        console.error('No datasource entity. Please select Entity alias.');
        return;
    }

    const $c = self.ctx.$container;
    const stageEl = $c.find('.stage')[0];
    const canvasEl = $c.find('canvas')[0];
    const camBoxEl = $c.find('.cam-box')[0];
    const selectEl = $c.find('.cam-dd')[0];
    const roiSwitchEl = $c.find('.roi-switch')[0];
    const roiBtns = Array.from($c.find('.roi-btn'));
    const toastCenter = $c.find('.toast-center')[0];

    const btnSaveEl = $c.find('.btn-save')[0];
    const btnUndoEl = $c.find('.btn-undo')[0];
    const btnClearEl = $c.find('.btn-clear')[0];
    const btnReloadEl = $c.find('.btn-reload')[0];

    const loadingTextEl = $c.find('.loading-text')[0];
    const camLabelEl = $c.find('.cam-label')[0];

    const g = canvasEl.getContext('2d');

    self._mode = 'default'; // tablet | edge | default
    self._deviceLabel = null;

    self._cams = [];
    self._activeCam = null; // only for edge

    // ✅ NEW: ưu tiên cam hiển thị ban đầu (đọc từ SERVER_SCOPE.current_cam)
    self._preferredCamId = null;

    self._bgImg = new Image();
    self._bgReady = false;
    self._lastSrc = null;

    self._imgDraw = { offX: 0, offY: 0, drawW: 0, drawH: 0 };

    self._tabletPair = []; // [{x,y}] or [{x,y},{x,y}]
    self._roisNorm = { Detect: [], Region1: [], Region2: [] };
    self._activeRoiName = 'Detect';
    self._pending = null;

    // i18n state
    self._lang = 'en';
    self._camPrefixText = 'Cam';
    self._unsubTranslate = null;

    const ROI_COLOR = { Detect: '#FFD400', Region1: '#22C55E', Region2: '#EF4444' };

    /* =========================
     * i18n (EN/JA switchable)
     * ========================= */
    const I18N = {
        en: {
            save: 'Save',
            undo: 'Undo',
            clear: 'Clear',
            reload: 'Reload',
            camera: 'Camera',
            detect: 'Detect',
            region1: 'Region1',
            region2: 'Region2',
            loading: 'Loading latest frame...',
            noCamera: 'No camera',
            camPrefix: 'Cam',
            toast_success: 'Succeeded.',
            toast_failed: 'Failed.',
            err_no_cam_selected: 'No camera selected.',
            err_frame_loading_try_again: 'Frame is loading. Please try again.',
            err_need_3_rois: 'You must draw 3 ROIs (Detect, Region1, Region2), each with at least 3 points.',
            err_need_2_points: 'Please select 2 points to create a line.',
            err_failed_request_frame: 'Failed to request frame.',
            err_failed_load_image: 'Failed to load frame image.'
        },
        ja: {
            save: '保存',
            undo: '元に戻す',
            clear: 'クリア',
            reload: '再読み込み',
            camera: 'カメラ',
            detect: '検出',
            region1: '領域1',
            region2: '領域2',
            loading: '最新フレームを読み込み中...',
            noCamera: 'カメラなし',
            camPrefix: 'カメラ',
            toast_success: '成功しました。',
            toast_failed: '失敗しました。',
            err_no_cam_selected: 'カメラが選択されていません。',
            err_frame_loading_try_again: 'フレームを読み込み中です。もう一度お試しください。',
            err_need_3_rois: '3つのROI（検出・領域1・領域2）をそれぞれ3点以上で描画してください。',
            err_need_2_points: '線を作成するには2点を選択してください。',
            err_failed_request_frame: 'フレーム要求に失敗しました。',
            err_failed_load_image: 'フレーム画像の読み込みに失敗しました。'
        }
    };

    function normLang(l) {
        if (!l) return 'en';
        l = String(l).toLowerCase();
        if (l.indexOf('ja') === 0) return 'ja';
        return 'en';
    }

    function t(key) {
        const d = I18N[self._lang] || I18N.en;
        if (d && d[key] != null) return d[key];
        return '';
    }

    function detectLang() {
        try {
            if ($translate && typeof $translate.use === 'function') {
                const used = $translate.use();
                if (used) return normLang(used);
            }
        } catch (e) { }

        try {
            const ls = localStorage.getItem('tb.lang') ||
                localStorage.getItem('tbLang') ||
                localStorage.getItem('language') ||
                localStorage.getItem('lang');
            if (ls) return normLang(ls);
        } catch (e) { }

        try {
            const hl = document && document.documentElement ? document.documentElement.lang : '';
            if (hl) return normLang(hl);
        } catch (e) { }

        try { return normLang(navigator.language); } catch (e) { }
        return 'en';
    }

    function applyI18nToUI() {
        if (btnSaveEl) btnSaveEl.textContent = t('save');
        if (btnUndoEl) btnUndoEl.textContent = t('undo');
        if (btnClearEl) btnClearEl.textContent = t('clear');
        if (btnReloadEl) btnReloadEl.textContent = t('reload');

        if (camLabelEl) camLabelEl.textContent = t('camera');
        if (loadingTextEl) loadingTextEl.textContent = t('loading');

        for (let i = 0; i < roiBtns.length; i++) {
            const b = roiBtns[i];
            if (!b) continue;
            const roiName = b.dataset ? b.dataset.roi : null;
            if (roiName === 'Detect') b.textContent = t('detect');
            else if (roiName === 'Region1') b.textContent = t('region1');
            else if (roiName === 'Region2') b.textContent = t('region2');
        }

        self._camPrefixText = t('camPrefix') || 'Cam';

        // update existing dropdown options text
        try {
            const opts = selectEl ? selectEl.options : null;
            if (opts) {
                for (let j = 0; j < opts.length; j++) {
                    const opt = opts[j];
                    if (!opt) continue;
                    if (opt.value === '') opt.textContent = t('noCamera');
                    else opt.textContent = self._camPrefixText + ' ' + opt.value;
                }
            }
        } catch (e) { }
    }

    function setLang(nextLang) {
        const n = normLang(nextLang);
        if (n === self._lang) return;
        self._lang = n;
        applyI18nToUI();
    }

    function initI18n() {
        self._lang = detectLang();
        applyI18nToUI();

        try { if (typeof self._unsubTranslate === 'function') self._unsubTranslate(); } catch (e) { }
        self._unsubTranslate = null;

        if ($rootScope && typeof $rootScope.$on === 'function') {
            self._unsubTranslate = $rootScope.$on('$translateChangeSuccess', function () {
                let used2 = null;
                try { used2 = ($translate && typeof $translate.use === 'function') ? $translate.use() : null; } catch (e) { }
                setLang(used2 || detectLang());
            });
        }
    }

    /* ===== Toast ===== */
    function toast(type, msg) {
        if (!toastCenter) return;
        const el = document.createElement('div');
        el.className = `toast ${type || 'info'}`;
        el.textContent = msg;
        toastCenter.appendChild(el);
        setTimeout(() => { try { toastCenter.removeChild(el); } catch (e) { } }, 2700);
    }

    /* ===== Loading ===== */
    function setLoading(on) {
        if (!stageEl) return;
        stageEl.classList.toggle('is-loading', !!on);
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function getStageWH() { return { w: stageEl.clientWidth, h: stageEl.clientHeight }; }

    function blankWhite() {
        const { w: stageW, h: stageH } = getStageWH();
        g.save();
        g.clearRect(0, 0, stageW, stageH);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, stageW, stageH);
        g.restore();
    }

    /* ===== Button feedback (Undo silent) ===== */
    function setBtnState(btn, state) {
        if (!btn) return;
        btn.classList.remove('is-working', 'is-success', 'is-error');
        if (state) {
            btn.classList.add(state);
            if (state === 'is-success' || state === 'is-error') {
                setTimeout(() => btn.classList.remove(state), 900);
            }
        }
    }

    function runWithFeedback(btn, actionName, fn, opts) {
        const silent = !!(opts && opts.silent);
        try {
            setBtnState(btn, 'is-working');
            const res = fn();
            if (res && typeof res.then === 'function') {
                return res.then(() => {
                    setBtnState(btn, null);
                    setBtnState(btn, 'is-success');
                    if (!silent) toast('success', t('toast_success'));
                }).catch((e) => {
                    setBtnState(btn, null);
                    setBtnState(btn, 'is-error');
                    if (!silent) toast('error', e?.message ? e.message : t('toast_failed'));
                });
            } else {
                setBtnState(btn, null);
                setBtnState(btn, 'is-success');
                if (!silent) toast('success', t('toast_success'));
            }
        } catch (e) {
            setBtnState(btn, null);
            setBtnState(btn, 'is-error');
            if (!silent) toast('error', e?.message ? e.message : t('toast_failed'));
        }
    }

    /* ===== Utils ===== */
    function clamp01(n) { return Math.max(0, Math.min(1, n)); }

    function computeImageDrawRect(stageW, stageH) {
        if (!self._bgReady) return self._imgDraw = { offX: 0, offY: 0, drawW: 0, drawH: 0 };
        const imgW = self._bgImg.naturalWidth || 1;
        const imgH = self._bgImg.naturalHeight || 1;
        const scale = Math.min(stageW / imgW, stageH / imgH);
        const drawW = imgW * scale;
        const drawH = imgH * scale;
        const offX = (stageW - drawW) / 2;
        const offY = (stageH - drawH) / 2;
        return self._imgDraw = { offX, offY, drawW, drawH };
    }

    function evToPointOnImageNorm(ev) {
        const { w: stageW, h: stageH } = getStageWH();
        const r = canvasEl.getBoundingClientRect();
        const xCss = ev.clientX - r.left;
        const yCss = ev.clientY - r.top;
        const { offX, offY, drawW, drawH } = computeImageDrawRect(stageW, stageH);
        if (drawW <= 0 || drawH <= 0) return null;
        if (xCss < offX || xCss > offX + drawW || yCss < offY || yCss > offY + drawH) return null;
        return { x: clamp01((xCss - offX) / drawW), y: clamp01((yCss - offY) / drawH) };
    }

    function normToPixelFlat(pointsNorm) {
        const imgW = self._bgImg.naturalWidth || 1;
        const imgH = self._bgImg.naturalHeight || 1;
        const flat = [];
        for (const p of pointsNorm) flat.push(Math.round(p.x * imgW), Math.round(p.y * imgH));
        return flat;
    }

    function pixelFlatToNorm(flat) {
        const imgW = self._bgImg.naturalWidth || 1;
        const imgH = self._bgImg.naturalHeight || 1;
        const pts = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
            pts.push({ x: clamp01(Number(flat[i]) / imgW), y: clamp01(Number(flat[i + 1]) / imgH) });
        }
        return pts;
    }

    /* ===== Mode UI ===== */
    function applyModeUI() {
        if (camBoxEl) camBoxEl.style.display = (self._mode === 'tablet') ? 'none' : 'flex';

        if (self._mode === 'edge') {
            if (roiSwitchEl) roiSwitchEl.style.display = 'flex';
            setActiveRoi(self._activeRoiName || 'Detect');
        } else {
            if (roiSwitchEl) roiSwitchEl.style.display = 'none';
        }
    }

    function setActiveRoi(name) {
        self._activeRoiName = name;
        roiBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.roi === name));
        redraw();
    }

    roiBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (self._mode !== 'edge') return;
            setActiveRoi(btn.dataset.roi);
        });
    });

    /* ===== Render ===== */
    function redraw() {
        const { w: stageW, h: stageH } = getStageWH();
        g.clearRect(0, 0, stageW, stageH);
        if (!self._bgReady) return;

        const rect = computeImageDrawRect(stageW, stageH);
        g.drawImage(self._bgImg, rect.offX, rect.offY, rect.drawW, rect.drawH);

        if (self._mode === 'edge') {
            drawRoi(self._roisNorm.Detect, 'Detect', self._activeRoiName === 'Detect');
            drawRoi(self._roisNorm.Region1, 'Region1', self._activeRoiName === 'Region1');
            drawRoi(self._roisNorm.Region2, 'Region2', self._activeRoiName === 'Region2');
        } else {
            drawTabletPolygon(self._tabletPair);
        }
    }

    function drawTabletPolygon(points) {
        if (!points || !points.length) return;
        const r = self._imgDraw;

        g.save();
        g.strokeStyle = '#F44336'; // Red
        g.fillStyle = '#F44336';
        g.lineWidth = 2.6;

        // Draw closed loop with fill
        if (points.length >= 3) {
            g.save();
            g.globalAlpha = 0.2; // Fill opacity
            g.beginPath();
            g.moveTo(r.offX + points[0].x * r.drawW, r.offY + points[0].y * r.drawH);
            for (let i = 1; i < points.length; i++) {
                g.lineTo(r.offX + points[i].x * r.drawW, r.offY + points[i].y * r.drawH);
            }
            g.closePath();
            g.fill();
            g.restore();
        }

        // Draw lines
        if (points.length >= 2) {
            g.beginPath();
            g.moveTo(r.offX + points[0].x * r.drawW, r.offY + points[0].y * r.drawH);
            for (let i = 1; i < points.length; i++) {
                g.lineTo(r.offX + points[i].x * r.drawW, r.offY + points[i].y * r.drawH);
            }
            if (points.length >= 3) {
                g.closePath(); // Close the loop visually for lines too
            }
            g.stroke();
        }

        // Draw points
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const cx = r.offX + p.x * r.drawW;
            const cy = r.offY + p.y * r.drawH;
            g.beginPath();
            g.arc(cx, cy, 4.5, 0, Math.PI * 2);
            g.fill();
        }

        g.restore();
    }

    function drawRoi(pointsNorm, name, isActive) {
        if (!pointsNorm || !pointsNorm.length) return;
        const r = self._imgDraw;
        const color = ROI_COLOR[name] || 'red';

        g.save();
        g.strokeStyle = color;
        g.fillStyle = color;
        g.lineWidth = isActive ? 2.8 : 1.6;
        g.globalAlpha = isActive ? 1 : 0.55;

        if (pointsNorm.length >= 3) {
            g.save();
            g.globalAlpha = isActive ? 0.18 : 0.10;
            g.beginPath();
            g.moveTo(r.offX + pointsNorm[0].x * r.drawW, r.offY + pointsNorm[0].y * r.drawH);
            for (let i = 1; i < pointsNorm.length; i++) {
                g.lineTo(r.offX + pointsNorm[i].x * r.drawW, r.offY + pointsNorm[i].y * r.drawH);
            }
            g.closePath();
            g.fill();
            g.restore();
        }

        if (pointsNorm.length >= 2) {
            g.beginPath();
            g.moveTo(r.offX + pointsNorm[0].x * r.drawW, r.offY + pointsNorm[0].y * r.drawH);
            for (let i = 1; i < pointsNorm.length; i++) {
                g.lineTo(r.offX + pointsNorm[i].x * r.drawW, r.offY + pointsNorm[i].y * r.drawH);
            }
            g.stroke();
        }

        for (let i = 0; i < pointsNorm.length; i++) {
            const p = pointsNorm[i];
            const cx = r.offX + p.x * r.drawW;
            const cy = r.offY + p.y * r.drawH;
            g.beginPath();
            g.arc(cx, cy, 4, 0, Math.PI * 2);
            g.fill();
        }
        g.restore();
    }

    /* ===== Resize (DPR) ===== */
    const resize = () => {
        const rect = stageEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvasEl.width = Math.max(1, Math.floor(rect.width * dpr));
        canvasEl.height = Math.max(1, Math.floor(rect.height * dpr));
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        redraw();
    };
    self._ro = new ResizeObserver(resize);
    self._ro.observe(stageEl);
    resize();

    /* =========================
     * ✅ NEW: read SERVER_SCOPE.current_cam
     * ========================= */
    function normalizeCamIdFromCurrentCam(v) {
        if (v == null) return null;
        const s = String(v).trim();
        if (!s) return null;
        // accept: "7", "CAM_7", "CAM7", "CAM 7"
        const m = s.match(/(\d+)/);
        return m ? String(Number(m[1])) : null;
    }

    function loadCurrentCamServer() {
        return new Promise((resolve) => {
            attributeService.getEntityAttributes(self._entityId, 'SERVER_SCOPE', ['current_cam'])
                .subscribe(
                    (attrs) => {
                        const a = (attrs || []).find(x => x.key === 'current_cam');
                        self._preferredCamId = normalizeCamIdFromCurrentCam(a?.value);
                        resolve(self._preferredCamId);
                    },
                    () => resolve(null)
                );
        });
    }

    /* ===== Telemetry pass_cam (edge only) ===== */
    function readPassCamFromTelemetry() {
        const dataArr = self.ctx.data || [];
        const entry = dataArr.find(d => d?.dataKey?.name === 'pass_cam');
        if (!entry || !entry.data || !entry.data.length) return null;
        let v = entry.data[0][1];
        if (v == null || v === '') return null;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
        return v;
    }

    function updateCamsFromTelemetry() {
        const obj = readPassCamFromTelemetry();
        if (!obj || typeof obj !== 'object') {
            self._cams = [];
            if (selectEl) selectEl.innerHTML = `<option value="">${t('noCamera')}</option>`;
            return;
        }
        const camIds = Object.keys(obj).sort((a, b) => Number(a) - Number(b));
        self._cams = camIds;

        if (!selectEl) return;
        selectEl.innerHTML = '';
        camIds.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = `${self._camPrefixText} ${id}`;
            selectEl.appendChild(opt);
        });

        // ✅ CHANGED: ưu tiên activeCam -> preferredCamId(current_cam) -> cam đầu
        const next =
            (self._activeCam && camIds.includes(self._activeCam)) ? self._activeCam :
                (self._preferredCamId && camIds.includes(self._preferredCamId)) ? self._preferredCamId :
                    camIds[0];

        selectEl.value = next;
        if (next && next !== self._activeCam) setActiveCam(next);
    }

    if (selectEl) {
        selectEl.addEventListener('change', () => {
            const camId = selectEl.value;
            if (camId) setActiveCam(camId);
        });
    }

    /* ===== Trigger get_frame_cam ===== */
    // EDGE: value = camId string (ex: "2")
    // TABLET/DEFAULT: value = timestamp (keep legacy behavior)
    function triggerGetFrameCam(val) {
        return new Promise((resolve, reject) => {
            attributeService.saveEntityAttributes(self._entityId, 'SHARED_SCOPE', [
                { key: 'get_frame_cam', value: String(val) }
            ]).subscribe(() => resolve(), err => reject(err));
        });
    }

    async function refreshLatestFrame() {
        if (self._mode === 'edge' && !self._activeCam) return;

        setLoading(true);
        try {
            const payload = (self._mode === 'edge') ? String(self._activeCam) : Date.now();
            await triggerGetFrameCam(payload);
            await sleep(2000);
            fetchFrame();
        } catch (e) {
            setLoading(false);
            toast('error', e?.message || t('err_failed_request_frame'));
        }
    }

    /* ===== deviceLabel ===== */
    function loadDeviceLabel() {
        attributeService.getEntityAttributes(self._entityId, 'SERVER_SCOPE', ['deviceLabel'])
            .subscribe(attrs => {
                const a = (attrs || []).find(x => x.key === 'deviceLabel');
                const label = a?.value;

                self._deviceLabel = label;
                if (label === 'tablet-type') self._mode = 'tablet';
                else if (label === 'edge-type') self._mode = 'edge';
                else self._mode = 'default';

                applyModeUI();

                if (self._mode === 'edge') {
                    // ✅ NEW: đọc current_cam trước rồi mới update dropdown
                    loadCurrentCamServer().then(() => {
                        updateCamsFromTelemetry();
                    });
                } else {
                    refreshLatestFrame();
                }
            }, () => { });
    }

    /* =======================================================================================
     * statistic_config (SHARED_SCOPE)
     * ======================================================================================= */
    function getCamStatId() {
        return self._activeCam ? `CAM_${self._activeCam}` : null;
    }

    function readStatisticConfigShared() {
        return new Promise((resolve, reject) => {
            attributeService.getEntityAttributes(self._entityId, 'SHARED_SCOPE', ['statistic_config'])
                .subscribe(attrs => {
                    const a = (attrs || []).find(x => x.key === 'statistic_config');
                    if (!a || a.value == null || a.value === '') { resolve(null); return; }
                    let v = a.value;
                    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep raw */ } }
                    resolve(v);
                }, err => reject(err));
        });
    }

    function writeStatisticConfigShared(cfg) {
        return new Promise((resolve, reject) => {
            attributeService.saveEntityAttributes(self._entityId, 'SHARED_SCOPE', [
                { key: 'statistic_config', value: cfg }
            ]).subscribe(() => resolve(), err => reject(err));
        });
    }

    function applyLoadedFromStatisticConfig(cfg) {
        if (self._mode === 'edge') {
            const camStatId = getCamStatId();
            if (!camStatId || !Array.isArray(cfg)) {
                self._roisNorm = { Detect: [], Region1: [], Region2: [] };
                redraw();
                return;
            }

            const item =
                cfg.find(x => x && x.id === camStatId) ||
                cfg.find(x => x && x.id === String(camStatId));

            const p = item?.point;

            if (Array.isArray(p) && Array.isArray(p[0])) {
                const d = Array.isArray(p[0]) ? p[0] : [];
                const r1 = Array.isArray(p[1]) ? p[1] : [];
                const r2 = Array.isArray(p[2]) ? p[2] : [];
                self._roisNorm.Detect = pixelFlatToNorm(d);
                self._roisNorm.Region1 = pixelFlatToNorm(r1);
                self._roisNorm.Region2 = pixelFlatToNorm(r2);
            } else {
                self._roisNorm = { Detect: [], Region1: [], Region2: [] };
            }

            redraw();
            return;
        }

        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
            // Tablet mode: load polygon points
            const flat = Array.isArray(cfg.points) ? cfg.points : [];
            const pts = pixelFlatToNorm(flat);
            self._tabletPair = pts; // Load all points
        } else {
            self._tabletPair = [];
        }
        redraw();
    }

    function loadShared() {
        return new Promise((resolve, reject) => {
            readStatisticConfigShared().then(cfg => {
                if (!cfg) {
                    self._tabletPair = [];
                    self._roisNorm = { Detect: [], Region1: [], Region2: [] };
                    self._pending = null;
                    redraw();
                    resolve();
                    return;
                }

                if (!self._bgReady) { self._pending = cfg; resolve(); return; }
                applyLoadedFromStatisticConfig(cfg);
                resolve();
            }).catch(reject);
        });
    }

    function saveShared() {
        return new Promise((resolve, reject) => {
            if (self._mode === 'edge') {
                if (!self._activeCam) { reject(new Error(t('err_no_cam_selected'))); return; }
            }

            if (!self._bgReady) {
                reject(new Error(t('err_frame_loading_try_again')));
                return;
            }

            readStatisticConfigShared().then(cfg => {
                if (self._mode === 'edge') {
                    const ok =
                        (self._roisNorm.Detect.length >= 3) &&
                        (self._roisNorm.Region1.length >= 3) &&
                        (self._roisNorm.Region2.length >= 3);

                    if (!ok) {
                        reject(new Error(t('err_need_3_rois')));
                        return;
                    }

                    const camStatId = getCamStatId();
                    const newPoint = [
                        normToPixelFlat(self._roisNorm.Detect),
                        normToPixelFlat(self._roisNorm.Region1),
                        normToPixelFlat(self._roisNorm.Region2)
                    ];

                    if (cfg == null || cfg === '') cfg = [];
                    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { /* ignore */ } }
                    if (!Array.isArray(cfg)) cfg = [];

                    let idx = cfg.findIndex(x => x && x.id === camStatId);
                    if (idx < 0) cfg.push({ id: camStatId, point: newPoint });
                    else cfg[idx].point = newPoint;

                    writeStatisticConfigShared(cfg).then(resolve).catch(reject);
                    return;
                }

                // Tablet Mode: Save Polygon
                // Need at least 3 points for a valid ROI
                if (!self._tabletPair || self._tabletPair.length < 3) {
                    // Reusing the message or using a more generic one if "err_need_3_rois" is too specific
                    // For now, let's say "Need at least 3 points"
                    reject(new Error((self._lang === 'ja') ? 'ROIを作成するには3点以上を選択してください。' : 'Please select at least 3 points to create an ROI.'));
                    return;
                }

                const newPoints = normToPixelFlat(self._tabletPair);

                if (cfg == null || cfg === '') cfg = {};
                if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
                if (Array.isArray(cfg) || typeof cfg !== 'object') cfg = {};

                cfg.points = newPoints;
                writeStatisticConfigShared(cfg).then(resolve).catch(reject);
            }).catch(reject);
        });
    }

    /* ===== Frame HEX -> Image ===== */
    function normalizeHexString(s) {
        if (s == null) return '';
        s = String(s).trim();
        if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
        if (s.toLowerCase().startsWith('hex:')) s = s.slice(4);
        s = s.replace(/[^0-9a-fA-F]/g, '');
        if (s.length % 2 === 1) s = s.slice(0, -1);
        return s;
    }

    function hexToBase64(hexNorm) {
        if (!hexNorm) return '';
        const bytes = new Uint8Array(hexNorm.length / 2);
        for (let i = 0; i < hexNorm.length; i += 2) bytes[i / 2] = parseInt(hexNorm.substr(i, 2), 16);

        const CHUNK = 0x8000;
        let bin = '';
        for (let j = 0; j < bytes.length; j += CHUNK) {
            const sub = bytes.subarray(j, j + CHUNK);
            bin += String.fromCharCode.apply(null, sub);
        }
        return btoa(bin);
    }

    // ✅ FIX: nhận hex đã normalize
    function guessMimeFromHexNorm(hexNorm) {
        if (!hexNorm || hexNorm.length < 16) return 'image/jpeg';
        const h = String(hexNorm).toUpperCase();
        if (h.startsWith('FFD8FF')) return 'image/jpeg';
        if (h.startsWith('89504E470D0A1A0A')) return 'image/png';
        if (h.startsWith('52494646')) return 'image/webp';
        return 'image/jpeg';
    }

    function setFrameSrc(val) {
        let src = val;

        if (typeof val === 'string' && !val.startsWith('data:image')) {
            const hexNorm = normalizeHexString(val);
            if (hexNorm) {
                const mime = guessMimeFromHexNorm(hexNorm);
                const b64 = hexToBase64(hexNorm);
                src = `data:${mime};base64,${b64}`;
            } else {
                // fallback legacy: treat as base64
                src = 'data:image/jpeg;base64,' + val;
            }
        }

        if (self._lastSrc === src) {
            setLoading(false);
            return;
        }

        self._lastSrc = src;
        self._bgReady = false;

        self._bgImg.onload = () => {
            self._bgReady = true;
            setLoading(false);

            if (self._pending != null) {
                applyLoadedFromStatisticConfig(self._pending);
                self._pending = null;
            }

            redraw();
        };

        self._bgImg.onerror = () => {
            self._bgReady = false;
            setLoading(false);
            toast('error', t('err_failed_load_image'));
        };

        self._bgImg.src = src;
    }

    function fetchFrame() {
        if (self._mode === 'tablet' || self._mode === 'default') {
            attributeService.getEntityAttributes(self._entityId, 'CLIENT_SCOPE', ['frame_base64'])
                .subscribe(attrs => {
                    const a = (attrs || []).find(x => x.key === 'frame_base64');
                    if (a?.value) setFrameSrc(a.value);
                    else setLoading(false);
                }, () => setLoading(false));
            return;
        }

        if (!self._activeCam) { setLoading(false); return; }
        const key = `frame_cam${self._activeCam}`;
        attributeService.getEntityAttributes(self._entityId, 'CLIENT_SCOPE', [key])
            .subscribe(attrs => {
                const a = (attrs || []).find(x => x.key === key);
                if (a?.value) setFrameSrc(a.value);
                else setLoading(false);
            }, () => setLoading(false));
    }

    function setActiveCam(camId) {
        if (!camId || self._activeCam === camId) return;
        self._activeCam = camId;

        self._tabletPair = [];
        self._roisNorm = { Detect: [], Region1: [], Region2: [] };
        self._pending = null;
        self._lastSrc = null;

        self._bgReady = false;
        setLoading(true);
        blankWhite();

        loadShared().catch(() => { });

        // ✅ REQUIRED: mỗi lần switch cam đều bắn camId vào get_frame_cam
        refreshLatestFrame();
    }

    /* ===== Click add point ===== */
    function onClickAddPoint(ev) {
        const p = evToPointOnImageNorm(ev);
        if (!p) return;

        if (self._mode === 'edge') {
            self._roisNorm[self._activeRoiName].push(p);
            redraw();
            return;
        }

        if (!self._tabletPair) self._tabletPair = [];
        self._tabletPair.push(p);

        redraw();
    }

    canvasEl.addEventListener('click', onClickAddPoint);
    self._onClickAddPoint = onClickAddPoint;

    /* ===== Toolbar actions ===== */
    self.ctx.$scope.savePolygon = () => runWithFeedback(btnSaveEl, 'Save', () => saveShared());

    self.ctx.$scope.undoPoint = () => runWithFeedback(btnUndoEl, 'Undo', () => {
        if (self._mode === 'edge') {
            const arr = self._roisNorm[self._activeRoiName];
            if (arr.length) arr.pop();
        } else {
            if (self._tabletPair && self._tabletPair.length) self._tabletPair.pop();
        }
        redraw();
    }, { silent: true });

    self.ctx.$scope.clearAll = () => runWithFeedback(btnClearEl, 'Clear', () => {
        if (self._mode === 'edge') self._roisNorm[self._activeRoiName] = [];
        else self._tabletPair = [];
        redraw();
    });

    self.ctx.$scope.reloadSaved = () => runWithFeedback(btnReloadEl, 'Reload', async () => {
        await loadShared();
        await refreshLatestFrame();
    });

    /* ===== Start ===== */
    initI18n();
    loadDeviceLabel();
    loadShared().catch(() => { });
};

self.onDataUpdated = function () {
    try {
        if (self._mode !== 'edge') return;

        const dataArr = self.ctx.data || [];
        const entry = dataArr.find(d => d?.dataKey?.name === 'pass_cam');
        if (!entry || !entry.data?.length) return;

        let v = entry.data[0][1];
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return; } }
        if (!v || typeof v !== 'object') return;

        const camIds = Object.keys(v).sort((a, b) => Number(a) - Number(b));
        const sel = self.ctx.$container.find('.cam-dd')[0];
        if (!sel) return;

        sel.innerHTML = '';
        if (!camIds.length) {
            sel.innerHTML = `<option value="">${(self._lang === 'ja') ? 'カメラなし' : 'No camera'}</option>`;
            self._activeCam = null;
            return;
        }

        camIds.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = `${self._camPrefixText || 'Cam'} ${id}`;
            sel.appendChild(opt);
        });

        // ✅ CHANGED: ưu tiên activeCam -> preferredCamId(current_cam) -> cam đầu
        const next =
            (self._activeCam && camIds.includes(self._activeCam)) ? self._activeCam :
                (self._preferredCamId && camIds.includes(self._preferredCamId)) ? self._preferredCamId :
                    camIds[0];

        sel.value = next;

        if (next !== self._activeCam) {
            self._activeCam = null;
            sel.dispatchEvent(new Event('change'));
        }
    } catch (e) { }
};

self.onDestroy = function () {
    try {
        if (self._ro) self._ro.disconnect();
        if (self._onClickAddPoint) {
            self.ctx.$container.find('canvas')[0].removeEventListener('click', self._onClickAddPoint);
        }
        if (typeof self._unsubTranslate === 'function') self._unsubTranslate();
    } catch (e) { }
};
