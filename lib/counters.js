"use strict";

const { addDays } = require("./dates");
const { computeDay } = require("./days");

/**
 * Source "counters": the day's figures are derived from energy states of other adapters (e.g. Shelly energy
 * meters for the consumption of an apartment, an inverter adapter for the production). Used where there is
 * no device that does the bookkeeping itself.
 *
 * @typedef {import("./days").DayRecord} DayRecord
 * @typedef {{ stateId: string, unit: "kWh"|"Wh", mode: "counter"|"daily" }} EnergySource
 * @typedef {EnergySource & { name: string }} MeterSource
 * @typedef {{ date: string, values: Record<string, number> }} Snapshot
 * @typedef {{ val: any, ts?: number }|null|undefined} StateLike
 * @typedef {object} CounterConfig
 * @property {MeterSource[]} meters
 * @property {EnergySource[]} production
 * @property {EnergySource[]} feedin
 * @property {number} staleMinutes
 */

/**
 * @param {any} v @param {string} unit @returns {number|null}
 * @param unit
 */
function toKwh(v, unit) {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") {
        return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
        return null;
    }
    return unit === "Wh" ? n / 1000 : n;
}

/**
 * Reads the energy of the day from one source.
 *
 * @param {EnergySource} src
 * @param {(id: string) => StateLike} getState
 * @param {Record<string, number>} prev        values of the previous snapshot (kWh)
 * @param {Record<string, number>} next        receives the current value of counter sources (kWh)
 * @param {number} nowMs
 * @param {number} staleMs
 * @param {string[]} warnings
 * @returns {{ kwh: number|null, stale: boolean }}
 */
function readSource(src, getState, prev, next, nowMs, staleMs, warnings) {
    const st = getState(src.stateId);
    const current = toKwh(st && st.val, src.unit);
    if (current === null) {
        warnings.push(`${src.stateId}: no numeric value`);
        return { kwh: null, stale: false };
    }
    const stale = !!(
        st &&
        typeof st.ts === "number" &&
        nowMs - st.ts > staleMs
    );
    if (src.mode === "daily") {
        return { kwh: Math.max(0, current), stale };
    }
    next[src.stateId] = current;
    const before = prev[src.stateId];
    if (before === undefined) {
        warnings.push(
            `${src.stateId}: no earlier reading yet, this is the starting point`,
        );
        return { kwh: null, stale };
    }
    if (current < before) {
        // a counter that went backwards was reset or replaced: what it shows now was counted since then
        warnings.push(
            `${src.stateId}: counter went back from ${before} to ${current}, taking ${current} as the day's value`,
        );
        return { kwh: current, stale };
    }
    return { kwh: current - before, stale };
}

/**
 * Closes the billing day `date`: reads all configured states, computes the day record and the snapshot to keep
 * for the next day.
 *
 * @param {object} p
 * @param {string} p.date                 the day being closed ("YYYY-MM-DD")
 * @param {CounterConfig} p.config
 * @param {(id: string) => StateLike} p.getState
 * @param {Snapshot|null} p.snapshot      snapshot of the previous run
 * @param {number} p.nowMs
 * @returns {{ day: DayRecord|null, snapshot: Snapshot, warnings: string[] }}
 */
function closeDay(p) {
    /** @type {string[]} */
    const warnings = [];
    /** @type {Record<string, number>} */
    const next = {};
    const prev = p.snapshot ? p.snapshot.values : {};
    const staleMs = Math.max(1, p.config.staleMinutes) * 60000;
    if (p.snapshot && p.snapshot.date >= p.date) {
        // this day was closed already: closing it again would use today's readings as tomorrow's baseline twice
        return {
            day: null,
            snapshot: p.snapshot,
            warnings: [`${p.date} is already closed`],
        };
    }
    const continuous = !!p.snapshot && p.snapshot.date === addDays(p.date, -1);
    if (p.snapshot && !continuous) {
        warnings.push(
            `last reading was ${p.snapshot.date}: the days in between cannot be reconstructed from counters and are skipped`,
        );
    }
    const base = continuous ? prev : {};

    let stale = false;
    let incomplete = false;
    const meters = p.config.meters.map((m) => {
        const r = readSource(
            m,
            p.getState,
            base,
            next,
            p.nowMs,
            staleMs,
            warnings,
        );
        stale = stale || r.stale;
        incomplete = incomplete || r.kwh === null;
        return { meter: m.name, kwh: r.kwh ?? 0 };
    });
    let production = 0;
    for (const s of p.config.production) {
        const r = readSource(
            s,
            p.getState,
            base,
            next,
            p.nowMs,
            staleMs,
            warnings,
        );
        stale = stale || r.stale;
        incomplete = incomplete || r.kwh === null;
        production += r.kwh ?? 0;
    }
    let feedin = p.config.feedin.length > 0 ? 0 : null;
    for (const s of p.config.feedin) {
        const r = readSource(
            s,
            p.getState,
            base,
            next,
            p.nowMs,
            staleMs,
            warnings,
        );
        stale = stale || r.stale;
        if (r.kwh === null) {
            feedin = null; // without a complete feed-in figure the building balance is used
            break;
        }
        feedin = (feedin ?? 0) + r.kwh;
    }

    const snapshot = { date: p.date, values: next };
    if (incomplete || meters.length === 0) {
        return { day: null, snapshot, warnings };
    }
    const day = computeDay({
        date: p.date,
        meters,
        productionKwh: production,
        feedinKwh: feedin,
        quality: stale ? "veraltet" : "ok",
    });
    return { day, snapshot, warnings };
}

/**
 * Normalises the table rows of the admin UI into a usable configuration.
 *
 * @param {any} native   adapter.config
 * @returns {{ config: CounterConfig, errors: string[] }}
 */
function parseCounterConfig(native) {
    /** @type {string[]} */
    const errors = [];
    /** @param {any} row @returns {EnergySource|null} */
    const source = (row) => {
        const stateId = String((row && row.stateId) || "").trim();
        if (!stateId) {
            return null;
        }
        return {
            stateId,
            unit: row.unit === "Wh" ? "Wh" : "kWh",
            mode: row.mode === "daily" ? "daily" : "counter",
        };
    };
    const list = (/** @type {any} */ v) => (Array.isArray(v) ? v : []);
    /** @type {MeterSource[]} */
    const meters = [];
    const names = new Set();
    for (const row of list(native.meters)) {
        const s = source(row);
        const name = String((row && row.name) || "").trim();
        if (!s && !name) {
            continue;
        }
        if (!s || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(name)) {
            errors.push(`Unit "${name}": name or state missing/invalid`);
            continue;
        }
        if (names.has(name)) {
            errors.push(`Unit "${name}" is configured twice`);
            continue;
        }
        names.add(name);
        meters.push({ name, ...s });
    }
    const sources = (/** @type {any} */ v) =>
        list(v)
            .map(source)
            .filter((s) => s !== null);
    const staleMinutes = Number(native.staleMinutes);
    return {
        config: {
            meters,
            production: /** @type {EnergySource[]} */ (
                sources(native.production)
            ),
            feedin: /** @type {EnergySource[]} */ (sources(native.feedin)),
            staleMinutes:
                Number.isFinite(staleMinutes) && staleMinutes > 0
                    ? staleMinutes
                    : 60,
        },
        errors,
    };
}

module.exports = { toKwh, closeDay, parseCounterConfig };
