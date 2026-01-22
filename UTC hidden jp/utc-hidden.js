self.onInit = function () {
  var DEFAULTS = {
    days: 999999,
    hours: 0,
    minutes: 1,
    seconds: 0,
    intervalMs: 60000,
    aggregationType: 'NONE',
    aggregationLimit: 50000
  };
  var SHARED_OFFSET_KEY = 'timewindow_widget_utc_offset_min';

  function getSettings() {
    var s = (self.ctx && self.ctx.settings) ? self.ctx.settings : {};
    return {
      days: typeof s.days === 'number' ? s.days : DEFAULTS.days,
      hours: typeof s.hours === 'number' ? s.hours : DEFAULTS.hours,
      minutes: typeof s.minutes === 'number' ? s.minutes : DEFAULTS.minutes,
      seconds: typeof s.seconds === 'number' ? s.seconds : DEFAULTS.seconds,
      intervalMs: typeof s.intervalMs === 'number' ? s.intervalMs : DEFAULTS.intervalMs,
      aggregationType: s.aggregationType || DEFAULTS.aggregationType,
      aggregationLimit: typeof s.aggregationLimit === 'number' ? s.aggregationLimit : DEFAULTS.aggregationLimit,
      showUtcLabel: typeof s.showUtcLabel === 'boolean' ? s.showUtcLabel : true
    };
  }

  function getSharedOffsetMinutes() {
    try {
      var raw = localStorage.getItem(SHARED_OFFSET_KEY);
      if (raw === null) return 0;
      var val = parseInt(raw, 10);
      return isNaN(val) ? 0 : val;
    } catch (e) {
      return 0;
    }
  }

  function formatOffset(minutes) {
    var sign = minutes >= 0 ? '+' : '-';
    var abs = Math.abs(minutes);
    var h = Math.floor(abs / 60);
    var m = abs % 60;
    var hh = h < 10 ? '0' + h : String(h);
    var mm = m < 10 ? '0' + m : String(m);
    return 'UTC' + sign + hh + ':' + mm;
  }

  function getCurrentTW() {
    var d = self.ctx && self.ctx.dashboard ? self.ctx.dashboard : {};
    var tw = d.dashboardTimewindow;
    if (!tw && d.getDashboardTimewindow) tw = d.getDashboardTimewindow();
    if (!tw) return null;
    var s = tw && tw.history && tw.history.fixedTimewindow && tw.history.fixedTimewindow.startTimeMs;
    var e = tw && tw.history && tw.history.fixedTimewindow && tw.history.fixedTimewindow.endTimeMs;
    var i = (tw && tw.history && tw.history.interval) ||
      (tw && tw.aggregation && tw.aggregation.interval) ||
      tw.interval;
    return { s: s, e: e, i: i, type: tw && tw.history && tw.history.historyType, tw: tw };
  }

  function applyTimewindow() {
    var s = getSettings();
    var utcOffsetMinutes = getSharedOffsetMinutes();
    var totalMs =
      (s.days * 24 * 60 * 60 * 1000) +
      (s.hours * 60 * 60 * 1000) +
      (s.minutes * 60 * 1000) +
      (s.seconds * 1000);

    var endMs = Date.now();
    var startMs = endMs - totalMs;

    var tw = {
      hideInterval: false, hideQuickInterval: false, hideAggregation: false, hideAggInterval: false, hideTimezone: false,
      selectedTab: 1,
      realtime: { realtimeType: 0, interval: 1000, timewindowMs: 60000 },
      history: {
        historyType: 0,
        interval: s.intervalMs,
        timewindowMs: totalMs,
        fixedTimewindow: { startTimeMs: startMs, endTimeMs: endMs }
      },
      aggregation: { type: s.aggregationType, limit: s.aggregationLimit, interval: s.intervalMs },
      utcOffsetMinutes: utcOffsetMinutes
    };

    try {
      var d = (self.ctx && self.ctx.dashboard) ? self.ctx.dashboard : {};
      if (d.setDashboardTimewindow) d.setDashboardTimewindow(tw);
      d.dashboardTimewindow = tw;
      if (self && self.ctx && self.ctx.dashboardCtrl && self.ctx.dashboardCtrl.onUpdateTimewindow) {
        self.ctx.dashboardCtrl.onUpdateTimewindow(tw);
      }
      if (d.dashboardTimewindowChangedSubject && d.dashboardTimewindowChangedSubject.next) {
        d.dashboardTimewindowChangedSubject.next(tw);
      }
    } catch (e) {
      console.error('UTC hidden timewindow update error:', e);
    }

    var label = document.getElementById('utc-hidden-label');
    if (label) {
      if (s.showUtcLabel) {
        label.textContent = formatOffset(utcOffsetMinutes);
        label.style.display = 'inline-block';
      } else {
        label.textContent = '';
        label.style.display = 'none';
      }
    }
  }

  applyTimewindow();
};
