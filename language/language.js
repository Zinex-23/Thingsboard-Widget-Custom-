self.onInit = function() {
    var ctx = self.ctx;
    
    // ===== CONFIG: ID state EN / JP =====
    var STATE_ID_JP = 'default';       // TODO: đổi thành ID state JP thật
    var STATE_ID_EN = 'home___copy_1'; // TODO: đổi thành ID state EN thật
    
    // ==== Hiển thị EN hoặc JP theo ngôn ngữ ====
    function displayLanguage(lang) {
        lang = (lang || '').toLowerCase();
        var display = ctx.$container[0].querySelector('#lang-display');
        if (!display) return;
        
        var isJa = lang.indexOf('ja') === 0;
        display.textContent = isJa ? 'JP' : 'EN';
    }
    
    // ==== Helpers: current state id (best-effort) ====
    function getCurrentStateId() {
        try {
            if (ctx.stateController && typeof ctx.stateController.getStateId === 'function') {
                return ctx.stateController.getStateId();
            }
        } catch (_) {}
        try {
            if (ctx.stateController && typeof ctx.stateController.getStateParams === 'function') {
                var p = ctx.stateController.getStateParams();
                if (p && (p.stateId || p.state)) return p.stateId || p.state;
            }
        } catch (_) {}
        return null;
    }

    // ==== Chuyển state theo lang (guard chống loop) ====
    function openStateByLang(lang) {
        lang = (lang || '').toLowerCase();
        var targetState = (lang.indexOf('ja') === 0) ? STATE_ID_JP : STATE_ID_EN;
        var currentState = getCurrentStateId();

        // Skip if already in target state
        if (currentState && currentState === targetState) return;

        // Debounce repeated openState to avoid loop/flicker
        var now = Date.now();
        if (self._lastTargetState === targetState && (now - (self._lastOpenAt || 0)) < 800) return;

        self._lastTargetState = targetState;
        self._lastOpenAt = now;
        self._isOpeningState = true;

        ctx.stateController.openState(targetState, {}, false);
    }
    
    // ----- Lần đầu load -----
    var initialLang = 'en_US';
    if (ctx.translate) {
        initialLang = ctx.translate.currentLang || ctx.translate.defaultLang || 'en_US';
    }
    
    displayLanguage(initialLang);
    self._lastLang = (initialLang || '').toLowerCase();
    openStateByLang(initialLang);
    
    // ----- Lắng nghe language đổi từ chỗ khác -----
    if (ctx.translate && ctx.translate.onLangChange && ctx.translate.onLangChange.subscribe) {
        self._langSub = ctx.translate.onLangChange.subscribe(function (event) {
            var newLang = event && (event.lang || event);
            newLang = (newLang || '').toLowerCase();
            if (newLang && self._lastLang === newLang) return;
            self._lastLang = newLang;

            if (self._langTimer) clearTimeout(self._langTimer);
            self._langTimer = setTimeout(function () {
                self._langTimer = null;
                displayLanguage(newLang);
                openStateByLang(newLang);
            }, 150);
        });
    }
};

self.onResize = function() {
    // CSS tự responsive theo container với clamp()
};

self.onDestroy = function() {
    if (self._langSub && self._langSub.unsubscribe) {
        self._langSub.unsubscribe();
    }
    if (self._langTimer) {
        clearTimeout(self._langTimer);
        self._langTimer = null;
    }
};

self.onDataUpdated = function() {
    // không dùng data
};
