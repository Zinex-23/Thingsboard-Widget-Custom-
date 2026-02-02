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

  function getCompareKeyConfig() {
    const s = (self.ctx && self.ctx.settings) ? self.ctx.settings : {};
    const deltaName = s.compareDeltaKeyName || s.deltaKeyName || s.compareDeltaKey || s.deltaKey || '';
    const percentName = s.comparePercentKeyName || s.percentKeyName || s.comparePercentKey || s.percentKey || '';
    return {
      deltaName: String(deltaName || '').trim(),
      percentName: String(percentName || '').trim()
    };
  }

  function isDebugEnabled() {
    try {
      return !!(self.ctx && self.ctx.settings && self.ctx.settings.debugCard);
    } catch (e) { return false; }
  }

  function debugCardSnapshot() {
    try {
      const utcState = readUtcWidgetState();
      const utcCurrentCtx = getUtcCurrentWindowContext();
      const twCtx = utcCurrentCtx || getTimeWindow();
      const prevCtxs = getPrevContextCandidates(twCtx, !!utcCurrentCtx);
      const st = readStateParams();
      const mode = getSelectedMode(st);
      const singleId = getSingleIdFromStateOrCtx(st);
      const ids = getAllIdsRobust(st);
      const keyName = getConfiguredKeyName();
      const payload = {
        keyName,
        mode,
        singleId,
        idsCount: (ids || []).length,
        utcState,
        current: twCtx,
        prevCandidates: prevCtxs
      };
      console.info('[card][debug]', payload);
      return payload;
    } catch (e) {
      console.warn('[card][debug] failed:', e);
      return { error: String(e && e.message ? e.message : e) };
    }
  }

  async function debugCardFetch() {
    try {
      const snap = debugCardSnapshot();
      if (!snap || snap.error) return snap || { error: 'no snapshot' };
      if (snap.mode !== 'SINGLE' || !snap.singleId) {
        return { error: 'debugCardFetch supports SINGLE mode only', snap };
      }
      const cur = snap.current;
      const prev = (snap.prevCandidates && snap.prevCandidates[0]) ? snap.prevCandidates[0] : null;
      if (!cur || !cur.startTs || !cur.endTs) return { error: 'invalid current window', snap };
      if (!prev || !prev.startTs || !prev.endTs) return { error: 'invalid prev window', snap };

      const deviceId = snap.singleId;
      const keyName = snap.keyName;
      const curInterval = pickIntervalMs(cur.startTs, cur.endTs);
      const prevInterval = pickIntervalMs(prev.startTs, prev.endTs);

      const curSum = await fetchTimeseries(deviceId, keyName, cur.startTs, cur.endTs, 'SUM', curInterval, 50000);
      const prevSum = await fetchTimeseries(deviceId, keyName, prev.startTs, prev.endTs, 'SUM', prevInterval, 50000);

      const curRaw = (curSum && curSum.length) ? null :
        await fetchTimeseries(deviceId, keyName, cur.startTs, cur.endTs, 'NONE', null, 50000);
      const prevRaw = (prevSum && prevSum.length) ? null :
        await fetchTimeseries(deviceId, keyName, prev.startTs, prev.endTs, 'NONE', null, 50000);

      const payload = {
        deviceId,
        keyName,
        current: {
          startTs: cur.startTs,
          endTs: cur.endTs,
          sumCount: (curSum || []).length,
          sumPoints: curSum,
          rawCount: (curRaw || []).length,
          rawPoints: curRaw
        },
        prev: {
          startTs: prev.startTs,
          endTs: prev.endTs,
          sumCount: (prevSum || []).length,
          sumPoints: prevSum,
          rawCount: (prevRaw || []).length,
          rawPoints: prevRaw
        }
      };
      console.info('[card][debug-fetch]', payload);
      return payload;
    } catch (e) {
      console.warn('[card][debug-fetch] failed:', e);
      return { error: String(e && e.message ? e.message : e) };
    }
  }

  function registerDebugCard() {
    try { self.debugCard = debugCardSnapshot; } catch (e) { }
    try { (window.top || window).debugCard = debugCardSnapshot; } catch (e) { }
    try { (window.top || window).__cardDebug = debugCardSnapshot; } catch (e) { }
    try { self.debugCardFetch = debugCardFetch; } catch (e) { }
    try { (window.top || window).__cardDebugFetch = debugCardFetch; } catch (e) { }
  }

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

  function getEffectiveTimewindow() {
    try {
      const sub = self.ctx?.defaultSubscription;
      const stw = sub?.subscriptionTimewindow || null;
      const useDash = !!sub?.useDashboardTimewindow;
      if (stw && !useDash) return stw;
    } catch (e) { }
    try {
      return (
        self.ctx?.dashboardTimewindow ||
        self.ctx?.dashboard?.dashboardTimewindow ||
        self.ctx?.dashboardCtrl?.dashboardTimewindow ||
        self.ctx?.$scope?.dashboardTimewindow ||
        self.ctx?.$scope?.dashboardCtrl?.dashboardTimewindow ||
        null
      );
    } catch (e) { }
    try {
      const sub2 = self.ctx?.defaultSubscription;
      return sub2?.subscriptionTimewindow || null;
    } catch (e) { }
    return null;
  }

  function isDayMode(tw) {
    if (!tw) return false;
    const start = tw.minTime || tw.fixedWindow?.startTimeMs;
    const end = tw.maxTime || tw.fixedWindow?.endTimeMs;
    if (!start || !end) return false;

    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (end - start > ONE_DAY + 15 * 60 * 1000) return false;

    const s = new Date(start), e = new Date(end);
    return s.getFullYear() === e.getFullYear() &&
      s.getMonth() === e.getMonth() &&
      s.getDate() === e.getDate();
  }

  function getDayWindowFull(tw) {
    const ref = tw.fixedWindow?.startTimeMs || tw.minTime || Date.now();
    const d = new Date(ref);
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    const start0 = new Date(y, m, day, 0, 0, 0, 0).getTime();
    const end24 = new Date(y, m, day, 23, 59, 59, 999).getTime();
    return [start0, end24];
  }

  function getTimeWindow() {
    const tw = getEffectiveTimewindow();
    if (!tw) return { startTs: null, endTs: null, displayStart: null, displayEnd: null, flags: null, dayMode: false };

    const fixed = tw.history?.fixedTimewindow;
    let startTs = null;
    let endTs = null;
    if (fixed?.startTimeMs != null && fixed?.endTimeMs != null) {
      startTs = fixed.startTimeMs;
      endTs = fixed.endTimeMs;
    } else if (tw.startTs != null && tw.endTs != null) {
      startTs = tw.startTs;
      endTs = tw.endTs;
    }

    const windowMs =
      (tw.realtime?.timewindowMs != null) ? Number(tw.realtime.timewindowMs) :
      (tw.history?.timewindowMs != null) ? Number(tw.history.timewindowMs) :
      null;

    if ((!startTs || !endTs) && windowMs && isFinite(windowMs)) {
      const end = Date.now();
      startTs = end - windowMs;
      endTs = end;
    }

    if (!startTs || !endTs) {
      startTs = tw.minTime || tw.fixedWindow?.startTimeMs || null;
      endTs = tw.maxTime || tw.fixedWindow?.endTimeMs || null;
    }

    const dayMode = isDayMode(tw);
    if (dayMode) {
      const full = getDayWindowFull(tw);
      startTs = full[0];
      endTs = full[1];
    }

    const flags = getModeFlags(startTs, endTs);
    let displayStart = startTs;
    let displayEnd = endTs;
    if (dayMode && startTs != null) {
      const d = new Date(startTs);
      displayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 0, 0, 0).getTime();
      displayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 0, 0, 0).getTime();
    }

    return { startTs, endTs, displayStart, displayEnd, flags, dayMode };
  }

  function getModeFlags(startTs, endTs) {
    const spanDays = (endTs && startTs) ? (endTs - startTs) / (24 * 60 * 60 * 1000) : 0;
    const isYearMode = spanDays >= 300;
    const isMonthMode = !isYearMode && spanDays > 1;
    const isHourlyGapMode = spanDays <= 1;
    return { isYearMode, isMonthMode, isHourlyGapMode };
  }

  function makeWindowContext(startTs, endTs, dayMode) {
    if (!startTs || !endTs) {
      return { startTs: null, endTs: null, displayStart: null, displayEnd: null, flags: null, dayMode: !!dayMode };
    }
    const flags = getModeFlags(startTs, endTs);
    let displayStart = startTs;
    let displayEnd = endTs;
    if (dayMode) {
      const d = new Date(startTs);
      displayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 0, 0, 0).getTime();
      displayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 0, 0, 0).getTime();
    }
    return { startTs, endTs, displayStart, displayEnd, flags, dayMode: !!dayMode };
  }

  function readUtcWidgetState() {
    const STORAGE_KEY = 'timewindow_widget_utc_state';
    const SHARED_OFFSET_KEY = 'timewindow_widget_utc_offset_min';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const offsetRaw = localStorage.getItem(SHARED_OFFSET_KEY);
      const offsetMin = Number(offsetRaw);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state || !state.mode) return null;
      return {
        mode: state.mode,
        year: state.year,
        month: state.month,
        day: state.day,
        offsetMin: Number.isFinite(offsetMin) ? offsetMin : 0
      };
    } catch (e) {
      return null;
    }
  }

  function utcStartEndFor(mode, y, m, d, offsetMin) {
    if (mode === 'day') {
      const start = Date.UTC(y, m, d, 0, 0, 0, 0) - offsetMin * 60000;
      const end = Date.UTC(y, m, d, 23, 59, 59, 999) - offsetMin * 60000;
      return { start, end, dayMode: true };
    }
    if (mode === 'month') {
      const start = Date.UTC(y, m, 1, 0, 0, 0, 0) - offsetMin * 60000;
      const end = Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - offsetMin * 60000;
      return { start, end, dayMode: false };
    }
    if (mode === 'year') {
      const start = Date.UTC(y, 0, 1, 0, 0, 0, 0) - offsetMin * 60000;
      const end = Date.UTC(y, 11, 31, 23, 59, 59, 999) - offsetMin * 60000;
      return { start, end, dayMode: false };
    }
    return null;
  }

  function nowPartsForOffset(offsetMin) {
    const n = new Date(Date.now() + (Number(offsetMin) || 0) * 60000);
    return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate() };
  }

  function daysInMonthUtc(y, m) {
    return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  }

  function getUtcCurrentWindowContext() {
    const utcState = readUtcWidgetState();
    if (!utcState || typeof utcState.year !== 'number' || typeof utcState.month !== 'number' || typeof utcState.day !== 'number') {
      return null;
    }
    const mode = utcState.mode;
    const y = utcState.year;
    const m = utcState.month;
    const d = utcState.day;
    const offsetMin = utcState.offsetMin || 0;
    const nowParts = nowPartsForOffset(offsetMin);
    const isCurrentDay = (y === nowParts.y && m === nowParts.m && d === nowParts.d);
    const isCurrentMonth = (y === nowParts.y && m === nowParts.m);
    const isCurrentYear = (y === nowParts.y);

    if (mode === 'day') {
      const start = Date.UTC(y, m, d, 0, 0, 0, 0) - offsetMin * 60000;
      const end = isCurrentDay
        ? (Date.now() + offsetMin * 60000) - offsetMin * 60000
        : Date.UTC(y, m, d, 23, 59, 59, 999) - offsetMin * 60000;
      return makeWindowContext(start, end, true);
    }

    if (mode === 'month') {
      const start = Date.UTC(y, m, 1, 0, 0, 0, 0) - offsetMin * 60000;
      const end = isCurrentMonth
        ? (Date.now() + offsetMin * 60000) - offsetMin * 60000
        : Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - offsetMin * 60000;
      return makeWindowContext(start, end, false);
    }

    if (mode === 'year') {
      const start = Date.UTC(y, 0, 1, 0, 0, 0, 0) - offsetMin * 60000;
      const end = isCurrentYear
        ? (Date.now() + offsetMin * 60000) - offsetMin * 60000
        : Date.UTC(y, 11, 31, 23, 59, 59, 999) - offsetMin * 60000;
      return makeWindowContext(start, end, false);
    }

    return null;
  }

  function getPrevWindowContext(ctx) {
    if (!ctx || !ctx.startTs || !ctx.endTs) return null;

    const utcState = readUtcWidgetState();
    if (utcState && utcState.mode) {
      const mode = utcState.mode;
      const span = ctx.endTs - ctx.startTs;
      if (!span || !Number.isFinite(span)) return null;

      if (mode === 'day') {
        const prevStart = ctx.startTs - 24 * 60 * 60 * 1000;
        const prevEnd = ctx.endTs - 24 * 60 * 60 * 1000;
        return makeWindowContext(prevStart, prevEnd, true);
      }

      if (mode === 'month') {
        const offsetMin = utcState.offsetMin || 0;
        const y = utcState.year;
        const m = utcState.month;
        const prevMonthDate = new Date(Date.UTC(y, m, 1));
        prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 1);
        const py = prevMonthDate.getUTCFullYear();
        const pm = prevMonthDate.getUTCMonth();
        const prevStart = Date.UTC(py, pm, 1, 0, 0, 0, 0) - offsetMin * 60000;
        const prevEnd = prevStart + span;
        return makeWindowContext(prevStart, prevEnd, false);
      }

      if (mode === 'year') {
        const offsetMin = utcState.offsetMin || 0;
        const y = utcState.year - 1;
        const prevStart = Date.UTC(y, 0, 1, 0, 0, 0, 0) - offsetMin * 60000;
        const prevEnd = prevStart + span;
        return makeWindowContext(prevStart, prevEnd, false);
      }
    }

    const span = ctx.endTs - ctx.startTs;
    if (!span || !Number.isFinite(span)) return null;
    const prevStart = ctx.startTs - span;
    const prevEnd = ctx.startTs;
    return makeWindowContext(prevStart, prevEnd, ctx.dayMode);
  }

  function getPrevContextCandidates(primaryCtx, utcUsed) {
    const list = [];
    const p = getPrevWindowContext(primaryCtx);
    if (p) list.push(p);

    if (utcUsed) {
      const dashCtx = getTimeWindow();
      if (dashCtx && dashCtx.startTs && dashCtx.endTs) {
        const span = dashCtx.endTs - dashCtx.startTs;
        if (span && Number.isFinite(span)) {
          const prevStart = dashCtx.startTs - span;
          const prevEnd = dashCtx.startTs;
          list.push(makeWindowContext(prevStart, prevEnd, dashCtx.dayMode));
        }
      }
    }

    return list;
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
  }

  function updateLatestCompareKeys(currentValue, prevValue) {
    const sub = self.ctx.defaultSubscription;
    if (!sub || !Array.isArray(sub.latestData) || !sub.latestData.length) return;

    const now = Date.now();
    const delta = Number(currentValue || 0) - Number(prevValue || 0);
    const pct = (Number(prevValue || 0) === 0) ? 0 : (delta / Number(prevValue)) * 100;

    const cfg = getCompareKeyConfig();
    const wantDelta = cfg.deltaName;
    const wantPct = cfg.percentName;
    const wantDeltaNorm = normalizeKeyName(wantDelta).toLowerCase();
    const wantPctNorm = normalizeKeyName(wantPct).toLowerCase();

    function classifyCompareKey(dk) {
      const raw = String(dk?.label || dk?.name || '').toLowerCase();
      if (!raw) return '';
      if (raw.includes('%') || raw.includes('percent') || raw.includes('pct') || raw.includes('ratio')) return 'pct';
      if (raw.includes('delta') || raw.includes('diff') || raw.includes('change') || raw.includes('compare') || raw.includes('vs') ||
          raw.includes('chenh') || raw.includes('chênh') || raw.includes('so sanh') || raw.includes('so sánh') ||
          raw.includes('増減') || raw.includes('差分')) return 'delta';
      return '';
    }

    for (let i = 0; i < sub.latestData.length; i++) {
      const dk = sub.latestData[i]?.dataKey;
      const dkRaw = String(dk?.name || dk?.label || '').trim();
      const dkNorm = normalizeKeyName(dkRaw).toLowerCase();
      const kind = classifyCompareKey(dk);

      if (wantDeltaNorm && dkNorm === wantDeltaNorm) {
        sub.latestData[i].data = [[now, delta]];
        continue;
      }
      if (wantPctNorm && dkNorm === wantPctNorm) {
        sub.latestData[i].data = [[now, pct]];
        continue;
      }

      if (!wantDelta && !wantPct) {
        if (kind === 'delta') sub.latestData[i].data = [[now, delta]];
        if (kind === 'pct') sub.latestData[i].data = [[now, pct]];
        continue;
      }

      if (wantDelta && kind === 'delta') sub.latestData[i].data = [[now, delta]];
      if (wantPct && kind === 'pct') sub.latestData[i].data = [[now, pct]];
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

  function lastBucketValue(points) {
    if (!Array.isArray(points) || !points.length) return 0;
    const last = points[points.length - 1];
    const v = Number(last?.value);
    return Number.isFinite(v) ? v : 0;
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

  function normalizeTimestamp(ms, opts) {
    const { isMonthMode, isYearMode, isHourlyGapMode } = opts || {};
    const x = new Date(ms);
    if (isYearMode) return new Date(x.getFullYear(), x.getMonth(), 1, 0, 0, 0, 0).getTime();
    if (isMonthMode) return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0).getTime();
    if (isHourlyGapMode) return new Date(x.getFullYear(), x.getMonth(), x.getDate(), x.getHours(), 0, 0, 0).getTime();
    return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0).getTime();
  }

  function pickLastValueInRange(points, startTs, endTs) {
    if (!Array.isArray(points) || !points.length) return 0;
    let lastTs = -Infinity;
    let lastVal = 0;
    for (const p of points) {
      const ts = Number(p[0] ?? p.t ?? p.ts);
      const val = Number(p[1] ?? p.y ?? p.value);
      if (!Number.isFinite(ts) || !Number.isFinite(val)) continue;
      if (startTs != null && ts < startTs) continue;
      if (endTs != null && ts > endTs) continue;
      if (ts > lastTs) { lastTs = ts; lastVal = val; }
    }
    return (lastTs === -Infinity) ? 0 : lastVal;
  }

  function pickLastValueFromMap(mapObj, startTs, endTs) {
    if (!mapObj) return 0;
    let lastTs = -Infinity;
    let lastVal = 0;
    Object.keys(mapObj).forEach(k => {
      const ts = Number(k);
      if (!Number.isFinite(ts)) return;
      if (startTs != null && ts < startTs) return;
      if (endTs != null && ts > endTs) return;
      if (ts > lastTs) { lastTs = ts; lastVal = Number(mapObj[k]) || 0; }
    });
    return (lastTs === -Infinity) ? 0 : lastVal;
  }

  function getSubscriptionSeriesPoints(keyName, startTs, endTs) {
    const sub = self.ctx?.defaultSubscription;
    const list = sub?.data || [];
    if (!list.length) return [];
    const normKey = normalizeKeyName(keyName);
    let picked = null;
    for (let i = 0; i < list.length; i++) {
      const dk = list[i]?.dataKey;
      const dkName = normalizeKeyName(dk?.name || dk?.label || '');
      if (dkName && dkName === normKey) { picked = list[i]; break; }
    }
    if (!picked) picked = list[0];
    const pts = Array.isArray(picked?.data) ? picked.data : [];
    if (!startTs && !endTs) return pts;
    return pts.filter(p => (!startTs || p[0] >= startTs) && (!endTs || p[0] <= endTs));
  }

  function computeSingleValueFromSubscription(keyName, ctx) {
    const pts = getSubscriptionSeriesPoints(keyName, ctx.displayStart, ctx.displayEnd);
    if (!pts || !pts.length) return null;
    return pickLastValueInRange(pts, ctx.displayStart, ctx.displayEnd);
  }

  async function fetchRawTimeseries(deviceId, keyName, startTs, endTs, signal) {
    return fetchTimeseries(deviceId, keyName, startTs, endTs, 'NONE', null, 50000, signal);
  }

  async function computeDeviceSumWindow(deviceId, keyName, startTs, endTs, signal) {
    if (!deviceId || !startTs || !endTs) return 0;
    const interval = pickIntervalMs(startTs, endTs);
    const buckets = await fetchTimeseries(deviceId, keyName, startTs, endTs, 'SUM', interval, 50000, signal);
    const sumVal = sumBucketValues(buckets);
    if (sumVal !== 0 || (buckets && buckets.length)) return sumVal;

    // Fallback: sum raw points if SUM returns empty
    const pts = await fetchTimeseries(deviceId, keyName, startTs, endTs, 'NONE', null, 50000, signal);
    let rawSum = 0;
    for (const p of (pts || [])) {
      const v = Number(p?.value);
      if (Number.isFinite(v)) rawSum += v;
    }
    return rawSum;
  }

  async function computeDeviceValueChartLogic(deviceId, keyName, ctx, signal) {
    if (!deviceId) return 0;
    const pts = await fetchRawTimeseries(deviceId, keyName, ctx.startTs, ctx.endTs, signal);
    if (!pts || !pts.length) return 0;
    const mapped = pts.map(p => [Number(p.ts), Number(p.value)]);
    return pickLastValueInRange(mapped, ctx.displayStart, ctx.displayEnd);
  }

  async function computeAllDevicesValueChartLogic(deviceIds, keyName, ctx, signal) {
    const opts = ctx.flags || {};
    const aggregated = {};
    const ids = deviceIds || [];
    for (let i = 0; i < ids.length; i++) {
      const deviceId = ids[i];
      const pts = await fetchRawTimeseries(deviceId, keyName, ctx.startTs, ctx.endTs, signal);
      if (!pts || !pts.length) continue;
      for (const p of pts) {
        const ts = Number(p.ts);
        const val = Number(p.value) || 0;
        if (!Number.isFinite(ts)) continue;
        const normTs = normalizeTimestamp(ts, opts);
        if (!aggregated[normTs]) aggregated[normTs] = 0;
        aggregated[normTs] += val;
      }
    }
    return pickLastValueFromMap(aggregated, ctx.displayStart, ctx.displayEnd);
  }

  // ========= Aggregators =========
  async function computeDeviceValue(deviceId, keyName, startTs, endTs, signal) {
    if (AGG_MODE === 'SUM_BUCKETS') {
      // Total value over the timewindow
      return computeDeviceSumWindow(deviceId, keyName, startTs, endTs, signal);
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

  function getPrevWindow(startTs, endTs) {
    const s = Number(startTs || 0);
    const e = Number(endTs || 0);
    if (!s || !e || e <= s) return null;
    const span = e - s;
    return { startTs: s - span, endTs: s };
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
    registerDebugCard();
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

    // Listen timewindow changes (UTC widget updates dashboard timewindow)
    try {
      const d = self.ctx?.dashboard || self.ctx?.dashboardCtrl;
      const subj = d?.dashboardTimewindowChangedSubject || self.ctx?.dashboardTimewindowChangedSubject;
      if (subj && typeof subj.subscribe === 'function') {
        self.timewindowSubscription = subj.subscribe(function () {
          scheduleRefresh('timewindowChanged');
        });
      }
    } catch (e) { }

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
    if (self.timewindowSubscription) {
      try { self.timewindowSubscription.unsubscribe(); } catch (e) { }
      self.timewindowSubscription = null;
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

    const utcCurrentCtx = getUtcCurrentWindowContext();
    const twCtx = utcCurrentCtx || getTimeWindow();
    if (!twCtx.startTs || !twCtx.endTs) {
      hideOverlay();
      return;
    }
    const prevCtxs = getPrevContextCandidates(twCtx, !!utcCurrentCtx);

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
        let value = await computeDeviceValue(singleId, keyName, twCtx.startTs, twCtx.endTs, controller.signal);
        let prevValue = 0;
        for (let i = 0; i < prevCtxs.length; i++) {
          const c = prevCtxs[i];
          if (!c) continue;
          prevValue = await computeDeviceValue(singleId, keyName, c.startTs, c.endTs, controller.signal);
          if (prevValue !== 0) break;
        }
        if (isDebugEnabled()) {
          console.log('[card] SINGLE', {
            keyName,
            cur: { start: twCtx.startTs, end: twCtx.endTs, value },
            prev: prevCtxs && prevCtxs.length ? { start: prevCtxs[0].startTs, end: prevCtxs[0].endTs, value: prevValue } : null
          });
        }

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
      let value = await computeAllDevices(ids, keyName, twCtx.startTs, twCtx.endTs, controller.signal);
      let prevValue = 0;
      for (let i = 0; i < prevCtxs.length; i++) {
        const c = prevCtxs[i];
        if (!c) continue;
        prevValue = await computeAllDevices(ids, keyName, c.startTs, c.endTs, controller.signal);
        if (prevValue !== 0) break;
      }
      if (isDebugEnabled()) {
        console.log('[card] ALL', {
          keyName,
          ids: (ids || []).length,
          cur: { start: twCtx.startTs, end: twCtx.endTs, value },
          prev: prevCtxs && prevCtxs.length ? { start: prevCtxs[0].startTs, end: prevCtxs[0].endTs, value: prevValue } : null
        });
      }

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
