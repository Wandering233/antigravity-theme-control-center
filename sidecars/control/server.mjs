import { createServer } from "node:http";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { createReadStream, existsSync, watch } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 39223);
const CDP_PORT = Number(process.env.ANTIGRAVITY_CDP_PORT || 39888);
const CONFIG_DIR = join(os.homedir(), ".gemini/config/custom-ui");
const CONFIG_FILE = join(CONFIG_DIR, "theme-config.json");
const CSS_FILE = join(CONFIG_DIR, "custom.css");
const SIDECAR_INFO_FILE = join(CONFIG_DIR, "sidecar-info.json");

const DEFAULT_CONFIG = {
  injection: {
    enabled: false,
    lastError: null
  },
  floating: {
    enabled: true,
    material: "liquid",
    gutter: 10,
    radius: 16,
    frosted: {
      opacity: 0.65,
      blur: 24
    },
    liquid: {
      opacity: 0.35,
      refraction: 20,
      wave: 2,
      blur: 8,
      specular: 0.75,
      innerGlow: 0.25
    }
  },
  wallpaper: {
    enabled: true,
    type: "image",
    url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1920&q=80",
    blur: 0,
    brightness: 1,
    dim: 0.1,
    fit: "cover"
  }
};

async function getOrCreateConfig() {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true });
    }
    if (existsSync(CONFIG_FILE)) {
      const text = await readFile(CONFIG_FILE, "utf8");
      return JSON.parse(text);
    }
  } catch (e) {
    console.error("[Sidecar] Error reading config, fallback to default:", e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

async function saveConfig(cfg) {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true });
    }
    await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error("[Sidecar] Error saving config:", e);
  }
}

async function recordSidecarInfo() {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true });
    }
    await writeFile(SIDECAR_INFO_FILE, JSON.stringify({
      port: PORT,
      cdpPort: CDP_PORT,
      url: `http://127.0.0.1:${PORT}`,
      pid: process.pid,
      updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
  } catch (e) {
    console.error("[Sidecar] Error writing sidecar info:", e);
  }
}

// 端口自发现机制：读取 Chromium / Electron 自动写入的 DevToolsActivePort 文件
async function getDiscoveryPorts(defaultPort) {
  const ports = [];
  const candidateFiles = [
    process.env.AGY_BROWSER_ACTIVE_PORT_FILE,
    join(os.homedir(), ".config/Antigravity/DevToolsActivePort"),
    join(os.homedir(), ".config/Antigravity-Preview/DevToolsActivePort")
  ].filter(Boolean);

  for (const file of candidateFiles) {
    try {
      if (existsSync(file)) {
        const content = await readFile(file, "utf8");
        const lines = content.trim().split("\n");
        const p = parseInt(lines[0].trim(), 10);
        if (p > 0 && !ports.includes(p)) ports.push(p);
      }
    } catch (e) {}
  }
  [defaultPort, 39888, 9222].forEach(p => {
    if (p > 0 && !ports.includes(p)) ports.push(p);
  });
  return ports;
}

// ========================================================
// CDP (Chrome DevTools Protocol) 客户端引擎
// 直接直连宿主 Antigravity 窗口，零文件侵入，彻底免疫软件更新
// ========================================================
class CdpEngine {
  constructor(port = CDP_PORT) {
    this.port = port;
    this.ws = null;
    this.seq = 1;
    this.pending = new Map();
    this.connected = false;
    this.connecting = null;
  }

  async connect() {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) return true;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const candidatePorts = await getDiscoveryPorts(this.port);
        let mainTarget = null;
        let activePort = this.port;

        for (const p of candidatePorts) {
          try {
            const res = await fetch(`http://127.0.0.1:${p}/json`, { signal: AbortSignal.timeout(1200) });
            if (res.ok) {
              const targets = await res.json();
              mainTarget = targets.find(t => t.type === "page" && !t.url.includes("devtools://") && !t.url.includes("data:"));
              if (mainTarget && mainTarget.webSocketDebuggerUrl) {
                activePort = p;
                break;
              }
            }
          } catch (e) {}
        }

        if (!mainTarget || !mainTarget.webSocketDebuggerUrl) {
          this.connected = false;
          return false;
        }

        this.port = activePort;
        if (this.ws) {
          try { this.ws.close(); } catch (e) {}
        }

        this.ws = new WebSocket(mainTarget.webSocketDebuggerUrl);

        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 3000);
          this.ws.onopen = () => {
            clearTimeout(timer);
            this.connected = true;
            resolve();
          };
          this.ws.onerror = (err) => {
            clearTimeout(timer);
            reject(err);
          };
        });

        this.ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.id && this.pending.has(msg.id)) {
              const { resolve, reject } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch (e) {}
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.ws = null;
        };

        console.log(`[CDP] Successfully connected to Antigravity host target (Port ${this.port})`);
        return true;
      } catch (e) {
        this.connected = false;
        this.ws = null;
        return false;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  call(method, params = {}) {
    return new Promise(async (resolve, reject) => {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const ok = await this.connect();
        if (!ok) return reject(new Error(`无法连接到 Antigravity 宿主调试端口 (${this.port})，请确保启动时附带 --remote-debugging-port=${this.port}`));
      }
      const id = this.seq++;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async evaluate(fn, ...args) {
    const helperCode = `${hostDomApply.toString()};\n${hostDomEject.toString()};\n${hostDomGetState.toString()};\n`;
    const expr = `(() => {\n${helperCode}\nreturn (${fn.toString()})(${args.map(a => JSON.stringify(a)).join(",")});\n})()`;
    const res = await this.call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Runtime.evaluate error");
    }
    return res?.result?.value;
  }
}

const cdp = new CdpEngine(CDP_PORT);

// ========================================================
// 宿主 DOM 注入与操作函数（通过 CDP 在主窗口中执行）
// ========================================================
function hostDomInject(userCSS, config, sidecarPort) {
  const root = document.getElementById("root") || document.querySelector(".agy-shell") || document.body;
  if (!root) {
    throw new Error("宿主界面尚未就绪或 DOM 根节点不可访问");
  }

  let el = document.getElementById("ag-user-theme");
  if (!el) {
    el = document.createElement("style");
    el.id = "ag-user-theme";
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = userCSS;

  // Apply theme config
  hostDomApply(config, sidecarPort);
  return { success: true };
}

function hostDomApply(config, sidecarPort) {
  if (!config) return;
  const docStyle = document.documentElement.style;

  if (config.floating) {
    const f = config.floating;
    const material = f.material || "liquid";
    document.documentElement.setAttribute("data-ag-material", material);

    if (f.gutter !== undefined) {
      docStyle.setProperty("--ag-gutter", `${f.gutter}px`);
      docStyle.setProperty("--ag-gutter-half", `${f.gutter / 2}px`);
    }
    if (f.radius !== undefined) docStyle.setProperty("--ag-glass-radius", `${f.radius}px`);

    const frosted = f.frosted || {};
    const fOpacity = frosted.opacity !== undefined ? frosted.opacity : (f.opacity !== undefined ? f.opacity : 0.65);
    const fBlur = frosted.blur !== undefined ? frosted.blur : (f.blur !== undefined ? f.blur : 24);
    docStyle.setProperty("--ag-glass-opacity", `${fOpacity}`);
    docStyle.setProperty("--ag-glass-blur", `${fBlur}px`);

    const liquid = f.liquid || {};
    const lOpacity = liquid.opacity !== undefined ? liquid.opacity : 0.35;
    const lRefract = liquid.refraction !== undefined ? liquid.refraction : 20;
    const lWave = liquid.wave !== undefined ? liquid.wave : 2;
    const lBlur = liquid.blur !== undefined ? liquid.blur : 8;
    const lSpecular = liquid.specular !== undefined ? liquid.specular : 0.75;
    const lInnerGlow = liquid.innerGlow !== undefined ? liquid.innerGlow : 0.25;

    docStyle.setProperty("--ag-liquid-opacity", `${lOpacity}`);
    docStyle.setProperty("--ag-liquid-blur", `${lBlur}px`);
    docStyle.setProperty("--ag-liquid-specular", `${lSpecular}`);
    docStyle.setProperty("--ag-liquid-inner-glow", `${lInnerGlow}`);

    let svg = document.getElementById("ag-liquid-glass-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "ag-liquid-glass-svg";
      svg.setAttribute("style", "position: absolute; width: 0; height: 0; pointer-events: none; overflow: hidden;");
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = `
      <defs>
        <filter id="ag-filter-liquid-refract" x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox">
          <feTurbulence id="ag-filter-turb" type="fractalNoise" baseFrequency="0.015" numOctaves="3" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="3" result="smoothNoise" />
          <feDisplacementMap id="ag-filter-disp" in="SourceGraphic" in2="smoothNoise" scale="20" xChannelSelector="R" yChannelSelector="G" result="refracted" />
        </filter>
      </defs>`;
      (document.body || document.documentElement).appendChild(svg);
    }
    const disp = document.getElementById("ag-filter-disp");
    if (disp) disp.setAttribute("scale", `${lRefract}`);
    const turb = document.getElementById("ag-filter-turb");
    if (turb) turb.setAttribute("baseFrequency", `${(lWave * 0.0075).toFixed(4)}`);

    if (f.enabled === false) {
      document.body?.classList.add("ag-floating-disabled");
    } else {
      document.body?.classList.remove("ag-floating-disabled");
    }
  }

  if (config.wallpaper) {
    const wp = config.wallpaper;
    if (wp.blur !== undefined) docStyle.setProperty("--ag-wallpaper-blur", `${wp.blur}px`);
    if (wp.brightness !== undefined) docStyle.setProperty("--ag-wallpaper-brightness", `${wp.brightness}`);
    if (wp.dim !== undefined) docStyle.setProperty("--ag-wallpaper-dim", `${wp.dim}`);
    if (wp.fit !== undefined) docStyle.setProperty("--ag-wallpaper-fit", wp.fit);

    let container = document.getElementById("ag-wallpaper-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "ag-wallpaper-container";
      container.innerHTML = `
        <img id="ag-wallpaper-img" style="display:none;" />
        <video id="ag-wallpaper-video" autoplay loop muted playsinline style="display:none;"></video>
        <div id="ag-wallpaper-overlay"></div>
      `;
      const root = document.getElementById("root") || document.body;
      if (root && root.parentElement) {
        root.parentElement.insertBefore(container, root);
      } else if (document.body) {
        document.body.appendChild(container);
      }
    }

    const img = document.getElementById("ag-wallpaper-img");
    const video = document.getElementById("ag-wallpaper-video");

    function resolveMediaUrl(rawUrl) {
      if (!rawUrl) return "";
      if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
        return rawUrl;
      }
      let clean = rawUrl;
      if (clean.startsWith("file://")) clean = clean.slice(7);
      return `http://127.0.0.1:${sidecarPort}/api/media?file=${encodeURIComponent(clean)}`;
    }

    const resolvedUrl = resolveMediaUrl(wp.url);

    if (!wp.enabled || wp.type === "none" || !resolvedUrl) {
      if (img) img.style.display = "none";
      if (video) {
        video.style.display = "none";
        try { video.pause(); } catch (e) {}
      }
    } else if (wp.type === "video") {
      if (img) img.style.display = "none";
      if (video) {
        video.style.display = "block";
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.playsInline = true;
        if (video.src !== resolvedUrl) {
          video.src = resolvedUrl;
        }
        video.play().catch(() => {});
      }
    } else if (wp.type === "image") {
      if (video) {
        video.style.display = "none";
        try { video.pause(); } catch (e) {}
      }
      if (img) {
        img.style.display = "block";
        if (img.src !== resolvedUrl) {
          img.src = resolvedUrl;
        }
      }
    }
  }
}

function hostDomEject() {
  document.querySelectorAll("style[id^='ag-']").forEach(s => s.remove());

  const wp = document.getElementById("ag-wallpaper-container");
  if (wp) wp.remove();

  const svg = document.getElementById("ag-liquid-glass-svg");
  if (svg) svg.remove();

  const sub = document.getElementById("ag-subframe-radius");
  if (sub) sub.remove();

  document.documentElement.removeAttribute("data-ag-material");
  document.body?.classList.remove("ag-floating-disabled");

  const style = document.documentElement.style;
  const props = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (prop && prop.startsWith("--ag-")) props.push(prop);
  }
  props.forEach(p => style.removeProperty(p));
  style.removeProperty("--ag-wallpaper-fit");

  return { success: true };
}

function hostDomGetState() {
  const el = document.getElementById("ag-user-theme");
  const wp = document.getElementById("ag-wallpaper-container");
  const mat = document.documentElement.getAttribute("data-ag-material");
  const docStyle = document.documentElement.style;
  return {
    isInjected: !!el,
    hasWallpaper: !!wp,
    material: mat || "none",
    glassBlur: docStyle.getPropertyValue("--ag-glass-blur") || null,
    liquidBlur: docStyle.getPropertyValue("--ag-liquid-blur") || null
  };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg"
};

let debouncedSaveTimer = null;

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // API: Get status & CDP connectivity
  if (url.pathname === "/api/status" && req.method === "GET") {
    const cfg = await getOrCreateConfig();
    const cdpOk = await cdp.connect();
    let hostState = null;
    if (cdpOk) {
      try {
        hostState = await cdp.evaluate(hostDomGetState);
      } catch (e) {}
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      cdpConnected: cdpOk,
      cdpPort: cdp.port,
      isInjected: hostState ? hostState.isInjected : cfg.injection?.enabled || false,
      hostState,
      config: cfg
    }));
    return;
  }

  // API: Inject theme via CDP
  if (url.pathname === "/api/inject" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = body ? JSON.parse(body) : await getOrCreateConfig();
        const cfg = payload.config || payload;

        // Ensure custom.css exists
        let userCSS = "";
        if (existsSync(CSS_FILE)) {
          userCSS = await readFile(CSS_FILE, "utf8");
        }

        const cdpOk = await cdp.connect();
        if (!cdpOk) {
          throw new Error(`无法连接到 Antigravity 宿主调试端口 (${cdp.port})。请使用官方包装器启动或附带 --remote-debugging-port=${cdp.port}`);
        }

        await cdp.evaluate(hostDomInject, userCSS, cfg, PORT);

        cfg.injection = cfg.injection || {};
        cfg.injection.enabled = true;
        cfg.injection.lastError = null;
        await saveConfig(cfg);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, isInjected: true }));
      } catch (err) {
        console.error("[CDP Inject Error]:", err);
        try {
          if (cdp.connected) {
            await cdp.evaluate(hostDomEject);
          }
        } catch (e) {}

        try {
          const cfg = await getOrCreateConfig();
          cfg.injection = cfg.injection || {};
          cfg.injection.enabled = false;
          cfg.injection.lastError = err.message;
          await saveConfig(cfg);
        } catch (e) {}

        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: Eject theme via CDP
  if (url.pathname === "/api/eject" && req.method === "POST") {
    try {
      const cdpOk = await cdp.connect();
      if (cdpOk) {
        await cdp.evaluate(hostDomEject);
      }
      const cfg = await getOrCreateConfig();
      cfg.injection = cfg.injection || {};
      cfg.injection.enabled = false;
      cfg.injection.lastError = null;
      await saveConfig(cfg);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, isInjected: false }));
    } catch (err) {
      console.error("[CDP Eject Error]:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // API: Realtime theme change via CDP
  if (url.pathname === "/api/theme-change" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const cfg = payload.config || payload;

        cdp.evaluate(hostDomApply, cfg, PORT).catch(e => console.warn("[CDP Apply Warn]:", e.message));

        clearTimeout(debouncedSaveTimer);
        debouncedSaveTimer = setTimeout(() => {
          saveConfig(cfg).catch(e => console.error("Debounced save error:", e));
        }, 400);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Get current config
  if (url.pathname === "/api/config" && req.method === "GET") {
    const cfg = await getOrCreateConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cfg));
    return;
  }

  // API: Save config
  if (url.pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const cfg = JSON.parse(body);
        await saveConfig(cfg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Stream local video / image media file
  if (url.pathname === "/api/media" && req.method === "GET") {
    const filePath = url.searchParams.get("file");
    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Media not found");
      return;
    }

    try {
      const stats = await stat(filePath);
      const ext = extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        const chunksize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stats.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": mime
        });
        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stats.size,
          "Accept-Ranges": "bytes",
          "Content-Type": mime
        });
        createReadStream(filePath).pipe(res);
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Stream error: " + e.message);
    }
    return;
  }

  // Static files for Control Center UI
  let filePath = join(__dirname, url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(filePath)) {
    filePath = join(__dirname, "index.html");
  }

  try {
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "text/html; charset=utf-8";
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found: " + err.message);
  }
});

// 监听 custom.css 变动，热推送到宿主 DOM
if (existsSync(CSS_FILE)) {
  try {
    watch(CSS_FILE, async (event) => {
      if (event === "change") {
        try {
          const cfg = await getOrCreateConfig();
          if (cfg?.injection?.enabled) {
            const newCSS = await readFile(CSS_FILE, "utf8");
            await cdp.evaluate((css) => {
              const el = document.getElementById("ag-user-theme");
              if (el) el.textContent = css;
            }, newCSS);
            console.log("[Sidecar] Hot reloaded custom.css to host");
          }
        } catch (e) {}
      }
    });
  } catch (e) {}
}

// 定时自愈与自动重新连接（针对页面刷新 Ctrl+R 或新建窗口场景）
setInterval(async () => {
  try {
    const cfg = await getOrCreateConfig();
    if (cfg?.injection?.enabled) {
      const ok = await cdp.connect();
      if (ok) {
        const state = await cdp.evaluate(hostDomGetState);
        if (!state?.isInjected) {
          let userCSS = "";
          if (existsSync(CSS_FILE)) {
            userCSS = await readFile(CSS_FILE, "utf8");
          }
          await cdp.evaluate(hostDomInject, userCSS, cfg, PORT);
          console.log("[CDP] Re-injected theme into refreshed host window");
        }
      }
    }
  } catch (e) {}
}, 3000);

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[Theme Control Center] Sidecar running on http://127.0.0.1:${PORT}`);
  await recordSidecarInfo();
  const cfg = await getOrCreateConfig();

  // On sidecar boot: if injection was previously enabled, automatically reconnect & restore theme
  setTimeout(async () => {
    try {
      const cdpOk = await cdp.connect();
      if (cdpOk && cfg.injection && cfg.injection.enabled === true) {
        let userCSS = "";
        if (existsSync(CSS_FILE)) {
          userCSS = await readFile(CSS_FILE, "utf8");
        }
        await cdp.evaluate(hostDomInject, userCSS, cfg, PORT);
        console.log("[CDP] Automatically restored theme injection on startup");
      }
    } catch (e) {
      console.warn("[CDP] Startup auto-inject:", e.message);
    }
  }, 1000);
});

// 优雅停机与卸载清理：在插件被禁用、卸载或进程终止时，完整恢复宿主原生界面
async function cleanShutdown() {
  console.log("[Sidecar] Received shutdown signal, cleaning up host DOM...");
  try {
    const ok = await cdp.connect();
    if (ok) {
      await cdp.evaluate(hostDomEject);
      console.log("[Sidecar] Host DOM cleanly restored before shutdown");
    }
  } catch (e) {}
  process.exit(0);
}

process.on("SIGTERM", cleanShutdown);
process.on("SIGINT", cleanShutdown);

