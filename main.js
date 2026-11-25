"use strict";

const utils = require("@iobroker/adapter-core");
const { ApiClient } = require("./lib/api");
const { closeDay, parseCounterConfig } = require("./lib/counters");
const { localDate, parseTime, msUntil } = require("./lib/dates");
const { createDelivery } = require("./lib/delivery");
const {
    mergeDays,
    parseJournal,
    parseSolarlogJournal,
    serializeJournal,
} = require("./lib/days");
const { applyUnitMap, buildBaseUrl } = require("./lib/config");
const { MbusManager } = require("./lib/mbus/manager");
const { MoxaUpdater } = require("./lib/moxa/updater");
const { RouterUpdater } = require("./lib/mikrotik/updater");
const { ensureKey } = require("./lib/mikrotik/ssh");
const { Store } = require("./lib/mbus/store");
const { ComMounts } = require("./lib/mbus/commount");
const pkg = require("./package.json");

/** Retry delay after a network or server problem. */
const RETRY_MS = 10 * 60 * 1000;
/**
 * Even when nothing is new, the server is asked this often what it lacks (gap repair, restored database). The
 * request is also the sign of life both sides watch: the server alarms after 2 hours without contact, the
 * monitoring on the ioBroker side after 1 hour.
 */
const HEARTBEAT_MS = 10 * 60 * 1000;
/** A change of the source journal is delivered after this pause, so several changes lead to one request. */
const DEBOUNCE_MS = 5000;

/** @param {any} v a table of the instance configuration @returns {any[]} */
function asRows(v) {
    return Array.isArray(v) ? v.filter((r) => r && typeof r === "object") : [];
}

class AbrechnungMailcarrier extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({ ...options, name: "abrechnungmailcarrier" });

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));

        /** @type {ApiClient|null} */
        this.api = null;
        /** @type {ReturnType<typeof createDelivery>|null} */
        this.delivery = null;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        this.syncTimer = undefined;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        this.closeTimer = undefined;
        this.unloading = false;
        this.sourceType = "solarlogJournal";
        this.journalStateId = "";
        /** @type {ReturnType<typeof parseCounterConfig>["config"]|null} */
        this.counterConfig = null;
        this.snapshotTime = { hour: 23, minute: 58 };
        /** @type {MbusManager|null} */
        this.mbus = null;
        /** @type {Set<string>} */
        this.mbusObjects = new Set();
    }

    async onReady() {
        await this.setState("info.connection", false, true);

        const { baseUrl, error } = buildBaseUrl(this.config);
        const token = String(this.config.apiToken || "").trim();
        const mbusOn = this.config.mbusEnabled === true;
        if (mbusOn) {
            // the meter reading runs on its own, with or without the solar delivery below
            await this.startMbus(baseUrl, error);
        }
        if (error || !token) {
            if (!mbusOn) {
                this.log.error(
                    `${error || "API token missing."} Please check server and API token in the instance configuration.`,
                );
            } else {
                this.log.info(
                    "No token for the solar delivery configured: only the M-Bus meter reading runs.",
                );
            }
            return;
        }
        this.api = new ApiClient({
            baseUrl,
            token,
            userAgent: `iobroker.abrechnungmailcarrier/${pkg.version}`,
        });
        this.sourceType =
            this.config.sourceType === "counters"
                ? "counters"
                : "solarlogJournal";

        if (this.sourceType === "solarlogJournal") {
            this.journalStateId = String(
                this.config.journalStateId || "",
            ).trim();
            if (!this.journalStateId) {
                this.log.error(
                    "No journal state configured (source: iobroker.solarlog). Please set it in the instance configuration.",
                );
                return;
            }
            await this.subscribeForeignStatesAsync(this.journalStateId);
        } else {
            const parsed = parseCounterConfig(this.config);
            parsed.errors.forEach((e) => this.log.error(e));
            if (
                parsed.errors.length > 0 ||
                parsed.config.meters.length === 0 ||
                parsed.config.production.length === 0
            ) {
                this.log.error(
                    "Source 'counters' needs at least one unit and one production state. Please complete the instance configuration.",
                );
                return;
            }
            this.counterConfig = parsed.config;
            this.snapshotTime =
                parseTime(this.config.snapshotTime) || this.snapshotTime;
            this.scheduleClose();
        }

        this.delivery = createDelivery({
            log: this.log,
            api: this.api,
            loadJournal: () => this.loadJournal(),
            setInfo: (info) => this.setInfo(info),
            today: () => localDate(new Date()),
            version: pkg.version,
            source:
                this.sourceType === "counters"
                    ? "iobroker-counters"
                    : "iobroker-solarlog",
        });

        await this.subscribeStatesAsync("control.*");
        this.log.info(`Started: source ${this.sourceType}, API ${baseUrl}`);
        this.scheduleSync(10 * 1000);
    }

    // ------------------------------------------------------------------ M-Bus

    /**
     * Starts the M-Bus meter reading: one API token per client (up to four), the configuration comes from the web
     * application, the readings go to disk first and then to the server.
     *
     * @param {string} baseUrl
     * @param {string} error
     */
    async startMbus(baseUrl, error) {
        const clients = [];
        for (let i = 1; i <= 4; i++) {
            const t = String(this.config[`mbusToken${i}`] || "").trim();
            if (t && !error) {
                clients.push({
                    label: `a${i}`,
                    api: new ApiClient({
                        baseUrl,
                        token: t,
                        userAgent: `iobroker.abrechnungmailcarrier/${pkg.version} mbus`,
                    }),
                });
            }
        }
        if (clients.length === 0) {
            this.log.error(
                `${error || "No M-Bus token entered."} Please check server and the M-Bus tokens in the instance configuration.`,
            );
            return;
        }
        this.mbusObjects = new Set();
        const dir = utils.getAbsoluteInstanceDataDir(this);
        // the virtual COM ports get a short path next to the data folder (/opt/iobroker/com/a1-moxa-21) when it can
        // be created there, otherwise inside the data folder of the instance
        let comRoot = dir;
        try {
            const parent = require("node:path").dirname(
                utils.getAbsoluteDefaultDataDir(),
            );
            require("node:fs").mkdirSync(
                require("node:path").join(parent, "com"),
                {
                    recursive: true,
                },
            );
            comRoot = parent;
        } catch {
            // keep the data folder of the instance
        }
        // the web console password of each Moxa is entered in its table row; plain entries are encrypted here
        const moxaRows = asRows(this.config.mbusMoxas);
        let encrypted = false;
        for (const row of moxaRows) {
            const p = String(row.password || "");
            if (p && !p.startsWith("enc:")) {
                row.password = `enc:${this.encrypt(p)}`;
                encrypted = true;
            }
        }
        if (encrypted) {
            this.config.mbusMoxas = moxaRows;
            await this.extendForeignObjectAsync(
                `system.adapter.${this.namespace}`,
                { native: { mbusMoxas: moxaRows } },
            );
        }
        const moxaPassword = (
            /** @type {string} */ label,
            /** @type {number} */ id,
        ) => {
            const row = asRows(this.config.mbusMoxas).find(
                (x) =>
                    String(x.site) === String(label).slice(1) &&
                    Number(x.id) === Number(id),
            );
            const p = String((row && row.password) || "");
            if (!p) {
                return "";
            }
            try {
                return p.startsWith("enc:") ? this.decrypt(p.slice(4)) : p;
            } catch {
                return "";
            }
        };
        const sshKey = await ensureKey(dir);
        if (!sshKey.ok) {
            this.log.warn(
                `No SSH key for the MikroTik routers (${sshKey.error}): router updates are off.`,
            );
        }
        this.mbus = new MbusManager({
            log: this.log,
            clients,
            routerUpdater: sshKey.ok
                ? new RouterUpdater({ log: this.log, dir })
                : null,
            sshPublicKey: sshKey.ok ? sshKey.publicKey : null,
            updater: new MoxaUpdater({
                log: this.log,
                password: String(this.config.moxaPassword || "").trim(),
                dir,
            }),
            moxaPassword,
            reportConnection: !String(this.config.apiToken || "").trim(),
            moxaSecondary: (label, id) => {
                const row = asRows(this.config.mbusMoxas).find(
                    (x) =>
                        String(x.site) === String(label).slice(1) &&
                        Number(x.id) === Number(id),
                );
                return String((row && row.secondary) || "")
                    .split(/[s,;]+/)
                    .filter((x) => /^d{8}$/.test(x));
            },
            moxaSetup: (label, id) => {
                const row = asRows(this.config.mbusMoxas).find(
                    (x) =>
                        String(x.site) === String(label).slice(1) &&
                        Number(x.id) === Number(id),
                );
                return !row || row.setup !== false;
            },
            comMounts: new ComMounts({
                log: this.log,
                dir: comRoot,
                onChange: async (label, id, file) => {
                    await this.mbusSetState(
                        `mbus.${label}.gateways.${id}.comPort`,
                        file,
                        "COM-Port (eingebunden, leer = nicht eingebunden)",
                    );
                    await this.mbusSetState(
                        `mbus.${label}.gateways.${id}.comPortUp`,
                        file !== "",
                        "COM-Port eingebunden",
                    );
                },
            }),
            store: new Store(dir),
            version: pkg.version,
            setState: (id, val, name, write) =>
                this.mbusSetState(id, val, name, write),
            tables: {
                read: () => ({
                    moxas: asRows(this.config.mbusMoxas),
                    units: asRows(this.config.mbusUnits),
                    routers: asRows(this.config.mbusRouters),
                    meters: asRows(this.config.mbusMeters),
                    settings: asRows(this.config.mbusSettings),
                }),
                write: async (t) => {
                    this.config.mbusMoxas = t.moxas;
                    await this.extendForeignObjectAsync(
                        `system.adapter.${this.namespace}`,
                        {
                            native: {
                                mbusMoxas: t.moxas,
                                mbusUnits: t.units,
                                mbusRouters: t.routers,
                                mbusMeters: t.meters || [],
                                mbusSettings: t.settings || [],
                            },
                        },
                    );
                },
            },
        });
        await this.subscribeStatesAsync("mbus.*.settings.*");
        this.mbus.start();
        this.log.info(`M-Bus: ${clients.length} client(s), data in ${dir}`);
    }

    /**
     * Writes a state of the M-Bus tree, creating the object on first use.
     *
     * @param {string} id
     * @param {any} val
     * @param {string} [name]
     * @param {boolean} [write]
     */
    async mbusSetState(id, val, name, write) {
        if (val === null || val === undefined || this.unloading) {
            return;
        }
        if (!this.mbusObjects.has(id)) {
            await this.setObjectNotExistsAsync(id, {
                type: "state",
                common: {
                    name: name || id,
                    type:
                        typeof val === "number"
                            ? "number"
                            : typeof val === "boolean"
                              ? "boolean"
                              : "string",
                    role: "state",
                    read: true,
                    write: write === true,
                },
                native: {},
            });
            this.mbusObjects.add(id);
        }
        await this.setState(id, val, true);
    }

    /**
     * Readable status of the M-Bus side for the button in the configuration: server contact, every Moxa
     * (connection, COM port, firmware, operating mode) and every router, from the states of the instance.
     *
     * @returns {Promise<string>}
     */
    async mbusStatusText() {
        if (this.config.mbusEnabled !== true) {
            return "M-Bus ist ausgeschaltet.";
        }
        const states = await this.getStatesAsync("mbus.*");
        const ns = `${this.namespace}.`;
        /** @type {Record<string, any>} */
        const v = {};
        for (const [id, st] of Object.entries(states || {})) {
            if (st && st.val !== null && st.val !== undefined) {
                v[id.startsWith(ns) ? id.slice(ns.length) : id] = st.val;
            }
        }
        const lines = [];
        for (const a of ["a1", "a2", "a3", "a4"]) {
            const conn = v[`mbus.${a}.info.connection`];
            if (conn === undefined) {
                continue;
            }
            lines.push(
                `Anlage ${a}: ${v[`mbus.${a}.info.client`] || "?"}, Server ${conn ? "erreichbar" : "NICHT erreichbar"}, offene Befunde ${v[`mbus.${a}.alarms.count`] ?? "?"}`,
            );
            const ids = new Set();
            for (const k of Object.keys(v)) {
                const m = new RegExp(
                    `^mbus\\.${a}\\.gateways\\.(\\d+)\\.`,
                ).exec(k);
                if (m) {
                    ids.add(m[1]);
                }
            }
            for (const id of ids) {
                const g = (/** @type {string} */ f) =>
                    v[`mbus.${a}.gateways.${id}.${f}`];
                lines.push(
                    `  Moxa ${id} "${g("name") || ""}" ${g("address") || ""}`,
                );
                lines.push(
                    `    Verbindung: ${g("reachable") === undefined ? "noch nicht abgefragt" : g("reachable") ? "erreichbar" : `NICHT erreichbar (${g("lastError") || "?"})`}`,
                );
                const mounts = this.mbus && this.mbus.mounts;
                const comFile = mounts
                    ? mounts.file(a, Number(id))
                    : g("comPort") || "";
                lines.push(
                    g("comPort")
                        ? `    COM-Port: EINGEBUNDEN, ${g("comPort")}`
                        : `    COM-Port: NICHT EINGEBUNDEN (vorgesehen: ${comFile || "-"})`,
                );
                lines.push(
                    `    Letzte Abfrage: ${g("lastPoll") || "-"}, Zähler: ${g("meters") ?? "-"}`,
                );
                lines.push(
                    `    Firmware: ${g("moxaModel") ? `${g("moxaModel")} ${g("moxaFirmware") || "?"} (${g("moxaFirmwareStatus") || "?"})` : "noch nicht gelesen"}${g("moxaNote") ? `, ${g("moxaNote")}` : ""}`,
                );
                if (g("moxaMode")) {
                    const ok = /TCP Server/i.test(String(g("moxaMode")));
                    lines.push(
                        `    Betriebsart: ${g("moxaMode")}, seriell ${g("moxaSerial") || "?"}${ok ? "" : "  <- für den M-Bus nötig: TCP Server Mode (Raw), 2400 8E1"}`,
                    );
                }
            }
        }
        for (const k of Object.keys(v)) {
            const m = /^mbus\.(a\d)\.routers\.(\d+)\.status$/.exec(k);
            if (m) {
                lines.push(
                    `Router ${m[2]} (${m[1]}): ${v[k]}, Version ${v[`mbus.${m[1]}.routers.${m[2]}.version`] || "?"}, neueste ${v[`mbus.${m[1]}.routers.${m[2]}.latest`] || "?"}`,
                );
            }
        }
        return lines.length
            ? lines.join("\n")
            : "Noch keine Daten, der erste Abgleich läuft gerade.";
    }

    // ------------------------------------------------------------------ local state

    /** @returns {Promise<import("./lib/days").DayRecord[]>} */
    async loadJournal() {
        const st = await this.getStateAsync("data.journal");
        return parseJournal(st && typeof st.val === "string" ? st.val : null);
    }

    /** @param {import("./lib/days").DayRecord[]} days */
    async saveJournal(days) {
        await this.setState("data.journal", serializeJournal(days), true);
    }

    /** @param {Record<string, any>} info */
    async setInfo(info) {
        if (info.connection !== undefined) {
            await this.setState("info.connection", info.connection, true);
        }
        if (info.lastContact !== undefined) {
            await this.setState("info.lastContact", info.lastContact, true);
        }
        if (info.lastDelivery !== undefined) {
            await this.setState("info.lastDelivery", info.lastDelivery, true);
        }
        if (info.lastDeliveredDate !== undefined) {
            await this.setState(
                "info.lastDeliveredDate",
                info.lastDeliveredDate,
                true,
            );
        }
        if (info.pendingDays !== undefined) {
            await this.setState("info.pendingDays", info.pendingDays, true);
        }
        if (info.lastError !== undefined) {
            await this.setState("info.lastError", info.lastError, true);
        }
        if (info.rejectedDates !== undefined) {
            await this.setState(
                "info.rejectedDates",
                info.rejectedDates.join(", "),
                true,
            );
        }
    }

    // ------------------------------------------------------------------ sources

    /** Copies the days of the solarlog journal into the own journal. */
    async importSolarlogJournal() {
        const st = await this.getForeignStateAsync(this.journalStateId);
        if (!st || typeof st.val !== "string") {
            this.log.warn(
                `State ${this.journalStateId} does not exist or is empty - nothing to import (is the solarlog adapter set to write the local journal?)`,
            );
            return;
        }
        const { days, skipped } = parseSolarlogJournal(st.val);
        skipped.forEach((s) => this.log.warn(`Journal entry skipped: ${s}`));
        const own = await this.loadJournal();
        const merged = mergeDays(own, applyUnitMap(days, this.config.unitMap));
        if (JSON.stringify(merged) !== JSON.stringify(own)) {
            await this.saveJournal(merged);
            this.log.debug(`Journal now holds ${merged.length} day(s)`);
        }
    }

    /** Closes today for the "counters" source. */
    async closeToday() {
        if (!this.counterConfig) {
            return;
        }
        const date = localDate(new Date());
        const snapRaw = await this.getStateAsync("data.snapshot");
        let snapshot = null;
        try {
            snapshot =
                snapRaw && typeof snapRaw.val === "string"
                    ? JSON.parse(snapRaw.val)
                    : null;
        } catch {
            snapshot = null;
        }
        const cfg = this.counterConfig;
        const ids = [...cfg.meters, ...cfg.production, ...cfg.feedin].map(
            (s) => s.stateId,
        );
        /** @type {Record<string, ioBroker.State|null|undefined>} */
        const states = {};
        for (const id of new Set(ids)) {
            states[id] = await this.getForeignStateAsync(id);
        }
        const res = closeDay({
            date,
            config: cfg,
            getState: (id) => states[id],
            snapshot,
            nowMs: Date.now(),
        });
        res.warnings.forEach((w) => this.log.warn(`${date}: ${w}`));
        await this.setState(
            "data.snapshot",
            JSON.stringify(res.snapshot),
            true,
        );
        if (res.day) {
            await this.saveJournal(
                mergeDays(await this.loadJournal(), [res.day]),
            );
            this.log.info(
                `${date}: day closed (${res.day.meters.length} unit(s), quality ${res.day.quality})`,
            );
        } else {
            this.log.warn(`${date}: no day record could be built`);
        }
    }

    // ------------------------------------------------------------------ scheduling

    scheduleClose() {
        if (this.unloading) {
            return;
        }
        const wait = msUntil(
            new Date(),
            this.snapshotTime.hour,
            this.snapshotTime.minute,
        );
        this.closeTimer = setTimeout(async () => {
            try {
                await this.closeToday();
            } catch (e) {
                this.log.error(`Closing the day failed: ${e && e.message}`);
            }
            this.scheduleClose();
            this.scheduleSync(2000);
        }, wait);
    }

    /** @param {number} delayMs */
    scheduleSync(delayMs) {
        if (this.unloading) {
            return;
        }
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
        }
        this.syncTimer = setTimeout(() => this.runSync(), delayMs);
    }

    async runSync() {
        let next = HEARTBEAT_MS;
        try {
            if (this.sourceType === "solarlogJournal") {
                await this.importSolarlogJournal();
            }
            const res = this.delivery ? await this.delivery.sync() : null;
            if (res && res.retrySoon) {
                next = RETRY_MS;
            }
        } catch (e) {
            this.log.error(`Synchronisation failed: ${e && e.message}`);
            next = RETRY_MS;
        }
        this.scheduleSync(next);
    }

    // ------------------------------------------------------------------ events

    /**
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (this.mbus && id.startsWith(`${this.namespace}.mbus.`)) {
            this.onMbusSettingChange(id, state);
            return;
        }
        if (id === this.journalStateId) {
            this.scheduleSync(DEBOUNCE_MS);
            return;
        }
        if (state.ack) {
            return;
        }
        if (id === `${this.namespace}.control.syncNow` && state.val) {
            this.scheduleSync(100);
            this.setState("control.syncNow", false, true);
        } else if (
            id === `${this.namespace}.control.closeDayNow` &&
            state.val
        ) {
            this.setState("control.closeDayNow", false, true);
            if (this.sourceType === "counters") {
                this.closeToday()
                    .then(() => this.scheduleSync(100))
                    .catch((e) =>
                        this.log.error(
                            `Closing the day failed: ${e && e.message}`,
                        ),
                    );
            }
        }
    }

    /**
     * A user changed an interval in the M-Bus tree: it is reported to the web application, which keeps the leading
     * copy (and refuses it if somebody changed it there in the meantime).
     *
     * @param {string} id
     * @param {ioBroker.State} state
     */
    onMbusSettingChange(id, state) {
        if (state.ack) {
            return;
        }
        const m =
            /\.mbus\.([^.]+)\.settings\.(readMinutes|scanDays|timesyncDays|timesyncEnabled|readMode|stichtagDay|stichtagTime)$/.exec(
                id,
            );
        if (!m) {
            return;
        }
        const keys = {
            readMinutes: "read_minutes",
            scanDays: "scan_days",
            timesyncDays: "timesync_days",
            timesyncEnabled: "timesync_enabled",
            readMode: "read_mode",
            stichtagDay: "stichtag_day",
            stichtagTime: "stichtag_time",
        };
        const val =
            m[2] === "timesyncEnabled"
                ? state.val === true
                : ["readMode", "stichtagDay", "stichtagTime"].includes(m[2])
                  ? String(state.val)
                  : Number(state.val);
        if (this.mbus) {
            this.mbus.changeSettings(m[1], { [keys[m[2]]]: val });
        }
        this.log.info(
            `M-Bus ${m[1]}: ${m[2]} = ${val} will be sent to the server`,
        );
    }

    /**
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        if (obj && obj.command === "mbusStatus") {
            const text = await this.mbusStatusText();
            if (obj.callback) {
                this.sendTo(
                    obj.from,
                    obj.command,
                    { result: text },
                    obj.callback,
                );
            }
            return;
        }
        if (!obj || obj.command !== "testConnection") {
            return;
        }
        const msg = obj.message || {};
        const { baseUrl, error } = buildBaseUrl(msg);
        // the token field of the form is only filled when it was just typed; otherwise the saved one is used
        const token = String(msg.apiToken || this.config.apiToken || "").trim();
        let res;
        if (error || !token) {
            res = {
                ok: false,
                kind: "config",
                message: error || "No API token entered.",
            };
        } else {
            const client = new ApiClient({
                baseUrl,
                token,
                userAgent: `iobroker.abrechnungmailcarrier/${pkg.version}`,
            });
            res = await client.status();
        }
        let text;
        if (res.ok) {
            const c = res.data.client || {};
            text = `OK: ${c.name || "?"}, ${Array.isArray(res.data.units) ? res.data.units.length : 0} unit(s), up to ${c.max_units ?? "?"} apartments`;
        } else {
            text = `${res.kind === "auth" ? "Token rejected" : "Failed"}: ${res.message}`;
        }
        if (obj.callback) {
            this.sendTo(
                obj.from,
                obj.command,
                { error: res.ok ? undefined : text, result: text },
                obj.callback,
            );
        }
    }

    /** @param {() => void} callback */
    onUnload(callback) {
        try {
            this.unloading = true;
            if (this.mbus) {
                this.mbus.stop();
            }
            if (this.syncTimer) {
                clearTimeout(this.syncTimer);
            }
            if (this.closeTimer) {
                clearTimeout(this.closeTimer);
            }
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = (options) => new AbrechnungMailcarrier(options);
} else {
    // otherwise start the instance directly
    (() => new AbrechnungMailcarrier())();
}
