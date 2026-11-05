# Antigravity Theme & Wallpaper Control Center

Visual customization sidecar and control panel for Google Antigravity. Supports floating card layouts, liquid and frosted glassmorphism, and dynamic video or static image background wallpapers.

## Features

- **Floating Card Layout**: Detaches panels into floating surface cards with customizable gutters and border radius.
- **Glassmorphism Materials**:
  - `frosted`: Gaussian blur backdrop with configurable opacity and blur radius.
  - `liquid`: Light refraction, wave specular highlights, and soft inner glow.
- **Custom Wallpapers**:
  - Supports image URLs and local media files.
  - Built-in HTTP media streaming (`/api/media`) for video backgrounds (MP4, WebM).
  - Configurable brightness, blur, and dim overlay.
- **CDP Injection Architecture**:
  - Connects to Antigravity's host window over the Chrome DevTools Protocol.
  - Zero binary or file patching; survives application updates.
  - Automatic reconnection and style re-injection on window reload (`Ctrl+R`).
  - Restores default UI styles on shutdown.
- **Auxiliary Pane UI**: Sidecar control dashboard adapted for light and dark modes.

## Installation

### Global

Clone into the Antigravity global plugins directory:

```bash
git clone https://github.com/Wandering233/antigravity-theme-control-center.git ~/.gemini/config/plugins/theme-control-center
```

Restart Antigravity to discover the plugin.

### Workspace Sandbox (Testing)

To test inside a specific repository without modifying global configurations:

```bash
mkdir -p .agents/plugins
git clone https://github.com/Wandering233/antigravity-theme-control-center.git .agents/plugins/theme-control-center
```

### Manifest Validation

Validate plugin structure using the Antigravity CLI:

```bash
agy plugin validate ~/.gemini/config/plugins/theme-control-center
```

## Configuration

Configuration is stored at `~/.gemini/config/custom-ui/theme-config.json`:

```json
{
  "injection": {
    "enabled": true
  },
  "floating": {
    "enabled": true,
    "material": "liquid",
    "gutter": 10,
    "radius": 16,
    "frosted": {
      "opacity": 0.65,
      "blur": 24
    },
    "liquid": {
      "opacity": 0.35,
      "refraction": 20,
      "wave": 2,
      "blur": 8,
      "specular": 0.75,
      "innerGlow": 0.25
    }
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

## Directory Structure

```text
theme-control-center/
├── plugin.json
├── assets/
│   └── logo.svg
├── sidecars/
│   └── control/
│       ├── index.html
│       ├── server.mjs
│       ├── theme.default.css   # bundled base stylesheet
│       └── sidecar.json
├── .gitignore
├── LICENSE
└── README.md
```

## Safety: Pre-flight Compatibility Check

Injection is gated rather than best-effort:

1. **Pre-flight** — probes required host anchors (`#root` / `.agy-shell`, `head`, left sidebar) plus optional ones (chat viewport, composer, Auxiliary Pane). Nothing is written at this stage.
2. **Refusal** — if a required anchor is missing, `POST /api/inject` returns `409` with the failing checks and no styles are applied.
3. **Post-check** — verifies the injected stylesheet is non-empty and that the wallpaper layer is `position: fixed` / `z-index: -99999` / `pointer-events: none`; any mismatch triggers a full eject.
4. **Visibility** — the control panel renders the checklist live with a "Re-check" button; `GET /api/diagnose` exposes the same result.

When an Antigravity update changes the DOM, the plugin refuses to inject instead of breaking the UI.

## Wallpaper & Local Files

- Colour extraction uses `fetch` → `blob` → `objectURL` and deliberately avoids `crossOrigin`, which is rejected from the `plugin://` origin.
- "Choose local file" calls `POST /api/pick`, which opens a native dialog (`zenity`) and returns an absolute path — a browser file input only exposes the basename.
- Falls back to a built-in file browser (`GET /api/browse`) when no native dialog is available.
- Load failures report the actual reason (`404` missing, `403` unreadable, decode failure).

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Runtime state and current config |
| GET | `/api/diagnose` | Run the compatibility probe without injecting |
| POST | `/api/inject` | Pre-flight → inject → verify; rolls back on failure (`409` if incompatible) |
| POST | `/api/eject` | Safely remove injected styles |
| GET/POST | `/api/config` | Read or write the persisted config |
| POST | `/api/theme-change` | Apply config live (debounced save) |
| GET | `/api/media?file=` | Media stream with HTTP Range support |
| GET | `/api/media-info?file=` | Pre-flight media check (exists / readable / MIME / reason) |
| POST | `/api/pick` | Native file dialog, returns an absolute path |
| GET | `/api/browse?dir=` | Directory listing of images and videos |

## License

MIT
