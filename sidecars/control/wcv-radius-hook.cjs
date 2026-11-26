"use strict";
// Non-invasive Electron main-process hook for Theme Control Center:
// Applies floating.radius via WebContentsView.setBorderRadius() to browser views.
if (process.type !== "browser") return;
if (!/antigravity/i.test(process.execPath || "")) return;

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");

const CONFIG_PATH = path.join(os.homedir(), ".gemini", "config", "custom-ui", "theme-config.json");
let cachedRadius = 16;
let lastReadAt = 0;

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
    url.startsWith("data:text/html,<!doctype html>")
  );
}

let patched = false;
const origLoad = Module._load;
Module._load = function patchedLoad(request) {
  const exportsObj = origLoad.apply(this, arguments);
  if (!patched && request === "electron" && exportsObj && exportsObj.WebContentsView) {
    patched = true;
    const proto = exportsObj.WebContentsView.prototype;
    if (proto && typeof proto.setBounds === "function" && typeof proto.setBorderRadius === "function") {
      const origSetBounds = proto.setBounds;
      proto.setBounds = function patchedSetBounds(bounds) {
        const res = origSetBounds.apply(this, arguments);
        try {
          const url = this.webContents && !this.webContents.isDestroyed() ? this.webContents.getURL() : "";
          if (!isHostOrCurtainUrl(url) && bounds && bounds.x > 0 && bounds.y > 0) {
            this.setBorderRadius(readRadius());
          }
        } catch {}
        return res;
      };
    }
  }
  return exportsObj;
};
