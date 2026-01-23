(function () {
  // ================== CONFIG ==================
  const DEFAULT_KEY = 'pass_total';

  // ✅ Chọn logic tại đây:
  // 'SUM_BUCKETS' | 'DELTA_MAX_MIN' | 'POSITIVE_DELTAS'
  const AGG_MODE = 'SUM_BUCKETS';

  const UPDATE_DEBOUNCE_MS = 120;
  const QUIET_TIME_MS = 220;       // coalesce rapid state/timewindow changes
  const SAME_SIG_SKIP_WINDOW_MS = 600;
  const OVERLAY_DELAY_MS = 180;    // avoid flicker on fast refreshes
  // ===========================================

  let pendingUpdateTimeout = null;
  let refreshTimer = null;
  let lastAppliedSig = null;
  let lastAppliedAt = 0;
  let refreshSeq = 0;
  let isFetching = false;
  let needsRerun = false;

  let originalSubBackup = null;
  let lastModeApplied = null;
  let lastSingleIdApplied = null;

  // overlay
  let overlayEl = null;
  let overlayStyleEl = null;
  let overlayTimer = null;

  // version + abort
  let fetchSeq = 0;
  let activeAbort = null;

  let lastSig = null;

  function safeGetToken() {
    try { return localStorage.getItem('jwt_token') || localStorage.getItem('token') || ''; }
    catch (e) { return ''; }
  }

  function getHost() {
    return (self.ctx.$container && self.ctx.$container[0]) ? self.ctx.$container[0] :
      (self.ctx.$widgetContainer && self.ctx.$widgetContainer[0]) ? self.ctx.$widgetContainer[0] :
        null;
  }

  function ensureOverlay() {
    if (overlayEl) return;

    const host = getHost();
    if (!host) return;

    const cs = window.getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';

    overlayStyleEl = document.createElement('style');
    overlayStyleEl.textContent = `
      .tb-spin-overlay{
        position:absolute; inset:0;
        display:none;
        align-items:center; justify-content:center;
        background:#ffffff;
        opacity:1;
        z-index:999999;
        pointer-events:all;
      }
      .tb-spin-overlay.show{ display:flex; }
      .tb-spin{
        width:42px; height:42px;
        border:4px solid rgba(237, 28, 36, 0.25);
        border-top-color:#ED1C24;
        border-radius:50%;
        animation: tbspin 0.9s linear infinite;
      }
      @keyframes tbspin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(overlayStyleEl);

    overlayEl = document.createElement('div');
    overlayEl.className = 'tb-spin-overlay';
    overlayEl.innerHTML = `<div class="tb-spin"></div>`;
    host.appendChild(overlayEl);
  }

  function showOverlayDelayed() {
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      ensureOverlay();
      if (overlayEl) {
        overlayEl.classList.add('show');
      }
    }, OVERLAY_DELAY_MS);
  }
  function hideOverlay() {
    if (overlayTimer) {
      clearTimeout(overlayTimer);
      overlayTimer = null;
    }
    if (overlayEl) overlayEl.classList.remove('show');
  }

  function extractDeviceId(ent) {
    if (!ent) return null;
    if (typeof ent === 'string') return ent;
    if (typeof ent.id === 'string') return ent.id;
    if (ent.id && typeof ent.id.id === 'string') return ent.id.id;
    if (ent.entityId && typeof ent.entityId.id === 'string') return ent.entityId.id;
    return null;
  }

  function dedupe(arr) {
    const out = [];
    const set = new Set();
    (arr || []).forEach(x => {
      const v = String(x || '').trim();
      if (v && !set.has(v)) { set.add(v); out.push(v); }
    });
    return out;
  }

  function readStateParams() {
    const sc = self.ctx && self.ctx.stateController;
    if (!sc) return {};
    try { const p = sc.getStateParams(); if (p && typeof p === 'object') return p; } catch (e) { }
    try { const p2 = sc.getStateParams('default'); if (p2 && typeof p2 === 'object') return p2; } catch (e) { }
    return {};
  }

  function getSelectedMode(stateParams) {
    const m = stateParams.selectedDeviceMode || stateParams.mode;
    return m === 'ALL' ? 'ALL' : 'SINGLE';
  }

  function getSingleIdFromStateOrCtx(stateParams) {
    const direct = stateParams.selectedDeviceId || stateParams.id || (stateParams.entityId && stateParams.entityId.id);
    if (direct) return String(direct);
    const idsFromCtx = getDeviceIdsFromCtxDatasources();
    return idsFromCtx.length ? String(idsFromCtx[0]) : '';
  }

  function getAllDeviceIdsFromState(stateParams) {
    const list = stateParams.entities || stateParams.entityIds || [];
    const ids = [];
    if (Array.isArray(list)) list.forEach(e => { const id = extractDeviceId(e); if (id) ids.push(id); });
    else { const id = extractDeviceId(list); if (id) ids.push(id); }
    return dedupe(ids);
  }

  function getDeviceIdsFromCtxDatasources() {
    const ids = [];
    const dsList =
      self.ctx?.defaultSubscription?.datasources ||
      self.ctx?.defaultSubscription?.dataSources ||
      self.ctx?.datasources ||
      self.ctx?.dataSources ||
      [];

    (dsList || []).forEach(ds => {
      const id =
        extractDeviceId(ds?.entityId) ||
        extractDeviceId(ds?.entity?.id) ||
        extractDeviceId(ds?.entity) ||
        extractDeviceId(ds?.entityId?.id);
      if (id) ids.push(id);
    });

    return dedupe(ids);
  }

  // ✅ ALL ids: ưu tiên state, fallback ctx
  function getAllIdsRobust(stateParams) {
    const fromState = getAllDeviceIdsFromState(stateParams);
    if (fromState.length > 1) return fromState;

    const fromCtx = getDeviceIdsFromCtxDatasources();
    if (fromCtx.length > 1) return fromCtx;

    return fromState.length ? fromState : fromCtx;
  }

  function normalizeKeyName(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const parts = s.split(':').map(x => x.trim()).filter(Boolean);
    return (parts.length ? parts[parts.length - 1] : s).trim();
  }

  function getConfiguredKeyName() {
    const sub = self.ctx.defaultSubscription;
    const candidates = [
      sub?.data?.[0]?.dataKey?.name,
      sub?.dataKeys?.[0]?.name,
      self.ctx?.datasources?.[0]?.dataKeys?.[0]?.name,
      DEFAULT_KEY
    ];
    const picked = candidates.find(x => x != null && String(x).trim() !== '');
    return normalizeKeyName(picked) || DEFAULT_KEY;
  }

  function getTimeWindow() {
    const tw = self.ctx.defaultSubscription?.subscriptionTimewindow;
    const startTs = tw?.minTime || tw?.fixedWindow?.startTimeMs;
    const endTs = tw?.maxTime || tw?.fixedWindow?.endTimeMs;
    return { startTs, endTs };
  }

  function pickIntervalMs(startTs, endTs) {
    const span = Number(endTs) - Number(startTs);
    const DAY = 24 * 60 * 60 * 1000;
    if (span <= 2 * DAY) return 60 * 60 * 1000;
    if (span <= 60 * DAY) return DAY;
    return 30 * DAY;
  }

  // ========= Backup/restore + inject (FIX datasource mixing) =========
  function backupSubscriptionIfNeeded() {
    const sub = self.ctx.defaultSubscription;
    if (!sub || originalSubBackup) return;

    // deep clone full arrays
    originalSubBackup = {
      data: JSON.parse(JSON.stringify(sub.data || [])),
      latestData: JSON.parse(JSON.stringify(sub.latestData || [])),
    };
  }

  function restoreSubscriptionBackup() {
    const sub = self.ctx.defaultSubscription;
    if (!sub || !originalSubBackup) return;

    sub.data = JSON.parse(JSON.stringify(originalSubBackup.data || []));
    sub.latestData = JSON.parse(JSON.stringify(originalSubBackup.latestData || []));
    originalSubBackup = null;
  }

  // ép subscription chỉ còn 1 series => widget không thể “đọc nhầm” series khác
  function injectAggregatedValueToSubscription(value) {
    const sub = self.ctx.defaultSubscription;
    if (!sub?.data?.length) return;

    const now = Date.now();

    sub.data = [sub.data[0]];
    sub.data[0].data = [[now, value]];

    if (Array.isArray(sub.latestData) && sub.latestData.length) {
      sub.latestData = [sub.latestData[0]];
      sub.latestData[0].data = [[now, value]];
    }
  }

  function renderCard() {
    try { self.ctx.$scope.aggregatedValueCardWidget.onDataUpdated(); } catch (e) { }
    try { self.ctx.$scope.aggregatedValueCardWidget.onLatestDataUpdated(); } catch (e) { }
    try { self.ctx.detectChanges(); } catch (e) { }
  }

  // ========= Fetch helpers =========
  async function fetchTimeseries(deviceId, keyName, startTs, endTs, agg, interval, limit, signal) {
    const token = safeGetToken();
    const url =
      `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries` +
      `?keys=${encodeURIComponent(keyName)}` +
      `&startTs=${Number(startTs)}` +
      `&endTs=${Number(endTs)}` +
      `&agg=${encodeURIComponent(agg)}` +
      (interval != null ? `&interval=${Number(interval)}` : '') +
      (limit != null ? `&limit=${Number(limit)}` : '');

    const res = await fetch(url, {
      method: 'GET',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Authorization': 'Bearer ' + token } : {})
      }
    });

    if (!res.ok) return [];
    const data = await res.json();
    const arr = data && data[keyName] ? data[keyName] : [];
    return Array.isArray(arr) ? arr : [];
  }

  function sumBucketValues(points) {
    let s = 0;
    for (const p of (points || [])) {
      const v = Number(p?.value);
      if (Number.isFinite(v)) s += v;
    }
    return s;
  }

  function computePositiveDeltasFromPoints(points) {
    const pts = (points || [])
      .map(p => ({ ts: Number(p.ts), v: Number(p.value) }))
      .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.v))
      .sort((a, b) => a.ts - b.ts);

    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].v - pts[i - 1].v;
      if (Number.isFinite(d) && d > 0) s += d;
    }
    return s;
  }

  // ========= Aggregators =========
  async function computeDeviceValue(deviceId, keyName, startTs, endTs, signal) {
    if (AGG_MODE === 'SUM_BUCKETS') {
      const interval = pickIntervalMs(startTs, endTs);
      const buckets = await fetchTimeseries(deviceId, keyName, startTs, endTs, 'SUM', interval, 50000, signal);
      return sumBucketValues(buckets);
    }

    if (AGG_MODE === 'DELTA_MAX_MIN') {
      const interval = Math.max(1, Number(endTs) - Number(startTs));
      const minArr = await fetchTimeseries(deviceId, keyName, startTs, endTs, 'MIN', interval, 2, signal);
      const maxArr = await fetchTimeseries(deviceId, keyName, startTs, endTs, 'MAX', interval, 2, signal);
      const minV = Number(minArr?.[0]?.value);
      const maxV = Number(maxArr?.[0]?.value);
      if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return 0;
      return maxV - minV;
    }

    if (AGG_MODE === 'POSITIVE_DELTAS') {
      const pts = await fetchTimeseries(deviceId, keyName, startTs, endTs, 'NONE', null, 50000, signal);
      return computePositiveDeltasFromPoints(pts);
    }

    return 0;
  }

  async function computeAllDevices(deviceIds, keyName, startTs, endTs, signal) {
    const per = await Promise.all(deviceIds.map(async (id) => {
      const v = await computeDeviceValue(id, keyName, startTs, endTs, signal);
      return Number(v) || 0;
    }));
    return per.reduce((a, b) => a + b, 0);
  }

  // ========= Signature + polling =========
  function normalizeIds(ids) {
    return dedupe(ids).sort().join(',');
  }

  function buildSignature() {
    const st = readStateParams();
    const mode = getSelectedMode(st);
    const idsCtx = normalizeIds(getDeviceIdsFromCtxDatasources());
    const idsState = normalizeIds(getAllDeviceIdsFromState(st));
    const tw = getTimeWindow();
    const key = getConfiguredKeyName();
    const singleId = getSingleIdFromStateOrCtx(st);
    if (mode === 'ALL') {
      return [
        'mode=ALL',
        'ids=' + (idsState || idsCtx),
        'tw=' + String(tw.startTs) + '-' + String(tw.endTs),
        'key=' + key,
        'agg=' + AGG_MODE
      ].join('|');
    }
    return [
      'mode=SINGLE',
      'id=' + String(singleId || ''),
      'tw=' + String(tw.startTs) + '-' + String(tw.endTs),
      'key=' + key,
      'agg=' + AGG_MODE
    ].join('|');
  }

  // ========= Lifecycle =========
  self.onInit = function () {
    self.ctx.$scope.aggregatedValueCardWidget.onInit();
    ensureOverlay();

    if (self.ctx.stateController && self.ctx.stateController.stateChanged) {
      let stateDebounce = null;
      self.stateSubscription = self.ctx.stateController.stateChanged().subscribe(function () {
        if (stateDebounce) clearTimeout(stateDebounce);
        stateDebounce = setTimeout(() => {
          try {
            if (self.ctx && self.ctx.updateAliases) self.ctx.updateAliases();
            if (self.ctx && self.ctx.aliasController && self.ctx.aliasController.updateAliases) {
              self.ctx.aliasController.updateAliases();
            }
          } catch (e) { }
          scheduleRefresh('stateChanged');
        }, 120);
      });
    }

    scheduleRefresh('init');
  };

  function scheduleRefresh(reason) {
    const mySeq = ++refreshSeq;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (mySeq !== refreshSeq) return;
      const sigNow = buildSignature();
      const now = Date.now();
      if (sigNow === lastAppliedSig && (now - lastAppliedAt) < SAME_SIG_SKIP_WINDOW_MS) {
        return;
      }
      lastAppliedSig = sigNow;
      lastAppliedAt = now;
      lastSig = sigNow;
      onDataUpdatedInternal();
    }, QUIET_TIME_MS);
  }

  function onDataUpdatedInternal() {
    if (isFetching) { needsRerun = true; return; }
    showOverlayDelayed();

    fetchSeq++;

    try { if (activeAbort) activeAbort.abort(); } catch (e) { }
    activeAbort = null;

    if (pendingUpdateTimeout) clearTimeout(pendingUpdateTimeout);
    const scheduledSeq = fetchSeq;
    pendingUpdateTimeout = setTimeout(() => processUpdate(scheduledSeq), UPDATE_DEBOUNCE_MS);
  }

  self.onDataUpdated = function () { scheduleRefresh('onDataUpdated'); };

  self.onLatestDataUpdated = function () { scheduleRefresh('onLatestDataUpdated'); };
  self.onResize = function () { self.ctx.$scope.aggregatedValueCardWidget.onResize(); };
  self.onEditModeChanged = function () { self.ctx.$scope.aggregatedValueCardWidget.onEditModeChanged(); };

  self.onDestroy = function () {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    if (self.stateSubscription) {
      self.stateSubscription.unsubscribe();
      self.stateSubscription = null;
    }

    try { if (activeAbort) activeAbort.abort(); } catch (e) { }
    activeAbort = null;

    try {
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      if (overlayStyleEl && overlayStyleEl.parentNode) overlayStyleEl.parentNode.removeChild(overlayStyleEl);
    } catch (e) { }
    overlayEl = null;
    overlayStyleEl = null;
    if (overlayTimer) {
      clearTimeout(overlayTimer);
      overlayTimer = null;
    }

    self.ctx.$scope.aggregatedValueCardWidget.onDestroy();
  };

  async function processUpdate(scheduledSeq) {
    const mySeq = scheduledSeq;

    const stateParams = readStateParams();
    const mode = getSelectedMode(stateParams);
    const isAllMode = (mode === 'ALL');
    const singleId = getSingleIdFromStateOrCtx(stateParams);

    if (lastModeApplied !== mode || (mode === 'SINGLE' && singleId && singleId !== lastSingleIdApplied)) {
      // Clear backup when switching device/mode to avoid stale data
      originalSubBackup = null;
    }
    lastModeApplied = mode;
    if (mode === 'SINGLE' && singleId) lastSingleIdApplied = singleId;

    const { startTs, endTs } = getTimeWindow();
    if (!startTs || !endTs) {
      hideOverlay();
      return;
    }

    if (!isAllMode) {
      if (!singleId || singleId === '__ALL__') {
        hideOverlay();
        renderCard();
        return;
      }

      if (isFetching) { needsRerun = true; return; }
      isFetching = true;
      needsRerun = false;

      const controller = new AbortController();
      activeAbort = controller;

      try {
        const keyName = getConfiguredKeyName();
        const value = await computeDeviceValue(singleId, keyName, startTs, endTs, controller.signal);

        if (controller.signal.aborted) return;
        if (mySeq !== fetchSeq) return;

        injectAggregatedValueToSubscription(value);
        renderCard();
        hideOverlay();
      } catch (e) {
        if (String(e && e.name) !== 'AbortError') console.error('[card] error:', e);
        hideOverlay();
      } finally {
        if (activeAbort === controller) activeAbort = null;
        isFetching = false;

        if (needsRerun) {
          needsRerun = false;
          const latest = fetchSeq;
          setTimeout(() => processUpdate(latest), 0);
        }
      }
      return;
    }

    const ids = getAllIdsRobust(stateParams);
    if (!ids || ids.length <= 1) {
      restoreSubscriptionBackup();
      hideOverlay();
      renderCard();
      return;
    }

    if (isFetching) { needsRerun = true; return; }
    isFetching = true;
    needsRerun = false;

    const controller = new AbortController();
    activeAbort = controller;

    try {
      backupSubscriptionIfNeeded();

      const keyName = getConfiguredKeyName();
      const value = await computeAllDevices(ids, keyName, startTs, endTs, controller.signal);

      if (controller.signal.aborted) return;
      if (mySeq !== fetchSeq) return;

      // ✅ Guard: ngữ cảnh đã đổi => không inject
      if (buildSignature() !== lastSig) return;

      injectAggregatedValueToSubscription(value);
      renderCard();
      hideOverlay();
    } catch (e) {
      if (String(e && e.name) !== 'AbortError') console.error('[card] error:', e);
    } finally {
      if (activeAbort === controller) activeAbort = null;
      isFetching = false;
      if (needsRerun) {
        needsRerun = false;
        const latest = fetchSeq;
        setTimeout(() => processUpdate(latest), 0);
      } else {
        hideOverlay();
      }
    }
  }

  self.typeParameters = function () {
    return {
      maxDatasources: 1,
      maxDataKeys: 1,
      singleEntity: false,
      previewWidth: '400px',
      previewHeight: '300px',
      embedTitlePanel: true,
      supportsUnitConversion: true,
      hasAdditionalLatestDataKeys: true,
      defaultDataKeysFunction: function () {
        return [
          { name: DEFAULT_KEY, label: 'Pass', type: 'timeseries', color: 'rgba(0, 0, 0, 0.87)', units: '', decimals: 0 }
        ];
      },
      defaultLatestDataKeysFunction: function (configComponent, configData) {
        return configComponent.createDefaultAggregatedValueLatestDataKeys(configData, DEFAULT_KEY, '', 0);
      }
    };
  };
})();
