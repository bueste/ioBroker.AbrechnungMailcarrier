"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { encPassword } = require("../../lib/moxa/auth");

const LOGIN = fs.readFileSync(path.join(__dirname, "../fixtures/moxa_login_page.html"), "latin1");

/**
 * A stand-in for the web console of an NPort, built from what the real login page shows and from how such consoles
 * are laid out. It only proves that the adapter's logic works against a console of this shape; the pages of the
 * real device are discovered at run time (and reported when they differ).
 *
 * @param {{ password?: string, firmware?: string, model?: string, noForm?: boolean, newVersionOnUpload?: boolean, downMs?: number }} [opt]
 */
function startFakeMoxa(opt = {}) {
    const o = { password: "moxa", firmware: "2.9", model: "NPort 5110", noForm: false, newVersionOnUpload: true, downMs: 150, ...opt };
    const st = {
        firmware: o.firmware,
        challenges: new Set(),
        sessions: new Set(),
        hits: [],
        uploads: [],
        downUntil: 0,
        pendingVersion: null,
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        st.hits.push(`${req.method} ${url.pathname}`);
        if (Date.now() < st.downUntil) {
            req.socket.destroy();
            return;
        }
        if (st.pendingVersion && Date.now() >= st.downUntil) {
            st.firmware = st.pendingVersion;
            st.pendingVersion = null;
            st.sessions.clear();
        }
        const send = (code, body, type = "text/html", extra = {}) => {
            res.writeHead(code, { "Content-Type": type, ...extra });
            res.end(body);
        };
        const loginPage = () => {
            const c = crypto.randomBytes(32).toString("hex").toUpperCase();
            st.challenges.add(c);
            return LOGIN.replace(/set\("FakeChallenge","[0-9A-F]+"\)/, `set("FakeChallenge","${c}")`);
        };
        const authed = () => /sid=([0-9a-f]+)/.test(req.headers.cookie || "") && st.sessions.has(/sid=([0-9a-f]+)/.exec(req.headers.cookie || "")[1]);
        if (url.pathname === "/") {
            return send(200, loginPage());
        }
        if (url.pathname === "/home.htm" && url.searchParams.has("EncPasswd")) {
            const c = url.searchParams.get("FakeChallenge");
            if (c && st.challenges.has(c) && url.searchParams.get("EncPasswd") === encPassword(o.password, c)) {
                const sid = crypto.randomBytes(8).toString("hex");
                st.sessions.add(sid);
                return send(200, '<html><frameset><frame src="menu.htm"></frameset></html>', "text/html", { "Set-Cookie": `sid=${sid}; path=/` });
            }
            return send(200, loginPage());
        }
        if (!authed()) {
            return send(200, loginPage());
        }
        if (url.pathname === "/home.htm") {
            return send(200, "<html><frameset><frame src=menu.htm></frameset></html>");
        }
        if (url.pathname === "/menu.htm") {
            return send(
                200,
                '<a href="overview.htm">Overview</a> <a href="firmware.htm">Firmware Upgrade</a> <a href="restart.htm">Restart</a> <a href="default.htm">Load Factory Default</a> <a href="logout.htm">Logout</a> <a href="exportcfg.htm">Export Configuration</a>',
            );
        }
        if (url.pathname === "/overview.htm") {
            return send(200, `<html><body><table><tr><td>Model name</td><td>${o.model}</td></tr><tr><td>MAC address</td><td>00:90:E8:EE:51:A1</td></tr><tr><td>Firmware version</td><td>${st.firmware} Build 17072815</td></tr></table></body></html>`);
        }
        if (url.pathname === "/firmware.htm") {
            return send(
                200,
                o.noForm
                    ? "<html><body>Firmware upgrade is done with the NPort Administration Suite.</body></html>"
                    : '<html><body><form method="POST" action="/fwupload.htm" enctype="multipart/form-data"><input type="hidden" name="token_text" value="abc"><input type="file" name="Firmware"><input type="submit"></form></body></html>',
            );
        }
        if (url.pathname === "/exportcfg.htm") {
            return send(200, "[NPort]\nname=test\n", "application/octet-stream");
        }
        if (url.pathname === "/fwupload.htm" && req.method === "POST") {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks);
                st.uploads.push({ bytes: body.length, type: req.headers["content-type"], head: body.subarray(0, 400).toString("latin1") });
                send(200, "<html>Upgrade in progress</html>");
                st.downUntil = Date.now() + o.downMs;
                st.pendingVersion = o.newVersionOnUpload ? "2.11" : null;
            });
            return;
        }
        // restart, default, logout: the adapter must never request these while looking around
        send(200, "<html>done</html>");
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, st })));
}

module.exports = { startFakeMoxa };
