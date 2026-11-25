"use strict";

/**
 * Writes the payload the manager sends for a poll of the simulated segment to a file, so the PHP side of the
 * contract can be checked against the real thing (see the web application, private/tests/contract_mbus.php).
 * Usage: node test/helpers/dump_payload.js out.json
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MbusManager } = require("../../lib/mbus/manager");
const { Store } = require("../../lib/mbus/store");
const { startSegment } = require("./segment");

const HEAT =
    "68BABA680801721717045565496904670000000C7817170455046D1013583B0415AD04040044156CF10300840115BDFE030084101500000000C4101500000000841115000000000405A353070044052F3E0700840105A147070084100500000000C410050000000084110500000000426C5E36026C7E36043B00000000143BFA030000042B00000000142B001B0000025B1B00025F1B00046090FFFFFF0222000042232C090223BA0EC2026CEB1C01FD17000490281200000002FB775A000916";
const HOTWATER =
    "684C4C680865724788845474264A062A0000000C7847888454046D390C583B0413786D0300026C7E364413864E0300426C5E368401131AF0020082016C3E360223800FC2026CFA1B01FD170209FD0E14DE16";
const COLDWATER =
    "684C4C6808C97219898454742649072C0000000C7819898454046D080D583B04130F6C0600026C7E36441334240600426C5E36840113BB75050082016C3E360223810FC2026CFB1B01FD170209FD0E140516";

(async () => {
    const seg = await startSegment([
        { addr: 1, frames: [Buffer.from(HEAT, "hex")] },
        { addr: 101, frames: [Buffer.from(HOTWATER, "hex")] },
        { addr: 201, frames: [Buffer.from(COLDWATER, "hex")] },
    ]);
    const sent = [];
    const api = {
        mbusConfig: async () => ({
            ok: true,
            status: 200,
            kind: "ok",
            message: "ok",
            details: [],
            data: {
                client: { id: 1, name: "x" },
                settings: { version: 1, scan_days: 30, read_minutes: 15, timesync_days: 30, timesync_enabled: false },
                gateways: [{ id: 1, name: "Keller", host: "127.0.0.1", port: seg.port, enabled: true, scan_due: true, meters: [] }],
                units: [],
                commands: [{ id: 5, gateway_id: 1, type: "test", params: null }],
                alarms: [],
            },
        }),
        mbusIngest: async (p) => {
            sent.push(p);
            return { ok: true, status: 200, kind: "ok", message: "ok", details: [], data: { ok: true } };
        },
    };
    const mgr = new MbusManager({
        log: { info() {}, warn() {}, error() {}, debug() {} },
        clients: [{ label: "a1", api }],
        store: new Store(fs.mkdtempSync(path.join(os.tmpdir(), "dump-"))),
        version: "0.2.0",
        setState: async () => {},
        busOptions: { ackWaitMs: 60, dataWaitMs: 300 },
        scanRange: [0, 5],
    });
    mgr.store.init();
    // add 101 and 201 to the scan range by scanning them as expected meters: first a scan 0..5 (finds heat), then a poll
    mgr.scanRange = [0, 5];
    await mgr.tick();
    mgr.stop();
    seg.server.close();
    fs.writeFileSync(process.argv[2], JSON.stringify(sent));
    process.exit(0);
})();
