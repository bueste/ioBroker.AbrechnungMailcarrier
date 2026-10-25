"use strict";

const http = require("node:http");
const { expect } = require("chai");
const { ApiClient } = require("../../lib/api");

/** Minimal stand-in for the web application's API, over real HTTP. */
function startServer(handler) {
    return new Promise((resolve) => {
        const requests = [];
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                requests.push({ method: req.method, url: req.url, headers: req.headers, body });
                const out = handler(req, body);
                res.writeHead(out.status, { "Content-Type": "application/json" });
                res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/api/v1` }));
    });
}

describe("ApiClient", () => {
    let srv;
    afterEach(() => new Promise((r) => (srv ? srv.server.close(r) : r())));

    it("sends the bearer token and reads the status", async () => {
        srv = await startServer(() => ({ status: 200, body: { ok: true, units: [], tariffs: [] } }));
        const res = await new ApiClient({ baseUrl: srv.url, token: "abrk_x" }).status();
        expect(res.ok).to.equal(true);
        expect(res.data.tariffs).to.deep.equal([]);
        expect(srv.requests[0]).to.deep.include({ method: "GET", url: "/api/v1/status.php" });
        expect(srv.requests[0].headers.authorization).to.equal("Bearer abrk_x");
    });

    it("posts the payload as JSON", async () => {
        srv = await startServer(() => ({ status: 200, body: { ok: true, inserted: 2 } }));
        const res = await new ApiClient({ baseUrl: `${srv.url}/`, token: "t" }).ingest({ schema: 1, meter_daily: [] });
        expect(res.ok).to.equal(true);
        expect(srv.requests[0].method).to.equal("POST");
        expect(srv.requests[0].headers["content-type"]).to.equal("application/json");
        expect(JSON.parse(srv.requests[0].body)).to.deep.equal({ schema: 1, meter_daily: [] });
    });

    it("tells apart a wrong token, a refused content and server trouble", async () => {
        const cases = [
            [401, "auth"],
            [403, "auth"],
            [422, "rejected"],
            [400, "rejected"],
            [413, "rejected"],
            [429, "transient"],
            [500, "transient"],
            [503, "transient"],
        ];
        for (const [status, kind] of cases) {
            srv = await startServer(() => ({ status, body: { ok: false, error: "x", message: "m", details: ["d1"] } }));
            const res = await new ApiClient({ baseUrl: srv.url, token: "t" }).ingest({});
            expect(res.ok, String(status)).to.equal(false);
            expect(res.kind, String(status)).to.equal(kind);
            expect(res.message).to.equal("m");
            expect(res.details).to.deep.equal(["d1"]);
            await new Promise((r) => srv.server.close(r));
            srv = null;
        }
    });

    it("treats a 200 that is not the API's answer as a transient fault", async () => {
        srv = await startServer(() => ({ status: 200, body: "<html>captive portal</html>" }));
        const res = await new ApiClient({ baseUrl: srv.url, token: "t" }).status();
        expect(res.ok).to.equal(false);
        expect(res.kind).to.equal("transient");
    });

    it("treats an unreachable server as transient", async () => {
        const res = await new ApiClient({ baseUrl: "http://127.0.0.1:1/api/v1", token: "t", timeoutMs: 2000 }).status();
        expect(res.ok).to.equal(false);
        expect(res.kind).to.equal("transient");
        expect(res.status).to.equal(0);
    });

    it("refuses a plain http URL to a remote host and an empty token without any request", async () => {
        const remote = await new ApiClient({ baseUrl: "http://abr.example.ch/api/v1", token: "t" }).status();
        expect(remote.kind).to.equal("rejected");
        const none = await new ApiClient({ baseUrl: "https://abr.example.ch/api/v1", token: "" }).status();
        expect(none.kind).to.equal("auth");
    });

    it("does not follow redirects (the token must not travel to another address)", async () => {
        srv = await startServer(() => ({ status: 200, body: { ok: true } }));
        const redirecting = http.createServer((req, res) => {
            res.writeHead(302, { Location: `${srv.url}/status.php` });
            res.end();
        });
        await new Promise((r) => redirecting.listen(0, "127.0.0.1", r));
        const res = await new ApiClient({ baseUrl: `http://127.0.0.1:${redirecting.address().port}/api/v1`, token: "t" }).status();
        redirecting.close();
        expect(res.ok).to.equal(false);
        expect(srv.requests).to.have.length(0);
    });
});
