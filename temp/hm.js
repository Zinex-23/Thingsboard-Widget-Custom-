// energy-heatmap.js  (FULL + FIX: listen device switch, loading overlay,
//                     supports SINGLE (subscription) + ALL (fetch & sum),
//                     range chips work, legend works, y-axis not overlap,
//                     tooltip: white background + red text (NO red border), English labels)

(function () {
  /*************** STATE & CONST ***************/
  var heatmapCanvas, heatmapCtx;
  var lastHeatmapMap = null;

  var startMs = null, endMs = null;     // applied range
  var yDays = 7;

  var hourMode = '10h';                 // '10h' | '24h'
  var currentMode = 'custom';           // 'custom' local range (chips/modal)
  var isExpanded = false;

  var PAD_HM = { L: 98, T: 34, R: 120, B: 22 };
  var LEVEL_COUNT = 5;

  var domainMax = 0;
  var BINS = [];
  var mobileSelectedCellKey = null;

  // Guards (stale render / fetch)
  var __fetchSeq = 0;
  var __renderSeq = 0;
  var __refreshSeq = 0;
  var __refreshTimer = null;
  var __lastAppliedSig = null;
  var __lastAppliedAt = 0;
  var __activeFetchController = null;
  var __orientationLocked = false;
  var QUIET_TIME_MS = 300;
  var SAME_SIG_SKIP_WINDOW_MS = 800;

  // For listening device switch (polling signature)
  var __pollTimer = null;
  var __lastSig = null;

  // Range persistence (temporary cache)
  var RANGE_CACHE_TTL_MS = 5 * 60 * 1000;
  var SHARED_OFFSET_KEY = 'timewindow_widget_utc_offset_min';

  // DOM ids (must match widget HTML template)
  var ids = {
    root: 'eh2-root', mobileNote: 'eh2-mobile-note',
    mobileBoard: 'eh2-mobile-board', mobileDetail: 'eh2-mobile-detail',
    main: 'eh2-main', canvas: 'eh2-canvas',
    header: 'eh2-header', rangeGroup: 'eh2-range-group',
    hourGroup: 'eh2-hour-mode-group',
    expandToggle: 'eh2-expand-toggle',
    expandedClose: 'eh2-expanded-close',
    legend: 'eh2-legend', tooltip: 'eh2-tooltip',
    keyWrap: 'eh2-key-wrap', keySelect: 'eh2-key-select',
    // modal
    overlay: 'eh2-range-overlay',
    prev: 'eh2-prev', next: 'eh2-next', title: 'eh2-title', grid: 'eh2-grid',
    selectionValue: 'eh2-selection-value',
    close: 'eh2-close', cancel: 'eh2-cancel', apply: 'eh2-apply',
    quickWeek: 'eh2-week-cur', quickMonth: 'eh2-month-cur'
  };

  /*************** PALETTE & HELPERS ***************/
  var NO_DATA_COLOR = '#f3f4f6';
  // Brand palettes (1st: #ED1C24, 2nd: green, 3rd: #2196F3)
  var COLORS_RED = ['#fff1f2', '#fecdd3', '#fda4af', '#fb7185', '#ed1c24'];
  var COLORS_GREEN = ['#ecfdf5', '#a7f3d0', '#6ee7b7', '#34d399', '#16a34a'];
  var COLORS_BLUE = ['#e3f2fd', '#bbdefb', '#90caf9', '#64b5f6', '#2196f3'];

  var selectedKeyId = null, dataKeyList = [];

  function getPaletteForSelectedKey() {
    var idx = 0;
    for (var i = 0; i < dataKeyList.length; i++) {
      if (String(dataKeyList[i].id) === String(selectedKeyId)) { idx = i; break; }
    }
    return [COLORS_RED, COLORS_GREEN, COLORS_BLUE][idx % 3];
  }

  var MS = { day: 86400000 };
  function getSharedOffsetMinutes() {
    try {
      var raw = localStorage.getItem(SHARED_OFFSET_KEY);
      if (raw === null) return 0;
      var val = parseInt(raw, 10);
      return isNaN(val) ? 0 : val;
    } catch (_) {
      return 0;
    }
  }
  function getShiftedUtcDate(input) {
    var ms = input instanceof Date ? input.getTime() : Number(input);
    if (!isFinite(ms)) ms = Date.now();
    return new Date(ms + getSharedOffsetMinutes() * 60000);
  }
  function getOffsetParts(input) {
    var d = getShiftedUtcDate(input);
    return {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth(),
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      min: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
      ms: d.getUTCMilliseconds(),
      dow: d.getUTCDay()
    };
  }
  function buildOffsetDate(y, m, d, h, min, s, ms) {
    return new Date(Date.UTC(y, m, d, h || 0, min || 0, s || 0, ms || 0) - getSharedOffsetMinutes() * 60000);
  }
  function nowForOffset() { return getShiftedUtcDate(Date.now()); }
  function startOfDay(d) {
    var p = getOffsetParts(d);
    return buildOffsetDate(p.y, p.m, p.d, 0, 0, 0, 0);
  }
  function endOfDay(d) {
    var p = getOffsetParts(d);
    return buildOffsetDate(p.y, p.m, p.d, 23, 59, 59, 999);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function getEl(id) { return document.getElementById(id); }
  function isExpandedView() { return !!isExpanded; }
  function getCardEl() {
    var root = getEl(ids.root);
    if (root && root.classList && root.classList.contains('eh-expanded')) {
      var expandedCard = root.querySelector('.eh-card');
      if (expandedCard) return expandedCard;
      return root;
    }
    try {
      if (self && self.ctx && self.ctx.$container && self.ctx.$container[0]) return self.ctx.$container[0];
    } catch (_) { }
    return document.body;
  }
  function getViewportWidth() {
    try {
      var w = window.top || window;
      return w.innerWidth || window.innerWidth || 0;
    } catch (_) {
      return window.innerWidth || 0;
    }
  }
  function isNarrowViewport() {
    var card = getCardEl();
    var cardW = card ? card.clientWidth : 0;
    var vw = getViewportWidth() || cardW;
    return (vw > 0 && vw <= 767) || (cardW > 0 && cardW <= 720);
  }
  function isPortraitViewport() {
    var w = 0, h = 0;
    try {
      var vv = window.visualViewport;
      if (vv) {
        w = vv.width || 0;
        h = vv.height || 0;
      }
    } catch (_) { }
    if (!w || !h) {
      try {
        var topWin = window.top || window;
        w = topWin.innerWidth || window.innerWidth || 0;
        h = topWin.innerHeight || window.innerHeight || 0;
      } catch (_) {
        w = window.innerWidth || 0;
        h = window.innerHeight || 0;
      }
    }
    return h >= w;
  }
  function isExpandedMobileView() {
    return isExpandedView() && isNarrowViewport();
  }
  function isMobileLayout() {
    if (isExpandedView()) return false;
    return isNarrowViewport();
  }
  function syncResponsiveLayout() {
    var root = getEl(ids.root);
    if (root && root.classList) {
      root.classList.toggle('eh-mobile', isMobileLayout());
      root.classList.toggle('eh-expanded-mobile', isExpandedMobileView());
      root.classList.toggle('eh-expanded-mobile-portrait', isExpandedMobileView() && isPortraitViewport());
    }
  }
  function getLayoutConfig() {
    var mobile = isMobileLayout();
    var card = getCardEl();
    var cardW = card ? card.clientWidth : 0;
    var showColorScale = !mobile && cardW >= ((hourMode === '10h') ? 700 : 880) && !isExpandedView();
    var expandedNarrow = isExpandedView() && cardW > 0 && cardW < 560;
    return {
      mobile: mobile,
      expanded: isExpandedView(),
      padL: mobile ? 70 : (isExpandedView() ? (expandedNarrow ? 72 : 96) : (cardW > 0 && cardW < 700 ? 82 : PAD_HM.L)),
      padT: mobile ? 30 : (isExpandedView() ? 40 : PAD_HM.T),
      padR: mobile ? 18 : (showColorScale ? PAD_HM.R : 16),
      padB: mobile ? 18 : (isExpandedView() ? 30 : PAD_HM.B),
      cellMinWidth: mobile ? ((hourMode === '10h') ? 46 : 42) : (isExpandedView() ? ((hourMode === '10h') ? 72 : 44) : 58),
      minHeight: mobile ? 220 : (isExpandedView() ? 520 : 280),
      minRowHeight: mobile ? 28 : 22,
      xAxisStep: mobile ? ((hourMode === '10h') ? 3 : 4) : (isExpandedView() ? 1 : 2),
      labelFont: mobile ? 11 : (isExpandedView() ? (expandedNarrow ? 9 : 13) : 12),
      valueFont: mobile ? 10 : (isExpandedView() ? (expandedNarrow ? 10 : 12) : 11),
      showColorScale: showColorScale,
      hourLabelCompact: isExpandedView() || expandedNarrow
    };
  }
  function getMobileTableMetrics() {
    var expandedMobile = isExpandedMobileView();
    var portraitExpanded = expandedMobile && isPortraitViewport();
    var allDay = hourMode === '24h';
    return {
      dateWidth: portraitExpanded ? (allDay ? 40 : 48) : (expandedMobile ? (allDay ? 56 : 64) : 92),
      headerHeight: portraitExpanded ? (allDay ? 24 : 28) : (expandedMobile ? (allDay ? 34 : 36) : 44),
      cellWidth: portraitExpanded ? (allDay ? 18 : 24) : (expandedMobile ? (allDay ? 30 : 36) : 56),
      cellHeight: portraitExpanded ? (allDay ? 24 : 28) : (expandedMobile ? (allDay ? 34 : 38) : 50),
      hourFont: portraitExpanded ? 8 : (expandedMobile ? (allDay ? 9 : 10) : 11),
      dateMainFont: portraitExpanded ? (allDay ? 8 : 9) : (expandedMobile ? (allDay ? 10 : 11) : 12),
      dateSubFont: portraitExpanded ? 8 : (expandedMobile ? 10 : 11),
      valueFont: portraitExpanded ? (allDay ? 8 : 9) : (expandedMobile ? (allDay ? 9 : 10) : 11),
      compact: expandedMobile,
      portraitExpanded: portraitExpanded
    };
  }
  function requestLandscapeOrientation() {
    try {
      if (!isExpandedMobileView() || !isPortraitViewport()) return;
      if (!screen || !screen.orientation || !screen.orientation.lock) return;
      screen.orientation.lock('landscape').then(function () {
        __orientationLocked = true;
      }).catch(function () {
        __orientationLocked = false;
      });
    } catch (_) { }
  }
  function releaseOrientationLock() {
    try {
      if (!__orientationLocked) return;
      if (screen && screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    } catch (_) { }
    __orientationLocked = false;
  }
  function getWidgetId() {
    try {
      if (self && self.ctx && self.ctx.widget && self.ctx.widget.id) return String(self.ctx.widget.id);
      if (self && self.ctx && self.ctx.widget && self.ctx.widget.config && self.ctx.widget.config.id) return String(self.ctx.widget.config.id);
      if (self && self.ctx && self.ctx.$scope && self.ctx.$scope.widget && self.ctx.$scope.widget.id) return String(self.ctx.$scope.widget.id);
    } catch (_) { }
    return 'eh2';
  }
  function cacheKey() { return 'eh2_range_' + getWidgetId(); }
  function saveRangeCache() {
    try {
      if (typeof sessionStorage === 'undefined') return;
      var payload = {
        ts: Date.now(),
        mode: currentMode || 'custom',
        startMs: startMs || null,
        endMs: endMs || null,
        hourMode: hourMode || '10h'
      };
      sessionStorage.setItem(cacheKey(), JSON.stringify(payload));
    } catch (_) { }
  }
  function restoreRangeCache() {
    try {
      if (typeof sessionStorage === 'undefined') return false;
      var raw = sessionStorage.getItem(cacheKey());
      if (!raw) return false;
      var obj = JSON.parse(raw);
      if (!obj || !obj.ts || (Date.now() - obj.ts) > RANGE_CACHE_TTL_MS) return false;
      if (obj.startMs && obj.endMs) {
        startMs = Number(obj.startMs);
        endMs = Number(obj.endMs);
        buildDaysCount();
      }
      if (obj.hourMode) {
        hourMode = obj.hourMode;
        setActiveHourChip(hourMode);
      }
      if (obj.mode) {
        currentMode = obj.mode;
        setActiveRangeChip(obj.mode === 'custom' ? 'custom' : obj.mode);
      }
      return true;
    } catch (_) { }
    return false;
  }
  function buildDaysCount() {
    var a = startOfDay(startMs).getTime(), b = startOfDay(endMs).getTime();
    yDays = clamp(Math.floor((b - a) / MS.day) + 1, 1, 366);
  }
  function ymd(d) {
    var p = getOffsetParts(d);
    return p.y + '-' + String(p.m + 1).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
  }
  function dayIndexOf(ts) {
    return Math.floor((startOfDay(ts).getTime() - startOfDay(startMs).getTime()) / MS.day);
  }
  function syncDashboardTimewindow() {
    if (!startMs || !endMs) return;
    try {
      var d = (self.ctx && self.ctx.dashboard) ? self.ctx.dashboard : {};
      var interval = Math.max(60000, Math.min(MS.day, Math.floor((endMs - startMs) / Math.max(1, yDays || 1))));
      var tw = {
        hideInterval: false, hideQuickInterval: false, hideAggregation: false, hideAggInterval: false, hideTimezone: false,
        selectedTab: 1,
        realtime: { realtimeType: 0, interval: 1000, timewindowMs: 60000 },
        history: {
          historyType: 0,
          interval: interval,
          timewindowMs: Math.max(0, endMs - startMs),
          fixedTimewindow: { startTimeMs: startMs, endTimeMs: endMs }
        },
        aggregation: { type: 'NONE', limit: 50000, interval: interval },
        utcOffsetMinutes: getSharedOffsetMinutes()
      };
      if (d.setDashboardTimewindow) d.setDashboardTimewindow(tw);
      d.dashboardTimewindow = tw;
      if (self && self.ctx && self.ctx.dashboardCtrl && self.ctx.dashboardCtrl.onUpdateTimewindow) {
        self.ctx.dashboardCtrl.onUpdateTimewindow(tw);
      }
      if (d.dashboardTimewindowChangedSubject && d.dashboardTimewindowChangedSubject.next) {
        d.dashboardTimewindowChangedSubject.next(tw);
      }
    } catch (_) { }
  }

  /*************** ThingsBoard state helpers (ALL/SINGLE) ***************/
  function safeGetToken() {
    try { return localStorage.getItem('jwt_token') || localStorage.getItem('token') || ''; } catch (_) { return ''; }
  }
  function extractDeviceId(ent) {
    if (!ent) return null;
    if (typeof ent === 'string') return ent;
    if (typeof ent.id === 'string') return ent.id;
    if (ent.id && typeof ent.id.id === 'string') return ent.id.id;
    return null;
  }
  function dedupe(arr) {
    var out = [], set = new Set();
    (arr || []).forEach(function (x) {
      var v = String(x || '').trim();
      if (v && !set.has(v)) { set.add(v); out.push(v); }
    });
    return out;
  }
  function readStateParams() {
    var sc = self.ctx && self.ctx.stateController;
    if (!sc) return {};
    try { var p = sc.getStateParams(); if (p && typeof p === 'object') return p; } catch (_) { }
    try { var p2 = sc.getStateParams('default'); if (p2 && typeof p2 === 'object') return p2; } catch (_) { }
    return {};
  }
  function getAllDeviceIdsFromState(stateParams) {
    var list = stateParams.entities || stateParams.entityIds || [];
    var idsArr = [];
    if (Array.isArray(list)) list.forEach(function (e) { var id = extractDeviceId(e); if (id) idsArr.push(id); });
    else { var id2 = extractDeviceId(list); if (id2) idsArr.push(id2); }
    return dedupe(idsArr);
  }
  function getSelectedMode(stateParams) {
    var m = stateParams.selectedDeviceMode || stateParams.mode;
    return m === 'ALL' ? 'ALL' : 'SINGLE';
  }

  // Try to read current SINGLE device id from ctx datasources (more reliable than state sometimes)
  function getCurrentSingleEntityIdFromCtx() {
    try {
      var ds = self.ctx && (self.ctx.datasources || self.ctx.dataSources || self.ctx.dataSource);
      if (Array.isArray(ds) && ds.length) {
        var e = ds[0].entity || ds[0].entityId || ds[0].entityID;
        var id = extractDeviceId(e) || extractDeviceId(ds[0].entityId) || extractDeviceId(ds[0].entityID);
        if (id) return id;
      }
    } catch (_) { }
    return null;
  }

  /*************** BINS & COLORS ***************/
  function buildDiscreteBinsZeroToMax(max, levels) {
    max = Math.max(0, Math.ceil(isFinite(max) ? max : 0));
    var bins = [];
    if (levels <= 1) { bins.push({ from: 0, to: max, level: 0 }); return bins; }
    var total = max + 1;
    var base = Math.floor(total / levels);
    var extra = total % levels;
    var start = 0;
    for (var i = 0; i < levels; i++) {
      var len = base + (i < extra ? 1 : 0);
      var end = i < levels - 1 ? (start + len - 1) : max;
      if (len <= 0) end = start - 1;
      bins.push({ from: start, to: end, level: i });
      start = end + 1;
    }
    return bins;
  }
  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function luminance(r, g, b) {
    function s(u) { u /= 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); }
    var R = s(r), G = s(g), B = s(b);
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }
  function levelColor(val, hasData, max, PALETTE) {
    if (!hasData || !isFinite(val)) return { css: NO_DATA_COLOR, level: -1, lum: 1 };
    var dMax = Math.max(0, Math.ceil(max));
    if (!BINS.length || BINS[BINS.length - 1].to !== dMax) BINS = buildDiscreteBinsZeroToMax(dMax, LEVEL_COUNT);
    var vInt = Math.floor(Math.max(0, val) + 1e-9); if (vInt > dMax) vInt = dMax;
    var lvl = 0;
    for (var i = 0; i < BINS.length; i++) {
      var b = BINS[i];
      if (vInt >= b.from && vInt <= b.to) { lvl = b.level; break; }
    }
    var rgb = hexToRgb(PALETTE[lvl]);
    return { css: PALETTE[lvl], level: lvl, lum: luminance(rgb.r, rgb.g, rgb.b) };
  }

  /*************** HEADER / KEY ***************/
  /*************** HEADER / KEY ***************/
  function keyIdOf(it) {
    try { return String(it.dataKey && (it.dataKey.name != null ? it.dataKey.name : (it.dataKey.label != null ? it.dataKey.label : ''))); }
    catch (_) { return ''; }
  }
  function keyLabelOf(it) {
    try { return String((it.dataKey && (it.dataKey.label || it.dataKey.name)) || 'Data Key'); }
    catch (_) { return 'Data Key'; }
  }
  function collectDataKeys() {
    var seen = {}; dataKeyList = [];
    // Try ctx.data (subscription data)
    (self.ctx.data || []).forEach(function (it) {
      var id = keyIdOf(it); if (!id) return;
      var label = keyLabelOf(it);
      if (!seen[id]) { seen[id] = true; dataKeyList.push({ id: id, label: label }); }
    });

    // Fallback: Try ctx.datasources (configuration info) if no data yet
    if (!dataKeyList.length) {
      var ds = self.ctx.datasources || self.ctx.dataSources || [];
      ds.forEach(function (d) {
        (d.dataKeys || []).forEach(function (dk) {
          var id = dk.name;
          var label = dk.label || dk.name;
          if (id && !seen[id]) { seen[id] = true; dataKeyList.push({ id: id, label: label }); }
        });
      });
    }
  }

  function buildKeyDropdown() {
    var wrap = getEl(ids.keyWrap);
    if (!wrap) return;

    collectDataKeys();

    if (dataKeyList.length <= 1) {
      wrap.style.display = 'none';
      if (dataKeyList.length === 1) {
        selectedKeyId = dataKeyList[0].id;
      }
      return;
    }

    wrap.style.display = 'flex';

    var menu = document.getElementById('eh2-key-menu');
    var trigger = document.getElementById('eh2-key-trigger');
    var labelSpan = document.getElementById('eh2-key-label');

    if (!menu || !trigger || !labelSpan) return;
    menu.innerHTML = '';

    // Wire Trigger
    if (!trigger.__wired) {
      trigger.__wired = true;
      trigger.onclick = function (e) {
        e.stopPropagation();
        menu.classList.toggle('show');
        trigger.classList.toggle('active');
      };
      window.addEventListener('click', function (e) {
        if (!trigger.contains(e.target) && !menu.contains(e.target)) {
          menu.classList.remove('show');
          trigger.classList.remove('active');
        }
      });
    }

    // Populate Menu
    dataKeyList.forEach(function (k) {
      var item = document.createElement('div');
      item.className = 'eh-dropdown-item';
      item.textContent = k.label;
      item.onclick = function () {
        selectedKeyId = k.id;
        updateLabel();
        menu.classList.remove('show');
        trigger.classList.remove('active');
        forceRefresh();
      };
      menu.appendChild(item);
    });

    if (!selectedKeyId || !dataKeyList.some(function (x) { return String(x.id) === String(selectedKeyId); })) {
      selectedKeyId = dataKeyList.length ? dataKeyList[0].id : null;
    }

    function updateLabel() {
      var found = dataKeyList.find(function (x) { return String(x.id) === String(selectedKeyId); });
      labelSpan.textContent = found ? found.label : 'Select';

      // Update selected class
      Array.from(menu.children).forEach(function (child) {
        child.classList.remove('selected');
        if (found && child.textContent === found.label) child.classList.add('selected');
      });
    }

    updateLabel();
  }

  /*************** LAYOUT / LEGEND ***************/

  function ensureMainWrap() {
    var card = getCardEl();
    var main = getEl(ids.main);
    if (!main) {
      main = document.createElement('div');
      main.id = ids.main;
      (card || document.body).appendChild(main);
    }
    var canvas = getEl(ids.canvas);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = ids.canvas;
      canvas.className = 'eh-canvas';
    }
    if (canvas.parentElement !== main) main.insertBefore(canvas, main.firstChild);

    var legend = getEl(ids.legend);
    if (!legend) {
      legend = document.createElement('div');
      legend.id = ids.legend;
    }
    if (legend.parentElement !== main) main.appendChild(legend);
    return { main: main, canvas: canvas };
  }

  function renderLegend() {
    var legend = getEl(ids.legend);
    if (!legend) return;
    legend.innerHTML = '';

    var PALETTE = getPaletteForSelectedKey();
    BINS = buildDiscreteBinsZeroToMax(domainMax, LEVEL_COUNT);

    BINS.forEach(function (b) {
      var chip = document.createElement('div'); chip.className = 'eh-chip';
      var sw = document.createElement('span'); sw.className = 'eh-swatch'; sw.style.background = PALETTE[b.level];
      var txt = document.createElement('span');
      txt.textContent = (b.to < b.from) ? '—' : (b.from + ' – ' + b.to);
      chip.appendChild(sw); chip.appendChild(txt);
      legend.appendChild(chip);
    });
  }

  /*************** VERTICAL COLOR SCALE (on canvas) ***************/
  function drawColorScale(ctx, canvasWidth, canvasHeight, PALETTE, layout) {
    if (!BINS || BINS.length === 0) return;

    layout = layout || getLayoutConfig();
    var padL = layout.padL, padT = layout.padT, padR = layout.padR, padB = layout.padB;
    var scaleWidth = 30;
    var scaleX = canvasWidth - padR + 20; // Position in right padding area
    var scaleHeight = canvasHeight - padT - padB;
    var cellHeight = scaleHeight / BINS.length;

    // Draw title
    ctx.save();
    ctx.fillStyle = '#475569';
    ctx.font = 'bold ' + layout.labelFont + 'px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Visitor Count', scaleX, padT - 20);

    // Draw each color level (reversed: 0 at bottom, high at top)
    BINS.slice().reverse().forEach(function (b, idx) {
      var y = padT + idx * cellHeight;

      // Draw colored rectangle
      ctx.fillStyle = PALETTE[b.level];
      ctx.fillRect(scaleX, y, scaleWidth, cellHeight - 2);

      // Draw border
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.strokeRect(scaleX, y, scaleWidth, cellHeight - 2);

      // Draw label
      ctx.fillStyle = '#475569';
      ctx.font = Math.max(10, layout.labelFont - 1) + 'px Arial';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      var label = (b.to < b.from) ? '—' : (b.from + ' – ' + b.to);
      ctx.fillText(label, scaleX + scaleWidth + 6, y + cellHeight / 2);
    });

    ctx.restore();
  }


  /*************** RANGE CHIPS / HOUR MODE ***************/
  function setActiveRangeChip(mode) {
    var wrap = getEl(ids.rangeGroup);
    if (!wrap) return;
    Array.prototype.slice.call(wrap.querySelectorAll('.eh-btn--chip')).forEach(function (b) { b.classList.remove('active'); });
    var target = wrap.querySelector('[data-range="' + mode + '"]');
    if (target) target.classList.add('active');
  }
  function clearActiveRangeChips() {
    var wrap = getEl(ids.rangeGroup);
    if (!wrap) return;
    Array.prototype.slice.call(wrap.querySelectorAll('.eh-btn--chip')).forEach(function (b) { b.classList.remove('active'); });
  }
  function setActiveHourChip(mode) {
    // Only one toggle button now
    var btn = document.getElementById('eh2-hour-toggle');
    if (!btn) return;

    // Update state
    btn.setAttribute('data-hour-mode', mode);

    // Update text
    var span = btn.querySelector('.eh-btn-text');
    if (span) {
      if (mode === '10h') {
        span.textContent = 'Business Hours';
      } else {
        span.textContent = 'All Day';
      }
    }
  }

  function setExpandedState(enabled) {
    var root = getEl(ids.root);
    var btn = getEl(ids.expandToggle);
    if (!root || !btn) return;
    if (!!enabled === !!isExpanded) {
      btn.classList.toggle('active', !!enabled);
      btn.setAttribute('aria-label', enabled ? 'Collapse fullscreen' : 'Expand fullscreen');
      btn.setAttribute('title', enabled ? 'Collapse fullscreen' : 'Expand fullscreen');
      return;
    }

    if (enabled) {
      root.classList.add('eh-expanded');
      isExpanded = true;
    } else {
      root.classList.remove('eh-expanded');
      isExpanded = false;
    }

    btn.classList.toggle('active', isExpanded);
    btn.setAttribute('aria-label', isExpanded ? 'Collapse fullscreen' : 'Expand fullscreen');
    btn.setAttribute('title', isExpanded ? 'Collapse fullscreen' : 'Expand fullscreen');
    try { document.body.style.overflow = isExpanded ? 'hidden' : ''; } catch (_) { }
    syncResponsiveLayout();
    if (isExpanded) requestLandscapeOrientation();
    else releaseOrientationLock();
    updateCanvasSize();
    if (lastHeatmapMap) renderHeatmapView(lastHeatmapMap);
    else drawNoData('Loading...');
  }

  function wireExpandButton() {
    var btn = getEl(ids.expandToggle);
    if (btn && !btn.__wired) {
      btn.__wired = true;
      btn.addEventListener('click', function () {
        setExpandedState(!isExpanded);
      });
    }
    var closeBtn = getEl(ids.expandedClose);
    if (closeBtn && !closeBtn.__wired) {
      closeBtn.__wired = true;
      closeBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        setExpandedState(false);
      });
    }
  }

  function wireHourModeButtons() {
    var group = document.getElementById('eh2-hour-mode-group');
    if (!group) return;

    // Check if we already wired the group
    if (group.__wired) return;
    group.__wired = true;

    group.addEventListener('click', function (ev) {
      // Find the button (target or closest)
      var btn = ev.target.closest('#eh2-hour-toggle');
      if (!btn) {
        // Fallback: checks if they are clicking the old buttons (stale HTML case)
        // If so, we might want to reload or just handle it if possible, 
        // but priority is the new button.
        return;
      }

      var current = btn.getAttribute('data-hour-mode') || '10h';
      var next = (current === '10h') ? '24h' : '10h';

      hourMode = next;
      setActiveHourChip(next);
      saveRangeCache();
      forceRefresh(false);
    });
  }

  function setPresetRange(mode) {
    var now = nowForOffset();
    var end = endOfDay(now).getTime();
    var nowParts = getOffsetParts(now);
    var start = buildOffsetDate(nowParts.y, nowParts.m, nowParts.d, 0, 0, 0, 0);

    if (mode === '1d') {
      start = buildOffsetDate(nowParts.y, nowParts.m, nowParts.d - 1, 0, 0, 0, 0);
    } else if (mode === '1w') {
      start = buildOffsetDate(nowParts.y, nowParts.m, nowParts.d - 6, 0, 0, 0, 0);
    } else if (mode === '1m') {
      start = buildOffsetDate(nowParts.y, nowParts.m, nowParts.d - 29, 0, 0, 0, 0);
    } else {
      start = buildOffsetDate(nowParts.y, nowParts.m, nowParts.d - 6, 0, 0, 0, 0);
    }

    startMs = start.getTime();
    endMs = end;
    buildDaysCount();
    currentMode = mode;
    saveRangeCache();
    syncDashboardTimewindow();
  }

  function wireRangeButtons() {
    var wrap = getEl(ids.rangeGroup);
    if (!wrap) return;
    if (wrap.__wired) return;
    wrap.__wired = true;

    wrap.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.eh-btn--chip');
      if (!btn) return;
      var mode = btn.getAttribute('data-range');
      if (!mode) return;

      setActiveRangeChip(mode);

      if (mode === 'custom') {
        currentMode = 'custom';
        openRangeModal();
        return;
      }

      currentMode = 'custom';
      setPresetRange(mode);
      forceRefresh();
    });
  }

  /*************** MODAL (CUSTOM RANGE) ***************/
  var modalState = { start: null, end: null, base: null };

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
  function firstOfMonth(d) {
    var p = getOffsetParts(d);
    return buildOffsetDate(p.y, p.m, 1, 0, 0, 0, 0);
  }
  function addMonths(d, n) {
    var p = getOffsetParts(d);
    return buildOffsetDate(p.y, p.m + n, 1, 0, 0, 0, 0);
  }
  function monthLabel(d) { return getShiftedUtcDate(d).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  function mondayOfCurrentWeek(now) {
    var p = getOffsetParts(now);
    var dow = (p.dow + 6) % 7;
    return buildOffsetDate(p.y, p.m, p.d - dow, 0, 0, 0, 0);
  }

  function daysInMatrix(baseDate) {
    var parts = getOffsetParts(baseDate);
    var y = parts.y, m = parts.m;
    var first = buildOffsetDate(y, m, 1, 0, 0, 0, 0), dowMon0 = (getOffsetParts(first).dow + 6) % 7;
    var dim = daysInMonth(y, m), prevDim = daysInMonth(y, m - 1);
    var cells = [];
    for (var i = 0; i < dowMon0; i++) cells.push({ y: y, m: m - 1, d: prevDim - dowMon0 + 1 + i, out: true });
    for (var d = 1; d <= dim; d++) cells.push({ y: y, m: m, d: d, out: false });
    while (cells.length % 7 !== 0) {
      var last = cells[cells.length - 1];
      cells.push({ y: last.m === 11 ? last.y + 1 : last.y, m: (last.m + 1) % 12, d: (last.d || 0) + 1, out: true });
    }
    while (cells.length < 42) {
      var L = cells[cells.length - 1];
      cells.push({ y: L.m === 11 ? L.y + 1 : L.y, m: (L.m + 1) % 12, d: (L.d || 0) + 1, out: true });
    }
    return cells;
  }
  function sameDate(a, b) {
    if (!a || !b) return false;
    var pa = getOffsetParts(a), pb = getOffsetParts(b);
    return pa.y === pb.y && pa.m === pb.m && pa.d === pb.d;
  }
  function isBetween(d, a, b) {
    if (!a || !b) return false;
    var x = a.getTime(), y = b.getTime(); if (x > y) { var t = x; x = y; y = t; }
    var t0 = startOfDay(d).getTime();
    return t0 >= startOfDay(x).getTime() && t0 <= startOfDay(y).getTime();
  }

  function formatRangeDate(d) {
    if (!d) return '';
    return getShiftedUtcDate(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function updateRangeSelectionLabel() {
    var el = getEl(ids.selectionValue);
    if (!el) return;

    if (!modalState.start && !modalState.end) {
      el.textContent = 'No dates selected';
      return;
    }

    if (modalState.start && !modalState.end) {
      el.textContent = formatRangeDate(modalState.start);
      return;
    }

    var s = modalState.start, e = modalState.end || modalState.start;
    if (e.getTime() < s.getTime()) { var tmp = s; s = e; e = tmp; }
    el.textContent = formatRangeDate(s) + ' - ' + formatRangeDate(e);
  }

  function renderCalendars() {
    var current = modalState.base ? firstOfMonth(modalState.base) : firstOfMonth(nowForOffset());
    var title = getEl(ids.title);
    if (title) title.textContent = monthLabel(current);
    fillGrid(getEl(ids.grid), current);
    updateRangeSelectionLabel();
  }
  function fillGrid(container, monthDate) {
    if (!container) return;
    container.innerHTML = '';
    daysInMatrix(monthDate).forEach(function (c) {
      var realMonth = (c.m % 12 + 12) % 12;
      var realYear = c.m < 0 ? c.y - 1 : (c.m > 11 ? c.y + 1 : c.y);
      var d = buildOffsetDate(realYear, realMonth, c.d, 0, 0, 0, 0);

      var el = document.createElement('div');
      el.className = 'eh2-day' + (c.out ? ' out' : '');
      el.textContent = String(c.d);

      if (modalState.start && sameDate(d, modalState.start)) el.classList.add('edge', 'sel');
      if (modalState.end && sameDate(d, modalState.end)) el.classList.add('edge', 'sel');
      if (modalState.start && modalState.end && isBetween(d, modalState.start, modalState.end)) el.classList.add('in');

      el.onclick = function () {
        if (c.out) return;
        if (!modalState.start || (modalState.start && modalState.end)) {
          modalState.start = startOfDay(d); modalState.end = null;
        } else {
          if (d.getTime() < modalState.start.getTime()) {
            modalState.end = modalState.start; modalState.start = startOfDay(d);
          } else {
            modalState.end = startOfDay(d);
          }
        }
        renderCalendars();
      };
      container.appendChild(el);
    });
  }

  function openRangeModal() {
    var overlay = getEl(ids.overlay);
    if (!overlay) {
      setPresetRange('1m');
      setActiveRangeChip('1m');
      forceRefresh();
      return;
    }

    var now = nowForOffset();
    if (startMs && endMs) {
      modalState.start = startOfDay(new Date(startMs));
      modalState.end = startOfDay(new Date(endMs));
    } else {
      modalState.start = mondayOfCurrentWeek(now);
      modalState.end = startOfDay(now);
    }
    modalState.base = firstOfMonth(modalState.start || now);
    renderCalendars();

    function safeOn(id, fn) { var el = getEl(id); if (el) el.onclick = fn; }

    safeOn(ids.prev, function () { modalState.base = addMonths(modalState.base, -1); renderCalendars(); });
    safeOn(ids.next, function () { modalState.base = addMonths(modalState.base, 1); renderCalendars(); });

    safeOn(ids.quickWeek, function () {
      var s = mondayOfCurrentWeek(now), e = startOfDay(now);
      modalState.start = s; modalState.end = e; modalState.base = firstOfMonth(s); renderCalendars();
    });
    safeOn(ids.quickMonth, function () {
      var np = getOffsetParts(now);
      var s = buildOffsetDate(np.y, np.m, 1, 0, 0, 0, 0), e = startOfDay(now);
      modalState.start = s; modalState.end = e; modalState.base = firstOfMonth(s); renderCalendars();
    });

    function closeOverlay() {
      overlay.style.display = 'none';
      window.removeEventListener('keydown', escToClose);
    }
    function escToClose(e) { if (e.key === 'Escape') closeOverlay(); }

    safeOn(ids.close, closeOverlay);
    safeOn(ids.cancel, closeOverlay);

    overlay.onclick = function (ev) { if (ev.target === overlay) closeOverlay(); };

    safeOn(ids.apply, function () {
      if (!modalState.start) { alert('Select start date'); return; }
      if (!modalState.end) modalState.end = modalState.start;
      var s = startOfDay(modalState.start), e = endOfDay(modalState.end);
      if (e < s) { var t = s; s = e; e = t; }

      startMs = s.getTime();
      endMs = e.getTime();
      buildDaysCount();

      closeOverlay();
      setActiveRangeChip('custom');
      currentMode = 'custom';
      saveRangeCache();
      syncDashboardTimewindow();
      forceRefresh();
    });

    window.addEventListener('keydown', escToClose);
    overlay.style.display = 'flex';
  }

  /*************** DATA: ALL DEVICES FETCH + SUM ***************/
  async function fetchAllDevicesAndBuildMap(deviceIds, keyName, startTs, endTs, signal) {
    var seq = ++__fetchSeq;

    var rows = Math.max(1, yDays);
    var map = {};
    for (var h = 0; h < 24; h++) {
      for (var d = 0; d < rows; d++) {
        map[h + '_' + d] = { value: 0, has: false };
      }
    }

    var token = safeGetToken();
    var urlKey = encodeURIComponent(String(keyName));
    var startNum = Number(startTs), endNum = Number(endTs);

    await Promise.all((deviceIds || []).map(async function (deviceId) {
      var url =
        '/api/plugins/telemetry/DEVICE/' + deviceId + '/values/timeseries' +
        '?keys=' + urlKey +
        '&startTs=' + startNum +
        '&endTs=' + endNum +
        '&limit=100000&agg=NONE';

      try {
        var res = await fetch(url, {
          method: 'GET',
          headers: (function () {
            var h = { 'Content-Type': 'application/json' };
            if (token) h['X-Authorization'] = 'Bearer ' + token;
            return h;
          })(),
          signal: signal
        });
        if (!res.ok) return;

        var data = await res.json();

        var points = (data && data[keyName]) ? data[keyName]
          : (data && data[String(keyName).toLowerCase()]) ? data[String(keyName).toLowerCase()]
            : (data && data[String(keyName).toUpperCase()]) ? data[String(keyName).toUpperCase()]
              : [];

        for (var i = 0; i < points.length; i++) {
          var p = points[i];
          var ts = Number(p.ts);
          var val = Number(p.value);
          if (!isFinite(ts) || !isFinite(val)) continue;
          if (ts < startNum || ts > endNum) continue;

          var dIdx = dayIndexOf(ts);
          if (dIdx < 0 || dIdx >= rows) continue;

          var hr = getOffsetParts(ts).h;
          var k = hr + '_' + dIdx;

          map[k].value += val;
          map[k].has = true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }));

    if (seq !== __fetchSeq) return null;
    if (signal && signal.aborted) return null;
    return map;
  }

  /*************** DRAW ***************/
  function formatInt(v) { return isFinite(v) ? String(Math.round(v)) : '—'; }
  function cellKey(hour, dayIdx) { return String(hour) + '_' + String(dayIdx); }
  function selectedKeyLabel() {
    var found = dataKeyList.find(function (x) { return String(x.id) === String(selectedKeyId); });
    return found ? found.label : 'People';
  }
  function getCellDetails(hour, dayIdx, cell) {
    var date = new Date(startOfDay(startMs).getTime() + dayIdx * MS.day);
    var h0 = String(hour).padStart(2, '0') + ':00';
    var h1 = String((hour + 1) % 24).padStart(2, '0') + ':00';
    return {
      key: cellKey(hour, dayIdx),
      hour: hour,
      dayIdx: dayIdx,
      hasData: !!(cell && cell.has),
      value: (cell && cell.value) || 0,
      valueText: formatInt((cell && cell.value) || 0),
      dateFull: getShiftedUtcDate(date).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      dateMain: getShiftedUtcDate(date).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      dateSub: getShiftedUtcDate(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }),
      timeLabel: h0 + ' – ' + h1
    };
  }
  function updateMobileDetail(details, emptyMessage) {
    var detail = getEl(ids.mobileDetail);
    if (!detail) return;

    if (!details) {
      detail.innerHTML =
        '<div class="eh-mobile-detail-head">Selected Cell</div>' +
        '<div class="eh-mobile-detail-title">' + (emptyMessage || 'Tap a cell to inspect details') + '</div>' +
        '<div class="eh-mobile-detail-meta">All data remains available through horizontal and vertical scrolling.</div>';
      return;
    }

    var valueClass = 'eh-mobile-detail-value' + (details.hasData ? '' : ' is-empty');
    var valueText = details.hasData ? (details.valueText + ' ' + selectedKeyLabel()) : 'No data';
    detail.innerHTML =
      '<div class="eh-mobile-detail-head">Selected Cell</div>' +
      '<div class="eh-mobile-detail-title">' + details.dateFull + '</div>' +
      '<div class="eh-mobile-detail-meta">' + details.timeLabel + '</div>' +
      '<div class="' + valueClass + '">' + valueText + '</div>';
  }
  function renderMobileHeatmap(map) {
    var board = getEl(ids.mobileBoard);
    if (!board) return;
    var metrics = getMobileTableMetrics();
    board.classList.toggle('is-expanded-view', isExpandedMobileView());

    if (!map) {
      board.innerHTML = '<div class="eh-mobile-empty">No data</div>';
      updateMobileDetail(null, 'No data available');
      return;
    }

    var rows = Math.max(1, yDays);
    var startHour = (hourMode === '10h') ? 7 : 0;
    var endHour = (hourMode === '10h') ? 19 : 23;
    var PALETTE = getPaletteForSelectedKey();
    var selected = null;
    if (mobileSelectedCellKey) {
      var parts = mobileSelectedCellKey.split('_');
      if (parts.length === 2) {
        var sh = Number(parts[0]), sd = Number(parts[1]);
        if (isFinite(sh) && isFinite(sd) && sh >= startHour && sh <= endHour && sd >= 0 && sd < rows) {
          selected = { hour: sh, dayIdx: sd };
        }
      }
    }

    if (!selected) {
      for (var dd0 = 0; dd0 < rows && !selected; dd0++) {
        for (var hh0 = startHour; hh0 <= endHour; hh0++) {
          var pickCell = map[cellKey(hh0, dd0)];
          if (pickCell && pickCell.has) {
            selected = { hour: hh0, dayIdx: dd0 };
            break;
          }
        }
      }
    }
    if (!selected) selected = { hour: startHour, dayIdx: 0 };
    mobileSelectedCellKey = cellKey(selected.hour, selected.dayIdx);

    var transposed = !!metrics.portraitExpanded;
    var tableClass = 'eh-mobile-table' +
      (metrics.compact && !transposed ? ' is-compact' : '') +
      (transposed ? ' is-transposed' : '');
    var html = '<table class="' + tableClass + '"><thead><tr>';
    html += '<th class="eh-mobile-corner" style="min-width:' + metrics.dateWidth + 'px;width:' + metrics.dateWidth + 'px;height:' + metrics.headerHeight + 'px;">' +
      '<span class="eh-mobile-corner-date">' + (transposed ? 'Hour' : 'Date') + '</span><span class="eh-mobile-corner-hour">' + (transposed ? 'Date' : 'Hour') + '</span></th>';

    if (transposed) {
      for (var dayHead = 0; dayHead < rows; dayHead++) {
        var headInfo = getCellDetails(startHour, dayHead, map[cellKey(startHour, dayHead)]);
        html += '<th class="eh-mobile-date eh-mobile-date-col" style="min-width:' + metrics.cellWidth + 'px;width:' + metrics.cellWidth + 'px;height:' + metrics.headerHeight + 'px;">' +
          '<span class="eh-mobile-date-main" style="font-size:' + metrics.dateMainFont + 'px;">' + headInfo.dateMain + '</span>' +
          '<span class="eh-mobile-date-sub" style="font-size:' + metrics.dateSubFont + 'px;">' + headInfo.dateSub + '</span></th>';
      }
      html += '</tr></thead><tbody>';

      for (var hour = startHour; hour <= endHour; hour++) {
        html += '<tr>';
        html += '<th class="eh-mobile-hour eh-mobile-hour-row" style="min-width:' + metrics.dateWidth + 'px;width:' + metrics.dateWidth + 'px;height:' + metrics.cellHeight + 'px;font-size:' + metrics.hourFont + 'px;">' + String(hour).padStart(2, '0') + '</th>';
        for (var dayIdxT = 0; dayIdxT < rows; dayIdxT++) {
          var keyT = cellKey(hour, dayIdxT);
          var cellT = map[keyT];
          var valueT = (cellT && cellT.value) || 0;
          var lcT = levelColor(valueT, !!(cellT && cellT.has), domainMax, PALETTE);
          var fgT = (cellT && cellT.has) ? ((lcT.level >= 0 && lcT.lum < 0.5) ? '#ffffff' : '#0f172a') : '#94a3b8';
          var clsT = 'eh-mobile-cell-btn' + ((cellT && cellT.has) ? '' : ' is-empty') + (mobileSelectedCellKey === keyT ? ' is-selected' : '') + ' is-compact';
          var labelT = (cellT && cellT.has) ? formatInt(valueT) : '—';
          html += '<td style="width:' + metrics.cellWidth + 'px;height:' + metrics.cellHeight + 'px;background:' + lcT.css + ';">' +
            '<button class="' + clsT + '" data-hour="' + hour + '" data-day="' + dayIdxT +
            '" style="width:100%;height:100%;background:' + lcT.css + ';color:' + fgT + ';font-size:' + metrics.valueFont + 'px;">' + labelT + '</button></td>';
        }
        html += '</tr>';
      }
    } else {
      for (var hour2 = startHour; hour2 <= endHour; hour2++) {
        html += '<th class="eh-mobile-hour" style="min-width:' + metrics.cellWidth + 'px;width:' + metrics.cellWidth + 'px;height:' + metrics.headerHeight + 'px;font-size:' + metrics.hourFont + 'px;">' + String(hour2).padStart(2, '0') + '</th>';
      }
      html += '</tr></thead><tbody>';

      for (var dayIdx = 0; dayIdx < rows; dayIdx++) {
        var sampleCell = map[cellKey(startHour, dayIdx)];
        var dateInfo = getCellDetails(startHour, dayIdx, sampleCell);
        html += '<tr>';
        html += '<th class="eh-mobile-date" style="min-width:' + metrics.dateWidth + 'px;width:' + metrics.dateWidth + 'px;">' +
          '<span class="eh-mobile-date-main" style="font-size:' + metrics.dateMainFont + 'px;">' + dateInfo.dateMain +
          '</span><span class="eh-mobile-date-sub" style="font-size:' + metrics.dateSubFont + 'px;">' + dateInfo.dateSub + '</span></th>';

        for (var hour3 = startHour; hour3 <= endHour; hour3++) {
          var key = cellKey(hour3, dayIdx);
          var cell = map[key];
          var value = (cell && cell.value) || 0;
          var lc = levelColor(value, !!(cell && cell.has), domainMax, PALETTE);
          var fg = (cell && cell.has) ? ((lc.level >= 0 && lc.lum < 0.5) ? '#ffffff' : '#0f172a') : '#94a3b8';
          var cls = 'eh-mobile-cell-btn' + ((cell && cell.has) ? '' : ' is-empty') + (mobileSelectedCellKey === key ? ' is-selected' : '') + (metrics.compact ? ' is-compact' : '');
          var label = (cell && cell.has) ? formatInt(value) : '—';
          html += '<td style="width:' + metrics.cellWidth + 'px;height:' + metrics.cellHeight + 'px;background:' + lc.css + ';">' +
            '<button class="' + cls + '" data-hour="' + hour3 + '" data-day="' + dayIdx +
            '" style="width:100%;height:100%;background:' + lc.css + ';color:' + fg + ';font-size:' + metrics.valueFont + 'px;">' + label + '</button></td>';
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table>';
    board.innerHTML = html;

    if (!board.__wired) {
      board.__wired = true;
      board.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.eh-mobile-cell-btn');
        if (!btn || !board.contains(btn)) return;
        mobileSelectedCellKey = cellKey(Number(btn.getAttribute('data-hour')), Number(btn.getAttribute('data-day')));
        renderMobileHeatmap(lastHeatmapMap);
      });
    }

    var currentCell = map[mobileSelectedCellKey];
    var selectedParts = mobileSelectedCellKey.split('_');
    updateMobileDetail(getCellDetails(Number(selectedParts[0]), Number(selectedParts[1]), currentCell));
  }
  function renderHeatmapView(map) {
    syncResponsiveLayout();
    if (isMobileLayout() || isExpandedMobileView()) {
      renderMobileHeatmap(map);
      return;
    }
    var board = getEl(ids.mobileBoard);
    if (board) board.innerHTML = '';
    drawHeatmap(map);
  }

  function drawNoData(msg) {
    syncResponsiveLayout();
    if (isMobileLayout() || isExpandedMobileView()) {
      var board = getEl(ids.mobileBoard);
      if (board) board.innerHTML = '<div class="eh-mobile-empty">' + (msg || 'No data') + '</div>';
      updateMobileDetail(null, msg || 'No data');
      return;
    }
    var c = getEl(ids.canvas);
    if (!c) return;
    var ctx = c.getContext('2d');
    updateCanvasSize();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#64748b';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'No data', c.width / 2, c.height / 2);
  }

  function computeDomainMax(map) {
    var rows = Math.max(1, yDays);
    var now = nowForOffset(), nowHour = getOffsetParts(now).h;
    var baseDay = startOfDay(startMs).getTime();
    var maxVal = -Infinity;

    for (var hh = 0; hh < 24; hh++) {
      for (var dd = 0; dd < rows; dd++) {
        var theDay = new Date(baseDay + dd * MS.day);
        var skip = (hh === nowHour && ymd(theDay) === ymd(now));
        if (skip) continue;
        var cell = map[hh + '_' + dd];
        var v = cell && cell.value;
        if (cell && cell.has && isFinite(v) && v > maxVal) maxVal = v;
      }
    }
    if (!isFinite(maxVal)) maxVal = 0;
    return Math.max(0, Math.ceil(maxVal));
  }

  function drawHeatmap(map) {
    var c = getEl(ids.canvas); if (!c) return;
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);

    var rows = Math.max(1, yDays);
    var layout = getLayoutConfig();
    var padL = layout.padL, padT = layout.padT, padR = layout.padR, padB = layout.padB;
    var gridW = c.width - padL - padR, gridH = c.height - padT - padB;

    var startHour = (hourMode === '10h') ? 7 : 0;
    var endHour = (hourMode === '10h') ? 19 : 23;
    var cols = endHour - startHour + 1;

    var cw = gridW / cols;
    var ch = gridH / rows;

    // X axis
    ctx.fillStyle = "#475569";
    ctx.font = layout.labelFont + "px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    var hourStep = Math.max(layout.xAxisStep, Math.ceil(34 / Math.max(cw, 1)));
    for (var h = startHour; h <= endHour; h += hourStep) {
      var hourLabel = layout.hourLabelCompact ? String(h).padStart(2, '0') : (String(h).padStart(2, '0') + ":00");
      ctx.fillText(hourLabel, padL + (h - startHour) * cw + cw / 2, padT - 10);
    }

    // Y axis labels
    var MIN_LABEL_PX = layout.mobile ? 24 : 18;
    var step = Math.max(1, Math.ceil(MIN_LABEL_PX / Math.max(1, ch)));
    var compact = layout.mobile || rows > 14 || ch < 14;

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#475569";
    ctx.font = layout.labelFont + "px Arial";

    for (var d = 0; d < rows; d++) {
      var isLast = (d === rows - 1);
      if ((d % step) !== 0 && !isLast) continue;

      var y = padT + d * ch + ch / 2;
      var date = new Date(startOfDay(startMs).getTime() + d * MS.day);
      var label = compact
        ? getShiftedUtcDate(date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: 'UTC' })
        : getShiftedUtcDate(date).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: 'UTC' });

      ctx.fillText(label, padL - 8, y);
    }

    // light grid line at label rows
    ctx.save();
    ctx.strokeStyle = "rgba(15,23,42,0.06)";
    ctx.lineWidth = 1;
    for (var d2 = 0; d2 < rows; d2++) {
      var isLast2 = (d2 === rows - 1);
      if ((d2 % step) !== 0 && !isLast2) continue;
      var yLine = padT + d2 * ch;
      ctx.beginPath();
      ctx.moveTo(padL, yLine);
      ctx.lineTo(padL + gridW, yLine);
      ctx.stroke();
    }
    ctx.restore();

    // Cells
    var PALETTE = getPaletteForSelectedKey();

    for (var hh = startHour; hh <= endHour; hh++) {
      for (var dd = 0; dd < rows; dd++) {
        var x0 = padL + (hh - startHour) * cw;
        var y0 = padT + dd * ch;
        var cell = map[hh + '_' + dd];
        var v = (cell && cell.value) || 0;

        var lc = levelColor(v, !!(cell && cell.has), domainMax, PALETTE);
        ctx.fillStyle = lc.css;
        ctx.fillRect(x0 + 1, y0 + 1, cw - 2, ch - 2);

        if (cell && cell.has && cw > (layout.mobile ? 42 : 30) && ch > (layout.mobile ? 26 : 22)) {
          ctx.fillStyle = (lc.level >= 0 && lc.lum < 0.5) ? "#fff" : "#0f172a";
          ctx.font = layout.valueFont + "px Arial";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(formatInt(v), x0 + cw / 2, y0 + ch / 2);
        }
      }
    }

    // Draw vertical color scale on the right
    if (layout.showColorScale) drawColorScale(ctx, c.width, c.height, PALETTE, layout);
  }

  /*************** SIZE & TOOLTIP ***************/
  function updateCanvasSize() {
    var canvas = getEl(ids.canvas);
    if (!canvas) return false;

    var card = getCardEl();
    var header = getEl(ids.header);
    var legend = getEl(ids.legend);
    var mobileNote = getEl(ids.mobileNote);
    var mobileDetail = getEl(ids.mobileDetail);

    syncResponsiveLayout();
    var layout = getLayoutConfig();

    var cs = getComputedStyle(card);
    var padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var headerH = header ? header.offsetHeight : 0;
    var legendH = (layout.mobile && legend) ? legend.offsetHeight : 0;
    var noteH = (layout.mobile && mobileNote) ? mobileNote.offsetHeight : 0;
    var detailH = (layout.mobile && mobileDetail) ? mobileDetail.offsetHeight : 0;

    var cardH = card ? card.clientHeight : 400;
    var availableH = Math.max(180, Math.floor(cardH - (padV + headerH + legendH + noteH + detailH + 20)));
    var rows = Math.max(1, yDays);
    var desiredH = rows * layout.minRowHeight + layout.padT + layout.padB;
    var targetH = isExpandedMobileView()
      ? Math.max(availableH, 220)
      : layout.mobile
      ? Math.max(layout.minHeight, desiredH)
      : Math.max(layout.minHeight, availableH);

    var cardW = card ? card.clientWidth : 800;
    var targetW = Math.max(320, cardW);

    var changed = false;
    if (canvas.width !== targetW) { canvas.width = targetW; changed = true; }
    if (canvas.height !== targetH) { canvas.height = targetH; changed = true; }
    canvas.style.setProperty('--eh-canvas-width', targetW + 'px');
    canvas.style.setProperty('--eh-canvas-height', targetH + 'px');

    var wrap = canvas.parentElement;
    if (wrap) {
      wrap.style.width = "100%";
      wrap.style.flex = "1 1 auto";
      wrap.style.height = availableH + "px";
      wrap.style.overflowX = layout.mobile ? "auto" : "hidden";
      wrap.style.overflowY = layout.mobile ? "auto" : "hidden";
    }
    return changed;
  }

  // Tooltip style: white background + red text, NO red border
  function injectTooltipStyleOnce() {
    if (document.getElementById('eh2-tooltip-style')) return;
    var st = document.createElement('style');
    st.id = 'eh2-tooltip-style';
    st.textContent = `
    #${ids.tooltip}{
      position:absolute;
      background:#ffffff !important;
      color:#000000 !important;      /* ✅ chữ đen */
      border:none !important;
      border-radius:10px;
      padding:10px 12px;
      box-shadow:0 10px 24px rgba(15,23,42,.18);
      font:12px/1.35 Arial, system-ui;
      z-index:9999;
      pointer-events:none;
      max-width:260px;
      white-space:nowrap;
    }
    #${ids.tooltip}.eh-tooltip--mobile{
      left:12px !important;
      right:12px !important;
      top:auto !important;
      bottom:12px !important;
      max-width:none;
      white-space:normal;
      transform:none;
    }
    #${ids.tooltip} b{ color:#000000 !important; } /* ✅ chữ đen cho <b> */
  `;
    document.head.appendChild(st);
  }

  function getHeatmapPointInfo(canvas, clientX, clientY) {
    if (!canvas || !lastHeatmapMap || !startMs || !endMs) return null;

    var rect = canvas.getBoundingClientRect();
    var mx = clientX - rect.left, my = clientY - rect.top;
    var layout = getLayoutConfig();
    var padL = layout.padL, padT = layout.padT, padR = layout.padR, padB = layout.padB;
    var gridW = canvas.width - padL - padR, gridH = canvas.height - padT - padB;
    var rows = Math.max(1, yDays);
    var startHour = (hourMode === '10h') ? 7 : 0;
    var endHour = (hourMode === '10h') ? 19 : 23;
    var cols = endHour - startHour + 1;
    var cw = gridW / cols, ch = gridH / rows;

    if (mx < padL || mx > padL + gridW || my < padT || my > padT + gridH) return null;

    var hh = startHour + Math.floor((mx - padL) / cw);
    var dd = Math.floor((my - padT) / ch);
    if (hh < startHour || hh > endHour || dd < 0 || dd >= rows) return null;

    var key = hh + '_' + dd;
    var cell = lastHeatmapMap[key];
    if (!cell) return null;

    var v = (cell && cell.value) || 0;
    var date = new Date(startOfDay(startMs).getTime() + dd * MS.day);
    var h0 = String(hh).padStart(2, '0') + ":00";
    var h1 = String((hh + 1) % 24).padStart(2, '0') + ":00";
    var ds = getShiftedUtcDate(date).toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
    var html = !cell.has
      ? `<b>${ds}</b><br>${h0} – ${h1}<br><b>No data</b>`
      : `<b>${ds}</b><br>${h0} – ${h1}<br>People: <b>${formatInt(v)}</b>`;

    return { key: key, html: html };
  }


  function safeSetupTooltip() {
    injectTooltipStyleOnce();

    var canvas = getEl(ids.canvas), tooltip = getEl(ids.tooltip);
    if (!canvas || !tooltip || canvas.__tooltipWired) return;
    canvas.__tooltipWired = true;

    function ensureTooltipParent() {
      var card = getCardEl();
      if (!card) return null;
      if (tooltip.parentElement !== card) {
        try { card.appendChild(tooltip); } catch (_) { }
      }
      return card;
    }

    var activeTapKey = null;

    function hide() {
      activeTapKey = null;
      tooltip.classList.remove('eh-tooltip--mobile');
      tooltip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
    function show(clientX, clientY, html) {
      var card = ensureTooltipParent();
      if (!card) return;
      tooltip.innerHTML = html;
      tooltip.classList.remove('eh-tooltip--mobile');
      tooltip.style.display = 'block';
      tooltip.style.right = 'auto';
      tooltip.style.bottom = 'auto';

      var cardBox = card.getBoundingClientRect();
      var tt = tooltip.getBoundingClientRect();
      var x = clientX - cardBox.left, y = clientY - cardBox.top;

      var left = clamp(x - tt.width / 2, 12, Math.max(12, card.clientWidth - tt.width - 12));
      var top = y - tt.height - 12;
      if (top < 12) top = Math.min(Math.max(12, card.clientHeight - tt.height - 12), y + 12);
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      canvas.style.cursor = 'pointer';
    }
    function showMobile(html, cellKey) {
      ensureTooltipParent();
      activeTapKey = cellKey;
      tooltip.innerHTML = html;
      tooltip.classList.add('eh-tooltip--mobile');
      tooltip.style.display = 'block';
    }

    canvas.addEventListener('mousemove', function (ev) {
      if (isMobileLayout()) return;
      var info = getHeatmapPointInfo(canvas, ev.clientX, ev.clientY);
      if (!info) return hide();
      show(ev.clientX, ev.clientY, info.html);
    });

    canvas.addEventListener('click', function (ev) {
      var info = getHeatmapPointInfo(canvas, ev.clientX, ev.clientY);
      if (!info) return hide();
      if (!isMobileLayout()) return show(ev.clientX, ev.clientY, info.html);
      if (tooltip.style.display === 'block' && activeTapKey === info.key) return hide();
      showMobile(info.html, info.key);
      ev.stopPropagation();
    });

    canvas.addEventListener('mouseleave', function () {
      if (!isMobileLayout()) hide();
    });

    var wrap = canvas.parentElement;
    if (wrap) wrap.addEventListener('scroll', hide, { passive: true });

    self._eh2_docClick = function (ev) {
      if (ev.target !== canvas) hide();
    };
    document.addEventListener('click', self._eh2_docClick, true);
  }

  /*************** LISTENING: signature & refresh ***************/
  function buildSignature() {
    var stateParams = readStateParams();
    var mode = getSelectedMode(stateParams);

    var singleId = getCurrentSingleEntityIdFromCtx() || '';
    var allIds = (mode === 'ALL') ? getAllDeviceIdsFromState(stateParams).join(',') : '';

    return [
      'mode=' + mode,
      'single=' + singleId,
      'all=' + allIds,
      'key=' + String(selectedKeyId || ''),
      'range=' + String(startMs || '') + '-' + String(endMs || ''),
      'hour=' + String(hourMode || ''),
      'utc=' + String(getSharedOffsetMinutes())
    ].join('|');
  }

  function forceRefresh(resetMap) {
    if (resetMap !== false) lastHeatmapMap = null;
    self.onDataUpdated();
  }

  function startPollingSelection() {
    if (__pollTimer) return;
    __pollTimer = setInterval(function () {
      try {
        var sig = buildSignature();
        if (__lastSig == null) __lastSig = sig;

        if (sig !== __lastSig) {
          __lastSig = sig;
          lastHeatmapMap = null;
          self.onDataUpdated();
        }
      } catch (_) { }
    }, 350);
  }

  function stopPollingSelection() {
    try { if (__pollTimer) clearInterval(__pollTimer); } catch (_) { }
    __pollTimer = null;
  }

  /*************** MAIN: onDataUpdated ***************/
  function onDataUpdatedInternal() {
    var myRender = ++__renderSeq;

    buildKeyDropdown();

    if (!startMs || !endMs) {
      setPresetRange('1w');
      setActiveRangeChip('1w');
    }

    updateCanvasSize();
    drawNoData('Loading...');
    domainMax = 0;
    renderLegend();

    if (__activeFetchController) {
      try { __activeFetchController.abort(); } catch (_) { }
    }
    __activeFetchController = null;

    Promise.resolve().then(function () {
      if (myRender !== __renderSeq) return;

      if (!selectedKeyId) {
        domainMax = 0;
        renderLegend();
        drawNoData('No data');
        return;
      }

      var stateParams = readStateParams();
      var mode = getSelectedMode(stateParams);

      // ===== ALL MODE =====
      if (mode === 'ALL') {
        var allDeviceIds = getAllDeviceIdsFromState(stateParams);
        if (!allDeviceIds || allDeviceIds.length === 0) {
          domainMax = 0; renderLegend();
          drawNoData('No data');
          return;
        }

        if (__activeFetchController) {
          try { __activeFetchController.abort(); } catch (_) { }
        }
        __activeFetchController = new AbortController();
        fetchAllDevicesAndBuildMap(allDeviceIds, selectedKeyId, startMs, endMs, __activeFetchController.signal)
          .then(function (mapAll) {
            if (myRender !== __renderSeq) return;
            if (!mapAll) return;

            lastHeatmapMap = mapAll;
            domainMax = computeDomainMax(mapAll);
            renderLegend();
            updateCanvasSize();
            renderHeatmapView(mapAll);
          })
          .finally(function () { __activeFetchController = null; });
        return;
      }

      // ===== SINGLE MODE =====
      if (!self.ctx.data || self.ctx.data.length < 1) {
        domainMax = 0; renderLegend();
        drawNoData('No data');
        return;
      }

      var items = (self.ctx.data || []).filter(function (it) { return keyIdOf(it) === selectedKeyId; });
      if (!items.length) {
        domainMax = 0; renderLegend();
        drawNoData('No data');
        return;
      }

      var rows = Math.max(1, yDays);
      var map = {};
      for (var h = 0; h < 24; h++) {
        for (var d = 0; d < rows; d++) {
          map[h + '_' + d] = { value: 0, has: false };
        }
      }

      function pushSeries(series) {
        for (var i = 0; i < series.length; i++) {
          var p = series[i]; if (!p || p.length < 2) continue;
          var ts = Number(p[0]), val = Number(p[1]);
          if (!isFinite(ts) || !isFinite(val)) continue;
          if (ts < startMs || ts > endMs) continue;

          var dIdx = dayIndexOf(ts);
          if (dIdx < 0 || dIdx >= rows) continue;

          var hr = getOffsetParts(ts).h;
          var k = hr + '_' + dIdx;

          map[k].value += val;
          map[k].has = true;
        }
      }

      items.forEach(function (item) {
        var series = Array.isArray(item && item.data) ? item.data : [];
        if (series.length) pushSeries(series);
      });

      if (myRender !== __renderSeq) return;

      lastHeatmapMap = map;
      domainMax = computeDomainMax(map);
      renderLegend();
      updateCanvasSize();
      renderHeatmapView(map);
    });
  }

  function scheduleRefresh(reason) {
    var mySeq = ++__refreshSeq;
    if (__refreshTimer) clearTimeout(__refreshTimer);
    __refreshTimer = setTimeout(function () {
      if (mySeq !== __refreshSeq) return;
      var sig = buildSignature();
      var now = Date.now();
      if (sig === __lastAppliedSig && (now - __lastAppliedAt) < SAME_SIG_SKIP_WINDOW_MS) return;
      __lastAppliedSig = sig;
      __lastAppliedAt = now;
      onDataUpdatedInternal();
    }, QUIET_TIME_MS);
  }

  self.onDataUpdated = function () { scheduleRefresh('onDataUpdated'); };

  /*************** INIT / RESIZE / DESTROY ***************/
  var resizeObs = null;

  self.onInit = function () {
    heatmapCanvas = getEl(ids.canvas);
    heatmapCtx = heatmapCanvas ? heatmapCanvas.getContext('2d') : null;

    syncResponsiveLayout();
    buildKeyDropdown();
    wireRangeButtons();
    wireHourModeButtons();
    wireExpandButton();

    hourMode = '10h';
    setActiveHourChip('10h');
    setExpandedState(false);

    // remove default active to avoid flicker when restoring cached range
    clearActiveRangeChips();
    if (!restoreRangeCache()) {
      setPresetRange('1w');
      setActiveRangeChip('1w');
    } else {
      syncDashboardTimewindow();
    }

    domainMax = 0;
    renderLegend();

    updateCanvasSize();
    drawNoData('Loading...');

    __lastSig = buildSignature();
    startPollingSelection();

    setTimeout(function () { self.onDataUpdated(); }, 0);

    try {
      resizeObs = new ResizeObserver(function () {
        syncResponsiveLayout();
        updateCanvasSize();
        if (lastHeatmapMap) renderHeatmapView(lastHeatmapMap);
      });
      var root = getEl(ids.root);
      var card = getCardEl();
      if (card) resizeObs.observe(card);
      if (root && root !== card) resizeObs.observe(root);
    } catch (_) { }

    safeSetupTooltip();

    self._eh2_rootClick = function (ev) {
      var root = getEl(ids.root);
      if (isExpanded && root && ev.target === root) setExpandedState(false);
    };
    var rootEl = getEl(ids.root);
    if (rootEl) rootEl.addEventListener('click', self._eh2_rootClick, true);

    self._eh2_escClose = function (ev) {
      if (ev.key === 'Escape' && isExpanded) setExpandedState(false);
    };
    window.addEventListener('keydown', self._eh2_escClose);
  };

  self.onResize = function () {
    syncResponsiveLayout();
    updateCanvasSize();
    if (lastHeatmapMap) renderHeatmapView(lastHeatmapMap);
  };

  self.onDestroy = function () {
    if (isExpanded) setExpandedState(false);
    try { document.body.style.overflow = ''; } catch (_) { }
    releaseOrientationLock();
    try { resizeObs && resizeObs.disconnect(); } catch (_) { }
    if (self._eh2_rootClick) {
      var rootEl = getEl(ids.root);
      if (rootEl) {
        try { rootEl.removeEventListener('click', self._eh2_rootClick, true); } catch (_) { }
      }
      self._eh2_rootClick = null;
    }
    if (self._eh2_escClose) {
      try { window.removeEventListener('keydown', self._eh2_escClose); } catch (_) { }
      self._eh2_escClose = null;
    }
    if (self._eh2_docClick) {
      try { document.removeEventListener('click', self._eh2_docClick, true); } catch (_) { }
      self._eh2_docClick = null;
    }
    stopPollingSelection();
    if (__refreshTimer) {
      clearTimeout(__refreshTimer);
      __refreshTimer = null;
    }
    if (__activeFetchController) {
      try { __activeFetchController.abort(); } catch (_) { }
      __activeFetchController = null;
    }
  };

})(); // end IIFE
