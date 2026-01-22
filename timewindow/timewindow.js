(function ensureCalendarManager() {
    var topWin = window.top || window;
    if (topWin.__TB_TW_CALENDAR__) return;

    topWin.__TB_TW_CALENDAR__ = {
        overlay: null,
        _listeners: [],
        ensureStyles: function (scale) {
            if (typeof scale === 'undefined') scale = 1;
            var topDoc = topWin.document;
            var style = topDoc.getElementById('tb-calendar-global-styles');
            var css =
                '.tb-calendar-overlay{position:fixed;inset:0;background:transparent;z-index:2147483647;--scale:' + scale + ';}' +
                '.tb-calendar{position:fixed;background:#fff;border-radius:calc(8px * var(--scale));' +
                'box-shadow:0 calc(8px * var(--scale)) calc(24px * var(--scale)) rgba(0,0,0,.15);' +
                'padding:calc(16px * var(--scale));min-width:calc(280px * var(--scale));' +
                'z-index:2147483648;box-sizing:border-box;}' +
                '.tb-calendar-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:calc(16px * var(--scale));gap:calc(8px*var(--scale));}' +
                '.tb-nav-btn{width:calc(32px*var(--scale));height:calc(32px*var(--scale));border:none;background:transparent;border-radius:50%;' +
                'cursor:pointer;font-size:calc(16px*var(--scale));color:#666;transition:background .2s;flex-shrink:0;}' +
                '.tb-nav-btn:hover{background:rgba(0,0,0,.05);}' +
                '.tb-calendar-title{font-size:calc(14px*var(--scale));font-weight:600;color:#333;text-align:center;flex:1;min-width:0;}' +
                '.tb-weekdays{display:grid;grid-template-columns:repeat(7,1fr);gap:calc(4px*var(--scale));margin-bottom:calc(8px*var(--scale));}' +
                '.tb-weekday{text-align:center;font-size:calc(12px*var(--scale));font-weight:600;color:#999;padding:calc(8px*var(--scale)) 0;}' +
                '.tb-days{display:grid;grid-template-columns:repeat(7,1fr);gap:calc(4px*var(--scale));}' +
                '.tb-day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer;' +
                'font-size:calc(13px*var(--scale));transition:all .2s;}' +
                '.tb-day:not(.tb-empty):hover{background:rgba(48,86,128,.1);}' +
                '.tb-day.tb-today{background:#ED1C24;color:#fff;font-weight:600;}' +
                '.tb-day.tb-selected{outline:calc(2px*var(--scale)) solid #ED1C24;}' +
                '.tb-months,.tb-years{display:grid;grid-template-columns:repeat(3,1fr);gap:calc(8px*var(--scale));}' +
                '.tb-month,.tb-year{padding:calc(16px*var(--scale)) calc(8px*var(--scale));text-align:center;border-radius:calc(8px*var(--scale));' +
                'cursor:pointer;font-size:calc(13px*var(--scale));font-weight:500;transition:all .2s;}' +
                '.tb-month:hover,.tb-year:hover{background:rgba(48,86,128,.1);}' +
                '.tb-month.tb-today,.tb-year.tb-today{background:#ED1C24;color:#fff;}' +
                '.tb-month.tb-selected,.tb-year.tb-selected{outline:calc(2px*var(--scale)) solid #ED1C24;}';
            if (!style) {
                style = topDoc.createElement('style');
                style.id = 'tb-calendar-global-styles';
                style.textContent = css;
                topDoc.head.appendChild(style);
            } else {
                style.textContent = css;
            }
        },
        open: function (html, scale) {
            this.close();
            this.ensureStyles(scale);
            var topDoc = (window.top || window).document;
            var div = topDoc.createElement('div');
            div.className = 'tb-calendar-overlay';
            div.innerHTML = html;
            topDoc.body.appendChild(div);
            this.overlay = div;

            var selfMgr = this;
            var onEsc = function (e) { if (e.key === 'Escape') selfMgr.close(); };
            var onOutside = function (e) { if (e.target === div) selfMgr.close(); };
            var onPageChange = function () { selfMgr.close(); };
            var onVisibility = function () { if (document.hidden) selfMgr.close(); };

            window.addEventListener('hashchange', onPageChange, true);
            window.addEventListener('popstate', onPageChange, true);
            window.addEventListener('beforeunload', onPageChange, true);
            document.addEventListener('visibilitychange', onVisibility, true);
            (window.top || window).addEventListener('resize', onPageChange);
            (window.top || window).addEventListener('keydown', onEsc, true);
            div.addEventListener('click', onOutside);

            this._listeners = [
                [window, 'hashchange', onPageChange, true],
                [window, 'popstate', onPageChange, true],
                [window, 'beforeunload', onPageChange, true],
                [document, 'visibilitychange', onVisibility, true],
                [window.top || window, 'resize', onPageChange, false],
                [window.top || window, 'keydown', onEsc, true]
            ];
            return div;
        },
        close: function () {
            if (!this.overlay) return;
            try {
                if (this._listeners && this._listeners.forEach) {
                    this._listeners.forEach(function (arr) {
                        try { arr[0].removeEventListener(arr[1], arr[2], arr[3]); } catch (e) { }
                    });
                }
            } catch (e) { }
            try { this.overlay.remove(); } catch (e) { }
            this.overlay = null;
            this._listeners = [];
        }
    };
})();

self.onInit = function () {
    var yearBtn = document.getElementById('tw-year-btn');
    var monthBtn = document.getElementById('tw-month-btn');
    var dayBtn = document.getElementById('tw-day-btn');
    var yearValue = document.getElementById('tw-year-value');
    var monthValue = document.getElementById('tw-month-value');
    var dayValue = document.getElementById('tw-day-value');
    var switcher = document.querySelector('.tw-switcher');

    var HOUR_MS = 60 * 60 * 1000;
    var DAY_MS = 24 * 60 * 60 * 1000;
    var MONTH_MS = 30 * DAY_MS;

    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var monthNamesFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    var EPS_MS = 1000; // 1s
    var STORAGE_KEY = 'timewindow_widget_state';

    // state
    var nowInit = new Date();
    var currentYear = nowInit.getFullYear();
    var currentMonth = nowInit.getMonth();
    var currentDay = nowInit.getDate();
    var lastSelectedMode = 'month';

    // ===== Persistence =====
    function saveState(mode, y, m, d) {
        try {
            var state = { mode: mode, year: y, month: m, day: d };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { }
    }

    function restoreState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var state = JSON.parse(raw);
                if (state.mode) lastSelectedMode = state.mode;

                var y = state.year;
                var m = state.month;
                var d = state.day;

                // Validation
                var now = new Date();
                var isValid = true;

                if (typeof y !== 'number' || y < 1900 || y > 2100) isValid = false;
                if (typeof m !== 'number' || m < 0 || m > 11) isValid = false;
                if (typeof d !== 'number' || d < 1 || d > 31) isValid = false;

                if (isValid) {
                    // Check days in month
                    var daysInMonth = new Date(y, m + 1, 0).getDate();
                    if (d > daysInMonth) d = daysInMonth;

                    currentYear = y;
                    currentMonth = m;
                    currentDay = d;
                } else {
                    // Fallback to now if invalid
                    currentYear = now.getFullYear();
                    currentMonth = now.getMonth();
                    currentDay = now.getDate();
                }
            }
        } catch (e) { }
    }

    restoreState();


    var _initialRetries = [];
    var _userInteracted = false;
    var _appliedInitialTW = false;
    var _isApplyingTW = false;

    var widgetContainer =
        (self.ctx && self.ctx.$container && self.ctx.$container[0]) ||
        (self.ctx && self.ctx.$scope && self.ctx.$scope.$element && self.ctx.$scope.$element[0]) ||
        document.body;

    function widgetScale() {
        if (!widgetContainer || !switcher) return 1;
        var w = widgetContainer.offsetWidth || 200;
        var h = widgetContainer.offsetHeight || 60;
        return Math.max(0.5, Math.min(2, Math.min(w / 200, h / 60)));
    }
    if (switcher && switcher.style) switcher.style.setProperty('--widget-scale', widgetScale());

    function setActiveVisual(mode) {
        [yearBtn, monthBtn, dayBtn].forEach(function (btn) {
            if (btn && btn.classList) btn.classList.remove('active');
        });
        if (mode === 'year' && yearBtn && yearBtn.classList) yearBtn.classList.add('active');
        if (mode === 'month' && monthBtn && monthBtn.classList) monthBtn.classList.add('active');
        if (mode === 'day' && dayBtn && dayBtn.classList) dayBtn.classList.add('active');
    }

    // helpers
    function isToday(y, m, d) { var t = new Date(); return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d; }
    function isThisMonth(y, m) { var t = new Date(); return t.getFullYear() === y && t.getMonth() === m; }
    function isThisYear(y) { return (new Date()).getFullYear() === y; }

    function softEqualTW(a, b) {
        if (!a || !b) return false;
        if (a.s !== b.s) return false;
        if (a.i !== b.i) return false;
        return Math.abs((a.e || 0) - (b.e || 0)) <= EPS_MS;
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
        return { s: s, e: e, i: i };
    }

    function applyTimewindow(startMs, endMs, intervalMs) {
        // tránh re-entrant
        if (_isApplyingTW) return;
        var cur = getCurrentTW();
        var target = { s: startMs, e: endMs, i: intervalMs };
        if (softEqualTW(cur, target)) return;

        _isApplyingTW = true;

        var tw = {
            hideInterval: false, hideQuickInterval: false, hideAggregation: false, hideAggInterval: false, hideTimezone: false,
            selectedTab: 1,
            realtime: { realtimeType: 0, interval: 1000, timewindowMs: 60000 },
            history: {
                historyType: 1, interval: intervalMs, timewindowMs: endMs - startMs,
                fixedTimewindow: { startTimeMs: startMs, endTimeMs: endMs }
            },
            aggregation: { type: 'SUM', limit: 25000, interval: intervalMs }

        };
        try {
            var d = (self.ctx && self.ctx.dashboard) ? self.ctx.dashboard : {};
            // 1) set
            if (d.setDashboardTimewindow) d.setDashboardTimewindow(tw);
            // 2) gán lại vào dashboard để các thành phần dựa vào object này thấy thay đổi
            d.dashboardTimewindow = tw;
            // 3) thông báo controller
            if (self && self.ctx && self.ctx.dashboardCtrl && self.ctx.dashboardCtrl.onUpdateTimewindow) {
                self.ctx.dashboardCtrl.onUpdateTimewindow(tw);
            }
            // 4) phát Subject (nếu có)
            if (d.dashboardTimewindowChangedSubject && d.dashboardTimewindowChangedSubject.next) {
                d.dashboardTimewindowChangedSubject.next(tw);
            }
        } catch (e) {
            console.error('Timewindow update error:', e);
        } finally {
            setTimeout(function () { _isApplyingTW = false; }, 50);
        }
    }


    function cancelInitialRetries() {
        _initialRetries.forEach(function (id) { clearTimeout(id); });
        _initialRetries = [];
    }

    function desiredTWFromStateWithFrozenNow(frozenNowMs) {
        if (lastSelectedMode === 'day') {
            var s1 = new Date(currentYear, currentMonth, currentDay, 0, 0, 0).getTime();
            var e1 = isToday(currentYear, currentMonth, currentDay)
                ? frozenNowMs
                : new Date(currentYear, currentMonth, currentDay, 23, 59, 59, 999).getTime();
            return { s: s1, e: e1, i: HOUR_MS };
        } else if (lastSelectedMode === 'month') {
            var s2 = new Date(currentYear, currentMonth, 1, 0, 0, 0).getTime();
            var e2 = isThisMonth(currentYear, currentMonth)
                ? frozenNowMs
                : new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999).getTime();
            return { s: s2, e: e2, i: DAY_MS };
        } else {
            var s3 = new Date(currentYear, 0, 1, 0, 0, 0).getTime();
            var e3 = isThisYear(currentYear)
                ? frozenNowMs
                : new Date(currentYear, 11, 31, 23, 59, 59, 999).getTime();
            return { s: s3, e: e3, i: MONTH_MS };
        }
    }

    //   function applyInitialTWWithRetries() {
    //     cancelInitialRetries();
    //     lastSelectedMode = 'month'; // default: tháng hiện tại
    //     var frozenNow = Date.now();
    //     var target = desiredTWFromStateWithFrozenNow(frozenNow);

    //     var tryApply = function () {
    //       if (_userInteracted || _appliedInitialTW) { cancelInitialRetries(); return; }
    //       var cur = getCurrentTW();
    //       if (softEqualTW(cur, target)) { _appliedInitialTW = true; cancelInitialRetries(); return; }
    //       applyTimewindow(target.s, target.e, target.i);
    //       var after = getCurrentTW();
    //       if (softEqualTW(after, target)) { _appliedInitialTW = true; cancelInitialRetries(); }
    //     };

    //     var delays = [0, 200, 800, 2000];
    //     _initialRetries = delays.map(function(d){ return setTimeout(tryApply, d); });
    //   }
    function applyInitialTWWithRetries() {
        cancelInitialRetries();
        // lastSelectedMode is already set by restoreState()

        var frozenNow = Date.now();
        var target = desiredTWFromStateWithFrozenNow(frozenNow);

        var tryApply = function () {
            if (_userInteracted || _appliedInitialTW) { cancelInitialRetries(); return; }
            var cur = getCurrentTW();
            if (softEqualTW(cur, target)) { _appliedInitialTW = true; cancelInitialRetries(); return; }
            applyTimewindow(target.s, target.e, target.i);
            // đánh dấu đã apply 1 lần để không lặp
            _appliedInitialTW = true;
            cancelInitialRetries();
        };

        // chỉ 1 nhát sau 200ms
        _initialRetries = [setTimeout(tryApply, 500)];
    }


    // ===== Calendar UI =====
    var pickerElement = null, activeButton = null, pickerMode = null;

    function showPicker(button, mode) {
        if (pickerElement && activeButton === button) { closePicker(); return; }
        closePicker();
        activeButton = button; pickerMode = mode;
        setActiveVisual(mode);

        var scale = widgetScale();
        var html =
            '<div class="tb-calendar">' +
            '<div class="tb-calendar-header">' +
            '<button class="tb-nav-btn" id="tb-prev">❮</button>' +
            '<div class="tb-calendar-title" id="tb-title"></div>' +
            '<button class="tb-nav-btn" id="tb-next">❯</button>' +
            '</div>' +
            '<div class="tb-calendar-body" id="tb-body"></div>' +
            '</div>';
        var mgr = (window.top || window).__TB_TW_CALENDAR__;
        pickerElement = mgr.open(html, scale);

        var topDoc = (window.top || window).document;
        var prevBtn = topDoc.getElementById('tb-prev');
        var nextBtn = topDoc.getElementById('tb-next');
        if (prevBtn) prevBtn.onclick = function () { navigate(-1); };
        if (nextBtn) nextBtn.onclick = function () { navigate(1); };

        renderCalendar();
        updatePickerPosition();
        window.addEventListener('scroll', updatePickerPosition, true);
        window.addEventListener('resize', updatePickerPosition);
    }
    function updatePickerPosition() {
        if (!pickerElement || !activeButton) return;
        var cal = pickerElement.querySelector('.tb-calendar'); if (!cal) return;
        var a = activeButton.getBoundingClientRect();
        var fe = window.frameElement;
        var f = fe ? fe.getBoundingClientRect() : { left: 0, top: 0 };
        var gap = 8 * widgetScale();
        var left = f.left + a.left;
        var top = f.top + a.bottom + gap;
        var vw = (window.top || window).innerWidth;
        var vh = (window.top || window).innerHeight;
        var calW = cal.offsetWidth, calH = cal.offsetHeight;
        if (left + calW + gap > vw) left = Math.max(gap, vw - calW - gap);
        if (top + calH + gap > vh) top = Math.max(gap, f.top + a.top - calH - gap);
        cal.style.left = Math.max(gap, left) + 'px';
        cal.style.top = Math.max(gap, top) + 'px';
    }
    function closePicker() {
        var mgr = (window.top || window).__TB_TW_CALENDAR__;
        if (mgr && mgr.close) mgr.close();
        pickerElement = null; activeButton = null;
        window.removeEventListener('scroll', updatePickerPosition, true);
        window.removeEventListener('resize', updatePickerPosition);
    }
    function renderCalendar() {
        if (!pickerElement) return;
        var topDoc = (window.top || window).document;
        var title = topDoc.getElementById('tb-title');
        var body = topDoc.getElementById('tb-body');
        if (!title || !body) return;
        if (pickerMode === 'day') renderDayCalendar(title, body);
        else if (pickerMode === 'month') renderMonthCalendar(title, body);
        else renderYearCalendar(title, body);
    }
    function navigate(direction) {
        if (pickerMode === 'day') {
            currentMonth += direction;
            if (currentMonth < 0) { currentMonth = 11; currentYear--; }
            else if (currentMonth > 11) { currentMonth = 0; currentYear++; }
        } else if (pickerMode === 'month') currentYear += direction;
        else if (pickerMode === 'year') currentYear += direction * 12;
        renderCalendar();
    }
    function renderDayCalendar(title, body) {
        title.textContent = monthNamesFull[currentMonth] + ' ' + currentYear;
        var weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        var firstDay = new Date(currentYear, currentMonth, 1).getDay();
        var daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
        var today = new Date();
        var html = '<div class="tb-weekdays">';
        weekdays.forEach(function (d) { html += '<div class="tb-weekday">' + d + '</div>'; });
        html += '</div><div class="tb-days">';
        for (var i = 0; i < firstDay; i++) html += '<div class="tb-day tb-empty"></div>';
        for (var d = 1; d <= daysInMonth; d++) {
            var date = new Date(currentYear, currentMonth, d);
            var cls = ['tb-day'];
            if (date.toDateString() === today.toDateString()) cls.push('tb-today');
            if (d === currentDay && lastSelectedMode === 'day') cls.push('tb-selected');
            html += '<div class="' + cls.join(' ') + '" data-day="' + d + '"><span>' + d + '</span></div>';
        }
        html += '</div>';
        body.innerHTML = html;
        var cells = body.querySelectorAll('.tb-day:not(.tb-empty)');
        for (var k = 0; k < cells.length; k++) {
            cells[k].onclick = (function (el) {
                return function () { selectDay(parseInt(el.getAttribute('data-day'), 10)); };
            })(cells[k]);
        }
    }
    function renderMonthCalendar(title, body) {
        title.textContent = String(currentYear);
        var today = new Date();
        var html = '<div class="tb-months">';
        monthNames.forEach(function (m, idx) {
            var cls = ['tb-month'];
            if (idx === today.getMonth() && currentYear === today.getFullYear()) cls.push('tb-today');
            if (idx === currentMonth && lastSelectedMode === 'month') cls.push('tb-selected');
            html += '<div class="' + cls.join(' ') + '" data-month="' + idx + '">' + m + '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
        var cells = body.querySelectorAll('.tb-month');
        for (var k = 0; k < cells.length; k++) {
            cells[k].onclick = (function (el) {
                return function () { selectMonth(parseInt(el.getAttribute('data-month'), 10)); };
            })(cells[k]);
        }
    }
    function renderYearCalendar(title, body) {
        var startYear = Math.floor(currentYear / 12) * 12;
        title.textContent = startYear + ' - ' + (startYear + 11);
        var today = new Date();
        var html = '<div class="tb-years">';
        for (var i = 0; i < 12; i++) {
            var y = startYear + i;
            var cls = ['tb-year'];
            if (y === today.getFullYear()) cls.push('tb-today');
            if (y === currentYear && lastSelectedMode === 'year') cls.push('tb-selected');
            html += '<div class="' + cls.join(' ') + '" data-year="' + y + '">' + y + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
        var cells = body.querySelectorAll('.tb-year');
        for (var k = 0; k < cells.length; k++) {
            cells[k].onclick = (function (el) {
                return function () { selectYear(parseInt(el.getAttribute('data-year'), 10)); };
            })(cells[k]);
        }
    }

    function selectDay(day) {
        _userInteracted = true;
        cancelInitialRetries();

        currentDay = day;
        lastSelectedMode = 'day';
        var s = new Date(currentYear, currentMonth, day, 0, 0, 0).getTime();
        var e = isToday(currentYear, currentMonth, day)
            ? Date.now()
            : new Date(currentYear, currentMonth, day, 23, 59, 59, 999).getTime();
        applyTimewindow(s, e, HOUR_MS);

        if (dayValue) dayValue.textContent = String(day);
        if (monthValue) monthValue.textContent = monthNames[currentMonth];
        if (yearValue) yearValue.textContent = String(currentYear);
        setActiveVisual('day');
        saveState('day', currentYear, currentMonth, currentDay);
        closePicker();
    }

    function selectMonth(month) {
        _userInteracted = true;
        cancelInitialRetries();

        currentMonth = month;
        lastSelectedMode = 'month';
        var s = new Date(currentYear, month, 1, 0, 0, 0).getTime();
        var e = isThisMonth(currentYear, month)
            ? Date.now()
            : new Date(currentYear, month + 1, 0, 23, 59, 59, 999).getTime();
        applyTimewindow(s, e, DAY_MS);

        if (dayValue) dayValue.textContent = 'Day';
        if (monthValue) monthValue.textContent = monthNames[month];
        if (yearValue) yearValue.textContent = String(currentYear);
        setActiveVisual('month');
        saveState('month', currentYear, currentMonth, currentDay);
        closePicker();
    }

    function selectYear(year) {
        _userInteracted = true;
        cancelInitialRetries();

        currentYear = year;
        lastSelectedMode = 'year';
        var s = new Date(year, 0, 1, 0, 0, 0).getTime();
        var e = isThisYear(year)
            ? Date.now()
            : new Date(year, 11, 31, 23, 59, 59, 999).getTime();
        applyTimewindow(s, e, MONTH_MS);

        if (dayValue) dayValue.textContent = 'Day';
        if (monthValue) monthValue.textContent = 'Month';
        if (yearValue) yearValue.textContent = String(year);
        setActiveVisual('year');
        saveState('year', currentYear, currentMonth, currentDay);
        closePicker();
    }

    if (yearValue) yearValue.textContent = String(currentYear);
    if (monthValue) monthValue.textContent = lastSelectedMode === 'year' ? 'Month' : monthNames[currentMonth];
    if (dayValue) dayValue.textContent = (lastSelectedMode === 'year' || lastSelectedMode === 'month') ? 'Day' : String(currentDay);
    setActiveVisual(lastSelectedMode);

    applyInitialTWWithRetries();

    if (widgetContainer && window.ResizeObserver) {
        var ro = new ResizeObserver(function () {
            if (switcher && switcher.style) switcher.style.setProperty('--widget-scale', widgetScale());
            if (pickerElement) updatePickerPosition();
        });
        ro.observe(widgetContainer);
        self._tw_ro = ro;
    }
    if (yearBtn) yearBtn.addEventListener('click', function () { showPicker(yearBtn, 'year'); });
    if (monthBtn) monthBtn.addEventListener('click', function () { showPicker(monthBtn, 'month'); });
    if (dayBtn) dayBtn.addEventListener('click', function () { showPicker(dayBtn, 'day'); });

    window.addEventListener('pageshow', function (e) {
        if (e.persisted && !_userInteracted && !_appliedInitialTW) applyInitialTWWithRetries();
    });

    self._tw_closePicker = function () { var m = (window.top || window).__TB_TW_CALENDAR__; if (m && m.close) m.close(); };
    self._tw_cancelInit = cancelInitialRetries;
};

self.onDestroy = function () {
    try {
        if (self._tw_cancelInit) self._tw_cancelInit();
        if (self._tw_ro && self._tw_ro.disconnect) self._tw_ro.disconnect();
        if (self._tw_closePicker) self._tw_closePicker();
    } catch (e) { }
};
