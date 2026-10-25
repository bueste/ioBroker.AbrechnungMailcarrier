"use strict";

const { missingOnServer } = require("./days");
const { buildPayloads } = require("./payload");

/**
 * Delivery of the local journal to the server. All side effects are injected, so the behaviour is testable
 * without ioBroker and without a network.
 *
 * What is sent is decided by the server's own status (which days it already has), not by a local "sent"
 * flag: that way a restored server database, a lost response or a gap in the middle are all made up for
 * by the next run, and nothing the server already holds is overwritten.
 *
 * @typedef {import("./days").DayRecord} DayRecord
 * @typedef {import("./api").ApiClient} ApiClient
 * @typedef {object} SyncResult
 * @property {"ok"|"transient"|"auth"|"rejected"|"idle"} outcome
 * @property {number} sentDays        days the server accepted in this run
 * @property {number} pendingDays     days still missing on the server after this run
 * @property {string[]} rejectedDates days the server refused for their content
 * @property {boolean} retrySoon      worth trying again in a few minutes (network/server trouble)
 * @property {string} message
 */

/**
 * @param {object} deps
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} deps.log
 * @param {Pick<ApiClient, "status"|"ingest">} deps.api
 * @param {() => Promise<DayRecord[]>} deps.loadJournal
 * @param {(info: {connection?: boolean, lastDelivery?: string, lastDeliveredDate?: string, pendingDays?: number, lastError?: string, rejectedDates?: string[]}) => Promise<void>} deps.setInfo
 * @param {() => string} deps.today   local "YYYY-MM-DD"
 * @param {string} deps.version
 * @param {string} deps.source
 * @param {number} [deps.maxRows]   rows per request (default: see payload.js)
 */
function createDelivery(deps) {
    const { log } = deps;
    let running = false;

    /** @returns {Promise<SyncResult>} */
    async function sync() {
        if (running) {
            return {
                outcome: "idle",
                sentDays: 0,
                pendingDays: 0,
                rejectedDates: [],
                retrySoon: false,
                message: "already running",
            };
        }
        running = true;
        try {
            return await run();
        } finally {
            running = false;
        }
    }

    /** @returns {Promise<SyncResult>} */
    async function run() {
        const journal = await deps.loadJournal();
        const st = await deps.api.status();
        if (!st.ok) {
            return failed(st.kind, st.message, journal.length);
        }
        await deps.setInfo({
            connection: true,
            lastContact: new Date().toISOString(),
        });

        const missing = missingOnServer(journal, st.data, deps.today());
        if (missing.length === 0) {
            await deps.setInfo({
                pendingDays: 0,
                lastError: "",
                rejectedDates: [],
            });
            return {
                outcome: "ok",
                sentDays: 0,
                pendingDays: 0,
                rejectedDates: [],
                retrySoon: false,
                message: "nothing to deliver",
            };
        }

        const tariffs = Array.isArray(st.data.tariffs) ? st.data.tariffs : [];
        const requests = buildPayloads(missing, tariffs, {
            source: deps.source,
            version: deps.version,
            maxRows: deps.maxRows,
        });
        let sentDays = 0;
        let lastDelivered = "";
        /** @type {string[]} */
        const rejectedDates = [];
        const missingDates = new Set(missing.map((d) => d.date));

        /**
         * @param {string[]} dates @param {Record<string, any>} payload
         * @param payload
         */
        const deliver = async (dates, payload) => {
            const res = await deps.api.ingest(payload);
            if (res.ok) {
                sentDays += dates.length;
                for (const d of dates) {
                    missingDates.delete(d);
                    if (d > lastDelivered) {
                        lastDelivered = d;
                    }
                }
                const d = res.data || {};
                log.info(
                    `Delivered ${dates.join(", ")}: new ${d.inserted ?? "?"}, changed ${d.updated ?? "?"}, unchanged ${d.unchanged ?? "?"}`,
                );
            }
            return res;
        };

        for (const req of requests) {
            let res = await deliver(req.dates, req.payload);
            if (!res.ok && res.kind === "rejected" && req.dates.length > 1) {
                // one faulty day must not keep the others from being delivered: retry day by day
                log.warn(
                    `Delivery refused (${res.message}); retrying ${req.dates.length} days one by one`,
                );
                for (const date of req.dates) {
                    const single = buildPayloads(
                        missing.filter((d) => d.date === date),
                        tariffs,
                        {
                            source: deps.source,
                            version: deps.version,
                            maxRows: deps.maxRows,
                        },
                    )[0];
                    const r = await deliver(single.dates, single.payload);
                    if (!r.ok && r.kind === "rejected") {
                        rejectedDates.push(date);
                        log.error(
                            `The server refused ${date}: ${r.message} ${r.details.join(" | ")}`.trim(),
                        );
                    } else if (!r.ok) {
                        res = r;
                        break;
                    }
                }
                if (res.ok || res.kind === "rejected") {
                    continue;
                }
            }
            if (!res.ok && res.kind === "rejected" && req.dates.length === 1) {
                rejectedDates.push(req.dates[0]);
                log.error(
                    `The server refused ${req.dates[0]}: ${res.message} ${res.details.join(" | ")}`.trim(),
                );
                continue;
            }
            if (!res.ok) {
                const r = await failed(
                    res.kind,
                    res.message,
                    missingDates.size,
                );
                if (sentDays > 0) {
                    await deps.setInfo({
                        lastDelivery: new Date().toISOString(),
                        lastDeliveredDate: lastDelivered,
                    });
                }
                return { ...r, sentDays, rejectedDates };
            }
        }

        const pending = missingDates.size;
        await deps.setInfo({
            ...(sentDays > 0
                ? {
                      lastDelivery: new Date().toISOString(),
                      lastDeliveredDate: lastDelivered,
                  }
                : {}),
            pendingDays: pending,
            rejectedDates,
            lastError:
                rejectedDates.length > 0
                    ? `The server refused: ${rejectedDates.join(", ")} (see log)`
                    : "",
        });
        return {
            outcome: rejectedDates.length > 0 ? "rejected" : "ok",
            sentDays,
            pendingDays: pending,
            rejectedDates,
            retrySoon: false,
            message:
                rejectedDates.length > 0
                    ? `refused: ${rejectedDates.join(", ")}`
                    : `delivered ${sentDays} day(s)`,
        };
    }

    /**
     * @param {"auth"|"rejected"|"transient"|"ok"} kind
     * @param {string} message
     * @param {number} pendingDays
     * @returns {Promise<SyncResult>}
     */
    async function failed(kind, message, pendingDays) {
        const transient = kind === "transient";
        if (kind === "auth") {
            log.error(`The server does not accept the API token: ${message}`);
        } else if (transient) {
            log.warn(`Delivery postponed: ${message}`);
        } else {
            log.error(`The server refused the request: ${message}`);
        }
        await deps.setInfo({
            connection: !transient && kind !== "auth",
            pendingDays,
            lastError: message,
        });
        return {
            outcome: kind === "ok" ? "ok" : kind,
            sentDays: 0,
            pendingDays,
            rejectedDates: [],
            retrySoon: transient,
            message,
        };
    }

    return { sync };
}

module.exports = { createDelivery };
