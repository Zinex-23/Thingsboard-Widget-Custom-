(function ensureUtcCalendarManager() {
    var topWin = window.top || window;
    if (topWin.__TB_UTC_CALENDAR__) return;

    topWin.__TB_UTC_CALENDAR__ = {
        overlay: null,
        _listeners: [],
        ensureStyles: function (scale) {
            if (typeof scale === 'undefined') scale = 1;
            var topDoc = topWin.document;
            var style = topDoc.getElementById('tb-utc-calendar-global-styles');
            var css =
                '.tb-utc-calendar-overlay{position:fixed;inset:0;background:transparent;z-index:2147483647;--scale:' + scale + ';}' +
                '.tb-utc-calendar{position:fixed;background:#fff;border-radius:calc(8px * var(--scale));' +
                'box-shadow:0 calc(8px * var(--scale)) calc(24px * var(--scale)) rgba(0,0,0,.15);' +
                'padding:calc(16px * var(--scale));min-width:calc(280px * var(--scale));' +
                'z-index:2147483648;box-sizing:border-box;}' +
                '.tb-utc-calendar-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:calc(16px * var(--scale));gap:calc(8px*var(--scale));}' +
                '.tb-utc-nav-btn{width:calc(32px*var(--scale));height:calc(32px*var(--scale));border:none;background:transparent;border-radius:50%;' +
                'cursor:pointer;font-size:calc(16px*var(--scale));color:#666;transition:background .2s;flex-shrink:0;}' +
                '.tb-utc-nav-btn:hover{background:rgba(0,0,0,.05);}' +
                '.tb-utc-calendar-title{font-size:calc(14px*var(--scale));font-weight:600;color:#333;text-align:center;flex:1;min-width:0;}' +
                '.tb-utc-weekdays{display:grid;grid-template-columns:repeat(7,1fr);gap:calc(4px*var(--scale));margin-bottom:calc(8px*var(--scale));}' +
                '.tb-utc-weekday{text-align:center;font-size:calc(12px*var(--scale));font-weight:600;color:#999;padding:calc(8px*var(--scale)) 0;}' +
                '.tb-utc-days{display:grid;grid-template-columns:repeat(7,1fr);gap:calc(4px*var(--scale));}' +
                '.tb-utc-day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer;' +
                'font-size:calc(13px*var(--scale));transition:all .2s;}' +
                '.tb-utc-day:not(.tb-utc-empty):hover{background:rgba(48,86,128,.1);}' +
                '.tb-utc-day.tb-utc-today{background:#ED1C24;color:#fff;font-weight:600;}' +
                '.tb-utc-day.tb-utc-selected{outline:calc(2px*var(--scale)) solid #ED1C24;}' +
                '.tb-utc-months,.tb-utc-years{display:grid;grid-template-columns:repeat(3,1fr);gap:calc(8px*var(--scale));}' +
                '.tb-utc-month,.tb-utc-year{padding:calc(16px*var(--scale)) calc(8px*var(--scale));text-align:center;border-radius:calc(8px*var(--scale));' +
                'cursor:pointer;font-size:calc(13px*var(--scale));font-weight:500;transition:all .2s;}' +
                '.tb-utc-month:hover,.tb-utc-year:hover{background:rgba(48,86,128,.1);}' +
                '.tb-utc-month.tb-utc-today,.tb-utc-year.tb-utc-today{background:#ED1C24;color:#fff;}' +
                '.tb-utc-month.tb-utc-selected,.tb-utc-year.tb-utc-selected{outline:calc(2px*var(--scale)) solid #ED1C24;}';
            if (!style) {
                style = topDoc.createElement('style');
                style.id = 'tb-utc-calendar-global-styles';
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
            div.className = 'tb-utc-calendar-overlay';
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

self.onDestroy = self.onDestroy || function () {};

function ensureOffsetPopupManager() {
    var topWin = window.top || window;
    if (topWin.__TB_UTC_OFFSET__) return;

    function ensureOffsetStyles() {
        var topDoc = topWin.document;
        var style = topDoc.getElementById('tb-utc-offset-styles');
        var css =
            '.utc-offset-overlay{position:fixed;inset:0;background:transparent;z-index:2147483647;}' +
            '.utc-offset-dropdown{position:fixed;background:#fff;border-radius:6px;padding:8px;min-width:240px;' +
            'box-shadow:0 10px 24px rgba(0,0,0,.2);box-sizing:border-box;z-index:2147483648;}' +
            '.utc-offset-list{display:block;max-height:220px;overflow:auto;padding-right:4px;}' +
            '.utc-offset-item{border:1px solid transparent;border-radius:4px;padding:8px 10px;text-align:left;' +
            'font-size:12px;font-weight:500;color:#333;cursor:pointer;background:#fff;transition:all .2s ease;width:100%;}' +
            '.utc-offset-item:hover{background:rgba(48,86,128,.08);color:#305680;}' +
            '.utc-offset-item.active{background:rgba(237,28,36,.1);color:#ED1C24;border-color:rgba(237,28,36,.3);}';
        if (!style) {
            style = topDoc.createElement('style');
            style.id = 'tb-utc-offset-styles';
            style.textContent = css;
            topDoc.head.appendChild(style);
        } else {
            style.textContent = css;
        }
    }

    topWin.__TB_UTC_OFFSET__ = {
        overlay: null,
        dropdown: null,
        open: function (html, anchorEl) {
            this.close();
            ensureOffsetStyles();
            var topDoc = topWin.document;
            var div = topDoc.createElement('div');
            div.className = 'utc-offset-overlay';
            topDoc.body.appendChild(div);
            this.overlay = div;

            var dropdown = topDoc.createElement('div');
            dropdown.className = 'utc-offset-dropdown';
            dropdown.innerHTML = html;
            dropdown.style.width = '112px';
            dropdown.style.maxWidth = '112px';
            topDoc.body.appendChild(dropdown);
            this.dropdown = dropdown;

            var selfMgr = this;
            var onEsc = function (e) { if (e.key === 'Escape') selfMgr.close(); };
            var onOutside = function (e) { if (e.target === div) selfMgr.close(); };

            (window.top || window).addEventListener('keydown', onEsc, true);
            div.addEventListener('click', onOutside);

            this._listeners = [
                [window.top || window, 'keydown', onEsc, true],
                [div, 'click', onOutside, false]
            ];
            if (anchorEl) this.position(anchorEl);
            return div;
        },
        position: function (anchorEl) {
            if (!this.dropdown || !anchorEl) return;
            var a = anchorEl.getBoundingClientRect();
            var fe = window.frameElement;
            var f = fe ? fe.getBoundingClientRect() : { left: 0, top: 0 };
            var gap = 6;
            var left = f.left + a.left;
            var top = f.top + a.bottom + gap;
            var vw = (window.top || window).innerWidth;
            var vh = (window.top || window).innerHeight;
            var dd = this.dropdown;
            var ddW = dd.offsetWidth || 240;
            var ddH = dd.offsetHeight || 200;
            if (left + ddW + gap > vw) left = Math.max(gap, vw - ddW - gap);
            if (top + ddH + gap > vh) top = Math.max(gap, f.top + a.top - ddH - gap);
            dd.style.left = Math.max(gap, left) + 'px';
            dd.style.top = Math.max(gap, top) + 'px';
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
            try { if (this.dropdown) this.dropdown.remove(); } catch (e) { }
            this.overlay = null;
            this.dropdown = null;
            this._listeners = [];
        }
    };
}

self.onInit = function () {
    var yearBtn = document.getElementById('utc-year-btn');
    var monthBtn = document.getElementById('utc-month-btn');
    var dayBtn = document.getElementById('utc-day-btn');
    var offsetBtn = document.getElementById('utc-offset-btn');
    var yearValue = document.getElementById('utc-year-value');
    var monthValue = document.getElementById('utc-month-value');
    var dayValue = document.getElementById('utc-day-value');
    var switcher = document.querySelector('.utc-switcher');

    var HOUR_MS = 60 * 60 * 1000;
    var DAY_MS = 24 * 60 * 60 * 1000;
    var MONTH_MS = 30 * DAY_MS;

    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var monthNamesFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    var EPS_MS = 1000; // 1s
    var STORAGE_KEY = 'timewindow_widget_utc_state';
    var SHARED_OFFSET_KEY = 'timewindow_widget_utc_offset_min';

    // state
    var utcOffsetMinutes = 0;
    function detectLocalOffsetMinutes() {
        return -new Date().getTimezoneOffset();
    }
    var nowInit = new Date();
    var currentYear = nowInit.getUTCFullYear();
    var currentMonth = nowInit.getUTCMonth();
    var currentDay = nowInit.getUTCDate();
    var lastSelectedMode = 'month';

    // ===== Persistence =====
    function saveState(mode, y, m, d, offsetMin) {
        try {
            var state = { mode: mode, year: y, month: m, day: d, offsetMin: offsetMin };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { }
    }
    function saveSharedOffset(offsetMin) {
        try {
            localStorage.setItem(SHARED_OFFSET_KEY, String(offsetMin));
        } catch (e) { }
    }

    function offsetNowMs() {
        return Date.now() + utcOffsetMinutes * 60000;
    }

    function nowPartsForOffset() {
        var n = new Date(offsetNowMs());
        return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate() };
    }

    function restoreState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var state = JSON.parse(raw);
                if (state.mode) lastSelectedMode = state.mode;
                if (typeof state.offsetMin === 'number') utcOffsetMinutes = state.offsetMin;

                var y = state.year;
                var m = state.month;
                var d = state.day;

                // Validation
                var now = nowPartsForOffset();
                var isValid = true;

                if (typeof y !== 'number' || y < 1900 || y > 2100) isValid = false;
                if (typeof m !== 'number' || m < 0 || m > 11) isValid = false;
                if (typeof d !== 'number' || d < 1 || d > 31) isValid = false;

                if (isValid) {
                    // Check days in month
                    var daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
                    if (d > daysInMonth) d = daysInMonth;

                    currentYear = y;
                    currentMonth = m;
                    currentDay = d;
                } else {
                    // Fallback to now if invalid
                    currentYear = now.y;
                    currentMonth = now.m;
                    currentDay = now.d;
                }
            } else {
                utcOffsetMinutes = detectLocalOffsetMinutes();
                var nowDefault = nowPartsForOffset();
                currentYear = nowDefault.y;
                currentMonth = nowDefault.m;
                currentDay = nowDefault.d;
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

    function isToday(y, m, d) {
        var t = nowPartsForOffset();
        return t.y === y && t.m === m && t.d === d;
    }
    function isThisMonth(y, m) {
        var t = nowPartsForOffset();
        return t.y === y && t.m === m;
    }
    function isThisYear(y) {
        return nowPartsForOffset().y === y;
    }

    function startOfDayMs(y, m, d) {
        return Date.UTC(y, m, d, 0, 0, 0) - utcOffsetMinutes * 60000;
    }
    function endOfDayMs(y, m, d) {
        return Date.UTC(y, m, d, 23, 59, 59, 999) - utcOffsetMinutes * 60000;
    }
    function startOfMonthMs(y, m) {
        return Date.UTC(y, m, 1, 0, 0, 0) - utcOffsetMinutes * 60000;
    }
    function endOfMonthMs(y, m) {
        return Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - utcOffsetMinutes * 60000;
    }
    function startOfYearMs(y) {
        return Date.UTC(y, 0, 1, 0, 0, 0) - utcOffsetMinutes * 60000;
    }
    function endOfYearMs(y) {
        return Date.UTC(y, 11, 31, 23, 59, 59, 999) - utcOffsetMinutes * 60000;
    }

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

    function getDashboardTimewindow() {
        var d = self.ctx && self.ctx.dashboard ? self.ctx.dashboard : {};
        var tw = d.dashboardTimewindow;
        if (!tw && d.getDashboardTimewindow) tw = d.getDashboardTimewindow();
        return tw || null;
    }

    function applyTimewindow(startMs, endMs, intervalMs, force) {
        // tránh re-entrant
        if (_isApplyingTW) return;
        var cur = getCurrentTW();
        var target = { s: startMs, e: endMs, i: intervalMs };
        if (!force && softEqualTW(cur, target)) return;

        _isApplyingTW = true;

        var existing = getDashboardTimewindow() || {};
        var aggType = existing && existing.aggregation && existing.aggregation.type ? existing.aggregation.type : 'SUM';
        var aggLimit = existing && existing.aggregation && typeof existing.aggregation.limit === 'number'
            ? existing.aggregation.limit
            : 25000;
        var aggInterval = (aggType === 'NONE')
            ? ((existing.aggregation && typeof existing.aggregation.interval === 'number') ? existing.aggregation.interval : 0)
            : intervalMs;
        var histInterval = (aggType === 'NONE')
            ? ((existing.history && typeof existing.history.interval === 'number') ? existing.history.interval : 0)
            : intervalMs;
        var historyType = existing && existing.history && typeof existing.history.historyType === 'number'
            ? existing.history.historyType
            : 1;

        var tw = {
            hideInterval: existing.hideInterval === true,
            hideQuickInterval: existing.hideQuickInterval === true,
            hideAggregation: existing.hideAggregation === true,
            hideAggInterval: existing.hideAggInterval === true,
            hideTimezone: existing.hideTimezone === true,
            selectedTab: 1,
            realtime: { realtimeType: 0, interval: 1000, timewindowMs: 60000 },
            history: {
                historyType: historyType, interval: histInterval, timewindowMs: endMs - startMs,
                fixedTimewindow: { startTimeMs: startMs, endTimeMs: endMs }
            },
            aggregation: { type: aggType, limit: aggLimit, interval: aggInterval }

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
            var s1 = startOfDayMs(currentYear, currentMonth, currentDay);
            var e1 = isToday(currentYear, currentMonth, currentDay)
                ? frozenNowMs
                : endOfDayMs(currentYear, currentMonth, currentDay);
            return { s: s1, e: e1, i: HOUR_MS };
        } else if (lastSelectedMode === 'month') {
            var s2 = startOfMonthMs(currentYear, currentMonth);
            var e2 = isThisMonth(currentYear, currentMonth)
                ? frozenNowMs
                : endOfMonthMs(currentYear, currentMonth);
            return { s: s2, e: e2, i: DAY_MS };
        } else {
            var s3 = startOfYearMs(currentYear);
            var e3 = isThisYear(currentYear)
                ? frozenNowMs
                : endOfYearMs(currentYear);
            return { s: s3, e: e3, i: MONTH_MS };
        }
    }

    function applyInitialTWWithRetries() {
        cancelInitialRetries();
        // lastSelectedMode is already set by restoreState()

        var frozenNow = Date.now();
        var target = desiredTWFromStateWithFrozenNow(frozenNow);

        var tryApply = function () {
            if (_userInteracted || _appliedInitialTW) { cancelInitialRetries(); return; }
            var cur = getCurrentTW();
            if (softEqualTW(cur, target)) { _appliedInitialTW = true; cancelInitialRetries(); return; }
            applyTimewindow(target.s, target.e, target.i, true);
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
            '<div class="tb-utc-calendar">' +
            '<div class="tb-utc-calendar-header">' +
            '<button class="tb-utc-nav-btn" id="tb-utc-prev">❮</button>' +
            '<div class="tb-utc-calendar-title" id="tb-utc-title"></div>' +
            '<button class="tb-utc-nav-btn" id="tb-utc-next">❯</button>' +
            '</div>' +
            '<div class="tb-utc-calendar-body" id="tb-utc-body"></div>' +
            '</div>';
        var mgr = (window.top || window).__TB_UTC_CALENDAR__;
        pickerElement = mgr.open(html, scale);

        var topDoc = (window.top || window).document;
        var prevBtn = topDoc.getElementById('tb-utc-prev');
        var nextBtn = topDoc.getElementById('tb-utc-next');
        if (prevBtn) prevBtn.onclick = function () { navigate(-1); };
        if (nextBtn) nextBtn.onclick = function () { navigate(1); };

        renderCalendar();
        updatePickerPosition();
        window.addEventListener('scroll', updatePickerPosition, true);
        window.addEventListener('resize', updatePickerPosition);
    }
    function updatePickerPosition() {
        if (!pickerElement || !activeButton) return;
        var cal = pickerElement.querySelector('.tb-utc-calendar'); if (!cal) return;
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
        var mgr = (window.top || window).__TB_UTC_CALENDAR__;
        if (mgr && mgr.close) mgr.close();
        pickerElement = null; activeButton = null;
        window.removeEventListener('scroll', updatePickerPosition, true);
        window.removeEventListener('resize', updatePickerPosition);
    }
    function renderCalendar() {
        if (!pickerElement) return;
        var topDoc = (window.top || window).document;
        var title = topDoc.getElementById('tb-utc-title');
        var body = topDoc.getElementById('tb-utc-body');
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
        var offsetMs = utcOffsetMinutes * 60000;
        var firstDay = new Date(Date.UTC(currentYear, currentMonth, 1) - offsetMs).getUTCDay();
        var daysInMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 0)).getUTCDate();
        var today = nowPartsForOffset();
        var html = '<div class="tb-utc-weekdays">';
        weekdays.forEach(function (d) { html += '<div class="tb-utc-weekday">' + d + '</div>'; });
        html += '</div><div class="tb-utc-days">';
        for (var i = 0; i < firstDay; i++) html += '<div class="tb-utc-day tb-utc-empty"></div>';
        for (var d = 1; d <= daysInMonth; d++) {
            var cls = ['tb-utc-day'];
            if (today.y === currentYear && today.m === currentMonth && today.d === d) cls.push('tb-utc-today');
            if (d === currentDay && lastSelectedMode === 'day') cls.push('tb-utc-selected');
            html += '<div class="' + cls.join(' ') + '" data-day="' + d + '"><span>' + d + '</span></div>';
        }
        html += '</div>';
        body.innerHTML = html;
        var cells = body.querySelectorAll('.tb-utc-day:not(.tb-utc-empty)');
        for (var k = 0; k < cells.length; k++) {
            cells[k].onclick = (function (el) {
                return function () { selectDay(parseInt(el.getAttribute('data-day'), 10)); };
            })(cells[k]);
        }
    }
    function renderMonthCalendar(title, body) {
        title.textContent = String(currentYear);
        var today = nowPartsForOffset();
        var html = '<div class="tb-utc-months">';
        monthNames.forEach(function (m, idx) {
            var cls = ['tb-utc-month'];
            if (idx === today.m && currentYear === today.y) cls.push('tb-utc-today');
            if (idx === currentMonth && lastSelectedMode === 'month') cls.push('tb-utc-selected');
            html += '<div class="' + cls.join(' ') + '" data-month="' + idx + '">' + m + '</div>';
        });
        html += '</div>';
        body.innerHTML = html;
        var cells = body.querySelectorAll('.tb-utc-month');
        for (var k = 0; k < cells.length; k++) {
            cells[k].onclick = (function (el) {
                return function () { selectMonth(parseInt(el.getAttribute('data-month'), 10)); };
            })(cells[k]);
        }
    }
    function renderYearCalendar(title, body) {
        var startYear = Math.floor(currentYear / 12) * 12;
        title.textContent = startYear + ' - ' + (startYear + 11);
        var today = nowPartsForOffset();
        var html = '<div class="tb-utc-years">';
        for (var i = 0; i < 12; i++) {
            var y = startYear + i;
            var cls = ['tb-utc-year'];
            if (y === today.y) cls.push('tb-utc-today');
            if (y === currentYear && lastSelectedMode === 'year') cls.push('tb-utc-selected');
            html += '<div class="' + cls.join(' ') + '" data-year="' + y + '">' + y + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
        var cells = body.querySelectorAll('.tb-utc-year');
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
        var s = startOfDayMs(currentYear, currentMonth, day);
        var e = isToday(currentYear, currentMonth, day)
            ? Date.now()
            : endOfDayMs(currentYear, currentMonth, day);
        applyTimewindow(s, e, HOUR_MS);

        if (dayValue) dayValue.textContent = String(day);
        if (monthValue) monthValue.textContent = monthNames[currentMonth];
        if (yearValue) yearValue.textContent = String(currentYear);
        setActiveVisual('day');
        saveState('day', currentYear, currentMonth, currentDay, utcOffsetMinutes);
        closePicker();
    }

    function selectMonth(month) {
        _userInteracted = true;
        cancelInitialRetries();

        currentMonth = month;
        lastSelectedMode = 'month';
        var s = startOfMonthMs(currentYear, month);
        var e = isThisMonth(currentYear, month)
            ? Date.now()
            : endOfMonthMs(currentYear, month);
        applyTimewindow(s, e, DAY_MS);

        if (dayValue) dayValue.textContent = 'Day';
        if (monthValue) monthValue.textContent = monthNames[month];
        if (yearValue) yearValue.textContent = String(currentYear);
        setActiveVisual('month');
        saveState('month', currentYear, currentMonth, currentDay, utcOffsetMinutes);
        closePicker();
    }

    function selectYear(year) {
        _userInteracted = true;
        cancelInitialRetries();

        currentYear = year;
        lastSelectedMode = 'year';
        var s = startOfYearMs(year);
        var e = isThisYear(year)
            ? Date.now()
            : endOfYearMs(year);
        applyTimewindow(s, e, MONTH_MS);

        if (dayValue) dayValue.textContent = 'Day';
        if (monthValue) monthValue.textContent = 'Month';
        if (yearValue) yearValue.textContent = String(year);
        setActiveVisual('year');
        saveState('year', currentYear, currentMonth, currentDay, utcOffsetMinutes);
        closePicker();
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

    function buildOffsetOptions() {
        var offsets = [];
        for (var h = 0; h <= 23; h++) offsets.push(h * 60);
        return offsets;
    }

    function applyOffset(minutes) {
        utcOffsetMinutes = minutes;
        var target = desiredTWFromStateWithFrozenNow(Date.now());
        applyTimewindow(target.s, target.e, target.i);
        saveState(lastSelectedMode, currentYear, currentMonth, currentDay, utcOffsetMinutes);
        saveSharedOffset(utcOffsetMinutes);
        if (pickerElement) renderCalendar();
    }

    function updateOffsetButton() {
        if (!offsetBtn) return;
        offsetBtn.textContent = formatOffset(utcOffsetMinutes);
    }

    function openOffsetPopup() {
        ensureOffsetPopupManager();
        var mgr = (window.top || window).__TB_UTC_OFFSET__;
        if (!mgr) return;
        var offsets = buildOffsetOptions();
        var html = '<div class="utc-offset-list">';
        offsets.forEach(function (min) {
            var cls = 'utc-offset-item' + (min === utcOffsetMinutes ? ' active' : '');
            html += '<button class="' + cls + '" data-offset="' + min + '">' + formatOffset(min) + '</button>';
        });
        html += '</div>';
        var overlay = mgr.open(html, offsetBtn);
        if (!overlay) return;
        var items = mgr.dropdown ? mgr.dropdown.querySelectorAll('.utc-offset-item') : [];
        for (var i = 0; i < items.length; i++) {
            items[i].onclick = function (e) {
                var val = parseInt(this.getAttribute('data-offset'), 10);
                if (!isNaN(val)) {
                    applyOffset(val);
                    updateOffsetButton();
                }
                mgr.close();
                e.stopPropagation();
            };
        }
        if (mgr.dropdown) {
            var onResize = function () { mgr.position(offsetBtn); };
            window.addEventListener('resize', onResize);
            self._utc_offsetResize = onResize;
        }
    }

    if (yearValue) yearValue.textContent = String(currentYear);
    if (monthValue) monthValue.textContent = lastSelectedMode === 'year' ? 'Month' : monthNames[currentMonth];
    if (dayValue) dayValue.textContent = (lastSelectedMode === 'year' || lastSelectedMode === 'month') ? 'Day' : String(currentDay);
    setActiveVisual(lastSelectedMode);

    var validOffsets = buildOffsetOptions();
    if (validOffsets.indexOf(utcOffsetMinutes) === -1) {
        utcOffsetMinutes = detectLocalOffsetMinutes();
        if (validOffsets.indexOf(utcOffsetMinutes) === -1) utcOffsetMinutes = 0;
    }
    updateOffsetButton();
    saveSharedOffset(utcOffsetMinutes);
    if (offsetBtn) offsetBtn.addEventListener('click', openOffsetPopup);

    applyInitialTWWithRetries();

    if (widgetContainer && window.ResizeObserver) {
        var ro = new ResizeObserver(function () {
            if (switcher && switcher.style) switcher.style.setProperty('--widget-scale', widgetScale());
            if (pickerElement) updatePickerPosition();
        });
        ro.observe(widgetContainer);
        self._utc_ro = ro;
    }
    if (yearBtn) yearBtn.addEventListener('click', function () { showPicker(yearBtn, 'year'); });
    if (monthBtn) monthBtn.addEventListener('click', function () { showPicker(monthBtn, 'month'); });
    if (dayBtn) dayBtn.addEventListener('click', function () { showPicker(dayBtn, 'day'); });

    window.addEventListener('pageshow', function (e) {
        if (e.persisted && !_userInteracted && !_appliedInitialTW) applyInitialTWWithRetries();
    });

    self._utc_closePicker = function () { var m = (window.top || window).__TB_UTC_CALENDAR__; if (m && m.close) m.close(); };
    self._utc_cancelInit = cancelInitialRetries;
};

self.onDestroy = function () {
    try {
        var mgr = (window.top || window).__TB_UTC_OFFSET__;
        if (mgr && mgr.close) mgr.close();
        if (self._utc_offsetResize) window.removeEventListener('resize', self._utc_offsetResize);
        if (self._utc_cancelInit) self._utc_cancelInit();
        if (self._utc_ro && self._utc_ro.disconnect) self._utc_ro.disconnect();
        if (self._utc_closePicker) self._utc_closePicker();
    } catch (e) { }
};
