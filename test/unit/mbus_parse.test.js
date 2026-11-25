"use strict";

const { expect } = require("chai");
const { takeFrame, shortFrame, longFrame } = require("../../lib/mbus/frame");
const { parseTelegram, summarize, mediumName, encodeDateF, dateF } = require("../../lib/mbus/parse");

// Real telegrams from the scan of 24.11.2026 (heat meter RKE address 1, hot water IST 101, cold water IST 201).
const HEAT =
    "68BABA680801721717045565496904670000000C7817170455046D1013583B0415AD04040044156CF10300840115BDFE030084101500000000C4101500000000841115000000000405A353070044052F3E0700840105A147070084100500000000C410050000000084110500000000426C5E36026C7E36043B00000000143BFA030000042B00000000142B001B0000025B1B00025F1B00046090FFFFFF0222000042232C090223BA0EC2026CEB1C01FD17000490281200000002FB775A000916";
const HOTWATER =
    "684C4C680865724788845474264A062A0000000C7847888454046D390C583B0413786D0300026C7E364413864E0300426C5E368401131AF0020082016C3E360223800FC2026CFA1B01FD170209FD0E14DE16";
const COLDWATER =
    "684C4C6808C97219898454742649072C0000000C7819898454046D080D583B04130F6C0600026C7E36441334240600426C5E36840113BB75050082016C3E360223810FC2026CFB1B01FD170209FD0E140516";

function read(hex) {
    const f = takeFrame(Buffer.from(hex, "hex"));
    expect(f.kind).to.equal("long");
    const t = parseTelegram(f.data, f.ci);
    expect(t.ok).to.equal(true);
    expect(t.errors).to.deep.equal([]);
    return { header: t.header, summary: summarize(t.header, t.records), records: t.records };
}

describe("M-Bus frames", () => {
    it("builds a short frame with checksum", () => {
        expect([...shortFrame(0x40, 1)]).to.deep.equal([0x10, 0x40, 0x01, 0x41, 0x16]);
    });

    it("builds and re-reads a long frame", () => {
        const f = longFrame(0x53, 5, 0x51, [0x04, 0x6d, 1, 2, 3, 4]);
        const r = takeFrame(f);
        expect(r.kind).to.equal("long");
        expect(r.a).to.equal(5);
        expect([...r.data]).to.deep.equal([0x04, 0x6d, 1, 2, 3, 4]);
    });

    it("recognises ack, waits for incomplete frames, skips noise and refuses a wrong checksum", () => {
        expect(takeFrame(Buffer.from([0xe5])).kind).to.equal("ack");
        expect(takeFrame(Buffer.from([0x00, 0x00, 0xe5])).kind).to.equal("ack");
        expect(takeFrame(Buffer.from([0x68, 0x04, 0x04])).kind).to.equal("none");
        const f = Buffer.from(HOTWATER, "hex");
        expect(takeFrame(f.subarray(0, 30)).kind).to.equal("none");
        const bad = Buffer.from(f);
        bad[bad.length - 2] ^= 1;
        expect(takeFrame(bad).kind).to.equal("garbage");
        expect(takeFrame(Buffer.from([0, 0, 0])).kind).to.equal("garbage");
    });

    it("returns the rest after a frame", () => {
        const both = Buffer.concat([Buffer.from([0xe5]), shortFrame(0x5b, 1)]);
        const r = takeFrame(both);
        expect(r.kind).to.equal("ack");
        expect(takeFrame(r.rest).kind).to.equal("short");
    });
});

describe("M-Bus telegram parsing (real meters)", () => {
    it("reads the hot water meter", () => {
        const { header, summary } = read(HOTWATER);
        expect(header.id).to.equal("54848847");
        expect(header.manufacturer).to.equal("IST");
        expect(header.medium).to.equal(0x06);
        expect(mediumName(header.medium)).to.equal("Hot water");
        expect(summary.value).to.equal(224.632);
        expect(summary.unit).to.equal("m3");
        expect(summary.flags).to.equal(2);
        expect(summary.meterTime).to.equal("2026-11-24 12:57");
        expect(summary.extra.stored[0]).to.deep.include({ storage: 1, date: "2026-06-30", value: 216.71 });
        expect(summary.extra.stored[1]).to.deep.include({ storage: 2, date: "2025-06-30", value: 192.538 });
    });

    it("reads the cold water meter", () => {
        const { header, summary } = read(COLDWATER);
        expect(header.id).to.equal("54848919");
        expect(summary.value).to.equal(420.879);
        expect(summary.extra.stored[0].value).to.equal(402.484);
    });

    it("reads the heat meter: energy in kWh as main value, volume as second value", () => {
        const { header, summary } = read(HEAT);
        expect(header.id).to.equal("55041717");
        expect(header.manufacturer).to.equal("RKE");
        expect(header.medium).to.equal(0x04);
        expect(summary.value).to.equal(48016.3);
        expect(summary.unit).to.equal("kWh");
        expect(summary.value2).to.equal(26334.1);
        expect(summary.unit2).to.equal("m3");
        expect(summary.flags).to.equal(0);
        expect(summary.meterTime).to.equal("2026-11-24 19:16");
        expect(summary.extra.stored[0]).to.deep.include({ storage: 1, date: "2026-06-30", value: 47467.1, value2: 25841.2 });
    });

    it("reports a truncated telegram instead of throwing", () => {
        const f = takeFrame(Buffer.from(HOTWATER, "hex"));
        const t = parseTelegram(f.data.subarray(0, 20), f.ci);
        expect(t.ok).to.equal(true);
        expect(t.errors.length).to.be.greaterThan(0);
    });

    it("refuses an unsupported CI", () => {
        expect(parseTelegram(Buffer.alloc(20), 0x7a).ok).to.equal(false);
    });
});

describe("date and time", () => {
    it("round-trips type F", () => {
        const d = new Date(2026, 10, 24, 19, 16);
        expect(dateF(encodeDateF(d))).to.equal("2026-11-24 19:16");
        const s = new Date(2026, 6, 15, 8, 5);
        expect(dateF(encodeDateF(s))).to.equal("2026-07-15 08:05");
    });
});
