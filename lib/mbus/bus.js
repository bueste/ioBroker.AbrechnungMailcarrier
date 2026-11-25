"use strict";

const net = require("node:net");
const { spawn } = require("node:child_process");
const {
    C_SND_NKE,
    C_SND_UD,
    C_REQ_UD2,
    C_REQ_UD2_FCB,
    CI_SET_DATA,
    shortFrame,
    longFrame,
    takeFrame,
} = require("./frame");
const {
    parseTelegram,
    summarize,
    mediumName,
    encodeDateF,
} = require("./parse");

/**
 * Master side of an M-Bus segment behind a serial server (Moxa NPort in raw TCP server mode). One TCP
 * connection per run; the serial settings (2400 baud, 8E1) are set in the serial server.
 */
class Bus {
    /**
     * @param {object} opts
     * @param {string} [opts.host]   serial server in raw TCP server mode
     * @param {number} [opts.port]
     * @param {string} [opts.device] COM device (real-COM mode of the serial server, USB serial adapter); replaces host and port
     * @param {number} [opts.baud]   with a device: line speed (default 2400)
     * @param {string} [opts.parity] with a device: E, N or O (default E)
     * @param {(device: string, baud: number, parity: string) => { cmd: string, args: string[] }} [opts.serialCommand] the helper that opens the device (tests replace it)
     * @param {number} [opts.connectTimeoutMs]
     * @param {number} [opts.ackWaitMs]     how long to wait for E5 after SND_NKE (a meter answers within ~150 ms)
     * @param {number} [opts.dataWaitMs]    how long to wait for a telegram after REQ_UD2
     * @param {(msg: string) => void} [opts.debug]
     */
    constructor(opts) {
        this.host = opts.host || "";
        this.port = opts.port || 4001;
        this.device = opts.device || "";
        this.baud = opts.baud || 2400;
        this.parity = opts.parity || "E";
        this.serialCommand = opts.serialCommand || socatCommand;
        this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
        this.ackWaitMs = opts.ackWaitMs || 400;
        this.dataWaitMs = opts.dataWaitMs || 2500;
        this.debug = opts.debug || (() => {});
        /** @type {net.Socket|null} */
        this.sock = null;
        /** @type {Buffer} */
        this.buf = Buffer.alloc(0);
        /** @type {null | (() => void)} */
        this.wake = null;
        this.error = null;
        this.tx = 0;
        this.rx = 0;
    }

    /** @returns {Promise<void>} rejects with a readable message */
    connect() {
        if (this.device) {
            return this.connectDevice();
        }
        return new Promise((resolve, reject) => {
            const s = net.createConnection({
                host: this.host,
                port: this.port,
            });
            let done = false;
            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    s.destroy();
                    reject(
                        new Error(
                            `Zeitüberschreitung beim Verbinden mit ${this.host}:${this.port}`,
                        ),
                    );
                }
            }, this.connectTimeoutMs);
            s.setNoDelay(true);
            s.once("connect", () => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                this.sock = s;
                resolve();
            });
            s.on("data", (d) => {
                this.rx += d.length;
                this.buf = Buffer.concat([this.buf, d]);
                if (this.wake) {
                    this.wake();
                }
            });
            s.on("error", (e) => {
                this.error = e;
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    reject(
                        new Error(`${this.host}:${this.port}: ${e.message}`),
                    );
                } else if (this.wake) {
                    this.wake();
                }
            });
            s.on("close", () => {
                this.sock = null;
                if (this.wake) {
                    this.wake();
                }
            });
        });
    }

    /**
     * Opens a COM device. socat sets the line (speed, 8 data bits, parity) and passes the bytes through its
     * standard input and output; that works the same for a real-COM device of a serial server, a USB serial
     * adapter and a pseudo terminal. `this.sock` then is a small object with the write/destroy of a socket.
     *
     * @returns {Promise<void>}
     */
    connectDevice() {
        return new Promise((resolve, reject) => {
            const { cmd, args } = this.serialCommand(
                this.device,
                this.baud,
                this.parity,
            );
            let child;
            try {
                child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
            } catch (e) {
                reject(
                    new Error(
                        `${this.device}: ${/** @type {Error} */ (e).message}`,
                    ),
                );
                return;
            }
            let done = false;
            let stderr = "";
            const fail = (/** @type {string} */ msg) => {
                this.error = new Error(msg);
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    reject(this.error);
                } else if (this.wake) {
                    this.wake();
                }
            };
            // socat has opened the device when it still runs after a short moment
            const timer = setTimeout(() => {
                if (done) {
                    return;
                }
                done = true;
                this.sock = /** @type {any} */ ({
                    write: (/** @type {Buffer} */ b) => child.stdin.write(b),
                    destroy: () => {
                        child.kill();
                    },
                });
                resolve();
            }, 300);
            child.stdout.on("data", (/** @type {Buffer} */ d) => {
                this.rx += d.length;
                this.buf = Buffer.concat([this.buf, d]);
                if (this.wake) {
                    this.wake();
                }
            });
            child.stderr.on("data", (/** @type {Buffer} */ d) => {
                stderr = (stderr + d.toString()).slice(-300);
            });
            child.stdin.on("error", () => {});
            child.on("error", (e) =>
                fail(
                    /** @type {any} */ (e).code === "ENOENT"
                        ? `${cmd} fehlt (sudo apt install socat), COM-Gerät ${this.device} nicht nutzbar`
                        : `${this.device}: ${e.message}`,
                ),
            );
            child.on("exit", (code) => {
                this.sock = null;
                fail(
                    `COM-Gerät ${this.device} nicht nutzbar${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ` (socat Code ${code})`}`,
                );
            });
        });
    }

    close() {
        if (this.sock) {
            this.sock.destroy();
            this.sock = null;
        }
    }

    /**
     * Sends a frame and waits for the answer.
     *
     * @param {Buffer} frame
     * @param {number} waitMs
     * @returns {Promise<{ kind: "none"|"ack"|"short"|"long"|"garbage", frame?: Buffer, ci?: number, data?: Buffer, a?: number }>}
     */
    async transact(frame, waitMs) {
        if (!this.sock) {
            throw new Error(
                this.error ? this.error.message : "Verbindung getrennt",
            );
        }
        this.buf = Buffer.alloc(0);
        this.tx += frame.length;
        this.debug(`TX ${frame.toString("hex")}`);
        this.sock.write(frame);
        const deadline = Date.now() + waitMs;
        let garbageSince = 0;
        for (;;) {
            const r = takeFrame(this.buf);
            if (r.kind === "ack" || r.kind === "short" || r.kind === "long") {
                this.buf = r.rest;
                this.debug(
                    `RX ${r.kind} ${r.frame ? r.frame.toString("hex") : ""}`,
                );
                return r;
            }
            if (r.kind === "garbage") {
                // collisions and line noise: give the line a moment to settle, then report it
                garbageSince = garbageSince || Date.now();
                if (Date.now() - garbageSince > 80) {
                    this.debug(`RX garbage ${this.buf.toString("hex")}`);
                    return { kind: "garbage" };
                }
            }
            const left = deadline - Date.now();
            if (left <= 0) {
                return { kind: this.buf.length ? "garbage" : "none" };
            }
            if (!this.sock) {
                throw new Error(
                    this.error ? this.error.message : "Verbindung getrennt",
                );
            }
            await new Promise((resolve) => {
                const t = setTimeout(
                    () => {
                        this.wake = null;
                        resolve(undefined);
                    },
                    Math.min(left, 40),
                );
                this.wake = () => {
                    clearTimeout(t);
                    this.wake = null;
                    resolve(undefined);
                };
            });
        }
    }

    /** @param {number} addr @returns {Promise<"ack"|"none"|"garbage">} */
    async nke(addr) {
        const r = await this.transact(
            shortFrame(C_SND_NKE, addr),
            this.ackWaitMs,
        );
        return r.kind === "ack"
            ? "ack"
            : r.kind === "garbage"
              ? "garbage"
              : "none";
    }

    /**
     * Reads all telegrams of a meter at a primary address.
     *
     * @param {number} addr
     * @returns {Promise<{ ok: boolean, error?: string, header?: any, summary?: ReturnType<typeof summarize>, records?: object[], frames: string[], medium_name?: string, more?: boolean }>}
     */
    async readMeter(addr) {
        const frames = [];
        const records = [];
        let header = null;
        let more = false;
        let fcb = false;
        await this.nke(addr);
        for (let n = 0; n < 8; n++) {
            let r = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                r = await this.transact(
                    shortFrame(fcb ? C_REQ_UD2_FCB : C_REQ_UD2, addr),
                    this.dataWaitMs,
                );
                if (r.kind === "long") {
                    break;
                }
                if (n > 0) {
                    break; // a follow-up telegram that does not come is not an error of the meter
                }
            }
            if (!r || r.kind !== "long") {
                if (n === 0) {
                    return {
                        ok: false,
                        error:
                            r && r.kind === "garbage"
                                ? "Störung oder Kollision auf dem Bus"
                                : "keine Antwort",
                        frames,
                    };
                }
                break;
            }
            frames.push(r.frame ? r.frame.toString("hex") : "");
            const t = parseTelegram(r.data || Buffer.alloc(0), r.ci || 0);
            if (!t.ok) {
                return { ok: false, error: t.error, frames };
            }
            if (!header) {
                header = t.header;
            }
            records.push(...(t.records || []).filter((x) => !x.special));
            more = t.more === true;
            if (!more) {
                break;
            }
            fcb = !fcb;
        }
        if (!header) {
            return { ok: false, error: "kein Kopf im Telegramm", frames };
        }
        return {
            ok: true,
            header,
            records,
            summary: summarize(header, records),
            frames,
            medium_name: mediumName(header.medium),
            more,
        };
    }

    /**
     * Looks for meters at the primary addresses.
     *
     * @param {number} from
     * @param {number} to
     * @param {(addr: number, kind: string) => void} [onHit]
     * @returns {Promise<{ addr: number, kind: string }[]>}
     */
    async scan(from = 0, to = 250, onHit) {
        const hits = [];
        for (let a = from; a <= to; a++) {
            const k = await this.nke(a);
            if (k !== "none") {
                hits.push({ addr: a, kind: k });
                if (onHit) {
                    onHit(a, k);
                }
            }
        }
        return hits;
    }

    /**
     * Sets the clock of a meter (SND_UD, CI 0x51, date and time type F). The meter answers E5 if it accepts.
     *
     * @param {number} addr
     * @param {Date} when
     * @returns {Promise<{ accepted: boolean, answer: string }>}
     */
    async setClock(addr, when) {
        await this.nke(addr);
        const data = Buffer.concat([
            Buffer.from([0x04, 0x6d]),
            encodeDateF(when),
        ]);
        const r = await this.transact(
            longFrame(C_SND_UD, addr, CI_SET_DATA, data),
            this.dataWaitMs,
        );
        return { accepted: r.kind === "ack", answer: r.kind };
    }
}

/**
 * The socat call that opens a COM device: raw mode, no echo, no flow control, 8 data bits, even/odd/no parity.
 *
 * @param {string} device
 * @param {number} baud
 * @param {string} parity
 */
function socatCommand(device, baud, parity) {
    const par =
        parity === "N"
            ? "parenb=0"
            : `parenb=1,parodd=${parity === "O" ? 1 : 0}`;
    return {
        cmd: "socat",
        args: [
            "-",
            `${device},raw,echo=0,b${baud},cs8,${par},cstopb=0,crtscts=0,clocal=1`,
        ],
    };
}

module.exports = { Bus, socatCommand };
