"use strict";

const SCHEMA = 1;
const CHECK_EVERY_MS = 24 * 3600000;
const RETRY_AFTER_FAILURE_MS = 3 * 86400000;

/** @param {string} s */
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Is `nowMs` inside the update window of the router? The window starts on the chosen weekdays at the chosen time
 * (local time of the host) and lasts the chosen number of minutes; it may reach over midnight.
 *
 * @param {number} nowMs
 * @param {{ upd_days?: string, upd_time?: string, upd_window_min?: number }} r
 */
function inWindow(nowMs, r) {
    const days = String(r.upd_days ?? "0")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => /^[0-6]$/.test(x))
        .map(Number);
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(r.upd_time || "03:30"));
    if (!m || days.length === 0) {
        return false;
    }
    const len =
        Math.max(5, Math.min(720, Number(r.upd_window_min) || 90)) * 60000;
    const now = new Date(nowMs);
    for (const back of [0, 1]) {
        const start = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - back,
            Number(m[1]),
            Number(m[2]),
            0,
            0,
        );
        if (
            days.includes(start.getDay()) &&
            nowMs >= start.getTime() &&
            nowMs < start.getTime() + len
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Looks after the MikroTik routers of a client: daily look at the versions, update at the time set in the web
 * application, report to the server.
 */
class RouterCare {
    /**
     * @param {object} o
     * @param {{ info: Function, warn: Function, error: Function, debug: Function }} o.log
     * @param {import("./updater").RouterUpdater} o.updater
     * @param {import("../mbus/store").Store} o.store
     * @param {string} o.version
     * @param {(id: string, value: any, name?: string, write?: boolean) => Promise<void>} o.setState
     * @param {() => number} [o.now]
     */
    constructor(o) {
        this.log = o.log;
        this.updater = o.updater;
        this.store = o.store;
        this.version = o.version;
        this.setState = o.setState;
        this.now = o.now || Date.now;
    }

    /**
     * One pass for one client.
     *
     * @param {{ label: string, clientId: number, cfg: any }} c
     */
    async run(c) {
        const routers = (c.cfg && c.cfg.routers) || [];
        const cmds = (c.cfg && c.cfg.router_commands) || [];
        const st = this.store.state;
        st.routers = st.routers || {};
        st.commands = st.commands || {};
        for (const r of routers) {
            if (!r.enabled) {
                continue;
            }
            const key = `${c.clientId}:${r.id}`;
            for (const cmd of cmds.filter(
                (x) => x.router_id === r.id && !st.commands[`r${x.id}`],
            )) {
                await this.command(c, r, cmd, key);
            }
            const s = st.routers[key] || {};
            const blocked =
                s.failedAt && this.now() - s.failedAt < RETRY_AFTER_FAILURE_MS;
            const due =
                !s.checkedAt || this.now() - s.checkedAt >= CHECK_EVERY_MS;
            if (
                s.pending &&
                r.auto_update &&
                !blocked &&
                inWindow(this.now(), r)
            ) {
                await this.work(c, r, key, true);
            } else if (due) {
                // looking is harmless at any time; installing only in the window
                await this.work(
                    c,
                    r,
                    key,
                    !!r.auto_update && !blocked && inWindow(this.now(), r),
                );
            }
        }
    }

    /**
     * @param {any} c
     * @param {any} r
     * @param {{ id: number, type: string }} cmd
     * @param {string} key
     */
    async command(c, r, cmd, key) {
        this.log.info(`Router ${r.name}: Auftrag ${cmd.type}`);
        let res;
        try {
            res = await this.work(c, r, key, cmd.type === "rupdate");
        } catch (e) {
            res = { ok: false, summary: `Fehler: ${e && e.message}` };
        }
        this.store.state.commands[`r${cmd.id}`] = this.now();
        this.store.saveState();
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [],
            router_commands: [
                { id: cmd.id, ok: res.ok, result: { summary: res.summary } },
            ],
        });
    }

    /**
     * Looks at the router and installs when `install` is set and something is to be installed.
     *
     * @param {any} c
     * @param {any} r
     * @param {string} key
     * @param {boolean} install
     * @returns {Promise<{ ok: boolean, summary: string }>}
     */
    async work(c, r, key, install) {
        const st = this.store.state.routers;
        const chk = await this.updater.check(r);
        let report = this.report(r, chk, chk.status, chk.note);
        let ok = chk.status !== "fehler";
        if (install && chk.status === "veraltet") {
            this.enqueue(c, {
                ...report,
                status: "update_laeuft",
                note: "Update wird eingespielt.",
            });
            const u = await this.updater.update(r);
            ok = u.ok;
            const after = u.ok ? await this.updater.check(r) : chk;
            report = this.report(
                r,
                after,
                u.ok ? "aktuell" : "fehler",
                u.note,
                u.ok ? new Date(this.now()).toISOString() : null,
            );
            st[key] = {
                ...(st[key] || {}),
                failedAt: u.ok ? undefined : this.now(),
            };
        }
        st[key] = {
            ...(st[key] || {}),
            checkedAt: this.now(),
            pending: report.status === "veraltet",
        };
        this.store.saveState();
        const p = `mbus.${safe(c.label)}.routers.${r.id}`;
        await this.setState(
            `${p}.version`,
            report.os_version,
            "RouterOS-Version",
        );
        await this.setState(
            `${p}.latest`,
            report.latest_version,
            "Neueste RouterOS-Version",
        );
        await this.setState(`${p}.status`, report.status, "Update-Status");
        this.enqueue(c, report);
        this.log.info(`Router ${r.name}: ${report.note}`);
        return { ok, summary: report.note };
    }

    /**
     * @param {any} r @param {any} chk @param {string} status @param {string} note @param {string|null} [updatedAt]
     * @param chk
     * @param status
     * @param note
     * @param updatedAt
     */
    report(r, chk, status, note, updatedAt = null) {
        return {
            router_id: r.id,
            status,
            reachable: chk.reachable !== false,
            model: chk.model || null,
            identity: chk.identity || null,
            os_version: chk.version || null,
            latest_version: chk.latest || null,
            rb_current: chk.rbCurrent || null,
            rb_upgrade: chk.rbUpgrade || null,
            note,
            updated_at: updatedAt,
        };
    }

    /**
     * @param {{ label: string }} c @param {object} report
     * @param report
     */
    enqueue(c, report) {
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [],
            routers: [report],
        });
    }
}

module.exports = { RouterCare, inWindow };
