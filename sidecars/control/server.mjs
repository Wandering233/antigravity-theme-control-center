import { createServer } from "node:http";
import { readFile, writeFile, stat, mkdir, readdir, access, chmod } from "node:fs/promises";
import { constants as FS_CONSTANTS, createReadStream, existsSync, watch } from "node:fs";
import { join, dirname, extname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 39223);
const CDP_PORT = Number(process.env.ANTIGRAVITY_CDP_PORT || 39888);
const CONFIG_DIR = join(os.homedir(), ".gemini/config/custom-ui");
const CONFIG_FILE = join(CONFIG_DIR, "theme-config.json");
const CSS_FILE = join(CONFIG_DIR, "custom.css");
const DEFAULT_CSS_FILE = join(__dirname, "theme.default.css");
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
    darkDim: 0.35,
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
    enabled: false,
    type: "image",
    url: "",
    blur: 0,
    brightness: 1,
    dim: 0.1,
    fit: "cover"
  },
  launchPerf: {
    enabled: false,
    vulkan: false
  }
};

// 行级相似度：判断 custom.css 是不是随包样式的旧副本
function lineSimilarity(a, b) {
  const la = a.split("\n").map((v) => v.trim()).filter(Boolean);
  if (!la.length) return 1;
  const lb = new Set(b.split("\n").map((v) => v.trim()).filter(Boolean));
  let hit = 0;
  for (const line of la) if (lb.has(line)) hit++;
  return hit / la.length;
}

// 解析"实际生效"的样式表：随包基底 + 用户覆盖，并说明用的是哪一份
async function resolveEffectiveCSS() {
  let baseCSS = "";
  if (existsSync(DEFAULT_CSS_FILE)) {
    try {
      baseCSS = await readFile(DEFAULT_CSS_FILE, "utf8");
    } catch (e) {
      console.warn("[Sidecar] Error reading bundled theme.default.css:", e);
    }
  }

  let userCSS = "";
  const userExisted = existsSync(CSS_FILE);
  if (userExisted) {
    try {
      userCSS = await readFile(CSS_FILE, "utf8");
    } catch (e) {}
  } else if (baseCSS) {
    try {
      if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
      await writeFile(CSS_FILE, baseCSS, "utf8");
      console.log("[Sidecar] Auto-initialized custom.css from bundled template");
      userCSS = baseCSS;
    } catch (e) {}
  }

  const norm = (v) => (v || "").replace(/\r\n/g, "\n").trim();
  const nb = norm(baseCSS);
  const nu = norm(userCSS);

  let css = "", source = "none", mode = "none";

  if (!userCSS && !baseCSS) {
    css = ""; source = "none"; mode = "empty";
  } else if (!userCSS) {
    css = baseCSS; source = "theme.default.css (bundled)"; mode = "bundled";
  } else if (!baseCSS) {
    css = userCSS; source = "custom.css"; mode = "custom-only";
  } else if (nu === nb) {
    css = baseCSS; source = "theme.default.css (bundled)"; mode = "identical";
  } else if (nb.startsWith(nu)) {
    // custom.css 只是随包样式的旧副本（纯前缀 / CRLF 差异）→ 视为未自定义
    css = baseCSS; source = "theme.default.css (bundled)"; mode = "stale-copy";
    console.log("[Sidecar] custom.css 是随包样式的旧副本，改用新版内置样式");
  } else if (lineSimilarity(nu, nb) >= 0.9) {
    // 随包样式改了若干行（例如修正选择器）也会让"前缀"判断失效，
    // 用行级相似度兜住：仍认为是旧副本，避免把两份样式叠加注入
    css = baseCSS; source = "theme.default.css (bundled)"; mode = "stale-copy-similar";
    console.log("[Sidecar] custom.css 与随包样式高度重合（旧副本），改用新版内置样式");
  } else {
    css = baseCSS + "\n\n/* ===================== user custom.css overrides ===================== */\n" + userCSS;
    source = "theme.default.css + custom.css"; mode = "stacked";
  }

  return {
    css, source, mode,
    chars: css.length,
    customExists: userExisted,
    bundledExists: existsSync(DEFAULT_CSS_FILE),
    customChars: userCSS.length,
    bundledChars: baseCSS.length
  };
}

async function getEffectiveCSS() {
  const r = await resolveEffectiveCSS();
  return r.css;
}

// 当前生效样式表的来源说明（诊断用，与 getEffectiveCSS 结论保持一致）
async function effectiveCSSSource() {
  const r = await resolveEffectiveCSS();
  const sha = (v) => createHash("sha256").update(v || "", "utf8").digest("hex").slice(0, 12);
  return {
    source: r.source,
    mode: r.mode,
    chars: r.chars,
    customExists: r.customExists,
    bundledExists: r.bundledExists,
    customChars: r.customChars,
    bundledChars: r.bundledChars,
    diverged: r.mode === "stacked",
    customSha: r.customExists ? sha(await readFile(CSS_FILE, "utf8").catch(() => "")) : null,
    bundledSha: r.bundledExists ? sha(await readFile(DEFAULT_CSS_FILE, "utf8").catch(() => "")) : null
  };
}

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

// 局部传入的配置与已存配置深合并，避免一次只带 injection 的调用把用户设置整体覆盖掉
function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...(base && typeof base === "object" ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
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
              const pageTargets = targets.filter(t => t.type === "page" && t.webSocketDebuggerUrl && !t.url.includes("devtools://") && !t.url.includes("data:"));
              mainTarget =
                pageTargets.find(t => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(t.url || "") || (t.url || "").startsWith("file://") || (t.url || "").startsWith("vscode-file://")) ||
                pageTargets.find(t => /\bAntigravity\b/.test(t.title || "")) ||
                pageTargets[0];
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
    const helperCode = `${hostDomAudit.toString()};\n${hostDomProbe.toString()};\n${hostDomApply.toString()};\n${hostDomEject.toString()};\n${hostDomGetState.toString()};\n`;
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
// ========================================================
// 宿主 DOM 兼容性巡检
// 注入前必须先通过巡检；任何必需项缺失都直接终止注入，绝不做"尽力而为"的破坏性写入。
// 返回结构化结果，供 UI 展示与用户决策。
// ========================================================
function hostDomProbe() {
  const checks = [];
  const add = (id, label, ok, required, detail) => {
    checks.push({ id, label, ok: !!ok, required: !!required, detail: detail || "" });
  };

  // 1. 根节点
  let root = null;
  let rootHow = "";
  if (document.getElementById("root")) { root = document.getElementById("root"); rootHow = "#root"; }
  else if (document.querySelector(".agy-shell")) { root = document.querySelector(".agy-shell"); rootHow = ".agy-shell"; }
  else if (document.body) { root = document.body; rootHow = "body(fallback)"; }
  add("root", "应用根节点", root, true, root ? rootHow : "未找到 #root / .agy-shell / body");

  // 2. 可写样式容器
  const styleHost = document.head || document.documentElement;
  add("style-host", "样式挂载点 (head)", !!styleHost, true, styleHost ? styleHost.tagName.toLowerCase() : "不可用");

  // 3. 左侧边栏容器
  const leftSidebar =
    document.querySelector(".agy-shell > div.flex-1 > div.relative.flex > div.flex:first-child") ||
    document.querySelector("[data-testid='conversation-list-sidebar']") ||
    document.querySelector("[data-testid='sidebar']") ||
    document.querySelector("[data-testid='left-sidebar']") ||
    document.querySelector("div[style*='clamp(256px']");
  add("left-sidebar", "左侧边栏容器", leftSidebar, true,
    leftSidebar
      ? "已匹配"
      : "官方 DOM 结构可能已变更，或当前不在主对话界面（请回到主界面后点『重新校验』）");

  // 4. 对话滚动视口（仅影响滚动遮罩，不阻塞注入）
  const viewport = document.querySelector("[data-testid='autoscroll-viewport']");
  add("chat-viewport", "对话滚动视口", viewport, false,
    viewport ? "已匹配" : "缺失，仅滚动淡出遮罩失效");

  // 5. 输入栏 composer（仅影响输入栏材质，不阻塞注入）
  const composer =
    document.querySelector("[data-testid='composer']") ||
    document.querySelector("textarea") ||
    document.querySelector("[contenteditable='true']");
  add("composer", "输入栏 composer", composer, false,
    composer ? "已匹配" : "未匹配到输入栏");

  // 6. 右侧边栏 / Auxiliary Pane（可选）
  const aux =
    document.querySelector("[data-testid='sidecar-iframe-slot']") ||
    document.querySelector("[data-testid='aux-pane-sash']") ||
    document.querySelector("[data-testid='toggle-aux-sidebar']") ||
    document.querySelector("[data-testid='auxiliary-pane']") ||
    document.querySelector(".auxiliary-pane");
  add("aux-pane", "右侧边栏 (Auxiliary Pane)", aux, false,
    aux ? "已匹配" : "未匹配（可选，仅影响侧栏材质）");

  const failed = checks.filter((c) => c.required && !c.ok);

  return {
    ok: failed.length === 0,
    injected: !!document.getElementById("ag-user-theme"),
    wallpaperLayer: !!document.getElementById("ag-wallpaper-container"),
    checks,
    failed: failed.map((c) => c.label),
    hostTitle: (document.title || "").slice(0, 120),
    origin: (typeof location !== "undefined" ? location.origin : ""),
    ts: Date.now()
  };
}

// ========================================================
// 宿主结构诊断
// 目的：把"部分样式没生效"变成可回传的结构化数据 ——
// 哪个样式面存在、选择器命中几个、最终计算样式是否真的被改写。
// ========================================================
function hostDomAudit() {
  const surface = (id, label, selector, opts) => {
    const o = opts || {};
    let els = [];
    try { els = Array.from(document.querySelectorAll(selector)); } catch (e) {
      return { id, label, selector, count: 0, optional: !!o.optional, error: e.message };
    }
    const el = els[0];
    if (!el) return { id, label, selector, count: 0, optional: !!o.optional, present: false };
    const cs = getComputedStyle(el);
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    const marginTop = parseFloat(cs.marginTop) || 0;
    const width = parseFloat(cs.width) || 0;
    const backdrop = (cs.backdropFilter && cs.backdropFilter !== "none")
      ? cs.backdropFilter
      : (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none") ? cs.webkitBackdropFilter : "none";

    const readPaint = (pseudo) => {
      const style = getComputedStyle(el, pseudo);
      const bd = style.backdropFilter && style.backdropFilter !== "none"
        ? style.backdropFilter
        : style.webkitBackdropFilter && style.webkitBackdropFilter !== "none"
          ? style.webkitBackdropFilter
          : "none";
      return {
        content: String(style.content || "").slice(0, 40),
        backgroundColor: String(style.backgroundColor || "").slice(0, 160),
        backgroundImage: String(style.backgroundImage || "none").slice(0, 240),
        backdrop: String(bd).slice(0, 240),
        opacity: style.opacity,
        zIndex: style.zIndex,
        position: style.position,
        overflow: style.overflow
      };
    };
    const selfPaint = readPaint(null);
    const beforePaint = readPaint("::before");

    // 判定方式：
    //   card     —— 吃到圆角 / 外边距 / 自身或 ::before 模糊，任一即可认为卡片化生效
    //   position —— 规则用的是 top/left 偏移，检查 top 是否被改写
    const top = parseFloat(cs.top);
    let applied = true;
    if (o.card) {
      applied = radius > 0 || marginTop > 0 || backdrop !== "none" || beforePaint.backdrop !== "none";
    } else if (o.position) {
      applied = !Number.isNaN(top) && top > 0;
    }
    // 折叠状态（如右侧面板收起时 width=0）不算失败
    const collapsed = o.collapsible ? (width === 0) : false;
    const glassExpected = ["sidebar", "main-pane", "aux-pane"].includes(id);
    const glassFilter = [selfPaint.backdrop, beforePaint.backdrop]
      .some((v) => v !== "none" && /blur\(|ag-filter-liquid-refract/.test(v));

    return {
      id, label, selector,
      count: els.length,
      present: true,
      optional: !!o.optional,
      collapsed,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || "").slice(0, 140),
      radius, marginTop, width, backdrop, top,
      glassExpected,
      glassFilter,
      paint: { self: selfPaint, before: beforePaint },
      browserHoleAncestor: String(el.className || "").includes("browser-hole-ancestor"),
      applied,
      status: collapsed ? "collapsed" : (applied ? "applied" : "not-applied")
    };
  };

  const S = [
    surface("sidebar", "左侧边栏卡片", ".agy-shell > div.flex-1 > div.relative.flex > div.flex:first-child", { card: true }),
    surface("sheet", "主容器 .agy-sheet", ".agy-sheet", {}),
    surface("main-pane", "中央主面板", ".agy-sheet > div.relative.flex.w-full.h-full > div.flex:first-child", { card: true }),
    surface("aux-pane", "右侧辅助面板", ".agy-sheet > div.relative.flex.w-full.h-full > div:last-child", { card: true, collapsible: true, optional: true }),
    surface("composer", "输入栏", ".surface-composer", { card: true, optional: true }),
    surface("viewport", "对话滚动视口", "[data-testid='autoscroll-viewport']", { optional: true }),
    surface("settings", "设置弹窗", ".settings-modal-container", { optional: true, card: true }),
    surface("titlebar", "顶栏", "div:has(> .flex.items-center.pl-2 > [data-testid='app-icon-new-conversation-button'])", { position: true, optional: true })
  ];

  const outline = (el, depth, budget) => {
    if (!el || depth < 0 || budget.n <= 0) return null;
    budget.n--;
    const kids = [];
    for (const c of Array.from(el.children).slice(0, 6)) {
      if (budget.n <= 0) break;
      kids.push(outline(c, depth - 1, budget));
    }
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || "").slice(0, 100),
      testid: (el.getAttribute && el.getAttribute("data-testid")) || undefined,
      children: kids.filter(Boolean)
    };
  };

  const injectedEl = document.getElementById("ag-user-theme");
  const shell = document.querySelector(".agy-shell");
  const required = S.filter((s) => s.present && !s.collapsed);

  return {
    ts: Date.now(),
    view: (document.title || "").slice(0, 120),
    injected: !!injectedEl,
    injectedChars: injectedEl ? (injectedEl.textContent || "").length : 0,
    material: document.documentElement.getAttribute("data-ag-material") || "none",
    bodyClass: String(document.body.className || "").slice(0, 120),
    userAgent: navigator.userAgent,
    hasShell: !!shell,
    hasSheet: !!document.querySelector(".agy-sheet"),
    browserHole: {
      shell: String((shell && shell.className) || "").includes("browser-hole-ancestor"),
      sheet: String((document.querySelector(".agy-sheet") || {}).className || "").includes("browser-hole-ancestor"),
      count: document.querySelectorAll(".browser-hole-ancestor").length
    },
    floatingVars: (() => {
      const ds = getComputedStyle(document.documentElement);
      const v = (n) => ds.getPropertyValue(n).trim();
      return {
        material: document.documentElement.getAttribute("data-ag-material") || "none",
        gutter: v("--ag-gutter"),
        radius: v("--ag-glass-radius"),
        glassOpacity: v("--ag-glass-opacity"),
        glassBlur: v("--ag-glass-blur"),
        liquidOpacity: v("--ag-liquid-opacity"),
        liquidBlur: v("--ag-liquid-blur"),
        liquidRefract: v("--ag-liquid-refraction")
      };
    })(),
    paint: (() => {
      const bg = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          color: String(cs.backgroundColor || "").slice(0, 40),
          image: String(cs.backgroundImage || "").slice(0, 40)
        };
      };
      const wpEl = document.getElementById("ag-wallpaper-container");
      const wpImg = document.getElementById("ag-wallpaper-img");
      const wpVideo = document.getElementById("ag-wallpaper-video");
      return {
        html: bg(document.documentElement),
        body: bg(document.body),
        shell: bg(document.querySelector(".agy-shell")),
        wallpaper: {
          layer: !!wpEl,
          layerZ: wpEl ? getComputedStyle(wpEl).zIndex : null,
          imgSrc: wpImg ? String(wpImg.getAttribute("src") || "").slice(0, 80) : null,
          imgLoaded: wpImg ? (wpImg.complete && wpImg.naturalWidth > 0) : false,
          imgSize: wpImg && wpImg.naturalWidth ? wpImg.naturalWidth + "x" + wpImg.naturalHeight : null,
          videoSrc: wpVideo ? String(wpVideo.getAttribute("src") || "").slice(0, 120) : null,
          videoReadyState: wpVideo ? wpVideo.readyState : null,
          videoNetworkState: wpVideo ? wpVideo.networkState : null,
          videoPaused: wpVideo ? wpVideo.paused : null,
          videoSize: wpVideo && wpVideo.videoWidth ? wpVideo.videoWidth + "x" + wpVideo.videoHeight : null,
          videoError: wpVideo && wpVideo.error ? wpVideo.error.code : null
        }
      };
    })(),
    surfaces: S,
    summary: {
      total: required.length,
      applied: required.filter((s) => s.applied).length,
      collapsed: S.filter((s) => s.collapsed).map((s) => s.label),
      absent: S.filter((s) => !s.present && !s.optional).map((s) => s.label),
      optionalAbsent: S.filter((s) => !s.present && s.optional).map((s) => s.label),
      notApplied: required.filter((s) => !s.applied).map((s) => s.label),
      materialMissing: required.filter((s) => s.glassExpected && !s.glassFilter).map((s) => s.label)
    },
    outline: shell ? outline(shell, 2, { n: 45 }) : outline(document.body, 2, { n: 30 })
  };
}

function hostDomInject(userCSS, config, sidecarPort) {
  try {
    // ── 注入前闸门：兼容性巡检 ──
    const probe = hostDomProbe();
    if (!probe.ok) {
      throw new Error(
        "宿主 DOM 兼容性校验未通过，已终止注入：" + probe.failed.join("、") +
        "（官方界面可能已更新，请等待插件适配）"
      );
    }

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

    // Apply theme config（内部任何异常都会冒泡到下面的 catch）
    hostDomApply(config, sidecarPort);

    // ── 注入后校验：确认真的挂上了 ──
    const applied = document.getElementById("ag-user-theme");
    if (!applied) {
      throw new Error("样式表挂载校验失败：#ag-user-theme 未挂载");
    }
    const expectedLen = (userCSS || "").length;
    const actualLen = (applied.textContent || "").length;
    if (expectedLen > 0 && actualLen !== expectedLen) {
      throw new Error(`样式表挂载校验失败：期望 ${expectedLen} 字符，实际 ${actualLen} 字符`);
    }

    const wp = config && config.wallpaper;
    const wallpaperOn = !!(wp && wp.enabled && wp.type && wp.type !== "none");
    if (wallpaperOn) {
      const container = document.getElementById("ag-wallpaper-container");
      if (!container) {
        throw new Error("壁纸层校验失败：#ag-wallpaper-container 未创建");
      }
      const cs = getComputedStyle(container);
      if (cs.position !== "fixed" || cs.pointerEvents !== "none" || cs.zIndex !== "-99999") {
        throw new Error(
          `壁纸层校验失败：position=${cs.position} pointer-events=${cs.pointerEvents} z-index=${cs.zIndex}`
        );
      }
    }

    return {
      success: true,
      verified: {
        styleChars: actualLen,
        wallpaperLayer: wallpaperOn,
        injected: true
      },
      probe
    };
  } catch (err) {
    // 失败必须干净回滚，不留半套样式
    try { hostDomEject(); } catch (e) {}
    throw err;
  }
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
    const darkDim = f.darkDim !== undefined ? f.darkDim : 0.35;
    docStyle.setProperty("--ag-glass-opacity", `${fOpacity}`);
    docStyle.setProperty("--ag-glass-blur", `${fBlur}px`);
    docStyle.setProperty("--ag-dark-dim", `${darkDim}`);

    // 兼容社区常见毛玻璃主题变量规范 (如 AreSet01/antigravity-theme 等)
    docStyle.setProperty("--glass-blur", `${fBlur}px`);
    docStyle.setProperty("--glass-alpha", `${fOpacity}`);
    docStyle.setProperty("--glass-opacity", `${fOpacity}`);
    docStyle.setProperty("--glass-radius", `${f.radius}px`);
    docStyle.setProperty("--gutter", `${f.gutter}px`);
    docStyle.setProperty("--sidebar-blur", `${fBlur}px`);

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
    // 供 CSS 判断是否该让出官方自带底色（2.29.0 起 .agy-sheet 自带白底 + 径向渐变）
    const wpOn = !!(wp.enabled && wp.type && wp.type !== "none" && wp.url);
    document.documentElement.setAttribute("data-ag-wallpaper", wpOn ? "on" : "off");

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

    // 防御性内联样式：确保背景壁纸永远沉在最底层，绝不会阻挡或遮盖操作界面
    container.style.cssText = "position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: -99999 !important; pointer-events: none !important; overflow: hidden !important; background: transparent !important;";

    const img = document.getElementById("ag-wallpaper-img");
    const video = document.getElementById("ag-wallpaper-video");
    const overlay = document.getElementById("ag-wallpaper-overlay");

    const mediaBlur = Number(wp.blur || 0);
    const mediaBrightness = wp.brightness ?? 1;
    const mediaFilter = (mediaBlur > 0 || mediaBrightness !== 1)
      ? `blur(${mediaBlur}px) brightness(${mediaBrightness})`
      : "none";

    if (img) {
      img.style.position = "absolute";
      img.style.top = "0";
      img.style.left = "0";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = wp.fit || "cover";
      img.style.filter = mediaFilter;
      img.style.transform = "scale(1.05)";
    }

    if (video) {
      video.style.position = "absolute";
      video.style.top = "0";
      video.style.left = "0";
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = wp.fit || "cover";
      video.style.filter = mediaFilter;
      video.style.willChange = "transform";
      video.style.transform = mediaBlur > 0 ? "translateZ(0) scale(1.05)" : "translateZ(0)";
    }
    container.style.contain = "strict";

    if (overlay) {
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.pointerEvents = "none";
      overlay.style.background = `rgba(0, 0, 0, ${wp.dim ?? 0.1})`;
    }

    function resolveMediaUrl(rawUrl) {
      if (!rawUrl) return "";
      if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
        return rawUrl;
      }
      let clean = rawUrl;
      if (clean.startsWith("file://")) {
        clean = clean.slice(7);
        if (/^\/[A-Za-z]:[\\/]/.test(clean)) clean = clean.slice(1);
      }
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
        video.preload = "auto";
        video.disableRemotePlayback = true;
        if (video.dataset.agSourceUrl !== resolvedUrl) {
          video.dataset.agSourceUrl = resolvedUrl;
          if (video.dataset.agBlobUrl) {
            try { URL.revokeObjectURL(video.dataset.agBlobUrl); } catch (e) {}
            delete video.dataset.agBlobUrl;
          }
          video.src = resolvedUrl;
          if (resolvedUrl.includes("/api/media?")) {
            const targetUrl = resolvedUrl;
            fetch(targetUrl)
              .then((r) => {
                if (!r.ok) return null;
                const len = Number(r.headers.get("content-length") || 0);
                if (len > 512 * 1024 * 1024) return null;
                return r.blob();
              })
              .then((blob) => {
                if (!blob || video.dataset.agSourceUrl !== targetUrl) return;
                const blobUrl = URL.createObjectURL(blob);
                const t = video.currentTime || 0;
                video.dataset.agBlobUrl = blobUrl;
                video.src = blobUrl;
                if (t > 0.1) {
                  video.addEventListener("loadedmetadata", () => {
                    try { video.currentTime = t; } catch (e) {}
                  }, { once: true });
                }
                video.play().catch(() => {});
              })
              .catch(() => {});
          }
        }
        if (video.paused) {
          video.play().catch(() => {});
        }
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

  // ========================================================
  // 思考等级滑块（Codex / GPT 风格，注入在模型选择菜单的 View Usage 上方）
  // - 动态探测并缓存每个模型真实支持的思考等级（如 Neon/Hydrogen 支持 Extra High）
  // - 拦截并隐藏思考等级二级菜单弹出（不影响 Orchestrator / View Usage 二级菜单）
  // - 支持点击模型直接切换 + 平滑滑动/拖拽切换思考等级
  // ========================================================
  const enableThinkingSlider = config.features?.thinkingSlider !== false;
  const SLIDER_STYLE_ID = "ag-thinking-slider-style";
  if (!enableThinkingSlider) {
    if (window.__agThinkingSliderObserver) {
      try { window.__agThinkingSliderObserver.disconnect(); } catch (e) {}
      window.__agThinkingSliderObserver = null;
    }
    document.getElementById(SLIDER_STYLE_ID)?.remove();
    document.querySelectorAll("#ag-thinking-slider-box").forEach(el => el.remove());
    document.querySelectorAll("[data-ag-thinking-slider]").forEach(el => el.removeAttribute("data-ag-thinking-slider"));
    document.querySelectorAll("[data-ag-thinking-model]").forEach(el => el.removeAttribute("data-ag-thinking-model"));
    document.querySelectorAll("[data-ag-thinking-footer]").forEach(el => el.removeAttribute("data-ag-thinking-footer"));
    document.querySelectorAll("[data-ag-thinking-usage]").forEach(el => el.removeAttribute("data-ag-thinking-usage"));
    document.querySelectorAll("[data-ag-hidden-thinking-entry]").forEach(el => el.removeAttribute("data-ag-hidden-thinking-entry"));
  } else {
    // 总是刷新样式与控制器，确保热更新后立即生效
    if (window.__agThinkingSliderObserver) {
      try { window.__agThinkingSliderObserver.disconnect(); } catch (e) {}
      window.__agThinkingSliderObserver = null;
    }
    let sliderStyle = document.getElementById(SLIDER_STYLE_ID);
    if (!sliderStyle) {
      sliderStyle = document.createElement("style");
      sliderStyle.id = SLIDER_STYLE_ID;
      document.head.appendChild(sliderStyle);
    }
    sliderStyle.textContent = `
      /* 彻底去掉一级思考模型项右侧的小箭头 >（绝不隐藏任何二级/三级菜单，确保 Orchestrator 三级菜单完全正常） */
      [data-ag-thinking-model="1"] > span:last-child:has(svg):not(.ml-auto) {
        display: none !important;
      }
      /* 悬停当前选中模型时保留其勾选对号 ✓ */
      [data-ag-thinking-model="1"] > span.ml-auto:has(svg) {
        display: flex !important;
      }
      [data-ag-thinking-model="1"]:hover {
        background: rgba(128, 128, 128, 0.14) !important;
        border-radius: 6px;
      }
      /* 彻底隐藏原菜单中可能残留的独立“思考”入口节点，避免与 View Usage 重叠 */
      [data-ag-hidden-thinking-entry="1"] {
        display: none !important;
      }
      /* 保证底部容器与模型列表、思考强度区块、View Usage 垂直流式排布，绝不挤压重叠 */
      [data-ag-thinking-slider="1"] [role="separator"] {
        background: rgba(0, 0, 0, 0.06) !important;
        margin: 4px -4px 0 !important;
        flex-shrink: 0 !important;
      }
      body.theme-dark [data-ag-thinking-slider="1"] [role="separator"],
      html.dark [data-ag-thinking-slider="1"] [role="separator"],
      body:not(.theme-light) [data-ag-thinking-slider="1"] [role="separator"] {
        background: rgba(255, 255, 255, 0.08) !important;
      }
      [data-ag-thinking-footer="1"] {
        display: flex !important;
        flex-direction: column !important;
        flex-shrink: 0 !important;
        gap: 0 !important;
      }
      [data-ag-thinking-usage="1"] {
        margin-top: 4px !important;
        flex-shrink: 0 !important;
      }
      /* OpenAI Codex / ChatGPT Desktop 官方风格粗胶囊思考强度滑块 */
      #ag-thinking-slider-box {
        box-sizing: border-box;
        flex-shrink: 0;
        padding: 10px 12px 11px;
        margin: 0 -4px;
        border-top: none !important;
        border-bottom: 1px solid rgba(0, 0, 0, 0.06);
        position: relative;
        z-index: 2;
        user-select: none;
        -webkit-user-select: none;
        overflow: hidden;
        max-height: 140px;
        opacity: 1;
        transition: max-height 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    opacity 160ms ease,
                    padding-top 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    padding-bottom 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    border-color 160ms ease;
      }
      body.theme-dark #ag-thinking-slider-box,
      html.dark #ag-thinking-slider-box,
      body:not(.theme-light) #ag-thinking-slider-box {
        border-bottom-color: rgba(255, 255, 255, 0.08);
      }
      #ag-thinking-slider-box[data-collapsed="1"] {
        max-height: 0 !important;
        opacity: 0 !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        border-bottom-width: 0 !important;
        pointer-events: none !important;
      }
      /* 顶部三栏头部：左闪电图标 ⚡ / 中间双行（蓝色档位 + 模型名）/ 右重置图标 ↻ */
      .ag-ts-header {
        display: grid;
        grid-template-columns: 24px 1fr 24px;
        align-items: center;
        gap: 6px;
        margin-bottom: 10px;
      }
      .ag-ts-side-btn {
        width: 24px;
        height: 24px;
        border: none;
        padding: 0;
        margin: 0;
        border-radius: 999px;
        background: transparent;
        color: rgba(15, 23, 42, 0.48);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background 140ms ease, color 140ms ease, transform 140ms ease;
      }
      .ag-ts-side-btn:hover {
        background: rgba(0, 0, 0, 0.06);
        color: rgba(15, 23, 42, 0.82);
      }
      .ag-ts-side-btn:active {
        transform: scale(0.92);
      }
      body.theme-dark .ag-ts-side-btn,
      html.dark .ag-ts-side-btn,
      body:not(.theme-light) .ag-ts-side-btn {
        color: rgba(241, 245, 249, 0.48);
      }
      body.theme-dark .ag-ts-side-btn:hover,
      html.dark .ag-ts-side-btn:hover,
      body:not(.theme-light) .ag-ts-side-btn:hover {
        background: rgba(255, 255, 255, 0.09);
        color: rgba(248, 250, 252, 0.90);
      }
      .ag-ts-side-btn svg {
        width: 14px;
        height: 14px;
        display: block;
      }
      .ag-ts-center {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-width: 0;
        line-height: 1.2;
        gap: 2px;
      }
      .ag-ts-value {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: #0066ff;
        white-space: nowrap;
        transition: opacity 140ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      body.theme-dark .ag-ts-value,
      html.dark .ag-ts-value,
      body:not(.theme-light) .ag-ts-value {
        color: #4da3ff;
      }
      .ag-ts-value[data-bump="1"] {
        transform: scale(1.04);
      }
      .ag-ts-model {
        font-size: 10.5px;
        font-weight: 500;
        color: rgba(15, 23, 42, 0.50);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
      body.theme-dark .ag-ts-model,
      html.dark .ag-ts-model,
      body:not(.theme-light) .ag-ts-model {
        color: rgba(241, 245, 249, 0.52);
      }
      /* 粗胶囊轨道（26px 高）+ 蓝色实心同心包裹填充 + 内嵌 22px 纯白大圆钮 + 均匀档位圆点 */
      .ag-ts-slider-area {
        position: relative;
        height: 26px;
        display: flex;
        align-items: center;
        cursor: pointer;
        touch-action: none;
        margin: 0;
      }
      .ag-ts-rail {
        position: relative;
        width: 100%;
        height: 26px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.075);
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.06);
        overflow: hidden;
      }
      body.theme-dark .ag-ts-rail,
      html.dark .ag-ts-rail,
      body:not(.theme-light) .ag-ts-rail {
        background: rgba(255, 255, 255, 0.11);
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
      }
      .ag-ts-fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        min-width: 26px;
        border-radius: 999px;
        background: #0066ff;
        transition: width 240ms cubic-bezier(0.22, 1, 0.36, 1);
        pointer-events: none;
        z-index: 1;
      }
      body.theme-dark .ag-ts-fill,
      html.dark .ag-ts-fill,
      body:not(.theme-light) .ag-ts-fill {
        background: #0a84ff;
      }
      .ag-ts-slider-area[data-dragging="1"] .ag-ts-fill {
        transition: none;
      }
      .ag-ts-dot {
        position: absolute;
        top: 50%;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.24);
        pointer-events: none;
        z-index: 2;
        transition: background 160ms ease, opacity 160ms ease;
      }
      .ag-ts-dot[data-passed="1"] {
        background: rgba(255, 255, 255, 0.46);
      }
      body.theme-dark .ag-ts-dot,
      html.dark .ag-ts-dot,
      body:not(.theme-light) .ag-ts-dot {
        background: rgba(255, 255, 255, 0.28);
      }
      body.theme-dark .ag-ts-dot[data-passed="1"],
      html.dark .ag-ts-dot[data-passed="1"],
      body:not(.theme-light) .ag-ts-dot[data-passed="1"] {
        background: rgba(255, 255, 255, 0.50);
      }
      .ag-ts-thumb {
        position: absolute;
        top: 50%;
        width: 22px;
        height: 22px;
        box-sizing: border-box;
        border-radius: 50%;
        background: #ffffff;
        border: 0.5px solid rgba(0, 0, 0, 0.06);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.20), 0 0.5px 1px rgba(0, 0, 0, 0.12);
        transform: translate(-50%, -50%) scale(1);
        pointer-events: none;
        z-index: 3;
        will-change: left, transform;
        transition: left 240ms cubic-bezier(0.22, 1, 0.36, 1),
                    transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
                    box-shadow 160ms ease;
      }
      body.theme-dark .ag-ts-thumb,
      html.dark .ag-ts-thumb,
      body:not(.theme-light) .ag-ts-thumb {
        background: #ffffff;
        border: none;
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.38);
      }
      .ag-ts-slider-area:hover .ag-ts-thumb {
        transform: translate(-50%, -50%) scale(1.03);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.24);
      }
      .ag-ts-slider-area[data-dragging="1"] .ag-ts-thumb {
        transition: transform 120ms ease, box-shadow 120ms ease;
        transform: translate(-50%, -50%) scale(0.96);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.26);
      }
      /* 底部极简档位刻度文字：与内嵌圆点严格对齐，支持直点切换 */
      .ag-ts-labels {
        position: relative;
        height: 15px;
        margin: 6px 0 0;
        font-size: 10.5px;
        line-height: 15px;
      }
      .ag-ts-lbl {
        position: absolute;
        top: 0;
        transform: translateX(-50%);
        opacity: 0.44;
        font-weight: 500;
        color: rgba(15, 23, 42, 0.85);
        white-space: nowrap;
        cursor: pointer;
        transition: opacity 150ms ease, color 150ms ease;
      }
      body.theme-dark .ag-ts-lbl,
      html.dark .ag-ts-lbl,
      body:not(.theme-light) .ag-ts-lbl {
        color: rgba(248, 250, 252, 0.88);
      }
      .ag-ts-lbl[data-pos="first"] { transform: translateX(0); }
      .ag-ts-lbl[data-pos="last"] { transform: translateX(-100%); }
      .ag-ts-lbl:hover { opacity: 0.82; }
      .ag-ts-lbl[data-active="1"] {
        opacity: 1;
        font-weight: 600;
        color: #0066ff;
      }
      body.theme-dark .ag-ts-lbl[data-active="1"],
      html.dark .ag-ts-lbl[data-active="1"],
      body:not(.theme-light) .ag-ts-lbl[data-active="1"] {
        color: #4da3ff;
      }
    `;

    const EFFORT_ORDER = ["none", "off", "minimal", "instant", "light", "low", "standard", "medium", "extended", "high", "heavy", "xhigh", "extra high", "max", "pro"];
    const EFFORT_DISPLAY = {
      none: "None",
      off: "Off",
      minimal: "Minimal",
      instant: "Instant",
      light: "Light",
      low: "Low",
      standard: "Standard",
      medium: "Medium",
      extended: "Extended",
      high: "High",
      heavy: "Heavy",
      xhigh: "Extra High",
      "extra high": "Extra High",
      max: "Max",
      pro: "Pro",
    };

    const parseOptionLabel = (label) => {
      const m = String(label || "").trim().match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (!m) return { base: String(label || "").trim(), effortKey: null, effortDisplay: null };
      const rawEff = m[2].trim().toLowerCase().replace(/\s+/g, " ");
      if (!EFFORT_ORDER.includes(rawEff)) {
        return { base: String(label || "").trim(), effortKey: null, effortDisplay: null };
      }
      return { base: m[1].trim(), effortKey: rawEff, effortDisplay: EFFORT_DISPLAY[rawEff] || m[2].trim() };
    };

    // 直接从 Antigravity 原生 React Fiber 读取 selectedModel / setSelectedModel / modelOptions（0ms 即时原生切换）
    // 多标签页场景下优先取当前可见的 model-selector-trigger，避免读到后台隐藏会话的模型
    const getModelController = () => {
      const trigs = Array.from(document.querySelectorAll("[data-testid='model-selector-trigger']"));
      const trig = trigs.find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) || trigs[0];
      if (!trig) return null;
      const fiberKey = Object.keys(trig).find(k => k.startsWith("__reactFiber$"));
      if (!fiberKey) return null;
      let f = trig[fiberKey];
      for (let i = 0; i < 32 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        if (p && typeof p.setSelectedModel === "function" && Array.isArray(p.modelOptions)) {
          return p;
        }
      }
      return null;
    };

    const getEffortGroupForBase = (ctrl, baseName) => {
      if (!ctrl || !baseName) return [];
      const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const target = norm(baseName);
      const list = [];
      for (const opt of ctrl.modelOptions) {
        if (opt.disabled) continue;
        const parsed = parseOptionLabel(opt.label);
        if (!parsed.effortKey) continue;
        if (norm(parsed.base) === target) {
          list.push({
            opt,
            effortKey: parsed.effortKey,
            display: parsed.effortDisplay,
            order: EFFORT_ORDER.indexOf(parsed.effortKey),
          });
        }
      }
      list.sort((a, b) => a.order - b.order);
      return list;
    };

    const getDirectModelItems = (menu) => {
      return Array.from(menu.querySelectorAll("[role='menuitem']")).filter(el => el.closest("[role='menu']") === menu);
    };

    const isThinkingModelItem = (el) => {
      if (!el || el.getAttribute("aria-haspopup") !== "menu") return false;
      const tid = el.getAttribute("data-testid") || "";
      if (tid === "model-selector-orchestrator") return false;
      const txt = (el.textContent || "").trim();
      if (/View Usage|查看用量/i.test(txt)) return false;
      // 只匹配包含 [data-model-base] 的一级思考模型项，绝不误伤 Orchestrator 或其他菜单
      return !!el.querySelector("[data-model-base]");
    };

    const selectNativeModelByBase = (baseName, preferredEffortKey) => {
      const ctrl = getModelController();
      if (!ctrl) return false;
      const group = getEffortGroupForBase(ctrl, baseName);
      if (!group.length) return false;
      const match = (preferredEffortKey && group.find(g => g.effortKey === preferredEffortKey))
        || group.find(g => g.effortKey === "medium")
        || group[0];
      if (match) {
        ctrl.setSelectedModel(match.opt);
        return true;
      }
      return false;
    };

    const wireModelItemGuards = (menu) => {
      const items = getDirectModelItems(menu);
      for (const it of items) {
        if (!isThinkingModelItem(it)) continue;
        it.setAttribute("data-ag-thinking-model", "1");
        if (it.dataset.agThinkingWired === "1") continue;
        it.dataset.agThinkingWired = "1";

        // 仅阻止一级思考模型项悬停弹出二级菜单（Orchestrator 二/三级菜单与 View Usage 完全不受影响）
        const blockHover = (e) => {
          e.stopImmediatePropagation();
        };
        it.addEventListener("pointerenter", blockHover, true);
        it.addEventListener("pointerover", blockHover, true);
        it.addEventListener("pointermove", blockHover, true);
        it.addEventListener("mouseenter", blockHover, true);
        it.addEventListener("mouseover", blockHover, true);

        // 点击一级模型项直接调用原生 setSelectedModel 即时切换，并同步更新滑块
        it.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const ctrl = getModelController();
          const curParsed = parseOptionLabel(ctrl?.selectedModel?.label);
          const base = it.querySelector("[data-model-base]")?.getAttribute("data-model-base");
          if (base) {
            selectNativeModelByBase(base, curParsed.effortKey || "medium");
            const existingBox = menu.querySelector("#ag-thinking-slider-box");
            if (existingBox && typeof existingBox.__agSyncSlider === "function") {
              requestAnimationFrame(() => existingBox.__agSyncSlider());
            }
          }
        }, true);
      }
    };

    // 隐藏原菜单底部可能残留的独立“思考”/“Thinking”入口节点，避免与 View Usage 重叠
    const hideResidualThinkingEntries = (menu, usageItem) => {
      const candidates = Array.from(menu.querySelectorAll("[role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio']"));
      for (const el of candidates) {
        if (el === usageItem) continue;
        if (el.closest("#ag-thinking-slider-box")) continue;
        if (el.getAttribute("data-testid") === "model-selector-orchestrator") continue;
        if (el.querySelector("[data-model-base]")) continue;
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^(思考|思考等级|思考强度|Thinking|Thinking Level|Reasoning|Reasoning Effort)(\s|$)/i.test(txt)) {
          el.setAttribute("data-ag-hidden-thinking-entry", "1");
        }
      }
    };

    const injectIntoModelMenu = (menu) => {
      if (!menu || menu.hasAttribute("data-nested")) return;
      const items = getDirectModelItems(menu);
      const usageItem = items.find(el => /View Usage|查看用量/i.test(el.textContent || ""));
      if (!usageItem) return;

      menu.setAttribute("data-ag-thinking-slider", "1");
      usageItem.setAttribute("data-ag-thinking-usage", "1");
      if (usageItem.parentElement) {
        usageItem.parentElement.setAttribute("data-ag-thinking-footer", "1");
      }
      hideResidualThinkingEntries(menu, usageItem);
      wireModelItemGuards(menu);

      const existing = menu.querySelector("#ag-thinking-slider-box");
      if (existing) {
        if (typeof existing.__agSyncSlider === "function") existing.__agSyncSlider();
        return;
      }

      const box = document.createElement("div");
      box.id = "ag-thinking-slider-box";
      box.addEventListener("pointerdown", e => e.stopPropagation());
      box.addEventListener("click", e => e.stopPropagation());

      const header = document.createElement("div");
      header.className = "ag-ts-header";

      // 左侧闪电图标 ⚡：点击快速切换到最低思考强度（最快响应）
      const fastBtn = document.createElement("button");
      fastBtn.type = "button";
      fastBtn.className = "ag-ts-side-btn";
      fastBtn.title = "最快响应（最低档）";
      fastBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 10-12h-7l0-8Z"/></svg>`;

      // 中间双行居中：上方蓝色当前思考档位，下方模型名
      const centerCol = document.createElement("div");
      centerCol.className = "ag-ts-center";
      const valEl = document.createElement("span");
      valEl.className = "ag-ts-value";
      const modelEl = document.createElement("span");
      modelEl.className = "ag-ts-model";
      centerCol.appendChild(valEl);
      centerCol.appendChild(modelEl);

      // 右侧顺时针重置图标 ↻：点击一键重置回默认档位（Medium）
      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "ag-ts-side-btn";
      resetBtn.title = "重置为默认强度";
      resetBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

      header.appendChild(fastBtn);
      header.appendChild(centerCol);
      header.appendChild(resetBtn);
      box.appendChild(header);

      const bodySlot = document.createElement("div");
      box.appendChild(bodySlot);

      let lastRenderedKey = "";
      let activeCommit = null;
      let activeDefaultIdx = 1;

      fastBtn.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); });
      fastBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof activeCommit === "function") activeCommit(0);
      });
      resetBtn.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); });
      resetBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof activeCommit === "function") activeCommit(activeDefaultIdx);
      });

      const renderSlider = (itemsGroup, activeEffortKey, baseName) => {
        if (!itemsGroup || itemsGroup.length <= 1) {
          box.dataset.collapsed = "1";
          box.setAttribute("aria-hidden", "true");
          activeCommit = null;
          lastRenderedKey = `collapsed:${baseName || ""}`;
          return;
        }

        const key = `${baseName}|${itemsGroup.map(g => g.effortKey).join(",")}|${activeEffortKey || ""}`;
        box.dataset.collapsed = "0";
        box.removeAttribute("aria-hidden");
        if (key === lastRenderedKey && bodySlot.childElementCount > 0) return;
        lastRenderedKey = key;

        bodySlot.innerHTML = "";

        let curIdx = itemsGroup.findIndex(g => g.effortKey === activeEffortKey);
        const medIdx = itemsGroup.findIndex(g => g.effortKey === "medium");
        activeDefaultIdx = medIdx >= 0 ? medIdx : Math.min(1, itemsGroup.length - 1);
        if (curIdx < 0) curIdx = activeDefaultIdx;
        valEl.textContent = itemsGroup[curIdx].display;
        modelEl.textContent = baseName || "";

        const area = document.createElement("div");
        area.className = "ag-ts-slider-area";

        const rail = document.createElement("div");
        rail.className = "ag-ts-rail";
        const fill = document.createElement("div");
        fill.className = "ag-ts-fill";
        rail.appendChild(fill);

        const maxIdx = Math.max(1, itemsGroup.length - 1);
        const dots = itemsGroup.map((_, i) => {
          const dot = document.createElement("div");
          dot.className = "ag-ts-dot";
          const ratio = i / maxIdx;
          dot.style.left = `calc(13px + (100% - 26px) * ${ratio})`;
          rail.appendChild(dot);
          return dot;
        });

        const thumb = document.createElement("div");
        thumb.className = "ag-ts-thumb";
        rail.appendChild(thumb);
        area.appendChild(rail);

        const commitIndex = (idx) => {
          curIdx = idx;
          setVisualAtRatio(idx / maxIdx, idx, true);
          const freshCtrl = getModelController();
          const chosen = itemsGroup[idx];
          if (freshCtrl && chosen?.opt) {
            lastRenderedKey = `${baseName}|${itemsGroup.map(g => g.effortKey).join(",")}|${chosen.effortKey}`;
            // 原生即时切换，0ms 生效
            freshCtrl.setSelectedModel(chosen.opt);
          }
        };
        activeCommit = commitIndex;

        const labelsWrap = document.createElement("div");
        labelsWrap.className = "ag-ts-labels";
        const lbls = itemsGroup.map((g, i) => {
          const lbl = document.createElement("span");
          lbl.className = "ag-ts-lbl";
          lbl.textContent = g.display;
          lbl.title = g.opt.label;
          if (i === 0) {
            lbl.style.left = "4px";
            lbl.dataset.pos = "first";
          } else if (i === itemsGroup.length - 1) {
            lbl.style.left = "calc(100% - 4px)";
            lbl.dataset.pos = "last";
          } else {
            const ratio = i / maxIdx;
            lbl.style.left = `calc(13px + (100% - 26px) * ${ratio})`;
          }
          lbl.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          lbl.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            commitIndex(i);
          });
          labelsWrap.appendChild(lbl);
          return lbl;
        });

        const setVisualAtRatio = (ratio, nearestIdx, animate = true) => {
          const r = Math.max(0, Math.min(1, ratio));
          if (!animate) {
            fill.style.transition = "none";
            thumb.style.transition = "none";
          }
          // 同心胶囊算法：26px 轨道高度、22px 白色圆钮，蓝条在任意位置都以 2px 均匀包裹圆钮
          fill.style.width = `calc(26px + (100% - 26px) * ${r})`;
          thumb.style.left = `calc(13px + (100% - 26px) * ${r})`;
          if (!animate) {
            thumb.getBoundingClientRect();
            fill.style.transition = "";
            thumb.style.transition = "";
          }
          dots.forEach((d, i) => { d.dataset.passed = (i / maxIdx) <= r + 0.005 ? "1" : "0"; });
          lbls.forEach((l, i) => { l.dataset.active = i === nearestIdx ? "1" : "0"; });
          const disp = itemsGroup[nearestIdx]?.display || "";
          if (valEl.textContent !== disp) {
            valEl.textContent = disp;
            valEl.dataset.bump = "1";
            setTimeout(() => { valEl.dataset.bump = "0"; }, 180);
          }
        };

        setVisualAtRatio(curIdx / maxIdx, curIdx, false);

        const ratioFromClientX = (clientX) => {
          const rect = rail.getBoundingClientRect();
          const usable = Math.max(1, rect.width - 26);
          return Math.max(0, Math.min(1, (clientX - (rect.left + 13)) / usable));
        };

        let dragging = false;

        area.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          dragging = true;
          area.dataset.dragging = "1";
          try { area.setPointerCapture(e.pointerId); } catch {}
          const r = ratioFromClientX(e.clientX);
          setVisualAtRatio(r, Math.round(r * maxIdx), false);
        });

        area.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          e.stopPropagation();
          const r = ratioFromClientX(e.clientX);
          setVisualAtRatio(r, Math.round(r * maxIdx), false);
        });

        const finishDrag = (e) => {
          if (!dragging) return;
          dragging = false;
          area.dataset.dragging = "0";
          try { area.releasePointerCapture(e.pointerId); } catch {}
          const r = ratioFromClientX(e.clientX);
          const chosenIdx = Math.round(r * maxIdx);
          commitIndex(chosenIdx);
        };

        area.addEventListener("pointerup", finishDrag);
        area.addEventListener("pointercancel", () => {
          dragging = false;
          area.dataset.dragging = "0";
          setVisualAtRatio(curIdx / maxIdx, curIdx, true);
        });

        bodySlot.appendChild(area);
        bodySlot.appendChild(labelsWrap);
      };

      const syncSlider = () => {
        const freshCtrl = getModelController();
        const curParsed = parseOptionLabel(freshCtrl?.selectedModel?.label);
        const group = getEffortGroupForBase(freshCtrl, curParsed.base);
        renderSlider(group, curParsed.effortKey, curParsed.base);
      };
      box.__agSyncSlider = syncSlider;
      syncSlider();

      const insertBeforeEl = usageItem.previousElementSibling && usageItem.previousElementSibling.getAttribute("role") === "separator"
        ? usageItem.previousElementSibling
        : usageItem;
      insertBeforeEl.parentElement.insertBefore(box, insertBeforeEl);
    };

    const obs = new MutationObserver(() => {
      document.querySelectorAll("[role='menu']").forEach(injectIntoModelMenu);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__agThinkingSliderObserver = obs;
    document.querySelectorAll("[role='menu']").forEach(injectIntoModelMenu);
  }
}

function hostDomEject() {
  document.querySelectorAll("style[id^='ag-']").forEach(s => s.remove());
  if (window.__agThinkingSliderObserver) {
    try { window.__agThinkingSliderObserver.disconnect(); } catch (e) {}
    window.__agThinkingSliderObserver = null;
  }
  document.querySelectorAll("#ag-thinking-slider-box").forEach(el => el.remove());
  document.querySelectorAll("[data-ag-thinking-slider]").forEach(el => el.removeAttribute("data-ag-thinking-slider"));
  document.querySelectorAll("[data-ag-thinking-model]").forEach(el => el.removeAttribute("data-ag-thinking-model"));
  document.querySelectorAll("[data-ag-thinking-footer]").forEach(el => el.removeAttribute("data-ag-thinking-footer"));
  document.querySelectorAll("[data-ag-thinking-usage]").forEach(el => el.removeAttribute("data-ag-thinking-usage"));
  document.querySelectorAll("[data-ag-hidden-thinking-entry]").forEach(el => el.removeAttribute("data-ag-hidden-thinking-entry"));

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
  const isDark = document.body.classList.contains("theme-dark") ||
    document.documentElement.classList.contains("dark") ||
    !document.body.classList.contains("theme-light");
  return {
    isInjected: !!el,
    hasWallpaper: !!wp,
    material: mat || "none",
    theme: isDark ? "dark" : "light",
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
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg"
};

let debouncedSaveTimer = null;

// ========================================================
// 引擎启动性能参数管理（需重启 Antigravity 生效，独立开关控制）
// ========================================================
const WRAPPER_PATH = join(os.homedir(), ".local/bin/antigravity");
const WRAPPER_BACKUP_PATH = join(CONFIG_DIR, "antigravity.wrapper.bak");
const HOOK_SCRIPT_SRC = join(__dirname, "wcv-radius-hook.cjs");
const HOOK_SCRIPT_DEST = join(CONFIG_DIR, "wcv-radius-hook.cjs");

async function ensureHookScriptCopied() {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
  if (existsSync(HOOK_SCRIPT_SRC)) {
    const content = await readFile(HOOK_SCRIPT_SRC, "utf8");
    await writeFile(HOOK_SCRIPT_DEST, content, "utf8");
  }
}

function computeRecommendedLaunchPerf() {
  const cpuThreads = Math.max(1, (os.cpus() || []).length);
  const totalMemGB = Math.max(1, Math.round(os.totalmem() / 1073741824));
  // 按逻辑核心数一半动态分配光栅线程，范围限制在 2~8，避免低配机过载
  const rasterThreads = Math.min(8, Math.max(2, Math.floor(cpuThreads / 2)));
  // 按物理内存分档分配 V8 堆上限，低内存机器保守控制避免 OOM
  const maxOldSpaceMB = totalMemGB >= 32
    ? 12288
    : (totalMemGB >= 16 ? 8192 : (totalMemGB >= 12 ? 6144 : (totalMemGB >= 8 ? 4096 : 2048)));
  return { cpuThreads, totalMemGB, rasterThreads, maxOldSpaceMB };
}

function runPowerShellJson(psScript) {
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (e) {
        reject(new Error(`PowerShell JSON 解析失败: ${e.message}`));
      }
    });
  });
}

async function detectRunningHostFlags() {
  const active = { detected: false, rasterThreads: null, maxOldSpaceMB: null, vulkan: false, graphite: false, browserRadiusHook: false, raw: "" };
  if (process.platform === "win32") {
    try {
      const data = await runPowerShellJson(`
$ErrorActionPreference = 'SilentlyContinue'
$proc = Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe'" | Where-Object {
  $_.CommandLine -and ($_.CommandLine -notmatch '--type=') -and ($_.CommandLine -notmatch 'register_loader\\.js')
} | Select-Object -First 1
[PSCustomObject]@{ cmd = if ($proc) { $proc.CommandLine } else { "" } } | ConvertTo-Json -Compress
`);
      const raw = String(data?.cmd || "").trim();
      if (raw) {
        active.detected = true;
        active.raw = raw;
        const mRaster = raw.match(/--num-raster-threads=(\d+)/);
        if (mRaster) active.rasterThreads = Number(mRaster[1]);
        const mHeap = raw.match(/--max-old-space-size=(\d+)/);
        if (mHeap) active.maxOldSpaceMB = Number(mHeap[1]);
        active.vulkan = /--enable-features=[^\s]*Vulkan/.test(raw) || /--use-angle=d3d11/.test(raw);
        active.graphite = /--enable-skia-graphite/.test(raw) || /--enable-features=[^\s]*SkiaGraphite/.test(raw);
      }
    } catch {}
    return active;
  }
  if (process.platform !== "linux") return active;
  try {
    const entries = await readdir("/proc");
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const raw = (await readFile(`/proc/${name}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
        if (!raw) continue;
        if ((raw.includes("/opt/Antigravity/antigravity") || raw.includes("/usr/bin/antigravity")) && !raw.includes("--type=") && !raw.includes("register_loader.js")) {
          active.detected = true;
          active.raw = raw;
          const mRaster = raw.match(/--num-raster-threads=(\d+)/);
          if (mRaster) active.rasterThreads = Number(mRaster[1]);
          const mHeap = raw.match(/--max-old-space-size=(\d+)/);
          if (mHeap) active.maxOldSpaceMB = Number(mHeap[1]);
          active.vulkan = /--enable-features=[^\s]*Vulkan/.test(raw);
          try {
            const envRaw = await readFile(`/proc/${name}/environ`, "utf8");
            active.browserRadiusHook = envRaw.includes("wcv-radius-hook.cjs");
          } catch {}
          break;
        }
      } catch {}
    }
  } catch {}
  return active;
}

function buildLaunchCliArgs(launchPerf, rec) {
  const args = [`--remote-debugging-port="$CDP_PORT"`];
  if (launchPerf && launchPerf.enabled) {
    args.push(`--num-raster-threads=${rec.rasterThreads}`);
    args.push(`--js-flags="--max-old-space-size=${rec.maxOldSpaceMB}"`);
    if (process.platform === "win32") {
      const features = [];
      if (launchPerf.vulkan) {
        args.push(`--use-gl=angle --use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy`);
        features.push("PlatformHEVCDecoderSupport");
      }
      if (launchPerf.graphite) {
        args.push(`--enable-skia-graphite`);
        features.push("SkiaGraphite");
      }
      if (features.length > 0) {
        args.push(`--enable-features=${features.join(",")}`);
      }
    } else if (launchPerf.vulkan) {
      args.push(`--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE`);
    }
  }
  return args;
}

async function inspectWindowsShortcuts() {
  const data = await runPowerShellJson(`
$ErrorActionPreference = 'SilentlyContinue'
$wsh = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) }

$items = @()
foreach ($root in $roots) {
  Get-ChildItem -Path $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $sc = $wsh.CreateShortcut($_.FullName)
      if ($sc.TargetPath -and ($sc.TargetPath -match 'Antigravity\\.exe$')) {
        $items += [PSCustomObject]@{ path = $_.FullName; args = ($sc.Arguments | Out-String).Trim() }
      }
    } catch {}
  }
}
[PSCustomObject]@{ items = $items } | ConvertTo-Json -Depth 3 -Compress
`);
  const items = Array.isArray(data?.items) ? data.items : (data?.items ? [data.items] : []);
  return items;
}

async function inspectLaunchPerfStatus(cfg) {
  const rec = computeRecommendedLaunchPerf();
  const lp = Object.assign({ enabled: false, vulkan: false, graphite: false, browserRadiusHook: false }, cfg?.launchPerf || {});
  const isWin = process.platform === "win32";
  const supported = process.platform === "linux" || isWin;
  let wrapperText = "";
  let hasWrapper = false;
  let wrapperPath = process.platform === "linux" ? WRAPPER_PATH : null;
  let winNodeOptions = "";

  if (process.platform === "linux" && existsSync(WRAPPER_PATH)) {
    hasWrapper = true;
    try { wrapperText = await readFile(WRAPPER_PATH, "utf8"); } catch {}
  } else if (isWin) {
    try {
      const shortcuts = await inspectWindowsShortcuts();
      if (shortcuts.length > 0) {
        hasWrapper = true;
        wrapperPath = `Windows 快捷方式 (${shortcuts.length} 个)`;
        wrapperText = shortcuts.map(s => s.args || "").join("\n");
      } else {
        wrapperPath = "Windows 快捷方式";
      }
      const envRes = await runPowerShellJson(`[PSCustomObject]@{ val = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'User') } | ConvertTo-Json -Compress`);
      winNodeOptions = String(envRes?.val || "");
    } catch {
      wrapperPath = "Windows 快捷方式";
    }
  }
  const wrapperHasPerf = /--num-raster-threads=/.test(wrapperText) || /--max-old-space-size=/.test(wrapperText);
  const wrapperHasVulkan = /--enable-features=[^\n]*Vulkan/.test(wrapperText) || /--use-angle=d3d11/.test(wrapperText);
  const wrapperHasGraphite = /--enable-skia-graphite/.test(wrapperText) || /--enable-features=[^\n]*SkiaGraphite/.test(wrapperText);
  const wrapperHasBrowserRadius = /wcv-radius-hook\.cjs/.test(isWin ? winNodeOptions : wrapperText);
  // 若配置从未显式设置过，但本机包装器已存在性能参数，自动同步显示状态
  if (cfg && cfg.launchPerf === undefined && (wrapperHasPerf || wrapperHasBrowserRadius)) {
    lp.enabled = wrapperHasPerf;
    lp.vulkan = wrapperHasVulkan;
    lp.graphite = wrapperHasGraphite;
    lp.browserRadiusHook = wrapperHasBrowserRadius;
  }

  const active = await detectRunningHostFlags();
  const activeHasPerf = !!(active.rasterThreads || active.maxOldSpaceMB);
  const needsRestart = supported && active.detected && (
    (lp.enabled !== activeHasPerf) ||
    (lp.enabled && lp.vulkan !== active.vulkan) ||
    (lp.enabled && isWin && lp.graphite !== active.graphite) ||
    (!isWin && lp.browserRadiusHook !== active.browserRadiusHook) ||
    (isWin && lp.browserRadiusHook !== wrapperHasBrowserRadius)
  );

  const previewArgs = buildLaunchCliArgs(lp, rec)
    .map(a => a.replace('"$CDP_PORT"', "39888"))
    .join(" ");

  return {
    supported,
    platform: process.platform,
    wrapperPath,
    hasWrapper,
    wrapperHasPerf,
    wrapperHasVulkan,
    wrapperHasGraphite,
    wrapperHasBrowserRadius,
    config: lp,
    recommended: rec,
    active,
    needsRestart,
    cliPreview: `${isWin ? "Antigravity.exe" : "antigravity"} ${previewArgs}`
  };
}

async function patchWindowsShortcuts(port = CDP_PORT) {
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$wsh = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) }

$patched = @()
$already = @()
foreach ($root in $roots) {
  Get-ChildItem -Path $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $sc = $wsh.CreateShortcut($_.FullName)
      if ($sc.TargetPath -and ($sc.TargetPath -match 'Antigravity\\.exe$')) {
        if ($sc.Arguments -match '--remote-debugging-port=') {
          $already += $_.FullName
        } else {
          $sc.Arguments = ("$($sc.Arguments) --remote-debugging-port=${port}").Trim()
          $sc.Save()
          $patched += $_.FullName
        }
      }
    } catch {}
  }
}
[PSCustomObject]@{
  patched = $patched
  already = $already
} | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        const patched = Array.isArray(parsed.patched) ? parsed.patched : (parsed.patched ? [parsed.patched] : []);
        const already = Array.isArray(parsed.already) ? parsed.already : (parsed.already ? [parsed.already] : []);
        resolve({ patched, already, port });
      } catch (e) {
        reject(new Error(`解析快捷方式结果失败: ${e.message}`));
      }
    });
  });
}

async function applyWindowsLaunchPerf(launchPerf, port = CDP_PORT) {
  const rec = computeRecommendedLaunchPerf();
  const perfFlags = [];
  if (launchPerf && launchPerf.enabled) {
    perfFlags.push(`--num-raster-threads=${rec.rasterThreads}`);
    perfFlags.push(`--js-flags="--max-old-space-size=${rec.maxOldSpaceMB}"`);
    const features = [];
    if (launchPerf.vulkan) {
      perfFlags.push(`--use-gl=angle`);
      perfFlags.push(`--use-angle=d3d11`);
      perfFlags.push(`--ignore-gpu-blocklist`);
      perfFlags.push(`--enable-gpu-rasterization`);
      perfFlags.push(`--enable-zero-copy`);
      features.push("PlatformHEVCDecoderSupport");
    }
    if (launchPerf.graphite) {
      perfFlags.push(`--enable-skia-graphite`);
      features.push("SkiaGraphite");
    }
    if (features.length > 0) {
      perfFlags.push(`--enable-features=${features.join(",")}`);
    }
  }
  const appendStr = perfFlags.join(" ");
  const data = await runPowerShellJson(`
$ErrorActionPreference = 'SilentlyContinue'
$wsh = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) }

$updated = @()
foreach ($root in $roots) {
  Get-ChildItem -Path $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $sc = $wsh.CreateShortcut($_.FullName)
      if ($sc.TargetPath -and ($sc.TargetPath -match 'Antigravity\\.exe$')) {
        $args = ($sc.Arguments | Out-String).Trim()
        $args = $args -replace '--num-raster-threads=\\d+', ''
        $args = $args -replace '--js-flags="[^"]*--max-old-space-size=\\d+[^"]*"', ''
        $args = $args -replace '--enable-features=[^\\s]*(?:Vulkan|PlatformHEVCDecoderSupport|SkiaGraphite)[^\\s]*', ''
        $args = $args -replace '--enable-skia-graphite', ''
        $args = $args -replace '--use-gl=angle', ''
        $args = $args -replace '--use-angle=d3d11', ''
        $args = $args -replace '--ignore-gpu-blocklist', ''
        $args = $args -replace '--enable-gpu-rasterization', ''
        $args = $args -replace '--enable-zero-copy', ''
        $args = ($args -replace '\\s+', ' ').Trim()
        if ($args -notmatch '--remote-debugging-port=') {
          $args = ("$args --remote-debugging-port=${port}").Trim()
        }
        $extra = '${appendStr}'
        if ($extra) {
          $args = ("$args $extra").Trim()
        }
        $sc.Arguments = $args
        $sc.Save()
        $updated += $_.FullName
      }
    } catch {}
  }
}
[PSCustomObject]@{ updated = $updated } | ConvertTo-Json -Compress
`);
  const updatedList = Array.isArray(data?.updated) ? data.updated : (data?.updated ? [data.updated] : []);
  return {
    updated: updatedList.length > 0,
    paths: updatedList,
    reason: updatedList.length === 0 ? "未找到 Antigravity.exe 快捷方式" : undefined
  };
}

async function applyWindowsNodeHook(enabled) {
  const dest = HOOK_SCRIPT_DEST;
  if (enabled) {
    await ensureHookScriptCopied();
  }
  const escapedDest = dest.replace(/'/g, "''");
  const flagStr = /\s/.test(dest) ? `--require "${dest}"` : `--require ${dest}`;
  const escapedFlag = flagStr.replace(/'/g, "''");
  await runPowerShellJson(`
$ErrorActionPreference = 'SilentlyContinue'
$cur = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'User')
if (-not $cur) { $cur = '' }
$cleaned = ($cur -replace '--require\\s+(?:"[^"]*wcv-radius-hook\\.cjs"|\\S*wcv-radius-hook\\.cjs)', '').Trim()
$cleaned = ($cleaned -replace '\\s+', ' ').Trim()
$enable = ${enabled ? "$true" : "$false"}
if ($enable) {
  $next = if ($cleaned) { "$cleaned ${escapedFlag}" } else { "${escapedFlag}" }
} else {
  $next = $cleaned
}
if ($next) {
  [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $next, 'User')
} else {
  [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'User')
}
[PSCustomObject]@{ ok = $true; nodeOptions = $next } | ConvertTo-Json -Compress
`);
}

async function applyLaunchWrapper(launchPerf) {
  if (process.platform === "win32") {
    const winRes = await applyWindowsLaunchPerf(launchPerf, CDP_PORT);
    await applyWindowsNodeHook(!!(launchPerf && launchPerf.browserRadiusHook));
    return winRes;
  }
  if (process.platform !== "linux") {
    return { updated: false, reason: "当前仅 Linux / Windows 自动写入启动参数，其他平台请手动附加下方启动参数" };
  }
  const rec = computeRecommendedLaunchPerf();
  const realBin = existsSync("/usr/bin/antigravity")
    ? "/usr/bin/antigravity"
    : (existsSync("/opt/Antigravity/antigravity") ? "/opt/Antigravity/antigravity" : "/usr/bin/antigravity");

  const binDir = dirname(WRAPPER_PATH);
  if (!existsSync(binDir)) await mkdir(binDir, { recursive: true });
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });

  if (existsSync(WRAPPER_PATH) && !existsSync(WRAPPER_BACKUP_PATH)) {
    try {
      const orig = await readFile(WRAPPER_PATH, "utf8");
      if (!orig.includes("Theme Control Center")) {
        await writeFile(WRAPPER_BACKUP_PATH, orig, "utf8");
      }
    } catch {}
  }

  const args = buildLaunchCliArgs(launchPerf, rec);
  const useNodeHook = !!(launchPerf && launchPerf.browserRadiusHook);
  if (useNodeHook) {
    await ensureHookScriptCopied();
  }
  const script = [
    "#!/usr/bin/env bash",
    "# Managed by Antigravity Theme Control Center",
    "CDP_PORT=39888",
    "if ss -ltn 2>/dev/null | grep -qE '(:|\\])39888\\b'; then",
    "  CDP_PORT=0",
    "fi",
    ...(useNodeHook ? [`export NODE_OPTIONS="\${NODE_OPTIONS:+\${NODE_OPTIONS} }--require ${HOOK_SCRIPT_DEST}"`] : []),
    `exec ${realBin} \\`,
    ...args.map(a => `  ${a} \\`),
    '  "$@"',
    ""
  ].join("\n");

  await writeFile(WRAPPER_PATH, script, "utf8");
  await chmod(WRAPPER_PATH, 0o755);

  // 确保桌面启动器指向 ~/.local/bin/antigravity（仅在不存在时创建，不破坏用户自定义）
  const desktopDir = join(os.homedir(), ".local/share/applications");
  const desktopFile = join(desktopDir, "antigravity.desktop");
  if (!existsSync(desktopFile)) {
    try {
      await mkdir(desktopDir, { recursive: true });
      await writeFile(desktopFile, [
        "[Desktop Entry]",
        "Name=Antigravity",
        "Comment=Experience liftoff",
        "GenericName=Agentic Platform",
        `Exec=${WRAPPER_PATH} %U`,
        "Icon=antigravity",
        "Type=Application",
        "StartupNotify=false",
        "StartupWMClass=Antigravity",
        "Categories=Development;Utility;",
        ""
      ].join("\n"), "utf8");
    } catch {}
  }

  return { updated: true, wrapperPath: WRAPPER_PATH };
}

// ========================================================
// 媒体文件检查 / 本地文件选择 / 目录浏览
// ========================================================

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi", ".ogv"]);

function normalizeLocalPath(raw) {
  if (!raw) return "";
  let p = String(raw).trim();
  if (p.startsWith("file://")) {
    try { p = decodeURIComponent(p.slice(7)); } catch { p = p.slice(7); }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  }
  if (p.startsWith("~")) p = join(os.homedir(), p.slice(1));
  return p;
}

async function checkMediaFile(rawPath) {
  const filePath = normalizeLocalPath(rawPath);
  const out = { path: filePath, exists: false, readable: false, isFile: false, size: 0, mime: null, reason: "" };
  if (!filePath) { out.reason = "路径为空"; return out; }
  if (!filePath.startsWith(sep) && !/^[A-Za-z]:[\\/]/.test(filePath)) {
    out.reason = "不是绝对路径";
    return out;
  }
  out.exists = existsSync(filePath);
  if (!out.exists) { out.reason = "文件不存在"; return out; }
  try {
    const st = await stat(filePath);
    out.isFile = st.isFile();
    out.size = st.size;
    if (!out.isFile) { out.reason = "不是普通文件（可能是目录）"; return out; }
  } catch (e) {
    out.reason = "无法读取文件状态：" + e.message;
    return out;
  }
  try {
    await access(filePath, FS_CONSTANTS.R_OK);
    out.readable = true;
  } catch (e) {
    out.reason = "没有读取权限";
    return out;
  }
  const ext = extname(filePath).toLowerCase();
  out.mime = MIME_TYPES[ext] || null;
  out.kind = IMAGE_EXT.has(ext) ? "image" : VIDEO_EXT.has(ext) ? "video" : "unknown";
  if (out.size === 0) out.reason = "文件为空 (0 字节)";
  return out;
}

function pickWithWindowsDialog(kind) {
  const title = kind === "video" ? "选择动态壁纸视频" : "选择壁纸图片";
  const filter = kind === "video"
    ? "视频文件 (*.mp4;*.webm;*.mov;*.m4v;*.mkv;*.avi;*.ogv)|*.mp4;*.webm;*.mov;*.m4v;*.mkv;*.avi;*.ogv|所有文件 (*.*)|*.*"
    : "图片文件 (*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.avif;*.svg)|*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.avif;*.svg|所有文件 (*.*)|*.*";
  const initialDir = kind === "video" ? join(os.homedir(), "Videos") : join(os.homedir(), "Pictures");
  const safeInit = existsSync(initialDir) ? initialDir : os.homedir();

  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '${title}'
$dlg.Filter = '${filter}'
$dlg.InitialDirectory = '${safeInit.replace(/'/g, "''")}'
$dlg.Multiselect = $false
$res = $dlg.ShowDialog($owner)
$owner.Dispose()
if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.FileName) {
  [PSCustomObject]@{ ok = $true; path = $dlg.FileName } | ConvertTo-Json -Compress
} else {
  [PSCustomObject]@{ ok = $false; code = 'CANCELLED' } | ConvertTo-Json -Compress
}
`;
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      return resolve({ ok: false, code: "NO_DIALOG", error: "无法启动 Windows 文件选择框：" + e.message });
    }

    let out = "";
    let errOut = "";
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, code: "TIMEOUT", error: "对话框等待超时" });
    }, 10 * 60 * 1000);

    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { errOut += d.toString("utf8"); });
    child.on("error", (e) => done({ ok: false, code: "DIALOG_FAILED", error: e.message }));
    child.on("close", (code) => {
      try {
        const parsed = JSON.parse(out.trim() || "{}");
        if (parsed && typeof parsed.ok === "boolean") return done(parsed);
      } catch {}
      if (code === 0) return done({ ok: false, code: "CANCELLED" });
      done({ ok: false, code: "DIALOG_FAILED", error: errOut.trim() || `PowerShell 退出码 ${code}` });
    });
  });
}

// 用原生对话框（Windows: OpenFileDialog / Linux: zenity）取绝对路径 —— 浏览器 <input type=file> 拿不到完整路径
function pickWithNativeDialog(kind) {
  if (process.platform === "win32") {
    return pickWithWindowsDialog(kind);
  }
  return new Promise((resolve) => {
    const filters = kind === "video"
      ? ["--file-filter=视频文件 | *.mp4 *.webm *.mov *.m4v *.mkv *.avi", "--file-filter=所有文件 | *"]
      : ["--file-filter=图片文件 | *.jpg *.jpeg *.png *.webp *.gif *.bmp *.avif", "--file-filter=所有文件 | *"];

    const args = [
      "--file-selection",
      `--title=${kind === "video" ? "选择动态壁纸视频" : "选择壁纸图片"}`,
      "--filename=" + os.homedir() + "/",
      ...filters
    ];

    let child;
    try {
      child = spawn("zenity", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, code: "NO_DIALOG", error: "无法启动 zenity：" + e.message });
    }

    let out = "";
    let errOut = "";
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch (e) {}
      done({ ok: false, code: "TIMEOUT", error: "对话框等待超时" });
    }, 10 * 60 * 1000);

    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { errOut += d.toString(); });

    child.on("error", (e) => {
      const noBin = e && e.code === "ENOENT";
      done({
        ok: false,
        code: noBin ? "NO_DIALOG" : "DIALOG_FAILED",
        error: noBin ? "系统未安装 zenity，改用内置文件浏览器" : e.message
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        const picked = out.trim();
        if (!picked) return done({ ok: false, code: "CANCELLED" });
        return done({ ok: true, path: picked });
      }
      if (code === 1) return done({ ok: false, code: "CANCELLED" });
      done({
        ok: false,
        code: "DIALOG_FAILED",
        error: (errOut.trim() || `zenity 退出码 ${code}`)
      });
    });
  });
}

// 内置目录浏览器兜底（zenity 不可用 / 远程环境）
async function listDirectory(rawDir) {
  const target = normalizeLocalPath(rawDir) || os.homedir();
  const dir = resolvePath(target);
  let st;
  try {
    st = await stat(dir);
  } catch (e) {
    const err = new Error(e.code === "ENOENT" ? "目录不存在：" + dir
      : e.code === "EACCES" ? "没有访问权限：" + dir
      : "无法读取目录：" + e.message);
    err.status = e.code === "ENOENT" ? 404 : e.code === "EACCES" ? 403 : 500;
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error("不是目录：" + dir);
    err.status = 400;
    throw err;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      dirs.push({ name: e.name, path: full, type: "dir" });
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      const kind = IMAGE_EXT.has(ext) ? "image" : VIDEO_EXT.has(ext) ? "video" : null;
      if (!kind) continue;
      files.push({ name: e.name, path: full, type: kind });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const parent = dirname(dir);
  return {
    dir,
    parent: parent === dir ? null : parent,
    home: os.homedir(),
    entries: [...dirs, ...files]
  };
}

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

  // API: 宿主结构诊断（哪个样式面没生效、DOM 轮廓、生效样式表来源）
  if (url.pathname === "/api/audit" && req.method === "GET") {
    try {
      const cdpOk = await cdp.connect();
      if (!cdpOk) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `无法连接宿主 CDP 端口 ${cdp.port}`, css: await effectiveCSSSource() }));
        return;
      }
      const audit = await cdp.evaluate(hostDomAudit);
      const css = await effectiveCSSSource();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        host: { title: audit.hostTitle, ua: audit.userAgent },
        css,
        version: { plugin: "1.0.0", cdpPort: cdp.port, sidecarPort: PORT },
        audit
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // API: Inject theme via CDP（先巡检 → 再注入 → 再验证；任一环节失败即回滚并报错）
  if (url.pathname === "/api/inject" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      let probe = null;
      try {
        const stored = await getOrCreateConfig();
        const payload = body ? JSON.parse(body) : stored;
        // 与已存配置合并：部分字段的调用（如只带 injection）不再清空壁纸/悬浮设置
        const cfg = deepMerge(stored, payload.config || payload);

        // Load bundled base CSS + optional user custom overrides
        const userCSS = await getEffectiveCSS();

        const cdpOk = await cdp.connect();
        if (!cdpOk) {
          throw new Error(`无法连接到 Antigravity 宿主调试端口 (${cdp.port})。请使用官方包装器启动或附带 --remote-debugging-port=${cdp.port}`);
        }

        // ── 步骤 1：注入前兼容性巡检（不写任何东西） ──
        probe = await cdp.evaluate(hostDomProbe);
        if (!probe || !probe.ok) {
          const failedLabels = (probe && probe.failed && probe.failed.length)
            ? probe.failed.join("、")
            : "宿主 respond 异常";
          const err = new Error(`兼容性校验未通过，已取消注入：${failedLabels}`);
          err.code = "COMPAT_FAILED";
          err.checks = (probe && probe.checks) || [];
          throw err;
        }

        // ── 步骤 2：注入（页面内还有一道闸门与注入后自检） ──
        const result = await cdp.evaluate(hostDomInject, userCSS, cfg, PORT);
        if (!result || !result.success) {
          const err = new Error("注入执行未返回成功状态");
          err.code = "INJECT_FAILED";
          throw err;
        }

        cfg.injection = cfg.injection || {};
        cfg.injection.enabled = true;
        cfg.injection.lastError = null;
        await saveConfig(cfg);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          isInjected: true,
          verified: result.verified || null,
          checks: (result.probe && result.probe.checks) || probe.checks
        }));
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

        const status = err.code === "COMPAT_FAILED" ? 409 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          error: err.message,
          code: err.code || "INJECT_ERROR",
          checks: err.checks || (probe && probe.checks) || []
        }));
      }
    });
    return;
  }

  // API: 只做兼容性巡检，不注入（供 UI 预检与"重新校验"）
  if (url.pathname === "/api/diagnose" && req.method === "GET") {
    try {
      const cdpOk = await cdp.connect();
      if (!cdpOk) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          connected: false,
          ok: false,
          error: `无法连接宿主 CDP 端口 ${cdp.port}`,
          checks: []
        }));
        return;
      }
      const probe = await cdp.evaluate(hostDomProbe);
      const hostState = await cdp.evaluate(hostDomGetState).catch(() => null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: true, ...probe, hostState }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: cdp.connected, ok: false, error: err.message, checks: [] }));
    }
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

  // API: 媒体文件预检（不读内容，只回答"能不能加载"以及为什么）
  if (url.pathname === "/api/media-info" && req.method === "GET") {
    const info = await checkMediaFile(url.searchParams.get("file"));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(info));
    return;
  }

  // API: 原生文件选择对话框（返回绝对路径）
  if (url.pathname === "/api/pick" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      let kind = "image";
      try { kind = (JSON.parse(body || "{}").kind) || "image"; } catch (e) {}
      const result = await pickWithNativeDialog(kind);
      const status = result.ok ? 200 : (result.code === "CANCELLED" ? 200 : 501);
      if (result.ok) {
        const info = await checkMediaFile(result.path);
        result.info = info;
        if (!info.exists || !info.readable) {
          result.ok = false;
          result.code = "BAD_FILE";
          result.error = info.reason || "所选文件不可用";
        }
      }
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // API: 目录浏览（内置浏览器兜底）
  if (url.pathname === "/api/browse" && req.method === "GET") {
    try {
      const listing = await listDirectory(url.searchParams.get("dir") || os.homedir());
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, ...listing }));
    } catch (err) {
      res.writeHead(err.status || 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // API: Get launch performance tuning status (requires restart)
  if (url.pathname === "/api/launch-perf" && req.method === "GET") {
    const cfg = await getOrCreateConfig();
    const status = await inspectLaunchPerfStatus(cfg);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(status));
    return;
  }

  // API: Update launch performance tuning flags & write launcher wrapper
  if (url.pathname === "/api/launch-perf" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body || "{}");
      const cfg = await getOrCreateConfig();
      const prev = Object.assign({ enabled: false, vulkan: false, graphite: false, browserRadiusHook: false }, cfg.launchPerf || {});
      const next = {
        enabled: patch.enabled !== undefined ? !!patch.enabled : prev.enabled,
        vulkan: patch.vulkan !== undefined ? !!patch.vulkan : prev.vulkan,
        graphite: patch.graphite !== undefined ? !!patch.graphite : prev.graphite,
        browserRadiusHook: patch.browserRadiusHook !== undefined ? !!patch.browserRadiusHook : prev.browserRadiusHook
      };
      if (!next.enabled) {
        next.vulkan = false;
        next.graphite = false;
      }
      cfg.launchPerf = next;
      await saveConfig(cfg);
      const writeRes = await applyLaunchWrapper(next);
      const status = await inspectLaunchPerfStatus(cfg);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, writeRes, ...status }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // API: Stream local video / image media file
  if (url.pathname === "/api/win-enable-cdp" && req.method === "POST") {
    if (process.platform !== "win32") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "仅支持 Windows 平台" }));
      return;
    }
    try {
      const result = await patchWindowsShortcuts(CDP_PORT);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // API: Stream local video / image media file
  if (url.pathname === "/api/media" && req.method === "GET") {
    const filePath = normalizeLocalPath(url.searchParams.get("file"));
    const info = await checkMediaFile(filePath);

    if (!info.exists || !info.isFile || !info.readable) {
      const status = !info.exists ? 404 : (!info.isFile ? 400 : 403);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify({
        error: info.reason || "无法读取媒体文件",
        path: filePath,
        exists: info.exists,
        readable: info.readable,
        isFile: info.isFile
      }));
      return;
    }

    try {
      const stats = await stat(filePath);
      const ext = extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const etag = `"${stats.size}-${Math.trunc(stats.mtimeMs)}"`;
      const lastModified = stats.mtime.toUTCString();
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        if (Number.isNaN(start) || start >= stats.size || start < 0) {
          res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
          res.end();
          return;
        }
        const safeEnd = Math.min(end, stats.size - 1);
        const chunksize = safeEnd - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${safeEnd}/${stats.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": mime,
          "ETag": etag,
          "Last-Modified": lastModified,
          "Cache-Control": "private, max-age=300"
        });
        const stream = createReadStream(filePath, { start, end: safeEnd });
        res.on("close", () => stream.destroy());
        stream.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stats.size,
          "Accept-Ranges": "bytes",
          "Content-Type": mime,
          "ETag": etag,
          "Last-Modified": lastModified,
          "Cache-Control": "private, max-age=300"
        });
        const stream = createReadStream(filePath);
        res.on("close", () => stream.destroy());
        stream.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
        stream.pipe(res);
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "读取失败：" + e.message, path: filePath }));
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
          const userCSS = await getEffectiveCSS();
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

  // On sidecar boot: if injection was previously enabled, automatically reconnect & restore theme quickly
  if (cfg.injection && cfg.injection.enabled === true) {
    (async () => {
      const userCSS = await getEffectiveCSS();
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          const cdpOk = await cdp.connect();
          if (cdpOk) {
            await cdp.evaluate(hostDomInject, userCSS, cfg, PORT);
            console.log("[CDP] Automatically restored theme injection on startup");
            return;
          }
        } catch (e) {
          if (attempt === 11) console.warn("[CDP] Startup auto-inject:", e.message);
        }
        await new Promise(r => setTimeout(r, 350));
      }
    })();
  }
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

