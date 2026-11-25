"use strict";

/** M-Bus link layer (EN 13757-2): frames and a stream parser. */

const C_SND_NKE = 0x40;
const C_SND_UD = 0x53;
const C_SND_UD_FCB = 0x73;
const C_REQ_UD2 = 0x5b;
const C_REQ_UD2_FCB = 0x7b;
const CI_SET_DATA = 0x51;
/** selection of a meter by its secondary address (SND_UD to address 253) */
const CI_SELECT = 0x52;
/** the address of a selected meter */
const ADDR_SELECTED = 0xfd;

/** @param {number[]|Buffer} bytes */
function checksum(bytes) {
    let s = 0;
    for (const b of bytes) {
        s = (s + b) & 0xff;
    }
    return s;
}

/**
 * @param {number} c control field
 * @param {number} a address
 * @returns {Buffer}
 */
function shortFrame(c, a) {
    return Buffer.from([0x10, c, a, (c + a) & 0xff, 0x16]);
}

/**
 * @param {number} c control field
 * @param {number} a address
 * @param {number} ci control information
 * @param {number[]|Buffer} data
 * @returns {Buffer}
 */
function longFrame(c, a, ci, data) {
    const body = Buffer.concat([Buffer.from([c, a, ci]), Buffer.from(data)]);
    const l = body.length;
    return Buffer.concat([
        Buffer.from([0x68, l, l, 0x68]),
        body,
        Buffer.from([checksum(body), 0x16]),
    ]);
}

/**
 * Takes the first complete frame out of a receive buffer.
 *
 * @param {Buffer} buf
 * @returns {{ kind: "none"|"ack"|"short"|"long"|"garbage", frame?: Buffer, rest: Buffer, c?: number, a?: number, ci?: number, data?: Buffer }}
 */
function takeFrame(buf) {
    let i = 0;
    // skip leading noise (line glitches); a frame starts with E5, 10 or 68
    while (i < buf.length && ![0xe5, 0x10, 0x68].includes(buf[i])) {
        i++;
    }
    if (i >= buf.length) {
        return { kind: buf.length ? "garbage" : "none", rest: Buffer.alloc(0) };
    }
    buf = buf.subarray(i);
    if (buf[0] === 0xe5) {
        return {
            kind: "ack",
            frame: buf.subarray(0, 1),
            rest: buf.subarray(1),
        };
    }
    if (buf[0] === 0x10) {
        if (buf.length < 5) {
            return { kind: "none", rest: buf };
        }
        const f = buf.subarray(0, 5);
        if (f[4] !== 0x16 || f[3] !== ((f[1] + f[2]) & 0xff)) {
            return { kind: "garbage", rest: buf.subarray(1) };
        }
        return {
            kind: "short",
            frame: f,
            c: f[1],
            a: f[2],
            rest: buf.subarray(5),
        };
    }
    if (buf.length < 4) {
        return { kind: "none", rest: buf };
    }
    if (buf[1] !== buf[2] || buf[3] !== 0x68) {
        return { kind: "garbage", rest: buf.subarray(1) };
    }
    const total = buf[1] + 6;
    if (buf.length < total) {
        return { kind: "none", rest: buf };
    }
    const f = buf.subarray(0, total);
    if (
        f[total - 1] !== 0x16 ||
        f[total - 2] !== checksum(f.subarray(4, total - 2))
    ) {
        return { kind: "garbage", rest: buf.subarray(1) };
    }
    return {
        kind: "long",
        frame: f,
        c: f[4],
        a: f[5],
        ci: f[6],
        data: f.subarray(7, total - 2),
        rest: buf.subarray(total),
    };
}

module.exports = {
    C_SND_NKE,
    C_SND_UD,
    C_SND_UD_FCB,
    C_REQ_UD2,
    C_REQ_UD2_FCB,
    CI_SET_DATA,
    CI_SELECT,
    ADDR_SELECTED,
    checksum,
    shortFrame,
    longFrame,
    takeFrame,
};
