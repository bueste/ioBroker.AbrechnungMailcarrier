"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = require("chai");
const { MbusManager } = require("../../lib/mbus/manager");
const { Store } = require("../../lib/mbus/store");
const { startSegment } = require("../helpers/segment");

const HOTWATER =
    "684C4C680865724788845474264A062A0000000C7847888454046D390C583B0413786D0300026C7E364413864E0300426C5E368401131AF0020082016C3E360223800FC2026CFA1B01FD170209FD0E14DE16";
const COLDWATER =
    "684C4C6808C97219898454742649072C0000000C7819898454046D080D583B04130F6C0600026C7E36441334240600426C5E36840113BB75050082016C3E360223810FC2026CFB1B01FD170209FD0E140516";

const ok = (data) => ({ ok: true, status: 200, kind: "ok", message: "ok", details: [], data });
const fail = (kind, message = "x", details = []) => ({ ok: false, status: kind === "auth" ? 401 : 500, kind, message, details, data: null });

/** In-memory stand-in for the web app's M-Bus API. */
function fakeApi(state) {
    return {
        async mbusConfig() {
            return state.cfgFail ? fail(state.cfgFail) : ok(state.cfg);
        },
        async mbusIngest(payload) {
            state.ingests.push(payload);
            if (state.ingestFail) {
                return fail(state.ingestFail, "Fehler", state.details || []);
            }
            return ok({ ok: true, settings: "angenommen" });
        },
    };
}

function config(port, meters, extra = {}) {
    return {
        ok: true,
        client: { id: 5, name: "Testhaus" },
        settings: { version: 3, scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false },
        gateways: [{ id: 1, name: "Keller", host: "127.0.0.1", port, enabled: true, scan_due: false, meters }],
        units: [{ name: "WHG 1", label: null, billable: true, active: true }],
        commands: [],
        alarms: [],
        ...extra,
    };
}

const expectedMeters = [
    { id: "54848847", primary: 101, medium: 6, kind: "warmwasser", unit: "WHG 1", status: "aktiv" },
    { id: "54848919", primary: 201, medium: 7, kind: "kaltwasser", unit: "WHG 1", status: "aktiv" },
];

describe("MbusManager", () => {
    let seg;
    let dir;
    let mgr;
    let clock;
    let states;
    let state;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbus-"));
        seg = await startSegment([
            { addr: 101, frames: [Buffer.from(HOTWATER, "hex")], acceptsClock: true },
            { addr: 201, frames: [Buffer.from(COLDWATER, "hex")] },
        ]);
        clock = new Date(2026, 10, 24, 20, 30, 0).getTime();
        states = {};
        state = { cfg: config(seg.port, expectedMeters), ingests: [] };
        mgr = new MbusManager({
            log: { info() {}, warn() {}, error() {}, debug() {} },
            clients: [{ label: "haus", api: fakeApi(state) }],
            store: new Store(dir),
            version: "test",
            setState: async (id, v) => {
                states[id] = v;
            },
            now: () => clock,
            busOptions: { ackWaitMs: 60, dataWaitMs: 200, connectTimeoutMs: 500, afterSetMs: 10, guardMs: 5 },
            scanRange: [99, 103],
        });
        mgr.store.init();
    });

    afterEach(async () => {
        mgr.stop();
        await new Promise((r) => seg.server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("polls the expected meters, archives, delivers and writes the states", async () => {
        await mgr.tick();
        expect(state.ingests).to.have.length(1);
        const gw = state.ingests[0].gateways[0];
        expect(gw).to.include({ id: 1, reachable: true, complete: true, scan: false });
        expect(gw.meters.map((m) => [m.id, m.primary, m.value, m.unit])).to.deep.equal([
            ["54848847", 101, 224.632, "m3"],
            ["54848919", 201, 420.879, "m3"],
        ]);
        expect(state.ingests[0]._c).to.equal("haus");
        expect(mgr.store.pending).to.have.length(0);
        const archive = fs.readdirSync(path.join(dir, "archive"));
        expect(archive).to.deep.equal(["mbus-2026-11.jsonl"]);
        const rows = fs.readFileSync(path.join(dir, "archive", archive[0]), "utf8").trim().split("\n");
        expect(rows).to.have.length(2);
        expect(states["mbus.haus.units.WHG_1.warmwasser.value"]).to.equal(224.632);
        expect(states["mbus.haus.units.WHG_1.kaltwasser.unit"]).to.equal("m3");
        expect(states["mbus.haus.gateways.1.reachable"]).to.equal(true);
        expect(states["mbus.haus.settings.readMinutes"]).to.equal(15);
    });

    it("polls once per interval slot, not on every pass", async () => {
        await mgr.tick();
        await mgr.tick();
        expect(state.ingests).to.have.length(1);
        clock += 15 * 60000;
        await mgr.tick();
        expect(state.ingests).to.have.length(2);
    });

    it("scans when the server says a scan is due and reports the meters it found", async () => {
        state.cfg = config(seg.port, [], {});
        state.cfg.gateways[0].scan_due = true;
        await mgr.tick();
        const gw = state.ingests[0].gateways[0];
        expect(gw.scan).to.equal(true);
        expect(gw.meters.map((m) => m.id)).to.deep.equal(["54848847"]); // the scan range of the test covers address 101 only
    });

    it("keeps everything when the server is down and delivers it in order afterwards", async () => {
        state.ingestFail = "transient";
        await mgr.tick();
        clock += 15 * 60000;
        await mgr.tick();
        expect(mgr.store.pending).to.have.length(2);
        expect(fs.readFileSync(path.join(dir, "pending.jsonl"), "utf8").trim().split("\n")).to.have.length(2);
        state.ingestFail = null;
        state.ingests.length = 0;
        await mgr.flush();
        expect(mgr.store.pending).to.have.length(0);
        expect(state.ingests.map((p) => p.gateways[0].polled_at)).to.deep.equal([...state.ingests.map((p) => p.gateways[0].polled_at)].sort());
        expect(state.ingests).to.have.length(2);
    });

    it("survives a restart: pending batches are read back from disk", async () => {
        state.ingestFail = "transient";
        await mgr.tick();
        const again = new Store(dir);
        again.init();
        expect(again.pending).to.have.length(1);
    });

    it("drops a batch the server refuses for good, but keeps a copy", async () => {
        state.ingestFail = "rejected";
        state.details = ["gateways[0]: unbekannter Moxa."];
        await mgr.tick();
        expect(mgr.store.pending).to.have.length(0);
        expect(fs.readFileSync(path.join(dir, "rejected.jsonl"), "utf8")).to.contain("unbekannter Moxa");
    });

    it("reports a Moxa that cannot be reached", async () => {
        const port = seg.port;
        await new Promise((r) => seg.server.close(r));
        state.cfg = config(port, expectedMeters);
        await mgr.tick();
        const gw = state.ingests[0].gateways[0];
        expect(gw.reachable).to.equal(false);
        expect(gw.error).to.contain("127.0.0.1");
        expect(states["mbus.haus.gateways.1.reachable"]).to.equal(false);
        seg = await startSegment([]); // so the afterEach has something to close
    });

    it("runs the connection test the web app queued and returns the result once", async () => {
        state.cfg = config(seg.port, expectedMeters, { commands: [{ id: 7, gateway_id: 1, type: "test", params: null }] });
        await mgr.tick();
        const withCmd = state.ingests.find((p) => p.commands && p.commands.length);
        expect(withCmd.commands[0]).to.include({ id: 7, ok: true });
        expect(withCmd.commands[0].result.summary).to.contain("2 von 2");
        // the server has not noticed yet: the same command comes again, but it must not run twice
        state.ingests.length = 0;
        clock += 60000;
        await mgr.tick();
        expect(state.ingests.filter((p) => p.commands && p.commands.length)).to.have.length(0);
    });

    it("reports a meter that does not take the clock, and does not claim success when the clock stays", async () => {
        state.cfg = config(seg.port, expectedMeters, { commands: [{ id: 9, gateway_id: 1, type: "timesync", params: { all: true } }] });
        await mgr.tick();
        const res = state.ingests.find((p) => p.commands && p.commands.length).commands[0];
        expect(res.ok).to.equal(false);
        expect(res.result.summary).to.contain("lehnt ab");
        expect(res.result.summary).to.contain("Uhr unverändert");
    });

    it("sends a settings change made in ioBroker with the base version", async () => {
        await mgr.tick();
        state.ingests.length = 0;
        mgr.changeSettings("haus", { read_minutes: 20 });
        clock += 60000;
        await mgr.tick();
        const change = state.ingests.find((p) => p.settings);
        expect(change.settings).to.deep.equal({ base_version: 3, read_minutes: 20 });
    });

    it("stops and reports when the token is refused", async () => {
        state.cfgFail = "auth";
        state.cfg = null;
        await mgr.tick();
        expect(state.ingests).to.have.length(0);
        expect(states["mbus.haus.info.connection"]).to.equal(false);
    });
});
