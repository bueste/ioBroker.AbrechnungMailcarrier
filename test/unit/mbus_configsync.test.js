"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = require("chai");
const sync = require("../../lib/mbus/configsync");
const { MbusManager } = require("../../lib/mbus/manager");
const { Store } = require("../../lib/mbus/store");
const { Bus } = require("../../lib/mbus/bus");

const gw = (id, name, host, extra = {}) => ({ id, name, host, port: 4001, device: null, baud: 2400, parity: "E", enabled: true, fw_auto: true, meters: [], ...extra });
const router = (id, name, host, extra = {}) => ({
    id, name, host, port: 22, ssh_user: "admin", channel: "stable", enabled: true, auto_update: true, routerboard_fw: false,
    upd_days: "0,6", upd_time: "03:30", upd_window_min: 90, ...extra,
});
const cfgOf = (o = {}) => ({ gateways: [], units: [], routers: [], ...o });
const empty = () => ({ moxas: [], units: [], routers: [] });

describe("configsync", () => {
    it("takes over the server rows when the instance has none yet", () => {
        const cfg = cfgOf({
            gateways: [gw(1, "Keller", "10.0.0.5")],
            units: [{ name: "WHG 1", label: null, billable: true, active: true }, { name: "Allgemein 1", label: "Heizung", billable: false, active: true }],
            routers: [router(7, "hAP", "10.0.0.1")],
        });
        const p = sync.plan(1, empty(), null, cfg);
        expect(p.push).to.equal(null);
        const rows = sync.resolve(1, cfg, p.pending, []);
        expect(rows.moxas[0]).to.include({ site: "1", id: 1, name: "Keller", host: "10.0.0.5", port: 4001, device: "", enabled: true, fwAuto: true });
        expect(rows.units.map((u) => [u.name, u.general])).to.deep.equal([["WHG 1", false], ["Allgemein 1", true]]);
        expect(rows.routers[0]).to.include({ id: 7, sshUser: "admin", autoUpdate: true, time: "03:30", window: 90 });
        expect(rows.routers[0].days).to.deep.equal(["6", "0"].sort((a, b) => ["1", "2", "3", "4", "5", "6", "0"].indexOf(a) - ["1", "2", "3", "4", "5", "6", "0"].indexOf(b)));
    });

    it("sends new rows, changed rows and removed rows to the server", () => {
        const cfg = cfgOf({ gateways: [gw(1, "Keller", "10.0.0.5"), gw(2, "Dach", "10.0.0.6")], units: [{ name: "WHG 1", active: true }, { name: "WHG 2", active: true }] });
        const snap = sync.snapshotFromServer(cfg);
        const local = {
            moxas: [
                { site: "1", id: 1, name: "Keller neu", host: "10.0.0.5", port: 4001, enabled: true, fwAuto: true }, // changed
                { site: "1", id: 0, name: "COM", host: "", device: "/dev/ttyr00", port: 4001, enabled: true, fwAuto: false }, // new
                // id 2 removed
            ],
            units: [{ site: "1", name: "WHG 1", label: "", general: false }, { site: "1", name: "WHG 3", label: "", general: false }],
            routers: [],
        };
        const p = sync.plan(1, local, snap, cfg);
        const g = p.push.gateways;
        expect(g.find((x) => x.id === 1)).to.include({ name: "Keller neu" });
        expect(g.find((x) => !x.id)).to.include({ device: "/dev/ttyr00", fw_auto: false });
        expect(g.find((x) => x.delete)).to.include({ id: 2 });
        expect(p.push.units.map((u) => [u.name, !!u.delete])).to.deep.equal([["WHG 3", false], ["WHG 2", true]]);
    });

    it("lets the server win for rows unchanged in the instance", () => {
        const before = cfgOf({ gateways: [gw(1, "Keller", "10.0.0.5")] });
        const snap = sync.snapshotFromServer(before);
        const local = { moxas: [sync.rowsFromServer(1, before).moxas[0]], units: [], routers: [] };
        const after = cfgOf({ gateways: [gw(1, "Keller", "10.0.0.99")] });
        const p = sync.plan(1, local, snap, after);
        expect(p.push).to.equal(null);
        expect(sync.resolve(1, after, [], []).moxas[0].host).to.equal("10.0.0.99");
    });

    it("never deletes everything because a table is empty", () => {
        const cfg = cfgOf({ gateways: [gw(1, "Keller", "10.0.0.5")], units: [{ name: "WHG 1", active: true }] });
        const p = sync.plan(1, empty(), sync.snapshotFromServer(cfg), cfg);
        expect(p.push).to.equal(null);
    });

    it("does not create a row the server already has, and treats a copied id as new", () => {
        const cfg = cfgOf({ gateways: [gw(1, "Keller", "10.0.0.5")] });
        const row = { site: "1", id: 0, name: "Keller", host: "10.0.0.5", port: 4001, enabled: true, fwAuto: true };
        expect(sync.plan(1, { moxas: [row], units: [], routers: [] }, null, cfg).push).to.equal(null);
        const dup = { ...row, id: 1 };
        const p = sync.plan(1, { moxas: [dup, { ...dup, name: "Kopie" }], units: [], routers: [] }, sync.snapshotFromServer(cfg), cfg);
        expect(p.push.gateways).to.have.length(1);
        expect(p.push.gateways[0]).to.include({ name: "Kopie" });
        expect(p.push.gateways[0].id).to.equal(undefined);
    });

    it("keeps a refused row in the table and puts a refused delete back", () => {
        const cfg = cfgOf({ gateways: [gw(1, "Keller", "10.0.0.5")], units: [{ name: "WHG 1", active: true }] });
        const snap = sync.snapshotFromServer(cfg);
        const local = {
            moxas: [{ site: "1", id: 0, name: "Falsch", host: "bad host", port: 4001, enabled: true, fwAuto: true }, sync.rowsFromServer(1, cfg).moxas[0]],
            units: [],
            routers: [],
        };
        const p = sync.plan(1, local, snap, cfg);
        const results = p.push.units.map((u) => ({ kind: "unit", ref: u.ref, ok: false, error: "zugeteilt" }))
            .concat(p.push.gateways.map((x) => ({ kind: "gateway", ref: x.ref, ok: false, error: "Adresse" })));
        const rows = sync.resolve(1, cfg, p.pending, results);
        expect(rows.moxas.map((m) => m.name)).to.have.members(["Keller", "Falsch"]);
        expect(rows.units.map((u) => u.name)).to.deep.equal(["WHG 1"]);
    });

    it("compares rows regardless of order and type", () => {
        const a = { moxas: [{ site: "1", id: 1, name: "A", host: "h", port: "4001", enabled: true, fwAuto: true }, { site: "1", id: 2, name: "B", host: "g", port: 4001, enabled: false, fwAuto: true }], units: [], routers: [] };
        const b = { moxas: [a.moxas[1], { ...a.moxas[0], port: 4001 }], units: [], routers: [] };
        expect(sync.sameRows(a, b)).to.equal(true);
        b.moxas[1].host = "x";
        expect(sync.sameRows(a, b)).to.equal(false);
    });
});

describe("MbusManager table comparison", () => {
    let dir;
    let state;
    let tables;
    let written;
    let mgr;

    /** A server that applies pushes like the web application does (only what the tests need). */
    function fakeApi() {
        return {
            async mbusConfig() {
                return { ok: true, status: 200, kind: "ok", message: "ok", details: [], data: JSON.parse(JSON.stringify(state.cfg)) };
            },
            async mbusIngest(p) {
                state.ingests.push(p);
                const results = [];
                for (const g of (p.config_push && p.config_push.gateways) || []) {
                    if (g.delete) {
                        state.cfg.gateways = state.cfg.gateways.filter((x) => x.id !== g.id);
                        results.push({ kind: "gateway", ref: g.ref, ok: true, id: g.id });
                    } else if (/\s/.test(g.host)) {
                        results.push({ kind: "gateway", ref: g.ref, ok: false, error: "Adresse ungültig" });
                    } else if (g.id) {
                        Object.assign(state.cfg.gateways.find((x) => x.id === g.id), { name: g.name, host: g.host, port: g.port, device: g.device || null });
                        results.push({ kind: "gateway", ref: g.ref, ok: true, id: g.id });
                    } else {
                        const id = 100 + state.cfg.gateways.length;
                        state.cfg.gateways.push({ id, name: g.name, host: g.host, port: g.port, device: g.device || null, baud: 2400, parity: "E", enabled: g.enabled, fw_auto: g.fw_auto, scan_due: false, meters: [] });
                        results.push({ kind: "gateway", ref: g.ref, ok: true, id });
                    }
                }
                for (const u of (p.config_push && p.config_push.units) || []) {
                    if (!u.delete) {
                        state.cfg.units.push({ name: u.name, label: u.label || null, billable: !u.general, active: true });
                    }
                    results.push({ kind: "unit", ref: u.ref, ok: true });
                }
                return { ok: true, status: 200, kind: "ok", message: "ok", details: [], data: { ok: true, config_result: p.config_push ? results : null } };
            },
        };
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbus-sync-"));
        state = {
            ingests: [],
            cfg: {
                ok: true, client: { id: 5, name: "Testhaus" },
                settings: { version: 1, scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false },
                gateways: [gw(1, "Keller", "10.0.0.5", { scan_due: false })], units: [{ name: "WHG 1", label: null, billable: true, active: true }],
                commands: [], alarms: [], routers: [], router_commands: [],
            },
        };
        tables = empty();
        written = [];
        mgr = new MbusManager({
            log: { info() {}, warn() {}, error() {}, debug() {} },
            clients: [{ label: "a1", api: fakeApi() }],
            store: new Store(dir),
            version: "test",
            setState: async () => {},
            tables: {
                read: () => JSON.parse(JSON.stringify(tables)),
                write: async (t) => {
                    written.push(t);
                    tables = t;
                },
            },
        });
        mgr.store.init();
    });

    afterEach(() => {
        mgr.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("fills the empty tables from the server on the first run, then stays quiet", async () => {
        await mgr.refreshConfig(mgr.clients[0]);
        expect(written).to.have.length(1);
        expect(tables.moxas[0]).to.include({ id: 1, name: "Keller" });
        expect(tables.units[0].name).to.equal("WHG 1");
        expect(state.ingests).to.have.length(0);
        await mgr.refreshConfig(mgr.clients[0]);
        expect(written).to.have.length(1);
        expect(state.ingests).to.have.length(0);
    });

    it("pushes rows added in the instance, takes the new ids over and writes the tables once", async () => {
        await mgr.refreshConfig(mgr.clients[0]);
        tables.moxas.push({ site: "1", id: 0, name: "COM Moxa", host: "", device: "/dev/ttyr00", port: 4001, enabled: true, fwAuto: false });
        tables.units.push({ site: "1", name: "WHG 2", label: "Dach", general: false });
        await mgr.refreshConfig(mgr.clients[0]);
        expect(state.ingests).to.have.length(1);
        const push = state.ingests[0].config_push;
        expect(push.gateways[0]).to.include({ name: "COM Moxa", device: "/dev/ttyr00" });
        expect(tables.moxas.find((m) => m.name === "COM Moxa").id).to.be.greaterThan(0);
        expect(tables.units.map((u) => u.name)).to.include("WHG 2");
        const n = written.length;
        await mgr.refreshConfig(mgr.clients[0]);
        expect(state.ingests).to.have.length(1);
        expect(written).to.have.length(n);
    });

    it("sends a removal and keeps a refused row", async () => {
        await mgr.refreshConfig(mgr.clients[0]);
        tables.moxas = [{ site: "1", id: 0, name: "Schlecht", host: "a b", device: "", port: 4001, enabled: true, fwAuto: true }];
        await mgr.refreshConfig(mgr.clients[0]);
        const push = state.ingests[0].config_push;
        expect(push.gateways.some((x) => x.delete && x.id === 1)).to.equal(true);
        expect(tables.moxas.map((m) => m.name)).to.deep.equal(["Schlecht"]);
        expect(state.cfg.gateways).to.have.length(0);
    });

    it("pushes again after the server refused and logs the refusal once", async () => {
        const logs = [];
        mgr.log.warn = (m) => logs.push(m);
        await mgr.refreshConfig(mgr.clients[0]);
        tables.moxas.push({ site: "1", id: 0, name: "Schlecht", host: "a b", device: "", port: 4001, enabled: true, fwAuto: true });
        await mgr.refreshConfig(mgr.clients[0]);
        await mgr.refreshConfig(mgr.clients[0]);
        expect(state.ingests).to.have.length(2);
        expect(logs.filter((m) => m.includes("abgelehnt"))).to.have.length(1);
    });
});

describe("Bus on a COM device", () => {
    const fake = path.join(__dirname, "..", "helpers", "fakeserial.js");

    it("talks through the serial helper", async () => {
        const b = new Bus({
            device: "/dev/ttyfake",
            baud: 2400,
            parity: "E",
            ackWaitMs: 200,
            dataWaitMs: 500,
            serialCommand: (device, baud, parity) => ({ cmd: process.execPath, args: [fake, device, String(baud), parity] }),
        });
        await b.connect();
        expect(await b.nke(5)).to.equal("ack");
        expect(await b.nke(6)).to.equal("none");
        b.close();
    });

    it("reports a helper that cannot open the device", async () => {
        const b = new Bus({
            device: "/dev/ttynone",
            serialCommand: () => ({ cmd: process.execPath, args: ["-e", "process.stderr.write('E open: No such file\\n');process.exit(1)"] }),
        });
        let msg = "";
        await b.connect().catch((e) => (msg = e.message));
        expect(msg).to.include("/dev/ttynone").and.to.include("No such file");
    });

    it("reports a missing helper program", async () => {
        const b = new Bus({ device: "/dev/ttyUSB0", serialCommand: () => ({ cmd: "nonexistent-socat-xyz", args: [] }) });
        let msg = "";
        await b.connect().catch((e) => (msg = e.message));
        expect(msg).to.include("fehlt");
    });
});
