self.onInit = function () {
  const ctx = self.ctx;

  /* ================== CONFIG ================== */

  const BASE_DOMAIN = "https://visiflow-cam.m-tech.com.vn";
  const PROFILE_KEY = "default";
  const IFRAME_SANDBOX = ""; // ví dụ: "allow-scripts allow-same-origin"

  /* ================== DOM ================== */

  const root = ctx.$container[0];
  const configCard = root.querySelector(".tb-config-merge");

  const iframeWrapper = document.createElement("div");
  Object.assign(iframeWrapper.style, {
    position: "absolute",
    inset: "0",
    background: "#000",
    display: "none",
    overflow: "hidden"
  });

  const iframe = document.createElement("iframe");
  Object.assign(iframe.style, {
    width: "100%",
    height: "100%",
    border: "0",
    display: "block"
  });

  if (IFRAME_SANDBOX) {
    iframe.setAttribute("sandbox", IFRAME_SANDBOX);
  }

  iframeWrapper.appendChild(iframe);
  root.appendChild(iframeWrapper);

  const liveBlocker = document.createElement("div");
  Object.assign(liveBlocker.style, {
    position: "absolute",
    inset: "0",
    background: "#ffffff",
    color: "#ED1C24",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "24px",
    zIndex: "2"
  });
  liveBlocker.innerHTML = `
    <div style="max-width:520px;line-height:1.55;background:#ffffff;border:2px solid #ED1C24;border-radius:12px;padding:20px;box-shadow:0 10px 28px rgba(237,28,36,0.18);">
      <div data-role="title" style="font-size:20px;font-weight:700;margin-bottom:8px;color:#ED1C24;"></div>
      <div data-role="desc" style="font-size:14px;color:#ED1C24;"></div>
    </div>
  `;
  iframeWrapper.appendChild(liveBlocker);

  /* ================== STATE ================== */

  let lastUrl = null;
  let lastMode = null; // 'edge' | 'tablet' | 'config'
  let currentDevice = null;
  let lastLang = "en";

  /* ================== HELPERS ================== */

  function showConfig() {
    if (lastMode === "config") return;
    lastMode = "config";
    iframeWrapper.style.display = "none";
    if (configCard) configCard.style.display = "flex";
  }

  function showIframe(url, mode) {
    if (!url) {
      showConfig();
      return;
    }

    if (lastUrl !== url) {
      iframe.src = url;
      lastUrl = url;
    }

    lastMode = mode;
    iframeWrapper.style.display = "block";
    if (configCard) configCard.style.display = "none";
  }

  function normalizeLabel(v) {
    if (v == null) return null;
    return String(v).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function getDevice() {
    const ds =
      ctx.datasources?.[0] ||
      ctx.defaultSubscription?.datasources?.[0];

    if (!ds) return null;

    return {
      id: ds.entityId?.id || ds.entityId,
      name: ds.entityName || ds.name,
      type: ds.entityType || "DEVICE"
    };
  }

  function detectLang() {
    const l =
      document.documentElement.lang ||
      localStorage.getItem("tbLang") ||
      navigator.language ||
      "en";
    return l.startsWith("ja") ? "ja" : "en";
  }

  function updateLiveBlocker(lang) {
    const title = liveBlocker.querySelector('[data-role="title"]');
    const desc = liveBlocker.querySelector('[data-role="desc"]');
    if (lang === "ja") {
      title.textContent = "設定";
      desc.textContent =
        "視聴するには設定ページで is_live_camera を true に変更してください。";
    } else {
      title.textContent = "Live stream is disabled";
      desc.textContent =
        "To watch, enable is_live_camera = true on the Configuration page.";
    }
  }

  function showLiveBlocker() {
    lastLang = detectLang();
    updateLiveBlocker(lastLang);
    lastMode = "tablet";
    iframeWrapper.style.display = "block";
    if (configCard) configCard.style.display = "none";
    liveBlocker.style.display = "flex";
  }

  function hideLiveBlocker() {
    liveBlocker.style.display = "none";
  }

  /* ================== EDGE ================== */

  function buildEdgeUrl(deviceName, cam) {
    if (!deviceName || !cam) return null;
    return `${BASE_DOMAIN}/${deviceName}/${cam}/`;
  }

  function readCurrentCam(dev, cb) {
    const url =
      `/api/plugins/telemetry/DEVICE/${dev.id}` +
      `/values/attributes/SERVER_SCOPE?keys=current_cam`;

    ctx.http.get(url).subscribe(
      res => {
        const arr = res.data || res;
        let cam = null;
        if (Array.isArray(arr)) {
          arr.forEach(it => {
            if (it.key === "current_cam") cam = it.value;
          });
        }
        cb(cam);
      },
      () => cb(null)
    );
  }

  /* ================== TABLET ================== */

  function handleTablet(dev) {
    const url =
      `/api/plugins/telemetry/DEVICE/${dev.id}` +
      `/values/attributes/SHARED_SCOPE?keys=statistic_config`;

    function buildTabletUrlFromRtsp(rtsp) {
      if (!rtsp) return null;

      const m = rtsp.match(/webrtc_(\d+)/);
      if (m) {
        return `${BASE_DOMAIN}/webrtc_${m[1]}`;
      }

      // Convert rtsp path to https on BASE_DOMAIN
      // Example: rtsp://117.2.120.27:44443/DHW7128GB25083023/ -> https://visiflow-cam.m-tech.com.vn/DHW7128GB25083023/
      let path = null;
      try {
        const u = new URL(rtsp);
        path = u.pathname || "/";
      } catch {
        const idx = rtsp.indexOf("://");
        if (idx !== -1) {
          const after = rtsp.slice(idx + 3);
          const slash = after.indexOf("/");
          if (slash !== -1) path = after.slice(slash);
        }
      }

      if (!path || path === "/") return null;
      if (!path.startsWith("/")) path = `/${path}`;
      if (!path.endsWith("/")) path += "/";
      return `${BASE_DOMAIN}${path}`;
    }

    ctx.http.get(url).subscribe(
      res => {
        const arr = res.data || res;
        let raw = null;
        if (Array.isArray(arr)) {
          arr.forEach(it => {
            if (it.key === "statistic_config") raw = it.value;
          });
        }
        if (!raw) {
          showConfig();
          return;
        }

        let cfg;
        try {
          cfg = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          showConfig();
          return;
        }

        const isLive = cfg.is_live_camera;
        if (isLive === false) {
          showLiveBlocker();
          return;
        }

        hideLiveBlocker();

        const rtsp = cfg.url_rtsp_device;
        if (!rtsp) {
          showConfig();
          return;
        }

        const url = buildTabletUrlFromRtsp(rtsp);
        if (!url) {
          showConfig();
          return;
        }

        showIframe(url, "tablet");
      },
      () => showConfig()
    );
  }

  /* ================== MAIN LOGIC ================== */

  function updateView() {
    const dev = getDevice();
    currentDevice = dev;

    if (!dev || dev.type !== "DEVICE") {
      showConfig();
      return;
    }

    const url =
      `/api/plugins/telemetry/DEVICE/${dev.id}` +
      `/values/attributes/SERVER_SCOPE?keys=deviceLabel`;

    ctx.http.get(url).subscribe(
      res => {
        const arr = res.data || res;
        let label = null;
        if (Array.isArray(arr)) {
          arr.forEach(it => {
            if (it.key === "deviceLabel") label = it.value;
          });
        }

        const norm = normalizeLabel(label);

        if (norm === "tablet-type" || norm === "tablet") {
          handleTablet(dev);
          return;
        }

        if (norm === "edge-type" || norm === "edge") {
          readCurrentCam(dev, cam => {
            const url = buildEdgeUrl(dev.name, cam);
            showIframe(url, "edge");
          });
          return;
        }

        showConfig();
      },
      () => showConfig()
    );
  }

  /* ================== POST MESSAGE ================== */

  function sendContext() {
    try {
      iframe.contentWindow.postMessage(
        {
          type: "TB_DEVICE_SELECTED",
          device: currentDevice,
          lang: detectLang(),
          profile: PROFILE_KEY
        },
        "*"
      );
    } catch {}
  }

  /* ================== 🔥 LISTEN CAM BUS (QUAN TRỌNG) ================== */

  (function listenCamBus() {
    try {
      const bus = (window.top || window).__TB_CAM_BUS__;
      if (!bus || !bus.on) return;

      bus.on(function (payload) {
        if (!payload || !payload.cam) return;
        if (!currentDevice || !currentDevice.name) return;

        // CHỈ ÁP DỤNG CHO EDGE
        if (lastMode !== "edge") return;

        const newUrl =
          `${BASE_DOMAIN}/${currentDevice.name}/${payload.cam}/`;

        if (lastUrl !== newUrl) {
          iframe.src = newUrl;
          lastUrl = newUrl;
        }
      });
    } catch (e) {}
  })();

  /* ================== LIFECYCLE ================== */

  self.onDataUpdated = updateView;
  self.onResize = function () {};
  self.onDestroy = function () {};

  iframe.addEventListener("load", function () {
    setTimeout(sendContext, 200);
  });

  /* ================== INIT ================== */

  let retry = 0;
  (function bootstrap() {
    updateView();
    sendContext();
    if (++retry < 8) setTimeout(bootstrap, 300);
  })();
};
