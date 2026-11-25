"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = require("chai");
const { RouterCare, inWindow } = require("../../lib/mikrotik/routers");
const { Store } = require("../../lib/mbus/store");

const D = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi, 0).getTime();
// 2026-11-22 is a Sunday
const SUN = (h, mi) => D(2026, 11, 22, h, mi);

describe("update window of a router", () => {
    const r = { upd_days: "0", upd_time: "03:30", upd_window_min: 90 };

    it("is open from the start time for the length of the window on the chosen day", () => {
        expect(inWindow(SUN(3, 29), r)).to.equal(false);
        expect(inWindow(SUN(3, 30), r)).to.equal(true);
        expect(inWindow(SUN(4, 59), r)).to.equal(true);
        expect(inWindow(SUN(5, 0), r)).to.equal(false);
        expect(inWindow(D(2026, 11, 23, 3, 45), r)).to.equal(false); // Monday
    });

    it("takes several weekdays", () => {
        const w = { upd_days: "1,3,5", upd_time: "02:00", upd_window_min: 60 };
        expect(inWindow(D(2026, 11, 23, 2, 30), w)).to.equal(true); // Monday
        expect(inWindow(D(2026, 11, 24, 2, 30), w)).to.equal(false); // Tuesday
        expect(inWindow(D(2026, 11, 25, 2, 30), w)).to.equal(true); // Wednesday
    });

    it("reaches over midnight", () => {
        const w = { upd_days: "6", upd_time: "23:30", upd_window_min: 120 }; // Saturday
        expect(inWindow(D(2026, 11, 21, 23, 45), w)).to.equal(true); // Saturday evening
        expect(inWindow(SUN(0, 30), w)).to.equal(true); // Sunday after midnight still belongs to Saturday's window
        expect(inWindow(SUN(1, 40), w)).to.equal(false);
    });

    it("is never open with unusable settings", () => {
        expect(inWindow(SUN(3, 40), { upd_days: "", upd_time: "03:30", upd_window_min: 90 })).to.equal(false);
        expect(inWindow(SUN(3, 40), { upd_days: "0", upd_time: "kaputt", upd_window_min: 90 })).to.equal(false);
        expect(inWindow(SUN(3, 40), { upd_days: "9,x", upd_time: "03:30", upd_window_min: 90 })).to.equal(false);
    });
});

describe("RouterCare", () => {
    let dir;
    let store;
    let clock;
    let calls;
    let updater;
    let states;
    let care;
    const client = (extra = {}) => ({
        label: "a1",
        clientId: 5,
        cfg: {
            routers: [{ id: 3, name: "hap", host: "10.0.0.1", enabled: true, auto_update: true, upd_days: "0", upd_time: "03:30", upd_window_min: 90, channel: "stable", routerboard_fw: true }],
            router_commands: [],
            ...extra,
        },
    });
    const reports = () => store.pending.flatMap((b) => b.routers || []);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
        store = new Store(dir);
        store.init();
        clock = D(2026, 11, 24, 12, 0); // Tuesday noon
        calls = { check: 0, update: 0 };
        states = {};
        updater = {
            outdated: true,
            ok: true,
            async check() {
                calls.check++;
                return this.outdated
                    ? { status: "veraltet", reachable: true, version: "7.16.2", latest: "7.17", model: "hAP", note: "RouterOS 7.16.2, neu ist 7.17 (stable)." }
                    : { status: "aktuell", reachable: true, version: "7.17", latest: "7.17", model: "hAP", note: "RouterOS 7.17 ist aktuell." };
            },
            async update() {
                calls.update++;
                if (this.ok) {
                    this.outdated = false;
                    return { ok: true, status: "aktuell", note: "RouterOS 7.16.2 -> 7.17", from: "7.16.2", to: "7.17" };
                }
                return { ok: false, status: "fehler", note: "Router nach dem Neustart nicht wieder erreichbar" };
            },
        };
        care = new RouterCare({
            log: { info() {}, warn() {}, error() {}, debug() {} },
            updater,
            store,
            version: "test",
            setState: async (id, v) => {
                states[id] = v;
            },
            now: () => clock,
        });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("looks at the router at the first run at any time and reports, but does not install outside the window", async () => {
        await care.run(client());
        expect(calls).to.deep.equal({ check: 1, update: 0 });
        expect(reports()[0]).to.include({ router_id: 3, status: "veraltet", os_version: "7.16.2", latest_version: "7.17" });
        expect(states["mbus.a1.routers.3.status"]).to.equal("veraltet");
    });

    it("installs at the set time on the set day, and reports the result", async () => {
        await care.run(client());
        clock = SUN(3, 40);
        await care.run(client());
        expect(calls.update).to.equal(1);
        const statuses = reports().map((r) => r.status);
        expect(statuses).to.include("update_laeuft");
        expect(reports().at(-1)).to.include({ status: "aktuell" });
        expect(reports().at(-1).updated_at).to.be.a("string");
        clock += 600000;
        await care.run(client());
        expect(calls.update).to.equal(1);
    });

    it("does not install when the automatic update is switched off for the router", async () => {
        const c = client();
        c.cfg.routers[0].auto_update = false;
        await care.run(c);
        clock = SUN(3, 40);
        await care.run(c);
        expect(calls.update).to.equal(0);
    });

    it("waits for the next chosen time when the window is missed", async () => {
        await care.run(client());
        clock = SUN(5, 30); // after the window
        await care.run(client());
        expect(calls.update).to.equal(0);
        clock = D(2026, 11, 29, 3, 40);
        await care.run(client());
        expect(calls.update).to.equal(1);
    });

    it("does not retry a failed update at the next window, but after three days", async () => {
        updater.ok = false;
        await care.run(client());
        clock = SUN(3, 40);
        await care.run(client());
        expect(calls.update).to.equal(1);
        expect(reports().at(-1).status).to.equal("fehler");
        clock = D(2026, 11, 29, 3, 40);
        await care.run(client());
        expect(calls.update).to.equal(2);
    });

    it("runs a manual update at once and returns the result once", async () => {
        const c = client({ router_commands: [{ id: 40, router_id: 3, type: "rupdate" }] });
        await care.run(c);
        expect(calls.update).to.equal(1);
        const cmd = store.pending.flatMap((b) => b.router_commands || []);
        expect(cmd).to.have.length(1);
        expect(cmd[0]).to.include({ id: 40, ok: true });
        await care.run(c);
        expect(store.pending.flatMap((b) => b.router_commands || [])).to.have.length(1);
    });

    it("skips switched-off routers", async () => {
        const c = client();
        c.cfg.routers[0].enabled = false;
        await care.run(c);
        expect(calls.check).to.equal(0);
    });
});
