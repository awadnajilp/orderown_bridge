'use strict';

/**
 * POS80Printer — lightweight wrapper used for legacy compatibility.
 * 
 * In the rebuilt app, all actual printing is handled in main.js via
 * Electron's webContents.print() for cross-platform image printing.
 * This class is retained for direct OS-level fallback if needed.
 */

const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

class POS80Printer {
    /**
     * @param {string} printerName  - Local system printer name
     */
    constructor(printerName = 'POS80') {
        this.printerName = printerName;
        this.isConnected = false;
    }

    // ─── Connection check ─────────────────────────────────────────────
    async connect() {
        const exists = await this.checkPrinterExists();
        this.isConnected = exists;
        if (exists) {
            console.log(`[POS80] ✅ Printer "${this.printerName}" found`);
        } else {
            console.error(`[POS80] ❌ Printer "${this.printerName}" not found`);
        }
        return exists;
    }

    async checkPrinterExists() {
        return new Promise((resolve) => {
            if (os.platform() === 'win32') {
                exec(
                    `powershell -NoProfile -Command "Get-Printer -Name '${this.printerName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue"`,
                    { timeout: 5000 },
                    (err, stdout) => {
                        resolve(!err && stdout.toLowerCase().includes(this.printerName.toLowerCase()));
                    }
                );
            } else {
                exec(`lpstat -p "${this.printerName}" 2>/dev/null`, { timeout: 3000 }, err => resolve(!err));
            }
        });
    }

    // ─── Raw ESC/POS text fallback ────────────────────────────────────
    /**
     * Print raw ESC/POS buffer via OS commands.
     * This is the fallback when Electron webContents.print() is not available.
     * 
     * @param {Buffer|string} content
     * @param {object} options
     * @param {boolean} options.cutPaper
     */
    async print(content, options = {}) {
        if (!this.isConnected) {
            throw new Error(`[POS80] Printer "${this.printerName}" is not connected`);
        }

        const { cutPaper = true } = options;

        // Build ESC/POS byte buffer
        let commands = [
            0x1b, 0x40, // ESC @ — initialise printer
            0x1b, 0x61, 0x00, // left align
            0x1b, 0x21, 0x00, // normal font
        ];

        const textBytes = Buffer.from(typeof content === 'string' ? content : content.toString('binary'), 'binary');
        commands = commands.concat(Array.from(textBytes));
        commands.push(0x0a, 0x0a, 0x0a); // line feeds

        if (cutPaper) {
            commands.push(0x1d, 0x56, 0x41, 0x03); // GS V A 3 — full cut
        }

        return this._sendRaw(Buffer.from(commands));
    }

    // ─── Image file print (OS-level) ──────────────────────────────────
    /**
     * Print an image file using OS commands.
     * Prefer using main.js Electron webContents.print() for images.
     * 
     * @param {string} imagePath  - Absolute path to the image file
     * @param {string} [format]   - Paper format: '58mm' | '80mm' | 'A4'
     */
    async printImageFile(imagePath, format = '80mm') {
        if (!this.isConnected) {
            throw new Error(`[POS80] Printer "${this.printerName}" is not connected`);
        }
        if (!fs.existsSync(imagePath)) {
            throw new Error(`[POS80] Image not found: ${imagePath}`);
        }

        return new Promise((resolve, reject) => {
            let cmd;
            if (os.platform() === 'win32') {
                // Use mspaint for silent image printing on Windows
                cmd = `mspaint /pt "${imagePath}" "${this.printerName}"`;
            } else {
                // lp with fit-to-page on macOS / Linux
                cmd = `lp -d "${this.printerName}" -o fit-to-page -o media=${format} "${imagePath}"`;
            }

            exec(cmd, { timeout: 20_000 }, (err, _stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
    }

    // ─── Internal raw send ────────────────────────────────────────────
    _sendRaw(buf) {
        return new Promise((resolve, reject) => {
            const tmpFile = path.join(os.tmpdir(), `pbr_${Date.now()}.bin`);
            try { fs.writeFileSync(tmpFile, buf); } catch (e) { return reject(e); }

            const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch {} };

            let cmd;
            if (os.platform() === 'win32') {
                cmd = `copy /b "${tmpFile}" "\\\\localhost\\${this.printerName}"`;
            } else {
                cmd = `lp -d "${this.printerName}" "${tmpFile}"`;
            }

            exec(cmd, { timeout: 15_000 }, (err, _out, stderr) => {
                cleanup();
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
    }

    async disconnect() {
        this.isConnected = false;
        console.log(`[POS80] Disconnected from "${this.printerName}"`);
    }
}

module.exports = POS80Printer;
