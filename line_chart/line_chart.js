(function () {
    let chart = null;
    let rootEl = null;
    let topbarEl = null;
    let canvasEl = null;
    let legendEl = null;
    let emptyEl = null;
    let resetZoomBtnEl = null;
    let mobileDetailEl = null;
    let selectedTimeEl = null;
    let selectedValuesEl = null;
    let resizeObserver = null;
    let canvasInteractionHandler = null;
    let legendClickHandler = null;
    let resetZoomHandler = null;
    let currentLayout = { width: 0, height: 0, mobile: false, compact: false, short: false, bucket: 'lg' };
    let lastLayoutSignature = '';
    let currentTimeContext = null;
    let selectedTimestamp = null;

    // =========================
    // ✅ Coalesced Refresh (Hướng 1)
    // =========================
    const QUIET_TIME_MS = 350;          // thời gian “yên” để coi state/timewindow đã ổn định
    const SAME_SIG_SKIP_WINDOW_MS = 800; // chống spam khi TB bắn lại cùng chữ ký
    let refreshTimer = null;
    let lastAppliedSig = null;
    let lastAppliedAt = 0;
    let refreshSeq = 0;                // token tăng dần mỗi lần schedule -> dùng để hủy kết quả fetch cũ
    let lastRenderAt = 0;
    const FAST_UPDATE_WINDOW_MS = 700; // nếu switch dồn dập thì update không animation

    function stableStringify(obj) {
        // stringify ổn định để signature không bị lệch do thứ tự key
        const allKeys = [];
        JSON.stringify(obj, (k, v) => (allKeys.push(k), v));
        allKeys.sort();
        return JSON.stringify(obj, allKeys);
    }

    function getTimeWindowSafe() {
        const sub = self.ctx.defaultSubscription;
        const tw = sub?.subscriptionTimewindow;
        let startTime = tw?.minTime || tw?.fixedWindow?.startTimeMs;
        let endTime = tw?.maxTime || tw?.fixedWindow?.endTimeMs;

        // Day mode -> fetch full day (00:00–23:59) để không mất data (display vẫn cắt 7–19 ở applyTimeScale)
        if (isDayMode(tw)) {
            const [s0, e24] = getDayWindowFull(tw);
            startTime = s0;
            endTime = e24;
        }
        return { sub, tw, startTime, endTime };
    }

    function getStateSafe() {
        const stateController = self.ctx.stateController;
        const stateParams = stateController ? stateController.getStateParams() : {};
        const deviceMode = stateParams?.selectedDeviceMode || stateParams?.mode;
        const entitiesFromState = stateParams?.entities || stateParams?.entityIds || [];
        const storeName = stateParams?.selectedDeviceName || stateParams?.name || 'All Devices';
        return { stateParams, deviceMode, entitiesFromState, storeName };
    }

    function getDataKeysSafe(sub) {
        return (sub?.data || []).map(dk => dk.dataKey?.name).filter(Boolean);
    }

    function makeSignature() {
        const { sub, startTime, endTime } = getTimeWindowSafe();
        const { deviceMode, entitiesFromState } = getStateSafe();
        const dataKeys = getDataKeysSafe(sub);

        const entityIds = (entitiesFromState || []).map(e => (e && e.id) ? e.id : e).filter(Boolean).sort();
        const sigObj = {
            deviceMode: deviceMode || '',
            entityIds,
            startTime: startTime || 0,
            endTime: endTime || 0,
            dataKeys: (dataKeys || []).slice().sort()
        };
        return stableStringify(sigObj);
    }

    function scheduleRefresh(reason) {
        if (!chart) return;

        // mỗi lần schedule tăng seq để invalidate fetch/update cũ
        const mySeq = ++refreshSeq;

        if (refreshTimer) clearTimeout(refreshTimer);

        refreshTimer = setTimeout(() => {
            if (!chart) return;

            // nếu trong thời gian chờ mà có schedule mới -> seq đã tăng -> bỏ lượt này
            if (mySeq !== refreshSeq) return;

            const sigNow = makeSignature();

            // nếu signature không đổi và vừa mới apply gần đây -> skip để tránh TB bắn lặp
            const now = Date.now();
            if (sigNow === lastAppliedSig && (now - lastAppliedAt) < SAME_SIG_SKIP_WINDOW_MS) {
                // console.log('[line_chart] ✅ Same signature - skip refresh', { reason });
                return;
            }

            lastAppliedSig = sigNow;
            lastAppliedAt = now;

            // console.log('[line_chart] 🔁 Coalesced refresh', { reason });
            processDataUpdate(mySeq);
        }, QUIET_TIME_MS);
    }

    function cacheDomRefs() {
        const container = self.ctx && self.ctx.$container ? self.ctx.$container[0] : null;
        rootEl = container ? container.querySelector('#lc-root') : null;
        topbarEl = container ? container.querySelector('.lc-topbar') : null;
        canvasEl = container ? container.querySelector('#chart') : null;
        legendEl = container ? container.querySelector('#lc-legend') : null;
        emptyEl = container ? container.querySelector('#lc-empty') : null;
        resetZoomBtnEl = container ? container.querySelector('#lc-reset-zoom') : null;
        mobileDetailEl = container ? container.querySelector('#lc-mobile-detail') : null;
        selectedTimeEl = container ? container.querySelector('#lc-selected-time') : null;
        selectedValuesEl = container ? container.querySelector('#lc-selected-values') : null;
    }

    function buildChartOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 800, easing: 'easeOutQuart' },
            legend: {
                display: true,
                position: 'top',
                labels: { usePointStyle: true, boxWidth: 3 }
            },
            layout: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
            tooltips: {
                backgroundColor: '#FFFFFF',
                titleFontColor: '#000000',
                bodyFontColor: '#000000',
                borderColor: 'rgba(0,0,0,0.15)',
                borderWidth: 1,
                displayColors: true,
                intersect: false,
                mode: 'index',
                callbacks: {
                    title: function (items, data) {
                        const ti = items && items[0];
                        if (!ti) return '';
                        const ds = data && data.datasets ? data.datasets[ti.datasetIndex] : null;
                        const pt = ds && ds.data ? ds.data[ti.index] : null;
                        const ts = (pt && (pt.t || pt.x)) || ti.xLabel || ti.label;
                        return formatTimestampLabel(ts);
                    },
                    labelPointStyle: function () { return { PointStyle: 'true', rotation: 0 }; },
                    labelColor: function (tooltipItem, chartRef) {
                        const ds = chartRef.config.data.datasets[tooltipItem.datasetIndex];
                        const c = ds.borderColor || '#666';
                        return { borderColor: c, backgroundColor: c };
                    }
                }
            },
            scales: {
                xAxes: [{
                    type: 'time',
                    time: {
                        tooltipFormat: 'HH:mm',
                        displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'YYYY-MM-DD', month: 'MMM' }
                    },
                    distribution: 'linear',
                    scaleLabel: { display: true, labelString: 'Date Time' },
                    ticks: {
                        source: 'data',
                        autoSkip: true,
                        maxRotation: 0,
                        minRotation: 0,
                        maxTicksLimit: 8,
                        fontSize: 11,
                        padding: 8
                    },
                    gridLines: {
                        color: 'rgba(148, 163, 184, 0.18)',
                        drawBorder: false
                    },
                    offset: false
                }],
                yAxes: [{
                    scaleLabel: { display: true, labelString: 'People Count' },
                    ticks: {
                        beginAtZero: true,
                        maxTicksLimit: 6,
                        fontSize: 11,
                        padding: 8
                    },
                    gridLines: {
                        color: 'rgba(148, 163, 184, 0.18)',
                        drawBorder: false
                    }
                }]
            },
            pan: { enabled: true, mode: 'x' },
            zoom: { enabled: true, mode: 'x' },
            elements: { point: { radius: 2, hoverRadius: 5, hitRadius: 6 } }
        };
    }

    function bindUiEvents() {
        if (legendEl) {
            legendClickHandler = function (evt) {
                const chip = evt.target && evt.target.closest ? evt.target.closest('.lc-legend-chip') : null;
                if (!chip || !legendEl.contains(chip)) return;
                const idx = Number(chip.getAttribute('data-index'));
                if (Number.isNaN(idx)) return;
                toggleDatasetVisibility(idx);
            };
            legendEl.addEventListener('click', legendClickHandler);
        }

        if (resetZoomBtnEl && chart && typeof chart.resetZoom === 'function') {
            resetZoomHandler = function () {
                if (!chart || typeof chart.resetZoom !== 'function') return;
                chart.resetZoom();
                chart.update(0);
            };
            resetZoomBtnEl.addEventListener('click', resetZoomHandler);
        }

        if (canvasEl) {
            canvasInteractionHandler = function (evt) {
                if (!currentLayout.mobile) return;
                handleChartInteraction(evt);
            };
            canvasEl.addEventListener('click', canvasInteractionHandler);
            canvasEl.addEventListener('touchstart', canvasInteractionHandler, { passive: true });
        }
    }

    function unbindUiEvents() {
        if (legendEl && legendClickHandler) {
            legendEl.removeEventListener('click', legendClickHandler);
        }
        if (resetZoomBtnEl && resetZoomHandler) {
            resetZoomBtnEl.removeEventListener('click', resetZoomHandler);
        }
        if (canvasEl && canvasInteractionHandler) {
            canvasEl.removeEventListener('click', canvasInteractionHandler);
            canvasEl.removeEventListener('touchstart', canvasInteractionHandler);
        }

        legendClickHandler = null;
        resetZoomHandler = null;
        canvasInteractionHandler = null;
    }

    function setupResizeObserver() {
        if (resizeObserver || typeof ResizeObserver === 'undefined') return;
        const container = self.ctx && self.ctx.$container ? self.ctx.$container[0] : null;
        if (!container) return;

        resizeObserver = new ResizeObserver(function () {
            syncResponsiveLayout();
        });
        resizeObserver.observe(container);
    }

    function computeLayoutState() {
        const container = self.ctx && self.ctx.$container ? self.ctx.$container[0] : null;
        const rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
        const width = Math.max(0, Math.round((rect && rect.width) || (container && container.clientWidth) || 0));
        const height = Math.max(0, Math.round((rect && rect.height) || (container && container.clientHeight) || 0));
        const mobile = width <= 700 || (width <= 820 && height > width * 1.05);
        const compact = false;
        const short = mobile && height > 0 && height <= 360;
        let bucket = 'lg';

        if (width <= 420) bucket = 'xs';
        else if (width <= 700) bucket = 'sm';

        return { width, height, mobile, compact, short, bucket };
    }

    function getLayoutSignature(layout) {
        return [layout.mobile ? 1 : 0, layout.compact ? 1 : 0, layout.short ? 1 : 0, layout.bucket].join('|');
    }

    function applyResponsiveChartOptions(layout) {
        if (!chart) return;

        const xAxis = chart.options.scales.xAxes[0];
        const yAxis = chart.options.scales.yAxes[0];
        const maxXTicks = layout.bucket === 'xs' ? 4 : 5;

        chart.options.legend.display = !layout.mobile;
        chart.options.legend.position = 'top';
        chart.options.legend.labels = chart.options.legend.labels || {};
        chart.options.legend.labels.usePointStyle = true;
        chart.options.legend.labels.boxWidth = 3;
        chart.options.layout.padding = layout.mobile
            ? { top: 4, right: 2, bottom: 0, left: 0 }
            : { top: 0, right: 0, bottom: 0, left: 0 };

        xAxis.scaleLabel.display = !layout.mobile;
        xAxis.ticks.autoSkip = true;
        xAxis.ticks.maxTicksLimit = layout.mobile ? maxXTicks : undefined;
        xAxis.ticks.maxRotation = 0;
        xAxis.ticks.minRotation = 0;
        xAxis.ticks.fontSize = layout.mobile ? 10 : 11;
        xAxis.ticks.padding = layout.mobile ? 6 : 8;

        yAxis.scaleLabel.display = !layout.mobile;
        yAxis.ticks.maxTicksLimit = layout.mobile ? 4 : 6;
        yAxis.ticks.fontSize = layout.mobile ? 10 : 11;
        yAxis.ticks.padding = layout.mobile ? 4 : 8;

        chart.options.tooltips.titleFontSize = layout.mobile ? 11 : 12;
        chart.options.tooltips.bodyFontSize = layout.mobile ? 11 : 12;
        chart.options.tooltips.xPadding = layout.mobile ? 10 : 12;
        chart.options.tooltips.yPadding = layout.mobile ? 8 : 10;

        chart.options.elements.point.hoverRadius = layout.mobile ? 6 : 5;
        chart.options.elements.point.hitRadius = layout.mobile ? 12 : 6;
    }

    function syncResponsiveLayout(forceUpdate) {
        currentLayout = computeLayoutState();
        const layoutSignature = getLayoutSignature(currentLayout);
        const layoutChanged = forceUpdate || layoutSignature !== lastLayoutSignature;

        if (rootEl) {
            rootEl.classList.toggle('lc-mobile', currentLayout.mobile);
            rootEl.classList.toggle('lc-short', currentLayout.short);
        }

        if (!chart) {
            lastLayoutSignature = layoutSignature;
            return;
        }

        if (layoutChanged) {
            applyResponsiveChartOptions(currentLayout);
            renderLegend();
            syncSelectionDisplay();
            chart.update(0);
        }

        chart.resize();
        lastLayoutSignature = layoutSignature;
    }

    function getHiddenDatasetLabels() {
        const hiddenMap = {};
        if (!chart || !chart.data || !Array.isArray(chart.data.datasets)) return hiddenMap;

        chart.data.datasets.forEach(function (dataset, index) {
            if (!dataset || !dataset.label) return;
            if (isDatasetHidden(index)) {
                hiddenMap[dataset.label] = true;
            }
        });

        return hiddenMap;
    }

    function applyHiddenState(datasets, hiddenMap) {
        (datasets || []).forEach(function (dataset) {
            if (!dataset || !dataset.label) return;
            dataset.hidden = !!hiddenMap[dataset.label];
        });
    }

    function decorateDatasetsForLayout(datasets) {
        const denseLimit = currentLayout.mobile ? 36 : 72;
        (datasets || []).forEach(function (dataset) {
            const pointCount = Array.isArray(dataset.data) ? dataset.data.length : 0;
            const dense = pointCount > denseLimit;

            dataset.borderWidth = currentLayout.mobile ? 3 : 5;
            dataset.pointRadius = dense ? 0 : (currentLayout.mobile ? 2 : 2);
            dataset.pointHitRadius = currentLayout.mobile ? 16 : 6;
            dataset.pointHoverRadius = currentLayout.mobile ? 6 : 5;
        });
    }

    function isDatasetHidden(index) {
        if (!chart || !chart.data || !chart.data.datasets || !chart.data.datasets[index]) return false;
        const dataset = chart.data.datasets[index];
        const meta = typeof chart.getDatasetMeta === 'function' ? chart.getDatasetMeta(index) : null;
        return !!((meta && meta.hidden === true) || dataset.hidden);
    }

    function toggleDatasetVisibility(index) {
        if (!chart || !chart.data || !chart.data.datasets || !chart.data.datasets[index]) return;

        const dataset = chart.data.datasets[index];
        const nextHidden = !isDatasetHidden(index);
        const meta = typeof chart.getDatasetMeta === 'function' ? chart.getDatasetMeta(index) : null;

        dataset.hidden = nextHidden;
        if (meta) {
            meta.hidden = nextHidden ? true : null;
        }

        chart.update(0);
        renderLegend();
        syncSelectionDisplay();
    }

    function renderLegend() {
        if (!legendEl) return;
        legendEl.innerHTML = '';

        const datasets = chart && chart.data && Array.isArray(chart.data.datasets) ? chart.data.datasets : [];
        if (!datasets.length) {
            const empty = document.createElement('div');
            empty.className = 'lc-legend-empty';
            empty.textContent = 'No series available';
            legendEl.appendChild(empty);
            return;
        }

        datasets.forEach(function (dataset, index) {
            const chip = document.createElement('button');
            const swatch = document.createElement('span');
            const label = document.createElement('span');
            const hidden = isDatasetHidden(index);

            chip.type = 'button';
            chip.className = 'lc-legend-chip' + (hidden ? ' is-off' : '');
            chip.setAttribute('data-index', String(index));
            chip.setAttribute('aria-pressed', hidden ? 'false' : 'true');

            swatch.className = 'lc-legend-swatch';
            swatch.style.background = dataset.borderColor || dataset.backgroundColor || '#94a3b8';

            label.className = 'lc-legend-label';
            label.textContent = dataset.label || ('Series ' + (index + 1));

            chip.appendChild(swatch);
            chip.appendChild(label);
            legendEl.appendChild(chip);
        });
    }

    function hasRenderableData(datasets) {
        const list = datasets || (chart && chart.data ? chart.data.datasets : []) || [];
        for (let i = 0; i < list.length; i++) {
            const points = Array.isArray(list[i].data) ? list[i].data : [];
            for (let j = 0; j < points.length; j++) {
                if (points[j] && points[j].y != null) return true;
            }
        }
        return false;
    }

    function syncEmptyState(datasets) {
        if (!emptyEl) return;
        emptyEl.classList.toggle('is-visible', !hasRenderableData(datasets));
    }

    function getActiveElementsFromEvent(evt) {
        if (!chart) return [];

        if (typeof chart.getElementsAtEventForMode === 'function') {
            const items = chart.getElementsAtEventForMode(evt, 'index', { intersect: false });
            if (items && items.length) return items;
        }
        if (typeof chart.getElementsAtXAxis === 'function') {
            const items = chart.getElementsAtXAxis(evt);
            if (items && items.length) return items;
        }
        if (typeof chart.getElementsAtEvent === 'function') {
            const items = chart.getElementsAtEvent(evt);
            if (items && items.length) return items;
        }

        return [];
    }

    function extractTimestampFromElement(element) {
        if (!element || !chart || !chart.data || !chart.data.datasets) return null;
        const datasetIndex = element._datasetIndex != null ? element._datasetIndex : element.datasetIndex;
        const pointIndex = element._index != null ? element._index : element.index;
        const dataset = chart.data.datasets[datasetIndex];
        const point = dataset && Array.isArray(dataset.data) ? dataset.data[pointIndex] : null;
        if (!point) return null;
        const ts = point.t != null ? point.t : point.x;
        return Number.isFinite(Number(ts)) ? Number(ts) : null;
    }

    function handleChartInteraction(evt) {
        const active = getActiveElementsFromEvent(evt);
        if (!active.length) return;
        const ts = extractTimestampFromElement(active[0]);
        if (ts == null) return;
        renderSelectionState(ts);
    }

    function findPointByTimestamp(points, targetTs) {
        const list = Array.isArray(points) ? points : [];
        for (let i = 0; i < list.length; i++) {
            const point = list[i];
            const ts = point && (point.t != null ? point.t : point.x);
            if (Number(ts) === Number(targetTs)) return point;
        }
        return null;
    }

    function collectSelectionItems(targetTs) {
        if (!chart || !chart.data || !Array.isArray(chart.data.datasets)) return [];

        const items = [];
        chart.data.datasets.forEach(function (dataset, index) {
            if (!dataset || isDatasetHidden(index)) return;
            const point = findPointByTimestamp(dataset.data, targetTs);
            if (!point || point.y == null) return;

            items.push({
                label: dataset.label || ('Series ' + (index + 1)),
                color: dataset.borderColor || dataset.backgroundColor || '#94a3b8',
                value: point.y
            });
        });

        items.sort(function (a, b) { return Number(b.value || 0) - Number(a.value || 0); });
        return items;
    }

    function pickNearestTimestamp(preferredTs) {
        if (!chart || !chart.data || !Array.isArray(chart.data.datasets)) return null;

        const map = {};
        chart.data.datasets.forEach(function (dataset, index) {
            if (!dataset || isDatasetHidden(index)) return;
            (dataset.data || []).forEach(function (point) {
                const ts = point && (point.t != null ? point.t : point.x);
                if (ts != null && point.y != null) {
                    map[Number(ts)] = true;
                }
            });
        });

        const timestamps = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
        if (!timestamps.length) return null;
        if (preferredTs == null) return timestamps[timestamps.length - 1];

        let best = timestamps[0];
        let bestDistance = Math.abs(best - preferredTs);
        for (let i = 1; i < timestamps.length; i++) {
            const distance = Math.abs(timestamps[i] - preferredTs);
            if (distance < bestDistance) {
                best = timestamps[i];
                bestDistance = distance;
            }
        }
        return best;
    }

    function renderSelectionEmpty(message) {
        if (!selectedTimeEl || !selectedValuesEl) return;
        selectedTimeEl.textContent = message || 'No selection';
        selectedValuesEl.innerHTML = '';

        const empty = document.createElement('div');
        empty.className = 'lc-mobile-empty';
        empty.textContent = hasRenderableData()
            ? 'Use the series chips to focus the chart, then tap a point to inspect the values.'
            : 'The current time window does not contain any data.';
        selectedValuesEl.appendChild(empty);
    }

    function renderSelectionState(targetTs) {
        if (!selectedTimeEl || !selectedValuesEl) return;

        let ts = targetTs;
        let items = collectSelectionItems(ts);
        if (!items.length) {
            ts = pickNearestTimestamp(ts);
            items = ts == null ? [] : collectSelectionItems(ts);
        }

        if (!items.length) {
            selectedTimestamp = null;
            renderSelectionEmpty(hasRenderableData() ? 'All series are hidden' : 'No data available');
            return;
        }

        selectedTimestamp = ts;
        selectedTimeEl.textContent = formatTimestampLabel(ts);
        selectedValuesEl.innerHTML = '';

        items.forEach(function (item) {
            const row = document.createElement('div');
            const main = document.createElement('div');
            const swatch = document.createElement('span');
            const label = document.createElement('span');
            const value = document.createElement('span');

            row.className = 'lc-mobile-value';
            main.className = 'lc-mobile-value-main';
            swatch.className = 'lc-legend-swatch';
            swatch.style.background = item.color;
            label.className = 'lc-mobile-value-label';
            label.textContent = item.label;
            value.className = 'lc-mobile-value-number';
            value.textContent = formatNumber(item.value);

            main.appendChild(swatch);
            main.appendChild(label);
            row.appendChild(main);
            row.appendChild(value);
            selectedValuesEl.appendChild(row);
        });
    }

    function syncSelectionDisplay() {
        if (!mobileDetailEl) return;

        if (!hasRenderableData()) {
            selectedTimestamp = null;
            renderSelectionEmpty('No data available');
            return;
        }

        const nextTs = pickNearestTimestamp(selectedTimestamp);
        if (nextTs == null) {
            selectedTimestamp = null;
            renderSelectionEmpty('No visible series');
            return;
        }

        renderSelectionState(nextTs);
    }

    function formatTimestampLabel(ts) {
        const value = Number(ts);
        if (!Number.isFinite(value)) return '';

        if (typeof moment !== 'undefined') {
            if (currentTimeContext && currentTimeContext.isYearMode) return moment(value).format('MMM YYYY');
            if (currentTimeContext && currentTimeContext.isMonthMode) return moment(value).format('DD MMM YYYY');
            return moment(value).format('DD MMM YYYY, HH:mm');
        }

        const date = new Date(value);
        if (currentTimeContext && currentTimeContext.isYearMode) {
            return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        }
        if (currentTimeContext && currentTimeContext.isMonthMode) {
            return date.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
        }
        return date.toLocaleString('en-US', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatNumber(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value == null ? '' : value);

        const hasDecimals = Math.abs(num % 1) > 0.001;
        if (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
            return new Intl.NumberFormat('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: hasDecimals ? 2 : 0
            }).format(num);
        }

        return String(hasDecimals ? Math.round(num * 100) / 100 : Math.round(num));
    }

    // =========================
    // Widget lifecycle
    // =========================
    self.onInit = function () {
        if (typeof moment !== 'undefined') {
            moment.locale('en');
        }

        cacheDomRefs();
        if (!canvasEl) return;

        const ctx = canvasEl.getContext('2d');

        chart = new Chart(ctx, {
            type: 'line',
            data: { datasets: [] },
            options: buildChartOptions()
        });

        if (resetZoomBtnEl) {
            const hasResetZoom = typeof chart.resetZoom === 'function';
            resetZoomBtnEl.style.display = hasResetZoom ? '' : 'none';
            if (topbarEl && !hasResetZoom) {
                topbarEl.style.display = 'none';
            }
        }

        bindUiEvents();
        setupResizeObserver();
        syncResponsiveLayout(true);

        // ✅ Subscribe to dashboard state changes -> chỉ schedule refresh (không render ngay)
        if (self.ctx.stateController) {
            self.stateSubscription = self.ctx.stateController.stateChanged().subscribe(function () {
                // console.log('[line_chart] 📡 Dashboard state changed');
                scheduleRefresh('stateChanged');
            });
        }

        // init render lần đầu
        scheduleRefresh('init');
    };

    self.onResize = function () {
        syncResponsiveLayout();
    };

    self.onDestroy = function () {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
        if (activeFetchController) {
            try { activeFetchController.abort(); } catch (e) { }
            activeFetchController = null;
        }
        if (self.stateSubscription) {
            self.stateSubscription.unsubscribe();
            self.stateSubscription = null;
        }
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        unbindUiEvents();
        if (chart) {
            chart.destroy();
            chart = null;
        }
    };

    // ThingsBoard gọi khi data/timewindow/subscription update -> chỉ schedule refresh
    self.onDataUpdated = function () {
        scheduleRefresh('onDataUpdated');
    };

    // =========================
    // Render pipeline
    // =========================
    // Track in-flight fetch to allow cancel on rapid switching
    let activeFetchController = null;

    function processDataUpdate(seqToken) {
        if (!chart) return;

        const { sub, tw, startTime, endTime } = getTimeWindowSafe();
        if (!sub) return;

        const spanDays = (endTime && startTime) ? (endTime - startTime) / (24 * 60 * 60 * 1000) : 0;
        const isYearMode = spanDays >= 300;
        const isMonthMode = !isYearMode && spanDays > 1;
        const isHourlyGapMode = spanDays <= 1;

        const dataKeys = getDataKeysSafe(sub);

        const { stateParams, deviceMode, entitiesFromState, storeName } = getStateSafe();
        const isAllDevicesMode = deviceMode === 'ALL';

        // Extract color and label mapping from subscription data keys
        const colorMap = {};
        const labelMap = {};
        (sub?.data || []).forEach(dk => {
            const keyName = dk.dataKey?.name;
            const keyColor = dk.dataKey?.color;
            const keyLabel = dk.dataKey?.label;
            if (keyName && keyColor) colorMap[keyName] = keyColor;
            if (keyName && keyLabel) labelMap[keyName] = keyLabel;
        });

        // console.log('[line_chart] 📊 Mode check:', { deviceMode, isAllDevicesMode, entitiesCount: entitiesFromState.length, dataKeys });

        // ✅ Nếu signature đã thay đổi trong lúc đang xử lý -> bỏ
        if (seqToken !== refreshSeq) return;

        if (isAllDevicesMode && entitiesFromState.length > 1 && dataKeys.length > 0) {
            // ✅ ALL DEVICES MODE: Fetch telemetry for all devices manually
            if (activeFetchController) {
                try { activeFetchController.abort(); } catch (e) { }
            }
            const fetchToken = seqToken; // dùng để invalidate kết quả fetch cũ
            activeFetchController = new AbortController();

            fetchAllDevicesTelemetry(
                entitiesFromState,
                dataKeys,
                startTime,
                endTime,
                { isMonthMode, isYearMode, isHourlyGapMode },
                activeFetchController.signal
            )
                .then(aggregatedData => {
                    if (!chart) return;
                    if (fetchToken !== refreshSeq) return; // có update mới hơn -> bỏ kết quả này
                    if (!aggregatedData) return;

                    const datasets = buildDatasetsFromAggregatedData(
                        aggregatedData,
                        storeName,
                        startTime,
                        endTime,
                        { isMonthMode, isYearMode, isHourlyGapMode, colorMap, labelMap }
                    );

                    updateChart(datasets, startTime, endTime, { isMonthMode, isYearMode });
                })
                .catch(err => {
                    if (err && err.name === 'AbortError') return;
                    if (!chart) return;
                    if (fetchToken !== refreshSeq) return;

                    // fallback subscription
                    const datasets = buildDatasetsFromSubscription(sub, startTime, endTime, { isMonthMode, isYearMode, isHourlyGapMode });
                    updateChart(datasets, startTime, endTime, { isMonthMode, isYearMode });
                })
                .finally(() => {
                    activeFetchController = null;
                });
        } else {
            // ✅ SINGLE DEVICE MODE: Use subscription data
            const datasets = buildDatasetsFromSubscription(sub, startTime, endTime, { isMonthMode, isYearMode, isHourlyGapMode });
            updateChart(datasets, startTime, endTime, { isMonthMode, isYearMode });
        }
    }

    // =========================
    // Helpers: Normalize timestamp
    // =========================
    let _normalizeFirstCall = true;
    function normalizeTimestamp(ms, opts) {
        const { isMonthMode, isYearMode, isHourlyGapMode } = opts || {};

        if (_normalizeFirstCall) {
            // console.log('[line_chart] 🔍 normalizeTimestamp first call - opts:', opts);
            _normalizeFirstCall = false;
        }

        const x = new Date(ms);
        let result;

        if (isYearMode) {
            result = new Date(x.getFullYear(), x.getMonth(), 1, 0, 0, 0, 0).getTime();
        } else if (isMonthMode) {
            result = new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0).getTime();
        } else if (isHourlyGapMode) {
            result = new Date(x.getFullYear(), x.getMonth(), x.getDate(), x.getHours(), 0, 0, 0).getTime();
        } else {
            result = new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0).getTime();
        }
        return result;
    }

    // =========================
    // Fetch telemetry for all devices and aggregate
    // =========================
    async function fetchAllDevicesTelemetry(entities, keys, startTime, endTime, opts, signal) {
        const aggregatedData = {}; // keyName -> { normalizedTimestamp -> sum }
        keys.forEach(key => { aggregatedData[key] = {}; });

        const fetchPromises = entities.map(async (entity) => {
            const deviceId = entity.id || entity;
            const keysStr = keys.join(',');

            const url = `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(keysStr)}&startTs=${startTime}&endTs=${endTime}&limit=10000&agg=NONE`;

            try {
                const jwtToken = localStorage.getItem('jwt_token') || localStorage.getItem('token') || '';
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(jwtToken ? { 'X-Authorization': 'Bearer ' + jwtToken } : {})
                    },
                    signal: signal
                });

                if (!response.ok) return;

                const data = await response.json();

                Object.keys(data).forEach(keyName => {
                    if (!aggregatedData[keyName]) aggregatedData[keyName] = {};
                    const points = data[keyName] || [];

                    points.forEach((point) => {
                        const ts = point.ts;
                        const normalizedTs = normalizeTimestamp(ts, opts);
                        const val = Number(point.value) || 0;

                        if (!aggregatedData[keyName][normalizedTs]) aggregatedData[keyName][normalizedTs] = 0;
                        aggregatedData[keyName][normalizedTs] += val;
                    });
                });

            } catch (error) {
                if (error && error.name === 'AbortError') return;
                // console.error('[line_chart] ❌ Error fetching telemetry for device:', deviceId, error);
            }
        });

        try {
            await Promise.all(fetchPromises);
        } catch (e) {
            if (e && e.name === 'AbortError') return null;
        }
        return aggregatedData;
    }

    // =========================
    // Build datasets from aggregated data
    // =========================
    function buildDatasetsFromAggregatedData(aggregatedData, storeName, startTime, endTime, opts) {
        const results = [];
        const { isMonthMode, isYearMode, isHourlyGapMode, colorMap, labelMap } = opts || {};
        const fallbackColors = ['#e74c3c', '#27ae60', '#2980b9', '#8e44ad', '#f39c12', '#16a085', '#c0392b', '#2c3e50'];

        let colorIndex = 0;

        Object.keys(aggregatedData).forEach(keyName => {
            const dataMap = aggregatedData[keyName] || {};
            let points = Object.keys(dataMap)
                .map(ts => ({ t: Number(ts), y: dataMap[ts] }))
                .sort((a, b) => a.t - b.t);

            if (isHourlyGapMode) points = fillGapsWithNull(points, startTime, endTime, 'hour');
            else if (isMonthMode) points = fillGapsWithNull(points, startTime, endTime, 'day');
            else if (isYearMode) points = fillGapsWithNull(points, startTime, endTime, 'month');

            points = stitchZeroBeforeData(points);

            const color = (colorMap && colorMap[keyName]) || fallbackColors[colorIndex % fallbackColors.length];
            const displayLabel = (labelMap && labelMap[keyName]) || keyName;
            colorIndex++;

            results.push({
                label: `${displayLabel}`,
                data: points,
                borderColor: color,
                backgroundColor: color,
                fill: false,
                borderWidth: 5,
                lineTension: 0.3,
                spanGaps: false,
                pointRadius: 2,
                pointHitRadius: 6,
                pointHoverRadius: 5,
                pointStyle: 'circle',
                showLine: true
            });
        });

        return results;
    }

    // =========================
    // Build datasets from subscription (single/all aggregate fallback)
    // =========================
    function buildDatasetsFromSubscription(subscription, startTime, endTime, opts) {
        const results = [];
        if (!subscription || !Array.isArray(subscription.data)) return results;

        const { isMonthMode, isYearMode, isHourlyGapMode } = opts || {};
        const fallbackColors = ['#e74c3c', '#27ae60', '#2980b9', '#8e44ad', '#f39c12', '#16a085', '#c0392b', '#2c3e50'];

        const { deviceMode, entitiesFromState, storeName } = getStateSafe();
        const isAllDevicesMode = deviceMode === 'ALL';

        const uniqueDevices = new Set();
        subscription.data.forEach((dk) => {
            const entityId = dk.datasource?.entityId || dk.dataKey?.datasource?.entityId;
            if (entityId) uniqueDevices.add(entityId);
        });

        const shouldAggregate = isAllDevicesMode && (uniqueDevices.size > 1 || (entitiesFromState || []).length > 1);

        if (shouldAggregate && subscription.data.length > 0) {
            const keyGroups = {};

            subscription.data.forEach((dk, idx) => {
                const key = dk.dataKey || {};
                const keyName = key.name || `Series ${idx + 1}`;
                const color = key.color || fallbackColors[idx % fallbackColors.length];

                if (!keyGroups[keyName]) {
                    keyGroups[keyName] = {
                        label: `${storeName} - Total ${key.label || keyName}`,
                        color: color,
                        dataMap: {}
                    };
                }

                (dk.data || [])
                    .filter(p => (!startTime || p[0] >= startTime) && (!endTime || p[0] <= endTime))
                    .forEach(p => {
                        const ts = Number(p[0]);
                        const normalizedTs = normalizeTimestamp(ts, { isMonthMode, isYearMode, isHourlyGapMode });
                        const val = Number(p[1]) || 0;

                        if (!keyGroups[keyName].dataMap[normalizedTs]) keyGroups[keyName].dataMap[normalizedTs] = 0;
                        keyGroups[keyName].dataMap[normalizedTs] += val;
                    });
            });

            Object.keys(keyGroups).forEach((keyName) => {
                const group = keyGroups[keyName];
                let points = Object.keys(group.dataMap)
                    .map(ts => ({ t: Number(ts), y: group.dataMap[ts] }))
                    .sort((a, b) => a.t - b.t);

                if (isHourlyGapMode) points = fillGapsWithNull(points, startTime, endTime, 'hour');
                else if (isMonthMode) points = fillGapsWithNull(points, startTime, endTime, 'day');
                else if (isYearMode) points = fillGapsWithNull(points, startTime, endTime, 'month');

                points = stitchZeroBeforeData(points);

                results.push({
                    label: group.label,
                    data: points,
                    borderColor: group.color,
                    backgroundColor: group.color,
                    fill: false,
                    borderWidth: 5,
                    lineTension: 0.3,
                    spanGaps: false,
                    pointRadius: 2,
                    pointHitRadius: 6,
                    pointHoverRadius: 5,
                    pointStyle: 'circle',
                    showLine: true
                });
            });

        } else {
            subscription.data.forEach((dk, idx) => {
                const key = dk.dataKey || {};
                const label = key.label || key.name || `Series ${idx + 1}`;
                const color = key.color || fallbackColors[idx % fallbackColors.length];

                let points = (dk.data || [])
                    .filter(p => (!startTime || p[0] >= startTime) && (!endTime || p[0] <= endTime))
                    .map(p => ({ t: Number(p[0]), y: p[1] }));

                if (isHourlyGapMode) points = fillGapsWithNull(points, startTime, endTime, 'hour');
                else if (isMonthMode) points = fillGapsWithNull(points, startTime, endTime, 'day');
                else if (isYearMode) points = fillGapsWithNull(points, startTime, endTime, 'month');

                points = stitchZeroBeforeData(points);

                results.push({
                    label,
                    data: points,
                    borderColor: color,
                    backgroundColor: color,
                    fill: false,
                    borderWidth: 5,
                    lineTension: 0.3,
                    spanGaps: false,
                    pointRadius: 2,
                    pointHitRadius: 6,
                    pointHoverRadius: 5,
                    pointStyle: 'circle',
                    showLine: true
                });
            });
        }

        return results;
    }

    // =========================
    // Fill gaps with null
    // mode: 'hour' | 'day' | 'month'
    // =========================
    function fillGapsWithNull(data, startTime, endTime, mode) {
        if (!Array.isArray(data) || data.length === 0 || !startTime || !endTime) return data || [];

        const map = {};
        const normKey = (ms) => {
            const x = new Date(ms);
            if (mode === 'hour') return new Date(x.getFullYear(), x.getMonth(), x.getDate(), x.getHours(), 0, 0, 0).getTime();
            if (mode === 'day') return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0).getTime();
            if (mode === 'month') return new Date(x.getFullYear(), x.getMonth(), 1, 0, 0, 0, 0).getTime();
            return ms;
        };

        data.forEach(p => {
            const ts = normKey(p.t);
            map[ts] = p.y;
        });

        const filled = [];

        var MAX_FILL_POINTS = 2000;
        if (mode === 'hour') {
            const sDate = new Date(startTime);
            const eDate = new Date(endTime);
            let current = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate(), sDate.getHours(), 0, 0, 0);
            const endTs = eDate.getTime();
            var totalHours = Math.floor((endTs - current.getTime()) / (60 * 60 * 1000)) + 1;
            if (totalHours > MAX_FILL_POINTS) return data;

            while (current.getTime() <= endTs) {
                const t = current.getTime();
                filled.push({ t, y: Object.prototype.hasOwnProperty.call(map, t) ? map[t] : null });
                current.setHours(current.getHours() + 1);
            }
            return filled;
        }

        if (mode === 'day') {
            const sDate = new Date(startTime);
            const eDate = new Date(endTime);
            let current = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate(), 0, 0, 0, 0);
            const endTs = eDate.getTime();
            var totalDays = Math.floor((endTs - current.getTime()) / (24 * 60 * 60 * 1000)) + 1;
            if (totalDays > MAX_FILL_POINTS) return data;

            while (current.getTime() <= endTs) {
                const t = current.getTime();
                filled.push({ t, y: Object.prototype.hasOwnProperty.call(map, t) ? map[t] : null });
                current.setDate(current.getDate() + 1);
            }
            return filled;
        }

        if (mode === 'month') {
            const sDate = new Date(startTime);
            const eDate = new Date(endTime);
            let current = new Date(sDate.getFullYear(), sDate.getMonth(), 1, 0, 0, 0, 0);
            const endTs = eDate.getTime();
            var totalMonths = (eDate.getFullYear() - current.getFullYear()) * 12 + (eDate.getMonth() - current.getMonth()) + 1;
            if (totalMonths > MAX_FILL_POINTS) return data;

            while (current.getTime() <= endTs) {
                const t = current.getTime();
                filled.push({ t, y: Object.prototype.hasOwnProperty.call(map, t) ? map[t] : null });
                current.setMonth(current.getMonth() + 1);
            }
            return filled;
        }

        return data;
    }

    // Insert y=0 before first non-null point after null gap
    function stitchZeroBeforeData(points) {
        if (!Array.isArray(points) || points.length === 0) return points || [];
        const out = [];
        for (let i = 0; i < points.length; i++) {
            const curr = points[i];
            const prev = i > 0 ? points[i - 1] : null;
            if (prev && prev.y == null && curr.y != null) {
                out.push({ t: prev.t, y: 0 });
            }
            out.push(curr);
        }
        return out;
    }

    // =========================
    // Time scale settings
    // =========================
    function applyTimeScaleForWindow(chart, startTime, endTime, opts) {
        const xAxis = chart.options.scales.xAxes[0];
        const { isMonthMode, isYearMode } = opts || {};
        let minMs = startTime ? Number(startTime) : undefined;
        let maxMs = endTime ? Number(endTime) : undefined;

        // Day mode -> display only 07:00–19:00
        if (isDayMode(self.ctx.defaultSubscription?.subscriptionTimewindow)) {
            const s = new Date(minMs);
            const e = new Date(minMs);
            const minDay = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 7, 0, 0, 0).getTime();
            const maxDay = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 19, 0, 0, 0).getTime();
            minMs = minDay;
            maxMs = maxDay;

            xAxis.time.unit = 'hour';
            xAxis.time.stepSize = 1;
            xAxis.time.displayFormats.hour = 'HH:mm';
            xAxis.time.tooltipFormat = 'HH:mm';
            xAxis.offset = false;
        }
        else if (isYearMode) {
            xAxis.time.unit = 'month';
            xAxis.time.stepSize = 1;
            xAxis.time.displayFormats.month = 'MMM';
            xAxis.offset = true;
        }
        else if (isMonthMode) {
            const s = new Date(minMs), e = new Date(maxMs);
            const minDay = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0).getTime();
            const maxDay = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59, 999).getTime();
            minMs = minDay; maxMs = maxDay;

            xAxis.time.unit = 'day';
            xAxis.time.stepSize = 1;
            xAxis.time.displayFormats.day = 'MMM DD';
            xAxis.time.tooltipFormat = 'YYYY-MM-DD';
            xAxis.offset = true;
        }
        else {
            xAxis.time.unit = 'hour';
            xAxis.time.stepSize = 1;
            xAxis.time.displayFormats.hour = 'HH:mm';
            xAxis.offset = false;
        }

        xAxis.ticks.min = minMs;
        xAxis.ticks.max = maxMs;
        xAxis.time.min = minMs;
        xAxis.time.max = maxMs;
    }

    function updateChart(datasets, startTime, endTime, opts) {
        if (!chart) return;

        const hiddenDatasetLabels = getHiddenDatasetLabels();
        currentTimeContext = {
            startTime: startTime,
            endTime: endTime,
            isMonthMode: !!(opts && opts.isMonthMode),
            isYearMode: !!(opts && opts.isYearMode),
            isDayMode: isDayMode(self.ctx.defaultSubscription?.subscriptionTimewindow)
        };

        decorateDatasetsForLayout(datasets);
        applyHiddenState(datasets, hiddenDatasetLabels);
        chart.data.datasets = datasets;
        applyResponsiveChartOptions(currentLayout);
        applyTimeScaleForWindow(chart, startTime, endTime, opts);
        var now = Date.now();
        var useFast = (now - lastRenderAt) < FAST_UPDATE_WINDOW_MS;
        lastRenderAt = now;
        chart.update(useFast ? 0 : undefined);
        syncEmptyState(datasets);
        renderLegend();
        syncSelectionDisplay();
    }

    // =========================
    // Day mode detection + full-day window
    // =========================
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

})();
