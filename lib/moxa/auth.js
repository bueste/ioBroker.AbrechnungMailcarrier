"use strict";

const crypto = require("node:crypto");

/**
 * Login of the Moxa NPort web console. The login page does not send the password: its script (SetPass) mixes it
 * with a challenge the server put into the page:
 *
 *   m = MD5(challenge)                        // the 64 character text of FakeChallenge, 32 hex digits
 *   w = hex(password), 2 digits per character // no padding
 *   p = nibble-wise xor of w and m
 *   EncPasswd = MD5(p)
 *
 * The page's own MD5 is the standard one for printable characters. test/unit/moxa_auth.test.js runs the real
 * script of a saved login page and compares its result with this function.
 */

/** @param {string} s */
function md5hex(s) {
    return crypto.createHash("md5").update(s, "latin1").digest("hex");
}

/**
 * @param {string} password at most 15 characters (the form field's limit)
 * @param {string} challenge value of the hidden field FakeChallenge
 * @returns {string} value for the field EncPasswd
 */
function encPassword(password, challenge) {
    const m = md5hex(challenge);
    let w = "";
    for (const ch of password) {
        w += ch.charCodeAt(0).toString(16);
    }
    let p = "";
    for (let i = 0; i < w.length; i++) {
        p += (parseInt(w[i], 16) ^ parseInt(m[i % m.length], 16)).toString(16);
    }
    return md5hex(p);
}

/**
 * @param {string} html the login page
 * @returns {string|null} the challenge of the page
 */
function challengeOf(html) {
    const m =
        /set\(\s*["']FakeChallenge["']\s*,\s*["']([0-9A-Fa-f]+)["']\s*\)/.exec(
            html,
        );
    return m ? m[1] : null;
}

module.exports = { md5hex, encPassword, challengeOf };
