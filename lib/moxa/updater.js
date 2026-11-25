"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const setup = require("./setup");
const catalog = require("./catalog");
const { MoxaWeb } = require("./web");

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps the Moxa serial servers up to date: reads model and firmware from the web console, compares with the newest
 * firmware Moxa publishes and, if allowed, flashes it and checks that the device is back with the new version and
 * its serial port open.
 */
class MoxaUpdater {
    /**
     * @param {object} o
     * @param {{ info: Function, warn: Function, error: Function, debug: Function }} o.log
     * @param {string} o.password web console password (the same on all Moxa)
     * @param {string} o.dir data folder for downloaded firmware and configuration backups
     * @param {typeof fetch} [o.fetchImpl]
     * @param {(host: string, port: number, password: string) => MoxaWeb} [o.webFactory]
     * @param {(host: string, port: number) => Promise<boolean>} [o.portCheck]
     * @param {(ms: number) => Promise<void>} [o.sleep]
     * @param {number} [o.settleMs]       pause after the upload before the device is looked at again
     * @param {number} [o.rebootTimeoutMs] how long the device may take to come back
     * @param {number} [o.pollMs]
     * @param {number} [o.portWaitMs] how long the serial port may stay closed after the update
     */
    constructor(o) {
        this.log = o.log;
        this.password = o.password || "";
        this.dir = o.dir;
        this.fetchImpl = o.fetchImpl || fetch;
        this.webFactory =
            o.webFactory ||
            ((host, port, password) => new MoxaWeb({ host, port, password }));
        this.portCheck = o.portCheck || tcpOpen;
        this.sleep = o.sleep || sleep;
        this.settleMs = o.settleMs ?? 25000;
        this.rebootTimeoutMs = o.rebootTimeoutMs ?? 6 * 60000;
        this.pollMs = o.pollMs ?? 10000;
        this.portWaitMs = o.portWaitMs ?? 90000;
    }

    /**
     * Logs in, reads the pages and returns what the device says about itself.
     *
     * @param {{ host: string, password?: string }} g
     */
    async inspect(g) {
        const web = this.webFactory(g.host, 80, g.password || this.password);
        const login = await web.login();
        if (!login.ok) {
            return {
                ok: false,
                error: login.error,
                web,
                model: null,
                firmware: null,
                firmwareText: null,
                mac: null,
                serialNo: null,
                mode: null,
                serial: null,
                form: null,
                forms: 0,
                exportLink: null,
            };
        }
        await web.crawl();
        const real = [...web.pages.values()].filter(
            (h) => !/Inputs*password/i.test(h),
        );
        if (web.pages.size < 3 || real.length < 3) {
            return {
                ok: false,
                error: "Die Web-Konsole der Moxa zeigt nach der Anmeldung nur die Anmeldeseite. Meist ist die Konsole durch eine andere Sitzung belegt (z. B. ein Browser mit offener Moxa-Seite); die Moxa erlaubt nur eine.",
                web,
                model: null,
                firmware: null,
                firmwareText: null,
                mac: null,
                serialNo: null,
                mode: null,
                serial: null,
                form: null,
                forms: 0,
                exportLink: null,
            };
        }
        const info = { ...web.parseInfo(), ...web.parseSettings() };
        const forms = web.findUploadForms();
        const form =
            forms.find((f) =>
                /firm|upgrad|upload|rom/i.test(`${f.path} ${f.action}`),
            ) || (forms.length === 1 ? forms[0] : null);
        return {
            ok: true,
            web,
            ...info,
            form,
            forms: forms.length,
            exportLink: web.findExportLink(),
        };
    }

    /**
     * Puts the Moxa into the state the M-Bus reading needs (TCP server mode, raw, the serial line) through the web
     * console, restarts it and checks that it came back with these settings and an open data port.
     *
     * @param {{ host: string, password?: string }} g
     * @param {{ port: number, baud: number, parity: string }} t
     * @returns {Promise<{ ok: boolean, note: string }>}
     */
    async configure(g, t) {
        const web = this.webFactory(g.host, 80, g.password || this.password);
        const login = await web.login();
        if (!login.ok) {
            return {
                ok: false,
                note: login.error || "Anmeldung an der Moxa nicht möglich",
            };
        }
        let res;
        try {
            res = await setup.apply(web, t);
        } catch (e) {
            return {
                ok: false,
                note: `Einrichtung abgebrochen: ${e && e.message}. Es wurde nichts neu gestartet.`,
            };
        }
        if (!res.ok) {
            return { ok: false, note: res.note };
        }
        this.log.info(`Moxa ${g.host}: ${res.note}`);
        await this.sleep(this.settleMs);
        const deadline = Date.now() + this.rebootTimeoutMs;
        /** @type {any} */
        let back = null;
        while (Date.now() < deadline) {
            const b = await this.inspect(g);
            if (b.ok && b.mode) {
                back = b;
                break;
            }
            await this.sleep(this.pollMs);
        }
        if (!back) {
            return {
                ok: false,
                note: `Die Moxa ist nach der Einrichtung nicht wieder erreichbar (${Math.round(this.rebootTimeoutMs / 60000)} Minuten gewartet). Vor Ort prüfen.`,
            };
        }
        const want = `${t.baud} 8${t.parity}1`;
        if (!/TCP Server/i.test(back.mode) || back.serial !== want) {
            return {
                ok: false,
                note: `Nach dem Neustart meldet die Moxa Betriebsart ${back.mode}, seriell ${back.serial}; erwartet TCP Server Mode, ${want}.`,
            };
        }
        let open = false;
        const until = Date.now() + this.portWaitMs;
        while (
            Date.now() < until &&
            !(open = await this.portCheck(g.host, t.port))
        ) {
            await this.sleep(this.pollMs);
        }
        if (!open) {
            return {
                ok: false,
                note: `Betriebsart und Seriell-Einstellung stimmen, aber der Datenport ${t.port} ist nicht offen.`,
            };
        }
        return {
            ok: true,
            note: `Moxa eingerichtet: TCP Server Mode (Raw), Port ${t.port}, ${want}, Datenport offen.`,
        };
    }

    /**
     * What is installed, what is newest, and whether an update could be flashed.
     *
     * @param {{ host: string, password?: string }} g
     * @returns {Promise<{ status: "aktuell"|"veraltet"|"unbekannt"|"fehler", model?: string|null, firmware?: string|null, latest?: string, latestDate?: string, note: string, updatable?: boolean, mode?: string|null, serial?: string|null }>}
     */
    async check(g) {
        const ins = await this.inspect(g);
        if (!ins.ok) {
            return {
                status: "fehler",
                note: ins.error || "Moxa nicht lesbar",
                mode: null,
                serial: null,
            };
        }
        if (!ins.model || !ins.firmware) {
            return {
                status: "unbekannt",
                model: ins.model,
                firmware: ins.firmware,
                mode: ins.mode,
                serial: ins.serial,
                note: `Modell oder Firmware-Version in der Web-Konsole nicht erkannt (${ins.web.pages.size} Seiten gelesen).`,
            };
        }
        const latest = await catalog.fetchLatest(ins.model, this.fetchImpl);
        if (!latest.ok || !latest.latest) {
            return {
                status: "unbekannt",
                model: ins.model,
                firmware: ins.firmware,
                mode: ins.mode,
                serial: ins.serial,
                note: latest.error || "keine Firmware-Information",
            };
        }
        const l = latest.latest;
        const newer = catalog.compareVersions(l.version, ins.firmware) > 0;
        const updatable = newer && ins.form !== null;
        return {
            status: newer ? "veraltet" : "aktuell",
            model: ins.model,
            firmware: ins.firmware,
            latest: l.version,
            latestDate: l.date,
            updatable,
            mode: ins.mode,
            serial: ins.serial,
            note: newer
                ? `Firmware ${ins.firmware}, neu ist ${l.version} (${l.date}). ${updatable ? "Upload-Seite gefunden." : "Upload-Seite der Web-Konsole NICHT erkannt, Update nicht automatisch möglich."}`
                : `Firmware ${ins.firmware} ist aktuell.`,
        };
    }

    /**
     * Flashes the newest firmware. Every step that can be checked before the upload is checked first.
     *
     * @param {{ host: string, port: number, name?: string }} g
     * @returns {Promise<{ ok: boolean, status: string, note: string, from?: string, to?: string }>}
     */
    async update(g) {
        const ins = await this.inspect(g);
        if (!ins.ok) {
            return {
                ok: false,
                status: "fehler",
                note: ins.error || "Moxa nicht lesbar",
            };
        }
        if (!ins.model || !ins.firmware) {
            return {
                ok: false,
                status: "unbekannt",
                note: "Modell oder Firmware-Version nicht erkannt, es wird nichts eingespielt.",
            };
        }
        if (!ins.form) {
            return {
                ok: false,
                status: "unbekannt",
                note: `Keine eindeutige Upload-Seite gefunden (${ins.forms} Formular(e) mit Datei), es wird nichts eingespielt.`,
            };
        }
        const latest = await catalog.fetchLatest(ins.model, this.fetchImpl);
        if (!latest.ok || !latest.latest) {
            return {
                ok: false,
                status: "unbekannt",
                note: latest.error || "keine Firmware-Information",
            };
        }
        const l = latest.latest;
        if (catalog.compareVersions(l.version, ins.firmware) <= 0) {
            return {
                ok: true,
                status: "aktuell",
                note: `Firmware ${ins.firmware} ist aktuell.`,
                from: ins.firmware,
                to: ins.firmware,
            };
        }
        const dl = await catalog.download(l, this.fetchImpl);
        if (!dl.ok || !dl.data) {
            return {
                ok: false,
                status: "fehler",
                note: dl.error || "Download fehlgeschlagen",
            };
        }
        fs.mkdirSync(path.join(this.dir, "firmware"), { recursive: true });
        const fileName = path.basename(new URL(l.url).pathname);
        fs.writeFileSync(path.join(this.dir, "firmware", fileName), dl.data);

        const portBefore = await this.portCheck(g.host, g.port);
        let backup = "keine Sicherung (Export-Link nicht gefunden)";
        if (ins.exportLink) {
            try {
                const r = await ins.web.request("GET", ins.exportLink);
                if (
                    r.status === 200 &&
                    r.body.length > 0 &&
                    !/<html/i.test(r.text.slice(0, 200))
                ) {
                    fs.mkdirSync(path.join(this.dir, "moxa-backup"), {
                        recursive: true,
                    });
                    const f = path.join(
                        this.dir,
                        "moxa-backup",
                        `${g.host}-${ins.firmware}-${new Date().toISOString().slice(0, 10)}.cfg`,
                    );
                    fs.writeFileSync(f, r.body);
                    backup = `Konfiguration gesichert: ${f}`;
                }
            } catch {
                // a backup that cannot be taken must not stop the update, but it is reported
            }
        }

        this.log.info(
            `Moxa ${g.host}: ${ins.model} ${ins.firmware} -> ${l.version}, ${fileName} (${dl.data.length} Bytes) wird eingespielt. ${backup}`,
        );
        try {
            const up = await ins.web.upload(ins.form, dl.data, fileName);
            this.log.info(
                `Moxa ${g.host}: Upload beantwortet mit HTTP ${up.status}`,
            );
        } catch (e) {
            // the device may drop the connection while it starts to write: that is looked at below
            this.log.info(
                `Moxa ${g.host}: Verbindung beim Upload beendet (${e.message}), prüfe den Zustand`,
            );
        }

        // back again?
        await this.sleep(this.settleMs);
        const deadline = Date.now() + this.rebootTimeoutMs;
        let now = null;
        while (Date.now() < deadline) {
            const back = await this.inspect(g);
            if (back.ok && back.firmware) {
                now = back;
                break;
            }
            await this.sleep(this.pollMs);
        }
        if (!now) {
            return {
                ok: false,
                status: "fehler",
                from: ins.firmware,
                to: l.version,
                note: `Die Moxa ist nach dem Update nicht wieder erreichbar (${Math.round(this.rebootTimeoutMs / 60000)} Minuten gewartet). Vor Ort prüfen. ${backup}`,
            };
        }
        if (catalog.compareVersions(now.firmware || "0", l.version) !== 0) {
            return {
                ok: false,
                status: "fehler",
                from: ins.firmware,
                to: l.version,
                note: `Nach dem Update meldet die Moxa Firmware ${now.firmware}, erwartet war ${l.version}. ${backup}`,
            };
        }
        if (portBefore) {
            let open = false;
            const until = Date.now() + this.portWaitMs;
            while (
                Date.now() < until &&
                !(open = await this.portCheck(g.host, g.port))
            ) {
                await this.sleep(this.pollMs);
            }
            if (!open) {
                return {
                    ok: false,
                    status: "fehler",
                    from: ins.firmware,
                    to: l.version,
                    note: `Firmware ist ${l.version}, aber der serielle Port ${g.port} ist nicht mehr offen. Betriebsart (TCP-Server, Raw) und Seriell-Einstellungen prüfen. ${backup}`,
                };
            }
        }
        return {
            ok: true,
            status: "aktuell",
            from: ins.firmware,
            to: l.version,
            note: `Firmware von ${ins.firmware} auf ${l.version} aktualisiert, Moxa ist wieder erreichbar${portBefore ? ", serieller Port offen" : ""}. ${backup}`,
        };
    }
}

/**
 * @param {string} host @param {number} port @returns {Promise<boolean>}
 * @param port
 */
function tcpOpen(host, port) {
    return new Promise((resolve) => {
        const s = net.createConnection({ host, port });
        const done = (v) => {
            s.destroy();
            resolve(v);
        };
        s.setTimeout(4000, () => done(false));
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
    });
}

module.exports = { MoxaUpdater, tcpOpen };
