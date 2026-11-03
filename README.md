# Theme & Wallpaper Control Center for Antigravity

[![Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin-blue.svg)](https://github.com/Wandering233/antigravity-theme-control-center)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Visual Control Center for **Google Antigravity**: toggle floating card layouts, tune liquid/frosted glassmorphism parameters, and customize background wallpapers with static pictures or dynamic video loops.

---

## ✨ Features

- 🎴 **Floating Card Layout (悬浮卡片模式)**: Transforms the standard IDE interface into modern floating surface cards with customizable margins, gutters, and border radius.
- 🧊 **Dual Material Glassmorphism (双材质毛玻璃)**:
  - **Frosted (经典磨砂)**: Clean, smooth Gaussian blur backdrop with subtle translucent tinting.
  - **Liquid (流体光泽)**: Advanced dynamic light refraction, subtle wave specular highlights, and soft inner glow.
- 🖼️ **Rich Wallpapers (静态与动态壁纸)**:
  - Supports online image URLs and local media files.
  - Built-in video streaming engine (`/api/media`) supporting high-definition MP4/WebM video wallpapers.
  - Live adjustment of brightness, blur, and dim overlay.
- ⚡ **CDP Zero-Patch Architecture (零侵入热注入)**:
  - Connects directly to Antigravity's host window via the Chrome DevTools Protocol (CDP).
  - **Zero file patching**: Does not tamper with internal app bundles or binary files; completely immune to software updates.
  - **Self-healing**: Automatically re-injects and synchronizes styles if the window reloads (`Ctrl+R`).
  - **Clean Shutdown**: Gracefully ejects injected CSS and restores the native UI upon plugin disable, uninstall, or exit.
- 🎨 **Sidecar Control Panel**:
  - Embedded Sidecar UI accessible directly from Antigravity's auxiliary panels.
  - Follows Material Design 3 (MD3) guidelines with automatic Dark / Light mode adaptation.

---

## 🚀 Installation & Debugging (快速安装与调试)

### 1. 全局安装 (Global Install)

将仓库克隆至 Antigravity 全局插件目录：

```bash
git clone https://github.com/Wandering233/antigravity-theme-control-center.git ~/.gemini/config/plugins/theme-control-center
```

重启 Antigravity 后，即可在侧边栏或自定义面板中打开 **Theme & Wallpaper Control Center**。

### 2. 工作区隔离调试 (Workspace Sandbox Install)

若仅想在特定测试项目中调试本插件，避免污染全局配置：

```bash
# 在你的任意测试项目根目录下执行
mkdir -p .agents/plugins
git clone https://github.com/Wandering233/antigravity-theme-control-center.git .agents/plugins/theme-control-center
```

打开该项目时 Antigravity 会单独挂载此插件，改动即时生效。

### 3. 插件规范校验 (CLI Validation)

在终端运行官方 CLI 工具检查插件完整性：

```bash
agy plugin validate ~/.gemini/config/plugins/theme-control-center
```

---

## 🛠️ Project Structure

```text
theme-control-center/
├── plugin.json         # Plugin manifest
├── assets/
│   └── logo.svg        # Vector plugin icon
├── sidecars/
│   └── control/
│       ├── sidecar.json # Sidecar service declaration
│       ├── server.mjs   # Node.js CDP engine & local media streaming server
│       └── index.html   # Visual Control Center dashboard
├── .gitignore
└── README.md
```

---

## ⚙️ Configuration File

插件配置自动保存在 `~/.gemini/config/custom-ui/theme-config.json`：

```json
{
  "injection": { "enabled": true },
  "floating": {
    "enabled": true,
    "material": "liquid",
    "gutter": 10,
    "radius": 16,
    "frosted": { "opacity": 0.65, "blur": 24 },
    "liquid": { "opacity": 0.35, "refraction": 20, "wave": 2, "blur": 8, "specular": 0.75, "innerGlow": 0.25 }
  },
  "wallpaper": {
    "enabled": true,
    "type": "image",
    "url": "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1920&q=80",
    "blur": 0,
    "brightness": 1,
    "dim": 0.1,
    "fit": "cover"
  }
}
```

---

## 📄 License

[MIT License](LICENSE) © 2026 Wandering233
