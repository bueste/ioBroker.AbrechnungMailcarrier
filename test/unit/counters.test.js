"use strict";

const { expect } = require("chai");
const { closeDay, parseCounterConfig, toKwh } = require("../../lib/counters");

const config = (over = {}) => ({
    meters: [
        { name: "WHG 1", stateId: "shelly.0.a.total", unit: "Wh", mode: "counter" },
        { name: "WHG 2", stateId: "shelly.0.b.total", unit: "kWh", mode: "counter" },
    ],
    production: [{ stateId: "goodwe.0.today", unit: "kWh", mode: "daily" }],
    feedin: [],
    staleMinutes: 60,
    ...over,
});
const NOW = Date.parse("2026-10-24T21:58:00Z");
const states = (map, ts = NOW - 60000) => (id) => (id in map ? { val: map[id], ts } : null);

describe("toKwh", () => {
    it("converts units and rejects non-numbers", () => {
        expect(toKwh(2500, "Wh")).to.equal(2.5);
        expect(toKwh("12.5", "kWh")).to.equal(12.5);
        expect(toKwh(null, "kWh")).to.equal(null);
        expect(toKwh("abc", "kWh")).to.equal(null);
        expect(toKwh(true, "kWh")).to.equal(null);
        expect(toKwh("", "kWh")).to.equal(null);
    });
});

describe("closeDay", () => {
    const readings = { "shelly.0.a.total": 150000, "shelly.0.b.total": 80, "goodwe.0.today": 10 };

    it("the first run only sets the starting point and builds no day", () => {
        const r = closeDay({ date: "2026-10-24", config: config(), getState: states(readings), snapshot: null, nowMs: NOW });
        expect(r.day).to.equal(null);
        expect(r.snapshot).to.deep.equal({ date: "2026-10-24", values: { "shelly.0.a.total": 150, "shelly.0.b.total": 80 } });
    });

    it("builds the day from the difference to yesterday's readings", () => {
        const snapshot = { date: "2026-10-23", values: { "shelly.0.a.total": 140, "shelly.0.b.total": 70 } };
        const r = closeDay({ date: "2026-10-24", config: config(), getState: states(readings), snapshot, nowMs: NOW });
        expect(r.day.meters.map((m) => [m.meter, m.verbrauchKwh])).to.deep.equal([["WHG 1", 10], ["WHG 2", 10]]);
        // 10 kWh produced, 20 kWh consumed -> half of every unit is solar
        expect(r.day.meters[0].solarKwh).to.be.closeTo(5, 1e-9);
        expect(r.day.building).to.deep.include({ produktionKwh: 10, verbrauchKwh: 20, einspeisungKwh: 0 });
        expect(r.day.quality).to.equal("ok");
        expect(r.snapshot.values["shelly.0.a.total"]).to.equal(150);
    });

    it("treats a counter that went back as reset and uses its new value", () => {
        const snapshot = { date: "2026-10-23", values: { "shelly.0.a.total": 900, "shelly.0.b.total": 70 } };
        const r = closeDay({ date: "2026-10-24", config: config(), getState: states(readings), snapshot, nowMs: NOW });
        expect(r.day.meters[0].verbrauchKwh).to.equal(150);
        expect(r.warnings.join(" ")).to.match(/went back/);
    });

    it("does not make up days when the last reading is older than yesterday", () => {
        const snapshot = { date: "2026-10-20", values: { "shelly.0.a.total": 100, "shelly.0.b.total": 50 } };
        const r = closeDay({ date: "2026-10-24", config: config(), getState: states(readings), snapshot, nowMs: NOW });
        expect(r.day).to.equal(null);
        expect(r.warnings.join(" ")).to.match(/skipped/);
        expect(r.snapshot.date).to.equal("2026-10-24");
    });

    it("builds no day if a reading is missing, but still moves the readings that exist", () => {
        const snapshot = { date: "2026-10-23", values: { "shelly.0.a.total": 140, "shelly.0.b.total": 70 } };
        const r = closeDay({ date: "2026-10-24", config: config(), getState: states({ "shelly.0.a.total": 150000, "goodwe.0.today": 10 }), snapshot, nowMs: NOW });
        expect(r.day).to.equal(null);
        expect(r.snapshot.values).to.deep.equal({ "shelly.0.a.total": 150 });
    });

    it("marks the day as outdated when a reading is older than the limit", () => {
        const snapshot = { date: "2026-10-23", values: { "shelly.0.a.total": 140, "shelly.0.b.total": 70 } };
        const r = closeDay({ date: "2026-10-24", config: config(), getState: states(readings, NOW - 3 * 3600 * 1000), snapshot, nowMs: NOW });
        expect(r.day.quality).to.equal("veraltet");
    });

    it("uses a measured feed-in for the self-consumption", () => {
        const snapshot = { date: "2026-10-23", values: { "shelly.0.a.total": 140, "shelly.0.b.total": 70, "grid.out": 5 } };
        const cfg = config({ feedin: [{ stateId: "grid.out", unit: "kWh", mode: "counter" }] });
        const r = closeDay({ date: "2026-10-24", config: cfg, getState: states({ ...readings, "grid.out": 11, "goodwe.0.today": 18 }), snapshot, nowMs: NOW });
        expect(r.day.building).to.deep.include({ produktionKwh: 18, einspeisungKwh: 6 });
        expect(r.day.building.autarkiegrad).to.be.closeTo(12 / 20, 1e-9);
    });

    it("falls back to the balance if the feed-in reading is missing", () => {
        const snapshot = { date: "2026-10-23", values: { "shelly.0.a.total": 140, "shelly.0.b.total": 70 } };
        const cfg = config({ feedin: [{ stateId: "grid.out", unit: "kWh", mode: "counter" }] });
        const r = closeDay({ date: "2026-10-24", config: cfg, getState: states(readings), snapshot, nowMs: NOW });
        expect(r.day).to.not.equal(null);
        expect(r.day.building.einspeisungKwh).to.equal(0);
    });

    it("adds up several production states", () => {
        const snapshot = { date: "2026-10-23", values: { "shelly.0.a.total": 140, "shelly.0.b.total": 70 } };
        const cfg = config({ production: [{ stateId: "goodwe.0.today", unit: "kWh", mode: "daily" }, { stateId: "solinteg.0.today", unit: "Wh", mode: "daily" }] });
        const r = closeDay({ date: "2026-10-24", config: cfg, getState: states({ ...readings, "solinteg.0.today": 4000 }), snapshot, nowMs: NOW });
        expect(r.day.building.produktionKwh).to.equal(14);
    });

    it("does not close the same day twice", () => {
        const snapshot = { date: "2026-10-24", values: { "shelly.0.a.total": 150, "shelly.0.b.total": 80 } };
        const r = closeDay({ date: "2026-10-24", config: config(), getState: states(readings), snapshot, nowMs: NOW });
        expect(r.day).to.equal(null);
        expect(r.snapshot).to.equal(snapshot);
    });
});

describe("parseCounterConfig", () => {
    it("takes the table rows and applies defaults", () => {
        const { config: c, errors } = parseCounterConfig({
            meters: [{ name: " WHG 1 ", stateId: "a.b", unit: "Wh", mode: "daily" }, { name: "", stateId: "" }, { name: "WHG 2", stateId: "c.d" }],
            production: [{ stateId: "p.1" }, { stateId: "" }],
            feedin: undefined,
            staleMinutes: "30",
        });
        expect(errors).to.deep.equal([]);
        expect(c.meters).to.deep.equal([
            { name: "WHG 1", stateId: "a.b", unit: "Wh", mode: "daily" },
            { name: "WHG 2", stateId: "c.d", unit: "kWh", mode: "counter" },
        ]);
        expect(c.production).to.deep.equal([{ stateId: "p.1", unit: "kWh", mode: "counter" }]);
        expect(c.feedin).to.deep.equal([]);
        expect(c.staleMinutes).to.equal(30);
    });

    it("reports invalid and duplicate unit names", () => {
        const { config: c, errors } = parseCounterConfig({
            meters: [{ name: "<x>", stateId: "a.b" }, { name: "WHG 1", stateId: "c" }, { name: "WHG 1", stateId: "d" }, { name: "WHG 3", stateId: "" }],
        });
        expect(errors).to.have.length(3);
        expect(c.meters.map((m) => m.name)).to.deep.equal(["WHG 1"]);
        expect(c.staleMinutes).to.equal(60);
    });
});
