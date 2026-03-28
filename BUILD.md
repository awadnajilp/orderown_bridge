# OrderOwn Bridge — Windows Build Guide

Complete instructions for building a distributable Windows installer (`.exe`) from source.
This is an **internal/private build** — no code-signing certificate is required.

---

## Table of Contents

1. [Project File Structure](#1-project-file-structure)
2. [Prerequisites](#2-prerequisites)
3. [First-Time Setup](#3-first-time-setup)
4. [Preparing Build Assets](#4-preparing-build-assets)
5. [Environment Configuration](#5-environment-configuration)
6. [Building the Windows Package](#6-building-the-windows-package)
7. [Build Outputs](#7-build-outputs)
8. [Installing on a Client Machine](#8-installing-on-a-client-machine)
9. [Troubleshooting](#9-troubleshooting)
10. [Claude Desktop / AI-Assisted Rebuilds](#10-claude-desktop--ai-assisted-rebuilds)

---

## 1. Project File Structure

Your project folder must look exactly like this before building:

```
orderown-bridge/
│
├── main.js                  ← Electron main process
├── preload.js               ← Secure IPC bridge
├── config.html              ← UI window
├── pos80-printer.js         ← Printer driver helper
├── package.json             ← App config + build config
├── .env                     ← Runtime environment variables (optional)
│
└── build/                   ← ALL build assets go here
    ├── icon.ico             ← Windows icon (REQUIRED — see §4)
    ├── icon.png             ← 512×512 PNG used for Linux/macOS
    ├── icon.icns            ← macOS icon (only needed for mac builds)
    ├── ORDEROWN_LOGO.png    ← In-app logo (already included)
    └── installer.nsh        ← NSIS auto-start hook (already included)
```

> **Important:** `electron-builder` looks for icons in `build/` by convention.
> The `icon.ico` file is mandatory for Windows builds.

---

## 2. Prerequisites

Install these on your **build machine** (the developer's PC — not the client's).

### 2a. Node.js (LTS)
- Download from https://nodejs.org — choose **LTS** (v18 or v20)
- During install, check **"Automatically install necessary tools"** (installs Chocolatey + Python + Build Tools)
- Verify: open Command Prompt → `node -v` and `npm -v`

### 2b. Git (optional but recommended)
- https://git-scm.com/download/win

### 2c. ImageMagick (for icon conversion)
- https://imagemagick.org/script/download.php#windows
- Only needed once, to convert the logo PNG → `.ico`
- Verify: `magick --version`

### 2d. Windows Build Tools (if not installed via Node.js setup)
```cmd
npm install --global windows-build-tools
```
Or via PowerShell (Admin):
```powershell
npm install --global --production windows-build-tools
```

---

## 3. First-Time Setup

Open **Command Prompt** (or PowerShell) in your project folder:

```cmd
cd C:\path\to\orderown-bridge

npm install
```

This installs:
- `electron` (the desktop framework)
- `electron-builder` (the packager)
- `axios`, `pusher-js`, `electron-updater`, `dotenv` (runtime deps)

---

## 4. Preparing Build Assets

### 4a. Convert logo to .ico (Windows icon)

`electron-builder` requires a `.ico` file for Windows.
Run this once from the project root:

**Using ImageMagick:**
```cmd
magick convert build\ORDEROWN_LOGO.png ^
  -define icon:auto-resize=256,128,64,48,32,16 ^
  build\icon.ico
```

**Using online converter (no install needed):**
1. Go to https://convertio.co/png-ico/ or https://icoconvert.com
2. Upload `build/ORDEROWN_LOGO.png`
3. Select sizes: **256, 128, 64, 48, 32, 16**
4. Download and save as `build/icon.ico`

**Verify the file exists:**
```cmd
dir build\icon.ico
```

### 4b. Copy the NSIS auto-start script

```cmd
copy installer.nsh build\installer.nsh
```

### 4c. Final build/ folder check

```cmd
dir build\
```

Expected output:
```
icon.ico            ← Windows icon
icon.png            ← Generic PNG (copy of ORDEROWN_LOGO.png works)
ORDEROWN_LOGO.png   ← In-app logo
installer.nsh       ← NSIS startup hook
```

If you don't have a separate `icon.png`, just copy the logo:
```cmd
copy build\ORDEROWN_LOGO.png build\icon.png
```

---

## 5. Environment Configuration

Create a `.env` file in the project root (optional — users can configure via UI):

```env
# Polling interval in milliseconds (default: 4000)
POLLING_INTERVAL=4000

# Set to 'development' to enable DevTools in the window
# NODE_ENV=development
```

The `.env` file is bundled into the installer automatically via `package.json` `files` list.

---

## 6. Building the Windows Package

### Standard build (x64 + x86, NSIS installer + portable)

```cmd
npm run build:win
```

This produces both a **64-bit** and **32-bit** NSIS installer and a **64-bit portable `.exe`**.

### x64 only (faster, most modern PCs)

```cmd
npx electron-builder --win --x64
```

### 32-bit only (for older Windows 7/8 machines)

> **Note:** To support Windows 7, 8, or 8.1, the project must use **Electron 22.x**. 
> (Electron 23 and newer require Windows 10+).
> The `package.json` has been updated to use Electron 22.3.27 for this reason.

```cmd
npm run build:win32
```

This produces a 32-bit installer and portable executable compatible with Windows 7 SP1+.

### Portable executable only (no installer, single .exe)

```cmd
npx electron-builder --win portable --x64
```

### Full cross-platform (win + mac + linux) — requires macOS for mac builds

```cmd
npm run build:all
```

---

### Build output location

All files appear in `dist/`:

```
dist/
├── OrderOwn Bridge Setup 1.0.0.exe          ← NSIS installer (x64)
├── OrderOwn Bridge Setup 1.0.0 (32bit).exe  ← NSIS installer (x86)
├── OrderOwn-Bridge-1.0.0-portable.exe       ← Portable (x64, no install)
└── builder-effective-config.yaml            ← Debug: what builder used
```

---

## 7. Build Outputs Explained

| File | Description | Use case |
|------|-------------|----------|
| `Setup 1.0.0.exe` | Full NSIS installer (x64) | Most Windows 10/11 PCs |
| `Setup 1.0.0 (32bit).exe` | Full NSIS installer (x86) | Older or 32-bit Windows |
| `*-portable.exe` | Single executable, no install needed | USB stick, quick deploy |

**The NSIS installer:**
- Lets the user choose install directory
- Creates a Desktop shortcut + Start Menu entry
- Automatically adds the app to **Windows startup** (via `installer.nsh`)
- Includes an uninstaller (`Add/Remove Programs`)

**The portable exe:**
- Runs without installation
- Stores config in `%APPDATA%\orderown-bridge\` (same as installer)
- Does **not** auto-start on Windows boot

---

## 8. Installing on a Client Machine

### Minimum requirements
- Windows 7 SP1 or later (x64 recommended)
- No additional runtime (Electron bundles its own Node.js + Chromium)
- Printer drivers already installed for the thermal printer(s)

### Steps
1. Copy `OrderOwn Bridge Setup 1.0.0.exe` to the client machine
2. Double-click → click **Next** through the installer
3. App launches automatically after install
4. On first launch, go to **Connection** tab and enter:
   - Domain URL: `https://your-orderown-domain.com`
   - API Key: from your OrderOwn dashboard
5. Click **Test Connection**, then **Save & Start**
6. Go to **Printer Map** → click **Refresh** → map each API printer to a local printer
7. App runs in the **system tray** — look for the OrderOwn icon near the clock

### Auto-start behaviour
The installer registers the app under:
```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OrderOwnBridge
```
It starts silently in the tray when the user logs in. No UAC prompt (runs as the current user).

---

## 9. Troubleshooting

### Build fails: `icon.ico not found`
```
Error: ENOENT: no such file or directory, open 'build/icon.ico'
```
→ Run the ImageMagick command in §4a to create the icon.

### Build fails: `node-gyp` / native module error
```
gyp ERR! build error
```
→ Run: `npm install --global windows-build-tools` (Admin PowerShell)
→ Then retry: `npm install` then `npm run build:win`

### Build hangs or is very slow
→ Normal — first build downloads Electron binaries (~120 MB). Subsequent builds are fast.
→ If it hangs >10 min, check your internet connection. Run:
```cmd
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build:win
```

### Installer builds but app crashes on client
→ Check `%APPDATA%\orderown-bridge\logs\` for crash logs
→ Or enable DevTools: add `NODE_ENV=development` to `.env`, rebuild, and the app will open DevTools on startup

### Antivirus flags the installer
→ Expected for unsigned Electron apps. This is normal for internal tools.
→ Add an exception in the antivirus, or code-sign the build (see below).

### Printer not found after install
→ Make sure the printer driver is installed *before* mapping
→ In **Printer Map**, click **Refresh** after installing the driver
→ The local printer name must match exactly what Windows shows in `Control Panel > Devices and Printers`

---

### Optional: Code Signing (for distribution without antivirus warnings)

Not required for internal use. If needed:

1. Purchase an EV or OV code-signing certificate (~$200-$500/year)
2. Export as `.pfx` file
3. Add to `package.json` `win` section:
```json
"certificateFile": "path/to/cert.pfx",
"certificatePassword": "your-password"
```
4. Rebuild

---

## 10. Claude Desktop / AI-Assisted Rebuilds

This section documents how to use **Claude Desktop** to rebuild, modify, or update OrderOwn Bridge using the project files as context.

### What to attach when asking Claude to modify the app

Always attach these 4 files as context:

| File | Purpose |
|------|---------|
| `main.js` | Electron main process — all printing logic, IPC, polling, Pusher |
| `config.html` | UI — all pages: Dashboard, Connection, Printer Map, Activity, Logs |
| `preload.js` | IPC bridge — the `window.bridge` API surface |
| `pos80-printer.js` | Fallback printer driver — ESC/POS + OS-level print |

Optionally also attach:
- The Laravel `PrintJobController.php` (so Claude knows the exact API contract)
- `package.json` (so Claude knows the build/dependency config)

---

### Example prompts for Claude

**Add a new feature:**
> "I've attached main.js, config.html, preload.js, and PrintJobController.php.
> Add a retry mechanism so failed print jobs are automatically retried up to 3 times with a 10-second delay before being marked permanently failed."

**Fix a bug:**
> "Attached: main.js. The app sometimes prints the same job twice when Pusher and polling overlap. Fix this."

**Update API integration:**
> "The API now has a new endpoint GET /api/print-jobs/{id}/status that returns the current job status. Integrate this so the client can verify a job was actually received by the server before marking it done."

**Restyle the UI:**
> "Attached: config.html and ORDEROWN_LOGO.png. Redesign the Dashboard page to show a larger live job counter and add a printer status summary card for each mapped printer."

---

### Context Claude needs to build well

When prompting Claude about this codebase, always clarify:

1. **API contract** — The app talks to Laravel at these endpoints:
   - `GET  /api/test-connection`       → test auth + get Pusher config
   - `GET  /api/printer-details`       → list all branch printers
   - `GET  /api/print-jobs/pull-multiple` → fetch all pending jobs (returns array)
   - `PATCH /api/print-jobs/{id}`      → mark job done/failed
   - Headers: `X-TABLETRACK-KEY: {apiKey}`

2. **Job structure** from `pull-multiple`:
   ```json
   {
     "id": 123,
     "image_filename": "receipt_abc.png",
     "is_copy": false,
     "printer": {
       "id": 1,
       "name": "Kitchen Printer",
       "print_format": "80mm",
       "share_name": "KP1",
       "type": "thermal",
       "printing_choice": "directPrint",
       "parent_printer_id": null
     }
   }
   ```

3. **PATCH body** (update endpoint validator):
   ```json
   {
     "status":     "done",          // required: done|failed
     "printed_at": "2024-01-01T...", // nullable — only send when done
     "printer":    "local name",    // nullable — local printer name used
     "error":      "message"        // nullable — only send when failed
   }
   ```

4. **Printing flow**: Jobs contain `image_filename` (a PNG). The client downloads `{domainUrl}/uploads/print/{image_filename}` and prints it via Electron's `webContents.print()` into a hidden BrowserWindow, sized to the printer's paper format.

5. **Pusher events** — two types may arrive:
   - Full job object (enqueue directly)
   - Trigger-only `{type:'print_job_created'}` (call `poll()` to fetch)

---

### Rebuilding from scratch with Claude Desktop

If you need a full rebuild:

1. Open Claude Desktop
2. Attach: `main.js`, `config.html`, `preload.js`, `pos80-printer.js`, `PrintJobController.php`, `ORDEROWN_LOGO.png`
3. Use this prompt:

```
I'm rebuilding an Electron app called "OrderOwn Bridge" — a desktop print bridge 
that connects to a Laravel REST API and prints thermal receipt images to local printers.

Attached files:
- main.js / preload.js / config.html / pos80-printer.js — existing app code
- PrintJobController.php — the Laravel API controller (source of truth for API contract)
- ORDEROWN_LOGO.png — the brand logo (use as app icon and in-app header)

Please rebuild the app with:
[describe your requirements here]

Keep all existing API integration logic (endpoints, PATCH body format, Pusher handling).
Use the ORDEROWN_LOGO.png as the app icon and sidebar logo.
```

---

## 11. Printing Logic & Technical Specifications

The application follows a strict hierarchical logic to ensure maximum compatibility and reliability, especially for RTL/Arabic character support.

### 11a. The "Gold" Rule: Payload Prioritization
The client app always prioritizes the `payload` object over the `image_filename`.
*   **If `payload` exists and contains data:** The app uses the engine specified in `payload.print_type` (`html` or `escpos`).
*   **If `payload` is null or empty:** The app falls back to downloading and printing the `image_filename`.

### 11b. Rendering Engines

| Engine | Data Source | Logic | Technical Detail |
|--------|-------------|-------|------------------|
| **HTML** | `payload.html_content` | Renders HTML string in a headless Chromium window. | Fixed Width: **576px** (80mm) or **384px** (58mm) @ 203 DPI. |
| **ESC/POS** | `payload.escpos_base64` | Decodes Base64 binary commands. | Sent directly to printer port without modification. |
| **IMAGE** | `image_filename` | Downloads PNG/JPG from `{APP_URL}/user-uploads/print/`. | Rasterized and printed via Electron's graphic engine. |

### 11c. Smart Fallback Mechanism
If an **IMAGE** print job fails (e.g., file missing on server), the app performs the following:
1.  Calls `POST /api/print-jobs/{id}/fallback-to-escpos`.
2.  If the server returns a text-based payload, the job is **re-queued at the front** and printed immediately using the ESC/POS engine.

### 11d. Connection & Queue Management
*   **Status Updates:** Every job attempt is reported back to the server as `done` or `failed` via `PATCH /api/print-jobs/{id}`.
*   **Ghost Job Guard:** If a job remains in the "printing" status for more than **5 minutes**, the client app treats it as a ghost job and skips it to prevent queue blockage.
*   **Arabic Support:** HTML rendering at fixed pixel widths ensures that RTL text and Arabic font shaping are preserved exactly as intended, regardless of the printer's internal font capabilities.

---

*Last updated: built for OrderOwn Bridge v1.0.0*
