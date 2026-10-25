"use strict";

const { expect } = require("chai");
const { buildPayloads, tariffFor } = require("../../lib/payload");

const day = (date, over = {}) => ({
    date,
    method: "integriert",
    quality: "ok",
    meters: [
        { meter: "WHG 1", zStartKwh: 100, zEndeKwh: 110.5, verbrauchKwh: 10.5, solarKwh: 4.0004, netzKwh: 6.4996, tarifNetz: null, tarifSolar: null },
        { meter: "Allgemein", zStartKwh: null, zEndeKwh: null, verbrauchKwh: 2, solarKwh: 1, netzKwh: 1, tarifNetz: null, tarifSolar: null },
    ],
    building: { produktionKwh: 30, verbrauchKwh: 40, einspeisungKwh: 5, autarkiegrad: 0.62499 },
    ...over,
});
const opts = { source: "test", version: "0.1.0" };

describe("tariffFor", () => {
    const server = [{ year: 2026, month: 10, netz_chf_kwh: 0.31, solar_chf_kwh: 0.22 }];
    it("prefers the server's tariff of the month", () => {
        expect(tariffFor("2026-10-24", server, 0.28, 0.2)).to.deep.equal({ netz: 0.31, solar: 0.22 });
    });
    it("falls back to the tariff the source brought along, else none", () => {
        expect(tariffFor("2026-11-01", server, 0.28, 0.2)).to.deep.equal({ netz: 0.28, solar: 0.2 });
        expect(tariffFor("2026-11-01", server, null, null)).to.equal(null);
        expect(tariffFor("2026-11-01", server, 0.28, null)).to.equal(null);
    });
});

describe("buildPayloads", () => {
    const server = [{ year: 2026, month: 10, netz_chf_kwh: 0.28, solar_chf_kwh: 0.2 }];

    it("builds the rows in the format of the API, rounded, with total from the rounded kWh", () => {
        const [req] = buildPayloads([day("2026-10-24")], server, opts);
        expect(req.dates).to.deep.equal(["2026-10-24"]);
        expect(req.payload).to.include({ schema: 1, source: "test", adapter_version: "0.1.0" });
        const [m, allg] = req.payload.meter_daily;
        expect(m).to.deep.include({ date: "2026-10-24", meter: "WHG 1", verbrauch_kwh: 10.5, solarbezug_kwh: 4, netzbezug_kwh: 6.5, methode: "integriert", quality: "ok", tarif_netz: 0.28, tarif_solar: 0.2, zaehlerstand_start_kwh: 100, zaehlerstand_ende_kwh: 110.5 });
        expect(m.total_chf).to.equal(Math.round((4 * 0.2 + 6.5 * 0.28) * 100) / 100);
        expect(allg).to.not.have.property("zaehlerstand_start_kwh");
        expect(req.payload.building_daily[0]).to.deep.equal({ date: "2026-10-24", produktion_kwh: 30, verbrauch_kwh: 40, einspeisung_kwh: 5, methode: "integriert", quality: "ok", autarkiegrad: 0.625 });
    });

    it("leaves the tariff out when nobody knows one", () => {
        const [req] = buildPayloads([day("2026-12-01")], [], opts);
        expect(req.payload.meter_daily[0]).to.not.have.any.keys("tarif_netz", "tarif_solar", "total_chf");
    });

    it("omits the building row when the day has none", () => {
        const [req] = buildPayloads([day("2026-10-24", { building: null })], server, opts);
        expect(req.payload.building_daily).to.deep.equal([]);
    });

    it("splits into several requests without ever splitting a day", () => {
        const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"].map((d) => day(d));
        const reqs = buildPayloads(days, server, { ...opts, maxRows: 7 }); // 3 rows per day -> 2 days per request
        expect(reqs.map((r) => r.dates.length)).to.deep.equal([2, 2, 1]);
        for (const r of reqs) {
            expect(r.payload.meter_daily.length + r.payload.building_daily.length).to.be.at.most(7);
        }
    });

    it("returns no request for no days", () => {
        expect(buildPayloads([], server, opts)).to.deep.equal([]);
    });
});
