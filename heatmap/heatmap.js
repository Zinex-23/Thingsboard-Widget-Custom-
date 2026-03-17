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

  var PAD_HM = { L: 98, T: 34, R: 20, B: 22 };
  var LEVEL_COUNT = 5;

  var domainMax = 0;
  var BINS = [];

  // Guards (stale render / fetch)
  var __fetchSeq = 0;
  var __renderSeq = 0;
  var __refreshSeq = 0;
  var __refreshTimer = null;
  var __lastAppliedSig = null;
  var __lastAppliedAt = 0;
  var __activeFetchController = null;
  var QUIET_TIME_MS = 300;
  var SAME_SIG_SKIP_WINDOW_MS = 800;

  // For listening device switch (polling signature)
  var __pollTimer = null;
  var __lastSig = null;

  // Range persistence (temporary cache)
  var RANGE_CACHE_TTL_MS = 5 * 60 * 1000;

  // DOM ids (must match widget HTML template)
  var ids = {
    main: 'eh2-main', canvas: 'eh2-canvas',
    header: 'eh2-header', rangeGroup: 'eh2-range-group',
    hourGroup: 'eh2-hour-mode-group',
    legend: 'eh2-legend', tooltip: 'eh2-tooltip',
    keyWrap: 'eh2-key-wrap', keySelect: 'eh2-key-select',
    // modal
    overlay: 'eh2-range-overlay',
    prevL: 'eh2-prevL', nextL: 'eh2-nextL', titleL: 'eh2-titleL', gridL: 'eh2-gridL',
    prevR: 'eh2-prevR', nextR: 'eh2-nextR', titleR: 'eh2-titleR', gridR: 'eh2-gridR',
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
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function endOfDay(d) { var x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function getEl(id) { return document.getElementById(id); }
  function getCardEl() {
    try {
      if (self && self.ctx && self.ctx.$container && self.ctx.$container[0]) return self.ctx.$container[0];
    } catch (_) { }
    return document.body;
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
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayIndexOf(ts) {
    return Math.floor((startOfDay(ts).getTime() - startOfDay(startMs).getTime()) / MS.day);
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

    if (dataKeyList.length === 0) {
      wrap.style.display = 'none';
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
    var now = new Date();
    var end = endOfDay(now).getTime();
    var start = new Date(now);

    if (mode === '1d') {
      start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (mode === '1w') {
      start.setDate(now.getDate() - 6); start = startOfDay(start);
    } else if (mode === '1m') {
      start.setDate(now.getDate() - 29); start = startOfDay(start);
    } else {
      start.setDate(now.getDate() - 6); start = startOfDay(start);
    }

    startMs = start.getTime();
    endMs = end;
    buildDaysCount();
    currentMode = mode;
    saveRangeCache();
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

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function monthLabel(d) { return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); }
  function mondayOfCurrentWeek(now) {
    var dow = (now.getDay() + 6) % 7; var mon = new Date(now);
    mon.setDate(now.getDate() - dow);
    return startOfDay(mon);
  }

  function daysInMatrix(baseDate) {
    var y = baseDate.getFullYear(), m = baseDate.getMonth();
    var first = new Date(y, m, 1), dowMon0 = (first.getDay() + 6) % 7;
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
    return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function isBetween(d, a, b) {
    if (!a || !b) return false;
    var x = a.getTime(), y = b.getTime(); if (x > y) { var t = x; x = y; y = t; }
    var t0 = startOfDay(d).getTime();
    return t0 >= startOfDay(x).getTime() && t0 <= startOfDay(y).getTime();
  }

  function renderCalendars() {
    var left = modalState.base ? firstOfMonth(modalState.base) : firstOfMonth(new Date());
    var right = firstOfMonth(addMonths(left, 1));
    var tL = getEl(ids.titleL), tR = getEl(ids.titleR);
    if (tL) tL.textContent = monthLabel(left);
    if (tR) tR.textContent = monthLabel(right);
    fillGrid(getEl(ids.gridL), left);
    fillGrid(getEl(ids.gridR), right);
  }
  function fillGrid(container, monthDate) {
    if (!container) return;
    container.innerHTML = '';
    daysInMatrix(monthDate).forEach(function (c) {
      var realMonth = (c.m % 12 + 12) % 12;
      var realYear = c.m < 0 ? c.y - 1 : (c.m > 11 ? c.y + 1 : c.y);
      var d = new Date(realYear, realMonth, c.d);

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

    var now = new Date();
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

    safeOn(ids.prevL, function () { modalState.base = addMonths(modalState.base, -1); renderCalendars(); });
    safeOn(ids.nextL, function () { modalState.base = addMonths(modalState.base, 1); renderCalendars(); });
    safeOn(ids.prevR, function () { modalState.base = addMonths(modalState.base, -1); renderCalendars(); });
    safeOn(ids.nextR, function () { modalState.base = addMonths(modalState.base, 1); renderCalendars(); });

    safeOn(ids.quickWeek, function () {
      var s = mondayOfCurrentWeek(now), e = startOfDay(now);
      modalState.start = s; modalState.end = e; modalState.base = firstOfMonth(s); renderCalendars();
    });
    safeOn(ids.quickMonth, function () {
      var s = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), e = startOfDay(now);
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
      forceRefresh();
    });

    window.addEventListener('keydown', escToClose);
    overlay.style.display = 'block';
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

          var hr = new Date(ts).getHours();
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

  function drawNoData(msg) {
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
    var now = new Date(), nowHour = now.getHours();
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
    var padL = PAD_HM.L, padT = PAD_HM.T, padR = PAD_HM.R, padB = PAD_HM.B;
    var gridW = c.width - padL - padR, gridH = c.height - padT - padB;

    var startHour = (hourMode === '10h') ? 7 : 0;
    var endHour = (hourMode === '10h') ? 19 : 23;
    var cols = endHour - startHour + 1;

    var cw = gridW / cols;
    var ch = gridH / rows;

    // X axis
    ctx.fillStyle = "#475569";
    ctx.font = "12px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (var h = startHour; h <= endHour; h += 2) {
      ctx.fillText(String(h).padStart(2, '0') + ":00", padL + (h - startHour) * cw + cw / 2, padT - 10);
    }

    // Y axis labels
    var MIN_LABEL_PX = 18;
    var step = Math.max(1, Math.ceil(MIN_LABEL_PX / Math.max(1, ch)));
    var compact = rows > 14 || ch < 14;

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#475569";
    ctx.font = "12px Arial";

    for (var d = 0; d < rows; d++) {
      var isLast = (d === rows - 1);
      if ((d % step) !== 0 && !isLast) continue;

      var y = padT + d * ch + ch / 2;
      var date = new Date(startOfDay(startMs).getTime() + d * MS.day);
      var label = compact
        ? date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
        : date.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });

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

        if (cell && cell.has && cw > 30 && ch > 22) {
          ctx.fillStyle = (lc.level >= 0 && lc.lum < 0.5) ? "#fff" : "#0f172a";
          ctx.font = "11px Arial";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(formatInt(v), x0 + cw / 2, y0 + ch / 2);
        }
      }
    }
  }

  /*************** SIZE & TOOLTIP ***************/
  function updateCanvasSize() {
    var canvas = getEl(ids.canvas);
    if (!canvas) return false;

    var card = getCardEl();
    var header = getEl(ids.header);

    var cs = getComputedStyle(card);
    var padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var headerH = header ? header.offsetHeight : 0;

    var cardH = card ? card.clientHeight : 400;
    var availableH = cardH - (padV + headerH);
    var targetH = Math.max(280, Math.floor(availableH));

    var cardW = card ? card.clientWidth : 800;
    var totalCols = (hourMode === '10h') ? 13 : 24;
    var cellMinWidth = 58;
    var targetW = Math.max(cardW, totalCols * cellMinWidth + PAD_HM.L + PAD_HM.R);

    var changed = false;
    if (canvas.width !== targetW) { canvas.width = targetW; changed = true; }
    if (canvas.height !== targetH) { canvas.height = targetH; changed = true; }

    var wrap = canvas.parentElement;
    if (wrap) {
      wrap.style.width = "100%";
      wrap.style.flex = "1 1 auto";
      wrap.style.height = (targetH - 35) + "px";
      wrap.style.overflowX = "auto";
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
    #${ids.tooltip} b{ color:#000000 !important; } /* ✅ chữ đen cho <b> */
  `;
    document.head.appendChild(st);
  }


  function safeSetupTooltip() {
    injectTooltipStyleOnce();

    var canvas = getEl(ids.canvas), tooltip = getEl(ids.tooltip), card = getCardEl();
    if (!canvas || !tooltip || !card) return;

    if (!tooltip.parentElement) {
      try { card.appendChild(tooltip); } catch (_) { }
    }

    function hide() { tooltip.style.display = 'none'; canvas.style.cursor = 'default'; }
    function show(clientX, clientY, html) {
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';

      var cardBox = card.getBoundingClientRect();
      var tt = tooltip.getBoundingClientRect();
      var x = clientX - cardBox.left, y = clientY - cardBox.top;

      tooltip.style.left = Math.max(12, x - tt.width / 2) + 'px';
      tooltip.style.top = Math.max(12, y - tt.height - 12) + 'px';
    }

    canvas.addEventListener('mousemove', function (ev) {
      if (!lastHeatmapMap || !startMs || !endMs) return hide();

      var rect = canvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;

      var padL = PAD_HM.L, padT = PAD_HM.T, padR = PAD_HM.R, padB = PAD_HM.B;
      var gridW = canvas.width - padL - padR, gridH = canvas.height - padT - padB;

      var rows = Math.max(1, yDays);
      var startHour = (hourMode === '10h') ? 7 : 0;
      var endHour = (hourMode === '10h') ? 19 : 23;
      var cols = endHour - startHour + 1;

      var cw = gridW / cols, ch = gridH / rows;

      if (mx < padL || mx > padL + gridW || my < padT || my > padT + gridH) return hide();

      var hh = startHour + Math.floor((mx - padL) / cw);
      var dd = Math.floor((my - padT) / ch);

      var key = hh + '_' + dd;
      var cell = lastHeatmapMap[key];
      if (!cell) return hide();

      var v = (cell && cell.value) || 0;
      var date = new Date(startOfDay(startMs).getTime() + dd * MS.day);
      var h0 = String(hh).padStart(2, '0') + ":00";
      var h1 = String((hh + 1) % 24).padStart(2, '0') + ":00";

      var ds = date.toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' });

      if (!cell.has) {
        show(ev.clientX, ev.clientY, `<b>${ds}</b><br>${h0} – ${h1}<br><b>No data</b>`);
      } else {
        show(ev.clientX, ev.clientY, `<b>${ds}</b><br>${h0} – ${h1}<br>People: <b>${formatInt(v)}</b>`);
      }
    });

    canvas.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
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
      'hour=' + String(hourMode || '')
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
            drawHeatmap(mapAll);
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

          var hr = new Date(ts).getHours();
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
      drawHeatmap(map);
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

    buildKeyDropdown();
    wireRangeButtons();
    wireHourModeButtons();

    hourMode = '10h';
    setActiveHourChip('10h');

    // remove default active to avoid flicker when restoring cached range
    clearActiveRangeChips();
    if (!restoreRangeCache()) {
      setPresetRange('1w');
      setActiveRangeChip('1w');
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
        if (updateCanvasSize() && lastHeatmapMap) drawHeatmap(lastHeatmapMap);
      });
      var main = getEl(ids.main);
      if (main) resizeObs.observe(main);
    } catch (_) { }

    safeSetupTooltip();
  };

  self.onResize = function () {
    if (updateCanvasSize() && lastHeatmapMap) drawHeatmap(lastHeatmapMap);
  };

  self.onDestroy = function () {
    try { resizeObs && resizeObs.disconnect(); } catch (_) { }
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
