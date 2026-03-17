'use strict';

(function () {

  /* ===================== SETTINGS ===================== */
  var DEFAULTS = {
    decimals: 0,
    hideZero: true,
    deltaEnabled: true,
    deltaDecimals: 1,
    deltaUpColor: '#16a34a',
    deltaDownColor: '#dc2626',
    deltaZeroColor: '#94a3b8',
    showTodayDot: true,
    locale: 'en-US',
    weekdayNames: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    keyLabelMap: null,
    // Compare mode: prevDay | prevWeek | prevMonth | prevYear
    compareMode: 'prevDay',

    // Loading text
    loadingText: 'Loading...'
  };
  var S = DEFAULTS;

  /* ===================== Helpers ===================== */
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function endOfDay(d) { var x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

  function fmtNumber(n) { return new Intl.NumberFormat(S.locale, { maximumFractionDigits: S.decimals }).format(n || 0); }
  function fmtPercent(x) { return Math.abs(x).toFixed(S.deltaDecimals) + '%'; }

  /* ===================== State ===================== */
  var viewYear, viewMonth;
  var dayAggMap = new Map();
  var availableKeys = [];
  var selectedKey = null;

  // Guards
  var __fetchSeq = 0;
  var __renderSeq = 0;
  var __refreshSeq = 0;
  var __refreshTimer = null;
  var __lastAppliedSig = null;
  var __lastAppliedAt = 0;
  var __pendingRefetchAll = false;
  var __activeFetchController = null;
  var __loadingSeq = 0;
  var QUIET_TIME_MS = 300;
  var SAME_SIG_SKIP_WINDOW_MS = 800;

  // Polling listen switch device / all
  var __pollTimer = null;
  var __lastSig = null;
  var SINGLE_FETCH_USES_API = true;
  var __loadingTimer = null;

  /* ===================== TB Helpers (ALL/SINGLE + detect switch) ===================== */
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
    // đổi key này nếu dashboard bạn khác
    var m = stateParams.selectedDeviceMode || stateParams.mode;
    if (m === 'ALL') return 'ALL';
    if (stateParams.selectedDeviceId === '__ALL__') return 'ALL';
    var list = stateParams.entities || stateParams.entityIds || [];
    if (Array.isArray(list) && list.length > 1) return 'ALL';
    return 'SINGLE';
  }
  // lấy entity id của SINGLE từ datasources (để detect switch device)
  function getCurrentSingleEntityIdFromCtx() {
    try {
      var ds = self.ctx && (self.ctx.datasources || self.ctx.dataSources || self.ctx.dataSource);
      if (Array.isArray(ds) && ds.length) {
        var e = ds[0].entity || ds[0].entityId || ds[0].entityID;
        var id = extractDeviceId(e) || extractDeviceId(ds[0].entityId) || extractDeviceId(ds[0].entityID);
        if (id) return id;
      }
    } catch (_) { }
    return '';
  }
  function getSingleDeviceIdFromStateOrCtx(stateParams) {
    var direct = stateParams.selectedDeviceId || stateParams.id || extractDeviceId(stateParams.entityId);
    if (direct && direct !== '__ALL__') return String(direct);
    var ctxId = getCurrentSingleEntityIdFromCtx();
    if (ctxId) return String(ctxId);
    return '';
  }

  /* ===================== DOM Helpers (Loading Overlay) ===================== */
  function rootEl() {
    return (self.ctx && self.ctx.$container && self.ctx.$container[0]) ? self.ctx.$container[0] : document.body;
  }
  function ensureLoadingOverlay() {
    var root = rootEl();
    if (!root) return null;

    // inject css once
    if (!document.getElementById('tb-cal-loading-style')) {
      var st = document.createElement('style');
      st.id = 'tb-cal-loading-style';
      st.textContent = `
      .tb-cal__loading{
        position:absolute; inset:0;
        display:none;
        align-items:center; justify-content:center;
        background:rgba(255,255,255,0.72);
        backdrop-filter: blur(2px);
        z-index: 50;
        font: 14px/1.2 Arial;
        color:#334155;
      }
      .tb-cal__loading .tb-cal__spinner{
        width:18px;height:18px;border-radius:50%;
        border:2px solid rgba(51,65,85,0.25);
        border-top-color: rgba(51,65,85,0.85);
        margin-right:10px;
        animation: tbspin 0.8s linear infinite;
      }
      @keyframes tbspin{ to{ transform:rotate(360deg);} }
      .tb-cal__wrap-rel{ position:relative; }
    `;
      document.head.appendChild(st);
    }

    // make root relative wrapper
    if (!root.classList.contains('tb-cal__wrap-rel')) root.classList.add('tb-cal__wrap-rel');

    var el = root.querySelector('.tb-cal__loading');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tb-cal__loading';
      el.innerHTML = `<div class="tb-cal__spinner"></div><div class="tb-cal__loading-text">${S.loadingText || 'Loading...'}</div>`;
      root.appendChild(el);
    }
    // sync text
    var t = el.querySelector('.tb-cal__loading-text');
    if (t) t.textContent = S.loadingText || 'Loading...';
    return el;
  }
  function showLoading() {
    var el = ensureLoadingOverlay();
    if (el) el.style.display = 'flex';
    if (__loadingTimer) {
      try { clearTimeout(__loadingTimer); } catch (_) { }
    }
    __loadingTimer = setTimeout(function () {
      hideLoading();
    }, 6000);
  }
  function hideLoading() {
    var el = ensureLoadingOverlay();
    if (el) el.style.display = 'none';
    if (__loadingTimer) {
      try { clearTimeout(__loadingTimer); } catch (_) { }
      __loadingTimer = null;
    }
  }

  /* ===================== Title helpers ===================== */
  function setTitle(y, m) {
    var titleEl = rootEl().querySelector('.tb-cal__title');
    if (!titleEl) return;
    var monthStr = new Date(y, m, 1).toLocaleDateString(S.locale, { month: 'long' });
    titleEl.innerHTML =
      '<div class="tb-title-month">' + monthStr + '</div>' +
      '<div class="tb-title-year">' + y + '</div>';
  }

  /* ===================== DataKey helpers ===================== */
  function keyIdOf(it) {
    try {
      if (typeof it.dataKey === 'string') return it.dataKey;
      if (it.dataKey && (it.dataKey.name || it.dataKey.label)) return String(it.dataKey.name || it.dataKey.label);
    } catch (_) { }
    return '';
  }
  function keyLabelOf(it) {
    try {
      if (typeof it.dataKey === 'string') return it.dataKey;
      if (it.dataKey && (it.dataKey.label || it.dataKey.name)) return String(it.dataKey.label || it.dataKey.name);
    } catch (_) { }
    return 'Data Key';
  }
  function extractAvailableKeys() {
    var data = Array.isArray(self.ctx && self.ctx.data) ? self.ctx.data : [];
    var seen = {}; availableKeys = [];
    for (var i = 0; i < data.length; i++) {
      var ds = data[i]; if (!ds) continue;
      var idA = keyIdOf(ds);
      if (idA && !seen[idA]) { seen[idA] = true; availableKeys.push({ id: idA, label: keyLabelOf(ds) }); }
      if (Array.isArray(ds.dataKeys)) {
        ds.dataKeys.forEach(function (k) {
          var idB = (k && (k.name || k.label)) ? String(k.name || k.label) : ''; if (!idB || seen[idB]) return;
          seen[idB] = true; availableKeys.push({ id: idB, label: String(k.label || k.name) });
        });
      }
    }
    if (!selectedKey || !availableKeys.some(function (k) { return k.id === selectedKey; })) {
      selectedKey = availableKeys.length ? availableKeys[0].id : null;
    }
  }
  function labelForKey(id) {
    if (!id) return '';
    if (S.keyLabelMap && S.keyLabelMap[id]) return S.keyLabelMap[id];
    var f = availableKeys.find(function (k) { return k.id === id; });
    return f ? f.label : id;
  }

  /* ===================== Weekdays ===================== */
  function renderWeekdays() {
    var wrap = rootEl().querySelector('.tb-cal__weekdays');
    if (!wrap) return;
    var names = Array.isArray(S.weekdayNames) && S.weekdayNames.length === 7 ? S.weekdayNames : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    wrap.innerHTML = names.map(function (d) { return '<div>' + d + '</div>'; }).join('');
  }

  /* ===================== Dropdowns ===================== */
  function populateDropdown() {
    var root = rootEl();
    var sel = root.querySelector('#tb-key-select'); if (!sel) return;
    sel.innerHTML = '';
    for (var i = 0; i < availableKeys.length; i++) {
      var k = availableKeys[i]; var o = document.createElement('option');
      o.value = k.id; o.textContent = labelForKey(k.id);
      if (k.id === selectedKey || (selectedKey == null && i === 0)) o.selected = true;
      sel.appendChild(o);
    }
  }
  function wireDropdown() {
    var root = rootEl();
    var sel = root.querySelector('#tb-key-select'); if (!sel) return;
    if (sel.__wired) return;
    sel.__wired = true;

    sel.addEventListener('change', function () {
      selectedKey = this.value;
      requestRefresh(); // loading + re-render
    });
  }

  function populateCompareDropdown() {
    var root = rootEl();
    var sel = root.querySelector('#tb-compare-select');
    if (!sel) return;
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === S.compareMode) { sel.selectedIndex = i; found = true; break; }
    }
    if (!found) sel.value = 'prevDay';
  }
  function wireCompareDropdown() {
    var root = rootEl();
    var sel = root.querySelector('#tb-compare-select'); if (!sel) return;
    if (sel.__wired) return;
    sel.__wired = true;

    sel.addEventListener('change', function () {
      S.compareMode = this.value || 'prevDay';
      requestRefresh(false); // no fetch needed necessarily, but keep loading briefly
    });
  }

  /* ===================== Compare date utilities ===================== */
  function lastDayOfMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function sameDatePrevMonth(d) {
    var x = new Date(d);
    var target = x.getDate();
    x.setHours(0, 0, 0, 0);
    x.setDate(1);
    x.setMonth(x.getMonth() - 1);
    var ld = lastDayOfMonth(x.getFullYear(), x.getMonth());
    x.setDate(Math.min(target, ld));
    return x;
  }
  function sameDatePrevYear(d) {
    var x = new Date(d);
    var y = x.getFullYear() - 1;
    var m = x.getMonth();
    var target = x.getDate();
    var ld = lastDayOfMonth(y, m);
    return new Date(y, m, Math.min(target, ld));
  }
  function sameWeekdayPrevWeek(d) {
    var x = new Date(d);
    x.setDate(x.getDate() - 7);
    return x;
  }
  function prevDay(d) {
    var x = new Date(d);
    x.setDate(x.getDate() - 1);
    return x;
  }
  function getPrevAnchorDate(d, mode) {
    if (mode === 'prevDay') return prevDay(d);
    if (mode === 'prevMonth') return sameDatePrevMonth(d);
    if (mode === 'prevYear') return sameDatePrevYear(d);
    return sameWeekdayPrevWeek(d); // default prevWeek
  }

  /* ===================== Build per-day totals (SINGLE from subscription) ===================== */
  function buildDayAggFromSubscription() {
    var data = Array.isArray(self.ctx && self.ctx.data) ? self.ctx.data : [];
    var map = new Map();
    if (!selectedKey) { dayAggMap = map; return; }

    for (var i = 0; i < data.length; i++) {
      var ds = data[i]; if (!ds) continue;

      var idA = keyIdOf(ds);
      if (idA === selectedKey && Array.isArray(ds.data)) {
        for (var j = 0; j < ds.data.length; j++) {
          var p = ds.data[j]; if (!p || p.length < 2) continue;
          var d = startOfDay(p[0]).getTime(); var v = Number(p[1]) || 0;
          map.set(d, (map.get(d) || 0) + v);
        }
      }
      if (Array.isArray(ds.dataKeys)) {
        var keyObj = ds.dataKeys.find(function (k) {
          var kid = (k && (k.name || k.label)) ? String(k.name || k.label) : ''; return kid === selectedKey;
        });
        if (keyObj && Array.isArray(keyObj.data)) {
          for (var t = 0; t < keyObj.data.length; t++) {
            var q = keyObj.data[t]; if (!q || q.length < 2) continue;
            var d2 = startOfDay(q[0]).getTime(); var vv = Number(q[1]) || 0;
            map.set(d2, (map.get(d2) || 0) + vv);
          }
        }
      }
    }
    dayAggMap = map;
  }

  /* ===================== ALL Devices fetch & build per-day totals ===================== */
  function monthRangeMs(y, m) {
    var s = startOfDay(new Date(y, m, 1)).getTime();
    var e = endOfDay(new Date(y, m + 1, 0)).getTime();
    return { start: s, end: e };
  }
  async function fetchAllDevicesDayAgg(deviceIds, keyName, startTs, endTs, signal) {
    var seq = ++__fetchSeq;
    var token = safeGetToken();
    var urlKey = encodeURIComponent(String(keyName));
    var startNum = Number(startTs), endNum = Number(endTs);

    var map = new Map();

    await Promise.all((deviceIds || []).map(async function (deviceId) {
      var url =
        `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries` +
        `?keys=${urlKey}` +
        `&startTs=${startNum}` +
        `&endTs=${endNum}` +
        `&limit=100000&agg=NONE`;

      try {
        var res = await fetch(url, {
          method: 'GET',
          signal: signal,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'X-Authorization': 'Bearer ' + token } : {})
          }
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

          var dMs = startOfDay(ts).getTime();
          map.set(dMs, (map.get(dMs) || 0) + val);
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }));

    if (seq !== __fetchSeq) return null; // superseded
    if (signal && signal.aborted) return null;
    return map;
  }

  /* ===================== Month total helper ===================== */
  function sumMonth(y, m) {
    var sum = 0;
    for (var d = new Date(y, m, 1); d.getMonth() === m; d.setDate(d.getDate() + 1)) {
      var k = startOfDay(d).getTime();
      if (dayAggMap.has(k)) sum += Number(dayAggMap.get(k)) || 0;
    }
    return sum;
  }

  /* ===================== Grid render ===================== */
  function renderGrid() {
    var root = rootEl();
    var grid = root.querySelector('#tb-cal-grid');
    var header = root.querySelector('.tb-cal__header');
    var toolbar = root.querySelector('.tb-cal__toolbar');
    var compareRow = root.querySelector('.tb-cal__compare-row');
    if (!grid || !header || !toolbar || !compareRow) return;

    /* Layout (ensure toolbar in header right col) */
    header.style.display = 'grid';
    header.style.gridTemplateColumns = '1fr minmax(280px, 520px) 1fr';
    header.style.alignItems = 'center';
    header.style.columnGap = '15px';
    if (toolbar.parentNode !== header) header.appendChild(toolbar);

    /* Title */
    setTitle(viewYear, viewMonth);

    /* Keep compare dropdown state synced */
    populateCompareDropdown();

    /* Monthly summary (vs previous month) */
    var curSum = sumMonth(viewYear, viewMonth);
    var prevBase = new Date(viewYear, viewMonth, 1);
    prevBase.setMonth(prevBase.getMonth() - 1);
    var prevSum = sumMonth(prevBase.getFullYear(), prevBase.getMonth());

    var compareEl = root.querySelector('.tb-cal__compare');
    if (!compareEl) {
      compareEl = document.createElement('div');
      compareEl.className = 'tb-cal__compare';
    }
    var diff = curSum - prevSum;
    var absCur = fmtNumber(curSum);
    var absDiff = fmtNumber(Math.abs(diff));
    var pct = (prevSum ? (diff / prevSum) * 100 : null);

    var sentence = '';
    if (prevSum === 0 && curSum === 0) sentence = 'No data for this month.';
    else if (pct === null) sentence = "This month's total: " + absCur + "  Compared to last month: " + (diff === 0 ? 'no change' : (diff > 0 ? '↑ +' : '↓ -') + absDiff) + ".";
    else if (diff === 0) sentence = "This month's total: " + absCur + "  No change vs last month.";
    else {
      var pctStr = (diff > 0 ? '+' : '') + Math.abs(pct).toFixed(S.deltaDecimals) + '%';
      var verb = diff > 0 ? 'Increased' : 'Decreased';
      sentence = "This month's total: " + absCur + "  " + verb + " " + (diff > 0 ? '+' : '-') + absDiff + " (" + pctStr + ") vs last month.";
    }
    compareEl.textContent = sentence;
    compareEl.style.color = diff > 0 ? S.deltaUpColor : (diff < 0 ? S.deltaDownColor : S.deltaZeroColor);
    compareRow.innerHTML = ''; compareRow.appendChild(compareEl);

    /* Render calendar grid */
    grid.innerHTML = '';

    var first = new Date(viewYear, viewMonth, 1);
    var startWeekIdx = (first.getDay() + 6) % 7;       // Monday-first
    var start = new Date(viewYear, viewMonth, 1 - startWeekIdx);
    var today = startOfDay(new Date()).getTime();

    // Month max abs for heatmap fallback (when no delta compare)
    var monthStart = new Date(viewYear, viewMonth, 1);
    var monthEnd = new Date(viewYear, viewMonth + 1, 0);
    var monthMaxAbs = 0;
    for (var dd = new Date(monthStart); dd <= monthEnd; dd.setDate(dd.getDate() + 1)) {
      var k = startOfDay(dd).getTime();
      if (dayAggMap.has(k)) {
        var vAbs = Math.abs(Number(dayAggMap.get(k)) || 0);
        if (vAbs > monthMaxAbs) monthMaxAbs = vAbs;
      }
    }

    for (var i = 0; i < 42; i++) {
      var d = new Date(start); d.setDate(start.getDate() + i);
      var dMs = startOfDay(d).getTime();
      var inMonth = (d.getMonth() === viewMonth);
      var isToday = (dMs === today);

      // Anchor date theo compare mode
      var prevDate = getPrevAnchorDate(d, S.compareMode);
      var prevMs = startOfDay(prevDate).getTime();

      var hasVal = dayAggMap.has(dMs);
      var hasPrev = dayAggMap.has(prevMs);
      var val = hasVal ? (dayAggMap.get(dMs) || 0) : 0;
      var prevVal = hasPrev ? (dayAggMap.get(prevMs) || 0) : 0;

      if (!inMonth) { hasVal = false; val = 0; hasPrev = false; prevVal = 0; }

      var showDelta = false, pctDay = 0, deltaAttr = '';
      if (inMonth && S.deltaEnabled && hasVal && hasPrev && prevVal) {
        pctDay = ((val - prevVal) / prevVal) * 100; showDelta = true;
        deltaAttr = pctDay > 0 ? 'up' : (pctDay < 0 ? 'down' : '');
      }

      var cell = document.createElement('div');
      cell.className = 'tb-cell' + (inMonth ? '' : ' other') + (isToday ? ' today' : '');
      if (deltaAttr) cell.setAttribute('data-delta', deltaAttr);

      var html = '<span class="num">' + d.getDate() + '</span>';
      if (inMonth && hasVal && !(S.hideZero && val === 0)) {
        html += '<div class="val">' + fmtNumber(val) + '</div>';
      }
      cell.innerHTML = html;

      if (inMonth && showDelta) {
        var chip = document.createElement('div'); chip.className = 'tb-delta';
        chip.style.color = (pctDay > 0) ? S.deltaUpColor : (pctDay < 0) ? S.deltaDownColor : S.deltaZeroColor;
        chip.innerHTML = (pctDay > 0 ? '▲' : (pctDay < 0 ? '▼' : '•')) + ' ' + fmtPercent(pctDay);
        cell.appendChild(chip);
      }

      if (S.showTodayDot && isToday) {
        var dot = document.createElement('div'); dot.className = 'today-dot'; cell.appendChild(dot);
      }

      if (inMonth) {
        if (showDelta) {
          // Heatmap effect for delta
          if (pctDay !== 0) {
            var absPct = Math.min(Math.abs(pctDay), 100);
            var alpha = 0.04 + (absPct / 100) * 0.12; // Light subtle blur effect
            var color = pctDay > 0 ? '22,163,74' : '239,68,68'; // Green / Red
            cell.style.backgroundColor = 'rgba(' + color + ', ' + alpha + ')';
          }

          var dateStr = d.toLocaleDateString(S.locale, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
          var valStr = fmtNumber(val);
          var prevStr = fmtNumber(prevVal);
          var deltaStr = (pctDay > 0 ? '+' : '') + fmtPercent(pctDay);

          var anchorLabel =
            S.compareMode === 'prevDay' ? 'Prev day' :
              S.compareMode === 'prevWeek' ? 'Prev week' :
                S.compareMode === 'prevMonth' ? 'Prev month' : 'Prev year';

          var tooltip = document.createElement('div');
          tooltip.className = 'tb-tooltip';
          tooltip.innerHTML = '<div class="tb-tip-date">' + dateStr + '</div>' +
            '<div class="tb-tip-line">Current: <b>' + valStr + '</b></div>' +
            '<div class="tb-tip-line">' + anchorLabel + ': <b>' + prevStr + '</b></div>' +
            '<div class="tb-tip-line">Change: <span style="color:' + (pctDay > 0 ? S.deltaUpColor : (pctDay < 0 ? S.deltaDownColor : S.deltaZeroColor)) + '">' + deltaStr + '</span></div>';
          cell.appendChild(tooltip);

        } else if (hasVal) {
          // Heatmap effect for single value
          if (val !== 0) {
            var signColor = val > 0 ? '22,163,74' : '239,68,68';
            var norm = monthMaxAbs > 0 ? Math.min(Math.abs(val) / monthMaxAbs, 1) : 0;
            var alpha2 = 0.04 + norm * 0.12;
            cell.style.backgroundColor = 'rgba(' + signColor + ', ' + alpha2 + ')';
          }
          var dateStr2 = d.toLocaleDateString(S.locale, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
          var valStr2 = fmtNumber(val);
          var tooltip2 = document.createElement('div');
          tooltip2.className = 'tb-tooltip';
          tooltip2.innerHTML = '<div class="tb-tip-date">' + dateStr2 + '</div>' +
            '<div class="tb-tip-line">Current: <b>' + valStr2 + '</b></div>';
          cell.appendChild(tooltip2);
        }
      }

      grid.appendChild(cell);
    }
  }

  /* ===================== Navigation (prev/next month) ===================== */
  function wireNav() {
    var root = rootEl();
    root.querySelectorAll('.tb-cal__btn').forEach(function (btn) {
      if (btn.__wired) return;
      btn.__wired = true;

      btn.addEventListener('click', function () {
        var step = +btn.getAttribute('data-nav');
        var base = new Date(viewYear, viewMonth, 1);
        base.setMonth(base.getMonth() + step);
        viewYear = base.getFullYear(); viewMonth = base.getMonth();

        requestRefresh(true); // month changed -> ALL mode must refetch
      });
    });
  }

  /* ===================== Signature listening (switch device / ALL) ===================== */
  function buildSignature() {
    var stateParams = readStateParams();
    var mode = getSelectedMode(stateParams);

    var singleId = getSingleDeviceIdFromStateOrCtx(stateParams) || '';
    var allIds = (mode === 'ALL') ? getAllDeviceIdsFromState(stateParams).join(',') : '';

    return [
      'mode=' + mode,
      'single=' + singleId,
      'all=' + allIds,
      'key=' + String(selectedKey || ''),
      'cmp=' + String(S.compareMode || ''),
      'month=' + String(viewYear) + '-' + String(viewMonth)
    ].join('|');
  }

  function startPollingSelection() {
    if (__pollTimer) return;
    __pollTimer = setInterval(function () {
      try {
        var sig = buildSignature();
        if (__lastSig == null) __lastSig = sig;

        if (sig !== __lastSig) {
          __lastSig = sig;
          requestRefresh(true);
        }
      } catch (_) { }
    }, 350);
  }
  function stopPollingSelection() {
    try { if (__pollTimer) clearInterval(__pollTimer); } catch (_) { }
    __pollTimer = null;
  }

  /* ===================== Unified refresh pipeline (Loading -> Build -> Render) ===================== */
  function requestRefresh(needRefetchAll) {
    // needRefetchAll: month change or device switch in ALL => true
    // for SINGLE, we just rebuild from subscription.
    showLoading();
    var token = ++__loadingSeq;
    scheduleRefresh(!!needRefetchAll, token);
  }

  function scheduleRefresh(needRefetchAll, token) {
    __pendingRefetchAll = __pendingRefetchAll || !!needRefetchAll;
    var mySeq = ++__refreshSeq;
    if (__refreshTimer) clearTimeout(__refreshTimer);
    __refreshTimer = setTimeout(function () {
      if (mySeq !== __refreshSeq) return;
      var sig = buildSignature();
      var now = Date.now();
      if (sig === __lastAppliedSig && (now - __lastAppliedAt) < SAME_SIG_SKIP_WINDOW_MS) {
        if (token === __loadingSeq) hideLoading();
        return;
      }
      __lastAppliedSig = sig;
      __lastAppliedAt = now;
      var need = __pendingRefetchAll;
      __pendingRefetchAll = false;
      refreshNow(need, token);
    }, QUIET_TIME_MS);
  }

  async function refreshNow(needRefetchAll, token) {
    var myRender = ++__renderSeq;

    // sync available keys from current ctx.data (SINGLE)
    extractAvailableKeys();
    populateDropdown();
    populateCompareDropdown();

    // if no key -> empty render
    if (!selectedKey) {
      dayAggMap = new Map();
      renderWeekdays();
      renderGrid();
      if (token === __loadingSeq) hideLoading();
      return;
    }

    var stateParams = readStateParams();
    var mode = getSelectedMode(stateParams);

    try {
      // ALL mode: fetch per month range
      if (mode === 'ALL') {
        var allDeviceIds = getAllDeviceIdsFromState(stateParams);
        if (!allDeviceIds || allDeviceIds.length === 0) {
          dayAggMap = new Map();
          renderWeekdays();
          renderGrid();
          return;
        }

        if (__activeFetchController) {
          try { __activeFetchController.abort(); } catch (_) { }
        }
        __activeFetchController = new AbortController();
        var range = monthRangeMs(viewYear, viewMonth);
        var mapAll = await fetchAllDevicesDayAgg(
          allDeviceIds,
          selectedKey,
          range.start,
          range.end,
          __activeFetchController.signal
        );

        if (myRender !== __renderSeq) { if (token === __loadingSeq) hideLoading(); return; } // superseded
        if (!mapAll) { if (token === __loadingSeq) hideLoading(); return; } // superseded by fetchSeq

        dayAggMap = mapAll;
        renderWeekdays();
        renderGrid();
        __activeFetchController = null;
        return;
      }

      // SINGLE mode: prefer API to avoid stale subscription
      if (SINGLE_FETCH_USES_API) {
        var singleId = getSingleDeviceIdFromStateOrCtx(stateParams);
        if (singleId) {
          if (__activeFetchController) {
            try { __activeFetchController.abort(); } catch (_) { }
          }
          __activeFetchController = new AbortController();
          var rangeS = monthRangeMs(viewYear, viewMonth);
          var mapSingle = await fetchAllDevicesDayAgg(
            [singleId],
            selectedKey,
            rangeS.start,
            rangeS.end,
            __activeFetchController.signal
          );
          if (myRender !== __renderSeq) { if (token === __loadingSeq) hideLoading(); return; }
          if (mapSingle) {
            dayAggMap = mapSingle;
            renderWeekdays();
            renderGrid();
            __activeFetchController = null;
            return;
          }
        }
      }

      // SINGLE mode: build from subscription
      buildDayAggFromSubscription();
      if (myRender !== __renderSeq) return;
      renderWeekdays();
      renderGrid();
    } finally {
      if (token === __loadingSeq && myRender === __renderSeq) hideLoading();
    }
  }

  /* ===================== Lifecycle ===================== */
  self.onInit = function () {
    S = Object.assign({}, DEFAULTS, (self.ctx && self.ctx.settings) || {});
    ensureLoadingOverlay();

    var now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();

    extractAvailableKeys();
    populateDropdown();
    wireDropdown();

    populateCompareDropdown();
    wireCompareDropdown();

    renderWeekdays();
    wireNav();

    // initial render with loading
    __lastSig = buildSignature();
    startPollingSelection();
    requestRefresh(true);

    setTitle(viewYear, viewMonth);

    if (self.ctx && self.ctx.stateController && self.ctx.stateController.stateChanged) {
      self.stateSubscription = self.ctx.stateController.stateChanged().subscribe(function () {
        try {
          if (self.ctx && self.ctx.updateAliases) self.ctx.updateAliases();
          if (self.ctx && self.ctx.aliasController && self.ctx.aliasController.updateAliases) {
            self.ctx.aliasController.updateAliases();
          }
        } catch (_) { }
        requestRefresh(true);
      });
    }
  };

  self.onDataUpdated = function () {
    // TB pushes new data (especially when switching SINGLE device)
    requestRefresh(false);
  };

  self.onSettingsChanged = function () {
    S = Object.assign({}, DEFAULTS, (self.ctx && self.ctx.settings) || {});
    ensureLoadingOverlay();
    requestRefresh(true);
  };

  self.onDestroy = function () {
    stopPollingSelection();
    if (self.stateSubscription) {
      try { self.stateSubscription.unsubscribe(); } catch (_) { }
      self.stateSubscription = null;
    }
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
