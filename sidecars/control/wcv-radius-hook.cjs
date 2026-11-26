"use strict";
// Non-invasive Electron main-process hook for Theme Control Center:
// Applies floating.radius via View/WebContentsView.setBorderRadius() to browser views & clipView.
if (process.type !== "browser") return;
if (!/antigravity/i.test(process.execPath || "")) return;

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");

const CONFIG_DIR = path.join(os.homedir(), ".gemini", "config", "custom-ui");
const CONFIG_PATH = path.join(CONFIG_DIR, "theme-config.json");
const LOG_PATH = path.join(CONFIG_DIR, "wcv-hook.log");
let cachedRadius = 16;
let lastReadAt = 0;

function logLine(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {}
}

function readRadius() {
  const now = Date.now();
  if (now - lastReadAt < 500) return cachedRadius;
  lastReadAt = now;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    if (cfg && cfg.floating && cfg.floating.enabled === false) {
      cachedRadius = 0;
    } else if (cfg && cfg.floating && typeof cfg.floating.radius === "number") {
      cachedRadius = Math.max(0, Math.round(cfg.floating.radius));
    }
  } catch {}
  return cachedRadius;
}

function isHostOrCurtainUrl(url) {
  if (!url) return false;
  return (
    url.startsWith("https://127.0.0.1:") ||
    url.startsWith("http://127.0.0.1:") ||
    url.startsWith("file://") ||
    url.startsWith("devtools://") ||
    url.startsWith("data:text/html,<!doctype html>") ||
    url.startsWith("data:text/html;charset=utf-8,")
  );
}

let patched = false;
const origLoad = Module._load;
Module._load = function patchedLoad(request) {
  const exportsObj = origLoad.apply(this, arguments);
  if (!patched && request === "electron" && exportsObj && (exportsObj.View || exportsObj.WebContentsView)) {
    patched = true;
    try { fs.writeFileSync(LOG_PATH, `[${new Date().toISOString()}] Hook loaded (pid=${process.pid}, platform=${process.platform})\n`, "utf8"); } catch {}
    const targets = [exportsObj.View, exportsObj.WebContentsView].filter(Boolean);
    const seenProtos = new Set();
    for (const Cls of targets) {
      const proto = Cls && Cls.prototype;
      if (!proto || seenProtos.has(proto)) continue;
      seenProtos.add(proto);
      if (typeof proto.setBounds === "function" && typeof proto.setBorderRadius === "function") {
        const origSetBounds = proto.setBounds;
        proto.setBounds = function patchedSetBounds(bounds) {
          const res = origSetBounds.apply(this, arguments);
          try {
            const r = readRadius();
            if (this.webContents) {
              const url = !this.webContents.isDestroyed() ? this.webContents.getURL() : "";
              if (!isHostOrCurtainUrl(url)) {
                this.setBorderRadius(r);
              }
            } else if (bounds && (bounds.x > 0 || bounds.y > 0) && Array.isArray(this.children) && this.children.length > 0) {
              // clipView container wrapping browserWcv
              this.setBorderRadius(r);
            }
          } catch {}
          return res;
        };
        logLine(`Patched ${Cls.name || "View"}.prototype.setBounds + setBorderRadius`);
      }
    }
  }
  return exportsObj;
};
