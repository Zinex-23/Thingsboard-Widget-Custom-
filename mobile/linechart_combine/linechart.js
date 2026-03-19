(function () {
    let chart = null;

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

    // =========================
    // Widget lifecycle
    // =========================
    self.onInit = function () {
        if (typeof moment !== 'undefined') {
            moment.locale('en');
        }

        const canvas = self.ctx.$container[0].querySelector('#chart');
        const ctx = canvas.getContext('2d');

        chart = new Chart(ctx, {
            type: 'line',
            data: { datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 800, easing: 'easeOutQuart' },
                legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 3 } },
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
                            const ti = items[0];
                            const ds = data.datasets[ti.datasetIndex];
                            const pt = ds && ds.data ? ds.data[ti.index] : null;
                            const ts = (pt && (pt.t || pt.x)) || ti.xLabel || ti.label;
                            const m = (typeof moment !== 'undefined') ? moment(Number(ts)) : null;
                            return m && m.isValid()
                                ? m.format('YYYY-MM-DD')
                                : (ti.label || ti.xLabel || '');
                        },
                        labelPointStyle: function () { return { PointStyle: 'true', rotation: 0 }; },
                        labelColor: function (tooltipItem, chart) {
                            const ds = chart.config.data.datasets[tooltipItem.datasetIndex];
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
                        ticks: { source: 'data' },
                        offset: false
                    }],
                    yAxes: [{ scaleLabel: { display: true, labelString: 'People Count' }, ticks: { beginAtZero: true } }]
                },
                pan: { enabled: true, mode: 'x' },
                zoom: { enabled: true, mode: 'x' },
                elements: { point: { radius: 2, hoverRadius: 5, hitRadius: 6 } }
            }
        });

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

    self.onResize = function () { if (chart) chart.resize(); };

    self.onDestroy = function () {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
        if (self.stateSubscription) {
            self.stateSubscription.unsubscribe();
            self.stateSubscription = null;
        }
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
        chart.data.datasets = datasets;
        applyTimeScaleForWindow(chart, startTime, endTime, opts);
        var now = Date.now();
        var useFast = (now - lastRenderAt) < FAST_UPDATE_WINDOW_MS;
        lastRenderAt = now;
        chart.update(useFast ? 0 : undefined);
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
