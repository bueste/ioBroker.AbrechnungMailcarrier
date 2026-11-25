"use strict";

const net = require("node:net");
const { takeFrame, longFrame } = require("../../lib/mbus/frame");

/** Header of an RSP_UD with the given 8 digit id, medium and record bytes. */
function rsp(id, medium, records) {
    const idb = Buffer.from(
        id
            .match(/../g)
            .reverse()
            .map((h) => parseInt(h, 16)),
    );
    return longFrame(0x08, 0x01, 0x72, Buffer.concat([idb, Buffer.from([0x26, 0x4a, 0x01, medium, 0x07, 0x00, 0x00, 0x00]), Buffer.from(records)]));
}

/**
 * A very small M-Bus segment behind a TCP port: meters answer SND_NKE with E5 and REQ_UD2 with their
 * telegrams, and accept a clock setting if they allow it.
 *
 * @param {{ addr: number, frames: Buffer[], silent?: boolean, acceptsClock?: boolean, sent?: number, clock?: string }[]} meters
 * @returns {Promise<{ server: net.Server, port: number, log: object[] }>}
 */
function startSegment(meters) {
    const log = [];
    const server = net.createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on("error", () => {});
        sock.on("data", (d) => {
            buf = Buffer.concat([buf, d]);
            for (;;) {
                const r = takeFrame(buf);
                if (r.kind === "none") {
                    break;
                }
                buf = r.rest;
                if (r.kind !== "short" && r.kind !== "long") {
                    continue;
                }
                log.push({ c: r.c, a: r.a, ci: r.ci, data: r.data ? r.data.toString("hex") : null });
                const ms = meters.filter((m) => m.addr === r.a);
                if (ms.length === 0) {
                    continue;
                }
                if (ms.length > 1) {
                    sock.write(Buffer.from([0x00, 0x13])); // collision: noise without a valid frame
                    continue;
                }
                const m = ms[0];
                if (r.kind === "short" && r.c === 0x40) {
                    m.sent = 0;
                    sock.write(Buffer.from([0xe5]));
                } else if (r.kind === "short" && (r.c === 0x5b || r.c === 0x7b)) {
                    if (m.silent) {
                        continue;
                    }
                    const f = m.frames[Math.min(m.sent || 0, m.frames.length - 1)];
                    m.sent = (m.sent || 0) + 1;
                    sock.write(f);
                } else if (r.kind === "long" && r.c === 0x53 && r.ci === 0x51) {
                    if (m.acceptsClock) {
                        m.clock = r.data.toString("hex");
                        sock.write(Buffer.from([0xe5]));
                    }
                }
            }
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, log })));
}

module.exports = { rsp, startSegment };
