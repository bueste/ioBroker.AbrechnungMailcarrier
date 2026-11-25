"use strict";

const { expect } = require("chai");
const { Bus } = require("../../lib/mbus/bus");
const { rsp, startSegment } = require("../helpers/segment");

const HOTWATER =
    "684C4C680865724788845474264A062A0000000C7847888454046D390C583B0413786D0300026C7E364413864E0300426C5E368401131AF0020082016C3E360223800FC2026CFA1B01FD170209FD0E14DE16";

describe("Bus", () => {
    let seg;
    afterEach(() => new Promise((r) => (seg ? seg.server.close(r) : r())));

    const bus = (port) => new Bus({ host: "127.0.0.1", port, ackWaitMs: 60, dataWaitMs: 200, connectTimeoutMs: 500 });

    it("reads a meter by primary address", async () => {
        seg = await startSegment([{ addr: 101, frames: [Buffer.from(HOTWATER, "hex")] }]);
        const b = bus(seg.port);
        await b.connect();
        const r = await b.readMeter(101);
        b.close();
        expect(r.ok).to.equal(true);
        expect(r.header.id).to.equal("54848847");
        expect(r.summary.value).to.equal(224.632);
        expect(r.medium_name).to.equal("Hot water");
        // reset first (SND_NKE), then request
        expect(seg.log[0]).to.include({ c: 0x40, a: 101 });
        expect(seg.log[1]).to.include({ c: 0x5b, a: 101 });
    });

    it("follows a multi-telegram answer with the alternating request", async () => {
        const first = rsp("12345678", 0x07, [0x0c, 0x13, 0x45, 0x23, 0x01, 0x00, 0x1f]);
        const second = rsp("12345678", 0x07, [0x4c, 0x13, 0x00, 0x10, 0x01, 0x00, 0x0f]);
        seg = await startSegment([{ addr: 5, frames: [first, second] }]);
        const b = bus(seg.port);
        await b.connect();
        const r = await b.readMeter(5);
        b.close();
        expect(r.ok).to.equal(true);
        expect(r.frames).to.have.length(2);
        expect(r.records.filter((x) => x.q === "Volumen")).to.have.length(2);
        const requests = seg.log.filter((l) => l.c === 0x5b || l.c === 0x7b).map((l) => l.c);
        expect(requests).to.deep.equal([0x5b, 0x7b]);
    });

    it("reports a silent meter and an unknown address", async () => {
        seg = await startSegment([{ addr: 7, silent: true, frames: [] }]);
        const b = bus(seg.port);
        await b.connect();
        const quiet = await b.readMeter(7);
        const none = await b.readMeter(9);
        b.close();
        expect(quiet.ok).to.equal(false);
        expect(none.ok).to.equal(false);
        expect(none.error).to.equal("keine Antwort");
    });

    it("sees a collision on a doubled address as garbage", async () => {
        seg = await startSegment([
            { addr: 0, frames: [] },
            { addr: 0, frames: [] },
        ]);
        const b = bus(seg.port);
        await b.connect();
        expect(await b.nke(0)).to.equal("garbage");
        b.close();
    });

    it("scans the addresses and finds the meters", async () => {
        seg = await startSegment([
            { addr: 3, frames: [] },
            { addr: 12, frames: [] },
        ]);
        const b = bus(seg.port);
        await b.connect();
        const hits = await b.scan(0, 20);
        b.close();
        expect(hits.map((h) => h.addr)).to.deep.equal([3, 12]);
    });

    it("sets the clock when the meter accepts and says so when it does not", async () => {
        const yes = { addr: 1, frames: [], acceptsClock: true };
        const no = { addr: 2, frames: [], acceptsClock: false };
        seg = await startSegment([yes, no]);
        const b = bus(seg.port);
        await b.connect();
        const when = new Date(2026, 10, 24, 20, 30);
        expect((await b.setClock(1, when)).accepted).to.equal(true);
        expect(yes.clock).to.match(/^046d/);
        expect((await b.setClock(2, when)).accepted).to.equal(false);
        b.close();
    });

    it("fails with a readable message when the moxa is not reachable", async () => {
        seg = await startSegment([]);
        const port = seg.port;
        await new Promise((r) => seg.server.close(r));
        seg = null;
        const b = bus(port);
        let msg = "";
        try {
            await b.connect();
        } catch (e) {
            msg = e.message;
        }
        expect(msg).to.contain("127.0.0.1");
    });
});

describe("Bus pause after an answer", () => {
    const net = require("node:net");

    /** A master that ignores a telegram arriving less than 50 ms after its last answer (like the Relay master). */
    function slowTurnaround() {
        let lastAnswer = 0;
        const server = net.createServer((sock) => {
            sock.on("data", (d) => {
                const now = Date.now();
                if (now - lastAnswer < 50) {
                    return;
                }
                if (d[0] === 0x10 && d[1] === 0x40 && [1, 2, 3].includes(d[2])) {
                    lastAnswer = now;
                    sock.write(Buffer.from([0xe5]));
                }
            });
        });
        return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
    }

    it("finds the meter right after a meter that answered, because it waits after every answer", async () => {
        const server = await slowTurnaround();
        const port = server.address().port;
        const quick = new Bus({ host: "127.0.0.1", port, ackWaitMs: 60, guardMs: 0 });
        await quick.connect();
        const missed = await quick.scan(1, 3);
        quick.close();
        const careful = new Bus({ host: "127.0.0.1", port, ackWaitMs: 60 });
        await careful.connect();
        await new Promise((r) => setTimeout(r, 150));
        const found = await careful.scan(1, 3);
        careful.close();
        await new Promise((r) => server.close(r));
        expect(missed.map((h) => h.addr)).to.deep.equal([1, 3]);
        expect(found.map((h) => h.addr)).to.deep.equal([1, 2, 3]);
    });
});
