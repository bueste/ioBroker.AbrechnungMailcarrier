"use strict";

const { expect } = require("chai");
const { addDays, isDate, localDate, msUntil, parseTime } = require("../../lib/dates");

describe("dates", () => {
    it("localDate uses the local calendar day", () => {
        expect(localDate(new Date(2026, 0, 5, 23, 59))).to.equal("2026-01-05");
        expect(localDate(new Date(2026, 11, 31, 0, 0))).to.equal("2026-12-31");
    });

    it("addDays crosses month and year boundaries", () => {
        expect(addDays("2026-10-31", 1)).to.equal("2026-11-01");
        expect(addDays("2026-01-01", -1)).to.equal("2025-12-31");
        expect(addDays("2024-02-28", 1)).to.equal("2024-02-29");
        expect(addDays("2026-10-25", 0)).to.equal("2026-10-25");
    });

    it("isDate accepts real calendar days only", () => {
        expect(isDate("2026-10-25")).to.equal(true);
        expect(isDate("2026-02-30")).to.equal(false);
        expect(isDate("2026-13-01")).to.equal(false);
        expect(isDate("26-10-25")).to.equal(false);
        expect(isDate(20261025)).to.equal(false);
        expect(isDate(null)).to.equal(false);
    });

    it("parseTime reads HH:MM", () => {
        expect(parseTime("23:58")).to.deep.equal({ hour: 23, minute: 58 });
        expect(parseTime("7:05")).to.deep.equal({ hour: 7, minute: 5 });
        expect(parseTime("24:00")).to.equal(null);
        expect(parseTime("12:60")).to.equal(null);
        expect(parseTime("abc")).to.equal(null);
        expect(parseTime(undefined)).to.equal(null);
    });

    it("msUntil waits until today if the time is ahead, else until tomorrow", () => {
        const now = new Date(2026, 9, 25, 10, 0, 0);
        expect(msUntil(now, 23, 58)).to.equal((13 * 60 + 58) * 60000);
        expect(msUntil(now, 9, 0)).to.equal(23 * 3600000);
        expect(msUntil(now, 10, 0)).to.equal(24 * 3600000);
    });
});
