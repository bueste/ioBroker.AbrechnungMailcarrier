"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = require("chai");
const { MbusManager } = require("../../lib/mbus/manager");
const { Store } = require("../../lib/mbus/store");
const { startSegment } = require("../helpers/segment");

const ok = (data) => ({ ok: true, status: 200, kind: "ok", message: "ok", details: [], data });
const HOUR = 3600000;

describe("MbusManager: Moxa firmware care", () => {
    let seg;
    let dir;
    let mgr;
    let clock;
    let state;
    let calls;
    let updater;

    const config = (extra = {}) => ({
        ok: true,
        client: { id: 5, name: "Testhaus" },
        settings: { version: 1, scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false },
        gateways: [{ id: 1, name: "Keller", host: "127.0.0.1", port: seg.port, enabled: true, scan_due: false, fw_auto: true, meters: [] }],
        units: [],
        commands: [],
        alarms: [],
        ...extra,
    });
    const moxaReports = () => state.ingests.flatMap((p) => p.moxa || []);

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
        seg = await startSegment([]);
        clock = new Date(2026, 10, 24, 12, 0, 0).getTime();
        calls = { check: 0, update: 0 };
        updater = {
            outdated: true,
            updateOk: true,
            async check() {
                calls.check++;
                return this.outdated
                    ? { status: "veraltet", model: "NPort 5110", firmware: "2.9", latest: "2.11", updatable: true, note: "Firmware 2.9, neu ist 2.11" }
                    : { status: "aktuell", model: "NPort 5110", firmware: "2.11", latest: "2.11", updatable: false, note: "Firmware 2.11 ist aktuell." };
            },
            async update() {
                calls.update++;
                if (this.updateOk) {
                    this.outdated = false;
                    return { ok: true, status: "aktuell", from: "2.9", to: "2.11", note: "aktualisiert" };
                }
                return { ok: false, status: "fehler", note: "Moxa nach dem Update nicht erreichbar" };
            },
        };
        state = { cfg: config(), ingests: [] };
        mgr = new MbusManager({
            moxaPassword: () => "box-pw",
            log: { info() {}, warn() {}, error() {}, debug() {} },
            clients: [
                {
                    label: "a1",
                    api: {
                        mbusConfig: async () => ok(state.cfg),
                        mbusIngest: async (p) => {
                            state.ingests.push(p);
                            return ok({ ok: true });
                        },
                    },
                },
            ],
            store: new Store(dir),
            version: "test",
            setState: async () => {},
            now: () => clock,
            busOptions: { ackWaitMs: 40, dataWaitMs: 100, connectTimeoutMs: 300 },
            updater,
        });
        mgr.store.init();
    });
    afterEach(async () => {
        mgr.stop();
        await new Promise((r) => seg.server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("looks at the firmware at the first run, at any time of day, but does not flash outside the window", async () => {
        await mgr.tick();
        expect(calls).to.deep.equal({ check: 1, update: 0 });
        expect(moxaReports()).to.have.length(1);
        expect(moxaReports()[0]).to.include({ gateway_id: 1, status: "veraltet", firmware: "2.9", latest: "2.11" });
    });

    it("flashes in the night window when the web application allows it, and reports the result", async () => {
        await mgr.tick();
        clock = new Date(2026, 10, 25, 1, 30, 0).getTime();
        await mgr.tick();
        expect(calls.update).to.equal(1);
        const last = moxaReports().at(-1);
        expect(last).to.include({ status: "aktuell", firmware: "2.11" });
        expect(moxaReports().map((r) => r.status)).to.include("update_laeuft");
        // done: no second flash
        clock += HOUR;
        await mgr.tick();
        expect(calls.update).to.equal(1);
    });

    it("never flashes when the web application has switched the automatic update off", async () => {
        state.cfg = config();
        state.cfg.gateways[0].fw_auto = false;
        await mgr.tick();
        clock = new Date(2026, 10, 25, 1, 30, 0).getTime();
        await mgr.tick();
        expect(calls.update).to.equal(0);
        expect(moxaReports().at(-1).status).to.equal("veraltet");
    });

    it("does not retry a failed update every night, but after a week", async () => {
        updater.updateOk = false;
        await mgr.tick();
        clock = new Date(2026, 10, 25, 1, 30, 0).getTime();
        await mgr.tick();
        expect(calls.update).to.equal(1);
        expect(moxaReports().at(-1).status).to.equal("fehler");
        clock = new Date(2026, 10, 26, 1, 30, 0).getTime();
        await mgr.tick();
        expect(calls.update).to.equal(1);
        clock = new Date(2026, 11, 3, 1, 30, 0).getTime();
        await mgr.tick();
        expect(calls.update).to.equal(2);
    });

    it("checks again after a week", async () => {
        updater.outdated = false;
        await mgr.tick();
        clock += 3 * 86400000;
        await mgr.tick();
        expect(calls.check).to.equal(1);
        clock += 5 * 86400000;
        await mgr.tick();
        expect(calls.check).to.equal(2);
    });

    it("runs a manual update order at any time and returns the result as command result", async () => {
        state.cfg = config({ commands: [{ id: 21, gateway_id: 1, type: "fwupdate", params: null }] });
        await mgr.tick();
        expect(calls.update).to.equal(1);
        const cmd = state.ingests.find((p) => p.commands && p.commands.length).commands[0];
        expect(cmd).to.include({ id: 21, ok: true });
        expect(cmd.result.summary).to.contain("aktualisiert");
    });

    it("says so when the firmware care is not set up", async () => {
        mgr.updater = null;
        state.cfg = config({ commands: [{ id: 22, gateway_id: 1, type: "fwcheck", params: null }] });
        await mgr.tick();
        const cmd = state.ingests.find((p) => p.commands && p.commands.length).commands[0];
        expect(cmd.ok).to.equal(false);
        expect(cmd.result.summary).to.contain("nicht eingerichtet");
    });
});
