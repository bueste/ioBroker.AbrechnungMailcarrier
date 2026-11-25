"use strict";

/**
 * RouterOS commands and the reading of their output. The same commands work on RouterOS 6 and 7.
 */

/**
 * "key: value" lines of a print output. @param {string} text @returns {Record<string,string>}
 *
 * @param text
 */
function parseKv(text) {
    /** @type {Record<string,string>} */
    const out = {};
    for (const line of String(text).split("\n")) {
        const m = /^\s*([a-z][a-z0-9-]*):\s*(.*?)\s*$/i.exec(line);
        if (m) {
            out[m[1].toLowerCase()] = m[2];
        }
    }
    return out;
}

/**
 * "7.16.2 (stable)" -> "7.16.2" @param {string|undefined} v
 *
 * @param v
 */
function versionOf(v) {
    const m = /(\d+(?:\.\d+)+)/.exec(String(v || ""));
    return m ? m[1] : null;
}

/**
 * @param {string} a @param {string} b @returns {number}
 * @param b
 */
function compareVersions(a, b) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) {
            return d;
        }
    }
    return 0;
}

/** @typedef {(command: string, timeoutMs?: number) => Promise<{ code: number|null, out: string, err: string }>} Exec */

/**
 * What the router is and what it runs.
 *
 * @param {Exec} exec
 * @returns {Promise<{ ok: boolean, error?: string, version?: string, board?: string, identity?: string, uptime?: string, routerboard?: boolean, model?: string, rbCurrent?: string|null, rbUpgrade?: string|null }>}
 */
async function readInfo(exec) {
    const res = await exec("/system resource print");
    if (res.code !== 0) {
        return {
            ok: false,
            error: (res.err || res.out || "keine Antwort")
                .trim()
                .split("\n")[0],
        };
    }
    const r = parseKv(res.out);
    const version = versionOf(r.version);
    if (!version) {
        return {
            ok: false,
            error: "RouterOS-Version in der Antwort nicht gefunden",
        };
    }
    const rb = parseKv((await exec("/system routerboard print")).out);
    const id = parseKv((await exec("/system identity print")).out);
    return {
        ok: true,
        version,
        board: r["board-name"] || "",
        identity: id.name || "",
        uptime: r.uptime || "",
        routerboard: rb.routerboard === "yes",
        model: rb.model || r["board-name"] || "",
        rbCurrent: versionOf(rb["current-firmware"]),
        rbUpgrade: versionOf(rb["upgrade-firmware"]),
    };
}

/**
 * Sets the channel and asks MikroTik which version is newest.
 *
 * @param {Exec} exec
 * @param {string} channel stable, long-term, testing
 * @returns {Promise<{ ok: boolean, error?: string, installed?: string, latest?: string|null, newer?: boolean, status?: string }>}
 */
async function checkUpdate(exec, channel) {
    if (!/^(stable|long-term|testing|development)$/.test(channel)) {
        return { ok: false, error: `Unbekannter Kanal "${channel}"` };
    }
    await exec(`/system package update set channel=${channel}`);
    let kv = {};
    for (let i = 0; i < 3; i++) {
        const r = await exec(
            "/system package update check-for-updates once",
            90000,
        );
        kv = parseKv(r.out);
        if (r.code !== 0 && !kv.status) {
            // RouterOS 6 has no "once"
            const r6 = await exec(
                "/system package update check-for-updates",
                90000,
            );
            kv = parseKv(r6.out);
        }
        if (
            kv["latest-version"] ||
            /error|could not|no.*route|fail/i.test(kv.status || "")
        ) {
            break;
        }
    }
    const installed = versionOf(
        kv["installed-version"] || kv["current-version"],
    );
    const latest = versionOf(kv["latest-version"]);
    if (!installed) {
        return {
            ok: false,
            error: `Update-Abfrage ohne Versionsangabe${kv.status ? ` (${kv.status})` : ""}`,
        };
    }
    if (!latest) {
        return {
            ok: false,
            error: `MikroTik meldet keine neueste Version${kv.status ? ` (${kv.status})` : ""}`,
        };
    }
    return {
        ok: true,
        installed,
        latest,
        newer: compareVersions(latest, installed) > 0,
        status: kv.status || "",
    };
}

module.exports = { parseKv, versionOf, compareVersions, readInfo, checkUpdate };
