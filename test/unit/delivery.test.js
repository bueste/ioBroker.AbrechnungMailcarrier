"use strict";

const { expect } = require("chai");
const { createDelivery } = require("../../lib/delivery");

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const day = (date, bad = false) => ({
    date,
    method: "tagesnetto",
    quality: "ok",
    meters: [{ meter: "WHG 1", zStartKwh: null, zEndeKwh: null, verbrauchKwh: bad ? -1 : 10, solarKwh: 4, netzKwh: 6, tarifNetz: null, tarifSolar: null }],
    building: { produktionKwh: 10, verbrauchKwh: 10, einspeisungKwh: 0, autarkiegrad: 0.4 },
});
const ok = (data = {}) => ({ ok: true, status: 200, kind: "ok", message: "ok", details: [], data });
const bad = (kind, message = "m", details = []) => ({ ok: false, status: kind === "rejected" ? 422 : 0, kind, message, details, data: null });

/** Fake server holding what it received; `rules` can make selected requests fail. */
function fakeApi({ status = ok({ tariffs: [{ year: 2026, month: 10, netz_chf_kwh: 0.28, solar_chf_kwh: 0.2 }] }), ingest } = {}) {
    const calls = { status: 0, ingest: [] };
    return {
        calls,
        async status() {
            calls.status++;
            return typeof status === "function" ? status() : status;
        },
        async ingest(payload) {
            calls.ingest.push(payload);
            return ingest ? ingest(payload, calls.ingest.length) : ok({ inserted: 1, updated: 0, unchanged: 0 });
        },
    };
}

function setup(journal, api, maxRows) {
    const info = {};
    const delivery = createDelivery({
        log: quiet,
        api,
        loadJournal: async () => journal,
        setInfo: async (i) => Object.assign(info, i),
        today: () => "2026-10-25",
        version: "0.1.0",
        source: "test",
        maxRows,
    });
    return { delivery, info };
}

describe("delivery", () => {
    it("delivers the days the server lacks and reports the newest one", async () => {
        const api = fakeApi();
        const { delivery, info } = setup([day("2026-10-20"), day("2026-10-21")], api);
        const r = await delivery.sync();
        expect(r).to.include({ outcome: "ok", sentDays: 2, pendingDays: 0 });
        expect(api.calls.ingest).to.have.length(1);
        expect(api.calls.ingest[0].meter_daily.map((m) => m.date)).to.deep.equal(["2026-10-20", "2026-10-21"]);
        expect(info).to.include({ connection: true, lastDeliveredDate: "2026-10-21", pendingDays: 0, lastError: "" });
        expect(info.lastDelivery).to.be.a("string");
    });

    it("notes every successful contact with the server, also when there is nothing to deliver", async () => {
        const api = fakeApi({ status: ok({ tariffs: [], present_meter_dates: { "WHG 1": ["2026-10-01"] }, present_building_dates: ["2026-10-01"] }) });
        const { delivery, info } = setup([day("2026-10-01")], api);
        await delivery.sync();
        expect(Date.parse(info.lastContact)).to.be.closeTo(Date.now(), 5000);
    });

    it("does not note a contact when the server cannot be reached", async () => {
        const { delivery, info } = setup([day("2026-10-20")], fakeApi({ status: bad("transient") }));
        await delivery.sync();
        expect(info.lastContact).to.equal(undefined);
    });

    it("takes the tariff from the server's status", async () => {
        const api = fakeApi();
        await setup([day("2026-10-20")], api).delivery.sync();
        expect(api.calls.ingest[0].meter_daily[0]).to.deep.include({ tarif_netz: 0.28, tarif_solar: 0.2, total_chf: 2.48 });
    });

    it("sends nothing if the server has everything (only the recent days are repeated)", async () => {
        const api = fakeApi({ status: ok({ tariffs: [], present_meter_dates: { "WHG 1": ["2026-10-01"] }, present_building_dates: ["2026-10-01"] }) });
        const { delivery } = setup([day("2026-10-01")], api);
        const r = await delivery.sync();
        expect(r.sentDays).to.equal(0);
        expect(api.calls.ingest).to.have.length(0);
    });

    it("keeps retrying later when the server cannot be reached", async () => {
        const api = fakeApi({ status: bad("transient", "timeout") });
        const { delivery, info } = setup([day("2026-10-20")], api);
        const r = await delivery.sync();
        expect(r).to.include({ outcome: "transient", retrySoon: true, pendingDays: 1 });
        expect(info.lastError).to.equal("timeout");
        expect(api.calls.ingest).to.have.length(0);
    });

    it("does not retry after a rejected token and shows the connection as down", async () => {
        const api = fakeApi({ status: bad("auth", "Token revoked") });
        const { delivery, info } = setup([day("2026-10-20")], api);
        const r = await delivery.sync();
        expect(r).to.include({ outcome: "auth", retrySoon: false });
        expect(info.connection).to.equal(false);
    });

    it("stops at a network failure during delivery and keeps what was accepted", async () => {
        const api = fakeApi({ ingest: (payload, n) => (n === 1 ? ok({ inserted: 1 }) : bad("transient", "reset")) });
        const days = ["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => day(d));
        // 2 rows per request: one day per request
        const { delivery, info } = setup(days, api, 2);
        const r = await delivery.sync();
        expect(r).to.include({ outcome: "transient", retrySoon: true, sentDays: 1 });
        expect(info.lastDeliveredDate).to.equal("2026-10-01");
    });

    it("isolates a day the server refuses and still delivers the others", async () => {
        const api = fakeApi({
            ingest: (payload) => (payload.meter_daily.some((m) => m.verbrauch_kwh < 0) ? bad("rejected", "refused", ["verbrauch_kwh negativ"]) : ok({ inserted: 1 })),
        });
        const { delivery, info } = setup([day("2026-10-01"), day("2026-10-02", true), day("2026-10-03")], api);
        const r = await delivery.sync();
        expect(r.outcome).to.equal("rejected");
        expect(r.rejectedDates).to.deep.equal(["2026-10-02"]);
        expect(r.sentDays).to.equal(2);
        expect(r.pendingDays).to.equal(1);
        expect(r.retrySoon).to.equal(false);
        expect(info.rejectedDates).to.deep.equal(["2026-10-02"]);
        expect(info.lastDeliveredDate).to.equal("2026-10-03");
    });

    it("does not run twice at the same time", async () => {
        let release;
        const gate = new Promise((r) => (release = r));
        const api = fakeApi({ status: async () => (await gate, ok({ tariffs: [] })) });
        const { delivery } = setup([day("2026-10-20")], api);
        const first = delivery.sync();
        const second = await delivery.sync();
        expect(second.outcome).to.equal("idle");
        release();
        expect((await first).outcome).to.equal("ok");
    });

    it("has nothing to do for an empty journal", async () => {
        const api = fakeApi();
        const r = await setup([], api).delivery.sync();
        expect(r).to.include({ outcome: "ok", sentDays: 0, pendingDays: 0 });
        expect(api.calls.status).to.equal(1);
    });
});

