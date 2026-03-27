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

    log('PRINT', `Sending HTML to [${localPrinterName}] | format: ${widthMm}mm`);

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
        await processSingleJob(job);
    }

    isProcessing = false;
}

async function processSingleJob(job) {
    const cfg = loadConfig();
    const base = cfg.domainUrl.replace(/\/+$/, '');

    // ── Log raw job structure first — essential for debugging ──────────
    log('INFO', `Job #${job.id} raw keys: [${Object.keys(job).join(', ')}]`);
    if (job.printer) {
        log('INFO', `Job #${job.id} printer object: ${JSON.stringify(job.printer)}`);
    }

    // ── Extract fields ───────────────────────────────────────────────
    const apiPrinterName    = job.printer?.name
                           || job.printer_name
                           || (typeof job.printer === 'string' ? job.printer : '')
                           || '';

    const printFormat       = job.printer?.print_format  || '80mm';
    const parentPrinterId   = job.printer?.parent_printer_id || null;
    const isCopy            = !!job.is_copy;

    // Detection: new API image vs ESC/POS payload
    const imageFilename     = job.image_filename || null;
    const htmlContent       = job.payload?.html_content || null;
    // Detection: prioritize explicit type from payload, then printer config, then job object.
    // Fallback based on content (HTML > Image > ESC/POS).
    let printType = job.payload?.print_type || job.printer?.print_type || job.print_type;

    // Content-based discovery (if no explicit type or if type is ambiguous)
    if (!printType || printType === 'escpos') {
        if (htmlContent) printType = 'html';
        else if (imageFilename) printType = 'image';
        else printType = 'escpos';
    }

    // Secondary Check: if it's explicitly 'escpos' but has an image and NO escpos data, switch to image.
    const escposBase64      = job.payload?.escpos_base64 || null;
    const escposLegacy      = job.payload?.text || job.text || null;
    if (printType === 'escpos' && imageFilename && !escposBase64 && !escposLegacy) {
        printType = 'image';
    }

    const imagePath         = (cfg.imageUrlPath || IMAGE_PATH).replace(/\/*$/, '/');
    const imageUrl          = imageFilename ? `${base}${imagePath}${imageFilename}` : '';
    const patchUrl          = `${base}${PATCH_BASE}/${job.id}`;
    const headers           = apiHeaders(cfg.key);

    const copyTag = isCopy ? ` [COPY — parent printer #${parentPrinterId}]` : '';
    log('INFO', `Job #${job.id} | type: ${printType} | printer: "${apiPrinterName}"${copyTag} | format: ${printFormat}`);
    emit('job-start', { id: job.id, printer: apiPrinterName, file: imageFilename || `(${printType})`, isCopy });

    // Guard: must have a valid data source
    if (printType === 'html' && !htmlContent) {
        const reason = `Job #${job.id} is type 'html' but has no html_content`;
        log('WARN', reason);
        emit('job-fail', { id: job.id, reason });
        await patchJob(patchUrl, 'failed', { error: reason }, headers);
        return;
    }
    if (printType === 'image' && !imageFilename) {
        const reason = `Job #${job.id} is type 'image' but has no image_filename`;
        log('WARN', reason);
        emit('job-fail', { id: job.id, reason });
        await patchJob(patchUrl, 'failed', { error: reason }, headers);
        return;
    }
    if (printType === 'escpos' && !escposBase64 && !escposLegacy) {
        const reason = `Job #${job.id} is type 'escpos' but has no base64 payload or legacy text`;
        log('WARN', reason);
        emit('job-fail', { id: job.id, reason });
        await patchJob(patchUrl, 'failed', { error: reason }, headers);
        return;
    }

    // Resolve local printer name from saved mapping
    const mappedName = cfg.printerMappings?.[apiPrinterName];
    if (!mappedName) {
        const reason = `No local printer mapped for API printer "${apiPrinterName}" — add a mapping in Printer Map`;
        log('WARN', `Job #${job.id}: ${reason}`);
        emit('job-fail', { id: job.id, reason });
        await patchJob(patchUrl, 'failed', { error: reason }, headers);
        return;
    }

    // Confirm the local printer actually exists on this system right now
    // AND resolve its exact case-sensitive system name.
    const systemPrinter = await findSystemPrinter(mappedName);
    if (!systemPrinter) {
        const reason = `Local printer "${mappedName}" not found on this system`;
        log('WARN', `Job #${job.id}: ${reason}`);
        emit('job-fail', { id: job.id, reason });
        await patchJob(patchUrl, 'failed', { error: reason }, headers);
        return;
    }

    const localPrinterName = systemPrinter.name; // Use the exact casing from the system

    try {
        if (printType === 'html') {
            // ── HTML print via Electron BrowserWindow ──────────
            log('PRINT', `Job #${job.id}: printing HTML content on [${localPrinterName}]`);
            await printHtmlJob(htmlContent, localPrinterName, printFormat);
        } else if (printType === 'image' || imageFilename) {
            // ── Image print via Electron BrowserWindow ──────────
            log('PRINT', `Job #${job.id}: printing image ${imageUrl} on [${localPrinterName}]`);
            await printImageJob(imageUrl, localPrinterName, printFormat);
        } else if (printType === 'escpos') {
            // ── ESC/POS raw print ───────────────────────────────
            let rawBuffer;
            if (escposBase64) {
                log('PRINT', `Job #${job.id}: decoding Base64 ESC/POS payload on [${localPrinterName}]`);
                rawBuffer = Buffer.from(escposBase64, 'base64');
            } else {
                log('PRINT', `Job #${job.id}: unescaping legacy ESC/POS text on [${localPrinterName}]`);
                rawBuffer = unescapeEscPos(escposLegacy);
            }
            log('INFO', `Job #${job.id}: sending ${rawBuffer.length} bytes to [${localPrinterName}]`);
            await printFileFallback(localPrinterName, rawBuffer);
        }

        emit('job-done', { id: job.id, printer: localPrinterName });
        await patchJob(patchUrl, 'done', { printer: localPrinterName }, headers);
        log('OK', `Job #${job.id} → DONE on [${localPrinterName}]${copyTag}`);
    } catch (err) {
        log('ERROR', `Job #${job.id} print error: ${err.message}`);
        emit('job-fail', { id: job.id, reason: err.message });
        await patchJob(patchUrl, 'failed', { error: err.message }, headers);
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
