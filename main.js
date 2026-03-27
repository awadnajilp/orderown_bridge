'use strict';

const { app, BrowserWindow, ipcMain, Tray, nativeImage, Menu, shell } = require('electron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const { autoUpdater } = require('electron-updater');
require('dotenv').config();

// ─────────────────────────────────────────────
//  Constants & globals (Lazy-loaded to avoid premature app.getPath calls)
// ─────────────────────────────────────────────
let CONFIG_PATH = null;
function getConfigPath() {
    if (!CONFIG_PATH) CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
    return CONFIG_PATH;
}

const ICON_PATH     = path.join(__dirname, 'build/icon.png');
const LOGO_PATH     = path.join(__dirname, 'build/ORDEROWN_LOGO.png');

// Disable GPU acceleration for Windows 7 stability if needed
// (Commonly fixes "app starts but no window" on old drivers)
if (os.platform() === 'win32') {
    app.disableHardwareAcceleration();
}

// Startup Crash Logger: write errors to a local file if the UI fails to launch
const CRASH_LOG = path.join(os.tmpdir(), 'orderown-bridge-crash.log');
process.on('uncaughtException', (err) => {
    const msg = `[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${err.stack || err}\n`;
    fs.appendFileSync(CRASH_LOG, msg);
    console.error(msg);
    app.quit();
});

const POLL_INTERVAL_DEFAULT = parseInt(process.env.POLLING_INTERVAL, 10) || 4000;
// Dynamic helper: reads from saved config so UI changes take effect without restart
function getPollInterval() {
    try {
        const cfg = loadConfig();
        const v = parseInt(cfg.pollInterval, 10);
        return (!isNaN(v) && v >= 1000) ? v : POLL_INTERVAL_DEFAULT;
    } catch { return POLL_INTERVAL_DEFAULT; }
}
// Primary endpoint (array, new API). Falls back to /pull (single-job, old API) on 404.
const PULL_ENDPOINT_MULTI  = '/api/print-jobs/pull-multiple';
const PULL_ENDPOINT_SINGLE = '/api/print-jobs/pull';
const PATCH_BASE    = '/api/print-jobs';
const IMAGE_PATH    = '/user-uploads/print/';

// Tracks which endpoint works — discovered on first successful poll
// 'multi' | 'single' | null (not yet discovered)
let activeEndpoint = null;

let configWindow    = null;
let tray            = null;
let pollingTimer    = null;
let jobQueue        = [];
let isProcessing    = false;

// ─── Pusher ───────────────────────────────────
let pusherClient    = null;
let pusherChannel   = null;
let isPusherActive  = false;
let pusherConfig    = null;

// ─────────────────────────────────────────────
//  Structured logger (ring-buffer, max 300 lines)
// ─────────────────────────────────────────────
const LOG_SIZE = 300;
const logs = [];

function log(level, ...parts) {
    const now    = new Date();
    const ts     = now.toISOString();   // UTC — used for sorting only
    // Local system time string (respects OS timezone)
    const localTs = now.toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const msg = parts.map(p => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join(' ');
    const line = { ts, localTs, level, msg };
    logs.push(line);
    if (logs.length > LOG_SIZE) logs.shift();

    // forward to renderer
    if (configWindow && !configWindow.isDestroyed()) {
        configWindow.webContents.send('log', line);
    }

    const prefix = { INFO: '•', WARN: '⚠', ERROR: '✖', OK: '✓', PRINT: '🖨' }[level] || '·';
    console[level === 'ERROR' ? 'error' : 'log'](`[${ts}] ${prefix} ${msg}`);
}

// ─────────────────────────────────────────────
//  Config helpers
// ─────────────────────────────────────────────
function loadConfig() {
    try {
        const p = getConfigPath();
        if (fs.existsSync(p)) {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
    } catch (e) {
        log('ERROR', 'loadConfig failed:', e.message);
    }
    return { domainUrl: '', key: '', printerMappings: {}, imageUrlPath: IMAGE_PATH, pollInterval: 4000 };
}

function saveConfig(cfg) {
    try {
        const p = getConfigPath();
        const existing = loadConfig();
        // preserve printerMappings if not explicitly passed
        if (!cfg.printerMappings && existing.printerMappings) {
            cfg.printerMappings = existing.printerMappings;
        }
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
        return true;
    } catch (e) {
        log('ERROR', 'saveConfig failed:', e.message);
        return false;
    }
}

function apiHeaders(key) {
    return key ? { 'X-TABLETRACK-KEY': key, 'Accept': 'application/json' } : { 'Accept': 'application/json' };
}

// ─────────────────────────────────────────────
//  System printer listing (cross-platform)
// ─────────────────────────────────────────────
async function listSystemPrinters() {
    if (os.platform() === 'win32') {
        return listSystemPrintersWin();
    }
    return new Promise((resolve) => {
        exec('lpstat -p 2>/dev/null', { timeout: 5000 }, (err, stdout) => {
            if (err || !stdout.trim()) return resolve([]);
            const printers = [];
            stdout.split('\n').forEach(line => {
                const m = line.match(/^printer\s+(\S+)\s+is\s+([^.]+)/);
                if (m) printers.push({ name: m[1], status: m[2].trim() });
            });
            resolve(printers);
        });
    });
}

// Windows: query BOTH Get-Printer (catches network/shared) AND Win32_Printer
// (catches some legacy drivers), then merge and deduplicate by name.
async function listSystemPrintersWin() {
    const run = (cmd) => new Promise((res) => {
        exec(cmd, { timeout: 10000 }, (err, stdout) => {
            if (err) {
                console.error(`Printer discovery command failed: ${cmd}\nError: ${err.message}`);
            }
            res(err || !stdout.trim() ? null : stdout.trim());
        });
    });

    // Method 1: Get-Printer — most complete; works on Win8+/Server2012+
    const gpCmd = `powershell -NoProfile -Command "Get-Printer | Select-Object Name,PrinterStatus,Shared,ShareName | ConvertTo-Json -Compress"`;
    // Method 2: WMI — fallback, broader driver support
    const wmiCmd = `powershell -NoProfile -Command "Get-WmiObject -Class Win32_Printer | Select-Object Name,WorkOffline,ShareName | ConvertTo-Json -Compress"`;
    // Method 3: WMIC — legacy fallback for very old drivers / virtual printers
    const legacyCmd = `wmic printer get Name /value`;

    const [gpOut, wmiOut, legacyOut] = await Promise.all([run(gpCmd), run(wmiCmd), run(legacyCmd)]);

    const seen = new Map(); // name.toLowerCase() → {name, status, shareName}

    // Parse Get-Printer output
    if (gpOut) {
        try {
            let arr = JSON.parse(gpOut);
            if (!Array.isArray(arr)) arr = [arr];
            for (const p of arr) {
                if (!p.Name) continue;
                const key = p.Name.toLowerCase();
                if (!seen.has(key)) {
                    const offline = p.PrinterStatus === 6 || p.PrinterStatus === 5;
                    seen.set(key, {
                        name:      p.Name,
                        status:    offline ? 'offline' : 'ready',
                        shareName: p.ShareName || '',
                        shared:    !!p.Shared,
                    });
                }
            }
        } catch (e) { console.error('Failed to parse Get-Printer JSON:', e.message); }
    }

    // Parse WMI output
    if (wmiOut) {
        try {
            let arr = JSON.parse(wmiOut);
            if (!Array.isArray(arr)) arr = [arr];
            for (const p of arr) {
                if (!p.Name) continue;
                const key = p.Name.toLowerCase();
                if (!seen.has(key)) {
                    seen.set(key, {
                        name:      p.Name,
                        status:    p.WorkOffline ? 'offline' : 'ready',
                        shareName: p.ShareName || '',
                        shared:    false,
                    });
                }
            }
        } catch (e) { console.error('Failed to parse Win32_Printer JSON:', e.message); }
    }

    // Parse Legacy WMIC output (simple Name=PrinterName lines)
    if (legacyOut) {
        legacyOut.split(/\r?\n/).forEach(line => {
            if (line.startsWith('Name=')) {
                const name = line.substring(5).trim();
                if (name && !seen.has(name.toLowerCase())) {
                    seen.set(name.toLowerCase(), {
                        name,
                        status: 'ready',
                        shareName: '',
                        shared: false
                    });
                }
            }
        });
    }

    // Return unique printers by actual Name
    const unique = new Map();
    for (const p of seen.values()) {
        const k = p.name.toLowerCase();
        if (!unique.has(k)) unique.set(k, p);
    }
    const result = Array.from(unique.values());
    log('INFO', `Discovered ${result.length} local printers on Windows`);
    return result;
}

async function printerExists(name) {
    if (!name) return false;
    if (os.platform() !== 'win32') {
        return new Promise((resolve) => {
            exec(`lpstat -p "${name}" 2>/dev/null`, { timeout: 3000 }, (err) => resolve(!err));
        });
    }
    // Windows: check installed printers list (already enriched from both sources)
    const printers = await listSystemPrintersWin();
    const n = name.toLowerCase();
    return printers.some(p =>
        p.name.toLowerCase() === n ||
        (p.shareName && p.shareName.toLowerCase() === n)
    );
}

async function findSystemPrinter(name) {
    if (!name) return null;
    const printers = await listSystemPrinters();
    const n = name.toLowerCase();
    return printers.find(p =>
        p.name.toLowerCase() === n ||
        (p.shareName && p.shareName.toLowerCase() === n)
    ) || null;
}

// ─────────────────────────────────────────────
//  Image printing via Electron hidden BrowserWindow
//  (cross-platform, handles PNG/JPG receipts, auto paper size)
// ─────────────────────────────────────────────
function formatToWidth(fmt) {
    // Returns width in microns (1 mm = 1000 µm).
    // Handles: '80', '80mm', '58mm', '58', 'A4', 'a4', null
    if (!fmt) return 80000;
    const s = String(fmt).toLowerCase().trim();
    if (s === 'a4')     return 210000;
    if (s === 'a5')     return 148000;
    if (s === 'letter') return 216000;
    // Extract leading integer (e.g. '80mm' → 80, '58mm' → 58)
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n * 1000;
    return 80000; // fallback 80 mm
}

async function printImageJob(imageUrl, localPrinterName, printFormat) {
    const widthMicrons  = formatToWidth(printFormat);
    const widthMm       = widthMicrons / 1000;

    log('PRINT', `Sending to [${localPrinterName}] | format: ${widthMm}mm | url: ${imageUrl}`);

    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            show:   false,
            width:  Math.round(widthMm * 3.78), // approx px at 96 dpi
            height: 1200,
            webPreferences: {
                nodeIntegration:  false,
                contextIsolation: true,
                sandbox:          true,
            },
        });

        // Disable window.print() calls inside the HTML to prevent popups
        win.webContents.on('will-prevent-unload', (event) => event.preventDefault());

        // Timeout safety net
        const TIMEOUT = 40_000;
        const timeoutId = setTimeout(() => {
            if (!win.isDestroyed()) win.destroy();
            reject(new Error('Print timeout after 40 s'));
        }, TIMEOUT);

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (!win.isDestroyed()) win.destroy();
        };

        const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  @page {
    margin: 0;
    size: ${widthMm}mm auto;
  }
  html, body {
    width: ${widthMm}mm;
    margin: 0;
    padding: 0;
    background: #fff;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    overflow: hidden;
  }
  img {
    display: block;
    width: calc(100% - 4mm);
    margin: 0 auto;
    height: auto;
    page-break-inside: avoid;
  }
</style>
</head>
<body>
  <img
    src="${imageUrl}"
    onload="document.title='READY'"
    onerror="document.title='ERROR'"
  />
</body>
</html>`;

        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

        win.webContents.on('did-finish-load', () => {
            // Poll for image readiness (load/error event via title)
            let tries = 0;
            const waitForImage = setInterval(() => {
                tries++;
                win.webContents.executeJavaScript('document.title').then(title => {
                    if (title === 'ERROR') {
                        clearInterval(waitForImage);
                        cleanup();
                        reject(new Error(`Failed to load image: ${imageUrl}`));
                        return;
                    }
                    if (title === 'READY' || tries > 30) {
                        clearInterval(waitForImage);
                        // Extra render tick
                        setTimeout(() => {
                            if (win.isDestroyed()) { reject(new Error('Window destroyed before print')); return; }

                            win.webContents.print(
                                {
                                    silent:          true,
                                    printBackground: true,
                                    deviceName:      localPrinterName,
                                    pageSize: {
                                        width:  widthMicrons,
                                        height: 2_000_000, // 2m tall; printer auto-trims
                                    },
                                    margins: { marginType: 'none' },
                                },
                                (success, failureReason) => {
                                    cleanup();
                                    if (success) {
                                        log('OK', `Print succeeded on [${localPrinterName}]`);
                                        resolve();
                                    } else {
                                        reject(new Error(failureReason || 'Print failed (unknown reason)'));
                                    }
                                }
                            );
                        }, 300);
                    }
                }).catch(() => { /* ignore JS eval errors */ });
            }, 200);
        });

        win.webContents.on('did-fail-load', (_e, code, desc) => {
            cleanup();
            reject(new Error(`Window load failed: ${desc} (${code})`));
        });
    });
}

async function printHtmlJob(htmlContent, localPrinterName, printFormat) {
    const widthMicrons  = formatToWidth(printFormat);
    const widthMm       = widthMicrons / 1000;
    
    // Standard thermal printer dot density (8 dots/mm)
    // 80mm printer (72mm printable) -> 576px
    // 58mm printer (48mm printable) -> 384px
    const renderWidth = widthMm >= 80 ? 576 : 384;

    log('PRINT', `Rendering HTML at ${renderWidth}px for [${localPrinterName}]`);

    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            show:   false,
            width:  renderWidth,
            height: 1200,
            webPreferences: {
                nodeIntegration:  false,
                contextIsolation: true,
                sandbox:          true,
            },
        });

        // Block any window.print() or other dialogs in the HTML
        win.webContents.on('will-prevent-unload', (event) => event.preventDefault());

        const TIMEOUT = 40_000;
        const timeoutId = setTimeout(() => {
            if (!win.isDestroyed()) win.destroy();
            reject(new Error('HTML Print timeout after 40 s'));
        }, TIMEOUT);

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (!win.isDestroyed()) win.destroy();
        };

        // Safety: Strip any window.print(), print() or event-based triggers from the content itself
        const safeHtml = htmlContent
            .replace(/window\.print\(\)/g, 'console.log("window.print blocked")')
            .replace(/\bprint\(\)/g, 'console.log("print blocked")')
            .replace(/onload="window\.print\(\)"/g, '')
            .replace(/onload="print\(\)"/g, '');

        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(safeHtml));

        win.webContents.on('did-finish-load', () => {
            // Wait 500ms for fonts to render as requested
            setTimeout(() => {
                if (win.isDestroyed()) {
                    reject(new Error('Window destroyed before HTML print'));
                    return;
                }

                // Log exactly what we are sending to Electron print
                log('INFO', `Silent print triggered on [${localPrinterName}] with width ${widthMm}mm`);

                win.webContents.print(
                    {
                        silent:          true,
                        printBackground: true,
                        deviceName:      localPrinterName,
                        pageSize: {
                            width:  widthMicrons,
                            height: 2_000_000, // 2m tall; printer auto-trims
                        },
                        margins: { marginType: 'none' },
                    },
                    (success, failureReason) => {
                        cleanup();
                        if (success) {
                            log('OK', `HTML Print succeeded on [${localPrinterName}]`);
                            resolve();
                        } else {
                            // If silent fails, log the EXACT error
                            log('ERROR', `Silent print FAILED on [${localPrinterName}]: ${failureReason}`);
                            reject(new Error(failureReason || 'HTML Print failed (unknown reason)'));
                        }
                    }
                );
            }, 500); // 500ms delay for fonts
        });

        win.webContents.on('did-fail-load', (_e, code, desc) => {
            cleanup();
            reject(new Error(`HTML Window load failed: ${desc} (${code})`));
        });
    });
}

// Fallback: OS-level raw ESC/POS buffer print (for old API compatibility)
async function printFileFallback(localPrinterName, rawBuffer) {
    return new Promise((resolve, reject) => {
        const tmpPath = require('path').join(require('os').tmpdir(), `oo_print_${Date.now()}.bin`);
        require('fs').writeFileSync(tmpPath, rawBuffer);
        let cmd;
        if (os.platform() === 'win32') {
            cmd = `copy /b "${tmpPath}" "\\\\localhost\\${localPrinterName}"`;
        } else {
            cmd = `lp -d "${localPrinterName}" "${tmpPath}"`;
        }
        exec(cmd, { timeout: 15_000 }, (err, _out, stderr) => {
            try { require('fs').unlinkSync(tmpPath); } catch {}
            if (err) reject(new Error(stderr || err.message));
            else resolve();
        });
    });
}

// Helper to unescape \xHH sequences into a Buffer
function unescapeEscPos(text) {
    if (!text) return Buffer.alloc(0);
    // Matches \x followed by exactly 2 hex digits
    return Buffer.from(
        text.replace(/\\x([0-9A-Fa-f]{2})/g, (match, hex) => {
            return String.fromCharCode(parseInt(hex, 16));
        }),
        'binary'
    );
}

// ─────────────────────────────────────────────
//  Job Queue  (sequential processing, no parallel prints)
// ─────────────────────────────────────────────
async function processQueue() {
    if (isProcessing || jobQueue.length === 0) return;
    isProcessing = true;

    while (jobQueue.length > 0) {
        const job = jobQueue.shift();
        // Skip jobs that are too old and might be "ghosts" (handled by server, but we guard here too)
        const ageInMinutes = (new Date() - new Date(job.updated_at || job.created_at)) / 60000;
        if (job.status === 'printing' && ageInMinutes > 5) {
            log('WARN', `Skipping ghost job #${job.id} (stuck in printing for ${Math.round(ageInMinutes)} mins)`);
            continue;
        }
        await processSingleJob(job);
    }

    isProcessing = false;
}

async function processSingleJob(job) {
    const cfg = loadConfig();
    const base = cfg.domainUrl.replace(/\/+$/, '');
    const headers = apiHeaders(cfg.key);

    // ── 1. Payload Prioritization (The "Gold" Rule) ──────────────────
    const htmlContent   = job.payload?.html_content || null;
    const escposBase64  = job.payload?.escpos_base64 || null;
    const escposLegacy  = job.payload?.text || job.text || null;
    const imageFilename = job.image_filename || null;

    // A payload is only "present" if it has actual data or a defined type
    const hasPayload    = !!(job.payload && (job.payload.print_type || htmlContent || escposBase64 || escposLegacy));

    // Determine engine: HTML > ESCPOS > IMAGE (Fallback)
    let printType = 'escpos'; // baseline
    if (hasPayload) {
        printType = job.payload.print_type || (htmlContent ? 'html' : 'escpos');
    } else if (imageFilename) {
        printType = 'image';
    }

    const apiPrinterName    = job.printer?.name || job.printer_name || '';
    const printFormat       = job.printer?.print_format || '80mm';
    const isCopy            = !!job.is_copy;
    const copyTag           = isCopy ? ' [COPY]' : '';

    log('INFO', `Job #${job.id} | Engine: ${printType.toUpperCase()} | Printer: "${apiPrinterName}"${copyTag}`);
    emit('job-start', { id: job.id, printer: apiPrinterName, file: imageFilename || `(${printType})`, isCopy });

    // ── Resolve local printer ────────────────────────────────────────
    const mappedName = cfg.printerMappings?.[apiPrinterName];
    const systemPrinter = mappedName ? await findSystemPrinter(mappedName) : null;
    
    if (!systemPrinter) {
        const reason = !mappedName 
            ? `No local printer mapped for "${apiPrinterName}"` 
            : `Local printer "${mappedName}" not found`;
        log('WARN', `Job #${job.id}: ${reason}`);
        emit('job-fail', { id: job.id, reason });
        await patchJob(`${base}${PATCH_BASE}/${job.id}`, 'failed', { error: reason }, headers);
        return;
    }
    const localPrinterName = systemPrinter.name;

    try {
        if (printType === 'html') {
            if (!htmlContent) throw new Error('HTML content missing in payload');
            await printHtmlJob(htmlContent, localPrinterName, printFormat);
        } 
        else if (printType === 'escpos') {
            const rawBuffer = escposBase64 ? Buffer.from(escposBase64, 'base64') : unescapeEscPos(escposLegacy);
            if (!rawBuffer || rawBuffer.length === 0) throw new Error('ESC/POS data missing');
            await printFileFallback(localPrinterName, rawBuffer);
        } 
        else if (printType === 'image') {
            const imagePath = (cfg.imageUrlPath || IMAGE_PATH).replace(/\/*$/, '/');
            const imageUrl  = `${base}${imagePath}${imageFilename}`;
            try {
                await printImageJob(imageUrl, localPrinterName, printFormat);
            } catch (imgErr) {
                log('WARN', `Image failed, attempting ESC/POS fallback for Job #${job.id}: ${imgErr.message}`);
                // ── 5. Fallback to ESC/POS API Call ──────────────────────
                try {
                    const fallbackUrl = `${base}${PATCH_BASE}/${job.id}/fallback-to-escpos`;
                    const res = await axios.post(fallbackUrl, {}, { headers, timeout: 8000 });
                    if (res.data && res.data.payload) {
                        log('INFO', `Fallback payload received for Job #${job.id} — re-queuing`);
                        jobQueue.unshift(res.data); // put back at front with new payload
                        return;
                    }
                } catch (fallbackApiErr) {
                    log('ERROR', `Fallback API failed: ${fallbackApiErr.message}`);
                }
                throw imgErr; // re-throw if fallback fails
            }
        }

        emit('job-done', { id: job.id, printer: localPrinterName });
        await patchJob(`${base}${PATCH_BASE}/${job.id}`, 'done', { printer: localPrinterName }, headers);
        log('OK', `Job #${job.id} → DONE`);
    } catch (err) {
        log('ERROR', `Job #${job.id} Error: ${err.message}`);
        emit('job-fail', { id: job.id, reason: err.message });
        await patchJob(`${base}${PATCH_BASE}/${job.id}`, 'failed', { error: err.message }, headers);
    }
}

async function patchJob(url, status, extra = {}, headers = {}) {
    // Controller validates status as in:done,failed only.
    // printed_at is only semantically valid for a successful print.
    const body = { status, ...extra };
    if (status === 'done') {
        body.printed_at = new Date().toISOString();
    }
    try {
        await axios.patch(url, body, { headers, timeout: 8000 });
    } catch (e) {
        log('WARN', `PATCH ${url} → ${e.response?.status || e.code}: ${e.message}`);
    }
}

function emit(event, data) {
    if (configWindow && !configWindow.isDestroyed()) {
        configWindow.webContents.send(event, data);
    }
}

// ─────────────────────────────────────────────
//  Universal API response → job array normalizer
//  Handles every response shape the server might send:
//   • []                        — new API, array of jobs
//   • [{id,image_filename,...}] — new API, populated
//   • {id, image_filename, ...} — single job object (old /pull endpoint)
//   • {data: [...]}             — Laravel pagination wrapper
//   • {jobs: [...]}             — alternative wrapper
//   • null / 204               — no pending jobs
// ─────────────────────────────────────────────
function normalizeJobsResponse(data, httpStatus) {
    // 204 No Content = nothing pending
    if (httpStatus === 204 || data === null || data === undefined) {
        log('INFO', 'Poll: server returned no pending jobs (204/empty)');
        return [];
    }

    // Bare array (new pull-multiple)
    if (Array.isArray(data)) {
        log('INFO', `Poll: server returned array with ${data.length} job(s)`);
        return data;
    }

    // Laravel pagination / wrapped array
    if (data && Array.isArray(data.data)) {
        log('INFO', `Poll: server returned wrapped array (data.data) with ${data.data.length} job(s)`);
        return data.data;
    }
    if (data && Array.isArray(data.jobs)) {
        log('INFO', `Poll: server returned wrapped array (data.jobs) with ${data.jobs.length} job(s)`);
        return data.jobs;
    }

    // Single job object (old /pull endpoint) — wrap in array
    if (data && (data.id !== undefined || data.image_filename || data.payload)) {
        log('INFO', `Poll: server returned single job object (id=${data.id}) — treating as array of 1`);
        return [data];
    }

    // Unknown shape — log raw for debugging
    log('WARN', `Poll: unrecognised response shape: ${JSON.stringify(data).substring(0, 200)}`);
    return [];
}

// ─────────────────────────────────────────────
//  Polling — dual-endpoint with auto-discovery
// ─────────────────────────────────────────────

// Try to GET from a single endpoint; returns { data, status } or throws
async function fetchPollEndpoint(url, headers) {
    const res = await axios.get(url, { headers, timeout: 10_000 });
    return { data: res.data, status: res.status };
}

async function poll() {
    const cfg = loadConfig();
    if (!cfg.domainUrl || !cfg.key) return;

    const base    = cfg.domainUrl.replace(/\/+$/, '');
    const headers = apiHeaders(cfg.key);
    const now     = new Date();
    const tickBase = {
        ts:      now.toISOString(),
        localTs: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    };

    let rawData    = null;
    let httpStatus = 200;
    let usedEndpoint = '';

    try {
        // ── Step 1: resolve which endpoint to use ─────────────────────
        if (activeEndpoint === 'multi' || activeEndpoint === null) {
            const multiUrl = base + PULL_ENDPOINT_MULTI;
            try {
                const r = await fetchPollEndpoint(multiUrl, headers);
                rawData    = r.data;
                httpStatus = r.status;
                usedEndpoint = 'pull-multiple';
                if (activeEndpoint === null) {
                    activeEndpoint = 'multi';
                    log('OK', `Endpoint discovery: using ${PULL_ENDPOINT_MULTI}`);
                }
            } catch (e404) {
                if (e404.response?.status === 404) {
                    // pull-multiple not available — try legacy /pull
                    log('WARN', `${PULL_ENDPOINT_MULTI} returned 404 — trying legacy ${PULL_ENDPOINT_SINGLE}`);
                    activeEndpoint = 'single';
                } else {
                    throw e404; // real error, re-throw
                }
            }
        }

        if (activeEndpoint === 'single' && rawData === null) {
            const singleUrl = base + PULL_ENDPOINT_SINGLE;
            try {
                const r = await fetchPollEndpoint(singleUrl, headers);
                rawData    = r.data;
                httpStatus = r.status;
                usedEndpoint = 'pull';
            } catch (eSingle) {
                if (eSingle.response?.status === 404) {
                    // Neither endpoint exists — log prominently
                    log('ERROR', `Both poll endpoints returned 404. Check server config. Multi: ${PULL_ENDPOINT_MULTI}  Single: ${PULL_ENDPOINT_SINGLE}`);
                    emit('poll-error', { msg: 'Poll endpoint not found (404). Check Domain URL and API key.' });
                    emit('poll-tick', { ...tickBase, count: 0, error: '404 — endpoint not found' });
                    return;
                }
                throw eSingle;
            }
        }

        // ── Step 2: normalise response to array of jobs ────────────────
        const jobs = normalizeJobsResponse(rawData, httpStatus);

        // ── Step 3: emit heartbeat tick ────────────────────────────────
        emit('poll-tick', {
            ...tickBase,
            count:    jobs.length,
            endpoint: usedEndpoint,
        });

        if (jobs.length === 0) return;

        log('INFO', `Pulled ${jobs.length} job(s) via /${usedEndpoint}`);
        emit('poll-jobs', { count: jobs.length });

        // ── Step 4: enqueue (dedup by id) ─────────────────────────────
        let enqueued = 0;
        jobs.forEach(j => {
            if (!j.id) {
                log('WARN', `Poll: job with no id skipped: ${JSON.stringify(j).substring(0, 100)}`);
                return;
            }
            if (!jobQueue.find(q => q.id === j.id)) {
                jobQueue.push(j);
                enqueued++;
            }
        });

        if (enqueued > 0) {
            log('INFO', `Enqueued ${enqueued} new job(s) — queue size: ${jobQueue.length}`);
            processQueue();
        } else {
            log('INFO', `${jobs.length} job(s) already in queue — skipping re-enqueue`);
        }

    } catch (e) {
        const statusCode = e.response?.status;
        const errMsg     = e.response?.data?.message || e.message;

        // Always log, always show in UI — no silent swallowing
        if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
            log('WARN', `Poll: cannot reach server (${e.code}): ${cfg.domainUrl}`);
        } else if (statusCode === 401 || statusCode === 403) {
            log('ERROR', `Poll: authentication failed (HTTP ${statusCode}) — check your API key`);
            emit('poll-error', { msg: `Auth failed (${statusCode}) — check API key` });
        } else {
            log('WARN', `Poll error (${statusCode || e.code || 'unknown'}): ${errMsg}`);
            emit('poll-error', { msg: errMsg });
        }

        emit('poll-tick', { ...tickBase, count: 0, error: `${statusCode || e.code}: ${errMsg}` });
    }
}

function startPolling() {
    if (pollingTimer) clearInterval(pollingTimer);
    const interval = getPollInterval();
    pollingTimer = setInterval(poll, interval);
    log('INFO', `Polling started every ${interval / 1000}s`);
    emit('polling-state', { active: true, running: true, mode: 'polling', interval });
    poll(); // immediate first poll
}

function stopPolling() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
    }
    log('INFO', 'Polling stopped');
    emit('polling-state', { active: false, running: false, mode: 'stopped' });
}

// ─────────────────────────────────────────────
//  Pusher
// ─────────────────────────────────────────────
function initPusher(cfg) {
    try {
        const Pusher = require('pusher-js');
        if (pusherClient) { pusherClient.disconnect(); }

        pusherClient = new Pusher(cfg.key, {
            cluster: cfg.cluster || 'mt1',
            forceTLS: true,
        });

        pusherChannel = pusherClient.subscribe(cfg.channel || 'print-jobs');
        const eventName = cfg.event || 'print-job.created';

        pusherChannel.bind(eventName, (data) => {
            log('INFO', 'Pusher event received');
            handlePusherJob(data);
        });

        pusherClient.connection.bind('connected', () => {
            isPusherActive = true;
            pusherConfig   = cfg;
            stopPolling();   // stop polling — pusher takes over
            log('OK', 'Pusher connected — live print mode active');
            // Emit full state so ALL UI elements (sidebar + dashboard + badge) update
            emit('pusher-state',  { active: true,  running: true, mode: 'pusher' });
            emit('polling-state', { active: false, running: false, mode: 'pusher' });
        });

        pusherClient.connection.bind('disconnected', () => {
            isPusherActive = false;
            log('WARN', 'Pusher disconnected — falling back to polling');
            emit('pusher-state', { active: false, running: false, mode: 'polling' });
            startPolling();  // startPolling emits its own polling-state event
        });

        pusherClient.connection.bind('error', (err) => {
            log('ERROR', 'Pusher error:', err?.data?.message || 'unknown');
            emit('pusher-state', { active: false, running: false, mode: 'error', error: err?.data?.message });
        });

        return true;
    } catch (e) {
        log('ERROR', 'Pusher init failed:', e.message);
        return false;
    }
}

function disconnectPusher() {
    if (pusherClient) {
        pusherClient.disconnect();
        pusherClient  = null;
        pusherChannel = null;
    }
    isPusherActive = false;
    emit('pusher-state', { active: false, running: false, mode: 'stopped' });
}

async function handlePusherJob(data) {
    // The server can push two kinds of events:
    //   A) Full job object  { id, image_filename, printer: {...}, is_copy, ... }
    //   B) Trigger-only     { type: 'print_job_created' } or similar stub
    //
    // For (A): enqueue and process directly.
    // For (B): call poll() to fetch all pending jobs via pull-multiple.

    const job = data.job || data;

    if (job && job.image_filename) {
        // Full payload — process directly
        log('INFO', `Pusher: direct job payload — job #${job.id} | printer: ${job.printer?.name || '?'}`);
        if (!jobQueue.find(q => q.id === job.id)) {
            jobQueue.push(job);
        }
        processQueue();
    } else {
        // Trigger-only or unrecognised shape — fetch pending jobs from API
        log('INFO', `Pusher: trigger event (type="${data.type || 'unknown'}") — fetching pending jobs`);
        await poll();
    }
}

// ─────────────────────────────────────────────
//  Printer mapping helpers
// ─────────────────────────────────────────────
function autoMapPrinters(apiPrinters, localPrinters) {
    // apiPrinters come from printerDetails with fields:
    //   id, name, printing_choice, print_format, share_name, type, parent_printer_id
    return apiPrinters.map(ap => {
        const name  = (ap.name       || '').toLowerCase();
        const share = (ap.share_name || '').toLowerCase();

        const exact   = localPrinters.find(lp => lp.name.toLowerCase() === name);
        const byShare = !exact && share
            ? localPrinters.find(lp => lp.name.toLowerCase() === share)
            : null;
        const partial = !exact && !byShare
            ? localPrinters.find(lp =>
                lp.name.toLowerCase().includes(name) || name.includes(lp.name.toLowerCase())
              )
            : null;

        const suggestion = exact || byShare || partial || null;
        return {
            // Pass the full api object — UI needs parent_printer_id, print_format etc.
            api: {
                id:                ap.id,
                name:              ap.name,
                print_format:      ap.print_format      || '80mm',
                share_name:        ap.share_name        || '',
                type:              ap.type              || '',
                printing_choice:   ap.printing_choice   || '',
                parent_printer_id: ap.parent_printer_id || null,
            },
            suggestion:  suggestion?.name || null,
            matchType:   exact ? 'exact' : byShare ? 'share' : partial ? 'partial' : 'none',
            localList:   localPrinters.map(lp => ({ name: lp.name, status: lp.status })),
        };
    });
}

// ─────────────────────────────────────────────
//  IPC Handlers
// ─────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-logs', () => logs.slice(-LOG_SIZE));

ipcMain.handle('save-config', async (_e, cfg) => {
    // Merge — preserve printerMappings if caller didn't include them
    const existing = loadConfig();
    if (!cfg.printerMappings) cfg.printerMappings = existing.printerMappings || {};
    // Validate pollInterval
    if (cfg.pollInterval) {
        const v = parseInt(cfg.pollInterval, 10);
        cfg.pollInterval = (!isNaN(v) && v >= 1000 && v <= 60000) ? v : 4000;
    } else {
        cfg.pollInterval = existing.pollInterval || 4000;
    }
    const ok = saveConfig(cfg);
    if (!ok) return { success: false, error: 'Write failed' };

    // If service is already running restart it so new interval / pusher state applies
    const wasPolling = !!pollingTimer;
    const wasPusher  = isPusherActive;

    if (wasPolling || wasPusher) {
        stopPolling();
        if (wasPusher) disconnectPusher();

        // Re-evaluate pusher vs polling
        try {
            const testUrl = cfg.domainUrl.replace(/\/+$/, '') + '/api/test-connection';
            const res = await axios.get(testUrl, { headers: apiHeaders(cfg.key), timeout: 6000 });
            if (res.data?.pusher_enabled && res.data?.pusher_config) {
                startPolling();   // polling baseline first
                initPusher(res.data.pusher_config);
                return { success: true, mode: 'connecting' };
            }
        } catch {}

        startPolling();
        return { success: true, mode: 'polling' };
    }

    return { success: true, mode: 'stopped' };
});

ipcMain.handle('test-connection', async (_e, { domainUrl, key }) => {
    try {
        const url = domainUrl.replace(/\/+$/, '') + '/api/test-connection';
        const res = await axios.get(url, { headers: apiHeaders(key), timeout: 6000 });

        if (res.status !== 200) {
            return { success: false, error: `HTTP ${res.status}` };
        }

        // Controller returns { message, status:'error' } with 404 if branch not found
        // (branch resolves server-side from the API key via middleware)
        if (res.data?.status === 'error') {
            return { success: false, error: res.data.message || 'Branch not found — check your API key' };
        }

        const { pusher_enabled, pusher_config } = res.data;
        return { success: true, pusher_enabled: !!pusher_enabled, pusher_config: pusher_config || null };
    } catch (e) {
        // axios throws on 4xx/5xx — extract Laravel JSON error message if present
        const msg = e.response?.data?.message || e.message;
        return { success: false, error: msg };
    }
});

ipcMain.handle('fetch-api-printers', async (_e, { domainUrl, key }) => {
    try {
        const res = await axios.get(
            domainUrl.replace(/\/+$/, '') + '/api/printer-details',
            { headers: apiHeaders(key), timeout: 10_000 }
        );
        if (!Array.isArray(res.data)) {
            return { success: false, error: 'Unexpected response from /api/printer-details' };
        }

        // printerDetails returns all branch printers (no server-side filter).
        // We only handle directPrint printers on the client side.
        const allPrinters    = res.data;
        const directPrinters = allPrinters.filter(p => p.printing_choice === 'directPrint');

        log('INFO', `Printers: ${allPrinters.length} total, ${directPrinters.length} directPrint`);

        if (directPrinters.length === 0) {
            return {
                success: true,
                apiPrinters: [],
                localPrinters: await listSystemPrinters(),
                mappings: [],
                warning: `No directPrint printers found (${allPrinters.length} total). Set printing_choice = directPrint on the server.`,
            };
        }

        const localPrinters = await listSystemPrinters();
        const mappings      = autoMapPrinters(directPrinters, localPrinters);

        return { success: true, apiPrinters: directPrinters, localPrinters, mappings };
    } catch (e) {
        const msg = e.response?.data?.message || e.message;
        return { success: false, error: msg };
    }
});

ipcMain.handle('list-system-printers', () => listSystemPrinters());

// ── Diagnostic: raw pull test — returns exactly what the server sends ────────
// Used in Connection page "Test Pull" button to debug job detection issues
ipcMain.handle('test-pull-raw', async (_e, { domainUrl, key }) => {
    const base    = (domainUrl || '').replace(/\/+$/, '');
    const headers = apiHeaders(key);
    const results = {};

    for (const ep of [PULL_ENDPOINT_MULTI, PULL_ENDPOINT_SINGLE]) {
        const url = base + ep;
        try {
            const res = await axios.get(url, { headers, timeout: 8000 });
            results[ep] = {
                status:    res.status,
                dataType:  Array.isArray(res.data) ? 'array' : typeof res.data,
                count:     Array.isArray(res.data) ? res.data.length
                         : (res.data?.data ? res.data.data.length : (res.data?.id ? 1 : 0)),
                preview:   JSON.stringify(res.data).substring(0, 500),
                rawData:   res.data,
            };
        } catch (e) {
            results[ep] = {
                status:    e.response?.status || null,
                error:     e.response?.data?.message || e.message,
                code:      e.code,
            };
        }
    }
    return results;
});

ipcMain.handle('save-printer-mappings', async (_e, { printerMappings }) => {
    const cfg = loadConfig();
    cfg.printerMappings = printerMappings;
    return { success: saveConfig(cfg) };
});

ipcMain.handle('get-printer-mappings', () => {
    const cfg = loadConfig();
    return { success: true, mappings: cfg.printerMappings || {} };
});

ipcMain.handle('clear-printer-mappings', () => {
    const cfg = loadConfig();
    cfg.printerMappings = {};
    return { success: saveConfig(cfg) };
});

ipcMain.handle('start-service', async (_e, { domainUrl, key, pollInterval }) => {
    const cfg = loadConfig();
    if (domainUrl)   cfg.domainUrl   = domainUrl;
    if (key)         cfg.key         = key;
    // Accept pollInterval from UI (in ms); validate range 1000–60000
    if (pollInterval) {
        const v = parseInt(pollInterval, 10);
        cfg.pollInterval = (!isNaN(v) && v >= 1000 && v <= 60000) ? v : 4000;
    }
    saveConfig(cfg);

    // Step 1: always start polling as the safe, immediate baseline
    startPolling();

    // Step 2: try to upgrade to Pusher live mode
    let mode = 'polling';
    try {
        const testUrl = cfg.domainUrl.replace(/\/+$/, '') + '/api/test-connection';
        const res = await axios.get(testUrl, { headers: apiHeaders(cfg.key), timeout: 6000 });
        if (res.data?.pusher_enabled && res.data?.pusher_config) {
            initPusher(res.data.pusher_config);
            // Pusher 'connected' event will call stopPolling() and emit pusher-state
            mode = 'connecting'; // UI will receive the final state via events
        }
    } catch (e) {
        log('WARN', 'Could not check Pusher config:', e.message);
    }

    return { success: true, mode };
});

ipcMain.handle('stop-service', () => {
    stopPolling();
    disconnectPusher();
    activeEndpoint = null; // re-discover on next start
    emit('service-stopped', {});
    return { success: true };
});

ipcMain.handle('get-service-status', () => {
    const cfg = loadConfig();
    const running = !!pollingTimer || isPusherActive;
    return {
        running,
        polling:      !!pollingTimer,
        pusher:       isPusherActive,
        mode:         isPusherActive ? 'pusher' : (pollingTimer ? 'polling' : 'stopped'),
        queue:        jobQueue.length,
        processing:   isProcessing,
        interval:     cfg.pollInterval || getPollInterval(),
        endpoint:     activeEndpoint || 'unknown',
        endpointPath: activeEndpoint === 'multi' ? PULL_ENDPOINT_MULTI :
                      activeEndpoint === 'single' ? PULL_ENDPOINT_SINGLE : '(not yet connected)',
    };
});

ipcMain.handle('check-for-update', () => {
    try {
        autoUpdater.checkForUpdatesAndNotify();
        return { status: 'checking' };
    } catch (e) {
        return { status: 'error', message: e.message };
    }
});

ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

// ─────────────────────────────────────────────
//  Auto-updater events
// ─────────────────────────────────────────────
autoUpdater.on('update-available',  () => emit('update-available',  {}));
autoUpdater.on('update-downloaded', () => emit('update-downloaded', {}));
autoUpdater.on('error',             e  => emit('update-error',      { message: e?.message }));

// ─────────────────────────────────────────────
//  Window & app lifecycle
// ─────────────────────────────────────────────
function createWindow() {
    configWindow = new BrowserWindow({
        width:  1180,
        height: 860,
        minWidth:  900,
        minHeight: 650,
        backgroundColor: '#0f1117',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            nodeIntegration:  false,
            contextIsolation: true,
            sandbox:          false,
        },
        titleBarStyle: os.platform() === 'darwin' ? 'hiddenInset' : 'default',
        title: 'OrderOwn Bridge',
    });

    configWindow.loadFile('config.html');

    // Dev tools in development
    if (process.env.NODE_ENV === 'development') {
        configWindow.webContents.openDevTools();
    }

    configWindow.on('close', (e) => {
        // Hide instead of close so tray keeps working
        e.preventDefault();
        configWindow.hide();
    });

    configWindow.on('minimize', (e) => {
        e.preventDefault();
        configWindow.hide();
    });
}

function buildTrayMenu() {
    return Menu.buildFromTemplate([
        {
            label: 'OrderOwn Bridge',
            enabled: false,
        },
        { type: 'separator' },
        {
            label: 'Show / Hide',
            click: () => {
                if (!configWindow || configWindow.isDestroyed()) {
                    createWindow();
                } else if (configWindow.isVisible()) {
                    configWindow.hide();
                } else {
                    configWindow.show();
                    configWindow.focus();
                }
            },
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                stopPolling();
                disconnectPusher();
                app.exit(0);
            },
        },
    ]);
}

app.whenReady().then(() => {
    // ── Auto-start on OS startup ─────────────────────
    if (app.isPackaged) {
        app.setLoginItemSettings({
            openAtLogin: true,
            path:        app.getPath('exe'),
        });
    }

    // Tray
    const logoExists = fs.existsSync(LOGO_PATH);
    const iconExists = fs.existsSync(ICON_PATH);
    const chosenPath = logoExists ? LOGO_PATH : (iconExists ? ICON_PATH : null);

    let icon;
    if (chosenPath) {
        icon = nativeImage.createFromPath(chosenPath).resize({ width: 22, height: 22 });
    } else {
        icon = nativeImage.createEmpty();
    }

    tray = new Tray(icon);
    tray.setToolTip('OrderOwn Bridge — running');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => {
        if (!configWindow || configWindow.isDestroyed()) {
            createWindow();
        } else {
            configWindow.isVisible() ? configWindow.hide() : configWindow.show();
        }
    });

    if (os.platform() === 'darwin' && app.dock && chosenPath) {
        try {
            app.dock.setIcon(chosenPath);
        } catch (err) {
            console.error('Failed to set dock icon:', err);
        }
    }

    createWindow();

    // Auto-start service if config exists
    const cfg = loadConfig();
    if (cfg.domainUrl && cfg.key) {
        log('INFO', 'Auto-starting print service with saved config');
        axios.get(cfg.domainUrl.replace(/\/+$/, '') + '/api/test-connection', {
            headers: apiHeaders(cfg.key),
            timeout: 6000,
        }).then(res => {
            if (res.data?.pusher_enabled && res.data?.pusher_config) {
                initPusher(res.data.pusher_config);
            } else {
                startPolling();
            }
        }).catch(() => startPolling());
    }
});

app.on('before-quit', () => {
    stopPolling();
    disconnectPusher();
});

app.on('activate', () => {
    if (!configWindow || configWindow.isDestroyed()) createWindow();
    else configWindow.show();
});

app.on('window-all-closed', () => {
    // Keep running in tray
});
