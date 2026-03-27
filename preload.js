'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a controlled API surface — no raw Node/Electron access in renderer
contextBridge.exposeInMainWorld('bridge', {
    // ── Config ──────────────────────────────────
    getConfig:     ()        => ipcRenderer.invoke('get-config'),
    saveConfig:    (cfg)     => ipcRenderer.invoke('save-config', cfg),
    getAppVersion: ()        => ipcRenderer.invoke('get-app-version'),

    // ── Connection ──────────────────────────────
    testConnection:     (opts) => ipcRenderer.invoke('test-connection',   opts),
    fetchApiPrinters:   (opts) => ipcRenderer.invoke('fetch-api-printers', opts),
    listSystemPrinters: ()     => ipcRenderer.invoke('list-system-printers'),
    testPullRaw:        (opts) => ipcRenderer.invoke('test-pull-raw',      opts),

    // ── Printer mappings ────────────────────────
    savePrinterMappings: (m) => ipcRenderer.invoke('save-printer-mappings', m),
    getPrinterMappings:  ()  => ipcRenderer.invoke('get-printer-mappings'),
    clearPrinterMappings: () => ipcRenderer.invoke('clear-printer-mappings'),

    // ── Service control ─────────────────────────
    startService:     (opts) => ipcRenderer.invoke('start-service',    opts),
    stopService:      ()     => ipcRenderer.invoke('stop-service'),
    getServiceStatus: ()     => ipcRenderer.invoke('get-service-status'),

    // ── Logs ────────────────────────────────────
    getLogs: () => ipcRenderer.invoke('get-logs'),

    // ── Updates ─────────────────────────────────
    checkForUpdate: ()  => ipcRenderer.invoke('check-for-update'),
    installUpdate:  ()  => ipcRenderer.send('install-update'),

    // ── Event subscriptions (push from main) ────
    on: (event, cb) => {
        const wrapper = (_ipcEvent, data) => cb(data);
        ipcRenderer.on(event, wrapper);
        // Return unsubscribe function
        return () => ipcRenderer.removeListener(event, wrapper);
    },
});
