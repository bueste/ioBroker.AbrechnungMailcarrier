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
    }

    async onReady() {
        await this.setState("info.connection", false, true);

        const { baseUrl, error } = buildBaseUrl(this.config);
        const token = String(this.config.apiToken || "").trim();
        if (error || !token) {
            this.log.error(
                `${error || "API token missing."} Please check server and API token in the instance configuration.`,
            );
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
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
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
