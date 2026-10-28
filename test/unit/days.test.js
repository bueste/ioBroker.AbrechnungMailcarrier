"use strict";

const { expect } = require("chai");
const { computeDay, mergeDays, missingOnServer, parseSolarlogJournal, MAX_DAYS } = require("../../lib/days");

const meterRow = (over = {}) => ({
    reading_date: "2026-10-24",
    meter_name: "WHG 1",
    zaehlerstand_start_kwh: 100,
    zaehlerstand_ende_kwh: 110.5,
    verbrauch_kwh: 10.5,
    solarbezug_kwh: 4,
    netzbezug_kwh: 6.5,
    tarif_netz: 0.28,
    tarif_solar: 0.2,
    total_chf: 2.92,
    berechnungsmethode: "integriert",
    ...over,
});
const buildingRow = { reading_date: "2026-10-24", produktion_kwh: 30, verbrauch_kwh: 40, einspeisung_kwh: 5, eigenverbrauchsquote: 0.625, berechnungsmethode: "integriert" };

describe("parseSolarlogJournal", () => {
    it("reads days written in the row format of the solarlog adapter", () => {
        const raw = JSON.stringify([{ date: "2026-10-24", meterRows: [meterRow(), meterRow({ meter_name: "Allgemein" })], buildingRow }]);
        const { days, skipped } = parseSolarlogJournal(raw);
        expect(skipped).to.deep.equal([]);
        expect(days).to.have.length(1);
        expect(days[0].method).to.equal("integriert");
        expect(days[0].meters.map((m) => m.meter)).to.deep.equal(["WHG 1", "Allgemein"]);
        expect(days[0].meters[0]).to.include({ verbrauchKwh: 10.5, solarKwh: 4, netzKwh: 6.5, tarifNetz: 0.28, zStartKwh: 100 });
        expect(days[0].building).to.deep.equal({ produktionKwh: 30, verbrauchKwh: 40, einspeisungKwh: 5, autarkiegrad: 0.625 });
    });

    it("skips unusable entries without throwing and keeps the good ones", () => {
        const raw = JSON.stringify([
            { date: "nonsense", meterRows: [meterRow()] },
            { date: "2026-10-23", meterRows: [{ meter_name: "WHG 1", verbrauch_kwh: "abc" }] },
            { date: "2026-10-22", meterRows: [meterRow({ reading_date: "2026-10-22" })], buildingRow: null },
        ]);
        const { days, skipped } = parseSolarlogJournal(raw);
        expect(days.map((d) => d.date)).to.deep.equal(["2026-10-22"]);
        expect(skipped).to.have.length(3); // bad date, incomplete row, and the day that is left without rows
    });

    it("treats empty, broken and non-list content as no days", () => {
        expect(parseSolarlogJournal("").days).to.deep.equal([]);
        expect(parseSolarlogJournal(null).days).to.deep.equal([]);
        expect(parseSolarlogJournal("{kaputt").skipped).to.have.length(1);
        expect(parseSolarlogJournal('{"a":1}').skipped).to.have.length(1);
    });

    it("defaults the method to tagesnetto and honours the quality flag", () => {
        const raw = JSON.stringify([{ date: "2026-10-24", datenqualitaet: "veraltet", meterRows: [meterRow({ berechnungsmethode: undefined })] }]);
        const d = parseSolarlogJournal(raw).days[0];
        expect(d.method).to.equal("tagesnetto");
        expect(d.quality).to.equal("veraltet");
    });

    it("passes the quality vorlaeufig of an intraday snapshot through", () => {
        const raw = JSON.stringify([{ date: "2026-10-24", datenqualitaet: "vorlaeufig", meterRows: [meterRow({})] }]);
        expect(parseSolarlogJournal(raw).days[0].quality).to.equal("vorlaeufig");
    });
});

describe("mergeDays", () => {
    const day = (date, v = 1) => ({ date, method: "tagesnetto", quality: "ok", meters: [{ meter: "WHG 1", verbrauchKwh: v }], building: null });

    it("replaces a day that is already there and keeps the order", () => {
        const merged = mergeDays([day("2026-10-02", 1), day("2026-10-01", 1)], [day("2026-10-02", 9), day("2026-10-03", 3)]);
        expect(merged.map((d) => d.date)).to.deep.equal(["2026-10-01", "2026-10-02", "2026-10-03"]);
        expect(merged[1].meters[0].verbrauchKwh).to.equal(9);
    });

    it("keeps only the newest MAX_DAYS days", () => {
        const many = [];
        for (let i = 0; i < MAX_DAYS + 10; i++) {
            many.push(day(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)));
        }
        const merged = mergeDays([], many);
        expect(merged).to.have.length(MAX_DAYS);
        expect(merged[merged.length - 1].date).to.equal(many[many.length - 1].date);
    });
});

describe("computeDay", () => {
    const meters = [
        { meter: "WHG 1", kwh: 10 },
        { meter: "WHG 2", kwh: 30 },
    ];

    it("splits proportionally when production is lower than consumption (no feed-in meter)", () => {
        const d = computeDay({ date: "2026-10-24", meters, productionKwh: 20, feedinKwh: null });
        expect(d.meters[0].solarKwh).to.be.closeTo(5, 1e-9);
        expect(d.meters[0].netzKwh).to.be.closeTo(5, 1e-9);
        expect(d.meters[1].solarKwh).to.be.closeTo(15, 1e-9);
        expect(d.building).to.deep.include({ produktionKwh: 20, verbrauchKwh: 40, einspeisungKwh: 0, autarkiegrad: 0.5 });
    });

    it("caps at 100 % solar and reports the surplus as feed-in", () => {
        const d = computeDay({ date: "2026-10-24", meters, productionKwh: 100, feedinKwh: null });
        expect(d.meters.every((m) => m.netzKwh === 0)).to.equal(true);
        expect(d.building.einspeisungKwh).to.equal(60);
        expect(d.building.autarkiegrad).to.equal(1);
    });

    it("uses production minus measured feed-in as self-consumption when a feed-in meter exists", () => {
        const d = computeDay({ date: "2026-10-24", meters, productionKwh: 50, feedinKwh: 30 });
        expect(d.building.einspeisungKwh).to.equal(30);
        expect(d.building.autarkiegrad).to.be.closeTo(0.5, 1e-9);
        expect(d.meters[1].solarKwh).to.be.closeTo(15, 1e-9);
    });

    it("never lets solar plus grid differ from the consumption of a unit", () => {
        for (const prod of [0, 7.3, 39.99, 40, 41, 500]) {
            const d = computeDay({ date: "2026-10-24", meters, productionKwh: prod, feedinKwh: null });
            for (const m of d.meters) {
                expect(m.solarKwh + m.netzKwh).to.be.closeTo(m.verbrauchKwh, 1e-9);
                expect(m.solarKwh).to.be.at.least(0);
                expect(m.netzKwh).to.be.at.least(0);
            }
        }
    });

    it("handles a day without any consumption", () => {
        const d = computeDay({ date: "2026-10-24", meters: [{ meter: "WHG 1", kwh: 0 }], productionKwh: 12, feedinKwh: null });
        expect(d.meters[0].solarKwh).to.equal(0);
        expect(d.building.autarkiegrad).to.equal(null);
        expect(d.building.einspeisungKwh).to.equal(12);
    });
});

describe("missingOnServer", () => {
    const day = (date) => ({
        date,
        method: "tagesnetto",
        quality: "ok",
        meters: [
            { meter: "WHG 1", verbrauchKwh: 1 },
            { meter: "WHG 2", verbrauchKwh: 1 },
        ],
        building: { produktionKwh: 1, verbrauchKwh: 1, einspeisungKwh: 0, autarkiegrad: 1 },
    });
    const journal = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"].map(day);

    it("sends only what the server lacks, also gaps in the middle", () => {
        const status = {
            present_meter_dates: { "WHG 1": ["2026-10-10", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"], "WHG 2": ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"] },
            present_building_dates: ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"],
        };
        const out = missingOnServer(journal, status, "2026-10-30");
        expect(out.map((d) => d.date)).to.deep.equal(["2026-10-11"]);
        expect(out[0].meters.map((m) => m.meter)).to.deep.equal(["WHG 1"]);
        expect(out[0].building).to.equal(null);
    });

    it("sends everything to an empty server", () => {
        const out = missingOnServer(journal, {}, "2026-10-30");
        expect(out).to.have.length(6);
        expect(out[0].meters).to.have.length(2);
        expect(out[0].building).to.not.equal(null);
    });

    it("always repeats the most recent days so late corrections arrive", () => {
        const all = {
            present_meter_dates: { "WHG 1": journal.map((d) => d.date), "WHG 2": journal.map((d) => d.date) },
            present_building_dates: journal.map((d) => d.date),
        };
        const out = missingOnServer(journal, all, "2026-10-16");
        expect(out.map((d) => d.date)).to.deep.equal(["2026-10-14", "2026-10-15"]);
        expect(missingOnServer(journal, all, "2026-10-30")).to.deep.equal([]);
    });
});
