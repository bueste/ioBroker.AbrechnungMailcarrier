"use strict";

/**
 * @typedef {object} ApiResult
 * @property {boolean} ok            HTTP 200 with ok:true
 * @property {number} status         HTTP status, 0 if the server could not be reached
 * @property {"ok"|"auth"|"rejected"|"transient"} kind
 *   auth = token missing/invalid/revoked; rejected = the server read the request and refused its content
 *   (retrying the same data will not help); transient = network or server problem, try again later
 * @property {string} message
 * @property {string[]} details      validation messages of the server, if any
 * @property {any} data              decoded JSON body, if any
 */

/**
 * Client of the data API of the Abrechnung web application (public/api/v1/).
 */
class ApiClient {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl   e.g. "https://abr.example.ch/api/v1"
     * @param {string} opts.token     bearer token ("abrk_...")
     * @param {typeof fetch} [opts.fetchImpl]
     * @param {number} [opts.timeoutMs]
     * @param {string} [opts.userAgent]
     */
    constructor(opts) {
        this.baseUrl = String(opts.baseUrl || "").replace(/\/+$/, "");
        this.token = String(opts.token || "");
        this.fetchImpl = opts.fetchImpl || fetch;
        this.timeoutMs = opts.timeoutMs || 30000;
        this.userAgent = opts.userAgent || "iobroker.abrechnungmailcarrier";
    }

    /** @returns {Promise<ApiResult>} */
    status() {
        return this._request("GET", "status.php");
    }

    /**
     * @param {object} payload   { schema, source, adapter_version, meter_daily, building_daily, ... }
     * @returns {Promise<ApiResult>}
     */
    ingest(payload) {
        return this._request("POST", "ingest.php", JSON.stringify(payload));
    }

    /**
     * @param {string} method
     * @param {string} file
     * @param {string} [body]
     * @returns {Promise<ApiResult>}
     */
    async _request(method, file, body) {
        if (
            !/^https:\/\//i.test(this.baseUrl) &&
            !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(
                this.baseUrl,
            )
        ) {
            return fail("rejected", 0, "The API URL must start with https://.");
        }
        if (!this.token) {
            return fail("auth", 0, "No API token configured.");
        }
        /** @type {Record<string,string>} */
        const headers = {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            "User-Agent": this.userAgent,
        };
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
        }
        let res;
        let text;
        try {
            res = await this.fetchImpl(`${this.baseUrl}/${file}`, {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(this.timeoutMs),
                redirect: "error",
            });
            text = await res.text();
        } catch (e) {
            return fail(
                "transient",
                0,
                `Server not reachable: ${e && e.message ? e.message : e}`,
            );
        }
        let data = null;
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
        const message =
            data && typeof data.message === "string"
                ? data.message
                : `HTTP ${res.status}`;
        const details =
            data && Array.isArray(data.details) ? data.details.map(String) : [];
        if (res.status === 200 && data && data.ok === true) {
            return {
                ok: true,
                status: 200,
                kind: "ok",
                message: "ok",
                details,
                data,
            };
        }
        if (res.status === 401 || res.status === 403) {
            return {
                ok: false,
                status: res.status,
                kind: "auth",
                message,
                details,
                data,
            };
        }
        if (res.status === 429 || res.status >= 500 || res.status === 200) {
            // 200 without ok:true is not our API (proxy error page, captive portal): treat as a transient fault
            return {
                ok: false,
                status: res.status,
                kind: "transient",
                message,
                details,
                data,
            };
        }
        return {
            ok: false,
            status: res.status,
            kind: "rejected",
            message,
            details,
            data,
        };
    }
}

/**
 * @param {ApiResult["kind"]} kind
 * @param {number} status
 * @param {string} message
 * @returns {ApiResult}
 */
function fail(kind, status, message) {
    return { ok: false, status, kind, message, details: [], data: null };
}

module.exports = { ApiClient };
