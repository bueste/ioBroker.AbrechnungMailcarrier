"use strict";

/**
 * Two-way comparison of the Moxa, apartment and router tables of the instance configuration with the web
 * application. Both sides can be edited; a three-way comparison with the state both sides agreed on last time
 * (the snapshot) tells who changed what:
 *
 *  - a row changed in the instance but not in the snapshot: sent to the web application
 *  - a row unchanged in the instance but different on the server: the server version is taken over
 *  - a row new in the instance (no id): created on the server
 *  - a row removed in the instance: deleted on the server
 *  - a row the server has and the snapshot does not: taken over
 *
 * Pure functions, no I/O.
 */

/** Days of the week as the admin offers them (0 = Sunday, like the web application). */
const DAY_KEYS = ["1", "2", "3", "4", "5", "6", "0"];

/**
 * @param {any} v @param {boolean} def
 * @param def
 */
function bool(v, def) {
    return v === undefined || v === null || v === ""
        ? def
        : v === true || v === "true" || v === 1 || v === "1";
}

/**
 * @param {any} v @param {number} def
 * @param def
 */
function int(v, def) {
    const n = Number(v);
    return Number.isFinite(n) && v !== "" && v !== null && v !== undefined
        ? Math.trunc(n)
        : def;
}

/** @param {any} v */
function str(v) {
    return v === undefined || v === null ? "" : String(v).trim();
}

/** @param {any} v days as array or "1,3,5" @returns {string} sorted, comma separated */
function daysString(v) {
    const list = Array.isArray(v)
        ? v
        : String(v === undefined || v === null ? "" : v).split(",");
    const set = new Set(
        list.map((d) => String(d).trim()).filter((d) => DAY_KEYS.includes(d)),
    );
    return DAY_KEYS.filter((d) => set.has(d)).join(",");
}

// ------------------------------------------------------------------ canonical form (what the server stores)

/** @param {any} r row of the instance table or of the server @returns {object} */
function canonMoxa(r) {
    return {
        name: str(r.name),
        host: str(r.host).toLowerCase(),
        port: int(r.port, 4001),
        enabled: bool(r.enabled, true),
        fw_auto: bool(r.fwAuto !== undefined ? r.fwAuto : r.fw_auto, true),
    };
}

/** @param {any} r @returns {object} */
function canonUnit(r) {
    return {
        name: str(r.name),
        label: str(r.label),
        general: bool(
            r.general !== undefined
                ? r.general
                : r.billable === undefined
                  ? false
                  : !bool(r.billable, true),
            false,
        ),
    };
}

/** @param {any} r @returns {object} */
function canonRouter(r) {
    const pick = (a, b) => (r[a] !== undefined ? r[a] : r[b]);
    return {
        name: str(r.name),
        host: str(r.host).toLowerCase(),
        port: int(r.port, 22),
        ssh_user: str(pick("sshUser", "ssh_user")) || "admin",
        channel: str(r.channel) || "stable",
        enabled: bool(r.enabled, true),
        auto_update: bool(pick("autoUpdate", "auto_update"), false),
        routerboard_fw: bool(pick("rbFw", "routerboard_fw"), false),
        upd_days: daysString(r.days !== undefined ? r.days : r.upd_days),
        upd_time: str(pick("time", "upd_time")) || "03:30",
        upd_window_min: int(pick("window", "upd_window_min"), 90),
    };
}

/**
 * The editable part of a meter: what the instance and the web application may both change. @param {any} r
 *
 * @param r
 */
function canonMeter(r) {
    return {
        kind: str(r.kind),
        unit: str(r.unit),
        label: str(r.label),
        status: str(r.status) || "neu",
    };
}

/** @param {any} r row of the instance table @returns {string} */
function meterKey(r) {
    return `${Number(r.gw !== undefined ? r.gw : r.gateway_id) || 0}:${str(r.mid !== undefined ? r.mid : r.id)}:${Number(r.medium) || 0}`;
}

/**
 * @param {number} site @param {any} m meter of the server config
 * @param m
 */
function meterRow(site, m) {
    const c = canonMeter(m);
    return {
        site: String(site),
        gw: Number(m.gateway_id) || 0,
        mid: str(m.id),
        medium: Number(m.medium) || 0,
        adr:
            m.primary === null || m.primary === undefined
                ? ""
                : String(m.primary),
        type: str(m.medium_name),
        kind: c.kind,
        unit: c.unit,
        label: c.label,
        status: c.status,
    };
}

/**
 * @param {any} a @param {any} b
 * @param b
 */
function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------------ rows of the instance table

/**
 * @param {number} site @param {any} g gateway of the server config
 * @param g
 * @param {(id: number) => string} [comPath] the COM port the adapter offers for the Moxa
 */
function moxaRow(site, g, comPath) {
    const c = canonMoxa(g);
    return {
        site: String(site),
        id: Number(g.id) || 0,
        name: c.name,
        host: c.host,
        port: c.port,
        comPort:
            comPath && c.host && !g.device
                ? comPath(Number(g.id))
                : g.device || "",
        enabled: c.enabled,
        fwAuto: c.fw_auto,
    };
}

/**
 * @param {number} site @param {any} u unit of the server config
 * @param u
 */
function unitRow(site, u) {
    const c = canonUnit(u);
    return {
        site: String(site),
        name: c.name,
        label: c.label,
        general: c.general,
    };
}

/**
 * @param {number} site @param {any} r router of the server config
 * @param r
 */
function routerRow(site, r) {
    const c = canonRouter(r);
    return {
        site: String(site),
        id: Number(r.id) || 0,
        name: c.name,
        host: c.host,
        port: c.port,
        sshUser: c.ssh_user,
        channel: c.channel,
        enabled: c.enabled,
        autoUpdate: c.auto_update,
        rbFw: c.routerboard_fw,
        days: c.upd_days === "" ? [] : c.upd_days.split(","),
        time: c.upd_time,
        window: c.upd_window_min,
    };
}

/**
 * The rows the server currently has, as table rows. @param {number} site @param {any} cfg
 *
 * @param site
 * @param cfg
 * @param {(id: number) => string} [comPath]
 * @returns {{ moxas: any[], units: any[], routers: any[], meters: any[] }}
 */
function rowsFromServer(site, cfg, comPath) {
    return {
        moxas: (cfg.gateways || []).map((g) => moxaRow(site, g, comPath)),
        units: (cfg.units || [])
            .filter((u) => u.active !== false)
            .map((u) => unitRow(site, u)),
        routers: (cfg.routers || []).map((r) => routerRow(site, r)),
        meters: (cfg.meter_rows || []).map((m) => meterRow(site, m)),
    };
}

/**
 * What the server has as canonical maps, the snapshot form. @param {any} cfg
 *
 * @param cfg
 */
function snapshotFromServer(cfg) {
    /** @type {{ moxas: Record<string, object>, units: Record<string, object>, routers: Record<string, object>, meters: Record<string, object> }} */
    const s = { moxas: {}, units: {}, routers: {}, meters: {} };
    for (const g of cfg.gateways || []) {
        s.moxas[String(g.id)] = canonMoxa(g);
    }
    for (const u of cfg.units || []) {
        if (u.active !== false) {
            s.units[str(u.name)] = canonUnit(u);
        }
    }
    for (const r of cfg.routers || []) {
        s.routers[String(r.id)] = canonRouter(r);
    }
    for (const m of cfg.meter_rows || []) {
        s.meters[meterKey(m)] = canonMeter(m);
    }
    return s;
}

// ------------------------------------------------------------------ plan

/**
 * @typedef {{ moxas: any[], units: any[], routers: any[], meters?: any[] }} Tables
 * @typedef {{ kind: string, ref: string, row: any }} Pending a pushed item and the local row behind it
 */

/**
 * Compares the local rows of one site with the server and the snapshot.
 *
 * @param {number} site
 * @param {Tables} local all rows of the instance table (all sites)
 * @param {{ moxas: Record<string, any>, units: Record<string, any>, routers: Record<string, any>, meters?: Record<string, any> }|null} snap
 * @param {any} cfg server config
 * @returns {{ push: { gateways: object[], units: object[], routers: object[] }|null, pending: Pending[] }}
 */
function plan(site, local, snap, cfg) {
    const mine = (/** @type {any[]} */ rows) =>
        (rows || []).filter((r) => String(r.site) === String(site));
    const S = snapshotFromServer(cfg);
    const P = {
        moxas: {},
        units: {},
        routers: {},
        meters: {},
        ...(snap || {}),
    };
    const push = {
        gateways: /** @type {object[]} */ ([]),
        units: /** @type {object[]} */ ([]),
        routers: /** @type {object[]} */ ([]),
        meters: /** @type {object[]} */ ([]),
    };
    /** @type {Pending[]} */
    const pending = [];
    let n = 0;

    /**
     * @param {string} kind "moxas" | "routers"
     * @param {(r: any) => any} canon
     * @param {(c: any, s: any) => boolean} [isDup] a new row the server already has under the same data
     */
    const byId = (kind, canon, isDup) => {
        const out = kind === "moxas" ? push.gateways : push.routers;
        const label = kind === "moxas" ? "gateway" : "router";
        const seen = new Set();
        for (const r of mine(local[kind])) {
            const c = canon(r);
            let id = Number(r.id) || 0;
            if (id && seen.has(id)) {
                id = 0; // copied row: a new one
            }
            if (id && S[kind][String(id)]) {
                seen.add(id);
                const was = P[kind][String(id)];
                if (was && !same(c, was)) {
                    const ref = `${label[0]}${++n}`;
                    out.push({ ref, id, ...c });
                    pending.push({ kind, ref, row: r });
                }
            } else if (id && !S[kind][String(id)]) {
                // removed on the server: gone, unless it was edited here in the meantime
                const was = P[kind][String(id)];
                if (was && !same(c, was)) {
                    const ref = `${label[0]}${++n}`;
                    out.push({ ref, ...c });
                    pending.push({ kind, ref, row: { ...r, id: 0 } });
                }
            } else {
                if (isDup && Object.values(S[kind]).some((s) => isDup(c, s))) {
                    continue;
                }
                const ref = `${label[0]}${++n}`;
                out.push({ ref, ...c });
                pending.push({ kind, ref, row: r });
            }
        }
        // an empty table is "not configured here yet", not "delete everything"
        for (const id of mine(local[kind]).length === 0
            ? []
            : Object.keys(P[kind])) {
            if (!seen.has(Number(id)) && S[kind][id]) {
                out.push({
                    ref: `${label[0]}d${id}`,
                    id: Number(id),
                    delete: true,
                });
                pending.push({ kind, ref: `${label[0]}d${id}`, row: null });
            }
        }
    };

    byId("moxas", canonMoxa, (c, s) => c.name === s.name && c.host === s.host);
    byId(
        "routers",
        canonRouter,
        (c, s) => c.name === s.name && c.host === s.host,
    );

    const names = new Set();
    for (const r of mine(local.units)) {
        const c = canonUnit(r);
        if (c.name === "" || names.has(c.name)) {
            continue;
        }
        names.add(c.name);
        const there = S.units[c.name];
        const was = P.units[c.name];
        if (there) {
            if (was && !same(c, was)) {
                push.units.push({ ref: c.name, ...c });
                pending.push({ kind: "units", ref: c.name, row: r });
            }
        } else if (was) {
            if (!same(c, was)) {
                push.units.push({ ref: c.name, ...c });
                pending.push({ kind: "units", ref: c.name, row: r });
            }
        } else {
            push.units.push({ ref: c.name, ...c });
            pending.push({ kind: "units", ref: c.name, row: r });
        }
    }
    for (const name of mine(local.units).length === 0
        ? []
        : Object.keys(P.units)) {
        if (!names.has(name) && S.units[name]) {
            push.units.push({ ref: name, name, delete: true });
            pending.push({ kind: "units", ref: name, row: null });
        }
    }

    // meters are found by the scan, never created here: only changes of kind, unit, label and status go back
    for (const r of mine(local.meters || [])) {
        const key = meterKey(r);
        const was = /** @type {any} */ (P).meters[key];
        const there = /** @type {any} */ (S).meters[key];
        const c = canonMeter(r);
        if (there && was && !same(c, was)) {
            push.meters.push({
                ref: key,
                gateway_id: Number(r.gw) || 0,
                meter_id: str(r.mid),
                medium: Number(r.medium) || 0,
                ...c,
            });
            pending.push({ kind: "meters", ref: key, row: r });
        }
    }

    const any =
        push.gateways.length +
            push.units.length +
            push.routers.length +
            push.meters.length >
        0;
    return { push: any ? push : null, pending };
}

/**
 * The rows of one site after the push: what the server has now, except the local rows the server refused
 * (they stay, so the user sees and can correct them).
 *
 * @param {number} site
 * @param {any} cfgAfter server config after the push
 * @param {Pending[]} pending
 * @param {Array<{ kind: string, ref: string, ok: boolean, id?: number|null, error?: string|null }>} results
 * @param {(id: number) => string} [comPath]
 * @returns {Tables}
 */
function resolve(site, cfgAfter, pending, results, comPath) {
    const rows = rowsFromServer(site, cfgAfter, comPath);
    const byRef = new Map((results || []).map((r) => [String(r.ref), r]));
    for (const p of pending) {
        const res = byRef.get(p.ref);
        if (res && res.ok) {
            continue;
        }
        if (!p.row) {
            continue; // refused delete: the server row stays in the list
        }
        const key = p.kind;
        const row = { ...p.row, site: String(site) };
        const list = /** @type {any[]} */ (
            rows[/** @type {"moxas"|"units"|"routers"|"meters"} */ (key)]
        );
        const at = list.findIndex((x) =>
            key === "units"
                ? x.name === row.name
                : key === "meters"
                  ? meterKey(x) === meterKey(row)
                  : row.id && x.id === Number(row.id),
        );
        if (at >= 0) {
            list[at] = row;
        } else {
            list.push(row);
        }
    }
    return rows;
}

/**
 * Tables with the rows of one site replaced. @param {number} site @param {Tables} local @param {Tables} rows
 *
 * @param site
 * @param local
 * @param rows
 * @returns {Tables}
 */
function replaceSite(site, local, rows) {
    const other = (/** @type {any[]} */ list) =>
        (list || []).filter((r) => String(r.site) !== String(site));
    return {
        moxas: [...other(local.moxas), ...rows.moxas],
        units: [...other(local.units), ...rows.units],
        routers: [...other(local.routers), ...rows.routers],
        meters: [...other(local.meters || []), ...(rows.meters || [])],
    };
}

/**
 * True if two sets of rows (one site) are the same, regardless of order. @param {Tables} a @param {Tables} b
 *
 * @param a
 * @param b
 */
function sameRows(a, b) {
    const norm = (/** @type {Tables} */ t) =>
        JSON.stringify([
            t.moxas
                .map((r) => ({
                    id: Number(r.id) || 0,
                    comPort: str(r.comPort),
                    ...canonMoxa(r),
                }))
                .sort(cmp),
            t.units.map((r) => canonUnit(r)).sort(cmp),
            t.routers
                .map((r) => ({ id: Number(r.id) || 0, ...canonRouter(r) }))
                .sort(cmp),
            (t.meters || [])
                .map((r) => ({
                    key: meterKey(r),
                    type: str(r.type),
                    adr: str(r.adr),
                    ...canonMeter(r),
                }))
                .sort(cmp),
        ]);
    return norm(a) === norm(b);
}

/**
 * @param {any} a @param {any} b
 * @param b
 */
function cmp(a, b) {
    return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
}

module.exports = {
    DAY_KEYS,
    canonMeter,
    meterKey,
    canonMoxa,
    canonUnit,
    canonRouter,
    rowsFromServer,
    snapshotFromServer,
    plan,
    resolve,
    replaceSite,
    sameRows,
};
