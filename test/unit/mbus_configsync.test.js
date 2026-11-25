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
        expect(rows.moxas[0]).to.include({ site: "1", id: 1, name: "Keller", host: "10.0.0.5", port: 4001, comPort: "", enabled: true, fwAuto: true });
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
                { site: "1", id: 0, name: "Neu", host: "10.0.0.9", port: 4001, enabled: true, fwAuto: false }, // new
                // id 2 removed
            ],
            units: [{ site: "1", name: "WHG 1", label: "", general: false }, { site: "1", name: "WHG 3", label: "", general: false }],
            routers: [],
        };
        const p = sync.plan(1, local, snap, cfg);
        const g = p.push.gateways;
        expect(g.find((x) => x.id === 1)).to.include({ name: "Keller neu" });
        expect(g.find((x) => !x.id)).to.include({ name: "Neu", host: "10.0.0.9", fw_auto: false });
        expect(g.every((x) => !("device" in x))).to.equal(true);
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
        tables.moxas.push({ site: "1", id: 0, name: "COM Moxa", host: "10.0.0.7", port: 4001, enabled: true, fwAuto: false });
        tables.units.push({ site: "1", name: "WHG 2", label: "Dach", general: false });
        await mgr.refreshConfig(mgr.clients[0]);
        expect(state.ingests).to.have.length(1);
        const push = state.ingests[0].config_push;
        expect(push.gateways[0]).to.include({ name: "COM Moxa", host: "10.0.0.7" });
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

describe("password and COM port per Moxa", () => {
    it("shows the COM port of a Moxa and keeps its password when the rows are rebuilt", () => {
        const cfg = { gateways: [gw(1, "Keller", "10.0.0.5")], units: [], routers: [] };
        const rows = sync.rowsFromServer(1, cfg, (id) => `/x/com/a1-moxa-${id}`);
        expect(rows.moxas[0].comPort).to.equal("/x/com/a1-moxa-1");
        expect(sync.canonMoxa({ ...rows.moxas[0], password: "geheim" })).to.not.have.any.keys("password", "comPort", "device");
    });

    it("keeps the password of a row after a comparison, and does not send it", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbus-pw-"));
        const state = {
            ingests: [],
            cfg: {
                ok: true, client: { id: 5, name: "T" }, settings: { version: 1, scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false },
                gateways: [gw(1, "Keller", "10.0.0.5")], units: [], commands: [], alarms: [], routers: [], router_commands: [],
            },
        };
        let tables = { moxas: [{ site: "1", id: 1, name: "Keller", host: "10.0.0.5", port: 4001, enabled: true, fwAuto: true, password: "enc:abc" }], units: [], routers: [] };
        const mgr = new MbusManager({
            log: { info() {}, warn() {}, error() {}, debug() {} },
            clients: [{ label: "a1", api: { mbusConfig: async () => ({ ok: true, data: JSON.parse(JSON.stringify(state.cfg)) }), mbusIngest: async (p) => { state.ingests.push(p); return { ok: true, data: {} }; } } }],
            store: new Store(dir),
            version: "t",
            setState: async () => {},
            tables: { read: () => JSON.parse(JSON.stringify(tables)), write: async (t) => { tables = t; } },
        });
        mgr.store.init();
        state.cfg.gateways[0].host = "10.0.0.6"; // changed on the server
        await mgr.refreshConfig(mgr.clients[0]);
        mgr.stop();
        fs.rmSync(dir, { recursive: true, force: true });
        expect(tables.moxas[0]).to.include({ host: "10.0.0.6", password: "enc:abc" });
        expect(state.ingests).to.have.length(0);
    });
});

describe("ComMounts", () => {
    const { ComMounts } = require("../../lib/mbus/commount");
    const fake = path.join(__dirname, "..", "helpers", "fakemount.js");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let dir;
    let mounts;
    let events;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbus-com-"));
        events = [];
        mounts = new ComMounts({
            log: { info() {}, warn() {}, error() {}, debug() {} },
            dir,
            restartMs: 150,
            upAfterMs: 200,
            command: (file, host, port) => ({ cmd: process.execPath, args: [fake, file, host, String(port)] }),
            onChange: (label, id, file) => events.push([label, id, file]),
        });
    });
    afterEach(() => {
        mounts.stopAll();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("mounts a port for an active Moxa and unmounts it when disabled or removed", async () => {
        mounts.sync("a1", [{ id: 4, host: "10.0.0.5", port: 4001, enabled: true }, { id: 5, host: "10.0.0.6", port: 4001, enabled: false }]);
        await wait(600);
        const file = mounts.file("a1", 4);
        expect(mounts.isUp("a1", 4)).to.equal(true);
        expect(fs.existsSync(file)).to.equal(true);
        expect(mounts.isUp("a1", 5)).to.equal(false);
        expect(events[0]).to.deep.equal(["a1", 4, file]);
        mounts.sync("a1", [{ id: 4, host: "10.0.0.5", port: 4001, enabled: false }]);
        await wait(300);
        expect(mounts.isUp("a1", 4)).to.equal(false);
        expect(fs.existsSync(file)).to.equal(false);
        expect(events[events.length - 1]).to.deep.equal(["a1", 4, ""]);
    });

    it("remounts when the address changes and does not mount a gateway with a device or no host", async () => {
        mounts.sync("a1", [{ id: 1, host: "10.0.0.5", port: 4001 }, { id: 2, host: "", port: 4001 }, { id: 3, host: "10.0.0.8", port: 4001, device: "/dev/ttyUSB0" }]);
        await wait(500);
        expect(mounts.isUp("a1", 1)).to.equal(true);
        expect(mounts.ports.size).to.equal(1);
        mounts.sync("a1", [{ id: 1, host: "10.0.0.9", port: 4001 }]);
        await wait(500);
        expect(mounts.isUp("a1", 1)).to.equal(true);
        expect(mounts.ports.get("a1:1").host).to.equal("10.0.0.9");
    });

    it("keeps trying while the Moxa is unreachable and logs it once", async () => {
        const warns = [];
        mounts.log.warn = (m) => warns.push(m);
        mounts.sync("a1", [{ id: 9, host: "fail", port: 4001 }]);
        await wait(700);
        expect(mounts.isUp("a1", 9)).to.equal(false);
        expect(warns).to.have.length(1);
        expect(warns[0]).to.include("Connection refused");
        expect(mounts.ports.get("a1:9").wanted).to.equal(true);
    });

    it("removes everything when the adapter stops", async () => {
        mounts.sync("a1", [{ id: 1, host: "10.0.0.5", port: 4001 }]);
        await wait(500);
        mounts.stopAll();
        expect(fs.readdirSync(path.join(dir, "com"))).to.deep.equal([]);
    });
});

describe("meters in the instance table", () => {
    const meter = (id, extra = {}) => ({ gateway_id: 1, id, medium: 7, primary: 201, manufacturer: "IST", medium_name: "Cold water", kind: null, unit: null, label: null, status: "neu", ...extra });

    it("lists the meters of the server and sends assignments back", () => {
        const cfg = { gateways: [], units: [], routers: [], meter_rows: [meter("111"), meter("222", { kind: "warmwasser", unit: "WHG 1", status: "aktiv" })] };
        const rows = sync.rowsFromServer(1, cfg);
        expect(rows.meters.map((m) => [m.mid, m.type, m.kind, m.unit, m.status])).to.deep.equal([
            ["111", "Cold water", "", "", "neu"],
            ["222", "Cold water", "warmwasser", "WHG 1", "aktiv"],
        ]);
        const snap = sync.snapshotFromServer(cfg);
        const local = { moxas: [], units: [], routers: [], meters: rows.meters.map((m) => (m.mid === "111" ? { ...m, kind: "kaltwasser", unit: "WHG 1", label: "Bad" } : m)) };
        const p = sync.plan(1, local, snap, cfg);
        expect(p.push.meters).to.have.length(1);
        expect(p.push.meters[0]).to.include({ gateway_id: 1, meter_id: "111", medium: 7, kind: "kaltwasser", unit: "WHG 1", label: "Bad" });
    });

    it("takes the server assignment when the instance did not change the row and keeps a refused edit", () => {
        const before = { gateways: [], units: [], routers: [], meter_rows: [meter("111")] };
        const snap = sync.snapshotFromServer(before);
        const local = { moxas: [], units: [], routers: [], meters: sync.rowsFromServer(1, before).meters };
        const after = { ...before, meter_rows: [meter("111", { kind: "kaltwasser", unit: "WHG 3", status: "aktiv" })] };
        expect(sync.plan(1, local, snap, after).push).to.equal(null);
        expect(sync.resolve(1, after, [], []).meters[0]).to.include({ unit: "WHG 3", status: "aktiv" });
        const edited = { ...local, meters: [{ ...local.meters[0], unit: "WHG 99" }] };
        const p = sync.plan(1, edited, snap, before);
        const rows = sync.resolve(1, before, p.pending, [{ kind: "meter", ref: p.push.meters[0].ref, ok: false, error: "x" }]);
        expect(rows.meters[0].unit).to.equal("WHG 99");
    });

    it("ignores the display columns when comparing", () => {
        const a = { moxas: [], units: [], routers: [], meters: [{ site: "1", gw: 1, mid: "1", medium: 7, kind: "", unit: "", label: "", status: "neu", type: "A", adr: "1" }] };
        const b = { moxas: [], units: [], routers: [], meters: [{ ...a.meters[0] }] };
        expect(sync.sameRows(a, b)).to.equal(true);
        b.meters[0].label = "x";
        expect(sync.sameRows(a, b)).to.equal(false);
    });
});

describe("COM port warning", () => {
    it("raises a finding when an active Moxa has no mounted port for three minutes and closes it when mounted", () => {
        let clock = 1000000;
        const queued = [];
        const mgr = new MbusManager({
            log: { info() {}, warn() {}, error() {}, debug() {} },
            clients: [{ label: "a1", api: {} }],
            store: { init() {}, state: { commands: {}, lastRun: {} }, enqueue: (b) => queued.push(b), saveState() {} },
            version: "t",
            setState: async () => {},
            now: () => clock,
        });
        const entry = { up: false, since: clock, lastErr: "Connection refused" };
        mgr.mounts = { ports: new Map([["a1:7", entry]]) };
        const c = mgr.clients[0];
        c.cfg = { gateways: [{ id: 7, name: "Keller", port: 4001 }] };
        mgr.checkMounts(c);
        expect(queued).to.have.length(0);
        clock += 4 * 60000;
        mgr.checkMounts(c);
        mgr.checkMounts(c);
        expect(queued).to.have.length(1);
        expect(queued[0].alarms[0]).to.include({ type: "com_port", key: "7", severity: "warn", resolved: false });
        expect(queued[0].alarms[0].message).to.include("Connection refused");
        entry.up = true;
        mgr.checkMounts(c);
        expect(queued).to.have.length(2);
        expect(queued[1].alarms[0]).to.include({ type: "com_port", resolved: true });
    });
});

describe("Moxa setup through the web console", () => {
    const http = require("node:http");
    const setup = require("../../lib/moxa/setup");
    const { MoxaWeb } = require("../../lib/moxa/web");
    const fx = (n) => fs.readFileSync(path.join(__dirname, "../fixtures", n), "utf8");

    function fakeConsole(opts = {}) {
        const seen = [];
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, "http://x");
            seen.push(u.pathname + (u.search ? "?" + [...u.searchParams.keys()].length : ""));
            const send = (b) => res.end(b);
            if (u.pathname === "/serial.htm") return send(opts.noSerialField ? fx("moxa_serial.htm").replace("name=Parity", "name=Other") : fx("moxa_serial.htm"));
            if (u.pathname === "/04Svr.htm") return send(fx("moxa_04svr.htm"));
            if (u.pathname === "/09.htm") return send(fx("moxa_09.htm"));
            if (u.pathname === "/Set.htm") {
                seen.push(JSON.stringify(Object.fromEntries(u.searchParams)));
                return send("<title>Set</title>ok");
            }
            if (u.pathname === "/09Set.htm") {
                seen.push("RESTART");
                return send("restarting");
            }
            res.statusCode = 404;
            res.end();
        });
        return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, seen })));
    }

    it("sets the serial line, switches to TCP server mode and restarts, in that order", async () => {
        const f = await fakeConsole();
        const web = new MoxaWeb({ host: "127.0.0.1", port: f.port, password: "x" });
        const r = await setup.apply(web, { port: 4001, baud: 2400, parity: "E" });
        f.server.close();
        expect(r.ok).to.equal(true);
        const sets = f.seen.filter((s) => s.startsWith("{"));
        expect(sets).to.have.length(2);
        const serial = JSON.parse(sets[0]);
        expect(serial).to.include({ setfunc: "Serial", BaudRate: "9", DataBits: "3", StopBits: "0", Parity: "24", FlowCtrl: "0" });
        expect(serial.token_text).to.be.a("string").and.not.equal("");
        const mode = JSON.parse(sets[1]);
        expect(mode).to.include({ setfunc: "OPMode", OpMode: "10", LocalTcpPort: "4001", CommandPort: "966", MaxConnect: "2" });
        expect(f.seen.indexOf("RESTART")).to.be.greaterThan(f.seen.indexOf(sets[1]));
    });

    it("changes nothing when a page does not look like the expected firmware", async () => {
        const f = await fakeConsole({ noSerialField: true });
        const web = new MoxaWeb({ host: "127.0.0.1", port: f.port, password: "x" });
        const r = await setup.apply(web, { port: 4001, baud: 2400, parity: "E" });
        f.server.close();
        expect(r.ok).to.equal(false);
        expect(f.seen.some((s) => s.startsWith("{") || s === "RESTART")).to.equal(false);
    });

    it("refuses values it cannot set", () => {
        expect(setup.checkTarget({ port: 4001, baud: 2400, parity: "E" })).to.equal(null);
        expect(setup.checkTarget({ port: 4001, baud: 2401, parity: "E" })).to.be.a("string");
        expect(setup.checkTarget({ port: 966, baud: 2400, parity: "E" })).to.be.a("string");
        expect(setup.checkTarget({ port: 4001, baud: 2400, parity: "X" })).to.be.a("string");
    });
});

describe("key date reading", () => {
    const { lastDue } = require("../../lib/mbus/stichtag");

    it("finds the last day of the month at 23:59 that is not in the future", () => {
        const d = lastDue(new Date(2026, 10, 25, 10, 0, 0), "last", "23:59");
        expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).to.deep.equal([2026, 9, 31, 23, 59]);
        const e = lastDue(new Date(2026, 10, 30, 23, 59, 30), "last", "23:59");
        expect([e.getMonth(), e.getDate()]).to.deep.equal([10, 30]);
        const f = lastDue(new Date(2026, 2, 1, 0, 0, 5), "last", "23:59");
        expect([f.getMonth(), f.getDate()]).to.deep.equal([1, 28]);
    });

    it("supports a fixed day of the month", () => {
        const d = lastDue(new Date(2026, 10, 25, 10, 0, 0), 28, "06:00");
        expect([d.getMonth(), d.getDate(), d.getHours()]).to.deep.equal([9, 28, 6]);
        const e = lastDue(new Date(2026, 10, 28, 6, 0, 0), "28", "06:00");
        expect([e.getMonth(), e.getDate()]).to.deep.equal([10, 28]);
    });

    it("compares the intervals row with the new fields", () => {
        const cfg = { gateways: [], units: [], routers: [], settings: { version: 3, scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false, read_mode: "stichtag", stichtag_day: "last", stichtag_time: "23:59" } };
        const row = sync.rowsFromServer(1, cfg).settings[0];
        expect(row).to.include({ readMode: "stichtag", stichtagDay: "last", stichtagTime: "23:59" });
        const snap = sync.snapshotFromServer(cfg);
        const p = sync.plan(1, { moxas: [], units: [], routers: [], settings: [{ ...row, stichtagTime: "22:00" }] }, snap, cfg);
        expect(p.settings).to.include({ read_mode: "stichtag", stichtag_time: "22:00" });
    });
});

describe("intervals row from an older version", () => {
    it("does not send an old row back that only lacks the newer fields", () => {
        const cfg = { gateways: [], units: [], routers: [], settings: { version: 4, scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false, read_mode: "stichtag", stichtag_day: "1", stichtag_time: "00:00" } };
        const oldSnap = { moxas: {}, units: {}, routers: {}, meters: {}, settings: { scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false } };
        const oldRow = { site: "1", scanDays: 30, readMinutes: 15, timesyncDays: 30, timesyncEnabled: false };
        const p = sync.plan(1, { moxas: [], units: [], routers: [], settings: [oldRow] }, oldSnap, cfg);
        expect(p.settings).to.equal(null);
        const rows = sync.resolve(1, cfg, [], []);
        expect(rows.settings[0]).to.include({ readMode: "stichtag", stichtagDay: "1", stichtagTime: "00:00" });
    });
});
