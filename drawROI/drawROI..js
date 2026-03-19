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
    const flowLegendEl = $c.find('.flow-legend')[0];
    const legendPassEl = $c.find('.legend-pass-label')[0];
    const legendOutEl = $c.find('.legend-out-label')[0];
    const toastCenter = $c.find('.toast-center')[0];
    const roiHintEl = $c.find('.roi-hint')[0];

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
    self._camsRefreshPromise = null;
    self._lastCamsRefreshAt = 0;

    // ✅ NEW: ưu tiên cam hiển thị ban đầu (đọc từ SERVER_SCOPE.current_cam)
    self._preferredCamId = null;

    self._bgImg = new Image();
    self._bgReady = false;
    self._lastSrc = null;

    self._imgDraw = { offX: 0, offY: 0, drawW: 0, drawH: 0 };

    self._tabletPair = []; // [{x,y}] or [{x,y},{x,y}]
    self._lineTypes = [null, null, null, null]; // per edge: in_out | null
    self._hoverEdgeIdx = null;
    self._selectedEdgeIdx = null;
    self._justAddedPoint = false;
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
            tip_save: 'Save',
            tip_undo: 'Undo',
            tip_clear: 'Delete',
            tip_reload: 'Reload',
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
            err_failed_load_image: 'Failed to load frame image.',
            err_need_4_points: 'Please select exactly 4 points to create ROI.',
            err_need_in_out: 'Please select at least one IN_OUT line.',
            err_invalid_stat_cfg: 'Invalid statistic_config format.',
            hint_tablet: 'Draw ROI with 4 points, then tap the red edge to toggle counting line.',
            hint_edge: 'Select Zone, then tap points to draw ROI.',
            legend_pass: 'Pass',
            legend_out: 'Exit'
        },
        ja: {
            save: '保存',
            undo: '元に戻す',
            clear: 'クリア',
            reload: '再読み込み',
            tip_save: '保存',
            tip_undo: '元に戻す',
            tip_clear: '削除',
            tip_reload: '再読み込み',
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
            err_failed_load_image: 'フレーム画像の読み込みに失敗しました。',
            err_need_4_points: 'ROIを作成するには4点を選択してください。',
            err_need_in_out: 'IN_OUTの線を1本以上選択してください。',
            err_invalid_stat_cfg: 'statistic_configの形式が不正です。',
            hint_tablet: '4点でROIを描画し、赤い辺をタップしてカウント線を切り替えます。',
            hint_edge: 'Detect/Region1/Region2を選択し、点をタップしてROIを描画します。',
            legend_pass: '通過',
            legend_out: '退出'
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
        if (btnSaveEl) { btnSaveEl.setAttribute('data-tip', t('tip_save')); btnSaveEl.setAttribute('aria-label', t('tip_save')); }
        if (btnUndoEl) { btnUndoEl.setAttribute('data-tip', t('tip_undo')); btnUndoEl.setAttribute('aria-label', t('tip_undo')); }
        if (btnClearEl) { btnClearEl.setAttribute('data-tip', t('tip_clear')); btnClearEl.setAttribute('aria-label', t('tip_clear')); }
        if (btnReloadEl) { btnReloadEl.setAttribute('data-tip', t('tip_reload')); btnReloadEl.setAttribute('aria-label', t('tip_reload')); }

        if (camLabelEl) camLabelEl.textContent = t('camera');
        if (loadingTextEl) loadingTextEl.textContent = t('loading');
        if (legendPassEl) legendPassEl.textContent = t('legend_pass');
        if (legendOutEl) legendOutEl.textContent = t('legend_out');
        updateHint();

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

    function updateHint() {
        if (!roiHintEl) return;
        if (self._mode === 'tablet') {
            roiHintEl.classList.remove('is-edge');
            roiHintEl.innerHTML = `
                <span class="hint-text">${t('hint_tablet')}</span>
                <span class="hint-chips">
                    <span class="hint-chip flow-item flow-pass">
                        <span class="flow-arrow"></span>
                        <span>${t('legend_pass')}</span>
                    </span>
                    <span class="hint-chip flow-item flow-out">
                        <span class="flow-arrow"></span>
                        <span>${t('legend_out')}</span>
                    </span>
                </span>
            `;
            roiHintEl.style.display = '';
        } else if (self._mode === 'edge') {
            roiHintEl.classList.add('is-edge');
            roiHintEl.textContent = t('hint_edge');
            roiHintEl.style.display = '';
        } else {
            roiHintEl.style.display = 'none';
        }
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

    function isCoarsePointer() {
        try {
            return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        } catch (e) {
            return false;
        }
    }

    function isSmallScreen() {
        try {
            return window.innerWidth <= 768;
        } catch (e) {
            return false;
        }
    }

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

    function normToCanvasPt(p) {
        const r = self._imgDraw;
        return { x: r.offX + p.x * r.drawW, y: r.offY + p.y * r.drawH };
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

    function polygonAreaNorm(pointsNorm) {
        if (!pointsNorm || pointsNorm.length < 3) return 0;
        let sum = 0;
        for (let i = 0; i < pointsNorm.length; i++) {
            const p1 = pointsNorm[i];
            const p2 = pointsNorm[(i + 1) % pointsNorm.length];
            sum += (p1.x * p2.y) - (p2.x * p1.y);
        }
        return Math.abs(sum) / 2;
    }

    function dist2PointToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        if (dx === 0 && dy === 0) {
            const ox = px - x1;
            const oy = py - y1;
            return ox * ox + oy * oy;
        }
        const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
        const tt = Math.max(0, Math.min(1, t));
        const cx = x1 + tt * dx;
        const cy = y1 + tt * dy;
        const ox = px - cx;
        const oy = py - cy;
        return ox * ox + oy * oy;
    }

    function pointInPolygon(px, py, polyPts) {
        if (!polyPts || polyPts.length < 3) return false;
        let inside = false;
        for (let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            const xi = polyPts[i].x;
            const yi = polyPts[i].y;
            const xj = polyPts[j].x;
            const yj = polyPts[j].y;
            const den = (yj - yi) || 1e-9;
            const crossX = ((xj - xi) * (py - yi)) / den + xi;
            const intersects = ((yi > py) !== (yj > py)) && (px < crossX);
            if (intersects) inside = !inside;
        }
        return inside;
    }

    function getInwardNormalForEdge(p1, p2, polyCanvasPts) {
        const ex = p2.x - p1.x;
        const ey = p2.y - p1.y;
        const edgeLen = Math.hypot(ex, ey);
        if (edgeLen < 1e-6) return null;

        const nLeft = { x: -ey / edgeLen, y: ex / edgeLen };
        const nRight = { x: -nLeft.x, y: -nLeft.y };
        const mx = (p1.x + p2.x) * 0.5;
        const my = (p1.y + p2.y) * 0.5;
        const probe = Math.max(10, Math.min(24, edgeLen * 0.16));

        const leftInside = pointInPolygon(mx + nLeft.x * probe, my + nLeft.y * probe, polyCanvasPts);
        const rightInside = pointInPolygon(mx + nRight.x * probe, my + nRight.y * probe, polyCanvasPts);
        if (leftInside !== rightInside) return leftInside ? nLeft : nRight;

        // Fallback for ambiguous boundaries: choose normal toward polygon centroid.
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < polyCanvasPts.length; i++) {
            cx += polyCanvasPts[i].x;
            cy += polyCanvasPts[i].y;
        }
        cx /= polyCanvasPts.length || 1;
        cy /= polyCanvasPts.length || 1;
        const dotLeft = (cx - mx) * nLeft.x + (cy - my) * nLeft.y;
        const dotRight = (cx - mx) * nRight.x + (cy - my) * nRight.y;
        return (dotLeft >= dotRight) ? nLeft : nRight;
    }

    function drawFlowArrow(cx, cy, dirX, dirY, style, geom) {
        const mag = Math.hypot(dirX, dirY);
        if (mag < 1e-6) return;

        const ux = dirX / mag;
        const uy = dirY / mag;
        const len = geom.len;
        const shaftH = geom.shaftH;
        const headL = geom.headL;

        const halfShaft = shaftH * 0.5;
        const headHalf = Math.max(halfShaft + 2, shaftH * 0.72);
        const xStart = -len * 0.5;
        const xHeadBase = len * 0.5 - headL;
        const xTip = len * 0.5;

        g.save();
        g.translate(cx, cy);
        g.rotate(Math.atan2(uy, ux));

        g.shadowColor = 'rgba(15,23,42,0.30)';
        g.shadowBlur = 8;
        g.shadowOffsetY = 2;

        const grad = g.createLinearGradient(xStart, 0, xTip, 0);
        grad.addColorStop(0, style.fillA || style.fill);
        grad.addColorStop(1, style.fillB || style.fill);

        g.fillStyle = grad;
        g.strokeStyle = style.stroke;
        g.lineWidth = 1.7;

        g.beginPath();
        g.moveTo(xStart, -halfShaft);
        g.lineTo(xHeadBase, -halfShaft);
        g.lineTo(xHeadBase, -headHalf);
        g.lineTo(xTip, 0);
        g.lineTo(xHeadBase, headHalf);
        g.lineTo(xHeadBase, halfShaft);
        g.lineTo(xStart, halfShaft);
        g.closePath();
        g.fill();
        g.stroke();

        g.shadowColor = 'transparent';
        g.beginPath();
        g.moveTo(xStart + 4, -halfShaft + 2.2);
        g.lineTo(xHeadBase - 4, -halfShaft + 2.2);
        g.lineTo(xHeadBase - 1.4, -1.4);
        g.strokeStyle = 'rgba(255,255,255,0.34)';
        g.lineWidth = 1.15;
        g.stroke();

        g.beginPath();
        g.moveTo(xStart + 3, halfShaft - 1.8);
        g.lineTo(xHeadBase - 3.6, halfShaft - 1.8);
        g.strokeStyle = 'rgba(15,23,42,0.2)';
        g.lineWidth = 1.05;
        g.stroke();

        g.restore();
    }

    function drawInOutArrowsForEdge(p1, p2, polyCanvasPts) {
        const ex = p2.x - p1.x;
        const ey = p2.y - p1.y;
        const edgeLen = Math.hypot(ex, ey);
        if (edgeLen < 24) return;

        const tx = ex / edgeLen;
        const ty = ey / edgeLen;
        const inward = getInwardNormalForEdge(p1, p2, polyCanvasPts);
        if (!inward) return;
        const outward = { x: -inward.x, y: -inward.y };

        const arrowLen = Math.max(58, Math.min(88, edgeLen * 0.58));
        const shaftH = Math.max(18, Math.min(26, arrowLen * 0.34));
        const headL = Math.max(16, Math.min(24, arrowLen * 0.34));
        const tangentShift = Math.min(edgeLen * 0.22, arrowLen * 0.42);

        const mx = (p1.x + p2.x) * 0.5;
        const my = (p1.y + p2.y) * 0.5;

        const inCenter = {
            x: mx + tx * tangentShift,
            y: my + ty * tangentShift
        };
        const outCenter = {
            x: mx - tx * tangentShift,
            y: my - ty * tangentShift
        };

        drawFlowArrow(inCenter.x, inCenter.y, inward.x, inward.y, {
            fillA: 'rgba(52,211,153,0.96)',
            fillB: 'rgba(22,163,74,0.96)',
            stroke: '#166534'
        }, { len: arrowLen, shaftH: shaftH, headL: headL });

        drawFlowArrow(outCenter.x, outCenter.y, outward.x, outward.y, {
            fillA: 'rgba(251,113,133,0.95)',
            fillB: 'rgba(239,68,68,0.95)',
            stroke: '#991b1b'
        }, { len: arrowLen, shaftH: shaftH, headL: headL });
    }

    function getEdgeIndexAtPos(ev) {
        if (!self._tabletPair || self._tabletPair.length !== 4) return null;
        const r = canvasEl.getBoundingClientRect();
        const mx = ev.clientX - r.left;
        const my = ev.clientY - r.top;
        const img = self._imgDraw;
        if (mx < img.offX || mx > img.offX + img.drawW || my < img.offY || my > img.offY + img.drawH) return null;

        const pts = self._tabletPair.map(normToCanvasPt);
        let bestIdx = null;
        let bestDist2 = Infinity;
        const hitRadius = (isCoarsePointer() || isSmallScreen()) ? 18 : 8;
        const hit2 = hitRadius * hitRadius;
        for (let i = 0; i < 4; i++) {
            const p1 = pts[i];
            const p2 = pts[(i + 1) % 4];
            const d2 = dist2PointToSegment(mx, my, p1.x, p1.y, p2.x, p2.y);
            if (d2 < hit2 && d2 < bestDist2) {
                bestDist2 = d2;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    function getLatestPointsFromCfg(cfg) {
        if (!cfg || !Array.isArray(cfg.points) || !cfg.points.length) return [];
        const isZeroFlat = (flat) => Array.isArray(flat) && flat.length >= 4 && flat.every(v => Number(v) === 0);
        const isValidFlat = (flat) => Array.isArray(flat) && flat.length >= 8 && !isZeroFlat(flat);

        if (typeof cfg.points[0] === 'number') {
            return isValidFlat(cfg.points) ? cfg.points : [];
        }
        if (Array.isArray(cfg.points[0])) {
            for (let i = cfg.points.length - 1; i >= 0; i--) {
                const candidate = cfg.points[i];
                if (isValidFlat(candidate)) return candidate;
            }
            return [];
        }
        return [];
    }

    /* ===== Mode UI ===== */
    function applyModeUI() {
        if (camBoxEl) camBoxEl.style.display = (self._mode === 'tablet') ? 'none' : 'flex';
        if (flowLegendEl) {
            const showLegend = (self._mode === 'tablet' || self._mode === 'edge');
            flowLegendEl.style.display = showLegend ? 'flex' : 'none';
            flowLegendEl.setAttribute('data-mode', (self._mode === 'edge') ? 'edge' : 'tablet');
        }

        if (self._mode === 'edge') {
            if (roiSwitchEl) roiSwitchEl.style.display = 'flex';
            setActiveRoi(self._activeRoiName || 'Detect');
        } else {
            if (roiSwitchEl) roiSwitchEl.style.display = 'none';
        }
        updateHint();
        updateCursor();
    }

    /* ===== Cursor Management ===== */
    function updateCursor() {
        if (isCoarsePointer()) {
            if (canvasEl) canvasEl.style.cursor = 'default';
            return;
        }
        // Update cursor based on mode and polygon state
        if (self._mode === 'tablet' && self._tabletPair && self._tabletPair.length === 4) {
            // When 4 points are drawn, switch to pointer cursor for clicking edges
            if (canvasEl) canvasEl.classList.add('can-click-edge');
        } else {
            // Otherwise use crosshair for drawing
            if (canvasEl) canvasEl.classList.remove('can-click-edge');
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

        // Update cursor based on state
        updateCursor();
    }

    function drawTabletPolygon(points) {
        if (!points || !points.length) return;
        const r = self._imgDraw;
        const baseColor = '#F44336';
        const lineColors = { in_out: '#1E88E5', base: baseColor };
        const polyCanvasPts = points.map((p) => ({
            x: r.offX + p.x * r.drawW,
            y: r.offY + p.y * r.drawH
        }));
        const inOutEdges = [];

        g.save();
        g.strokeStyle = baseColor; // Red
        g.fillStyle = baseColor;
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

        // Draw lines (color per edge for IN/OUT)
        if (points.length >= 2) {
            const closeLoop = points.length >= 3;
            const edgeCount = closeLoop ? points.length : points.length - 1;
            for (let i = 0; i < edgeCount; i++) {
                const p1 = points[i];
                const p2 = points[(i + 1) % points.length];
                const type = (points.length === 4 && self._lineTypes && self._lineTypes[i]) ? self._lineTypes[i] : null;
                const isHover = (self._hoverEdgeIdx === i);
                g.strokeStyle = lineColors[type] || lineColors.base;
                g.lineWidth = type ? (isHover ? 3.8 : 3.2) : (isHover ? 3.2 : 2.6);
                g.globalAlpha = isHover ? 1 : 0.92;
                if (isHover) {
                    g.save();
                    g.shadowColor = 'rgba(0,0,0,0.35)';
                    g.shadowBlur = 6;
                    g.shadowOffsetY = 2;
                    g.lineWidth = g.lineWidth + 0.8;
                    g.beginPath();
                    g.moveTo(r.offX + p1.x * r.drawW, r.offY + p1.y * r.drawH);
                    g.lineTo(r.offX + p2.x * r.drawW, r.offY + p2.y * r.drawH);
                    g.stroke();
                    g.restore();
                }
                g.beginPath();
                g.moveTo(r.offX + p1.x * r.drawW, r.offY + p1.y * r.drawH);
                g.lineTo(r.offX + p2.x * r.drawW, r.offY + p2.y * r.drawH);
                g.stroke();

                if (type === 'in_out' && points.length === 4) {
                    inOutEdges.push({
                        p1: { x: r.offX + p1.x * r.drawW, y: r.offY + p1.y * r.drawH },
                        p2: { x: r.offX + p2.x * r.drawW, y: r.offY + p2.y * r.drawH }
                    });
                }
            }
        }

        if (inOutEdges.length && polyCanvasPts.length >= 3) {
            for (let i = 0; i < inOutEdges.length; i++) {
                drawInOutArrowsForEdge(inOutEdges[i].p1, inOutEdges[i].p2, polyCanvasPts);
            }
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
        g.lineJoin = 'round';
        g.lineCap = 'round';
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
            if (pointsNorm.length >= 3) g.closePath();
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
    function normalizeCamId(v) {
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
                        self._preferredCamId = normalizeCamId(a?.value);
                        resolve(self._preferredCamId);
                    },
                    () => resolve(null)
                );
        });
    }

    /* ===== Edge camera list from statistic_config (SHARED_SCOPE) ===== */
    function getCamIdsFromStatisticConfig(cfg) {
        if (!Array.isArray(cfg)) return [];

        const seen = Object.create(null);
        const camIds = [];
        for (let i = 0; i < cfg.length; i++) {
            const camId = normalizeCamId(cfg[i]?.id);
            if (!camId || seen[camId]) continue;
            seen[camId] = true;
            camIds.push(camId);
        }

        camIds.sort((a, b) => Number(a) - Number(b));
        return camIds;
    }

    function renderCamOptions(camIds) {
        self._cams = Array.isArray(camIds) ? camIds.slice() : [];

        if (!selectEl) return;

        selectEl.innerHTML = '';
        if (!self._cams.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = t('noCamera');
            selectEl.appendChild(opt);
            self._activeCam = null;
            return;
        }

        self._cams.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = `${self._camPrefixText} ${id}`;
            selectEl.appendChild(opt);
        });

        const next =
            (self._activeCam && self._cams.includes(self._activeCam)) ? self._activeCam :
                (self._preferredCamId && self._cams.includes(self._preferredCamId)) ? self._preferredCamId :
                    self._cams[0];

        selectEl.value = next || '';

        if (!next) {
            self._activeCam = null;
            return;
        }

        if (next !== self._activeCam) setActiveCam(next);
    }

    function updateCamsFromStatisticConfig(cfg) {
        renderCamOptions(getCamIdsFromStatisticConfig(cfg));
    }

    function refreshCamsFromShared(force) {
        if (self._mode !== 'edge') return Promise.resolve([]);

        const now = Date.now();
        if (!force && self._camsRefreshPromise) return self._camsRefreshPromise;
        if (!force && self._lastCamsRefreshAt && (now - self._lastCamsRefreshAt) < 1500) {
            return Promise.resolve(self._cams.slice());
        }

        self._camsRefreshPromise = readStatisticConfigShared()
            .then(cfg => {
                updateCamsFromStatisticConfig(cfg);
                self._lastCamsRefreshAt = Date.now();
                return self._cams.slice();
            })
            .catch(() => {
                renderCamOptions([]);
                self._lastCamsRefreshAt = Date.now();
                return [];
            })
            .finally(() => {
                self._camsRefreshPromise = null;
            });

        return self._camsRefreshPromise;
    }

    self._refreshCamsFromShared = refreshCamsFromShared;

    if (selectEl) {
        selectEl.addEventListener('change', () => {
            const camId = selectEl.value;
            if (camId) setActiveCam(camId);
            else self._activeCam = null;
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
                    // Read current_cam first, then populate camera dropdown from statistic_config.
                    loadCurrentCamServer().then(() => {
                        refreshCamsFromShared(true);
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

    function normalizeRuleValue(v) {
        if (!v) return 'none';
        const s = String(v).toLowerCase();
        if (s === 'in_out' || s === 'inout') return 'in_out';
        return 'none';
    }

    function rulesFromCfg(cfg) {
        const raw = cfg?.rules;
        if (!Array.isArray(raw)) return [];
        return raw.map(normalizeRuleValue);
    }

    function edgeFlatListFromPoints(pointsNorm) {
        if (!pointsNorm || pointsNorm.length !== 4) return [];
        const imgW = self._bgImg.naturalWidth || 1;
        const imgH = self._bgImg.naturalHeight || 1;
        const edges = [];
        for (let i = 0; i < 4; i++) {
            const a = pointsNorm[i];
            const b = pointsNorm[(i + 1) % 4];
            edges.push([
                Math.round(a.x * imgW), Math.round(a.y * imgH),
                Math.round(b.x * imgW), Math.round(b.y * imgH)
            ]);
        }
        return edges;
    }

    function applyLineTypesFromConfig(cfg) {
        self._lineTypes = [null, null, null, null];
        if (!self._tabletPair || self._tabletPair.length !== 4) return;
        const rules = rulesFromCfg(cfg);
        if (rules.length === 4) {
            for (let i = 0; i < 4; i++) {
                const r = rules[i];
                self._lineTypes[i] = (r === 'in_out') ? 'in_out' : null;
            }
        }
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
            const flat = getLatestPointsFromCfg(cfg);
            const pts = pixelFlatToNorm(flat);
            self._tabletPair = pts; // Load all points
            applyLineTypesFromConfig(cfg);
        } else {
            self._tabletPair = [];
            self._lineTypes = [null, null, null, null];
        }
        redraw();
    }

    function loadShared() {
        return new Promise((resolve, reject) => {
            readStatisticConfigShared().then(cfg => {
                if (self._mode === 'edge') updateCamsFromStatisticConfig(cfg);

                if (!cfg) {
                    self._tabletPair = [];
                    self._lineTypes = [null, null, null, null];
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
                if (!self._tabletPair || self._tabletPair.length !== 4) {
                    reject(new Error(t('err_need_4_points')));
                    return;
                }
                if (polygonAreaNorm(self._tabletPair) < 0.00001) {
                    reject(new Error(t('err_need_4_points')));
                    return;
                }

                const hasInOut = self._lineTypes && self._lineTypes.some(x => x === 'in_out');
                if (!hasInOut) {
                    reject(new Error(t('err_need_in_out')));
                    return;
                }

                const newPoints = normToPixelFlat(self._tabletPair);

                if (cfg == null || cfg === '') cfg = {};
                if (typeof cfg === 'string') {
                    try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
                }
                if (Array.isArray(cfg) || typeof cfg !== 'object') {
                    cfg = {};
                }

                cfg.points = newPoints;
                cfg.rules = self._lineTypes.map(v => (v === 'in_out') ? 'IN_OUT' : 'NONE');
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

        if (self._mode === 'tablet' && getEdgeIndexAtPos(ev) != null) return;
        if (!self._tabletPair) self._tabletPair = [];
        if (self._tabletPair.length >= 4) return;
        self._tabletPair.push(p);
        if (self._tabletPair.length === 4) self._lineTypes = [null, null, null, null];

        self._justAddedPoint = true;
        setTimeout(() => { self._justAddedPoint = false; }, 0);
        redraw();
    }

    canvasEl.addEventListener('click', onClickAddPoint);
    self._onClickAddPoint = onClickAddPoint;

    function onCanvasClick(ev) {
        if (self._mode !== 'tablet' || !self._bgReady) {
            return;
        }
        if (self._justAddedPoint) {
            return;
        }
        if (!self._tabletPair || self._tabletPair.length !== 4) {
            return;
        }
        const idx = getEdgeIndexAtPos(ev);
        if (idx == null) {
            return;
        }
        self._selectedEdgeIdx = idx;
        self._hoverEdgeIdx = idx;
        const curr = self._lineTypes[idx];
        self._lineTypes[idx] = (curr === 'in_out') ? null : 'in_out';
        redraw();
    }

    function onCanvasHover(ev) {
        if (isCoarsePointer()) return;
        if (self._mode !== 'tablet' || !self._bgReady) return;
        const idx = getEdgeIndexAtPos(ev);
        if (idx !== self._hoverEdgeIdx) {
            self._hoverEdgeIdx = idx;
            // Update cursor when hovering over edge
            if (self._tabletPair && self._tabletPair.length === 4 && canvasEl) {
                canvasEl.style.cursor = (idx !== null) ? 'pointer' : 'default';
            }
            redraw();
        }
    }

    function onCanvasLeave(ev) {
        if (self._hoverEdgeIdx != null) {
            self._hoverEdgeIdx = null;
            redraw();
        }
        // Reset cursor when leaving canvas
        updateCursor();
    }

    if (canvasEl) {
        canvasEl.addEventListener('click', onCanvasClick);
        canvasEl.addEventListener('mousemove', onCanvasHover);
        canvasEl.addEventListener('mouseleave', onCanvasLeave);
        canvasEl.addEventListener('touchstart', onCanvasLeave, { passive: true });
    }

    /* ===== Toolbar actions ===== */
    self.ctx.$scope.savePolygon = () => runWithFeedback(btnSaveEl, 'Save', () => saveShared());

    self.ctx.$scope.undoPoint = () => runWithFeedback(btnUndoEl, 'Undo', () => {
        if (self._mode === 'edge') {
            const arr = self._roisNorm[self._activeRoiName];
            if (arr.length) arr.pop();
        } else {
            if (self._tabletPair && self._tabletPair.length) self._tabletPair.pop();
            self._lineTypes = [null, null, null, null];
            updateCursor();
        }
        redraw();
    }, { silent: true });

    self.ctx.$scope.clearAll = () => runWithFeedback(btnClearEl, 'Clear', () => {
        if (self._mode === 'edge') self._roisNorm[self._activeRoiName] = [];
        else {
            self._tabletPair = [];
            self._lineTypes = [null, null, null, null];
            updateCursor();
        }
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
        if (typeof self._refreshCamsFromShared === 'function') {
            self._refreshCamsFromShared(false);
        }
    } catch (e) { }
};

self.onDestroy = function () {
    try {
        if (self._ro) self._ro.disconnect();
        if (self._onClickAddPoint) {
            self.ctx.$container.find('canvas')[0].removeEventListener('click', self._onClickAddPoint);
        }
        if (canvasEl) {
            canvasEl.removeEventListener('click', onCanvasClick);
            canvasEl.removeEventListener('mousemove', onCanvasHover);
            canvasEl.removeEventListener('mouseleave', onCanvasLeave);
        }
        if (typeof self._unsubTranslate === 'function') self._unsubTranslate();
    } catch (e) { }
};
