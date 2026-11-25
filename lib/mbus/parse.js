"use strict";

/**
 * Application layer (EN 13757-3): variable data structure of an RSP_UD telegram, reduced to what the
 * readings need: the meter identity, the main value (volume or energy), the stored values at the billing
 * date, status and the clock of the meter.
 */

const MEDIA = {
    0x00: "Other",
    0x01: "Oil",
    0x02: "Electricity",
    0x03: "Gas",
    0x04: "Heat (outlet)",
    0x05: "Steam",
    0x06: "Hot water",
    0x07: "Water",
    0x08: "Heat cost allocator",
    0x0a: "Cooling (outlet)",
    0x0b: "Cooling (inlet)",
    0x0c: "Heat (inlet)",
    0x0d: "Heat/cooling",
    0x15: "Hot water (>=90C)",
    0x16: "Cold water",
    0x1a: "Smoke detector",
};

const HEAT_MEDIA = new Set([0x04, 0x0a, 0x0b, 0x0c, 0x0d]);

/** @param {number} medium */
function mediumName(medium) {
    return MEDIA[medium] || `Medium 0x${medium.toString(16)}`;
}

/**
 * Manufacturer code: 3 letters in 15 bits. @param {number} v
 *
 * @param v
 */
function manufacturer(v) {
    return String.fromCharCode(
        ((v >> 10) & 31) + 64,
        ((v >> 5) & 31) + 64,
        (v & 31) + 64,
    );
}

/** @param {Buffer} b @returns {string} BCD digits, most significant first */
function bcdId(b) {
    let s = "";
    for (let i = b.length - 1; i >= 0; i--) {
        s += b[i].toString(16).padStart(2, "0");
    }
    return s;
}

/**
 * Value of a BCD number (little endian, a high nibble F in the top byte = negative).
 *
 * @param {Buffer} b
 * @returns {number|null} null for invalid digits
 */
function bcdValue(b) {
    let neg = false;
    let v = 0;
    for (let i = b.length - 1; i >= 0; i--) {
        let hi = b[i] >> 4;
        const lo = b[i] & 15;
        if (i === b.length - 1 && hi === 0xf) {
            neg = true;
            hi = 0;
        }
        if (hi > 9 || lo > 9) {
            return null;
        }
        v = v * 100 + hi * 10 + lo;
    }
    return neg ? -v : v;
}

/** @param {Buffer} b signed little endian integer */
function intValue(b) {
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) {
        v = (v << 8n) | BigInt(b[i]);
    }
    const bits = BigInt(b.length * 8);
    if (v >= 1n << (bits - 1n)) {
        v -= 1n << bits;
    }
    return Number(v);
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * Type G (date): 2 bytes. @param {Buffer} b
 *
 * @param b
 */
function dateG(b) {
    const day = b[0] & 31;
    const month = b[1] & 15;
    const year = ((b[0] & 0xe0) >> 5) | ((b[1] & 0xf0) >> 1);
    if (day === 0 || month === 0 || month > 12) {
        return null;
    }
    return `${year < 81 ? 2000 + year : 1900 + year}-${pad(month)}-${pad(day)}`;
}

/**
 * Type F (date and time): 4 bytes. @param {Buffer} b
 *
 * @param b
 */
function dateF(b) {
    if (b[0] & 0x80) {
        return null; // invalid
    }
    const min = b[0] & 63;
    const hour = b[1] & 31;
    const day = b[2] & 31;
    const month = b[3] & 15;
    const year = ((b[2] & 0xe0) >> 5) | ((b[3] & 0xf0) >> 1);
    if (day === 0 || month === 0 || month > 12) {
        return null;
    }
    return `${year < 81 ? 2000 + year : 1900 + year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}`;
}

/**
 * Inverse of dateF for setting the clock of a meter (local time, summer time bit set when in effect).
 *
 * @param {Date} d
 * @returns {Buffer}
 */
function encodeDateF(d) {
    const year = d.getFullYear() % 100;
    const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
    const summer = jan !== jul && d.getTimezoneOffset() === Math.min(jan, jul);
    return Buffer.from([
        d.getMinutes() & 63,
        (d.getHours() & 31) | (summer ? 0x80 : 0),
        (d.getDate() & 31) | ((year & 7) << 5),
        ((d.getMonth() + 1) & 15) | ((year & 0x78) << 1),
    ]);
}

/**
 * Quantity of a primary VIF: value = raw * 10^exp. @param {number} vif
 *
 * @param vif
 */
function primaryVif(vif) {
    const v = vif & 0x7f;
    const n = v & 7;
    if (v < 0x08) {
        return { q: "Energie", unit: "Wh", exp: n - 3 };
    }
    if (v < 0x10) {
        return { q: "Energie", unit: "J", exp: n };
    }
    if (v < 0x18) {
        return { q: "Volumen", unit: "m3", exp: n - 6 };
    }
    if (v < 0x20) {
        return { q: "Masse", unit: "kg", exp: n - 3 };
    }
    if (v < 0x24) {
        return {
            q: "Einschaltdauer",
            unit: ["s", "min", "h", "d"][v & 3],
            exp: 0,
        };
    }
    if (v < 0x28) {
        return {
            q: "Betriebsdauer",
            unit: ["s", "min", "h", "d"][v & 3],
            exp: 0,
        };
    }
    if (v < 0x30) {
        return { q: "Leistung", unit: "W", exp: n - 3 };
    }
    if (v < 0x38) {
        return { q: "Leistung", unit: "J/h", exp: n };
    }
    if (v < 0x40) {
        return { q: "Volumenfluss", unit: "m3/h", exp: n - 6 };
    }
    if (v < 0x48) {
        return { q: "Volumenfluss", unit: "m3/min", exp: n - 7 };
    }
    if (v < 0x50) {
        return { q: "Volumenfluss", unit: "m3/s", exp: n - 9 };
    }
    if (v < 0x58) {
        return { q: "Massenfluss", unit: "kg/h", exp: n - 3 };
    }
    if (v < 0x5c) {
        return { q: "Vorlauftemperatur", unit: "C", exp: (v & 3) - 3 };
    }
    if (v < 0x60) {
        return { q: "Ruecklauftemperatur", unit: "C", exp: (v & 3) - 3 };
    }
    if (v < 0x64) {
        return { q: "Temperaturdifferenz", unit: "K", exp: (v & 3) - 3 };
    }
    if (v < 0x68) {
        return { q: "Aussentemperatur", unit: "C", exp: (v & 3) - 3 };
    }
    if (v < 0x6c) {
        return { q: "Druck", unit: "bar", exp: (v & 3) - 3 };
    }
    if (v === 0x6c) {
        return { q: "Datum", unit: "", exp: 0, date: "G" };
    }
    if (v === 0x6d) {
        return { q: "Datum/Zeit", unit: "", exp: 0, date: "F" };
    }
    if (v === 0x78) {
        return { q: "Fabrikationsnummer", unit: "", exp: 0 };
    }
    if (v === 0x79) {
        return { q: "Kennung", unit: "", exp: 0 };
    }
    if (v === 0x7a) {
        return { q: "Busadresse", unit: "", exp: 0 };
    }
    return { q: `VIF 0x${v.toString(16)}`, unit: "", exp: 0 };
}

const DATA_LEN = [0, 1, 2, 3, 4, 4, 6, 8, 0, 1, 2, 3, 4, 6, 0, 0];

/**
 * Parses the data records of an RSP_UD telegram.
 *
 * @param {Buffer} data record area (after the header)
 * @returns {{ records: object[], more: boolean, errors: string[] }}
 */
function parseRecords(data) {
    const records = [];
    const errors = [];
    let more = false;
    let i = 0;
    /**
     * @param {number} n @param {string} what
     * @param what
     */
    const need = (n, what) => {
        if (i + n > data.length) {
            errors.push(`${what}: Telegramm zu kurz`);
            return false;
        }
        return true;
    };
    /** skips VIFE bytes while the extension bit is set */
    const skipExt = () => {
        for (;;) {
            if (!need(1, "VIFE")) {
                return false;
            }
            if (!(data[i++] & 0x80)) {
                return true;
            }
        }
    };
    while (i < data.length) {
        const dif = data[i];
        if (dif === 0x2f) {
            i++; // idle filler
            continue;
        }
        if (dif === 0x0f || dif === 0x1f) {
            more = dif === 0x1f;
            records.push({
                special: more ? "more" : "mfr",
                raw: data.subarray(i + 1).toString("hex"),
            });
            break;
        }
        if ((dif & 0x0f) === 0x0f || dif === 0x7f) {
            i++;
            continue;
        }
        i++;
        let storage = (dif >> 6) & 1;
        let tariff = 0;
        let subunit = 0;
        let ext = dif & 0x80;
        let n = 0;
        while (ext) {
            if (!need(1, "DIFE")) {
                return { records, more, errors };
            }
            const e = data[i++];
            storage |= (e & 15) << (1 + 4 * n);
            tariff |= ((e >> 4) & 3) << (2 * n);
            subunit |= ((e >> 6) & 1) << n;
            ext = e & 0x80;
            n++;
            if (n > 10) {
                errors.push("DIFE-Kette zu lang");
                return { records, more, errors };
            }
        }
        if (!need(1, "VIF")) {
            break;
        }
        const vif = data[i++];
        let info;
        let isText = false;
        if (vif === 0x7c || vif === 0xfc) {
            if (!need(1, "VIF-Text")) {
                break;
            }
            const len = data[i++];
            if (!need(len, "VIF-Text")) {
                break;
            }
            const text = Buffer.from(data.subarray(i, i + len))
                .reverse()
                .toString("latin1");
            i += len;
            info = { q: text, unit: "", exp: 0 };
            isText = true;
            if (vif & 0x80 && !skipExt()) {
                return { records, more, errors };
            }
        } else if (vif === 0xfd || vif === 0xfb) {
            if (!need(1, "VIF-Erweiterung")) {
                break;
            }
            const x = data[i++];
            info =
                vif === 0xfd && (x & 0x7f) === 0x17
                    ? { q: "Fehlerflags", unit: "", exp: 0 }
                    : {
                          q: `VIF 0x${vif.toString(16)} 0x${(x & 0x7f).toString(16)}`,
                          unit: "",
                          exp: 0,
                      };
            if (x & 0x80 && !skipExt()) {
                return { records, more, errors };
            }
        } else {
            info = primaryVif(vif);
            if (vif & 0x80 && !skipExt()) {
                return { records, more, errors };
            }
        }
        const field = dif & 0x0f;
        let len = DATA_LEN[field];
        if (field === 0x0d) {
            if (!need(1, "LVAR")) {
                break;
            }
            len = data[i++];
        }
        if (!need(len, "Daten")) {
            break;
        }
        const raw = data.subarray(i, i + len);
        i += len;
        /** @type {any} */
        const rec = {
            storage,
            tariff,
            subunit,
            func: (dif >> 4) & 3, // 0 instant, 1 max, 2 min, 3 error
            q: info.q,
            unit: info.unit,
            raw: raw.toString("hex"),
            value: null,
            text: null,
        };
        if (info.date === "G" && len === 2) {
            rec.text = dateG(raw);
        } else if (info.date === "F" && len === 4) {
            rec.text = dateF(raw);
        } else if (
            info.q === "Fabrikationsnummer" &&
            ((field >= 9 && field <= 0x0c) || field === 0x0e)
        ) {
            rec.text = bcdId(raw);
        } else if (field === 0x0d || isText) {
            rec.text = raw.toString("latin1");
        } else if (field >= 1 && field <= 7) {
            rec.value =
                (field === 5 ? raw.readFloatLE(0) : intValue(raw)) *
                10 ** info.exp;
        } else if ((field >= 9 && field <= 0x0c) || field === 0x0e) {
            const bv = bcdValue(raw);
            rec.value = bv === null ? null : bv * 10 ** info.exp;
        }
        if (rec.value !== null) {
            rec.value = Math.round(rec.value * 1e9) / 1e9;
        }
        records.push(rec);
    }
    return { records, more, errors };
}

/**
 * Parses the data area of an RSP_UD (CI 0x72) into header and records.
 *
 * @param {Buffer} data data area of the long frame (after C, A, CI)
 * @param {number} ci
 * @returns {{ ok: boolean, error?: string, header?: object, records?: object[], more?: boolean, errors?: string[] }}
 */
function parseTelegram(data, ci) {
    if (ci !== 0x72) {
        return {
            ok: false,
            error: `CI 0x${ci.toString(16)} nicht unterstützt`,
        };
    }
    if (data.length < 12) {
        return { ok: false, error: "Telegramm zu kurz für den Kopf" };
    }
    const header = {
        id: bcdId(data.subarray(0, 4)),
        manufacturer: manufacturer(data.readUInt16LE(4)),
        version: data[6],
        medium: data[7],
        access: data[8],
        status: data[9],
    };
    const r = parseRecords(data.subarray(12));
    return {
        ok: true,
        header,
        records: r.records,
        more: r.more,
        errors: r.errors,
    };
}

/**
 * @param {number} v @param {number} d
 * @param d
 */
function round(v, d) {
    const f = 10 ** d;
    return Math.round(v * f) / f;
}

/**
 * Condenses the records of all telegrams of a meter into the reading that is delivered.
 *
 * @param {{ id: string, medium: number, status: number }} header
 * @param {object[]} records
 */
function summarize(header, records) {
    const pick = (q, storage) =>
        records.find(
            (r) =>
                r.q === q &&
                r.storage === storage &&
                r.tariff === 0 &&
                r.subunit === 0 &&
                r.func === 0 &&
                r.value !== null,
        );
    const norm = (r) => {
        if (!r) {
            return null;
        }
        if (r.unit === "Wh") {
            return { v: round(r.value / 1000, 4), u: "kWh" };
        }
        if (r.unit === "J") {
            return { v: round(r.value / 3.6e6, 4), u: "kWh" };
        }
        return { v: round(r.value, 6), u: r.unit };
    };
    const heat = HEAT_MEDIA.has(header.medium);
    const main = heat
        ? norm(pick("Energie", 0)) || norm(pick("Volumen", 0))
        : norm(pick("Volumen", 0)) || norm(pick("Energie", 0));
    const second =
        heat && main && main.u === "kWh" ? norm(pick("Volumen", 0)) : null;
    const time = records.find(
        (r) => r.q === "Datum/Zeit" && r.storage === 0 && r.text,
    );
    const flags = records.find(
        (r) => r.q === "Fehlerflags" && r.value !== null,
    );
    // stored values at the billing date: storage 1 and 2 with the date of the same storage
    const stored = [];
    for (const s of [1, 2]) {
        const a = heat ? norm(pick("Energie", s)) : norm(pick("Volumen", s));
        const b = heat ? norm(pick("Volumen", s)) : null;
        const d = records.find(
            (r) => r.q === "Datum" && r.storage === s && r.text,
        );
        if (a) {
            stored.push({
                storage: s,
                date: d ? d.text : null,
                value: a.v,
                unit: a.u,
                value2: b ? b.v : null,
            });
        }
    }
    const on = records.find(
        (r) =>
            (r.q === "Betriebsdauer" || r.q === "Einschaltdauer") &&
            r.storage === 0 &&
            r.unit === "d",
    );
    return {
        value: main ? main.v : null,
        unit: main ? main.u : null,
        value2: second ? second.v : null,
        unit2: second ? second.u : null,
        flags: flags ? Math.trunc(flags.value) : null,
        meterTime: time ? time.text : null,
        extra: {
            stored,
            onTimeDays: on ? on.value : undefined,
            status: header.status,
        },
    };
}

module.exports = {
    MEDIA,
    HEAT_MEDIA,
    mediumName,
    manufacturer,
    bcdId,
    dateF,
    dateG,
    encodeDateF,
    parseRecords,
    parseTelegram,
    summarize,
};
