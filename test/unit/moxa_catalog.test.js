"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { expect } = require("chai");
const { parseSoftwarePage, pickFor, compareVersions, modelKey, fetchLatest, download } = require("../../lib/moxa/catalog");

// two firmware rows of Moxa's NPort 5100 series page (real markup, 24.11.2026)
const PAGE = fs.readFileSync(path.join(__dirname, "../fixtures/moxa_software_page.html"), "utf8");

describe("Moxa firmware catalog", () => {
    it("reads version, checksum, size and date of the firmware rows", () => {
        const rows = parseSoftwarePage(PAGE);
        expect(rows).to.have.length(2);
        const r = rows.find((x) => /5110/.test(x.label));
        expect(r.version).to.equal("2.11");
        expect(r.date).to.equal("2024-03-15");
        expect(r.size).to.equal("423.5 KB");
        expect(r.sha512).to.match(/^2ce858c12083b70d/);
        expect(r.sha512).to.have.length(128);
        expect(r.url).to.match(/moxa-nport-5110-5110-t-firmware-v2\.11\.rom$/);
    });

    it("picks the right row for the model", () => {
        const rows = parseSoftwarePage(PAGE);
        expect(pickFor(rows, "NPort 5110").version).to.equal("2.11");
        expect(pickFor(rows, "NPort 5110-T").version).to.equal("2.11");
        expect(pickFor(rows, "NPort 5150").version).to.equal("3.11");
        expect(pickFor(rows, "NPort 5110A")).to.equal(null);
        expect(pickFor(rows, "NPort 6150")).to.equal(null);
    });

    it("compares versions numerically", () => {
        expect(compareVersions("2.9", "2.11")).to.be.lessThan(0);
        expect(compareVersions("2.11", "2.11")).to.equal(0);
        expect(compareVersions("3.0", "2.99")).to.be.greaterThan(0);
        expect(compareVersions("2.5.1", "2.5")).to.be.greaterThan(0);
        expect(modelKey("NPort 5110A")).to.equal("5110A");
    });

    it("fetches the latest firmware from the page, and says so when the model is unknown", async () => {
        const f = async () => ({ ok: true, status: 200, text: async () => PAGE });
        const r = await fetchLatest("NPort 5110", f);
        expect(r.ok).to.equal(true);
        expect(r.latest.version).to.equal("2.11");
        expect((await fetchLatest("NPort 5110A", f)).ok).to.equal(false);
        expect((await fetchLatest("NPort 5110", async () => ({ ok: false, status: 503 }))).error).to.contain("503");
        expect((await fetchLatest("NPort 5110", async () => { throw new Error("offline"); })).error).to.contain("offline");
    });

    it("accepts a download only when the SHA-512 matches", async () => {
        const data = crypto.randomBytes(100 * 1024);
        const entry = { url: "http://x/y.rom", sha512: crypto.createHash("sha512").update(data).digest("hex") };
        const f = (d) => async () => ({ ok: true, status: 200, arrayBuffer: async () => d.buffer.slice(d.byteOffset, d.byteOffset + d.length) });
        expect((await download(entry, f(data))).ok).to.equal(true);
        const bad = Buffer.from(data);
        bad[10] ^= 1;
        expect((await download(entry, f(bad))).error).to.contain("Prüfsumme");
        const tiny = Buffer.from("<html>403</html>");
        const e2 = { url: "x", sha512: crypto.createHash("sha512").update(tiny).digest("hex") };
        expect((await download(e2, f(tiny))).error).to.contain("Unplausible");
    });
});
