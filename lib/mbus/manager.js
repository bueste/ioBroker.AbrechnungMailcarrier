"use strict";

const { Bus } = require("./bus");
const { HEAT_MEDIA, mediumName } = require("./parse");
const { RouterCare } = require("../mikrotik/routers");
const sync = require("./configsync");
const { lastDue } = require("./stichtag");

const SCHEMA = 1;
const CONFIG_EVERY_MS = 60 * 1000;
const TICK_MS = 20 * 1000;
const MAX_FLUSH_PER_TICK = 25;
const SCAN_RETRY_MS = 60 * 60 * 1000;
/** Moxa firmware: looked at every week, flashed only in this window (local time), not at the maintenance run of the host (03:00) */
const FW_CHECK_EVERY_MS = 7 * 86400000;
const FW_RETRY_AFTER_FAILURE_MS = 7 * 86400000;
const FW_WINDOW = { from: 60, to: 165 }; // minutes after midnight: 01:00 to 02:45

/** @param {string} s */
function safe(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the M-Bus work of the adapter: fetches the configuration from the web app, polls the meters behind each
 * Moxa on schedule, scans the bus, runs the commands the web app queued, keeps everything on disk and delivers
 * it with retry. One manager serves several clients (one API token each).
 */
class MbusManager {
    /**
     * @param {object} o
     * @param {{ info: Function, warn: Function, error: Function, debug: Function }} o.log
     * @param {{ label: string, api: import("../api").ApiClient }[]} o.clients
     * @param {import("./store").Store} o.store
     * @param {string} o.version
     * @param {(id: string, value: any, name?: string, write?: boolean) => Promise<void>} o.setState
     * @param {() => number} [o.now]
     * @param {object} [o.busOptions]  timing overrides (tests)
     * @param {[number, number]} [o.scanRange]
     * @param {import("../moxa/updater").MoxaUpdater|null} [o.updater] firmware care of the Moxa (null: off)
     * @param {import("../mikrotik/updater").RouterUpdater|null} [o.routerUpdater] update care of the MikroTik routers (null: off)
     * @param {string|null} [o.sshPublicKey] public key the routers must know, reported to the web application
     * @param {import("./commount").ComMounts|null} [o.comMounts] automatic virtual COM ports of the Moxas (null: off)
     * @param {(label: string, id: number) => string} [o.moxaPassword] web console password of one Moxa
     * @param {boolean} [o.reportConnection] let the state info.connection follow the M-Bus side (when the solar delivery is not used)
     * @param {(label: string, id: number) => string[]} [o.moxaSecondary] identification numbers of meters that are reached by secondary address (not found by the primary scan)
     * @param {(label: string, id: number) => boolean} [o.moxaSetup] true if the adapter may set the Moxa up for the M-Bus (default: no)
     * @param {{ read: () => { moxas: any[], units: any[], routers: any[], meters: any[], settings: any[] }, write: (t: { moxas: any[], units: any[], routers: any[], meters?: any[], settings?: any[] }) => Promise<void> }|null} [o.tables] the Moxa, apartment and router tables of the instance configuration (null: web application only)
     */
    constructor(o) {
        this.log = o.log;
        this.store = o.store;
        this.version = o.version;
        this.setState = o.setState;
        this.now = o.now || Date.now;
        this.busOptions = o.busOptions || {};
        this.updater = o.updater || null;
        /** MikroTik router care (null: off) */
        this.routers = o.routerUpdater
            ? new RouterCare({
                  log: this.log,
                  updater: o.routerUpdater,
                  store: this.store,
                  version: this.version,
                  setState: this.setState,
                  now: this.now,
              })
            : null;
        this.sshPublicKey = o.sshPublicKey || null;
        this.tables = o.tables || null;
        this.mounts = o.comMounts || null;
        this.moxaPassword = o.moxaPassword || (() => "");
        this.moxaSetup = o.moxaSetup || (() => false);
        this.moxaSecondary = o.moxaSecondary || (() => []);
        /** the instance state info.connection (the green dot in the instance list) follows the M-Bus side */
        this.reportConnection = o.reportConnection === true;
        /** @type {Record<string, number>} last time an error of the table comparison was logged, by text */
        this.syncLogged = {};
        /** address range of a bus scan (tests narrow it) */
        this.scanRange = o.scanRange || [0, 250];
        /** @type {{ label: string, api: import("../api").ApiClient, cfg: any, cfgAt: number, clientId: number, lastSlot: Record<string, number>, scanTried: Record<string, number>, settingsChange: any, authFailed: boolean }[]} */
        this.clients = o.clients.map((c) => ({
            label: c.label,
            api: c.api,
            cfg: null,
            cfgAt: 0,
            clientId: 0,
            lastSlot: {},
            scanTried: {},
            settingsChange: null,
            authFailed: false,
        }));
        this.running = false;
        this.stopped = false;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        this.timer = undefined;
    }

    start() {
        this.store.init();
        // a firmware look from before the status was kept is repeated right away
        const fw = this.store.state.fw || {};
        for (const k of Object.keys(fw)) {
            if (!fw[k].status || !fw[k].setupSeen) {
                delete fw[k];
            }
        }
        if (this.sshPublicKey) {
            for (const c of this.clients) {
                this.store.enqueue({
                    _c: c.label,
                    schema: SCHEMA,
                    adapter_version: this.version,
                    gateways: [],
                    adapter: { ssh_public_key: this.sshPublicKey },
                });
            }
        }
        this.schedule(2000);
    }

    stop() {
        this.stopped = true;
        if (this.mounts) {
            this.mounts.stopAll();
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }

    /** @param {number} ms */
    schedule(ms) {
        if (this.stopped) {
            return;
        }
        this.timer = setTimeout(async () => {
            try {
                await this.tick();
            } catch (e) {
                this.log.error(`M-Bus: ${e && e.message}`);
            }
            this.schedule(TICK_MS);
        }, ms);
    }

    /** One pass over all clients. */
    async tick() {
        if (this.running) {
            return;
        }
        this.running = true;
        try {
            for (const c of this.clients) {
                await this.tickClient(c);
            }
            await this.flush();
            await this.updateConnection();
        } finally {
            this.running = false;
        }
    }

    /**
     * info.connection ("connected with device or service"): true when the web application answers and every active
     * Moxa answered at its last reading.
     */
    async updateConnection() {
        if (!this.reportConnection) {
            return;
        }
        let ok = this.clients.length > 0;
        for (const c of this.clients) {
            const down = /** @type {any} */ (c).down || {};
            if (!c.cfg || c.authFailed) {
                ok = false;
                continue;
            }
            for (const g of c.cfg.gateways) {
                if (g.enabled && down[String(g.id)] !== false) {
                    ok = false;
                }
            }
        }
        await this.setState(
            "info.connection",
            ok,
            "Verbunden mit Gerät oder Dienst",
        );
    }

    // ------------------------------------------------------------------ per client

    /** @param {MbusManager["clients"][number]} c */
    async tickClient(c) {
        if (this.now() - c.cfgAt >= CONFIG_EVERY_MS || c.settingsChange) {
            await this.refreshConfig(c);
        }
        if (!c.cfg) {
            return;
        }
        this.checkMounts(c);
        const s = c.cfg.settings;
        const interval = Math.max(5, Number(s.read_minutes) || 15) * 60000;
        for (const g of c.cfg.gateways) {
            if (!g.enabled || this.stopped) {
                continue;
            }
            const key = String(g.id);
            const cmds = c.cfg.commands.filter(
                (x) =>
                    x.gateway_id === g.id && !this.store.state.commands[x.id],
            );
            for (const cmd of cmds) {
                await this.runCommand(c, g, cmd);
            }
            const scanDue =
                g.scan_due &&
                this.now() - (c.scanTried[key] || 0) >= SCAN_RETRY_MS;
            if (scanDue) {
                c.scanTried[key] = this.now();
                await this.runJob(c, g, "scan");
                c.lastSlot[key] = Math.floor(this.now() / interval);
                continue;
            }
            if (s.read_mode === "stichtag") {
                await this.stichtagStep(c, g, s);
            } else {
                const slot = Math.floor(this.now() / interval);
                if (c.lastSlot[key] !== slot) {
                    c.lastSlot[key] = slot;
                    await this.runJob(c, g, "poll");
                }
            }
            await this.maybeTimesync(c, g);
            await this.maybeFirmware(c, g);
        }
        if (this.routers && !this.stopped) {
            await this.routers.run(c);
        }
    }

    /**
     * Reading only on the key date: at the key date (e.g. last day of the month, 23:59) all meters are read once;
     * a pass with missing meters is repeated every five minutes for three hours. In between, every ten minutes a
     * short report says whether the Moxa answers (no readings), so the monitoring keeps working.
     *
     * @param {MbusManager["clients"][number]} c
     * @param {any} g
     * @param {any} s settings of the web application
     */
    async stichtagStep(c, g, s) {
        const ca = /** @type {any} */ (c);
        ca.tried = ca.tried || {};
        ca.beat = ca.beat || {};
        const st = this.store.state;
        st.stichtag = st.stichtag || {};
        const key = String(g.id);
        const skey = `${c.clientId}:${g.id}`;
        const due = lastDue(
            new Date(this.now()),
            s.stichtag_day || "1",
            s.stichtag_time || "00:00",
        );
        const dueIso = due.toISOString();
        const late = this.now() - due.getTime();
        const done = st.stichtag[skey] && st.stichtag[skey].due === dueIso;
        if (!done && this.now() - (ca.tried[key] || 0) >= 5 * 60000) {
            ca.tried[key] = this.now();
            this.log.info(
                `M-Bus ${g.name}: Stichtagsablesung ${due.toLocaleString("de-CH")}${late > 15 * 60000 ? " (verspätet)" : ""}`,
            );
            const res = await this.runJob(c, g, "poll", due);
            const ok = !!res && res.reachable && res.complete;
            if (ok || late > 3 * 3600 * 1000) {
                st.stichtag[skey] = {
                    due: dueIso,
                    ok,
                    doneAt: new Date(this.now()).toISOString(),
                };
                this.store.saveState();
                if (!ok) {
                    this.queueAlarm(
                        c,
                        g.id,
                        "stichtag",
                        key,
                        "crit",
                        `Stichtagsablesung vom ${due.toLocaleString("de-CH")} der Moxa "${g.name}" unvollständig: ${res && res.failed ? `${res.failed} Zähler ohne Antwort` : "Moxa nicht erreichbar"}.`,
                        false,
                    );
                } else if (ca.stichtagAlarm) {
                    this.queueAlarm(
                        c,
                        g.id,
                        "stichtag",
                        key,
                        "crit",
                        "Stichtagsablesung vollständig",
                        true,
                    );
                }
                ca.stichtagAlarm = !ok;
            }
            ca.beat[key] = this.now();
            return;
        }
        if (this.now() - (ca.beat[key] || 0) >= 10 * 60000) {
            ca.beat[key] = this.now();
            await this.heartbeat(c, g);
        }
    }

    /**
     * Reports whether the Moxa answers, without reading meters (the web application then sees the gateway as alive).
     *
     * @param {MbusManager["clients"][number]} c
     * @param {any} g
     */
    async heartbeat(c, g) {
        const bus = this.busFor(g, c);
        const gp = `mbus.${safe(c.label)}.gateways.${g.id}`;
        const gw = {
            id: g.id,
            reachable: false,
            error: /** @type {string|null} */ (null),
            polled_at: new Date(this.now()).toISOString(),
            complete: false,
            scan: false,
            meters: [],
        };
        try {
            await bus.connect();
            gw.reachable = true;
        } catch (e) {
            gw.error = e && e.message ? e.message : String(e);
        } finally {
            bus.close();
        }
        /** @type {any} */ (c).down = /** @type {any} */ (c).down || {};
        /** @type {any} */ (c).down[String(g.id)] = !gw.reachable;
        await this.setState(`${gp}.reachable`, gw.reachable, "Moxa erreichbar");
        await this.setState(
            `${gp}.lastError`,
            gw.error || "",
            "Letzter Fehler",
        );
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [gw],
        });
    }

    /**
     * Warns (finding in the web application, mail for warnings) when the COM port of an active Moxa is not
     * mounted for more than three minutes, and closes the finding when it is mounted again.
     *
     * @param {MbusManager["clients"][number]} c
     */
    checkMounts(c) {
        if (!this.mounts || !c.cfg) {
            return;
        }
        const ca = /** @type {any} */ (c);
        ca.comAlarm = ca.comAlarm || {};
        for (const g of c.cfg.gateways) {
            const key = String(g.id);
            const entry = this.mounts.ports.get(`${c.label}:${g.id}`);
            const missing =
                !!entry &&
                !entry.up &&
                this.now() - entry.since >= 3 * 60 * 1000;
            if (missing && !ca.comAlarm[key]) {
                ca.comAlarm[key] = true;
                this.queueAlarm(
                    c,
                    g.id,
                    "com_port",
                    key,
                    "warn",
                    `COM-Port der Moxa "${g.name}" ist nicht eingebunden: ${entry.lastErr || `Moxa nicht erreichbar oder nicht im TCP-Server-Modus (Port ${g.port})`}`,
                    false,
                );
            } else if (!missing && ca.comAlarm[key]) {
                delete ca.comAlarm[key];
                this.queueAlarm(
                    c,
                    g.id,
                    "com_port",
                    key,
                    "warn",
                    `COM-Port der Moxa "${g.name}" ist wieder eingebunden`,
                    true,
                );
            }
        }
    }

    /**
     * @param {MbusManager["clients"][number]} c
     * @param {number} gatewayId
     * @param {string} type
     * @param {string} key
     * @param {"info"|"warn"|"crit"} severity
     * @param {string} message
     * @param {boolean} resolved
     */
    queueAlarm(c, gatewayId, type, key, severity, message, resolved) {
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [],
            alarms: [
                {
                    type,
                    key,
                    severity,
                    message,
                    gateway_id: gatewayId,
                    resolved,
                },
            ],
        });
    }

    /** @param {MbusManager["clients"][number]} c */
    async refreshConfig(c) {
        const change = c.settingsChange;
        if (change) {
            const r = await c.api.mbusIngest({
                schema: SCHEMA,
                adapter_version: this.version,
                gateways: [],
                settings: {
                    base_version: c.cfg ? c.cfg.settings.version : -1,
                    ...change,
                },
            });
            if (r.ok) {
                this.log.info(
                    `M-Bus ${c.label}: Intervalle an den Server gemeldet (${r.data.settings || "?"})`,
                );
            } else {
                this.log.warn(
                    `M-Bus ${c.label}: Intervall-Änderung nicht übertragen: ${r.message}`,
                );
            }
            if (r.ok || r.kind === "rejected") {
                c.settingsChange = null;
            }
        }
        const r = await c.api.mbusConfig();
        c.cfgAt = this.now();
        if (!r.ok) {
            if (r.kind === "auth") {
                if (!c.authFailed) {
                    this.log.error(
                        `M-Bus ${c.label}: Token abgelehnt: ${r.message}`,
                    );
                }
                c.authFailed = true;
            } else {
                this.log.warn(
                    `M-Bus ${c.label}: Konfiguration nicht abrufbar: ${r.message}`,
                );
            }
            await this.setState(
                `mbus.${safe(c.label)}.info.connection`,
                false,
                "Server erreichbar",
            );
            return;
        }
        c.authFailed = false;
        c.cfg = r.data;
        c.clientId = Number(r.data.client && r.data.client.id) || 0;
        try {
            await this.syncTables(c);
        } catch (e) {
            this.log.warn(
                `M-Bus ${c.label}: Tabellenabgleich: ${e && e.message}`,
            );
        }
        if (this.mounts) {
            this.mounts.sync(c.label, c.cfg.gateways);
        }
        await this.publishConfig(c);
    }

    /**
     * Compares the Moxa, apartment and router tables of the instance with the web application and carries the
     * differences over in both directions (see configsync.js).
     *
     * @param {MbusManager["clients"][number]} c
     */
    async syncTables(c) {
        if (!this.tables || !c.cfg) {
            return;
        }
        const site = Number(String(c.label).slice(1));
        const local = this.tables.read();
        const snaps =
            this.store.state.cfgSnap || (this.store.state.cfgSnap = {});
        const pl = sync.plan(site, local, snaps[c.label] || null, c.cfg);
        let cfg = c.cfg;
        /** @type {any[]} */
        let results = [];
        /** @type {any} */
        let keepSettings = null;
        if (pl.settings) {
            const r = await c.api.mbusIngest({
                schema: SCHEMA,
                adapter_version: this.version,
                gateways: [],
                settings: {
                    base_version: c.cfg.settings.version,
                    ...pl.settings,
                },
            });
            if (r.ok && r.data.settings === "angenommen") {
                this.log.info(
                    `M-Bus ${c.label}: Intervalle aus der Instanz an den Server übertragen`,
                );
                const again = await c.api.mbusConfig();
                if (again.ok) {
                    cfg = again.data;
                    c.cfg = cfg;
                }
            } else {
                const why = r.ok ? r.data.settings : r.message;
                keepSettings =
                    (local.settings || []).find(
                        (x) => String(x.site) === String(site),
                    ) || null;
                this.logOnce(
                    `set:${c.label}:${why}`,
                    `M-Bus ${c.label}: Intervalle vom Server abgelehnt: ${why}`,
                );
            }
        }
        if (pl.push) {
            const r = await c.api.mbusIngest({
                schema: SCHEMA,
                adapter_version: this.version,
                gateways: [],
                config_push: pl.push,
            });
            if (!r.ok) {
                this.logOnce(
                    `push:${c.label}:${r.message}`,
                    `M-Bus ${c.label}: Änderungen nicht übertragen: ${r.message}`,
                );
                return;
            }
            results = Array.isArray(r.data.config_result)
                ? r.data.config_result
                : [];
            for (const x of results) {
                if (!x.ok) {
                    this.logOnce(
                        `res:${c.label}:${x.kind}:${x.ref}:${x.error}`,
                        `M-Bus ${c.label}: ${x.kind} "${x.ref}" vom Server abgelehnt: ${x.error}`,
                    );
                }
            }
            const again = await c.api.mbusConfig();
            if (again.ok) {
                cfg = again.data;
                c.cfg = cfg;
            }
            this.log.info(
                `M-Bus ${c.label}: ${results.filter((x) => x.ok).length} Änderung(en) aus der Instanz an den Server übertragen`,
            );
        }
        const comPath = (/** @type {number} */ id) =>
            this.mounts ? this.mounts.file(c.label, id) : "";
        const rows = sync.resolve(
            site,
            cfg,
            pl.pending,
            results,
            comPath,
            keepSettings,
        );
        const mine = {
            moxas: local.moxas.filter((x) => String(x.site) === String(site)),
            units: local.units.filter((x) => String(x.site) === String(site)),
            routers: local.routers.filter(
                (x) => String(x.site) === String(site),
            ),
            meters: (local.meters || []).filter(
                (x) => String(x.site) === String(site),
            ),
            settings: (local.settings || []).filter(
                (x) => String(x.site) === String(site),
            ),
        };
        for (const row of rows.moxas) {
            const old = mine.moxas.find(
                (x) => Number(x.id) === Number(row.id) && Number(row.id) > 0,
            );
            if (old && old.password && !row.password) {
                row.password = old.password; // stays on this computer, never sent to the server
            }
            if (old && old.setup !== undefined && row.setup === undefined) {
                row.setup = old.setup;
            }
            if (old && old.secondary && !row.secondary) {
                row.secondary = old.secondary;
            }
        }
        snaps[c.label] = sync.snapshotFromServer(cfg);
        this.store.saveState();
        if (!sync.sameRows(mine, rows)) {
            this.log.info(
                `M-Bus ${c.label}: Tabellen der Instanz werden mit dem Server abgeglichen (die Instanz startet dabei einmal neu)`,
            );
            await this.tables.write(sync.replaceSite(site, local, rows));
        }
    }

    /**
     * Logs a message only once per hour per key. @param {string} key @param {string} msg
     *
     * @param key
     * @param msg
     */
    logOnce(key, msg) {
        const t = this.now();
        if (!this.syncLogged[key] || t - this.syncLogged[key] > 3600000) {
            this.syncLogged[key] = t;
            this.log.warn(msg);
        }
    }

    /**
     * A bus on the connection of a gateway: TCP (Moxa in raw server mode) or a COM device.
     *
     * @param {any} g gateway of the configuration
     * @param {MbusManager["clients"][number]} [c]
     */
    busFor(g, c) {
        const mounted =
            c && this.mounts && this.mounts.isUp(c.label, g.id)
                ? this.mounts.file(c.label, g.id)
                : "";
        return new Bus({
            host: g.host,
            port: g.port,
            device: mounted || g.device || undefined,
            baud: g.baud,
            parity: g.parity,
            debug: (m) => this.log.debug(`M-Bus ${g.name}: ${m}`),
            ...this.busOptions,
        });
    }

    /**
     * Mirrors the configuration into ioBroker states. @param {MbusManager["clients"][number]} c
     *
     * @param c
     */
    async publishConfig(c) {
        const p = `mbus.${safe(c.label)}`;
        const s = c.cfg.settings;
        await this.setState(`${p}.info.connection`, true, "Server erreichbar");
        await this.setState(
            `${p}.info.client`,
            String(c.cfg.client.name || ""),
            "Mandant",
        );
        await this.setState(
            `${p}.settings.readMinutes`,
            s.read_minutes,
            "Zählerstände auslesen alle (Minuten)",
            true,
        );
        await this.setState(
            `${p}.settings.readMode`,
            String(s.read_mode || "intervall"),
            "Ablesung: intervall oder stichtag",
            true,
        );
        await this.setState(
            `${p}.settings.stichtagDay`,
            String(s.stichtag_day || "1"),
            "Stichtag: last oder Tag 1 bis 28",
            true,
        );
        await this.setState(
            `${p}.settings.stichtagTime`,
            String(s.stichtag_time || "00:00"),
            "Uhrzeit des Stichtags",
            true,
        );
        await this.setState(
            `${p}.settings.scanDays`,
            s.scan_days,
            "Bus-Scan alle (Tage)",
            true,
        );
        await this.setState(
            `${p}.settings.timesyncDays`,
            s.timesync_days,
            "Zeitabgleich alle (Tage)",
            true,
        );
        await this.setState(
            `${p}.settings.timesyncEnabled`,
            !!s.timesync_enabled,
            "Zeitabgleich automatisch",
            true,
        );
        await this.setState(
            `${p}.settings.version`,
            s.version,
            "Version der Einstellungen",
        );
        const alarms = Array.isArray(c.cfg.alarms) ? c.cfg.alarms : [];
        await this.setState(
            `${p}.alarms.count`,
            alarms.length,
            "Offene Befunde",
        );
        await this.setState(
            `${p}.alarms.text`,
            alarms.map((a) => a.message).join("\n"),
            "Befunde als Text",
        );
        for (const u of c.cfg.units || []) {
            await this.setState(
                `${p}.units.${safe(u.name)}.label`,
                String(u.label || ""),
                "Bezeichnung",
            );
        }
        for (const g of c.cfg.gateways) {
            const gp = `${p}.gateways.${g.id}`;
            await this.setState(`${gp}.name`, g.name, "Name");
            await this.setState(
                `${gp}.address`,
                g.device ? g.device : `${g.host}:${g.port}`,
                "Adresse",
            );
            await this.setState(
                `${gp}.comPort`,
                this.mounts && this.mounts.isUp(c.label, g.id)
                    ? this.mounts.file(c.label, g.id)
                    : g.device || "",
                "COM-Port (automatisch eingebunden)",
            );
            await this.setState(
                `${gp}.meters`,
                g.meters.length,
                "Erwartete Zähler",
            );
        }
    }

    // ------------------------------------------------------------------ jobs

    /**
     * @param {MbusManager["clients"][number]} c
     * @param {any} g gateway of the configuration
     * @param {"poll"|"scan"} mode
     * @param {Date} [due] key date of a reading taken only on the key date
     * @returns {Promise<{ reachable: boolean, complete: boolean, failed: number }>}
     */
    async runJob(c, g, mode, due) {
        const started = this.now();
        const bus = this.busFor(g, c);
        const gp = `mbus.${safe(c.label)}.gateways.${g.id}`;
        /** @type {{ id: number, reachable: boolean, error: string|null, polled_at: string, complete: boolean, scan: boolean, meters: any[] }} */
        const gw = {
            id: g.id,
            reachable: false,
            error: null,
            polled_at: new Date(started).toISOString(),
            complete: false,
            scan: mode === "scan",
            meters: [],
        };
        /** @type {object[]} */
        const rows = [];
        let failed = 0;
        try {
            await bus.connect();
            gw.reachable = true;
            /** @type {{ addr: number|null, secondary?: string, expected: any }[]} */
            let targets;
            if (mode === "scan") {
                this.log.info(
                    `M-Bus ${g.name}: Bus-Scan ${this.scanRange[0]} bis ${this.scanRange[1]} ...`,
                );
                const hits = await bus.scan(
                    this.scanRange[0],
                    this.scanRange[1],
                );
                targets = hits.map((h) => ({
                    addr: h.addr,
                    expected: g.meters.find((m) => m.primary === h.addr),
                }));
            } else {
                targets = g.meters
                    .filter(
                        (m) => m.primary !== null && m.primary !== undefined,
                    )
                    .map((m) => ({ addr: m.primary, expected: m }));
            }
            // meters reached by secondary address (entered in the Moxa row)
            for (const sid of this.moxaSecondary(c.label, g.id)) {
                targets.push({
                    addr: null,
                    secondary: sid,
                    expected: g.meters.find((m) => m.id === sid),
                });
            }
            for (const t of targets) {
                if (this.stopped) {
                    break;
                }
                // a reading taken within 15 minutes of the key date carries the key date as its time
                const readAt =
                    due && this.now() - due.getTime() <= 15 * 60000
                        ? due
                        : new Date(this.now());
                const r = t.secondary
                    ? await bus.readMeter(253, t.secondary)
                    : await bus.readMeter(/** @type {number} */ (t.addr));
                if (!r.ok) {
                    failed++;
                    this.log.debug(
                        `M-Bus ${g.name}: ${t.secondary ? `Sekundäradresse ${t.secondary}` : `Adresse ${t.addr}`}: ${r.error}`,
                    );
                    continue;
                }
                const sm = r.summary;
                if (!sm) {
                    continue;
                }
                const m = {
                    id: r.header.id,
                    primary: t.addr,
                    manufacturer: r.header.manufacturer,
                    version: r.header.version,
                    medium: r.header.medium,
                    medium_name: mediumName(r.header.medium),
                    ok: sm.value !== null,
                    read_at: readAt.toISOString(),
                    value: sm.value,
                    unit: sm.unit,
                    value2: sm.value2,
                    unit2: sm.unit2,
                    flags: sm.flags,
                    meter_time: sm.meterTime,
                    extra: sm.extra,
                };
                gw.meters.push(m);
                if (m.ok) {
                    rows.push({
                        t: m.read_at,
                        gw: g.id,
                        id: m.id,
                        p: m.primary,
                        v: m.value,
                        u: m.unit,
                        v2: m.value2,
                        u2: m.unit2,
                        f: m.flags,
                        mt: m.meter_time,
                    });
                }
                if (t.expected && t.expected.id !== m.id) {
                    this.log.warn(
                        `M-Bus ${g.name}: Adresse ${t.addr} liefert Zähler ${m.id}, erwartet war ${t.expected.id}`,
                    );
                }
            }
            gw.complete = !this.stopped;
            this.log.info(
                `M-Bus ${g.name}: ${mode === "scan" ? "Scan" : "Abfrage"} fertig, ${gw.meters.length} Zähler gelesen${failed ? `, ${failed} ohne Antwort` : ""} (${Math.round((this.now() - started) / 1000)} s)`,
            );
            await this.setState(`${gp}.lastError`, "", "Letzter Fehler");
            await this.publishReadings(c, g, gw.meters);
        } catch (e) {
            gw.error = e && e.message ? e.message : String(e);
            gw.reachable = !!bus.sock && gw.reachable;
            this.log.warn(`M-Bus ${g.name}: ${gw.error}`);
            await this.setState(`${gp}.lastError`, gw.error, "Letzter Fehler");
        } finally {
            bus.close();
        }
        /** @type {any} */ (c).down = /** @type {any} */ (c).down || {};
        /** @type {any} */ (c).down[String(g.id)] = !gw.reachable;
        await this.setState(`${gp}.reachable`, gw.reachable, "Moxa erreichbar");
        await this.setState(`${gp}.lastPoll`, gw.polled_at, "Letzte Abfrage");
        this.store.archive(rows, new Date(started));
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [gw],
        });
        return {
            reachable: gw.reachable,
            complete: gw.complete && failed === 0,
            failed,
        };
    }

    /**
     * Writes the readings of assigned meters into states.
     *
     * @param c
     * @param g
     * @param meters
     */
    async publishReadings(c, g, meters) {
        const p = `mbus.${safe(c.label)}`;
        const used = new Set();
        for (const m of meters) {
            if (!m.ok) {
                continue;
            }
            const exp = g.meters.find((x) => x.id === m.id);
            let base;
            if (exp && exp.unit && exp.kind) {
                base = `${p}.units.${safe(exp.unit)}.${safe(exp.kind)}`;
                if (used.has(base)) {
                    base += `_${m.id}`;
                }
            } else {
                base = `${p}.unassigned.${m.id}`;
            }
            used.add(base);
            await this.setState(`${base}.value`, m.value, "Stand");
            await this.setState(`${base}.unit`, m.unit, "Einheit");
            await this.setState(`${base}.meterId`, m.id, "Zähler-Kennung");
            await this.setState(`${base}.lastRead`, m.read_at, "Abgefragt");
            if (m.value2 !== null && m.value2 !== undefined) {
                await this.setState(
                    `${base}.value2`,
                    m.value2,
                    "Zweitwert (Volumen)",
                );
            }
        }
    }

    /**
     * Command from the web app: test, scan, timesync.
     *
     * @param {MbusManager["clients"][number]} c
     * @param {any} g
     * @param {{ id: number, type: string, params: any }} cmd
     */
    async runCommand(c, g, cmd) {
        this.log.info(`M-Bus ${g.name}: Auftrag ${cmd.type}`);
        let result;
        let ok = true;
        try {
            if (cmd.type === "test") {
                result = await this.testGateway(g, c);
            } else if (cmd.type === "scan") {
                await this.runJob(c, g, "scan");
                result = {
                    summary:
                        "Bus-Scan ausgeführt, das Ergebnis steht bei den Zählern.",
                };
                c.scanTried[String(g.id)] = this.now();
            } else if (cmd.type === "timesync") {
                result = await this.timesync(c, g, cmd.params || {});
            } else if (cmd.type === "fwcheck" || cmd.type === "fwupdate") {
                result = await this.firmware(c, g, cmd.type === "fwupdate");
            } else {
                ok = false;
                result = { summary: `unbekannter Auftrag ${cmd.type}` };
            }
        } catch (e) {
            ok = false;
            result = { summary: `Fehler: ${e && e.message}` };
        }
        if (result && result.ok === false) {
            ok = false;
        }
        this.store.state.commands[cmd.id] = this.now();
        this.store.saveState();
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [],
            commands: [{ id: cmd.id, ok, result }],
        });
    }

    /**
     * Connection test: TCP to the Moxa, then a look at the expected addresses. @param {any} g
     *
     * @param g
     * @param {MbusManager["clients"][number]} [c]
     */
    async testGateway(g, c) {
        const t0 = this.now();
        const bus = this.busFor(g, c);
        try {
            await bus.connect();
        } catch (e) {
            return {
                ok: false,
                reachable: false,
                summary: `Moxa nicht erreichbar: ${e.message}`,
            };
        }
        try {
            const addrs = g.meters
                .map((m) => m.primary)
                .filter((p) => p !== null && p !== undefined);
            const probe = addrs.length
                ? addrs
                : Array.from({ length: 21 }, (_, i) => i);
            let answered = 0;
            for (const a of probe) {
                if ((await bus.nke(a)) !== "none") {
                    answered++;
                }
            }
            const what = addrs.length
                ? `${answered} von ${addrs.length} erwarteten Zählern antworten`
                : `${answered} Antwort(en) auf den Adressen 0 bis 20 (noch keine Zähler bekannt, Scan auslösen)`;
            return {
                ok: addrs.length ? answered > 0 : true,
                reachable: true,
                answered,
                expected: addrs.length,
                ms: this.now() - t0,
                summary: `Moxa erreichbar, ${what} (${this.now() - t0} ms)`,
            };
        } finally {
            bus.close();
        }
    }

    // ------------------------------------------------------------------ clock

    /**
     * Sets the clock of meters and checks by reading back. Only meters that were asked for: params.meter_id, otherwise
     * all heat meters (params.all = true: all meters).
     *
     * @param {MbusManager["clients"][number]} c
     * @param {any} g
     * @param {{ meter_id?: string, all?: boolean }} params
     */
    async timesync(c, g, params) {
        const bus = this.busFor(g, c);
        const targets = g.meters.filter(
            (m) =>
                m.primary !== null &&
                m.primary !== undefined &&
                m.status !== "ignoriert" &&
                (params.meter_id
                    ? m.id.toUpperCase() ===
                      String(params.meter_id).toUpperCase()
                    : params.all || HEAT_MEDIA.has(m.medium)),
        );
        if (targets.length === 0) {
            return {
                ok: false,
                summary: "Kein passender Zähler für den Zeitabgleich.",
            };
        }
        await bus.connect();
        const lines = [];
        let accepted = 0;
        try {
            for (const m of targets) {
                const before = await bus.readMeter(m.primary);
                const t0 =
                    before.ok && before.summary
                        ? before.summary.meterTime
                        : null;
                const set = await bus.setClock(m.primary, new Date(this.now()));
                let after = null;
                if (set.accepted) {
                    await sleep(this.busOptions.afterSetMs ?? 2000);
                    const r = await bus.readMeter(m.primary);
                    after = r.ok && r.summary ? r.summary.meterTime : null;
                }
                const changed = set.accepted && after !== null && after !== t0;
                if (changed) {
                    accepted++;
                }
                lines.push(
                    `${m.id}: vorher ${t0 || "?"}, ${set.accepted ? "Meter hat quittiert" : "Zähler lehnt ab (keine Quittung)"}, nachher ${after || "?"}${set.accepted && !changed ? " (Uhr unverändert)" : ""}`,
                );
            }
        } finally {
            bus.close();
        }
        return {
            ok: accepted > 0,
            accepted,
            tried: targets.length,
            summary: `Zeitabgleich: ${accepted} von ${targets.length} Zählern übernehmen die Zeit. ${lines.join("; ")}`,
            lines,
        };
    }

    /**
     * Automatic clock adjustment on schedule, only when switched on in the web app. @param {any} c @param {any} g
     *
     * @param c
     * @param g
     */
    async maybeTimesync(c, g) {
        const s = c.cfg.settings;
        if (!s.timesync_enabled) {
            return;
        }
        const key = `timesync:${c.clientId}:${g.id}`;
        const last = this.store.state.lastRun[key] || 0;
        if (this.now() - last < Math.max(1, s.timesync_days) * 86400000) {
            return;
        }
        this.store.state.lastRun[key] = this.now();
        this.store.saveState();
        let res;
        try {
            res = await this.timesync(c, g, {});
        } catch (e) {
            res = {
                ok: false,
                summary: `Zeitabgleich fehlgeschlagen: ${e && e.message}`,
            };
        }
        this.log.info(`M-Bus ${g.name}: ${res.summary}`);
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [],
            alarms: [
                {
                    gateway_id: g.id,
                    type: "zeitabgleich",
                    key: String(g.id),
                    severity: "info",
                    message: `Moxa "${g.name}": ${res.summary}`,
                    resolved: res.ok === true,
                },
            ],
        });
    }

    // ------------------------------------------------------------------ Moxa firmware

    /** Local time as minutes after midnight. */
    localMinutes() {
        const d = new Date(this.now());
        return d.getHours() * 60 + d.getMinutes();
    }

    /**
     * Looks at the Moxa firmware (and flashes it when allowed). Result goes to the server as a "moxa" entry.
     *
     * @param {MbusManager["clients"][number]} c
     * @param {any} g gateway of the configuration
     * @param {boolean} flash flash now if an update is available
     * @returns {Promise<{ ok: boolean, summary: string }>}
     */
    async firmware(c, g, flash) {
        if (!this.updater) {
            return {
                ok: false,
                summary:
                    "Firmware-Pflege ist im Adapter nicht eingerichtet (Moxa-Passwort fehlt).",
            };
        }
        if (!g.host) {
            return {
                ok: false,
                summary:
                    "Firmware-Pflege braucht die Netzwerkadresse des Moxa, bei einem COM-Gerät ist keine eingetragen.",
            };
        }
        const gp0 = { ...g, password: this.moxaPassword(c.label, g.id) };
        if (!gp0.password && !this.updater.password) {
            return {
                ok: false,
                summary:
                    "Für diese Moxa ist in der Instanz-Konfiguration kein Web-Passwort eingetragen.",
            };
        }
        g = gp0;
        const st = this.store.state;
        st.fw = st.fw || {};
        const key = `${c.clientId}:${g.id}`;
        const gp = `mbus.${safe(c.label)}.gateways.${g.id}`;
        let report;
        let ok = true;
        let check;
        let mode = null;
        let serial = null;
        try {
            check = await this.updater.check(g);
            const fixed = await this.maybeSetup(c, g, check);
            if (fixed) {
                if (fixed.ok) {
                    check = await this.updater.check(g);
                }
                check = {
                    ...check,
                    note: `${fixed.note} ${check.note}`.slice(0, 280),
                };
            }
            report = {
                gateway_id: g.id,
                model: check.model || null,
                firmware: check.firmware || null,
                latest: check.latest || null,
                status: check.status,
                note: this.withMode(check),
            };
            mode = check.mode || null;
            serial = check.serial || null;
            ok = check.status !== "fehler";
            if (flash && check.status === "veraltet") {
                if (!check.updatable) {
                    ok = false;
                    report.note = check.note;
                } else {
                    report = {
                        ...report,
                        status: "update_laeuft",
                        note: "Firmware wird eingespielt.",
                    };
                    this.queueMoxa(c, report);
                    const u = await this.updater.update(g);
                    ok = u.ok;
                    report = {
                        gateway_id: g.id,
                        model: check.model || null,
                        firmware: u.ok ? u.to || check.latest : check.firmware,
                        latest: check.latest || null,
                        status: u.ok ? "aktuell" : "fehler",
                        note: u.note,
                        updated_at: u.ok
                            ? new Date(this.now()).toISOString()
                            : null,
                    };
                    if (u.ok) {
                        delete st.fw[key];
                    } else {
                        st.fw[key] = { failedAt: this.now(), note: u.note };
                    }
                }
            }
        } catch (e) {
            ok = false;
            report = {
                gateway_id: g.id,
                status: "fehler",
                note: `Fehler: ${e && e.message}`,
            };
        }
        st.fw[key] = {
            ...(st.fw[key] || {}),
            checkedAt: this.now(),
            status: report.status,
            setupSeen: true,
            pending: report.status === "veraltet",
        };
        this.store.saveState();
        await this.setState(`${gp}.moxaModel`, report.model, "Moxa Modell");
        await this.setState(
            `${gp}.moxaFirmware`,
            report.firmware,
            "Moxa Firmware",
        );
        await this.setState(
            `${gp}.moxaFirmwareStatus`,
            report.status,
            "Moxa Firmware Status",
        );
        await this.setState(`${gp}.moxaNote`, report.note, "Moxa Hinweis");
        if (mode) {
            await this.setState(`${gp}.moxaMode`, mode, "Betriebsart der Moxa");
        }
        if (serial) {
            await this.setState(
                `${gp}.moxaSerial`,
                serial,
                "Serielle Einstellung der Moxa",
            );
        }
        this.queueMoxa(c, report);
        this.log.info(`Moxa ${g.name}: ${report.note}`);
        return { ok, summary: report.note };
    }

    /**
     * Sets the Moxa up for the M-Bus when its console shows another operating mode or serial line than the
     * reading needs (TCP server mode, the serial line of the gateway) and the row allows it. A failed attempt is
     * not repeated for six hours.
     *
     * @param {MbusManager["clients"][number]} c
     * @param {any} g gateway of the configuration, with the password
     * @param {{ mode?: string|null, serial?: string|null }} check
     * @returns {Promise<{ ok: boolean, note: string }|null>}
     */
    async maybeSetup(c, g, check) {
        if (!this.updater || !check.mode || !this.moxaSetup(c.label, g.id)) {
            return null;
        }
        const target = {
            port: Number(g.port) || 4001,
            baud: Number(g.baud) || 2400,
            parity: String(g.parity || "E"),
        };
        const want = `${target.baud} 8${target.parity}1`;
        if (/TCP Server/i.test(check.mode) && check.serial === want) {
            return null;
        }
        const st = this.store.state;
        st.fw = st.fw || {};
        const key = `${c.clientId}:${g.id}`;
        const f = st.fw[key] || {};
        if (f.setupFailedAt && this.now() - f.setupFailedAt < 6 * 3600 * 1000) {
            return null;
        }
        this.log.info(
            `Moxa ${g.name}: Betriebsart ${check.mode}, seriell ${check.serial}, nötig TCP Server Mode, ${want}: wird eingerichtet`,
        );
        const res = await this.updater.configure(g, target);
        st.fw[key] = {
            ...(st.fw[key] || {}),
            setupFailedAt: res.ok ? 0 : this.now(),
        };
        this.store.saveState();
        if (res.ok) {
            this.log.info(`Moxa ${g.name}: ${res.note}`);
            // the first scan could not run before: do it now, not after the hourly retry
            delete c.scanTried[String(g.id)];
        } else {
            this.log.warn(
                `Moxa ${g.name}: Einrichtung fehlgeschlagen: ${res.note}`,
            );
        }
        return res;
    }

    /**
     * The note of a firmware check with the operating mode of the Moxa appended (kept short for the server).
     *
     * @param {{ note: string, mode?: string|null, serial?: string|null }} check
     */
    withMode(check) {
        const extra = [
            check.mode ? `Betriebsart ${check.mode}` : "",
            check.serial ? `seriell ${check.serial}` : "",
        ].filter(Boolean);
        return extra.length
            ? `${check.note} ${extra.join(", ")}.`.slice(0, 280)
            : check.note;
    }

    /**
     * @param {MbusManager["clients"][number]} c @param {object} report
     * @param report
     */
    queueMoxa(c, report) {
        this.store.enqueue({
            _c: c.label,
            schema: SCHEMA,
            adapter_version: this.version,
            gateways: [],
            moxa: [report],
        });
    }

    /**
     * Weekly look at the firmware; flashes in the quiet window when the web application allows it
     * (fw_auto) and the last attempt did not fail recently.
     *
     * @param {MbusManager["clients"][number]} c
     * @param {any} g
     */
    async maybeFirmware(c, g) {
        if (
            !this.updater ||
            this.stopped ||
            !g.host ||
            (!this.moxaPassword(c.label, g.id) && !this.updater.password)
        ) {
            return;
        }
        const st = this.store.state;
        const f = (st.fw && st.fw[`${c.clientId}:${g.id}`]) || {};
        // a check that could not tell (unknown, error) is repeated after half an hour, a clear one after a week
        const retryOpen = f.status === "unbekannt" || f.status === "fehler";
        // a gateway that does not answer is looked at every half hour as well: its mode may be wrong
        const down = !!(
            /** @type {any} */ (c).down &&
            /** @type {any} */ (c).down[String(g.id)]
        );
        const due =
            !f.checkedAt ||
            this.now() - f.checkedAt >=
                (retryOpen || down ? 30 * 60 * 1000 : FW_CHECK_EVERY_MS);
        const m = this.localMinutes();
        const inWindow = m >= FW_WINDOW.from && m <= FW_WINDOW.to;
        const blocked =
            f.failedAt && this.now() - f.failedAt < FW_RETRY_AFTER_FAILURE_MS;
        if (f.pending && g.fw_auto && inWindow && !blocked) {
            await this.firmware(c, g, true);
        } else if (
            due &&
            (!f.checkedAt ||
                inWindow ||
                this.now() - f.checkedAt >= FW_CHECK_EVERY_MS)
        ) {
            // looking is harmless at any time; flashing only happens in the window
            await this.firmware(c, g, g.fw_auto && inWindow && !blocked);
        }
    }

    // ------------------------------------------------------------------ delivery

    /**
     * Settings changed in ioBroker: sent on the next pass. @param {string} label @param {Record<string, number|boolean|string>} change
     *
     * @param label
     * @param change
     */
    changeSettings(label, change) {
        const c = this.clients.find((x) => x.label === label);
        if (c) {
            c.settingsChange = { ...(c.settingsChange || {}), ...change };
        }
    }

    /** Delivers the pending batches in order; a batch that fails for a transient reason stays and ends the pass. */
    async flush() {
        const c = this.clients.find((x) => !x.authFailed) || this.clients[0];
        if (!c || this.clients.length === 0) {
            return 0;
        }
        let sent = 0;
        while (
            this.store.pending.length > 0 &&
            sent < MAX_FLUSH_PER_TICK &&
            !this.stopped
        ) {
            const batch = this.store.pending[0];
            const client = this.clientForBatch(batch) || c;
            const r = await client.api.mbusIngest(batch);
            if (r.ok) {
                this.store.shift(1);
                sent++;
                continue;
            }
            if (r.kind === "rejected") {
                this.log.error(
                    `M-Bus: Lieferung vom Server abgelehnt (${r.message}${r.details.length ? `: ${r.details.slice(0, 2).join(" | ")}` : ""}), verworfen`,
                );
                this.store.reject(
                    batch,
                    `${r.message} ${r.details.join(" | ")}`,
                );
                this.store.shift(1);
                continue;
            }
            this.log.warn(
                `M-Bus: Lieferung zurückgestellt (${r.message}), ${this.store.pending.length} Paket(e) warten`,
            );
            break;
        }
        const first = this.clients[0];
        if (first) {
            await this.setState(
                `mbus.${safe(first.label)}.info.pending`,
                this.store.pending.length,
                "Nicht gelieferte Pakete",
            );
        }
        return sent;
    }

    /**
     * A batch carries the label of the client it belongs to (_c); the server ignores that field. @param {any} batch
     *
     * @param batch
     */
    clientForBatch(batch) {
        return (
            this.clients.find((cl) => cl.label === batch._c) ||
            (this.clients.length === 1 ? this.clients[0] : null)
        );
    }
}

module.exports = { MbusManager, safe };
