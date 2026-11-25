"use strict";

/**
 * Sets a Moxa NPort (one serial port) up for the M-Bus through its web console: operating mode "TCP Server
 * Mode" (raw data on the local TCP port) and the serial line (baud rate, 8 data bits, 1 stop bit, parity, no flow
 * control), then saves and restarts the device. The page layout is that of the NPort 5100 series (firmware 2.x);
 * every page is checked for the fields it is expected to have, and nothing is sent if one is missing.
 */

/** Value of the option in the baud rate list of the console. */
const BAUD = {
    300: 5,
    600: 6,
    1200: 7,
    2400: 9,
    4800: 10,
    9600: 12,
    19200: 13,
    38400: 14,
};
/** Value of the option in the parity list of the console. */
const PARITY = { N: "00", O: "08", E: "24" };
const PARITY_NAME = { N: "None", O: "Odd", E: "Even" };

/** @param {string} html @returns {string|null} one-time token of a page (set("token_text","...")) */
function tokenOf(html) {
    const m = /set\("token_text","([^"]*)"\)/.exec(html);
    return m ? m[1] : null;
}

/**
 * Literal arguments of a call such as sPack("0","0",false,...) in the page script.
 *
 * @param {string} html
 * @param {string} fn
 * @returns {string[]|null}
 */
function argsOf(html, fn) {
    const re = new RegExp(
        `\\b${fn}\\(((?:"[^"]*"|\\d+|true|false)(?:,(?:"[^"]*"|\\d+|true|false))*)\\)`,
    );
    const m = re.exec(html);
    return m ? m[1].split(",").map((a) => a.replace(/^"|"$/g, "")) : null;
}

/** @param {Record<string, string|number>} p @returns {string} */
function query(p) {
    return Object.entries(p)
        .map(
            ([k, v]) =>
                `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        )
        .join("&");
}

/**
 * The target values, or the reason why they cannot be set.
 *
 * @param {{ port: number, baud: number, parity: string }} t
 * @returns {string|null}
 */
function checkTarget(t) {
    if (!(t.baud in BAUD)) {
        return `Baudrate ${t.baud} wird von der Moxa-Einrichtung nicht unterstützt (300 bis 38400).`;
    }
    if (!(t.parity in PARITY)) {
        return `Parität ${t.parity} unbekannt (E, N oder O).`;
    }
    if (
        !Number.isInteger(t.port) ||
        t.port < 1024 ||
        t.port > 65535 ||
        t.port === 966 ||
        t.port === 950
    ) {
        return `TCP-Port ${t.port} ist nicht zulässig (1024 bis 65535, nicht 950 und 966).`;
    }
    return null;
}

/**
 * Sends the settings and the restart. The web console must be logged in.
 *
 * @param {import("./web").MoxaWeb} web
 * @param {{ port: number, baud: number, parity: string, maxConnect?: number }} t
 * @returns {Promise<{ ok: boolean, note: string, restarted?: boolean }>}
 */
async function apply(web, t) {
    const bad = checkTarget(t);
    if (bad) {
        return { ok: false, note: bad };
    }
    const get = async (/** @type {string} */ p) => {
        const r = await web.request("GET", p);
        if (
            r.status !== 200 ||
            /Input\s*password/i.test(r.text) ||
            /Expired Page/i.test(r.text)
        ) {
            throw new Error(
                `Seite ${p.split("?")[0]} nicht lesbar (Sitzung abgelaufen oder belegt)`,
            );
        }
        return r.text;
    };

    /** The operating mode page: checked, with the values that are kept and its one-time key. */
    const readOp = async () => {
        const op = await get("/04Svr.htm?Port=01");
        const token = tokenOf(op);
        const sS = argsOf(op, "sS");
        const sPack = argsOf(op, "sPack");
        const sSvr = argsOf(op, "sSvr");
        for (const f of [
            "OpMode",
            "LocalTcpPort",
            "CommandPort",
            "MaxConnect",
            "setfunc",
        ]) {
            if (!op.includes(`name=${f}`)) {
                return `Seite Operating Settings hat das Feld ${f} nicht, andere Firmware? Nichts geändert.`;
            }
        }
        if (
            !token ||
            !sS ||
            sS.length < 5 ||
            !sPack ||
            sPack.length < 7 ||
            !sSvr ||
            sSvr.length < 2
        ) {
            return "Seite TCP Server Mode nicht wie erwartet aufgebaut. Nichts geändert.";
        }
        return { token, sS, sPack, sSvr };
    };
    const first = await readOp();
    if (typeof first === "string") {
        return { ok: false, note: first };
    }
    const ser = await get("/serial.htm?Port=01");
    const serToken = tokenOf(ser);
    for (const f of [
        "BaudRate",
        "DataBits",
        "StopBits",
        "Parity",
        "FlowCtrl",
        "setfunc",
    ]) {
        if (!ser.includes(`name=${f}`)) {
            return {
                ok: false,
                note: `Seite Serial Settings hat das Feld ${f} nicht, andere Firmware? Nichts geändert.`,
            };
        }
    }
    if (!serToken) {
        return {
            ok: false,
            note: "Seite Serial Settings ohne Sitzungsschlüssel. Nichts geändert.",
        };
    }
    /** @type {Record<string, string|number>} */
    const serial = {
        PortAlias: "",
        BaudRate: BAUD[/** @type {keyof typeof BAUD} */ (t.baud)],
        DataBits: 3,
        StopBits: 0,
        Parity: PARITY[/** @type {keyof typeof PARITY} */ (t.parity)],
        FlowCtrl: 0,
        FIFO: 1,
        PortNo: "01",
        Submit: "Submit",
        setfunc: "Serial",
        token_text: serToken,
    };
    const r1 = await web.request("GET", `/Set.htm?${query(serial)}`);
    if (r1.status !== 200 || /Expired Page/i.test(r1.text)) {
        return {
            ok: false,
            note: "Die Moxa hat die seriellen Einstellungen nicht angenommen.",
        };
    }

    // 2. operating mode, read again for a fresh key
    const op2 = await readOp();
    if (typeof op2 === "string") {
        return {
            ok: false,
            note: `${op2} (die seriellen Einstellungen sind schon gesendet, ohne Neustart wirken sie nicht)`,
        };
    }
    const { sS, sPack, sSvr } = op2;
    const maxConnect = t.maxConnect || 2;
    /** @type {Record<string, string|number>} */
    const mode = {
        OpMode: 10,
        TCPAliveCheck: sS[0],
        InactivityTime: sS[1],
        MaxConnect: maxConnect,
    };
    if (maxConnect > 1) {
        mode.ignorejam = sS[3];
        mode.allowdrvctrl = sS[4];
    }
    mode.packlen = sPack[0];
    if (sPack[0] === "" || sPack[0] === "0") {
        mode.DelimiterChar1 = sPack[1];
        if (sPack[2] === "true") {
            mode.DelimiterChar1Flag = "ON";
        }
        mode.DelimiterChar2 = sPack[3];
        if (sPack[4] === "true") {
            mode.DelimiterChar2Flag = "ON";
        }
        mode.delimprocess = sPack[5];
    }
    mode.ForceTxTime = sPack[6];
    mode.LocalTcpPort = t.port;
    mode.CommandPort = sSvr[1];
    mode.PortNo = "01";
    mode.Submit = "Submit";
    mode.setfunc = "OPMode";
    mode.token_text = op2.token;
    const r2 = await web.request("GET", `/Set.htm?${query(mode)}`);
    if (r2.status !== 200 || /Expired Page/i.test(r2.text)) {
        return {
            ok: false,
            note: "Die Moxa hat die Betriebsart nicht angenommen (die seriellen Einstellungen sind schon gesendet, es folgt kein Neustart).",
        };
    }

    // 3. save and restart
    const rs = await get("/09.htm");
    const rsToken = tokenOf(rs);
    if (!rsToken || !rs.includes("09Set.htm")) {
        return {
            ok: false,
            note: "Seite Save/Restart nicht wie erwartet: Einstellungen sind gesendet, aber die Moxa wurde nicht neu gestartet.",
        };
    }
    try {
        await web.request(
            "GET",
            `/09Set.htm?${query({ Submit: "Submit", token_text: rsToken })}`,
        );
    } catch {
        // the device may close the connection while it restarts
    }
    return {
        ok: true,
        restarted: true,
        note: `TCP Server Mode, Port ${t.port}, ${t.baud} 8${t.parity}1 gesendet, Moxa wird neu gestartet.`,
    };
}

module.exports = {
    apply,
    checkTarget,
    tokenOf,
    argsOf,
    BAUD,
    PARITY,
    PARITY_NAME,
};
