/* global Chart, ChartDataLabels */
(function () {
  'use strict';

  var GENDER_KEY_HINTS = ['gender', 'genders', 'male_ages', 'female_ages'];

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
    try { var p = sc.getStateParams(); if (p && typeof p === 'object') return p; } catch (_) {}
    try { var p2 = sc.getStateParams('default'); if (p2 && typeof p2 === 'object') return p2; } catch (_) {}
    return {};
  }
  function getSelectedMode(stateParams) {
    var m = stateParams.selectedDeviceMode || stateParams.mode;
    return m === 'ALL' ? 'ALL' : 'SINGLE';
  }
  function getCurrentSingleEntityIdFromCtx() {
    try {
      var ds = self.ctx && (self.ctx.datasources || self.ctx.dataSources || self.ctx.dataSource);
      if (Array.isArray(ds) && ds.length) {
        var e = ds[0].entity || ds[0].entityId || ds[0].entityID;
        var id = extractDeviceId(e) || extractDeviceId(ds[0].entityId) || extractDeviceId(ds[0].entityID);
        if (id) return id;
      }
    } catch (_) {}
    try {
      var sub = self.ctx && self.ctx.defaultSubscription;
      var d0 = sub && sub.datasources && sub.datasources[0];
      var id2 = d0 && extractDeviceId(d0.entityId || d0.entity || d0);
      if (id2) return id2;
    } catch (_) {}
    return '';
  }
  function getSingleDeviceIdFromStateOrCtx(stateParams) {
    var direct = stateParams.selectedDeviceId || stateParams.id || extractDeviceId(stateParams.entityId);
    if (direct && direct !== '__ALL__') return String(direct);
    var ctxId = getCurrentSingleEntityIdFromCtx();
    if (ctxId) return String(ctxId);
    return '';
  }
  function getAllDeviceIdsFromState(stateParams) {
    var candidates = [];
    if (stateParams.entities) candidates = candidates.concat(stateParams.entities);
    if (stateParams.entityIds) candidates = candidates.concat(stateParams.entityIds);
    if (stateParams.devices) candidates = candidates.concat(stateParams.devices);
    if (stateParams.deviceIds) candidates = candidates.concat(stateParams.deviceIds);
    if (stateParams.selectedDevices) candidates = candidates.concat(stateParams.selectedDevices);
    if (stateParams.selectedDeviceIds) candidates = candidates.concat(stateParams.selectedDeviceIds);

    var ids = [];
    if (Array.isArray(candidates)) candidates.forEach(function (e) { var id = extractDeviceId(e); if (id) ids.push(id); });
    else { var one = extractDeviceId(candidates); if (one) ids.push(one); }
    return dedupe(ids);
  }
  function isFiniteNumber(x) { return typeof x === 'number' && isFinite(x); }
  function getEffectiveTimewindow(ctx) {
    try {
      var sub = ctx && ctx.defaultSubscription;
      var stw = (sub && sub.subscriptionTimewindow) || null;
      var useDash = !!(sub && sub.useDashboardTimewindow);
      if (stw && !useDash) return stw;
    } catch (_) {}
    try {
      return (
        (ctx && ctx.dashboardTimewindow) ||
        (ctx && ctx.dashboard && ctx.dashboard.dashboardTimewindow) ||
        (ctx && ctx.dashboardCtrl && ctx.dashboardCtrl.dashboardTimewindow) ||
        (ctx && ctx.$scope && ctx.$scope.dashboardTimewindow) ||
        (ctx && ctx.$scope && ctx.$scope.dashboardCtrl && ctx.$scope.dashboardCtrl.dashboardTimewindow) ||
        null
      );
    } catch (_) {}
    try {
      var sub2 = ctx && ctx.defaultSubscription;
      return (sub2 && sub2.subscriptionTimewindow) || null;
    } catch (_) {}
    return null;
  }
  function getTWRange(ctx) {
    try {
      var stw = getEffectiveTimewindow(ctx);
      if (!stw) return null;
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
      if (isFiniteNumber(windowMs)) {
        var now = Date.now();
        return { start: now - windowMs, end: now };
      }
    } catch (_) {}
    return null;
  }

  function safeParseArray(x) {
    if (Array.isArray(x)) return x;
    if (typeof x === 'string') { try { var a = JSON.parse(x); return Array.isArray(a) ? a : null; } catch (_) {} }
    return null;
  }
  function normalizeGenderStr(s) {
    if (s == null) return '';
    var t = String(s).replace(/"/g, '').trim().toLowerCase();
    if (t === 'male' || t === 'm' || t === 'nam' || t === '1' || t === 'true') return 'male';
    if (t === 'female' || t === 'f' || t === 'nu' || t === 'nữ' || t === '0' || t === 'false') return 'female';
    if (t.indexOf('m') === 0) return 'male';
    if (t.indexOf('f') === 0) return 'female';
    return '';
  }

  function extractGendersAny(payload) {
    if (payload && typeof payload === 'object' && 'v' in payload) payload = payload.v;
    if (payload && typeof payload === 'object' && 'value' in payload && Object.keys(payload).length === 1) payload = payload.value;

    if (typeof payload === 'string') {
      try { return extractGendersAny(JSON.parse(payload)); } catch (_) {
        var g0 = normalizeGenderStr(payload);
        return g0 ? [g0] : [];
      }
    }
    if (Array.isArray(payload)) return payload.map(normalizeGenderStr).filter(Boolean);

    if (payload && typeof payload === 'object') {
      // gender/genders direct
      var g = payload.gender != null ? payload.gender
        : payload.genders != null ? payload.genders
        : (payload.values && (payload.values.gender != null ? payload.values.gender : payload.values.genders));
      if (g != null) {
        var arr = safeParseArray(g) || (Array.isArray(g) ? g : [g]);
        return arr.map(normalizeGenderStr).filter(Boolean);
      }

      // fallback male_ages/female_ages -> đếm số phần tử
      var ma = payload.male_ages || (payload.values && payload.values.male_ages);
      var fa = payload.female_ages || (payload.values && payload.values.female_ages);
      var mArr = safeParseArray(ma) || (Array.isArray(ma) ? ma : []);
      var fArr = safeParseArray(fa) || (Array.isArray(fa) ? fa : []);
      var out = [];
      for (var i = 0; i < mArr.length; i++) out.push('male');
      for (var j = 0; j < fArr.length; j++) out.push('female');
      return out;
    }
    return [];
  }

  function keyNameOf(ds) {
    try {
      if (!ds) return '';
      if (typeof ds.dataKey === 'string') return ds.dataKey;
      if (ds.dataKey && (ds.dataKey.name || ds.dataKey.label)) return String(ds.dataKey.name || ds.dataKey.label);
    } catch (_) {}
    return '';
  }
  function keyMatchesGender(name) {
    var n = String(name || '').toLowerCase();
    if (!n) return false;
    for (var i = 0; i < GENDER_KEY_HINTS.length; i++) {
      if (n.indexOf(GENDER_KEY_HINTS[i]) !== -1) return true;
    }
    return false;
  }
  function getGenderKeysFromCtx(ctxTB) {
    var keys = [];
    try {
      var sub = ctxTB && ctxTB.defaultSubscription;
      var dk = (sub && sub.dataKeys) || [];
      for (var i = 0; i < dk.length; i++) {
        var nm = dk[i] && (dk[i].name || dk[i].label);
        if (nm) keys.push(String(nm));
      }
      var data = (sub && sub.data) || [];
      for (var j = 0; j < data.length; j++) {
        var nm2 = data[j] && data[j].dataKey && (data[j].dataKey.name || data[j].dataKey.label);
        if (nm2) keys.push(String(nm2));
      }
    } catch (_) {}
    try {
      var dss = ctxTB && (ctxTB.datasources || ctxTB.dataSources);
      if (Array.isArray(dss)) {
        for (var k = 0; k < dss.length; k++) {
          var dks = dss[k] && dss[k].dataKeys;
          if (Array.isArray(dks)) {
            for (var q = 0; q < dks.length; q++) {
              var nm3 = dks[q] && (dks[q].name || dks[q].label);
              if (nm3) keys.push(String(nm3));
            }
          }
        }
      }
    } catch (_) {}
    keys = dedupe(keys).filter(function (k) { return keyMatchesGender(k); });
    return keys.length ? keys : GENDER_KEY_HINTS.slice();
  }

  function collectGenderCountsFromCtx(ctxTB) {
    var rng = getTWRange(ctxTB) || { start: -Infinity, end: Infinity };
    var male = 0, female = 0;

    function feed(ts, v) {
      if (!(ts >= rng.start && ts <= rng.end)) return;
      var gs = extractGendersAny(v);
      for (var k = 0; k < gs.length; k++) { if (gs[k] === 'male') male++; else if (gs[k] === 'female') female++; }
    }

    // ctx.data
    try {
      var data = Array.isArray(ctxTB && ctxTB.data) ? ctxTB.data : [];
      for (var i = 0; i < data.length; i++) {
        var ds = data[i] || {};
        var kn = keyNameOf(ds);
        if (kn && !keyMatchesGender(kn)) continue;

        var series = Array.isArray(ds.data) ? ds.data : [];
        for (var j = 0; j < series.length; j++) {
          var p = series[j];
          if (p && p.length >= 2) feed(Number(p[0]), p[1]);
        }
      }
    } catch (_) {}

    // defaultSubscription
    try {
      var sub = ctxTB && ctxTB.defaultSubscription;
      var blocks = (sub && sub.data) || [];
      for (var b = 0; b < blocks.length; b++) {
        var blk = blocks[b] || {};
        var kn2 = blk.dataKey && (blk.dataKey.name || blk.dataKey.label);
        if (kn2 && !keyMatchesGender(kn2)) continue;

        var arrs = [blk.data || [], blk.latestData || []];
        for (var a = 0; a < arrs.length; a++) {
          var arr = arrs[a];
          for (var t = 0; t < arr.length; t++) {
            var p2 = arr[t];
            if (p2 && p2.length >= 2) feed(Number(p2[0]), p2[1]);
          }
        }
      }
    } catch (_) {}

    // ctx.datasources
    try {
      var dss = ctxTB && ctxTB.datasources;
      if (Array.isArray(dss)) {
        for (var dsi = 0; dsi < dss.length; dsi++) {
          var d = dss[dsi];
          var dd = d && d.data;
          if (!dd) continue;

          if (Array.isArray(dd) && dd.length && typeof dd[0] === 'object' && !Array.isArray(dd[0])) {
            for (var bi = 0; bi < dd.length; bi++) {
              var blk2 = dd[bi] || {};
              var kn3 = blk2.dataKey && (blk2.dataKey.name || blk2.dataKey.label);
              if (kn3 && !keyMatchesGender(kn3)) continue;

              var series2 = blk2.data || [];
              var ld2 = blk2.latestData || [];
              for (var q = 0; q < series2.length; q++) {
                var p4 = series2[q];
                if (p4 && p4.length >= 2) feed(Number(p4[0]), p4[1]);
              }
              for (var w = 0; w < ld2.length; w++) {
                var p5 = ld2[w];
                if (p5 && p5.length >= 2) feed(Number(p5[0]), p5[1]);
              }
            }
          } else if (Array.isArray(dd) && dd.length && Array.isArray(dd[0]) && dd[0].length >= 2) {
            for (var u = 0; u < dd.length; u++) {
              var p3 = dd[u];
              if (p3 && p3.length >= 2) feed(Number(p3[0]), p3[1]);
            }
          }
        }
      }
    } catch (_) {}

    return { male: male, female: female };
  }

  async function fetchGenderCountsFromDevices(deviceIds, rng, signal) {
    var token = safeGetToken();
    var keys = getGenderKeysFromCtx(self.ctx);
    if (!rng || !isFiniteNumber(rng.start) || !isFiniteNumber(rng.end)) return null;
    var startTs = Number(rng.start);
    var endTs = Number(rng.end);
    var male = 0, female = 0;

    function addGenders(gs) {
      for (var i = 0; i < gs.length; i++) {
        if (gs[i] === 'male') male++;
        else if (gs[i] === 'female') female++;
      }
    }

    await Promise.all((deviceIds || []).map(async function (deviceId) {
      var url =
        `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries` +
        `?keys=${encodeURIComponent(keys.join(','))}` +
        `&startTs=${startTs}` +
        `&endTs=${endTs}` +
        `&limit=50000&agg=NONE`;
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
        for (var ki = 0; ki < keys.length; ki++) {
          var k = keys[ki];
          var arr = (data && data[k]) ? data[k] :
            (data && data[String(k).toLowerCase()]) ? data[String(k).toLowerCase()] :
              (data && data[String(k).toUpperCase()]) ? data[String(k).toUpperCase()] : [];
          if (!arr || !arr.length) continue;
          for (var i = 0; i < arr.length; i++) {
            var p = arr[i];
            var ts = Number(p && p.ts);
            var v = (p && p.value != null) ? p.value : (p && p.v);
            if (!isFinite(ts)) continue;
            if (!(ts >= startTs && ts <= endTs)) continue;
            addGenders(extractGendersAny(v));
          }
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }));

    return { male: male, female: female };
  }

  function ensureOverlay(root, cls, text) {
    var wrap = root.querySelector('#wrap');
    if (!wrap) return null;
    var el = root.querySelector('.' + cls);
    if (el) return el;

    if (!wrap.style.position) wrap.style.position = 'relative';
    el = document.createElement('div');
    el.className = cls;
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.display = 'none';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.background = 'rgba(255,255,255,0.75)';
    el.style.zIndex = '5';
    el.innerHTML = '<div style="font:600 13px system-ui;color:#0f172a;">' + text + '</div>';
    wrap.appendChild(el);
    return el;
  }
  function setOverlay(el, on) { if (el) el.style.display = on ? 'flex' : 'none'; }

  self.onInit = function () {
    var $root = self.ctx.$container[0];
    var wrap = $root.querySelector('#wrap');
    var canvas = $root.querySelector('#gender-pie');
    if (!wrap || !canvas) {
      self.ctx.$container.html('<div id="wrap" style="height:100%"><canvas id="gender-pie"></canvas></div>');
    }

    var _wrap = self.ctx.$container[0].querySelector('#wrap');
    var _canvas = self.ctx.$container[0].querySelector('#gender-pie');
    var ctx = _canvas.getContext('2d');

    var S = Object.assign({
      labels: ['男性', '女性'],
      colors: ['#59B5FF', '#FF96D0'],
      paddingPx: 2,
      ringGapPx: 2,
      explodePx: 1,
      legendPosition: 'bottom',
      datalabelFontSize: 16
    }, (self.ctx.settings || {}));

    self.ctx.$container.css({ height: '100%', padding: 0, margin: 0 });
    _wrap.style.height = '90%';

    function sizeCanvas() {
      var w = _wrap.clientWidth || 300;
      var h = _wrap.clientHeight || 200;
      var dpr = (window.devicePixelRatio || 1);
      _canvas.style.width = w + 'px';
      _canvas.style.height = h + 'px';
      _canvas.width = Math.floor(w * dpr);
      _canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    sizeCanvas();

    var loadingEl = ensureOverlay(self.ctx.$container[0], 'tb-loading', '読み込み中…');
    var nodataEl = ensureOverlay(self.ctx.$container[0], 'tb-nodata', 'データなし');

    if (typeof ChartDataLabels !== 'undefined') Chart.plugins.register(ChartDataLabels);

    var ExplodePiePlugin = {
      id: 'explodePie',
      afterUpdate: function (chart) {
        var cfg = chart.options && chart.options.plugins && chart.options.plugins.explodePie;
        if (!cfg || !cfg.enabled) return;
        var off = Number(cfg.offset || 0);
        if (!off) return;

        var meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data || !chart.chartArea) return;

        var baseX = (chart.chartArea.left + chart.chartArea.right) / 2;
        var baseY = (chart.chartArea.top + chart.chartArea.bottom) / 2;

        meta.data.forEach(function (arc) {
          var m = arc && arc._model;
          if (!m) return;
          var mid = (m.startAngle + m.endAngle) / 2;
          m.x = baseX + Math.cos(mid) * off;
          m.y = baseY + Math.sin(mid) * off;
          if (arc._view) { arc._view.x = m.x; arc._view.y = m.y; }
        });
      }
    };
    Chart.plugins.register(ExplodePiePlugin);

    var cardBg = '#fff';
    try { var cs = window.getComputedStyle(_wrap); if (cs && cs.backgroundColor) cardBg = cs.backgroundColor; } catch (_) {}

    self.chart = new Chart(ctx, {
      type: 'pie',
      data: { labels: S.labels, datasets: [{ data: [0, 0], backgroundColor: S.colors, borderWidth: S.ringGapPx, borderColor: cardBg }] },
      options: {
        responsive: false, maintainAspectRatio: false, cutoutPercentage: 0,
        layout: { padding: { top: S.paddingPx, right: S.paddingPx, bottom: S.paddingPx, left: S.paddingPx } },
        legend: { position: S.legendPosition, labels: { padding: 8, usePointStyle: true } },
        plugins: {
          explodePie: { enabled: true, offset: S.explodePx },
          datalabels: {
            display: true,
            color: '#fff',
            font: { weight: 'bold', size: S.datalabelFontSize },
            formatter: function (value, ctx2) {
              var ds = ctx2.dataset || { data: [] };
              var total = (ds.data || []).reduce(function (a, b) { return a + (+b || 0); }, 0);
              if (!total) return '';
              return ((+value || 0) / total * 100).toFixed(1) + '%';
            }
          }
        },
        animation: { animateRotate: true, animateScale: true, duration: 650, easing: 'easeOutQuart' }
      }
    });

    var __updateSeq = 0;
    var __activeAbort = null;
    async function updateChart() {
      if (!self.chart) return;

      setOverlay(nodataEl, false);
      setOverlay(loadingEl, true);

      var mySeq = ++__updateSeq;
      try {
        if (__activeAbort) { try { __activeAbort.abort(); } catch (_) {} }
        __activeAbort = new AbortController();
        var signal = __activeAbort.signal;

        var st = readStateParams();
        var mode = getSelectedMode(st);
        var rng = getTWRange(self.ctx);

        var c = null;
        if (mode === 'ALL') {
          var ids = getAllDeviceIdsFromState(st);
          if (ids && ids.length) c = await fetchGenderCountsFromDevices(ids, rng, signal);
        } else {
          var singleId = getSingleDeviceIdFromStateOrCtx(st);
          if (singleId) c = await fetchGenderCountsFromDevices([singleId], rng, signal);
        }
        if (mySeq !== __updateSeq || (signal && signal.aborted)) return;
        if (!c) c = collectGenderCountsFromCtx(self.ctx);
        var total = c.male + c.female;

        self.chart.data.datasets[0].data = [c.male, c.female];
        self.chart.update();

        setOverlay(nodataEl, total === 0);
      } finally {
        setOverlay(loadingEl, false);
      }
    }

    self.onDataUpdated = function () { updateChart(); };
    self.onResize = function () { if (!self.chart) return; sizeCanvas(); self.chart.resize(); };

    if (self.ctx && self.ctx.stateController && self.ctx.stateController.stateChanged) {
      self.stateSubscription = self.ctx.stateController.stateChanged().subscribe(function () {
        updateChart();
      });
    }

    updateChart();
  };

  self.onDestroy = function () {
    if (self.stateSubscription) {
      try { self.stateSubscription.unsubscribe(); } catch (_) {}
      self.stateSubscription = null;
    }
    if (self.chart) { self.chart.destroy(); self.chart = null; }
  };
})();
