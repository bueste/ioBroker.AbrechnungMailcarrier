"use strict";

/**
 * Builds the base URL of the API from the configured server.
 *
 * The server is entered as a host name ("abr.example.ch", optionally with a port). The connection is always
 * HTTPS; plain HTTP is only accepted for localhost (development and tests), so a token can never be sent
 * unencrypted because of a typing mistake.
 *
 * @param {{ host?: string, apiPath?: string, apiUrl?: string }} native
 * @returns {{ baseUrl: string, error: string }}
 */
function buildBaseUrl(native) {
    let host = String(native.host || "").trim();
    if (!host && native.apiUrl) {
        // configuration of an earlier version: a complete URL
        const m = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(
            String(native.apiUrl).trim(),
        );
        if (!m) {
            return {
                baseUrl: "",
                error: "The configured API URL is not valid.",
            };
        }
        host = m[2];
        native = { ...native, apiPath: m[3] || native.apiPath };
    }
    if (!host) {
        return { baseUrl: "", error: "No server configured." };
    }
    host = host.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (
        !/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/i.test(
            host,
        )
    ) {
        return {
            baseUrl: "",
            error: `"${host}" is not a valid host name (enter only the name, e.g. abr.example.ch).`,
        };
    }
    let path = String(native.apiPath || "/api/v1").trim();
    if (!path.startsWith("/")) {
        path = `/${path}`;
    }
    path = path.replace(/\/+$/, "");
    if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) {
        return { baseUrl: "", error: `"${path}" is not a valid API path.` };
    }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    return {
        baseUrl: `${local ? "http" : "https"}://${host}${path}`,
        error: "",
    };
}

/**
 * Applies the unit table of the configuration to the meter rows of a day: a unit of the source can be renamed
 * to the name the billing knows, or be left out (e.g. a meter that must not be billed).
 *
 * @param {import("./days").DayRecord[]} days
 * @param {{ source?: string, target?: string, skip?: boolean }[]} map
 * @returns {import("./days").DayRecord[]}
 */
function applyUnitMap(days, map) {
    const rules = new Map();
    for (const r of Array.isArray(map) ? map : []) {
        const source = String((r && r.source) || "").trim();
        if (source) {
            rules.set(source, {
                target: String(r.target || "").trim(),
                skip: r.skip === true,
            });
        }
    }
    if (rules.size === 0) {
        return days;
    }
    return days.map((day) => {
        const meters = [];
        const seen = new Set();
        for (const m of day.meters) {
            const rule = rules.get(m.meter);
            if (rule && rule.skip) {
                continue;
            }
            const mapped =
                rule && rule.target ? { ...m, meter: rule.target } : m;
            // two source units renamed to the same name would be refused by the server as a duplicate: keep the first
            if (!seen.has(mapped.meter)) {
                seen.add(mapped.meter);
                meters.push(mapped);
            }
        }
        return { ...day, meters };
    });
}

module.exports = { buildBaseUrl, applyUnitMap };
