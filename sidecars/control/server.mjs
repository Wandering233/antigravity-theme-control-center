import { createServer } from "node:http";
import { readFile, writeFile, stat, mkdir, readdir, access } from "node:fs/promises";
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
  }
};

async function getEffectiveCSS() {
  let baseCSS = "";
  if (existsSync(DEFAULT_CSS_FILE)) {
    try {
      baseCSS = await readFile(DEFAULT_CSS_FILE, "utf8");
    } catch (e) {
      console.warn("[Sidecar] Error reading bundled theme.default.css:", e);
    }
  }

  let userCSS = "";
  if (existsSync(CSS_FILE)) {
    try {
      userCSS = await readFile(CSS_FILE, "utf8");
    } catch (e) {}
  } else if (baseCSS) {
    try {
      if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
      await writeFile(CSS_FILE, baseCSS, "utf8");
      console.log("[Sidecar] Auto-initialized custom.css from bundled template");
    } catch (e) {}
  }

  return userCSS || baseCSS;
}

// 当前生效的样式表来源 + 与内置版本是否一致
// （用户 custom.css 优先，容易残留旧版本，导致"跑的不是仓库里的样式"）
async function effectiveCSSSource() {
  const out = {
    source: "none", chars: 0,
    customExists: existsSync(CSS_FILE), bundledExists: existsSync(DEFAULT_CSS_FILE),
    customChars: 0, bundledChars: 0, diverged: false,
    customSha: null, bundledSha: null
  };
  const sha = (s) => createHash("sha256").update(s || "", "utf8").digest("hex").slice(0, 12);
  try {
    if (out.customExists) {
      const css = await readFile(CSS_FILE, "utf8");
      out.customChars = (css || "").length;
      out.customSha = sha(css);
      if (css && css.length > 0) { out.source = "custom.css"; out.chars = css.length; }
    }
    if (out.bundledExists) {
      const bundled = await readFile(DEFAULT_CSS_FILE, "utf8");
      out.bundledChars = (bundled || "").length;
      out.bundledSha = sha(bundled);
      if (out.source === "none") { out.source = "theme.default.css (bundled)"; out.chars = out.bundledChars; }
    }
    out.diverged = !!(out.customExists && out.customChars > 0 && out.bundledExists && out.customSha !== out.bundledSha);
  } catch (e) {
    out.error = e.message;
  }
  return out;
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

    // 判定方式：
    //   card     —— 吃到圆角 / 外边距 / 模糊，任一即可认为卡片化生效
    //   position —— 规则用的是 top/left 偏移，检查 top 是否被改写
    const top = parseFloat(cs.top);
    let applied = true;
    if (o.card) applied = radius > 0 || marginTop > 0 || backdrop !== "none";
    else if (o.position) applied = !Number.isNaN(top) && top > 0;
    // 折叠状态（如右侧面板收起时 width=0）不算失败
    const collapsed = o.collapsible ? (width === 0) : false;

    // 不能只看元素自身：左侧边栏和中央面板的材质画在 ::before 上。
    // 元素自身 backdrop-filter:none 是刻意规避 Chromium 嵌套滤镜限制，并非材质缺失。
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
      return {
        html: bg(document.documentElement),
        body: bg(document.body),
        shell: bg(document.querySelector(".agy-shell")),
        wallpaper: {
          layer: !!wpEl,
          layerZ: wpEl ? getComputedStyle(wpEl).zIndex : null,
          imgSrc: wpImg ? String(wpImg.getAttribute("src") || "").slice(0, 80) : null,
          imgLoaded: wpImg ? (wpImg.complete && wpImg.naturalWidth > 0) : false,
          imgSize: wpImg && wpImg.naturalWidth ? wpImg.naturalWidth + "x" + wpImg.naturalHeight : null
        }
      };
    })(),
    surfaces: S,
    summary: {
      total: required.length,
      applied: required.filter((s) => s.applied).length,
      collapsed: S.filter((s) => s.collapsed).map((s) => s.label),
      absent: S.filter((s) => !s.present).map((s) => s.label),
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
    docStyle.setProperty("--ag-glass-opacity", `${fOpacity}`);
    docStyle.setProperty("--ag-glass-blur", `${fBlur}px`);

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

    if (img) {
      img.style.position = "absolute";
      img.style.top = "0";
      img.style.left = "0";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = wp.fit || "cover";
      img.style.filter = `blur(${wp.blur || 0}px) brightness(${wp.brightness ?? 1})`;
      img.style.transform = "scale(1.05)";
    }

    if (video) {
      video.style.position = "absolute";
      video.style.top = "0";
      video.style.left = "0";
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = wp.fit || "cover";
      video.style.filter = `blur(${wp.blur || 0}px) brightness(${wp.brightness ?? 1})`;
      video.style.transform = "scale(1.05)";
    }

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
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg"
};

let debouncedSaveTimer = null;

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
    access(filePath, FS_CONSTANTS.R_OK);
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

// 用原生 GTK 对话框（zenity）取绝对路径 —— 浏览器 <input type=file> 拿不到完整路径
function pickWithNativeDialog(kind) {
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
          "Content-Type": mime
        });
        createReadStream(filePath, { start, end: safeEnd }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stats.size,
          "Accept-Ranges": "bytes",
          "Content-Type": mime
        });
        createReadStream(filePath).pipe(res);
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

  // On sidecar boot: if injection was previously enabled, automatically reconnect & restore theme
  setTimeout(async () => {
    try {
      const cdpOk = await cdp.connect();
      if (cdpOk && cfg.injection && cfg.injection.enabled === true) {
        const userCSS = await getEffectiveCSS();
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

