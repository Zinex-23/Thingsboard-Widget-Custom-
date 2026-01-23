// ================== CONFIG ==================
var AGE_MIN = 0;
var AGE_MAX = 100;
// 'male' | 'female' | 'both'
var SERIES = 'both';
// Test mock
var USE_MOCK = false;
// Debug log
var DEBUG = false;
// Nhóm theo datasource hay gộp toàn cục
var GROUP_BY_DATASOURCE = false; // false = gộp; true = giữ nhãn theo datasource (hành vi cũ)

// ===== Auto-zoom settings =====
var AUTO_ZOOM_ENABLED = true;    // Bật/tắt auto zoom dải tuổi có dữ liệu
var ZOOM_PADDING_BINS = 2;       // Số "tuổi" padding hai bên sau khi tìm thấy min/max có dữ liệu
var MIN_VISIBLE_BINS = 12;       // Ít nhất bao nhiêu cột hiển thị để không quá sát

// ===== Tham chiếu thời gian từ Time Window =====
var USE_TB_TIME_REFERENCE = true;
var FALLBACK_USE_MAX_TS_FROM_DATA = false;

// ===== ALL DEVICES (plural) =====
var ENABLE_ALL_DEVICES_MODE = true;       // bật logic ALL devices
var ALL_KEYS = ['ages', 'gender'];        // keys cần fetch khi ALL
var ALL_FETCH_LIMIT = 100000;             // limit timeseries
var ALL_FETCH_AGG = 'NONE';               // agg
var POLL_SELECTION_ENABLED = true;        // lắng nghe switch device selector phía trên
var POLL_INTERVAL_MS = 350;               // polling signature
var LOADING_TEXT = 'Loading...';          // overlay text
var SINGLE_FETCH_USES_API = true;         // SINGLE cũng fetch trực tiếp để tránh stale subscription

// ===========================================

(function () {
  // --- rAF polyfill (fallback ~60fps) ---
  var _rAF = window.requestAnimationFrame || function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
  var _cAF = window.cancelAnimationFrame || clearTimeout;

  var ui = { titleText: '', timeWindowText: '' };

  var state = {
    labels: [],          // [AGE_MIN..AGE_MAX]
    seriesLabels: [],
    colors: [],
    counts2D: [],        // [series][ageIndex]
    totals: [],
    yMax: 1,
    hiddenSeries: {},

    // Auto-zoom viewport (theo index trong labels gốc)
    zoom: { enabled: AUTO_ZOOM_ENABLED, startIdx: 0, endIdx: 0 },

    // Animation
    anim: { start: 0, duration: 1200, progress: 1, raf: null }
  };

  // --- Tooltip & hover state ---
  var _tooltipEl = null;
  var _layout = null; // lưu layout frame gần nhất để hit-test
  var _hover = { ai: -1, si: -1 }; // ai: index tuổi, si: series index

  // Guards
  var __fetchSeq = 0;
  var __pollTimer = null;
  var __lastSig = null;
  var __lastAppliedSig = null;
  var __lastAppliedAt = 0;
  var SAME_SIG_SKIP_WINDOW_MS = 600;
  var __updateSeq = 0;
  var __pendingUpdate = null;
  var __activeAbort = null;

  // ---------- Utils (ES5) ----------
  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
  function msToHuman(ms) {
    var sec = 1000, min = 60*sec, hour = 60*min, day = 24*hour;
    if (ms >= day)  return Math.round(ms/day)  + ' days';
    if (ms >= hour) return Math.round(ms/hour) + ' hours';
    if (ms >= min)  return Math.round(ms/min)  + ' minutes';
    return Math.round(ms/sec) + ' seconds';
  }
  function formatDateRange(aMs, bMs) {
    var a = new Date(aMs), b = new Date(bMs);
    return a.toLocaleString() + ' → ' + b.toLocaleString();
  }
  function pickFirstNumber(){
    for (var i=0;i<arguments.length;i++){
      var v = arguments[i];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }
  function isFiniteNumber(x){ return typeof x === 'number' && isFinite(x); }

  // ---------- TB state helpers (ALL/SINGLE + switch detect) ----------
  function safeGetToken() {
    try { return localStorage.getItem('jwt_token') || localStorage.getItem('token') || ''; } catch(_) { return ''; }
  }
  function extractDeviceId(ent) {
    if (!ent) return null;
    if (typeof ent === 'string') return ent;
    if (typeof ent.id === 'string') return ent.id;
    if (ent.id && typeof ent.id.id === 'string') return ent.id.id;
    return null;
  }
  function dedupe(arr) {
    var out=[], set=new Set();
    (arr||[]).forEach(function(x){
      var v=String(x||'').trim();
      if(v && !set.has(v)){ set.add(v); out.push(v); }
    });
    return out;
  }
  function readStateParams() {
    var sc = self.ctx && self.ctx.stateController;
    if (!sc) return {};
    try { var p = sc.getStateParams(); if (p && typeof p === 'object') return p; } catch(e){}
    try { var p2 = sc.getStateParams('default'); if (p2 && typeof p2 === 'object') return p2; } catch(e){}
    return {};
  }
  function getAllDeviceIdsFromState(stateParams) {
    var list = stateParams.entities || stateParams.entityIds || [];
    var ids = [];
    if (Array.isArray(list)) {
      list.forEach(function(e){ var id=extractDeviceId(e); if(id) ids.push(id); });
    } else {
      var id2=extractDeviceId(list); if(id2) ids.push(id2);
    }
    return dedupe(ids);
  }
  function getSelectedMode(stateParams) {
    // chỉnh nếu dashboard bạn dùng key khác
    var m = stateParams.selectedDeviceMode || stateParams.mode;
    if (m === 'ALL') return 'ALL';
    if (stateParams.selectedDeviceId === '__ALL__') return 'ALL';
    var list = stateParams.entities || stateParams.entityIds || [];
    if (Array.isArray(list) && list.length > 1) return 'ALL';
    return 'SINGLE';
  }
  function getCurrentSingleEntityIdFromCtx() {
    try {
      var ds = self.ctx && (self.ctx.datasources || self.ctx.dataSources || self.ctx.dataSource);
      if (Array.isArray(ds) && ds.length) {
        var e = ds[0].entity || ds[0].entityId || ds[0].entityID;
        var id = extractDeviceId(e) || extractDeviceId(ds[0].entityId) || extractDeviceId(ds[0].entityID);
        if (id) return id;
      }
    } catch(_){}
    // fallback: defaultSubscription datasource
    try{
      var sub = self.ctx && self.ctx.defaultSubscription;
      var d0 = sub && sub.datasources && sub.datasources[0];
      var id2 = d0 && extractDeviceId(d0.entityId || d0.entity || d0);
      if (id2) return id2;
    }catch(_){}
    return '';
  }
  function getSingleDeviceIdFromStateOrCtx(stateParams){
    var direct = stateParams.selectedDeviceId || stateParams.id || extractDeviceId(stateParams.entityId);
    if (direct && direct !== '__ALL__') return String(direct);
    var ctxId = getCurrentSingleEntityIdFromCtx();
    if (ctxId) return String(ctxId);
    return '';
  }

  function buildSignature() {
    var st = readStateParams();
    var mode = getSelectedMode(st);
    var singleId = getSingleDeviceIdFromStateOrCtx(st) || '';
    var allIds = (mode === 'ALL') ? getAllDeviceIdsFromState(st).join(',') : '';
    return [
      'mode=' + mode,
      'single=' + singleId,
      'all=' + allIds,
      'series=' + String(SERIES),
      'gb=' + String(GROUP_BY_DATASOURCE),
      'az=' + String(AUTO_ZOOM_ENABLED),
      'min=' + String(AGE_MIN) + '-' + String(AGE_MAX)
    ].join('|');
  }

  function startPollingSelection(){
    if (!POLL_SELECTION_ENABLED) return;
    if (__pollTimer) return;
    __lastSig = buildSignature();
    __pollTimer = setInterval(function(){
      try{
        var sig = buildSignature();
        if (sig !== __lastSig){
          __lastSig = sig;
          scheduleUpdate(80); // trigger refresh
        }
      }catch(_){}
    }, POLL_INTERVAL_MS);
  }
  function stopPollingSelection(){
    try{ if(__pollTimer) clearInterval(__pollTimer); }catch(_){}
    __pollTimer = null;
  }

  // ---------- Loading overlay ----------
  function getContainerEl(){
    try { if (self.ctx && self.ctx.$container && self.ctx.$container[0]) return self.ctx.$container[0]; } catch(_){}
    return document.body;
  }
  function ensureLoadingOverlay(){
    var root = getContainerEl();
    if (!root) return null;

    if (!document.getElementById('tb-hist-loading-style')) {
      var st = document.createElement('style');
      st.id = 'tb-hist-loading-style';
      st.textContent = `
        .tb-hist__wrap-rel{ position:relative; }
        .tb-hist__loading{
          position:absolute; inset:0;
          display:none;
          align-items:center; justify-content:center;
          background:rgba(255,255,255,0.72);
          backdrop-filter: blur(2px);
          z-index: 50;
          font: 14px/1.2 Arial;
          color:#334155;
        }
        .tb-hist__loading .spin{
          width:18px;height:18px;border-radius:50%;
          border:2px solid rgba(51,65,85,0.25);
          border-top-color: rgba(51,65,85,0.85);
          margin-right:10px;
          animation: tbHistSpin 0.8s linear infinite;
        }
        @keyframes tbHistSpin{ to{ transform:rotate(360deg);} }
      `;
      document.head.appendChild(st);
    }

    if (!root.classList.contains('tb-hist__wrap-rel')) root.classList.add('tb-hist__wrap-rel');

    var el = root.querySelector('.tb-hist__loading');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tb-hist__loading';
      el.innerHTML = `<div class="spin"></div><div class="txt">${LOADING_TEXT||'Loading...'}</div>`;
      root.appendChild(el);
    }
    return el;
  }
  function showLoading(){
    var el = ensureLoadingOverlay();
    if (el) el.style.display = 'flex';
  }
  function hideLoading(){
    var el = ensureLoadingOverlay();
    if (el) el.style.display = 'none';
  }

  // ---------- Session Storage Helpers (SAFE) ----------
  var _ss = (function(){
    function getWidgetId(ctx){
      try {
        if (ctx && ctx.widget) {
          if (ctx.widget.id) return String(ctx.widget.id);
          if (ctx.widget.config && ctx.widget.config.id) return String(ctx.widget.config.id);
        }
        if (ctx && ctx.$scope && ctx.$scope.widget) {
          var w = ctx.$scope.widget;
          if (w.id) return String(w.id);
          if (w.config && w.config.id) return String(w.config.id);
        }
      } catch(_e){}
      return 'tb-histogram';
    }
    var prefix = 'tb_hist_' + getWidgetId(self.ctx) + '_';

    function ok(){
      try {
        if (typeof sessionStorage === 'undefined') return false;
        var t = prefix + '__test__';
        sessionStorage.setItem(t, '1');
        sessionStorage.removeItem(t);
        return true;
      } catch(_e){ return false; }
    }
    function set(k, v){
      try {
        if (!ok()) return;
        var s = (typeof v === 'string') ? v : JSON.stringify(v);
        sessionStorage.setItem(prefix + k, s);
      } catch(_e){}
    }
    function get(k, fallback){
      try {
        if (!ok()) return fallback;
        var s = sessionStorage.getItem(prefix + k);
        if (s == null) return fallback;
        try { return JSON.parse(s); } catch(_e){ return s; }
      } catch(_e){ return fallback; }
    }
    function del(k){
      try { if (ok()) sessionStorage.removeItem(prefix + k); } catch(_e){}
    }
    return { set:set, get:get, del:del, _prefix:prefix };
  })();

  // ---------- Lifecycle ----------
  self.onInit = function () {
    try {
      if (self.ctx && self.ctx.$scope && self.ctx.$scope.valueCardWidget && self.ctx.$scope.valueCardWidget.onInit) {
        self.ctx.$scope.valueCardWidget.onInit();
      }
    } catch(_e){}

    ensureLoadingOverlay();

    ui.titleText = getDashboardTitle(self.ctx);
    ui.timeWindowText = getTimeWindowText(self.ctx);

    // ---- Load settings from Session Storage (if any) ----
    try {
      var savedSeries = _ss.get('SERIES', null);
      if (savedSeries === 'male' || savedSeries === 'female' || savedSeries === 'both') {
        SERIES = savedSeries;
      }
      var savedGroupByDs = _ss.get('GROUP_BY_DATASOURCE', null);
      if (typeof savedGroupByDs === 'boolean') GROUP_BY_DATASOURCE = savedGroupByDs;

      var savedAutoZoom = _ss.get('AUTO_ZOOM_ENABLED', null);
      if (typeof savedAutoZoom === 'boolean') AUTO_ZOOM_ENABLED = savedAutoZoom;

      var savedZoomPadding = _ss.get('ZOOM_PADDING_BINS', null);
      if (typeof savedZoomPadding === 'number' && isFinite(savedZoomPadding)) ZOOM_PADDING_BINS = savedZoomPadding;

      var savedMinBins = _ss.get('MIN_VISIBLE_BINS', null);
      if (typeof savedMinBins === 'number' && isFinite(savedMinBins)) MIN_VISIBLE_BINS = savedMinBins;

      var savedZoom = _ss.get('zoom', null);
      if (savedZoom && typeof savedZoom === 'object') {
        if (!state.zoom) state.zoom = { enabled: AUTO_ZOOM_ENABLED, startIdx: 0, endIdx: 0 };
        if (typeof savedZoom.enabled === 'boolean') state.zoom.enabled = savedZoom.enabled;
        if (isFiniteNumber(savedZoom.startIdx)) state.zoom.startIdx = savedZoom.startIdx|0;
        if (isFiniteNumber(savedZoom.endIdx)) state.zoom.endIdx = savedZoom.endIdx|0;
      } else {
        if (state.zoom) state.zoom.enabled = AUTO_ZOOM_ENABLED;
      }
    } catch(_e){}

    setEmptyState();
    drawAll();
    setupResizeObserver(); // auto-fit, no scroll
    attachHoverEvents();
    if (self.ctx.stateController && self.ctx.stateController.stateChanged) {
      self.stateSubscription = self.ctx.stateController.stateChanged().subscribe(function () {
        try {
          if (self.ctx && self.ctx.updateAliases) self.ctx.updateAliases();
          if (self.ctx && self.ctx.aliasController && self.ctx.aliasController.updateAliases) {
            self.ctx.aliasController.updateAliases();
          }
        } catch(_e){}
        scheduleUpdate(120);
      });
    }
    startPollingSelection();

    // initial load
    scheduleUpdate(50);
  };

  self.onResize = function () { drawAll(); };

  self.onDataUpdated = function () {
    try {
      if (self.ctx && self.ctx.$scope && self.ctx.$scope.valueCardWidget && self.ctx.$scope.valueCardWidget.onDataUpdated) {
        self.ctx.$scope.valueCardWidget.onDataUpdated();
      }
    } catch(_e){}
    refreshHeader();
    scheduleUpdate(120);
  };

  self.onLatestDataUpdated = function () {
    try {
      if (self.ctx && self.ctx.$scope && self.ctx.$scope.valueCardWidget && self.ctx.$scope.valueCardWidget.onLatestDataUpdated) {
        self.ctx.$scope.valueCardWidget.onLatestDataUpdated();
      }
    } catch(_e){}
    refreshHeader();
    scheduleUpdate(120);
  };

  self.typeParameters = function () {
    return {
      maxDatasources: 20,
      maxDataKeys: 50,
      singleEntity: false,
      previewWidth: '360px',
      previewHeight: '300px',
      embedTitlePanel: false,
      hasAdditionalLatestDataKeys: true,
      defaultDataKeysFunction: function () {
        return [{ name: 'ages', label: 'Ages', type: 'timeseries' }];
      }
    };
  };

  self.onDestroy = function () {
    if (_resizeObs) { try { _resizeObs.disconnect(); } catch(_e){} }
    stopPollingSelection();
    if (self.stateSubscription) {
      try { self.stateSubscription.unsubscribe(); } catch(_e){}
      self.stateSubscription = null;
    }
    if (__pendingUpdate) {
      try { clearTimeout(__pendingUpdate); } catch(_e){}
      __pendingUpdate = null;
    }
    if (__activeAbort) {
      try { __activeAbort.abort(); } catch(_e){}
      __activeAbort = null;
    }
  };

  // ---------- Header ----------
  function refreshHeader() {
    ui.titleText = getDashboardTitle(self.ctx);
    ui.timeWindowText = getTimeWindowText(self.ctx);
  }
  function getDashboardTitle(ctx) {
    try {
      if (ctx && ctx.dashboard && ctx.dashboard.title) return ctx.dashboard.title;
      if (ctx && ctx.dashboard && ctx.dashboard.configuration && ctx.dashboard.configuration.title) return ctx.dashboard.configuration.title;
      if (ctx && ctx.$scope && ctx.$scope.dashboard && ctx.$scope.dashboard.title) return ctx.$scope.dashboard.title;
      if (ctx && ctx.$scope && ctx.$scope.dashboardCtrl && ctx.$scope.dashboardCtrl.dashboard && ctx.$scope.dashboardCtrl.dashboard.title) {
        return ctx.$scope.dashboardCtrl.dashboard.title;
      }
    } catch(_e){}
    return '';
  }

  // ---- Time window hiệu lực ----
  function getEffectiveTimewindow(ctx){
    try {
      var sub = ctx && ctx.defaultSubscription;
      var stw = sub && sub.subscriptionTimewindow ? sub.subscriptionTimewindow : null;
      var useDash = !!(sub && sub.useDashboardTimewindow);
      if (stw && !useDash) return stw;
    } catch(_e){}
    try {
      var dashTW =
        (ctx && ctx.$scope && ctx.$scope.dashboardTimewindow) ||
        (ctx && ctx.$scope && ctx.$scope.dashboardCtrl && ctx.$scope.dashboardCtrl.dashboardTimewindow) ||
        (ctx && ctx.dashboardTimewindow) ||
        (ctx && ctx.dashboard && ctx.dashboard.dashboardTimewindow) ||
        null;
      if (dashTW) return dashTW;
    } catch(_e){}
    try {
      if (ctx && ctx.timewindow) return ctx.timewindow;
    } catch(_e){}
    try {
      var sub2 = ctx && ctx.defaultSubscription;
      if (sub2 && sub2.subscriptionTimewindow) return sub2.subscriptionTimewindow;
    } catch(_e){}
    return null;
  }

  function getTimeWindowText(ctx) {
    try {
      var stw = getEffectiveTimewindow(ctx);
      if (!stw) return '';
      if (stw.realtime && isFiniteNumber(stw.realtime.timewindowMs)) return 'Last ' + msToHuman(Number(stw.realtime.timewindowMs));
      var fixed = stw.history && stw.history.fixedTimewindow;
      if (fixed && isFiniteNumber(fixed.startTimeMs) && isFiniteNumber(fixed.endTimeMs)) return formatDateRange(Number(fixed.startTimeMs), Number(fixed.endTimeMs));
      if (stw.history && isFiniteNumber(stw.history.timewindowMs)) return 'Last ' + msToHuman(Number(stw.history.timewindowMs));
      if (isFiniteNumber(stw.startTs) && isFiniteNumber(stw.endTs)) return formatDateRange(Number(stw.startTs), Number(stw.endTs));
    } catch(_e){}
    return '';
  }

  // ---------- Thu thập TB values (SINGLE) ----------
  function collectGroupedTBValues(ctx) {
    var result = [];
    function upsert(id, label, ts, val, meta) {
      var g = null, i;
      for (i=0;i<result.length;i++){ if (result[i].id === id){ g=result[i]; break; } }
      if (!g) { g = { id:id, label:label, payloads:[], dsName:meta.dsName, keyName:meta.keyName }; result.push(g); }
      g.payloads.push({ ts: ts, v: val });
    }

    try {
      var sub = ctx && ctx.defaultSubscription;
      if (sub && sub.data && sub.data.length) {
        for (var i=0;i<sub.data.length;i++) {
          var block = sub.data[i] || {};
          var dk = block.dataKey || {};
          var keyName = dk.name || dk.label || ('key#' + (i+1));
          var dsLabel = (block.datasource && (block.datasource.name || block.datasource.entityName)) || '';
          var label = dsLabel ? (dsLabel + ' / ' + keyName) : keyName;
          var id = 'SUB|' + dsLabel + '|' + keyName + '|' + i;

          var arr = block.data || [];
          for (var a=0;a<arr.length;a++) {
            var p = arr[a];
            if (p && p.length >= 2) upsert(id, label, p[0], p[1], { dsName: dsLabel, keyName: keyName });
          }
          var ld = block.latestData || [];
          for (var b=0;b<ld.length;b++) {
            var p2 = ld[b];
            if (p2 && p2.length >= 2) upsert(id, label, p2[0], p2[1], { dsName: dsLabel, keyName: keyName });
          }
        }
      }
    } catch(_e){}

    return result;
  }

  // ---------- Ghép ages + gender THEO TIMESTAMP ----------
  function fuseAgesAndGenderByTimestamp(groups){
    var out = [];
    var used = {};

    var byDs = {};
    for (var i=0;i<groups.length;i++){
      var g = groups[i];
      var ds = (g.dsName || '').toLowerCase();
      var key = (g.keyName || '').toLowerCase();
      if (!byDs[ds]) byDs[ds] = [];
      byDs[ds].push({ idx:i, key:key, g:g });
    }

    for (var dsName in byDs){
      var list = byDs[dsName];
      var agesG = null, genderG = null, others = [];
      for (var j=0;j<list.length;j++){
        var it = list[j];
        if (it.key === 'ages') agesG = it;
        else if (it.key === 'gender' || it.key === 'genders') genderG = it;
        else others.push(it);
      }

      if (agesG && genderG){
        used[agesG.idx] = 1; used[genderG.idx] = 1;

        var map = {};
        var pA = agesG.g.payloads || [];
        for (var a=0;a<pA.length;a++){ var ta=pA[a].ts; if(!map[ta]) map[ta]={}; map[ta].ages=pA[a].v; }
        var pG = genderG.g.payloads || [];
        for (var b=0;b<pG.length;b++){ var tg=pG[b].ts; if(!map[tg]) map[tg]={}; map[tg].gender=pG[b].v; }

        var fused = [];
        for (var tsStr in map){ fused.push({ ts: Number(tsStr), v: { ages: map[tsStr].ages, gender: map[tsStr].gender } }); }
        fused.sort(function(x,y){return x.ts-y.ts;});

        out.push({
          id: (agesG.g.id||'') + '|FUSED',
          label: agesG.g.dsName || agesG.g.label || 'Fused',
          dsName: agesG.g.dsName || '',
          keyName: 'ages+gender',
          payloads: fused
        });

        for (var k=0;k<others.length;k++) out.push(others[k].g);
      }
    }

    for (var ii=0;ii<groups.length;ii++){ if (!used[ii]) out.push(groups[ii]); }
    return out;
  }

  // ---------- Parsing ----------
  function normalizeGenderStr(s) {
    if (typeof s !== 'string') return '';
    var t = s.replace(/"/g,'').trim().toLowerCase();
    if (t.indexOf('m') === 0) return 'male';
    if (t.indexOf('f') === 0) return 'female';
    return '';
  }

  // {male:[], female:[]}
  function splitAgesByGender(payload) {
    if (payload && typeof payload === 'object' && 'v' in payload) payload = payload.v;
    if (payload && typeof payload === 'object' && 'value' in payload && Object.keys(payload).length === 1) payload = payload.value;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch(_e){} }

    var out = { male: [], female: [] };

    // kiểu cũ male_ages / female_ages
    if (payload && typeof payload === 'object') {
      var m1 = payload.male_ages != null ? payload.male_ages : (payload.values && payload.values.male_ages);
      var f1 = payload.female_ages != null ? payload.female_ages : (payload.values && payload.values.female_ages);
      if (m1 != null || f1 != null) {
        out.male = out.male.concat(parseAges(m1 != null ? m1 : []));
        out.female = out.female.concat(parseAges(f1 != null ? f1 : []));
        return out;
      }
    }

    // ages + gender
    var ages = null, genders = null;
    if (payload && typeof payload === 'object') {
      if (Array.isArray(payload.ages) || typeof payload.ages === 'string') ages = Array.isArray(payload.ages) ? payload.ages : safeParseArray(payload.ages);
      if (Array.isArray(payload.gender) || typeof payload.gender === 'string') genders = Array.isArray(payload.gender) ? payload.gender : safeParseArray(payload.gender);
      if ((!ages || !genders) && payload.values) {
        var va = payload.values.ages, vg = payload.values.gender;
        if (va != null) ages = Array.isArray(va) ? va : safeParseArray(va);
        if (vg != null) genders = Array.isArray(vg) ? vg : safeParseArray(vg);
      }
    }

    if (Array.isArray(ages) && Array.isArray(genders) && ages.length === genders.length) {
      for (var i=0;i<ages.length;i++) {
        var n = Number(ages[i]);
        var g = normalizeGenderStr(String(genders[i]));
        if (!isNaN(n) && n>=AGE_MIN && n<=AGE_MAX) {
          if (g==='male') out.male.push(n);
          else if (g==='female') out.female.push(n);
        }
      }
      return out;
    }

    // fallback: chỉ có 1 mảng tuổi
    var agesOnly = parseAges(payload);
    if (SERIES === 'male') out.male = out.male.concat(agesOnly);
    else if (SERIES === 'female') out.female = out.female.concat(agesOnly);
    return out;

    function safeParseArray(x){
      if (Array.isArray(x)) return x;
      if (typeof x === 'string') { try { var arr = JSON.parse(x); return Array.isArray(arr) ? arr : null; } catch(_e){} }
      return null;
    }
  }

  function parseAges(val) {
    if (val && typeof val === 'object' && 'value' in val && Object.keys(val).length === 1) val = val.value;

    if (Array.isArray(val)) {
      var out = [];
      for (var i=0;i<val.length;i++){ var n = Number(val[i]); if(!isNaN(n)) out.push(clamp(n, AGE_MIN, AGE_MAX)); }
      return out;
    }
    if (typeof val === 'number') return [clamp(val, AGE_MIN, AGE_MAX)];
    if (typeof val === 'string') {
      try { var arr = JSON.parse(val); if (Array.isArray(arr)) return parseAges(arr); } catch(_e){}
      var s = val.replace(/[\[\]\s]/g,''); if(!s) return [];
      var parts = s.split(','), out2 = [];
      for (var j=0;j<parts.length;j++){ if(!parts[j]) continue; var nn=Number(parts[j]); if(!isNaN(nn)) out2.push(clamp(nn, AGE_MIN, AGE_MAX)); }
      return out2;
    }
    if (val && typeof val === 'object' && (val.values || val.male_ages || val.female_ages)) {
      var ms = parseAges(val.male_ages || (val.values && val.values.male_ages) || []);
      var fs = parseAges(val.female_ages || (val.values && val.values.female_ages) || []);
      return ms.concat(fs);
    }
    return [];
  }

  // ---------- Build stacked ----------
  function buildStackedHistogram(seriesList) {
    var labels = []; for (var i=AGE_MIN;i<=AGE_MAX;i++) labels.push(i);
    var Slen = seriesList.length, A = labels.length;
    var counts2D = new Array(Slen), totals = new Array(Slen), seriesLabels = new Array(Slen);

    for (var si=0; si<Slen; si++){
      counts2D[si] = new Array(A);
      for (var ai=0; ai<A; ai++) counts2D[si][ai]=0;
      totals[si]=0; seriesLabels[si]=seriesList[si].label;

      var arr = seriesList[si].ages || [];
      for (var k=0;k<arr.length;k++){
        var n = Number(arr[k]);
        if (!isNaN(n) && n>=AGE_MIN && n<=AGE_MAX){ counts2D[si][n-AGE_MIN]+=1; totals[si]+=1; }
      }
    }

    var yMax = 1;
    for (var ai2=0;ai2<A;ai2++){
      var sum=0;
      for (var si2=0;si2<Slen;si2++) sum+=counts2D[si2][ai2];
      if (sum>yMax) yMax=sum;
    }

    var colors = ['#59B5FF','#FF96D0'];

    state.labels = labels;
    state.seriesLabels = seriesLabels;
    state.colors = colors;
    state.counts2D = counts2D;
    state.totals = totals;
    state.yMax = Math.max(yMax,1);
    writeLegend();
  }

  // ---------- Auto-zoom computations ----------
  function computeAutoZoom(){
    var labels = state.labels;
    var A = labels.length;
    var Slen = state.seriesLabels.length;
    if (!state.zoom) state.zoom = { enabled: AUTO_ZOOM_ENABLED, startIdx: 0, endIdx: A?A-1:0 };
    state.zoom.enabled = !!AUTO_ZOOM_ENABLED;

    if (!state.zoom.enabled || !A || !Slen || !state.counts2D.length) {
      state.zoom.startIdx = 0; state.zoom.endIdx = A ? A-1 : 0;
      try { _ss.set('zoom', { enabled: state.zoom.enabled, startIdx: state.zoom.startIdx, endIdx: state.zoom.endIdx }); } catch(_e){}
      return;
    }

    var minIdx = -1, maxIdx = -1;
    for (var ai=0; ai<A; ai++){
      var sum = 0;
      for (var si=0; si<Slen; si++){ sum += (state.counts2D[si][ai]||0); }
      if (sum > 0){
        if (minIdx === -1) minIdx = ai;
        maxIdx = ai;
      }
    }

    if (minIdx === -1) {
      state.zoom.startIdx = 0; state.zoom.endIdx = A-1;
      try { _ss.set('zoom', { enabled: state.zoom.enabled, startIdx: state.zoom.startIdx, endIdx: state.zoom.endIdx }); } catch(_e){}
      return;
    }

    var start = clamp(minIdx - ZOOM_PADDING_BINS, 0, A-1);
    var end   = clamp(maxIdx + ZOOM_PADDING_BINS, 0, A-1);

    var need = (MIN_VISIBLE_BINS - (end - start + 1));
    if (need > 0){
      var leftAdd = Math.floor(need/2), rightAdd = need - leftAdd;
      start = clamp(start - leftAdd, 0, A-1);
      end   = clamp(end + rightAdd, 0, A-1);
      var width = (end - start + 1);
      if (width < MIN_VISIBLE_BINS){
        var remaining = MIN_VISIBLE_BINS - width;
        if (start === 0) end = clamp(end + remaining, 0, A-1);
        else if (end === A-1) start = clamp(start - remaining, 0, A-1);
      }
    }

    state.zoom.startIdx = start;
    state.zoom.endIdx = end;

    try { _ss.set('zoom', { enabled: state.zoom.enabled, startIdx: state.zoom.startIdx, endIdx: state.zoom.endIdx }); } catch(_e){}
  }

  function chooseNiceTickStep(visibleBins){
    if (visibleBins <= 12) return 1;
    if (visibleBins <= 24) return 2;
    if (visibleBins <= 50) return 5;
    if (visibleBins <= 100) return 10;
    return 20;
  }

  // ---------- Drawing (auto-fit, no scrollbar) ----------
  function getCanvasContainer() {
    var el = document.getElementById('tb-hist-chartwrap');
    if (el) return el;
    var c = document.getElementById('histCanvas');
    if (c && c.parentElement) return c.parentElement;
    try { if (self.ctx && self.ctx.$container && self.ctx.$container[0]) return self.ctx.$container[0]; } catch(_e){}
    return document.body;
  }
  function setNoScrollStyles() {
    try {
      if (self.ctx && self.ctx.$container && self.ctx.$container[0]) {
        var w = self.ctx.$container[0];
        w.style.overflow = 'hidden';
        w.style.contain = 'strict';
      }
    } catch(_e){}
  }

  var _resizeObs = null, _lastMeasured = null;
  function setupResizeObserver() {
    setNoScrollStyles();
    var container = getCanvasContainer();
    if (!container || !window.ResizeObserver) return;
    try { if (_resizeObs) _resizeObs.disconnect(); } catch(_e){}
    _resizeObs = new ResizeObserver(function (entries) {
      var r = entries && entries[0] && entries[0].contentRect;
      if (r) _lastMeasured = { w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) };
      _rAF(function(){ drawAll(); });
    });
    _resizeObs.observe(container);
  }

  function drawAll() {
    var titleEl = document.getElementById('tb-hist-title');
    var twEl = document.getElementById('tb-hist-timewindow');
    if (titleEl) titleEl.textContent = ui.titleText || '';
    if (twEl) twEl.textContent = ui.timeWindowText || '';
    drawHistogramStacked();
  }

  function writeLegend() {
    var legendEl = document.getElementById('tb-hist-legend');
    if (!legendEl) return;
    legendEl.innerHTML = '';
    for (var i=0;i<state.seriesLabels.length;i++){
      var item=document.createElement('div');
      item.style.display='flex'; item.style.alignItems='center'; item.style.gap='8px'; item.style.marginRight='6px';
      item.style.cursor = 'pointer';
      item.setAttribute('data-series-index', String(i));

      var sw=document.createElement('span');
      sw.style.display='inline-block'; sw.style.width='12px'; sw.style.height='12px';
      sw.style.borderRadius='3px'; sw.style.background=state.colors[i%state.colors.length];
      item.appendChild(sw);

      var txt=document.createElement('span');
      txt.style.fontSize='12px'; txt.style.color='#444';
      txt.appendChild(document.createTextNode(state.seriesLabels[i]+' — Total: '+(state.totals[i]||0)));
      item.appendChild(txt);

      if (state.hiddenSeries && state.hiddenSeries[i]) {
        item.style.opacity = '0.45';
      }

      item.addEventListener('click', function(){
        var idx = parseInt(this.getAttribute('data-series-index'), 10);
        if (!state.hiddenSeries) state.hiddenSeries = {};
        state.hiddenSeries[idx] = !state.hiddenSeries[idx];
        drawAll();
        writeLegend();
      });

      legendEl.appendChild(item);
    }
    if (!state.seriesLabels.length){
      var empty=document.createElement('div');
      empty.style.fontSize='12px'; empty.style.color='#888';
      empty.appendChild(document.createTextNode('No data'));
      legendEl.appendChild(empty);
    }
  }

  function drawHistogramStacked() {
    var canvas = document.getElementById('histCanvas');
    if (!canvas) return;

    var container = getCanvasContainer();
    var cssW, cssH;

    if (_lastMeasured) {
      cssW = _lastMeasured.w; cssH = _lastMeasured.h;
    } else {
      var rect = container.getBoundingClientRect ? container.getBoundingClientRect() : {width:600,height:300};
      cssW = Math.max(1, Math.floor(rect.width));
      cssH = Math.max(1, Math.floor(rect.height));
    }
    if (cssW <= 1 || cssH <= 1) { _rAF(function(){ drawHistogramStacked(); }); return; }

    var dpr = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width  = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var margin = { top: 10, right: 12, bottom: 48, left: 56 };
    var plotW = Math.max(cssW - margin.left - margin.right, 10);
    var plotH = Math.max(cssH - margin.top - margin.bottom, 10);

    var labels = state.labels;
    var A = labels.length;
    var Slen = state.seriesLabels.length;

    var zStart = 0, zEnd = A - 1;
    if (state.zoom && state.zoom.enabled) {
      zStart = clamp(state.zoom.startIdx, 0, A-1);
      zEnd   = clamp(state.zoom.endIdx, 0, A-1);
      if (zEnd < zStart) { var t=zStart; zStart=zEnd; zEnd=t; }
    }
    var visibleBins = Math.max(1, (zEnd - zStart + 1));

    var barW = plotW / visibleBins;
    var yMax = 1;
    var hidden = state.hiddenSeries || {};
    for (var aiY = zStart; aiY <= zEnd; aiY++) {
      var sumY = 0;
      for (var siY = 0; siY < Slen; siY++) {
        if (hidden[siY]) continue;
        sumY += (state.counts2D[siY] && state.counts2D[siY][aiY]) ? state.counts2D[siY][aiY] : 0;
      }
      if (sumY > yMax) yMax = sumY;
    }
    yMax = Math.max(yMax, 1);
    function yScale(v){ return plotH * (v / yMax); }

    // Axes + grid
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(margin.left, margin.top); ctx.lineTo(margin.left, margin.top + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin.left, margin.top + plotH); ctx.lineTo(margin.left + plotW, margin.top + plotH); ctx.stroke();

    var yTicks = 4;
    for (var t = 1; t <= yTicks; t++) {
      var v = (yMax / yTicks) * t;
      var y = margin.top + plotH - yScale(v);
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y); ctx.stroke();
    }

    // Y labels
    ctx.fillStyle = '#64748b';
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('0', margin.left - 8, margin.top + plotH);
    ctx.fillText(String(yMax), margin.left - 8, margin.top + (plotH - yScale(yMax)));

    // X ticks (nice step)
    var step = chooseNiceTickStep(visibleBins);
    ctx.textAlign='center'; ctx.textBaseline='top';
    for (var ai=zStart; ai<=zEnd; ai++){
      var ageVal = labels[ai];
      if ((ageVal - labels[zStart]) % step !== 0) continue;
      var idx = (ai - zStart) + 0.5;
      var x = margin.left + idx * barW;
      ctx.strokeStyle = '#cbd5e1';
      ctx.beginPath(); ctx.moveTo(x, margin.top + plotH); ctx.lineTo(x, margin.top + plotH + 4); ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.font = '11px system-ui, -apple-system, Segoe UI, Arial, sans-serif';
      ctx.fillText(String(ageVal), x, margin.top + plotH + 6);
    }

    // Axis titles
    ctx.save();
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var xTitle = state.zoom.enabled ? ('Ages ( ' + labels[zStart] + '–' + labels[zEnd] + ')') : 'Ages';
    ctx.fillText(xTitle, margin.left + plotW / 2, margin.top + plotH + 26);
    ctx.restore();

    ctx.save();
    ctx.translate(margin.left - 36, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Arial, sans-serif';
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Number of people', 0, 0);
    ctx.restore();

    var animProg = (state && state.anim && typeof state.anim.progress === 'number') ? state.anim.progress : 1;

    _layout = {
      margin: margin,
      plotW: plotW,
      plotH: plotH,
      zStart: zStart,
      zEnd: zEnd,
      barW: barW,
      animProg: animProg
    };

    if (_hover && _hover.ai >= zStart && _hover.ai <= zEnd) {
      var colHover = _hover.ai - zStart;
      var xGuide = margin.left + (colHover + 0.5) * barW;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xGuide, margin.top);
      ctx.lineTo(xGuide, margin.top + plotH);
      ctx.stroke();
    }

    var hiddenSeries = state.hiddenSeries || {};
    var lastNonZero = new Array(state.labels.length);
    for (var ai0 = zStart; ai0 <= zEnd; ai0++) {
      var lastIdx = -1;
      for (var si0 = 0; si0 < Slen; si0++) {
        if (hiddenSeries[si0]) continue;
        var c0 = (state.counts2D[si0] && state.counts2D[si0][ai0]) ? state.counts2D[si0][ai0] : 0;
        if (c0) lastIdx = si0;
      }
      lastNonZero[ai0] = lastIdx;
    }
    for (var ai2 = zStart; ai2 <= zEnd; ai2++) {
      var baseline = 0;
      for (var si = 0; si < Slen; si++) {
        if (hiddenSeries[si]) continue;
        var c = (state.counts2D[si] && state.counts2D[si][ai2]) ? state.counts2D[si][ai2] : 0;
        if (!c) continue;
        var hFull = yScale(c);
        var hAnim = hFull * animProg;
        var xBar = margin.left + (ai2 - zStart) * barW;
        var yBar = margin.top + (plotH - baseline - hAnim);
        ctx.fillStyle = state.colors[si % state.colors.length];
        if (si === lastNonZero[ai2]) {
          drawRoundedTopRect(ctx, xBar, yBar, Math.max(1, barW), hAnim, Math.min(6, barW * 0.35));
        } else {
          ctx.fillRect(xBar, yBar, Math.max(1, barW), hAnim);
        }
        baseline += hAnim;
      }
    }
  }

  function drawRoundedTopRect(ctx, x, y, w, h, r) {
    if (h <= 0) return;
    var radius = Math.max(0, Math.min(r || 0, w / 2, h));
    if (radius <= 0) {
      ctx.fillRect(x, y, w, h);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  // ---------- RANGE từ TIME WINDOW ----------
  function currentRangeFromTB(ctx, groups){
    var stw = getEffectiveTimewindow(ctx);
    if (!stw) return { start: -Infinity, end: Infinity };

    var fixed = stw.history && stw.history.fixedTimewindow;
    if (fixed && isFiniteNumber(fixed.startTimeMs) && isFiniteNumber(fixed.endTimeMs)) {
      return { start: Number(fixed.startTimeMs), end: Number(fixed.endTimeMs) };
    }
    if (isFiniteNumber(stw.startTs) && isFiniteNumber(stw.endTs)) {
      return { start: Number(stw.startTs), end: Number(stw.endTs) };
    }

    var windowMs =
      (stw.realtime && isFiniteNumber(stw.realtime.timewindowMs)) ? Number(stw.realtime.timewindowMs) :
      (stw.history && isFiniteNumber(stw.history.timewindowMs)) ? Number(stw.history.timewindowMs) :
      null;

    if (!isFiniteNumber(windowMs)) return { start: -Infinity, end: Infinity };

    var nowRef = resolveTbNowRef(ctx, groups);
    return { start: nowRef - windowMs, end: nowRef };
  }

  function resolveTbNowRef(ctx, groups){
    if (!USE_TB_TIME_REFERENCE) return Date.now();
    try {
      var stw = getEffectiveTimewindow(ctx);
      if (stw) {
        var fixed = stw.history && stw.history.fixedTimewindow;
        var endFixed = fixed && isFiniteNumber(fixed.endTimeMs) ? Number(fixed.endTimeMs) : null;
        var endGeneric = isFiniteNumber(stw.endTs) ? Number(stw.endTs) : null;

        var endDash =
          (self.ctx && self.ctx.$scope && self.ctx.$scope.dashboardTimewindow && isFiniteNumber(self.ctx.$scope.dashboardTimewindow.endTs)) ? Number(self.ctx.$scope.dashboardTimewindow.endTs) :
          (self.ctx && self.ctx.$scope && self.ctx.$scope.dashboardCtrl && self.ctx.$scope.dashboardCtrl.dashboardTimewindow && isFiniteNumber(self.ctx.$scope.dashboardCtrl.dashboardTimewindow.endTs)) ? Number(self.ctx.$scope.dashboardCtrl.dashboardTimewindow.endTs) :
          (self.ctx && self.ctx.dashboardTimewindow && isFiniteNumber(self.ctx.dashboardTimewindow.endTs)) ? Number(self.ctx.dashboardTimewindow.endTs) :
          null;

        var endMaybe = pickFirstNumber(endFixed, endGeneric, endDash);
        if (endMaybe) return endMaybe;
      }
    } catch(_e){ if (DEBUG) try { console.warn('[resolveTbNowRef] resolve error', _e); } catch(_e2){} }

    if (FALLBACK_USE_MAX_TS_FROM_DATA && groups && groups.length) {
      var maxTs = null;
      for (var gi=0; gi<groups.length; gi++){
        var g = groups[gi], arr = (g && g.payloads) ? g.payloads : [];
        for (var pi=0; pi<arr.length; pi++){
          var ts = Number(arr[pi] && arr[pi].ts);
          if (isFiniteNumber(ts)) {
            if (maxTs === null || ts > maxTs) maxTs = ts;
          }
        }
      }
      if (isFiniteNumber(maxTs)) return maxTs;
    }
    return Date.now();
  }

  // ---------- ALL DEVICES FETCH ----------
  async function fetchAllDevicesGroups(deviceIds, rng, signal){
    var seq = ++__fetchSeq;
    var token = safeGetToken();
    var startTs = Number(rng.start), endTs = Number(rng.end);
    var keys = ALL_KEYS.join(',');
    var urlKeys = encodeURIComponent(keys);

    var outGroups = [];

    await Promise.all((deviceIds||[]).map(async function(deviceId){
      var url =
        `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries` +
        `?keys=${urlKeys}` +
        `&startTs=${startTs}` +
        `&endTs=${endTs}` +
        `&limit=${ALL_FETCH_LIMIT}&agg=${ALL_FETCH_AGG}`;

      try{
        var res = await fetch(url, {
          method:'GET',
          signal: signal,
          headers:{
            'Content-Type':'application/json',
            ...(token ? {'X-Authorization':'Bearer '+token} : {})
          }
        });
        if (!res.ok) return;

        var data = await res.json();
        // data[key] => [{ts,value}]
        for (var ki=0; ki<ALL_KEYS.length; ki++){
          var k = ALL_KEYS[ki];
          var arr = (data && data[k]) ? data[k] :
                    (data && data[String(k).toLowerCase()]) ? data[String(k).toLowerCase()] :
                    (data && data[String(k).toUpperCase()]) ? data[String(k).toUpperCase()] : [];
          if (!arr || !arr.length) continue;

          var g = {
            id: 'ALL|' + deviceId + '|' + k,
            label: deviceId + ' / ' + k,
            dsName: deviceId,
            keyName: k,
            payloads: []
          };
          for (var i=0;i<arr.length;i++){
            var p = arr[i];
            if (!p) continue;
            var ts = Number(p.ts);
            var v = (p.value != null) ? p.value : p.v;
            if (!isFiniteNumber(ts)) continue;
            if (!(ts >= startTs && ts <= endTs)) continue;
            g.payloads.push({ ts: ts, v: v });
          }
          if (g.payloads.length) outGroups.push(g);
        }
      }catch(_e){
        if (_e && _e.name === 'AbortError') return;
      }
    }));

    if (seq !== __fetchSeq) return null; // superseded
    return outGroups;
  }

  // ---------- Pipeline ----------
  function setEmptyState() {
    var labels = [];
    for (var i = AGE_MIN; i <= AGE_MAX; i++) labels.push(i);
    state.labels = labels;
    state.seriesLabels = [];
    state.colors = [];
    state.counts2D = [];
    state.totals = [];
    state.yMax = 1;
    state.zoom = { enabled: AUTO_ZOOM_ENABLED, startIdx: 0, endIdx: labels.length - 1 };
    writeLegend();
  }

  function scheduleUpdate(delayMs){
    if (__pendingUpdate) clearTimeout(__pendingUpdate);
    __pendingUpdate = setTimeout(function(){
      __pendingUpdate = null;
      var mySeq = ++__updateSeq;
      var sig = buildSignature();
      var now = Date.now();
      if (sig === __lastAppliedSig && (now - __lastAppliedAt) < SAME_SIG_SKIP_WINDOW_MS) {
        return;
      }
      __lastAppliedSig = sig;
      __lastAppliedAt = now;
      runUpdate(mySeq);
    }, delayMs || 0);
  }

  async function runUpdate(mySeq) {
    // Loading: luôn show trước, hide khi xong build + start anim
    showLoading();

    refreshHeader();
    ui.timeWindowText = getTimeWindowText(self.ctx);

    var stParams = readStateParams();
    var mode = getSelectedMode(stParams);

    // Range tính từ timewindow (không cần groups)
    var rng = currentRangeFromTB(self.ctx, null);

    var groups = [];

    try {
      if (__activeAbort) { try { __activeAbort.abort(); } catch(_e){} }
      __activeAbort = new AbortController();
      var signal = __activeAbort.signal;

      if (ENABLE_ALL_DEVICES_MODE && mode === 'ALL') {
        var allIds = getAllDeviceIdsFromState(stParams);
        if (!allIds || !allIds.length) {
          setEmptyState();
          drawAll();
          return;
        }

        var fetched = await fetchAllDevicesGroups(allIds, rng, signal);
        if (mySeq !== __updateSeq || (signal && signal.aborted)) return;
        if (!fetched) {
          setEmptyState();
          drawAll();
          return;
        }
        groups = fetched;

      } else {
        // SINGLE (prefer API to avoid stale subscription)
        if (SINGLE_FETCH_USES_API) {
          var singleId = getSingleDeviceIdFromStateOrCtx(stParams);
          if (singleId) {
            var fetchedSingle = await fetchAllDevicesGroups([singleId], rng, signal);
            if (mySeq !== __updateSeq || (signal && signal.aborted)) return;
            if (fetchedSingle && fetchedSingle.length) groups = fetchedSingle;
          }
        }
        if (!groups.length) {
          groups = collectGroupedTBValues(self.ctx);
        }
      }

      if (USE_MOCK) {
        groups.push({
          id: '__mock__',
          label: 'Mock',
          dsName: 'Mock',
          keyName: 'ages+gender',
          payloads: [{ ts: Date.now(), v: { ages: '[28,30,35]', gender: '["female","male","female"]' } }]
        });
      }

      // fuse ages+gender (nếu có ages và gender cùng dsName)
      groups = fuseAgesAndGenderByTimestamp(groups);

      // lọc theo rng (SINGLE vẫn có thể dùng rng)
      // build histogram (giữ nguyên logic cũ)
      if (!GROUP_BY_DATASOURCE) {
        var maleGlobal = [], femaleGlobal = [];
        for (var gi = 0; gi < groups.length; gi++) {
          var g = groups[gi];
          for (var pi = 0; pi < g.payloads.length; pi++) {
            var rec = g.payloads[pi];
            var ts = Number(rec && rec.ts);
            if (!isFiniteNumber(ts)) continue;
            if (!(ts >= rng.start && ts <= rng.end)) continue;

            var payload = rec.v != null ? rec.v : rec;
            var split = splitAgesByGender(payload);
            if (split.male && split.male.length)   maleGlobal   = maleGlobal.concat(split.male);
            if (split.female && split.female.length) femaleGlobal = femaleGlobal.concat(split.female);
          }
        }

        var series = [];
        if (SERIES === 'male' || SERIES === 'both')   series.push({ label: 'Male',   ages: maleGlobal });
        if (SERIES === 'female' || SERIES === 'both') series.push({ label: 'Female', ages: femaleGlobal });

        buildStackedHistogram(series);
        computeAutoZoom();
        startBarsAnimation();
        _rAF(function(){ hideLoading(); });
        return;
      }

      var seriesOld = [];
      for (var gi2 = 0; gi2 < groups.length; gi2++) {
        var g2 = groups[gi2], maleAll = [], femaleAll = [];
        for (var pi2 = 0; pi2 < g2.payloads.length; pi2++) {
          var rec2 = g2.payloads[pi2];
          var ts2 = Number(rec2 && rec2.ts);
          if (!isFiniteNumber(ts2)) continue;
          if (!(ts2 >= rng.start && ts2 <= rng.end)) continue;

          var payload2 = rec2.v != null ? rec2.v : rec2;
          var split2 = splitAgesByGender(payload2);
          maleAll = maleAll.concat(split2.male);
          femaleAll = femaleAll.concat(split2.female);
        }
        if (SERIES === 'male' || SERIES === 'both')   seriesOld.push({ label: g2.label + ' / male',   ages: maleAll });
        if (SERIES === 'female' || SERIES === 'both') seriesOld.push({ label: g2.label + ' / female', ages: femaleAll });
      }

      buildStackedHistogram(seriesOld);
      computeAutoZoom();
      startBarsAnimation();
      _rAF(function(){ hideLoading(); });
    } finally {
      if (mySeq === __updateSeq) {
        _rAF(function(){ hideLoading(); });
      }
    }
  }

  // ---------- Animation ----------
  function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }
  function startBarsAnimation(){
    if (state.anim.raf) { try { _cAF(state.anim.raf); } catch(_e){} state.anim.raf = null; }
    state.anim.start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    state.anim.progress = 0.0001;
    function tick(ts){
      var now = (typeof ts === 'number') ? ts : (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var p = Math.min((now - state.anim.start) / state.anim.duration, 1);
      state.anim.progress = easeOutCubic(p);
      drawAll();
      if (p < 1) state.anim.raf = _rAF(tick);
      else state.anim.raf = null;
    }
    state.anim.raf = _rAF(tick);
  }

  // ---------- Hover/Tooltip ----------
  function ensureContainerPositioned() {
    var c = getCanvasContainer();
    if (c && (!c.style.position || c.style.position === '')) c.style.position = 'relative';
  }
  function ensureTooltip() {
    if (_tooltipEl) return _tooltipEl;
    ensureContainerPositioned();
    var c = getCanvasContainer();
    var el = document.createElement('div');
    el.id = 'tb-hist-tooltip';
    el.style.position = 'absolute';
    el.style.pointerEvents = 'none';
    el.style.background = 'rgba(0,0,0,0.8)';
    el.style.color = '#fff';
    el.style.font = '12px sans-serif';
    el.style.padding = '6px 8px';
    el.style.borderRadius = '6px';
    el.style.whiteSpace = 'nowrap';
    el.style.transform = 'translate(-50%, -100%)';
    el.style.visibility = 'hidden';
    el.style.zIndex = '10';
    c.appendChild(el);
    _tooltipEl = el;
    return el;
  }
  function showTooltip(html, x, y) {
    var el = ensureTooltip();
    el.innerHTML = html;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.visibility = 'visible';
  }
  function hideTooltip() {
    if (_tooltipEl) _tooltipEl.style.visibility = 'hidden';
  }
  function formatPct(n, d) {
    if (!d) return '0%';
    var p = (n / d) * 100;
    return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + '%';
  }

  function attachHoverEvents() {
    var canvas = document.getElementById('histCanvas');
    if (!canvas) return;

    canvas.addEventListener('mousemove', function (ev) {
      if (!_layout) return;

      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var y = ev.clientY - rect.top;

      var L = _layout;
      var mx = x, my = y;

      if (mx < L.margin.left || mx > L.margin.left + L.plotW ||
          my < L.margin.top  || my > L.margin.top  + L.plotH) {
        _hover.ai = -1; _hover.si = -1;
        hideTooltip();
        return;
      }

      var relX = mx - L.margin.left;
      var col = Math.floor(relX / L.barW);
      var ai = L.zStart + col;
      if (ai < L.zStart || ai > L.zEnd) { hideTooltip(); return; }

      var Slen = state.seriesLabels.length;
      var totalAtAge = 0;
      for (var si=0; si<Slen; si++) totalAtAge += (state.counts2D[si][ai] || 0);

      var baseline = 0, hoveredSi = -1;
      for (var si2=0; si2<Slen; si2++) {
        var c = (state.counts2D[si2][ai] || 0);
        if (!c) continue;
        var hFull = (L.plotH * (c / Math.max(state.yMax,1)));
        var hAnim = hFull * L.animProg;
        var topY = L.margin.top + (L.plotH - baseline - hAnim);
        var botY = L.margin.top + (L.plotH - baseline);
        if (my >= topY && my <= botY) { hoveredSi = si2; break; }
        baseline += hAnim;
      }
      if (hoveredSi === -1) hoveredSi = 0;

      var ageVal = state.labels[ai];
      var lines = [];
      lines.push('<div style="font-weight:600;margin-bottom:4px">Age: ' + ageVal + '</div>');
      for (var j=0; j<Slen; j++) {
        var v = state.counts2D[j][ai] || 0;
        var pct = formatPct(v, totalAtAge);
        var sw = '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' +
                 (state.colors[j % state.colors.length]) + ';margin-right:6px;vertical-align:middle"></span>';
        lines.push('<div>' + sw + state.seriesLabels[j] + ': <b>' + v + '</b>' +
                   (totalAtAge ? ' <span style="opacity:.8">(' + pct + ')</span>' : '') + '</div>');
      }
      if (Slen > 1) lines.push('<div style="margin-top:4px;opacity:.9">Total: <b>' + totalAtAge + '</b></div>');

      var cx = L.margin.left + (col + 0.5) * L.barW;
      var cy = L.margin.top + L.plotH - baseline - 4;

      showTooltip(lines.join(''), cx, cy);
      _hover.ai = ai; _hover.si = hoveredSi;
    });

    canvas.addEventListener('mouseleave', function () {
      _hover.ai = -1; _hover.si = -1;
      hideTooltip();
    });
  }

})();
