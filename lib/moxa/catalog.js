"use strict";

const crypto = require("node:crypto");

/**
 * Which firmware is the newest for an NPort, taken from Moxa's own software page of the product series (the page
 * lists every firmware with version, size, date and SHA-512). The file is only used if its SHA-512 matches the
 * checksum Moxa publishes.
 */

const UA =
    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const PAGE =
    "https://www.moxa.com/en/support/product-support/software-and-documentation?psid=";
/** product series page ids (psid) by model number; extend when other models are installed */
const SERIES = { 5110: 50254, 5130: 50254, 5150: 50254 };

/** @param {string} s */
const text = (s) =>
    s
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * @param {string} html page of the series
 * @returns {{ label: string, url: string, size: string, sha512: string, version: string, date: string }[]}
 */
function parseSoftwarePage(html) {
    const out = [];
    for (const m of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
        const row = m[0];
        if (!/data-type="Firmware"/i.test(row)) {
            continue;
        }
        const label = /js-checksum-filename[^>]*>([\s\S]*?)<\/span>/i.exec(row);
        const url = /href="([^"]+\.rom)"/i.exec(row);
        const sha = /js-checksum"?[^>]*>\s*([0-9A-Fa-f]{128})\s*</i.exec(row);
        const ver = /version-short[^>]*>\s*v?([0-9][0-9.]*)\s*</i.exec(row);
        const size = /border-table__note">\s*([0-9.,]+\s*[KMG]B)\s*</i.exec(
            row,
        );
        const date = /date-short[^>]*>\s*(\d{4}-\d{2}-\d{2})/i.exec(row);
        if (label && url && sha && ver) {
            out.push({
                label: text(label[1]),
                url: url[1],
                size: size ? size[1] : "",
                sha512: sha[1].toLowerCase(),
                version: ver[1],
                date: date ? date[1] : "",
            });
        }
    }
    return out;
}

/**
 * "NPort 5110" -> "5110", "NPort 5110A" -> "5110A", "NPort 5110-T" -> "5110". @param {string} model
 *
 * @param model
 */
function modelKey(model) {
    const m = /(\d{4}[A-Za-z]?)/.exec(String(model || ""));
    return m ? m[1].toUpperCase() : null;
}

/**
 * @param {ReturnType<typeof parseSoftwarePage>} entries
 * @param {string} model
 */
function pickFor(entries, model) {
    const key = modelKey(model);
    if (!key) {
        return null;
    }
    const hits = entries.filter((e) => {
        const tokens = e.label
            .toUpperCase()
            .split(/[\s/,()]+/)
            .map((t) => t.replace(/-T$/, ""));
        return tokens.includes(key);
    });
    hits.sort((a, b) => compareVersions(b.version, a.version));
    return hits[0] || null;
}

/**
 * Numeric comparison of dotted versions ("2.9" < "2.11"). @returns {number} <0, 0, >0
 *
 * @param a
 * @param b
 */
function compareVersions(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) {
            return d;
        }
    }
    return 0;
}

/**
 * @param {string} model e.g. "NPort 5110"
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, error?: string, latest?: ReturnType<typeof parseSoftwarePage>[number] }>}
 */
async function fetchLatest(model, fetchImpl = fetch) {
    const key = modelKey(model);
    const base = key ? Number(key.replace(/\D/g, "")) : 0;
    if (!key || !SERIES[base] || /[A-Z]$/.test(key)) {
        return {
            ok: false,
            error: `Für das Modell "${model}" ist noch keine Firmware-Quelle hinterlegt.`,
        };
    }
    let res;
    try {
        res = await fetchImpl(PAGE + SERIES[base], {
            headers: { "User-Agent": UA },
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        return { ok: false, error: `moxa.com nicht erreichbar: ${e.message}` };
    }
    if (!res.ok) {
        return {
            ok: false,
            error: `moxa.com antwortet mit HTTP ${res.status}`,
        };
    }
    const entries = parseSoftwarePage(await res.text());
    const latest = pickFor(entries, model);
    return latest
        ? { ok: true, latest }
        : {
              ok: false,
              error: `Auf der Moxa-Seite keine Firmware für "${model}" gefunden (${entries.length} Einträge gelesen).`,
          };
}

/**
 * Downloads the file and checks it against the published SHA-512. Nothing unverified is ever returned.
 *
 * @param {{ url: string, sha512: string }} entry
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, error?: string, data?: Buffer }>}
 */
async function download(entry, fetchImpl = fetch) {
    let res;
    try {
        res = await fetchImpl(entry.url, {
            headers: { "User-Agent": UA },
            signal: AbortSignal.timeout(120000),
        });
    } catch (e) {
        return { ok: false, error: `Download fehlgeschlagen: ${e.message}` };
    }
    if (!res.ok) {
        return { ok: false, error: `Download: HTTP ${res.status}` };
    }
    const data = Buffer.from(await res.arrayBuffer());
    const sum = crypto.createHash("sha512").update(data).digest("hex");
    if (sum !== entry.sha512.toLowerCase()) {
        return {
            ok: false,
            error: "Die Prüfsumme (SHA-512) der heruntergeladenen Firmware stimmt nicht mit der von Moxa veröffentlichten überein, Datei verworfen.",
        };
    }
    if (data.length < 50 * 1024 || data.length > 8 * 1024 * 1024) {
        return {
            ok: false,
            error: `Unplausible Dateigrösse (${data.length} Bytes), Datei verworfen.`,
        };
    }
    return { ok: true, data };
}

module.exports = {
    parseSoftwarePage,
    modelKey,
    pickFor,
    compareVersions,
    fetchLatest,
    download,
    SERIES,
};
