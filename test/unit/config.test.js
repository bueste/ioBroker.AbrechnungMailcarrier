"use strict";

const assert = require("node:assert/strict");
const { applyUnitMap, buildBaseUrl } = require("../../lib/config");

describe("buildBaseUrl", () => {
    it("builds an https URL from a host name", () => {
        assert.deepEqual(buildBaseUrl({ host: "abr.example.ch", apiPath: "/api/v1" }), {
            baseUrl: "https://abr.example.ch/api/v1",
            error: "",
        });
    });

    it("uses /api/v1 when no path is given and tolerates a missing slash or a trailing one", () => {
        assert.equal(buildBaseUrl({ host: "abr.example.ch" }).baseUrl, "https://abr.example.ch/api/v1");
        assert.equal(buildBaseUrl({ host: "abr.example.ch", apiPath: "api/v1/" }).baseUrl, "https://abr.example.ch/api/v1");
    });

    it("strips a pasted scheme and trailing slashes from the host, but never keeps http", () => {
        assert.equal(buildBaseUrl({ host: "http://abr.example.ch/" }).baseUrl, "https://abr.example.ch/api/v1");
        assert.equal(buildBaseUrl({ host: "https://abr.example.ch" }).baseUrl, "https://abr.example.ch/api/v1");
    });

    it("accepts a port", () => {
        assert.equal(buildBaseUrl({ host: "abr.example.ch:8443" }).baseUrl, "https://abr.example.ch:8443/api/v1");
    });

    it("allows plain http only for localhost", () => {
        assert.equal(buildBaseUrl({ host: "127.0.0.1:8080" }).baseUrl, "http://127.0.0.1:8080/api/v1");
        assert.equal(buildBaseUrl({ host: "localhost" }).baseUrl, "http://localhost/api/v1");
        assert.equal(buildBaseUrl({ host: "10.0.0.5" }).baseUrl, "https://10.0.0.5/api/v1");
    });

    it("rejects invalid hosts and paths", () => {
        for (const host of ["", "  ", "abr example.ch", "abr.example.ch/api", "user@abr.example.ch", "abr.example.ch:99999x", "-.ch"]) {
            assert.notEqual(buildBaseUrl({ host }).error, "", `host ${JSON.stringify(host)}`);
        }
        assert.notEqual(buildBaseUrl({ host: "abr.example.ch", apiPath: "/api/../x?y" }).error, "");
        assert.notEqual(buildBaseUrl({ host: "abr.example.ch", apiPath: "/a b" }).error, "");
    });

    it("still reads the full URL of an earlier version", () => {
        assert.equal(
            buildBaseUrl({ apiUrl: "https://abr.example.ch/api/v1" }).baseUrl,
            "https://abr.example.ch/api/v1",
        );
        assert.notEqual(buildBaseUrl({ apiUrl: "ftp://x" }).error, "");
    });
});

describe("applyUnitMap", () => {
    const day = (meters) => [{ date: "2026-10-01", meters, building: null }];
    const m = (meter) => ({ meter, total_kwh: 1 });

    it("returns the days unchanged without rules", () => {
        const days = day([m("A")]);
        assert.equal(applyUnitMap(days, []), days);
        assert.equal(applyUnitMap(days, undefined), days);
    });

    it("renames and skips units", () => {
        const out = applyUnitMap(day([m("A"), m("B"), m("C")]), [
            { source: "A", target: "WHG 1" },
            { source: "B", skip: true },
        ]);
        assert.deepEqual(out[0].meters.map((x) => x.meter), ["WHG 1", "C"]);
    });

    it("keeps only the first unit when two end up with the same name", () => {
        const out = applyUnitMap(day([m("A"), m("B")]), [
            { source: "A", target: "X" },
            { source: "B", target: "X" },
        ]);
        assert.equal(out[0].meters.length, 1);
    });

    it("ignores rows without a source name", () => {
        const days = day([m("A")]);
        assert.equal(applyUnitMap(days, [{ source: "", target: "Z" }]), days);
    });
});
