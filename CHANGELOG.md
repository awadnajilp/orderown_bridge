# Changelog - OrderOwn Bridge

## [1.0.1] - 2026-03-24

### 🚀 Features
- **Updated Default Paths:** Changed the default image upload path from `/uploads/print/` to `/user-uploads/print/` across the application (`main.js` and `config.html`) to align with server-side changes.

### 🛠 Fixes
- **Printing Layout (Cropping):** 
  - Reduced print image width to `calc(100% - 4mm)` and centered it using `margin: 0 auto`.
  - This provides a **2mm safety margin** on both the left and right sides, preventing thermal printers from cropping content on the edges.
- **RTL & Arabic Support:**
  - Added `lang="ar"` and `dir="rtl"` attributes to the hidden printing window.
  - This ensures that any text-based rendering (if used) respects Right-to-Left alignment and improves Arabic character shaping in the Electron print context.

### 📦 Build Updates
- **Windows Build:** Generated updated NSIS Installers (`.exe`) and Portable executables including the latest layout and path fixes.
