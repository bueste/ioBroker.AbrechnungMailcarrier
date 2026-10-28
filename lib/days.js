"use strict";

const { isDate, addDays } = require("./dates");

/**
 * A "day record" is the unit this adapter stores and delivers: everything known about one billing day.
 *
 * @typedef {object} MeterDay
 * @property {string} meter
 * @property {number|null} zStartKwh   meter reading at the start of the day, if known
 * @property {number|null} zEndeKwh
 * @property {number} verbrauchKwh
 * @property {number} solarKwh
 * @property {number} netzKwh
 * @property {number|null} tarifNetz   CHF/kWh used by the source, if it had one
 * @property {number|null} tarifSolar
 * @typedef {object} BuildingDay
 * @property {number} produktionKwh
 * @property {number} verbrauchKwh
 * @property {number} einspeisungKwh
 * @property {number|null} autarkiegrad  share of the building consumption covered by own production (0..1)
 * @typedef {object} DayRecord
 * @property {string} date                 "YYYY-MM-DD"
 * @property {"tagesnetto"|"integriert"} method
 * @property {"ok"|"veraltet"|"vorlaeufig"} quality   "vorlaeufig": intraday snapshot of the day so far, replaced by the final day
 * @property {MeterDay[]} meters
 * @property {BuildingDay|null} building
 */

/** Days kept in the local journal; a delivery outage up to this long is made up for afterwards. */
const MAX_DAYS = 120;

const METHODS = ["tagesnetto", "integriert"];

/** @param {any} v @returns {number|null} */
function num(v) {
    if (v === null || v === undefined || v === "") {
        return null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Reads the local daily journal of the iobroker.solarlog adapter (state Database.dailyJournal): a JSON list of
 * { date, meterRows, buildingRow } where the rows have the column names of the former database tables.
 * Entries that cannot be used are skipped, never thrown on: one bad night must not block the others.
 *
 * @param {string|null|undefined} raw
 * @returns {{ days: DayRecord[], skipped: string[] }}
 */
function parseSolarlogJournal(raw) {
    /** @type {string[]} */
    const skipped = [];
    /** @type {DayRecord[]} */
    const days = [];
    let list;
    try {
        list = raw ? JSON.parse(raw) : [];
    } catch {
        return { days, skipped: ["journal is not valid JSON"] };
    }
    if (!Array.isArray(list)) {
        return { days, skipped: ["journal is not a list"] };
    }
    for (const entry of list) {
        const date = entry && entry.date;
        if (!isDate(date)) {
            skipped.push(
                `entry without valid date: ${JSON.stringify(entry && entry.date)}`,
            );
            continue;
        }
        /** @type {MeterDay[]} */
        const meters = [];
        for (const r of Array.isArray(entry.meterRows) ? entry.meterRows : []) {
            const verbrauch = num(r.verbrauch_kwh);
            const solar = num(r.solarbezug_kwh);
            const netz = num(r.netzbezug_kwh);
            if (
                typeof r.meter_name !== "string" ||
                verbrauch === null ||
                solar === null ||
                netz === null
            ) {
                skipped.push(
                    `${date}: meter row incomplete (${r && r.meter_name})`,
                );
                continue;
            }
            meters.push({
                meter: r.meter_name,
                zStartKwh: num(r.zaehlerstand_start_kwh),
                zEndeKwh: num(r.zaehlerstand_ende_kwh),
                verbrauchKwh: verbrauch,
                solarKwh: solar,
                netzKwh: netz,
                tarifNetz: num(r.tarif_netz),
                tarifSolar: num(r.tarif_solar),
            });
        }
        const b = entry.buildingRow;
        const building =
            b &&
            num(b.produktion_kwh) !== null &&
            num(b.verbrauch_kwh) !== null &&
            num(b.einspeisung_kwh) !== null
                ? {
                      produktionKwh: /** @type {number} */ (
                          num(b.produktion_kwh)
                      ),
                      verbrauchKwh: /** @type {number} */ (
                          num(b.verbrauch_kwh)
                      ),
                      einspeisungKwh: /** @type {number} */ (
                          num(b.einspeisung_kwh)
                      ),
                      // the column is called eigenverbrauchsquote but holds the share of the consumption covered by PV
                      autarkiegrad: num(b.eigenverbrauchsquote),
                  }
                : null;
        if (meters.length === 0 && !building) {
            skipped.push(`${date}: no usable rows`);
            continue;
        }
        const method = METHODS.includes(b && b.berechnungsmethode)
            ? b.berechnungsmethode
            : METHODS.includes(
                    entry.meterRows &&
                        entry.meterRows[0] &&
                        entry.meterRows[0].berechnungsmethode,
                )
              ? entry.meterRows[0].berechnungsmethode
              : "tagesnetto";
        const quality = ["veraltet", "vorlaeufig"].includes(
            entry.datenqualitaet,
        )
            ? entry.datenqualitaet
            : "ok";
        days.push({ date, method, quality, meters, building });
    }
    return { days, skipped };
}

/** @param {string|null|undefined} raw @returns {DayRecord[]} */
function parseJournal(raw) {
    try {
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list)
            ? list.filter((d) => d && isDate(d.date))
            : [];
    } catch {
        return [];
    }
}

/** @param {DayRecord[]} days */
function serializeJournal(days) {
    return JSON.stringify(days);
}

/**
 * Adds days to the journal; a day that is already there is replaced by the incoming one (the source is
 * authoritative), the result is sorted and limited to the newest MAX_DAYS days.
 *
 * @param {DayRecord[]} journal
 * @param {DayRecord[]} incoming
 * @returns {DayRecord[]}
 */
function mergeDays(journal, incoming) {
    const byDate = new Map(journal.map((d) => [d.date, d]));
    for (const d of incoming) {
        byDate.set(d.date, d);
    }
    return [...byDate.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-MAX_DAYS);
}

/**
 * Self-consumption split of the day (proportional ZEV method): every unit receives the same share of own
 * production, capped at its consumption.
 *
 * @param {object} p
 * @param {string} p.date
 * @param {{ meter: string, kwh: number, zStartKwh?: number|null, zEndeKwh?: number|null }[]} p.meters  consumption per unit
 * @param {number} p.productionKwh   own production of the day
 * @param {number|null} p.feedinKwh  energy fed into the grid; if unknown it is derived as production minus consumption
 * @param {"ok"|"veraltet"} [p.quality]
 * @returns {DayRecord}
 */
function computeDay(p) {
    const total = p.meters.reduce((s, m) => s + m.kwh, 0);
    const production = Math.max(0, p.productionKwh);
    const feedin =
        p.feedinKwh === null
            ? Math.max(0, production - total)
            : Math.min(Math.max(0, p.feedinKwh), production);
    const selfConsumed =
        p.feedinKwh === null
            ? Math.min(production, total)
            : production - feedin;
    const ratio = total > 0 ? Math.min(1, selfConsumed / total) : 0;
    return {
        date: p.date,
        method: "tagesnetto",
        quality: p.quality || "ok",
        meters: p.meters.map((m) => ({
            meter: m.meter,
            zStartKwh: m.zStartKwh ?? null,
            zEndeKwh: m.zEndeKwh ?? null,
            verbrauchKwh: m.kwh,
            solarKwh: m.kwh * ratio,
            netzKwh: m.kwh - m.kwh * ratio,
            tarifNetz: null,
            tarifSolar: null,
        })),
        building: {
            produktionKwh: production,
            verbrauchKwh: total,
            einspeisungKwh: feedin,
            autarkiegrad: total > 0 ? Math.min(1, selfConsumed / total) : null,
        },
    };
}

/**
 * Which days (and within them which rows) the server still lacks, given what it reported in its status.
 * Rows the server already has are not sent again, so manual corrections made on the server side are never
 * overwritten by older local values; only the most recent days are always resent so a late correction of
 * the source (e.g. a value that had been marked "veraltet") reaches the server.
 *
 * @param {DayRecord[]} journal
 * @param {{ present_meter_dates?: Record<string,string[]>, present_building_dates?: string[] }} status
 * @param {string} today  "YYYY-MM-DD"
 * @param {number} [resendDays]
 * @returns {DayRecord[]}
 */
function missingOnServer(journal, status, today, resendDays = 2) {
    const recentFrom = addDays(today, -resendDays);
    const meterDates = status.present_meter_dates || {};
    const buildingDates = new Set(status.present_building_dates || []);
    const have = new Map(
        Object.entries(meterDates).map(([m, dates]) => [m, new Set(dates)]),
    );
    /** @type {DayRecord[]} */
    const out = [];
    for (const day of journal) {
        const recent = day.date >= recentFrom;
        const meters = day.meters.filter(
            (m) => recent || !(have.get(m.meter) || new Set()).has(day.date),
        );
        const building =
            day.building && (recent || !buildingDates.has(day.date))
                ? day.building
                : null;
        if (meters.length > 0 || building) {
            out.push({ ...day, meters, building });
        }
    }
    return out;
}

module.exports = {
    MAX_DAYS,
    parseSolarlogJournal,
    parseJournal,
    serializeJournal,
    mergeDays,
    computeDay,
    missingOnServer,
};
