"use strict";

const http = require("node:http");
const { encPassword, challengeOf } = require("./auth");

/** Pages that change the device or end the session are never requested while looking around. */
const FORBIDDEN =
    /restart|reboot|reset|default|factory|clear|delete|erase|format|logout|logoff|exit|save|apply/i;

/** @param {string} html */
const stripTags = (html) =>
    html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * Client of the Moxa NPort web console (HTTP, MoxaHttp/1.0). It logs in with the challenge scheme of the login page,
 * reads model and firmware version from the pages it finds, finds the firmware upload form and posts a file to it.
 * Nothing is hard-wired to page names: the pages are discovered from the links of the home page, because they
 * differ between models and firmware generations.
 */
class MoxaWeb {
    /**
     * @param {object} o
     * @param {string} o.host
     * @param {number} [o.port]
     * @param {string} o.password
     * @param {number} [o.timeoutMs]
     */
    constructor(o) {
        this.host = o.host;
        this.port = o.port || 80;
        this.password = o.password || "";
        this.timeoutMs = o.timeoutMs || 15000;
        /** @type {Map<string, string>} */
        this.cookies = new Map();
        /** @type {Map<string, string>} path -> html */
        this.pages = new Map();
    }

    /**
     * @param {string} method
     * @param {string} path
     * @param {{ headers?: Record<string,string>, body?: Buffer, timeoutMs?: number }} [opt]
     * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: Buffer, text: string }>}
     */
    request(method, path, opt = {}) {
        return new Promise((resolve, reject) => {
            /** @type {Record<string,string>} */
            const headers = {
                "User-Agent": "iobroker.abrechnungmailcarrier",
                Connection: "close",
                ...(opt.headers || {}),
            };
            if (this.cookies.size) {
                headers.Cookie = [...this.cookies]
                    .map(([k, v]) => `${k}=${v}`)
                    .join("; ");
            }
            if (opt.body) {
                headers["Content-Length"] = String(opt.body.length);
            }
            const req = http.request(
                {
                    host: this.host,
                    port: this.port,
                    method,
                    path,
                    headers,
                    agent: false,
                },
                (res) => {
                    /** @type {Buffer[]} */
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        for (const c of res.headers["set-cookie"] || []) {
                            const [kv] = c.split(";");
                            const i = kv.indexOf("=");
                            if (i > 0) {
                                this.cookies.set(
                                    kv.slice(0, i).trim(),
                                    kv.slice(i + 1).trim(),
                                );
                            }
                        }
                        const body = Buffer.concat(chunks);
                        resolve({
                            status: res.statusCode || 0,
                            headers: res.headers,
                            body,
                            text: body.toString("latin1"),
                        });
                    });
                    res.on("error", reject);
                },
            );
            req.setTimeout(opt.timeoutMs || this.timeoutMs, () =>
                req.destroy(new Error(`Zeitüberschreitung ${method} ${path}`)),
            );
            req.on("error", reject);
            if (opt.body) {
                req.write(opt.body);
            }
            req.end();
        });
    }

    /**
     * Opens the session. A device without password shows the home page right away.
     *
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    async login() {
        this.cookies.clear();
        this.pages.clear();
        let first;
        try {
            first = await this.request("GET", "/");
        } catch (e) {
            return {
                ok: false,
                error: `Moxa-Web-Konsole nicht erreichbar: ${e.message}`,
            };
        }
        const challenge = challengeOf(first.text);
        if (!challenge) {
            if (first.status === 200 && !/Input\s*password/i.test(first.text)) {
                this.pages.set("/", first.text);
                return { ok: true };
            }
            return { ok: false, error: "Anmeldeseite der Moxa nicht erkannt." };
        }
        if (!this.password) {
            return {
                ok: false,
                error: "Die Moxa verlangt ein Passwort, im Adapter ist keines eingetragen.",
            };
        }
        const enc = encPassword(this.password, challenge);
        const q = `token_text=&FakeChallenge=${challenge}&EncPasswd=${enc}&Submit=Submit`;
        let res;
        try {
            res = await this.request("GET", `/home.htm?${q}`);
        } catch (e) {
            return {
                ok: false,
                error: `Anmeldung fehlgeschlagen: ${e.message}`,
            };
        }
        if (
            res.status !== 200 ||
            /Input\s*password/i.test(res.text) ||
            challengeOf(res.text)
        ) {
            return {
                ok: false,
                error: "Anmeldung an der Moxa abgelehnt (Passwort falsch oder die Moxa erlaubt gerade keine weitere Sitzung).",
            };
        }
        this.pages.set("/home.htm", res.text);
        return { ok: true };
    }

    /**
     * Page paths mentioned by a page (links, frames, script strings). @param {string} html @param {string} from
     *
     * @param html
     * @param from
     */
    linksOf(html, from) {
        const found = new Set();
        const add = (u) => {
            if (!u || /^(https?:|mailto:|javascript:|#)/i.test(u)) {
                return;
            }
            let p = u.split("#")[0];
            if (!/\.(htm|html|asp|cgi)(\?.*)?$/i.test(p)) {
                return;
            }
            if (!p.startsWith("/")) {
                p = `${from.replace(/[^/]*$/, "")}${p}`;
            }
            if (!p.includes("?") && !FORBIDDEN.test(p)) {
                found.add(p);
            }
        };
        for (const m of html.matchAll(
            /(?:href|src|action)\s*=\s*["']?([^"'\s>]+)/gi,
        )) {
            add(m[1]);
        }
        for (const m of html.matchAll(
            /["']([A-Za-z0-9_\-/]+\.(?:htm|html|asp))["']/g,
        )) {
            add(m[1]);
        }
        return [...found];
    }

    /**
     * Reads pages starting at the home page (links only, at most `max` pages).
     *
     * @param {number} [max]
     * @returns {Promise<Map<string, string>>}
     */
    async crawl(max = 40) {
        const queue = ["/home.htm"];
        const seen = new Set();
        while (queue.length && seen.size < max) {
            const p = /** @type {string} */ (queue.shift());
            if (seen.has(p)) {
                continue;
            }
            seen.add(p);
            let html = this.pages.get(p);
            if (html === undefined) {
                try {
                    const r = await this.request("GET", p);
                    if (r.status !== 200) {
                        continue;
                    }
                    html = r.text;
                } catch {
                    continue;
                }
                this.pages.set(p, html);
            }
            for (const l of this.linksOf(html, p)) {
                if (!seen.has(l)) {
                    queue.push(l);
                }
            }
        }
        return this.pages;
    }

    /**
     * Model and firmware version from whatever page carries them.
     *
     * @returns {{ model: string|null, firmware: string|null, firmwareText: string|null, mac: string|null, serialNo: string|null }}
     */
    parseInfo() {
        let model = null;
        let firmware = null;
        let firmwareText = null;
        let mac = null;
        let serialNo = null;
        for (const html of this.pages.values()) {
            // the overview page fills its fields by script: getElementById("ver").innerHTML="2.11 Build 23081519"
            const field = (/** @type {string} */ id) => {
                const m = new RegExp(
                    `getElementById\\("${id}"\\)\\.innerHTML="([^"]*)"`,
                ).exec(html);
                return m && m[1].trim() ? m[1].trim() : null;
            };
            const jsModel = field("modelname");
            const jsVer = field("ver");
            if (jsModel && !model) {
                model = jsModel.replace(/\s+/, " ");
            }
            if (jsVer && !firmware) {
                const v = /^v?([0-9]+(?:\.[0-9]+)+)/i.exec(jsVer);
                if (v) {
                    firmware = v[1];
                    firmwareText = jsVer;
                }
            }
            mac = mac || field("mac");
            serialNo = serialNo || field("serialno");
            const t = stripTags(html);
            if (!model) {
                const m =
                    /Model\s*name\s*[:=]?\s*(NPort\s*[0-9A-Za-z-]+)/i.exec(t) ||
                    /\b(NPort\s*[0-9]{4}[A-Za-z]?(?:-[A-Za-z0-9]+)?)\b/i.exec(
                        t,
                    );
                if (m) {
                    model = m[1].replace(/\s+/, " ");
                }
            }
            if (!firmware) {
                const m =
                    /Firmware\s*version\s*[:=]?\s*(?:v(?:ersion)?\s*)?([0-9]+(?:\.[0-9]+)+)([^A-Za-z]{0,40}Build\s*[0-9A-Za-z]+)?/i.exec(
                        t,
                    );
                if (m) {
                    firmware = m[1];
                    firmwareText = m[0].replace(/\s+/g, " ");
                }
            }
        }
        return { model, firmware, firmwareText, mac, serialNo };
    }

    /**
     * Operating mode and serial settings of port 1 from the two view pages.
     *
     * @returns {{ mode: string|null, serial: string|null }}
     */
    parseSettings() {
        let mode = null;
        let serial = null;
        const op = this.pages.get("/04View.htm");
        if (op) {
            const m =
                /\b1\s+(Real COM Mode|TCP Server Mode|TCP Client Mode|UDP Mode|RFC 2217 Mode|Pair Connection (?:Slave|Master) Mode|Reverse Telnet Mode|Disabled)/i.exec(
                    stripTags(op),
                );
            mode = m ? m[1] : null;
        }
        const se = this.pages.get("/03View.htm");
        if (se) {
            const m =
                /Port\s+1\s+(?:&nbsp;\s*)?([0-9]{3,6})\s+([5-8])\s+([12])\s+(None|Even|Odd|Mark|Space)/i.exec(
                    stripTags(se),
                );
            if (m) {
                serial = `${m[1]} ${m[2]}${m[4][0].toUpperCase()}${m[3]}`;
            }
        }
        return { mode, serial };
    }

    /**
     * The page with a form that takes a file (the firmware upload).
     *
     * @returns {{ path: string, action: string, method: string, fileField: string, hidden: Record<string,string> }[]}
     */
    findUploadForms() {
        const out = [];
        for (const [p, html] of this.pages) {
            for (const f of html.matchAll(
                /<form\b([^>]*)>([\s\S]*?)<\/form>/gi,
            )) {
                const inner = f[2];
                const file =
                    /<input\b[^>]*type\s*=\s*["']?file["']?[^>]*>/i.exec(inner);
                if (!file) {
                    continue;
                }
                const name = /name\s*=\s*["']?([^"'\s>]+)/i.exec(file[0]);
                const action = /action\s*=\s*["']?([^"'\s>]+)/i.exec(f[1]);
                const method = /method\s*=\s*["']?(\w+)/i.exec(f[1]);
                /** @type {Record<string,string>} */
                const hidden = {};
                for (const h of inner.matchAll(
                    /<input\b[^>]*type\s*=\s*["']?hidden["']?[^>]*>/gi,
                )) {
                    const n = /name\s*=\s*["']?([^"'\s>]+)/i.exec(h[0]);
                    const v =
                        /value\s*=\s*["']([^"']*)["']/i.exec(h[0]) ||
                        /value\s*=\s*([^\s>]+)/i.exec(h[0]);
                    if (n) {
                        hidden[n[1]] = v ? v[1] : "";
                    }
                }
                let a = action ? action[1] : p;
                if (!a.startsWith("/")) {
                    a = `${p.replace(/[^/]*$/, "")}${a}`;
                }
                out.push({
                    path: p,
                    action: a,
                    method: (method ? method[1] : "post").toUpperCase(),
                    fileField: name ? name[1] : "file",
                    hidden,
                });
            }
        }
        return out;
    }

    /**
     * Posts the firmware file as multipart form data.
     *
     * @param {{ action: string, fileField: string, hidden: Record<string,string> }} form
     * @param {Buffer} data
     * @param {string} filename
     */
    async upload(form, data, filename) {
        const boundary = `----iob${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const parts = [];
        for (const [k, v] of Object.entries(form.hidden)) {
            parts.push(
                Buffer.from(
                    `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
                    "latin1",
                ),
            );
        }
        parts.push(
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${form.fileField}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
                "latin1",
            ),
        );
        parts.push(data);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "latin1"));
        return this.request("POST", form.action, {
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
            },
            body: Buffer.concat(parts),
            timeoutMs: 120000,
        });
    }

    /**
     * A link to a configuration export, if the console offers one (only looked at, never triggered by guessing).
     *
     * @returns {string|null}
     */
    findExportLink() {
        for (const [p, html] of this.pages) {
            for (const m of html.matchAll(
                /href\s*=\s*["']?([^"'\s>]*(?:export|\.ini|\.cfg|config(?:uration)?file)[^"'\s>]*)/gi,
            )) {
                if (!/import|restore|upload/i.test(m[1])) {
                    return m[1].startsWith("/")
                        ? m[1]
                        : `${p.replace(/[^/]*$/, "")}${m[1]}`;
                }
            }
        }
        return null;
    }
}

module.exports = { MoxaWeb, stripTags, FORBIDDEN };
