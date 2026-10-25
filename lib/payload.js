"use strict";

/**
 * @typedef {import("./days").DayRecord} DayRecord
 * @typedef {{ year: number, month: number, netz_chf_kwh: number, solar_chf_kwh: number }} ServerTariff
 */

const SCHEMA = 1;
/** The server accepts 1000 rows per delivery; stay well below it. */
const MAX_ROWS_PER_REQUEST = 400;

/** @param {number} v */
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Tariff of a month: the one the server has (it is the single place where tariffs are maintained), else the
 * one the source brought along, else none.
 *
 * @param {string} date
 * @param {ServerTariff[]} serverTariffs
 * @param {number|null} ownNetz
 * @param {number|null} ownSolar
 * @returns {{ netz: number, solar: number }|null}
 */
function tariffFor(date, serverTariffs, ownNetz, ownSolar) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const t = serverTariffs.find((x) => x.year === year && x.month === month);
    if (t) {
        return { netz: t.netz_chf_kwh, solar: t.solar_chf_kwh };
    }
    return ownNetz !== null && ownSolar !== null
        ? { netz: ownNetz, solar: ownSolar }
        : null;
}

/**
 * @param {DayRecord} day
 * @param {ServerTariff[]} serverTariffs
 */
function rowsOfDay(day, serverTariffs) {
    const meter = day.meters.map((m) => {
        const solar = round3(m.solarKwh);
        const netz = round3(m.netzKwh);
        const t = tariffFor(day.date, serverTariffs, m.tarifNetz, m.tarifSolar);
        /** @type {Record<string, any>} */
        const row = {
            date: day.date,
            meter: m.meter,
            verbrauch_kwh: round3(m.verbrauchKwh),
            solarbezug_kwh: solar,
            netzbezug_kwh: netz,
            methode: day.method,
            quality: day.quality,
        };
        if (m.zStartKwh !== null) {
            row.zaehlerstand_start_kwh = round3(m.zStartKwh);
        }
        if (m.zEndeKwh !== null) {
            row.zaehlerstand_ende_kwh = round3(m.zEndeKwh);
        }
        if (t) {
            row.tarif_netz = t.netz;
            row.tarif_solar = t.solar;
            // from the rounded kWh figures that are sent, so the stored total can be recomputed from the stored row
            row.total_chf =
                Math.round((solar * t.solar + netz * t.netz) * 100) / 100;
        }
        return row;
    });
    /** @type {Record<string, any>|null} */
    let building = null;
    if (day.building) {
        building = {
            date: day.date,
            produktion_kwh: round3(day.building.produktionKwh),
            verbrauch_kwh: round3(day.building.verbrauchKwh),
            einspeisung_kwh: round3(day.building.einspeisungKwh),
            methode: day.method,
            quality: day.quality,
        };
        if (day.building.autarkiegrad !== null) {
            building.autarkiegrad =
                Math.round(
                    Math.min(1, Math.max(0, day.building.autarkiegrad)) * 10000,
                ) / 10000;
        }
    }
    return { meter, building };
}

/**
 * Splits the days into requests of at most MAX_ROWS_PER_REQUEST rows. A day is never split, so a request
 * (which the server stores all-or-nothing) always contains complete days.
 *
 * @param {DayRecord[]} days
 * @param {ServerTariff[]} serverTariffs
 * @param {{ source: string, version: string, maxRows?: number }} opts
 * @returns {{ payload: Record<string, any>, dates: string[] }[]}
 */
function buildPayloads(days, serverTariffs, opts) {
    const maxRows = opts.maxRows || MAX_ROWS_PER_REQUEST;
    /** @type {{ payload: Record<string, any>, dates: string[] }[]} */
    const out = [];
    /** @type {any} */
    let cur = null;
    let rows = 0;
    for (const day of days) {
        const { meter, building } = rowsOfDay(day, serverTariffs);
        const n = meter.length + (building ? 1 : 0);
        if (!cur || rows + n > maxRows) {
            cur = {
                payload: {
                    schema: SCHEMA,
                    source: opts.source,
                    adapter_version: opts.version,
                    meter_daily: [],
                    building_daily: [],
                },
                dates: [],
            };
            out.push(cur);
            rows = 0;
        }
        cur.payload.meter_daily.push(...meter);
        if (building) {
            cur.payload.building_daily.push(building);
        }
        cur.dates.push(day.date);
        rows += n;
    }
    return out;
}

module.exports = { SCHEMA, MAX_ROWS_PER_REQUEST, tariffFor, buildPayloads };
