"use strict";

const { expect } = require("chai");
const ros = require("../../lib/mikrotik/routeros");
const { RouterUpdater } = require("../../lib/mikrotik/updater");

/** A scripted RouterOS: answers the commands the updater uses, in the output format of RouterOS 7 (or 6). */
function fakeRouter(o = {}) {
    const st = {
        version: "7.16.2",
        latest: "7.17",
        rbCurrent: "7.16.2",
        rbUpgrade: "7.17",
        down: 0,
        installFails: false,
        neverBack: false,
        rebootPrompt: false,
        v6: false,
        rbRequested: false,
        channel: "stable",
        log: [],
        ...o,
    };
    const ok = (out) => ({ code: 0, out, err: "" });
    const exec = async (cmd) => {
        st.log.push(cmd);
        if (st.down > 0 && /resource print|routerboard print|identity print/.test(cmd)) {
            if (cmd.includes("resource")) {
                st.down--;
            }
            return { code: 255, out: "", err: "ssh: connect to host 10.0.0.1 port 22: Connection timed out" };
        }
        if (st.neverBack && st.installed) {
            return { code: 255, out: "", err: "ssh: connect: No route to host" };
        }
        if (cmd === "/system resource print") {
            return ok(`                   uptime: 3d4h\n                  version: ${st.version} (stable)\n               board-name: hAP ac^2\n        architecture-name: arm\n`);
        }
        if (cmd === "/system routerboard print") {
            return ok(`       routerboard: yes\n             model: hAP ac^2\n  current-firmware: ${st.rbCurrent}\n  upgrade-firmware: ${st.rbUpgrade}\n`);
        }
        if (cmd === "/system identity print") {
            return ok("  name: hap\n");
        }
        if (cmd.startsWith("/system package update set channel=")) {
            st.channel = cmd.split("=")[1];
            return ok("");
        }
        if (cmd === "/system package update check-for-updates once") {
            if (st.v6) {
                return { code: 1, out: "", err: "expected end of command (line 1 column 51)" };
            }
            return ok(`            channel: ${st.channel}\n  installed-version: ${st.version}\n     latest-version: ${st.latest}\n             status: ${st.latest === st.version ? "System is already up to date" : "New version is available"}\n`);
        }
        if (cmd === "/system package update check-for-updates") {
            return ok(`            channel: ${st.channel}\n  installed-version: ${st.version}\n     latest-version: ${st.latest}\n             status: ${st.latest === st.version ? "System is already up to date" : "New version is available"}\n`);
        }
        if (cmd === "/system package update install") {
            st.installed = true;
            if (!st.installFails) {
                st.version = st.latest;
                st.down = 3;
            }
            return { code: 255, out: "", err: "connection closed" };
        }
        if (cmd === "/system routerboard upgrade") {
            st.rbRequested = true;
            return ok("");
        }
        if (cmd === "/system reboot") {
            if (st.rebootPrompt) {
                return ok("Reboot, yes? [y/N]:");
            }
            if (st.rbRequested) {
                st.rbCurrent = st.rbUpgrade;
                st.down = 2;
            }
            return { code: 255, out: "", err: "connection closed" };
        }
        if (cmd === ':execute "/system reboot"') {
            if (st.rbRequested) {
                st.rbCurrent = st.rbUpgrade;
                st.down = 2;
            }
            return ok("");
        }
        return ok("");
    };
    return { st, exec };
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const router = { host: "10.0.0.1", name: "hap", channel: "stable", routerboard_fw: true };

function updater(r, extra = {}) {
    const fetched = [];
    const u = new RouterUpdater({
        log: quiet,
        dir: "/tmp/none",
        execFor: () => r.exec,
        fetchFile: async (rt, remote, local) => {
            fetched.push(remote);
            return true;
        },
        sleep: async () => {},
        settleMs: 0,
        rebootTimeoutMs: extra.rebootTimeoutMs ?? 5000,
        pollMs: 1,
    });
    u.fetched = fetched;
    return u;
}

describe("RouterOS reading", () => {
    it("reads key: value output and versions", () => {
        const kv = ros.parseKv("  installed-version: 7.16.2\n     latest-version: 7.17\n             status: New version is available\n");
        expect(kv).to.deep.equal({ "installed-version": "7.16.2", "latest-version": "7.17", status: "New version is available" });
        expect(ros.versionOf("7.16.2 (stable)")).to.equal("7.16.2");
        expect(ros.versionOf("6.49.18 (long-term)")).to.equal("6.49.18");
        expect(ros.compareVersions("7.17", "7.16.2")).to.be.greaterThan(0);
        expect(ros.compareVersions("7.9", "7.10")).to.be.lessThan(0);
    });
});

describe("RouterUpdater", () => {
    it("reports an outdated router and changes nothing but the channel", async () => {
        const r = fakeRouter();
        const c = await updater(r).check(router);
        expect(c).to.include({ status: "veraltet", version: "7.16.2", latest: "7.17", osNewer: true, rbNewer: true, reachable: true });
        expect(c.note).to.contain("RouterOS 7.16.2, neu ist 7.17");
        expect(r.st.log.join("|")).to.not.match(/install|reboot|upgrade$|backup|export/);
    });

    it("reports a current router as current", async () => {
        const r = fakeRouter({ latest: "7.16.2", rbUpgrade: "7.16.2" });
        expect((await updater(r).check(router)).status).to.equal("aktuell");
    });

    it("ignores the RouterBOARD firmware when it is switched off for the router", async () => {
        const r = fakeRouter({ latest: "7.16.2" });
        expect((await updater(r).check({ ...router, routerboard_fw: false })).status).to.equal("aktuell");
        expect((await updater(r).check(router)).status).to.equal("veraltet");
    });

    it("uses the older command on RouterOS 6", async () => {
        const r = fakeRouter({ v6: true, version: "6.49.10", latest: "6.49.18", rbCurrent: "6.49.10", rbUpgrade: "6.49.10" });
        const c = await updater(r).check(router);
        expect(c).to.include({ status: "veraltet", latest: "6.49.18" });
    });

    it("reports an unreachable router and a wrong channel", async () => {
        const r = fakeRouter({ down: 99 });
        const c = await updater(r).check(router);
        expect(c).to.include({ status: "fehler", reachable: false });
        expect((await updater(fakeRouter()).check({ ...router, channel: "nightly; reboot" })).note).to.contain("Unbekannter Kanal");
    });

    it("saves a backup, installs, waits for the reboot, then does the RouterBOARD firmware with a second reboot", async () => {
        const r = fakeRouter();
        const u = updater(r);
        const res = await u.update(router);
        expect(res, res.note).to.include({ ok: true, status: "aktuell", from: "7.16.2", to: "7.17" });
        expect(res.note).to.contain("RouterBOARD-Firmware 7.16.2 -> 7.17");
        expect(r.st.version).to.equal("7.17");
        expect(r.st.rbCurrent).to.equal("7.17");
        const log = r.st.log;
        expect(log.findIndex((c) => c.startsWith("/system backup save"))).to.be.lessThan(log.indexOf("/system package update install"));
        expect(log.indexOf("/system package update install")).to.be.lessThan(log.indexOf("/system routerboard upgrade"));
        expect(u.fetched).to.have.length(2);
    });

    it("updates only RouterOS when the RouterBOARD firmware is switched off", async () => {
        const r = fakeRouter();
        const res = await updater(r).update({ ...router, routerboard_fw: false });
        expect(res.ok).to.equal(true);
        expect(r.st.log).to.not.include("/system routerboard upgrade");
    });

    it("answers the reboot confirmation of the router", async () => {
        const r = fakeRouter({ rebootPrompt: true, latest: "7.16.2" });
        const res = await updater(r).update(router);
        expect(res, res.note).to.include({ ok: true });
        expect(r.st.log).to.include(':execute "/system reboot"');
        expect(r.st.rbCurrent).to.equal("7.17");
    });

    it("reports a router that did not install the new version", async () => {
        const r = fakeRouter({ installFails: true });
        const res = await updater(r, { rebootTimeoutMs: 100 }).update(router);
        expect(res.ok).to.equal(false);
        expect(res.status).to.equal("fehler");
        expect(res.note).to.contain("erwartet RouterOS 7.17");
    });

    it("reports a router that does not come back", async () => {
        const r = fakeRouter({ neverBack: true });
        const res = await updater(r, { rebootTimeoutMs: 100 }).update(router);
        expect(res.ok).to.equal(false);
        expect(res.note).to.contain("nicht wieder erreichbar");
    });

    it("does nothing to a current router", async () => {
        const r = fakeRouter({ latest: "7.16.2", rbUpgrade: "7.16.2" });
        const res = await updater(r).update(router);
        expect(res).to.include({ ok: true, status: "aktuell" });
        expect(r.st.log.join("|")).to.not.match(/install|reboot|backup/);
    });
});
