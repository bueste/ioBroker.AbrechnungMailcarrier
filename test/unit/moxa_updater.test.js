"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = require("chai");
const { MoxaUpdater } = require("../../lib/moxa/updater");
const { MoxaWeb } = require("../../lib/moxa/web");
const { startFakeMoxa } = require("../helpers/fakemoxa");

const SOFTWARE_PAGE = fs.readFileSync(path.join(__dirname, "../fixtures/moxa_software_page.html"), "utf8");
const FIRMWARE = crypto.randomBytes(120 * 1024);
const SHA = crypto.createHash("sha512").update(FIRMWARE).digest("hex");

/** fetch that serves Moxa's software page (with the checksum of our test file) and the test file */
function fakeFetch(opt = {}) {
    const page = SOFTWARE_PAGE.replace(/2CE858C1[0-9A-F]{120}/i, opt.badSum ? "0".repeat(128) : SHA.toUpperCase());
    return async (url) => {
        if (/software-and-documentation/.test(String(url))) {
            return { ok: true, status: 200, text: async () => page };
        }
        return { ok: true, status: 200, arrayBuffer: async () => FIRMWARE.buffer.slice(FIRMWARE.byteOffset, FIRMWARE.byteOffset + FIRMWARE.length) };
    };
}

describe("MoxaUpdater", () => {
    let moxa;
    let dir;
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "moxa-"));
    });
    afterEach(async () => {
        if (moxa) {
            await new Promise((r) => moxa.server.close(r));
            moxa = null;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const updater = (extra = {}) =>
        new MoxaUpdater({
            log: quiet,
            password: "moxa",
            dir,
            fetchImpl: fakeFetch(extra.fetch),
            webFactory: (host, port, password) => new MoxaWeb({ host: "127.0.0.1", port: moxa.port, password, timeoutMs: 2000 }),
            portCheck: async () => extra.portOpen !== false,
            sleep: async (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
            settleMs: 10,
            rebootTimeoutMs: extra.rebootTimeoutMs ?? 5000,
            pollMs: 10,
        });
    const gw = { host: "10.0.0.5", port: 4001 };

    it("reads model and firmware and says that an update is available and possible", async () => {
        moxa = await startFakeMoxa();
        const r = await updater().check(gw);
        expect(r).to.include({ status: "veraltet", model: "NPort 5110", firmware: "2.9", latest: "2.11", updatable: true });
    });

    it("reports a current device as current", async () => {
        moxa = await startFakeMoxa({ firmware: "2.11" });
        expect((await updater().check(gw)).status).to.equal("aktuell");
    });

    it("never requests restart, reset or logout pages while looking around", async () => {
        moxa = await startFakeMoxa();
        await updater().check(gw);
        expect(moxa.st.hits.join(" ")).to.not.match(/restart|default|logout/);
    });

    it("reports a wrong password instead of trying again and again", async () => {
        moxa = await startFakeMoxa({ password: "other" });
        const r = await updater().check(gw);
        expect(r.status).to.equal("fehler");
        expect(r.note).to.contain("abgelehnt");
    });

    it("flashes the firmware, waits for the device and verifies version and serial port", async () => {
        moxa = await startFakeMoxa();
        const r = await updater().update(gw);
        expect(r, r.note).to.include({ ok: true, status: "aktuell", from: "2.9", to: "2.11" });
        expect(moxa.st.uploads).to.have.length(1);
        expect(moxa.st.uploads[0].type).to.match(/^multipart\/form-data; boundary=/);
        expect(moxa.st.uploads[0].bytes).to.be.greaterThan(FIRMWARE.length);
        expect(moxa.st.uploads[0].head).to.contain('name="token_text"').and.to.contain('name="Firmware"; filename="moxa-nport-5110-5110-t-firmware-v2.11.rom"');
        expect(r.note).to.contain("Konfiguration gesichert");
        expect(fs.readdirSync(path.join(dir, "firmware"))).to.deep.equal(["moxa-nport-5110-5110-t-firmware-v2.11.rom"]);
    });

    it("does nothing when the device is current", async () => {
        moxa = await startFakeMoxa({ firmware: "2.11" });
        const r = await updater().update(gw);
        expect(r.status).to.equal("aktuell");
        expect(moxa.st.uploads).to.have.length(0);
    });

    it("refuses a firmware whose checksum does not match, before anything is uploaded", async () => {
        moxa = await startFakeMoxa();
        const r = await updater({ fetch: { badSum: true } }).update(gw);
        expect(r.ok).to.equal(false);
        expect(r.note).to.contain("Prüfsumme");
        expect(moxa.st.uploads).to.have.length(0);
    });

    it("does not guess when the console shows no upload form", async () => {
        moxa = await startFakeMoxa({ noForm: true });
        const r = await updater().update(gw);
        expect(r.status).to.equal("unbekannt");
        expect(r.note).to.contain("Upload-Seite");
        expect(moxa.st.uploads).to.have.length(0);
        expect((await updater().check(gw)).updatable).to.equal(false);
    });

    it("reports a failed update when the device keeps the old version", async () => {
        moxa = await startFakeMoxa({ newVersionOnUpload: false });
        const r = await updater().update(gw);
        expect(r.ok).to.equal(false);
        expect(r.status).to.equal("fehler");
        expect(r.note).to.contain("erwartet war 2.11");
    });

    it("reports a device that does not come back", async () => {
        moxa = await startFakeMoxa({ downMs: 60000 });
        const r = await updater({ rebootTimeoutMs: 300 }).update(gw);
        expect(r.ok).to.equal(false);
        expect(r.note).to.contain("nicht wieder erreichbar");
    });

    it("reports a closed serial port after the update", async () => {
        moxa = await startFakeMoxa();
        // port open before, closed afterwards
        let calls = 0;
        const u = updater();
        u.portCheck = async () => ++calls === 1;
        u.pollMs = 5;
        u.portWaitMs = 100;
        const r = await u.update(gw);
        expect(r.ok).to.equal(false);
        expect(r.note).to.contain("nicht mehr offen");
    });
});
